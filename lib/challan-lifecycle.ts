import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuthUser } from "@/lib/auth";
import { SETTLEMENT_NET_REFERENCE_TYPES } from "@/lib/settlement-correction";

type Tx = PrismaClient | Prisma.TransactionClient;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

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

// SETTLEMENT_NET_REFERENCE_TYPES (lib/settlement-correction.ts) is the
// full set of referenceTypes that ever contribute to a Challan's
// settlement position, INCLUDING SETTLEMENT_UNSETTLE_REVERSAL itself -
// correct and unchanged for getPartyNetFromSettlement()'s own use
// (summing every one of them, reversals included, is exactly how a
// cancelling pair nets back to zero in a running total).
// reverseChallanSettlementEntries() below uses this same list to find
// every CANDIDATE entry, but - unlike that summing use - it must
// never re-reverse an entry that a PRIOR Unsettle already reversed;
// see that function's own doc comment for how it narrows the
// candidate set down to only the currently-live ones before posting
// anything.
export { SETTLEMENT_NET_REFERENCE_TYPES };

export type EntryWithLines = Prisma.JournalEntryGetPayload<{ include: { lines: true } }>;

/** `${accountId}:${debit}:${credit}` per line, sorted - a multiset
 * key independent of line insertion order (Prisma does not guarantee
 * `findMany` preserves a nested `create` array's order). */
export function canonicalLineSet(lines: { accountId: string; debit: Prisma.Decimal | number; credit: Prisma.Decimal | number }[]): string {
  return lines
    .map((l) => `${l.accountId}:${round2(Number(l.debit))}:${round2(Number(l.credit))}`)
    .sort()
    .join("|");
}

/** Same as canonicalLineSet, but with each line's own debit/credit
 * swapped first - the shape a REVERSAL of these lines would have. */
export function canonicalNegatedLineSet(lines: { accountId: string; debit: Prisma.Decimal | number; credit: Prisma.Decimal | number }[]): string {
  return canonicalLineSet(lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit })));
}

export interface ReversalMatch {
  reversalId: string;
  matchedForwardEntryId: string | null;
  /** Other unconsumed candidates with the exact same negated shape,
   * at the time this reversal was matched - empty unless the legacy
   * fallback (no `reversesEntryId`) hit a genuine ambiguity. Reported
   * by scripts/backfill-reversal-links.ts, never silently resolved
   * beyond picking the oldest (see matchReversalsToForwardEntries). */
  ambiguousCandidateIds: string[];
}

/**
 * Matches every reversal in `reversalEntries` to the ONE forward
 * entry (from `forwardEntries`) it reverses - via the exact
 * `reversesEntryId` link when a reversal already carries one (every
 * reversal this codebase creates going forward always does), falling
 * back to an exact negated-line-set match (oldest unconsumed
 * candidate first - same greedy, exact-amount precedent as
 * lib/ledger-description.ts's extractReversedPairs) for historical
 * reversal entries that predate that link (NULL on every entry
 * created before this field existed - see
 * scripts/backfill-reversal-links.ts, which fills it in for exactly
 * this historical data, after which this fallback path stops being
 * exercised for anything it successfully backfills). Never matched by
 * description text, by date alone, or by referenceType - only by the
 * exact linked id, or an exact financial negation. Shared by
 * reverseChallanSettlementEntries (which only needs the resulting
 * "already reversed" id set) and the backfill/scan scripts (which
 * also need the ambiguity detail to report, never silently resolve).
 */
export function matchReversalsToForwardEntries(forwardEntries: EntryWithLines[], reversalEntries: EntryWithLines[]): ReversalMatch[] {
  const consumed = new Set<string>();
  const results: ReversalMatch[] = [];
  for (const reversal of reversalEntries) {
    if (reversal.reversesEntryId) {
      consumed.add(reversal.reversesEntryId);
      results.push({ reversalId: reversal.id, matchedForwardEntryId: reversal.reversesEntryId, ambiguousCandidateIds: [] });
      continue;
    }
    const targetKey = canonicalNegatedLineSet(reversal.lines);
    const candidates = forwardEntries.filter(
      (f) => !consumed.has(f.id) && f.createdAt < reversal.createdAt && canonicalLineSet(f.lines) === targetKey
    );
    if (candidates.length === 0) {
      results.push({ reversalId: reversal.id, matchedForwardEntryId: null, ambiguousCandidateIds: [] });
      continue;
    }
    const [chosen, ...rest] = candidates; // oldest first - forwardEntries/candidates preserve createdAt-asc order.
    consumed.add(chosen.id);
    results.push({ reversalId: reversal.id, matchedForwardEntryId: chosen.id, ambiguousCandidateIds: rest.map((c) => c.id) });
  }
  return results;
}

