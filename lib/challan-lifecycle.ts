import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuthUser } from "@/lib/auth";
import { SETTLEMENT_NET_REFERENCE_TYPES } from "@/lib/settlement-correction";

type Tx = PrismaClient | Prisma.TransactionClient;

// ============================================================
// CHALLAN LIFECYCLE (Bin/Restore-with-Bilty-reset, Mark as Not
// Delivered, Delivered-Challan Bilty add, Unsettle) - shared helpers
// used by app/api/challan/[id]/route.ts (DELETE), .../restore,
// .../mark-not-delivered and .../unsettle.
//
// All six lifecycle actions these helpers support are SUPER_ADMIN-
// only, enforced the same way app/api/challan/[id]/settlement-payments
// /route.ts already enforces its own SUPER_ADMIN-only POST: a direct
// role check, not an entry in lib/permissions.ts's per-role Permission
// arrays. MANAGER already holds "challan.bin"/"challan.restore" there
// for the OLD (pre-this-feature) Bin/Restore behavior, which this
// task deliberately overrides to also reset Bilty status/revenue -
// widening who that reaches was never asked for, so the narrower,
// additional direct-role gate below is layered on top instead of
// touching those arrays.
// ============================================================

export class ChallanLifecycleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChallanLifecycleError";
    this.code = code;
  }
}

export const SUPER_ADMIN_ONLY_MESSAGE = "Sirf Super Admin ye kar sakta hai";

export function assertSuperAdmin(user: AuthUser): void {
  if (user.role !== "SUPER_ADMIN") {
    throw new ChallanLifecycleError("NOT_SUPER_ADMIN", SUPER_ADMIN_ONLY_MESSAGE);
  }
}

/**
 * True if a Phonch (Showroom) or Private Phonch vehicle line already
 * references this Bilty No. - both biltyNo fields are deliberately
 * plain manual reference text, never a foreign key (see PhonchVehicle
 * 's own schema doc comment), so this is a string match, scoped to
 * non-deleted parent Phonch/Private Phonch records. A Bill is derived
 * from a Phonch/Private Phonch vehicle line via BillSourceLink, so it
 * can never exist without a vehicle line here first - covering
 * Phonch/Private Phonch transitively covers the Bill case too.
 */
export async function biltyHasPhonchOrBillReference(tx: Tx, biltyNo: string): Promise<boolean> {
  const [phonchVehicle, privatePhonchVehicle] = await Promise.all([
    tx.phonchVehicle.findFirst({
      where: { biltyNo, phonch: { isDeleted: false } },
      select: { id: true },
    }),
    tx.privatePhonchVehicle.findFirst({
      where: { biltyNo, phonch: { isDeleted: false } },
      select: { id: true },
    }),
  ]);
  return Boolean(phonchVehicle || privatePhonchVehicle);
}

export const SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE = "SETTLEMENT_UNSETTLE_REVERSAL";

// Every forward-posting referenceType Unsettle must reverse - every
// entry type in SETTLEMENT_NET_REFERENCE_TYPES (see lib/settlement-
// correction.ts) EXCEPT the reversal type itself would be redundant to
// exclude here: reversing literally everything found under the full
// list - including a PRIOR Unsettle's own reversal entries, on a
// second settle/unsettle cycle - is what keeps the math correct no
// matter how many settle/unsettle cycles a Challan goes through. See
// the module-level reasoning in reverseChallanSettlementEntries below.
export { SETTLEMENT_NET_REFERENCE_TYPES };

interface ReverseSettlementEntriesParams {
  challanId: string;
  challanNo: string;
  createdById: string;
  reason: string;
}

interface ReverseSettlementEntriesResult {
  reversedCount: number;
  reversedEntryIds: string[];
  deactivatedPaymentRowCount: number;
}

/**
 * Finds every non-deleted JournalEntry currently contributing to this
 * Challan's settlement position (main SETTLEMENT entry, any
 * SETTLEMENT_CORRECTION, every SETTLEMENT_PAYMENT/_CORRECTION/
 * _REVERSAL row from the multi-payer engine, and any MULTI_PAYER_
 * TRANSITION sync entry - exactly the set lib/settlement-
 * correction.ts's getPartyNetFromSettlement() already reads to
 * compute a party's current net settlement position for this
 * Challan) and posts ONE new, append-only reversing JournalEntry per
 * entry found - same lines, debit and credit swapped, same
 * referenceId (so future getPartyNetFromSettlement()/party-ledger
 * reads net correctly to zero), tagged
 * SETTLEMENT_UNSETTLE_REVERSAL. The ORIGINAL entries are never
 * edited or soft-deleted.
 *
 * Reversing literally every entry currently in scope (rather than
 * trying to net them into a single correcting entry per party) is
 * what makes this safe to call again after a later re-settle: whatever
 * the running total across all of them was before this call, summing
 * each entry with its own exact mirror always brings that running
 * total back to precisely zero, regardless of how many settle/
 * correct/pay/unsettle cycles already happened.
 */
export async function reverseChallanSettlementEntries(
  tx: Tx,
  params: ReverseSettlementEntriesParams
): Promise<ReverseSettlementEntriesResult> {
  const biltyLinks = await tx.challanBilty.findMany({
    where: { challanId: params.challanId },
    select: { biltyId: true },
  });
  const referenceIds = [params.challanId, ...biltyLinks.map((l) => l.biltyId)];

  const entries = await tx.journalEntry.findMany({
    where: {
      isDeleted: false,
      referenceType: { in: SETTLEMENT_NET_REFERENCE_TYPES },
      referenceId: { in: referenceIds },
    },
    include: { lines: true },
    orderBy: { createdAt: "asc" },
  });

  const reversedEntryIds: string[] = [];

  for (const entry of entries) {
    if (entry.lines.length === 0) continue; // zero-line settlement marker - nothing to reverse.

    const description = `Unsettle - ${params.challanNo} - ${params.reason} - reversing: ${entry.description}`;

    await tx.journalEntry.create({
      data: {
        entryDate: new Date(),
        referenceType: SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE,
        referenceId: entry.referenceId,
        description,
        createdById: params.createdById,
        lines: {
          create: entry.lines.map((l) => ({
            accountId: l.accountId,
            debit: Number(l.credit),
            credit: Number(l.debit),
            description,
            sourceType: l.sourceType,
            sourceId: l.sourceId,
            sourceNumber: l.sourceNumber,
          })),
        },
      },
    });

    reversedEntryIds.push(entry.id);
  }

  // DEACTIVATE every COLLECTION/CARRIER_RENT SettlementPayment row for
  // this Challan - SOFT only (isActive: false), never a delete, and
  // never touching the real accounting lines above (those stay exactly
  // as posted, reversal entries included, forever). Scoped to
  // `challanId: params.challanId` alone: both components "always set
  // this" (see the model's own doc comment) - CARRIER_RENT rows live
  // directly on the Challan (biltyId null), COLLECTION rows live on one
  // of its Bilties but still carry this SAME challanId - so this one
  // filter already captures every row this Unsettle call's reversal
  // above just reversed the accounting effect of. A Challan's Unsettle
  // is all-or-nothing for its own settlement position (see this
  // function's own module doc comment: "reversing literally every entry
  // currently in scope"), so there is no partial case where only SOME
  // of a Challan's rows should be deactivated here.
  //
  // PAID rows are never touched - they always have challanId: null
  // (resolved independently of any Challan/Settlement, see the model's
  // own doc comment), so this filter structurally excludes them even
  // without the explicit component check below.
  const deactivation = await tx.settlementPayment.updateMany({
    where: {
      challanId: params.challanId,
      component: { in: ["COLLECTION", "CARRIER_RENT"] },
      isActive: true,
    },
    data: {
      isActive: false,
      deactivatedAt: new Date(),
      deactivatedById: params.createdById,
      deactivationReason: params.reason,
    },
  });

  return {
    reversedCount: reversedEntryIds.length,
    reversedEntryIds,
    deactivatedPaymentRowCount: deactivation.count,
  };
}