function findAlreadyReversedIds(forwardEntries: EntryWithLines[], reversalEntries: EntryWithLines[]): Set<string> {
  const alreadyReversedIds = new Set<string>();
  for (const match of matchReversalsToForwardEntries(forwardEntries, reversalEntries)) {
    if (match.matchedForwardEntryId) alreadyReversedIds.add(match.matchedForwardEntryId);
  }
  return alreadyReversedIds;
}

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
 * entry that is NOT ALREADY REVERSED - same lines, debit and credit
 * swapped, same referenceId (so future getPartyNetFromSettlement()/
 * party-ledger reads net correctly to zero), tagged
 * SETTLEMENT_UNSETTLE_REVERSAL with `reversesEntryId` pointing at the
 * exact entry it reverses. The ORIGINAL entries are never edited or
 * soft-deleted.
 *
 * CORRECTNESS NOTE (previously wrong): an earlier version of this
 * function reversed literally every candidate entry ever found, on
 * the theory that re-reversing an already-cancelled pair is harmless
 * because it nets to zero in isolation. That is true only in the
 * instant it happens - it is NOT safe to repeat on a 2nd+ settle/
 * unsettle cycle, because `findAlreadyReversedIds` below has no way
 * to tell "already reversed, leave it" apart from "still live,
 * reverse it" without this distinction, so calling Unsettle on a
 * Challan that had already been through one full settle/unsettle/
 * re-settle cycle re-reversed the dead pair from the FIRST cycle too -
 * harmless in isolation, but it silently duplicates the reversal
 * JournalEntry count every cycle and, worse, can corrupt anything
 * that later tries to pair an original line with its one true
 * reversal by exact amount (e.g. Party Ledger Short view's removal-
 * pair hiding) by handing it more than one candidate to match
 * against. Each entry is now reversed AT MOST ONCE, tracked via
 * `reversesEntryId` (falling back to an exact negated-line match for
 * historical rows predating that link - see findAlreadyReversedIds).
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

  // Zero-line settlement markers carry no accounting effect and are
  // excluded up front - both from reversal AND from the matching
  // below (an empty line-set would otherwise coincidentally "match"
  // any other empty-line entry).
  const nonEmptyEntries = entries.filter((e) => e.lines.length > 0);
  const reversalEntries = nonEmptyEntries.filter((e) => e.referenceType === SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE);
  const forwardEntries = nonEmptyEntries.filter((e) => e.referenceType !== SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE);
  const alreadyReversedIds = findAlreadyReversedIds(forwardEntries, reversalEntries);
  const toReverse = forwardEntries.filter((f) => !alreadyReversedIds.has(f.id));

  const reversedEntryIds: string[] = [];

  for (const entry of toReverse) {
    // Defense-in-depth, inside this SAME transaction: re-check for an
    // existing reversal immediately before posting (guards a
    // concurrent second Unsettle call on this same Challan, on top of
    // the isSettled check the API route itself already does before
    // ever calling this function).
    const existingReversal = await tx.journalEntry.findFirst({
      where: { reversesEntryId: entry.id, isDeleted: false },
      select: { id: true },
    });
    if (existingReversal) continue;

    const description = `Unsettle - ${params.challanNo} - ${params.reason} - reversing: ${entry.description}`;

    await tx.journalEntry.create({
      data: {
        entryDate: new Date(),
        referenceType: SETTLEMENT_UNSETTLE_REVERSAL_REFERENCE_TYPE,
        referenceId: entry.referenceId,
        reversesEntryId: entry.id,
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
  // is all-or-nothing for its own CURRENTLY LIVE settlement position,
  // so there is no partial case where only SOME of a Challan's
  // currently-active rows should be deactivated here - already-
  // deactivated rows from a prior Unsettle are simply excluded by
  // `isActive: true` above, left untouched (idempotent).
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
