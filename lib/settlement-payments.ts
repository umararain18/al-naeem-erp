import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  getGrossBiltyReceivableAccountId,
  getGrossCarrierRentPayableAccountId,
} from "@/lib/gross-accounts";
import {
  findSettledPartyAccountId,
  getComponentNetAmount,
  getPartyNetFromSettlement,
} from "@/lib/settlement-correction";
import { getBiltyPaidVerification } from "@/lib/bilty-paid-verification";

// ============================================================
// MULTI-PAYER / MULTI-COLLECTOR SETTLEMENT PAYMENT ENGINE
// (P1 + P2 integration + PAID responsibility)
//
// This module is a PURE, ADDITIVE extension over the existing,
// unmodified Settlement architecture. It never touches
// lib/settlement-accounting.ts / lib/gross-accounts.ts / lib/pnl.ts
// / lib/challan-financials.ts. It reads ONE existing, unmodified
// read-only helper from lib/settlement-correction.ts
// (getComponentNetAmount, exported for this purpose - its own logic
// is untouched) to find how much the OLD single-payer mechanism
// currently has attributed to a component, for the OLD/NEW
// coexistence transition below - it never calls any WRITE function
// from that module and never duplicates its calculation.
//
// Every row this engine creates is backed by a real, balanced
// JournalEntry using the EXACT SAME account/direction pair the
// existing single-payer Settlement already uses for that component
// (see buildLines() below) - Carrier Rent expense and Booking
// Income remain recognized exactly once, at dispatch/booking time,
// regardless of how many payment rows are later posted here.
//
// A row's own id is the ONLY thing ever used to find the
// JournalEntry/JournalLines that belong to it - every line this
// module creates is tagged sourceType: "SETTLEMENT_PAYMENT",
// sourceId: <row id>. This is a real, indexed, exact-match column
// lookup - never description-text pattern matching, never a
// "latest JournalLine wins" inference.
//
// Component semantics (deliberately explicit, per the finalized
// business rules this module implements):
//  - COLLECTION is Bilty-level. Its total is Bilty.toPay - the
//    REMAINING To-Pay portion only, not Bilty.total. Requires the
//    Bilty's Challan to already be settled (an unavoidable
//    prerequisite of the existing single-payer Settlement flow).
//  - CARRIER_RENT is Challan-level (biltyId is always null). Its
//    total is Challan.carrierRent. Also requires the Challan to
//    already be settled.
//  - PAID is Bilty-level, single-party, and completely INDEPENDENT
//    of any Challan/Settlement - Consignor/Consignee responsibility
//    is resolved at Bilty creation/edit time, per the Paid
//    Responsibility Receivable Accounting audit. Its total is
//    Bilty.advance (never Bilty.total, never Bilty.toPay). A PAID
//    row's own `challanId` is always null.
//
// ANC is never a selectable payer here (per the finalized business
// rules) - a component's un-allocated remainder simply stays as
// Due/Payable; no account is ever required or fabricated to
// represent it.
//
// ============================================================
// OLD (single-payer) / NEW (multi-payer) COEXISTENCE
//
// The existing single-payer Settlement (lib/settlement-accounting.ts,
// via POST /api/challan/[id]/settle) is an unavoidable PREREQUISITE
// of COLLECTION/CARRIER_RENT rows - a Challan must already be
// `isSettled` - and that original settlement ALWAYS reclassifies a
// Bilty's FULL Bilty.total for Collection (and the FULL
// Challan.carrierRent for Carrier Rent) to exactly one party in one
// shot. If this engine's rows were validated only against their own
// componentTotal without accounting for what the OLD mechanism
// already claimed, the SAME Gross balance would be reclassified out
// TWICE.
//
// ensureOldAttributionWithinFloor() (below) closes this gap by
// posting an additional, balanced, purely additive correction -
// never mutating or deleting the original entry, never touching
// Income/Expense. It reduces the OLD party's CURRENT ledger
// attribution for COLLECTION down to a FLOOR that depends on whether
// a PAID row now exists for the same Bilty:
//  - No PAID row yet: floor = Bilty.advance (the Paid amount stays,
//    for now, with whichever party the OLD mechanism originally
//    attributed Collection to - the pre-PAID-accounting stopgap).
//  - A PAID row exists: floor = 0 - the Paid slice has already been
//    explicitly, separately reclassified to the Paid-responsible
//    Party, so the OLD Collection party must retain NO claim over
//    it. Establishing a PAID row therefore always re-runs this
//    transition (idempotently) to push the OLD party's Collection
//    floor down from Bilty.advance to 0, releasing exactly that
//    difference back to Gross.
//
// This is fully idempotent by construction (it recomputes the OLD
// party's live net attribution from the ledger every time via
// getComponentNetAmount() - a release only fires when that net is
// still above the floor) and only ever fires when an admin actively
// establishes a new-engine row for that document/component.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type MultiPayerComponent = "COLLECTION" | "CARRIER_RENT" | "PAID";

export class SettlementPaymentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SettlementPaymentError";
    this.code = code;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const EPS = 0.009;

// ============================================================
// COMPONENT CONTEXT - resolves the target document, its component
// total, and the gross account this component reclassifies out of.
// Never recomputes anything challan-financials.ts / settlement-
// accounting.ts already own - Bilty.toPay/Bilty.advance and
// Challan.carrierRent are read directly, exactly as they already
// exist.
// ============================================================

interface ComponentContext {
  challanId: string | null;
  challanNo: string | null;
  settlementJournalEntryId: string | null;
  biltyId: string | null;
  biltyNo: string | null;
  biltyAdvance: number | null;
  componentTotal: number;
  grossAccountId: string;
  documentLabel: string;
}

interface ResolveComponentContextOptions {
  /**
   * PAID only. resolveComponentContext()'s default behavior re-reads
   * Bilty.advance fresh and rejects (DOCUMENT_NOT_ALLOCATABLE) when it
   * is <= 0 - correct for CREATING/allocating a new PAID row (never
   * allocate against a Bilty with nothing to allocate), but wrong
   * when resolving context for an EXISTING PAID row that is being
   * deleted/updated: the caller (app/api/bilty/[id]/route.ts) already
   * updates Bilty.advance to its NEW value (which may legitimately be
   * 0, e.g. a Paid -> To-Pay reversal) BEFORE calling
   * deleteSettlementPayment()/updateSettlementPaymentAmount() in the
   * SAME transaction - at that point advance<=0 does not mean "no
   * Paid amount to allocate", it means "the existing row is correctly
   * being fully reversed." Set true ONLY from a caller that already
   * owns a real, existing SettlementPayment row - never from a create
   * path. Never bypasses PAID_BELOW_VERIFIED / PAID_DELETE_BLOCKED_VERIFIED_RECEIPT
   * or any other guard - those are checked separately, before this is
   * ever reached, and remain fully intact.
   */
  forExistingPaidRow?: boolean;
}

async function resolveComponentContext(
  tx: Tx,
  component: MultiPayerComponent,
  input: { challanId?: string | null; biltyId?: string | null },
  options: ResolveComponentContextOptions = {}
): Promise<ComponentContext> {
  // PAID - Bilty-only, no Challan/Settlement involved at all.
  if (component === "PAID") {
    if (!input.biltyId) {
      throw new SettlementPaymentError("INVALID_TARGET", "Paid responsibility requires a Bilty.");
    }
    const bilty = await tx.bilty.findUnique({
      where: { id: input.biltyId },
      select: { id: true, biltyNo: true, isDeleted: true, advance: true },
    });
    if (!bilty || bilty.isDeleted) {
      throw new SettlementPaymentError("BILTY_NOT_FOUND", "Bilty not found.");
    }
    const advance = round2(Number(bilty.advance));
    if (advance <= 0 && !options.forExistingPaidRow) {
      throw new SettlementPaymentError(
        "DOCUMENT_NOT_ALLOCATABLE",
        "This Bilty has no Paid amount to establish responsibility for."
      );
    }
    const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
    return {
      challanId: null,
      challanNo: null,
      settlementJournalEntryId: null,
      biltyId: bilty.id,
      biltyNo: bilty.biltyNo,
      biltyAdvance: advance,
      componentTotal: advance,
      grossAccountId,
      documentLabel: `Bilty ${bilty.biltyNo} Paid`,
    };
  }

  if (!input.challanId) {
    throw new SettlementPaymentError("INVALID_TARGET", `${component} requires a Challan.`);
  }

  const challan = await tx.challan.findUnique({
    where: { id: input.challanId },
    select: {
      id: true,
      challanNo: true,
      isDeleted: true,
      isSettled: true,
      carrierRent: true,
      settlementJournalEntryId: true,
    },
  });

  if (!challan || challan.isDeleted) {
    throw new SettlementPaymentError("CHALLAN_NOT_FOUND", "Challan not found.");
  }
  if (!challan.isSettled || !challan.settlementJournalEntryId) {
    throw new SettlementPaymentError(
      "CHALLAN_NOT_SETTLED",
      "This Challan has not been through Final Settlement yet - settlement payment rows can only be recorded against an already-settled Challan."
    );
  }

  if (component === "CARRIER_RENT") {
    if (input.biltyId) {
      throw new SettlementPaymentError(
        "INVALID_TARGET",
        "Carrier Rent is a Challan-level component and must not specify a Bilty."
      );
    }
    const carrierRent = round2(Number(challan.carrierRent));
    if (carrierRent <= 0) {
      throw new SettlementPaymentError(
        "DOCUMENT_NOT_ALLOCATABLE",
        "This Challan has no Carrier Rent to record payments against."
      );
    }
    const grossAccountId = await getGrossCarrierRentPayableAccountId(tx);
    return {
      challanId: challan.id,
      challanNo: challan.challanNo,
      settlementJournalEntryId: challan.settlementJournalEntryId,
      biltyId: null,
      biltyNo: null,
      biltyAdvance: null,
      componentTotal: carrierRent,
      grossAccountId,
      documentLabel: `Challan ${challan.challanNo} Carrier Rent`,
    };
  }

  // COLLECTION - Bilty-level, scoped to the Remaining To-Pay portion.
  if (!input.biltyId) {
    throw new SettlementPaymentError("INVALID_TARGET", "Collection requires a Bilty.");
  }

  const link = await tx.challanBilty.findFirst({
    where: { challanId: challan.id, biltyId: input.biltyId },
    select: {
      bilty: { select: { id: true, biltyNo: true, isDeleted: true, toPay: true, advance: true } },
    },
  });

  if (!link || link.bilty.isDeleted) {
    throw new SettlementPaymentError(
      "BILTY_NOT_FOUND",
      "This Bilty was not found on this Challan."
    );
  }

  const toPay = round2(Number(link.bilty.toPay));
  if (toPay <= 0) {
    throw new SettlementPaymentError(
      "DOCUMENT_NOT_ALLOCATABLE",
      "This Bilty has no remaining To-Pay amount to record collections against."
    );
  }

  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
  return {
    challanId: challan.id,
    challanNo: challan.challanNo,
    settlementJournalEntryId: challan.settlementJournalEntryId,
    biltyId: link.bilty.id,
    biltyNo: link.bilty.biltyNo,
    biltyAdvance: round2(Number(link.bilty.advance)),
    componentTotal: toPay,
    grossAccountId,
    documentLabel: `Bilty ${link.bilty.biltyNo} To-Pay`,
  };
}

// ============================================================
// OLD -> NEW TRANSITION (COLLECTION / CARRIER_RENT only - see the
// module header comment above for full reasoning). Recomputes the
// OLD mechanism's CURRENT live attribution for this component from
// the ledger every time (getComponentNetAmount - an existing,
// unmodified, read-only helper) and releases only the amount above
// the given floor. A no-op when nothing is above the floor (already
// released, or the old mechanism never attributed a party for this
// component at all). Never called for PAID - it has no "old
// mechanism" to transition from.
// ============================================================

async function getBookingIncomeAccountId(tx: Tx): Promise<string> {
  const account = await tx.account.findFirst({
    where: { category: "BOOKING_INCOME", isActive: true },
    select: { id: true },
  });
  if (!account) {
    throw new SettlementPaymentError("CONFIG_MISSING", "Required BOOKING_INCOME account is not configured.");
  }
  return account.id;
}

/**
 * The Collection floor depends on whether a PAID row now exists for
 * this Bilty: with none, Bilty.advance stays (for now) with whoever
 * the OLD mechanism attributed Collection to (the pre-PAID-
 * accounting stopgap); once a PAID row exists, the Paid slice has
 * its own separate claim, so the OLD Collection party must retain
 * NO claim over it (floor = 0).
 */
async function resolveCollectionFloor(tx: Tx, biltyId: string, biltyAdvance: number): Promise<number> {
  if (biltyAdvance <= 0) return 0;
  const paidRow = await tx.settlementPayment.findFirst({
    where: { component: "PAID", biltyId },
    select: { id: true },
  });
  return paidRow ? 0 : Math.max(0, biltyAdvance);
}

/**
 * Keeps the OLD (single-payer) Collection mechanism's ledger
 * attribution for this Bilty in sync with whatever PAID attribution
 * CURRENTLY exists for it - in EITHER direction. This is the other
 * half of the double-drain protection: ensureOldAttributionWithinFloor()
 * only ever fires on its own from within
 * createSettlementPayment("COLLECTION", ...) - establishing, editing,
 * or removing a PAID row never itself creates/edits/removes a
 * COLLECTION row, so without this explicit cross-component trigger the
 * OLD mechanism's claim would never react to PAID activity at all.
 *
 * The target floor is recomputed fresh from the CURRENT PAID row (if
 * any still exists) every time this is called - never from
 * Bilty.advance directly, since Bilty.advance intentionally stays
 * unchanged when a PAID row is deleted (the Paid amount itself is not
 * being reversed, only its separate attribution is):
 *   - A PAID row exists for `amount`: floor = Bilty.total - amount
 *     (the OLD party retains exactly the un-attributed ToPay slice).
 *   - No PAID row exists (never established, or just deleted): floor
 *     = Bilty.total (nothing is separately attributed anymore, so the
 *     OLD mechanism's original single-payer claim is fully restored).
 *
 * ensureOldAttributionWithinFloor() itself decides release vs restore
 * by comparing this floor to the OLD party's live current net - this
 * function only ever supplies the correct TARGET, never the direction.
 *
 * A no-op when this Bilty has no settled Challan yet (nothing for the
 * OLD mechanism to have claimed) - correctly deferred, never
 * fabricated, and re-checked (idempotently, via
 * ensureOldAttributionWithinFloor's own live-ledger recomputation)
 * every time a PAID row is created, updated, or removed.
 */
async function syncCollectionFloorForBilty(
  tx: Tx,
  biltyId: string,
  createdById: string | null
): Promise<void> {
  const link = await tx.challanBilty.findFirst({
    where: { biltyId, challan: { isDeleted: false, status: { not: "CANCELLED" } } },
    select: {
      challan: { select: { id: true, challanNo: true, isSettled: true, settlementJournalEntryId: true } },
      bilty: { select: { id: true, biltyNo: true, advance: true, total: true } },
    },
  });

  if (!link || !link.challan.isSettled || !link.challan.settlementJournalEntryId) {
    return;
  }

  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
  const biltyTotal = round2(Number(link.bilty.total));
  const currentPaidRow = await tx.settlementPayment.findFirst({
    where: { component: "PAID", biltyId },
    select: { amount: true },
  });
  const explicitFloor = currentPaidRow
    ? Math.max(0, round2(biltyTotal - round2(Number(currentPaidRow.amount))))
    : biltyTotal;
  const collectionContext: ComponentContext = {
    challanId: link.challan.id,
    challanNo: link.challan.challanNo,
    settlementJournalEntryId: link.challan.settlementJournalEntryId,
    biltyId: link.bilty.id,
    biltyNo: link.bilty.biltyNo,
    biltyAdvance: round2(Number(link.bilty.advance)),
    // Not used by ensureOldAttributionWithinFloor() - this context is
    // built solely to trigger the OLD mechanism's release/restore, not
    // to validate/create an actual COLLECTION row.
    componentTotal: 0,
    grossAccountId,
    documentLabel: `Bilty ${link.bilty.biltyNo} To-Pay`,
  };

  await ensureOldAttributionWithinFloor(tx, "COLLECTION", collectionContext, createdById, explicitFloor);
}

/**
 * Closes a distinct lifecycle gap from syncCollectionFloorForBilty()
 * above: a Bilty's advance/PAID amount can already be raised BEFORE
 * its Challan is ever settled for the first time - at that moment
 * syncCollectionFloorForBilty() (called from the PAID row's own
 * create/update) correctly no-ops, since there is no settled Challan
 * yet to reconcile against. Nothing else ever revisits it afterward:
 * buildSettlementEntries() (lib/settlement-accounting.ts) establishes
 * the OLD single-payer Collection default using the Bilty's full
 * `total` - the ledger has no notion of `toPay` at that point - so a
 * Bilty that was already fully (or partially) Paid before its first
 * settlement is left with a stale over-attribution that nothing ever
 * releases.
 *
 * Must be called from WITHIN the SAME transaction that just created
 * the settlement JournalEntry (finalize-settlement), immediately
 * after, for every Bilty on the Challan - reconciling the freshly-
 * established default down to that Bilty's CURRENT `toPay` (the
 * authoritative "how much Collection is actually outstanding" figure
 * the rest of the multi-payer engine already uses everywhere else).
 *
 * This is a DIFFERENT floor concept from resolveCollectionFloor()
 * (which protects the Paid slice from an ONGOING new-engine
 * COLLECTION row, keyed off PAID-row presence/absence) - here the
 * floor is simply the Bilty's own toPay, independent of whether a
 * PAID row exists at all:
 *   - Genuinely To-Pay (toPay === total): floor === the default
 *     itself - a no-op, nothing was ever wrongly attributed.
 *   - Partially Paid (0 < toPay < total): only the amount ABOVE
 *     toPay is released - the still-outstanding toPay stays exactly
 *     where the OLD mechanism put it.
 *   - Fully Paid (toPay === 0): the entire default is released.
 *
 * Fully idempotent (delegates to ensureOldAttributionWithinFloor()'s
 * own live-net recomputation, which no-ops once the old attribution
 * already sits at or below the requested floor) - safe to call on
 * every Bilty on every finalize-settlement, including Bilties that
 * were never affected by this gap at all.
 */
export async function reconcileCollectionAttributionAtSettlement(
  tx: Tx,
  challanId: string,
  biltyId: string,
  createdById: string | null
): Promise<void> {
  const bilty = await tx.bilty.findUnique({
    where: { id: biltyId },
    select: { id: true, biltyNo: true, advance: true, toPay: true, isDeleted: true },
  });
  if (!bilty || bilty.isDeleted) return;

  const challan = await tx.challan.findUnique({
    where: { id: challanId },
    select: { id: true, challanNo: true, settlementJournalEntryId: true },
  });
  if (!challan || !challan.settlementJournalEntryId) return;

  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
  const floor = Math.max(0, round2(Number(bilty.toPay)));

  const collectionContext: ComponentContext = {
    challanId: challan.id,
    challanNo: challan.challanNo,
    settlementJournalEntryId: challan.settlementJournalEntryId,
    biltyId: bilty.id,
    biltyNo: bilty.biltyNo,
    biltyAdvance: round2(Number(bilty.advance)),
    // Not used by ensureOldAttributionWithinFloor() - see
    // syncCollectionFloorForBilty()'s identical comment above.
    componentTotal: 0,
    grossAccountId,
    documentLabel: `Bilty ${bilty.biltyNo} To-Pay`,
  };

  await ensureOldAttributionWithinFloor(tx, "COLLECTION", collectionContext, createdById, floor);
}

/**
 * Keeps the OLD (single-payer) Carrier Rent mechanism's ledger
 * attribution for its default/residual party (the Transporter, per
 * finalize-settlement's default priority - or the Clearing Agent
 * fallback, or whatever a pre-existing historical Challan already
 * established) in sync with the CURRENT sum of active CARRIER_RENT
 * SettlementPayment rows, in EITHER direction - the Carrier Rent
 * analogue of syncCollectionFloorForBilty(), but self-referential:
 * CARRIER_RENT's own new-engine activity determines CARRIER_RENT's
 * own floor directly (there is no separate cross-component trigger
 * the way PAID drives COLLECTION's floor - Carrier Rent has exactly
 * one component, and its default party IS the residual claimant for
 * whatever this component itself has not yet explicitly attributed
 * to a payer).
 *
 * Unlike resolveCollectionFloor() (a fixed, one-time floor keyed off
 * Bilty.advance/PAID existence), Carrier Rent's floor must track the
 * LIVE remaining balance so a PARTIAL payment by one payer leaves
 * the unpaid remainder attributed to the default party rather than
 * releasing the default's entire original claim on the first row:
 *
 *   floor = max(0, Challan.carrierRent - sum(ALL active CARRIER_RENT rows))
 *
 * Every active row (including one whose payer happens to BE the
 * default party itself - e.g. a direct Transporter settlement)
 * counts toward the sum: excluding a self-attributed row would leave
 * the default party's original claim un-released while its own new
 * row adds a second, redundant credit - fabricating a doubled
 * balance with no real economic change. Including it means a
 * self-attributed row's release and its own credit net to the
 * default party's ledger balance staying exactly where it already
 * was (a legitimate no-op re-formalization, not a discharge - actual
 * discharge only ever happens via Daily Posting) - while a
 * different-party row correctly moves its amount away from the
 * default party, leaving the true unpaid residual behind.
 *
 * Recomputed fresh from the ledger every time via
 * ensureOldAttributionWithinFloor()'s own live-net recomputation -
 * fully idempotent and bidirectional (a new/increased row lowers the
 * floor -> release; a deleted/decreased row raises it -> restore).
 * A no-op when this Challan has no settled Carrier Rent to have ever
 * claimed (mirrors resolveComponentContext's own CARRIER_RENT guards).
 */
async function syncCarrierRentFloorForChallan(
  tx: Tx,
  challanId: string,
  createdById: string | null
): Promise<void> {
  const context = await resolveComponentContext(tx, "CARRIER_RENT", { challanId });
  const activeRows = await getActiveSettlementPayments(tx, "CARRIER_RENT", { challanId });
  const activeTotal = round2(activeRows.reduce((s, r) => s + r.amount, 0));
  const explicitFloor = Math.max(0, round2(context.componentTotal - activeTotal));

  await ensureOldAttributionWithinFloor(tx, "CARRIER_RENT", context, createdById, explicitFloor);
}

async function ensureOldAttributionWithinFloor(
  tx: Tx,
  component: "COLLECTION" | "CARRIER_RENT",
  context: ComponentContext,
  createdById: string | null,
  explicitFloor?: number
): Promise<void> {
  // The "incomeOrExpenseAccountId" findSettledPartyAccountId()/
  // getComponentNetAmount() need to recognize this component's
  // reclassification group is the SAME account the original
  // single-payer entry paired the gross account with - Booking
  // Income for COLLECTION, the Carrier Rent EXPENSE account (never
  // the gross/payable account) for CARRIER_RENT, resolved the same
  // way every existing caller of these two functions already does.
  const matchAccountId =
    component === "COLLECTION"
      ? await getBookingIncomeAccountId(tx)
      : (
          await tx.account.findFirst({ where: { category: "CARRIER_RENT", isActive: true }, select: { id: true } })
        )?.id;

  if (!matchAccountId) {
    // No CARRIER_RENT expense account configured - nothing to match
    // against, so there cannot be an old-mechanism attribution to
    // release either. Not an error: this only means the old
    // mechanism itself could never have run for this component.
    return;
  }

  const biltyIdForLookup = component === "CARRIER_RENT" ? null : context.biltyId;

  const oldPartyAccountId = await findSettledPartyAccountId(
    tx,
    context.challanId as string,
    context.settlementJournalEntryId as string,
    component,
    matchAccountId,
    biltyIdForLookup
  );

  if (!oldPartyAccountId) {
    // The old single-payer mechanism never established a party for
    // this component (e.g. the amount was 0 at original settlement
    // time) - nothing to release.
    return;
  }

  const oldNet = await getComponentNetAmount(
    tx,
    context.challanId as string,
    context.settlementJournalEntryId as string,
    component,
    matchAccountId,
    biltyIdForLookup,
    oldPartyAccountId
  );

  const floor =
    explicitFloor !== undefined
      ? explicitFloor
      : component === "COLLECTION"
        ? await resolveCollectionFloor(tx, context.biltyId as string, context.biltyAdvance || 0)
        : 0;
  // COLLECTION's old net is a DEBIT (positive); CARRIER_RENT's old
  // net is a CREDIT (negative, per getComponentNetAmount's own
  // debit-minus-credit convention) - normalize to a positive
  // "currently attributed" magnitude before comparing to the floor.
  const originalAttributed = component === "COLLECTION" ? oldNet : -oldNet;

  const sourceType = component === "CARRIER_RENT" ? "CHALLAN" : "BILTY";
  const sourceId = component === "CARRIER_RENT" ? (context.challanId as string) : (context.biltyId as string);
  const sourceNumber = component === "CARRIER_RENT" ? (context.challanNo as string) : (context.biltyNo as string);
  const releaseReferenceType =
    component === "COLLECTION" ? "COLLECTION_MULTI_PAYER_TRANSITION" : "CARRIER_RENT_MULTI_PAYER_TRANSITION";

  // getComponentNetAmount() only sees the ORIGINAL settlement entry
  // and real SETTLEMENT_CORRECTION entries - it has no knowledge of
  // this module's own transition entries (a different, distinct
  // referenceType, deliberately not "SETTLEMENT_CORRECTION" so it is
  // never confused with a real correction). Track their NET effect
  // separately so this stays self-correcting/idempotent AND
  // bidirectional: a release entry moves the old party's attribution
  // DOWN, a restore entry (e.g. a PAID row being deleted, handing its
  // slice back to the OLD mechanism) moves it back UP - so a second
  // call for the same document/component always sees the FULL history
  // and computes a delta of ~0 once the target floor has already been
  // reached, from either direction.
  const priorTransitions = await tx.journalEntry.findMany({
    where: { referenceType: releaseReferenceType, referenceId: sourceId, isDeleted: false },
    select: { lines: { where: { accountId: oldPartyAccountId }, select: { debit: true, credit: true } } },
  });
  let netReleased = 0;
  for (const entry of priorTransitions) {
    for (const line of entry.lines) {
      // A release entry (buildReverseLines) credits the old party's
      // account for COLLECTION (debits it for CARRIER_RENT); a restore
      // entry (buildLines) does the opposite. Summing (credit - debit)
      // for COLLECTION / (debit - credit) for CARRIER_RENT yields the
      // signed net amount released so far - positive for a net
      // release, negative for a net restore.
      netReleased +=
        component === "COLLECTION"
          ? Number(line.credit) - Number(line.debit)
          : Number(line.debit) - Number(line.credit);
    }
  }

  const currentlyAttributed = round2(originalAttributed - netReleased);
  const delta = round2(floor - currentlyAttributed);

  if (Math.abs(delta) <= EPS) {
    return;
  }

  const isRestore = delta > 0;
  const adjustAmount = Math.abs(delta);
  const lines = isRestore
    ? buildLines(component, adjustAmount, oldPartyAccountId, context.grossAccountId)
    : buildReverseLines(component, adjustAmount, oldPartyAccountId, context.grossAccountId);
  const description =
    component === "COLLECTION"
      ? isRestore
        ? `Collection Multi-Collector Transition - ${context.documentLabel} - restoring ${adjustAmount} from Gross (Paid attribution no longer separately claims this slice)`
        : `Collection Multi-Collector Transition - ${context.documentLabel} - releasing ${adjustAmount} back to Gross${floor > 0 ? ` (Paid amount ${floor} remains with the original party)` : " (Paid amount now separately established)"}`
      : isRestore
        ? `Carrier Rent Multi-Payer Transition - ${context.documentLabel} - restoring ${adjustAmount} from Gross`
        : `Carrier Rent Multi-Payer Transition - ${context.documentLabel} - releasing ${adjustAmount} back to Gross`;

  const oldPartyNetBefore = context.challanId
    ? await getPartyNetFromSettlement(tx, context.challanId, oldPartyAccountId)
    : 0;

  await tx.journalEntry.create({
    data: {
      entryDate: new Date(),
      referenceType: releaseReferenceType,
      referenceId: sourceId,
      description,
      createdById,
      lines: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          description,
          sourceType,
          sourceId,
          sourceNumber,
        })),
      },
    },
  });

  if (context.challanId) {
    const oldPartyNetAfter = await getPartyNetFromSettlement(tx, context.challanId, oldPartyAccountId);
    await adjustChallanOutstanding(tx, context.challanId, oldPartyNetBefore, oldPartyNetAfter);
  }
}

// ============================================================
// Challan.outstandingReceivable / outstandingPayable INTEGRATION
//
// These are the existing BLENDED, per-party, whole-Challan fields
// lib/settlement-correction.ts's applySettlementCorrection() and
// applySettlementReassignment() already maintain via a "remove this
// party's OLD blended-net contribution, add their NEW one" pattern.
//
// getPartyNetFromSettlement() (lib/settlement-correction.ts) is the
// ONE authoritative helper for "this party's blended net on this
// Challan" - it has been extended (not duplicated) to also scan this
// module's own referenceTypes alongside the original SETTLEMENT/
// SETTLEMENT_CORRECTION ones. PAID never touches these fields at all
// - it has no Challan, and Paid responsibility is deliberately kept
// out of the Collection/Carrier Rent blended Receivable/Payable
// picture (per the finalized business rules - see the Paid
// Responsibility Receivable Accounting audit for why this must stay
// a separate, per-Bilty concept rather than merged in).
// ============================================================

/** Moves exactly one party's blended-net contribution from its OLD
 * bucket to its NEW one - the identical remove-old/add-new pattern
 * applySettlementCorrection()/applySettlementReassignment() already
 * use, applied here to this module's own ledger-affecting events. */
async function adjustChallanOutstanding(
  tx: Tx,
  challanId: string,
  netBefore: number,
  netAfter: number
): Promise<void> {
  if (round2(netBefore) === round2(netAfter)) return;

  const challan = await tx.challan.findUniqueOrThrow({
    where: { id: challanId },
    select: { outstandingReceivable: true, outstandingPayable: true },
  });

  let outstandingReceivable = Number(challan.outstandingReceivable);
  let outstandingPayable = Number(challan.outstandingPayable);

  if (netBefore > 0) outstandingReceivable -= netBefore;
  else if (netBefore < 0) outstandingPayable -= -netBefore;

  if (netAfter > 0) outstandingReceivable += netAfter;
  else if (netAfter < 0) outstandingPayable += -netAfter;

  // Defensive clamp only, mirroring the existing correction/
  // reassignment functions - correct bookkeeping should never drive
  // these negative.
  outstandingReceivable = Math.max(0, round2(outstandingReceivable));
  outstandingPayable = Math.max(0, round2(outstandingPayable));

  await tx.challan.update({
    where: { id: challanId },
    data: { outstandingReceivable, outstandingPayable },
  });
}

// ============================================================
// PARTY ACCOUNT VALIDATION - never trust a client-supplied account
// id beyond confirming it is a real, active PARTY account. No
// fabricated/system account is ever accepted as a payer.
// ============================================================

async function assertValidPayerAccount(tx: Tx, payerAccountId: string): Promise<void> {
  const account = await tx.account.findUnique({
    where: { id: payerAccountId },
    select: { id: true, category: true, isActive: true },
  });

  if (!account) {
    throw new SettlementPaymentError("PARTY_NOT_FOUND", "Selected payer account was not found.");
  }
  if (account.category !== "PARTY") {
    throw new SettlementPaymentError("INVALID_PARTY_ACCOUNT", "Selected payer account must be a Party account.");
  }
  if (!account.isActive) {
    throw new SettlementPaymentError("INVALID_PARTY_ACCOUNT", "Selected payer account is inactive.");
  }
}

// ============================================================
// DIRECTION - reused verbatim from the existing single-payer
// Settlement accounting (lib/settlement-accounting.ts). Never a new
// direction, never a new account. PAID uses the EXACT SAME direction
// as COLLECTION (both reclassify out of Gross Bilty Receivable).
//
// COLLECTION / PAID:  Dr [payer]              Cr Gross Bilty Receivable
// CARRIER_RENT:        Dr Gross Carrier Rent Payable   Cr [payer]
// ============================================================

function buildLines(
  component: MultiPayerComponent,
  amount: number,
  payerAccountId: string,
  grossAccountId: string
): { accountId: string; debit: number; credit: number }[] {
  if (component === "COLLECTION" || component === "PAID") {
    return [
      { accountId: payerAccountId, debit: amount, credit: 0 },
      { accountId: grossAccountId, debit: 0, credit: amount },
    ];
  }
  return [
    { accountId: grossAccountId, debit: amount, credit: 0 },
    { accountId: payerAccountId, debit: 0, credit: amount },
  ];
}

// Opposite of buildLines() - used for delta corrections (negative
// delta) and full reversals.
function buildReverseLines(
  component: MultiPayerComponent,
  amount: number,
  payerAccountId: string,
  grossAccountId: string
): { accountId: string; debit: number; credit: number }[] {
  const forward = buildLines(component, amount, payerAccountId, grossAccountId);
  return forward.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit }));
}

// ============================================================
// READ: active payment rows / remaining capacity
// ============================================================

export interface SettlementPaymentRow {
  id: string;
  component: MultiPayerComponent;
  challanId: string | null;
  biltyId: string | null;
  payerAccountId: string;
  amount: number;
  journalEntryId: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(row: {
  id: string;
  component: string;
  challanId: string | null;
  biltyId: string | null;
  payerAccountId: string;
  amount: Prisma.Decimal;
  journalEntryId: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SettlementPaymentRow {
  return {
    id: row.id,
    component: row.component as MultiPayerComponent,
    challanId: row.challanId,
    biltyId: row.biltyId,
    payerAccountId: row.payerAccountId,
    amount: Number(row.amount),
    journalEntryId: row.journalEntryId,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getActiveSettlementPayments(
  tx: Tx,
  component: MultiPayerComponent,
  target: { challanId?: string | null; biltyId?: string | null }
): Promise<SettlementPaymentRow[]> {
  const where: Prisma.SettlementPaymentWhereInput = { component };
  if (component === "CARRIER_RENT") {
    where.challanId = target.challanId ?? undefined;
    where.biltyId = null;
  } else if (component === "COLLECTION") {
    where.challanId = target.challanId ?? undefined;
    where.biltyId = target.biltyId ?? undefined;
  } else {
    // PAID - Bilty-only, challanId is always null.
    where.biltyId = target.biltyId ?? undefined;
  }

  const rows = await tx.settlementPayment.findMany({ where, orderBy: { createdAt: "asc" } });
  return rows.map(toRow);
}

export interface ComponentPaymentState {
  componentTotal: number;
  rows: SettlementPaymentRow[];
  totalPaid: number;
  remainingDue: number;
  distinctPayerAccountIds: string[];
}

/**
 * Read-only summary of a component's multi-payer state: the
 * component total (Bilty.toPay for COLLECTION, Challan.carrierRent
 * for CARRIER_RENT, Bilty.advance for PAID - never recomputed, read
 * straight off the existing fields), every active row, and the
 * derived remaining Due/Payable. This never duplicates lib/challan-
 * financials.ts's own blended receivable/payable calculation - it is
 * a narrower, per-component/per-document view used only by this
 * engine and by the resolution-layer callers below.
 */
export async function getComponentPaymentState(
  component: MultiPayerComponent,
  target: { challanId?: string | null; biltyId?: string | null }
): Promise<ComponentPaymentState> {
  const context = await resolveComponentContext(prisma, component, target);
  const rows = await getActiveSettlementPayments(prisma, component, {
    challanId: context.challanId,
    biltyId: context.biltyId,
  });
  const totalPaid = round2(rows.reduce((s, r) => s + r.amount, 0));
  const remainingDue = Math.max(0, round2(context.componentTotal - totalPaid));
  const distinctPayerAccountIds = [...new Set(rows.map((r) => r.payerAccountId))];

  return {
    componentTotal: context.componentTotal,
    rows,
    totalPaid,
    remainingDue,
    distinctPayerAccountIds,
  };
}

// ============================================================
// PARTY RESOLUTION HELPER (for lib/document-party-resolution.ts and
// lib/payment-allocation.ts to consult) - returns each distinct
// payer's own summed amount for this component/document. An empty
// array means "no multi-payer rows exist here yet" - callers must
// fall back to their existing, unmodified single-payer resolution
// in that case. Two or more entries means genuine ambiguity - no
// caller may guess which one "the" responsible party is. (PAID never
// has more than one active row by construction, so this always
// returns 0 or 1 entries for it.)
// ============================================================

export interface SettlementPayerSummary {
  payerAccountId: string;
  totalAmount: number;
}

export async function getActiveSettlementPayers(
  tx: Tx,
  component: MultiPayerComponent,
  target: { challanId?: string | null; biltyId?: string | null }
): Promise<SettlementPayerSummary[]> {
  const rows = await getActiveSettlementPayments(tx, component, target);
  const byPayer = new Map<string, number>();
  for (const row of rows) {
    byPayer.set(row.payerAccountId, round2((byPayer.get(row.payerAccountId) || 0) + row.amount));
  }
  return [...byPayer.entries()].map(([payerAccountId, totalAmount]) => ({ payerAccountId, totalAmount }));
}

// ============================================================
// GUARD: reject a component-total decrease that would leave active
// SettlementPayment rows over-committed.
//
// Called from app/api/bilty/[id]/route.ts (Collection, keyed on the
// Bilty's new Bilty.toPay; and PAID, keyed on the new Bilty.advance)
// and app/api/challan/[id]/route.ts (Carrier Rent, keyed on the new
// Challan.carrierRent) - INSIDE those routes' own existing correction
// transaction (passed in as `tx`), which must be SERIALIZABLE for
// this check to be race-safe against a concurrent
// createSettlementPayment()/updateSettlementPaymentAmount() call
// (both already SERIALIZABLE). Historical documents with zero active
// rows always pass trivially - this guard only ever becomes active
// once the new engine has rows to protect.
// ============================================================

export async function assertComponentTotalNotBelowActiveRows(
  tx: Tx,
  component: MultiPayerComponent,
  target: { challanId?: string | null; biltyId?: string | null },
  newComponentTotal: number
): Promise<void> {
  const rows = await getActiveSettlementPayments(tx, component, target);
  if (rows.length === 0) return;

  const activeTotal = round2(rows.reduce((s, r) => s + r.amount, 0));
  if (activeTotal > round2(newComponentTotal) + EPS) {
    const subject = component === "CARRIER_RENT" ? "Carrier Rent" : component === "PAID" ? "Paid" : "Collection (To-Pay)";
    throw new SettlementPaymentError(
      "COMPONENT_TOTAL_BELOW_ACTIVE_ROWS",
      `Cannot reduce ${subject} to ${round2(newComponentTotal)} - ${activeTotal} is already recorded across active settlement payment rows for this ${component === "CARRIER_RENT" ? "Challan" : "Bilty"}. Remove or reduce the relevant payment row(s) first.`
    );
  }
}

// ============================================================
// WRITE: CREATE
//
// Accepts an OPTIONAL externalTx: when provided, this function
// participates in the CALLER's own transaction (used by Bilty
// creation/edit to make "Bilty exists" and "its PAID row exists"
// fully atomic - if establishment fails, the whole Bilty
// create/edit rolls back too) instead of opening its own. Idempotency
// -key collision handling only applies in standalone mode (the
// nested/PAID-establishment call sites never pass one, since they
// are already atomic with their own caller and are not independently
// retried).
// ============================================================

export interface CreateSettlementPaymentInput {
  challanId?: string | null;
  biltyId?: string | null;
  component: MultiPayerComponent;
  payerAccountId: string;
  amount: number;
  createdById: string;
  idempotencyKey?: string;
}

export interface SettlementPaymentResult {
  row: SettlementPaymentRow;
  componentTotal: number;
  totalPaid: number;
  remainingDue: number;
  idempotentReplay?: boolean;
}

export async function createSettlementPayment(
  input: CreateSettlementPaymentInput,
  externalTx?: Tx
): Promise<SettlementPaymentResult> {
  const { challanId, biltyId, component, payerAccountId, amount, createdById, idempotencyKey } = input;

  if (!(amount > 0)) {
    throw new SettlementPaymentError("INVALID_AMOUNT", "Amount must be greater than zero.");
  }

  const derivedRowId = idempotencyKey ? `idem_${idempotencyKey}` : null;
  const derivedEntryId = idempotencyKey ? `idem_${idempotencyKey}_je` : null;

  const body = async (tx: Tx) => {
    const context = await resolveComponentContext(tx, component, { challanId, biltyId });
    await assertValidPayerAccount(tx, payerAccountId);

    // Release whatever the OLD single-payer mechanism still
    // attributes above this component's floor BEFORE validating the
    // new row against componentTotal, so the two mechanisms never
    // simultaneously double-claim the same Gross balance. CARRIER_RENT
    // is handled AFTER row creation instead (see the
    // syncCarrierRentFloorForChallan() call below) - its floor depends
    // on the live sum of active rows INCLUDING the one being created
    // here, which does not exist yet at this point. Never applies to
    // PAID, which has no old mechanism to transition from.
    if (component === "COLLECTION") {
      await ensureOldAttributionWithinFloor(tx, component, context, createdById);
    }

    const existingRows = await getActiveSettlementPayments(tx, component, {
      challanId: context.challanId,
      biltyId: context.biltyId,
    });

    if (component === "PAID" && existingRows.length > 0) {
      // Single-party by construction - use reassignPaidResponsibility()
      // or updateSettlementPaymentAmount() for an already-established
      // Bilty, never a second create.
      throw new SettlementPaymentError(
        "PAID_ALREADY_ESTABLISHED",
        "This Bilty already has a Paid responsibility established - edit or reassign it instead of creating a new one."
      );
    }

    const existingTotal = round2(existingRows.reduce((s, r) => s + r.amount, 0));
    const requested = round2(amount);

    if (existingTotal + requested > context.componentTotal + EPS) {
      throw new SettlementPaymentError(
        "OVER_ALLOCATION",
        `This payment of ${requested} would exceed ${context.documentLabel}'s remaining amount (${round2(context.componentTotal - existingTotal)}).`
      );
    }

    const rowId = derivedRowId || randomUUID();
    const entryId = derivedEntryId || randomUUID();

    const lines = buildLines(component, requested, payerAccountId, context.grossAccountId);
    const description = `Settlement Payment - ${context.documentLabel} - ${requested} recorded against payer`;

    const sourceType = component === "CARRIER_RENT" ? "CHALLAN" : "BILTY";
    const sourceId = (component === "CARRIER_RENT" ? context.challanId : context.biltyId) as string;
    const sourceNumber = (component === "CARRIER_RENT" ? context.challanNo : context.biltyNo) as string;
    // Every entry needs a real referenceId for audit/lookup even
    // when there is no Challan (PAID) - the Bilty id serves that
    // role, matching the existing BILTY_BOOKING convention.
    const referenceId = context.challanId ?? (context.biltyId as string);

    const payerNetBefore = context.challanId
      ? await getPartyNetFromSettlement(tx, context.challanId, payerAccountId)
      : 0;

    await tx.journalEntry.create({
      data: {
        id: entryId,
        entryDate: new Date(),
        referenceType: "SETTLEMENT_PAYMENT",
        referenceId,
        description,
        createdById,
        lines: {
          create: lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            description,
            sourceType,
            sourceId,
            sourceNumber,
          })),
        },
      },
    });

    const created = await tx.settlementPayment.create({
      data: {
        id: rowId,
        challanId: context.challanId,
        biltyId: context.biltyId,
        component,
        payerAccountId,
        amount: requested,
        journalEntryId: entryId,
        createdById,
      },
    });

    if (context.challanId) {
      const payerNetAfter = await getPartyNetFromSettlement(tx, context.challanId, payerAccountId);
      await adjustChallanOutstanding(tx, context.challanId, payerNetBefore, payerNetAfter);
    }

    // The other half of the double-drain protection: now that this
    // Bilty has its own PAID row, the OLD single-payer Collection
    // mechanism (if it ever ran for this Bilty) must retain only the
    // un-attributed ToPay slice - see syncCollectionFloorForBilty()
    // for the full reasoning. A no-op for any Bilty with no settled
    // Challan yet.
    if (component === "PAID") {
      await syncCollectionFloorForBilty(tx, context.biltyId as string, createdById);
    }

    // The Carrier Rent analogue: keep the OLD mechanism's default-
    // party attribution in sync with the live sum of active
    // CARRIER_RENT rows (now including the one just created) - see
    // syncCarrierRentFloorForChallan() for the full reasoning.
    if (component === "CARRIER_RENT") {
      await syncCarrierRentFloorForChallan(tx, context.challanId as string, createdById);
    }

    return {
      row: toRow({ ...created, amount: created.amount }),
      componentTotal: context.componentTotal,
      totalPaid: round2(existingTotal + requested),
      remainingDue: Math.max(0, round2(context.componentTotal - (existingTotal + requested))),
    };
  };

  if (externalTx) {
    return body(externalTx);
  }

  try {
    return await prisma.$transaction(body, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    const isIdempotencyCollision =
      derivedRowId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

    if (isIdempotencyCollision) {
      const existing = await prisma.settlementPayment.findUnique({ where: { id: derivedRowId! } });
      if (existing) {
        const state = await getComponentPaymentState(component, { challanId, biltyId });
        return {
          row: toRow(existing),
          componentTotal: state.componentTotal,
          totalPaid: state.totalPaid,
          remainingDue: state.remainingDue,
          idempotentReplay: true,
        };
      }
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new SettlementPaymentError(
        "CONCURRENT_SETTLEMENT_PAYMENT",
        "Another settlement payment was recorded for the same document at the same time. Please retry."
      );
    }

    throw error;
  }
}

// ============================================================
// WRITE: UPDATE (edit one row's amount, in isolation)
// ============================================================

export interface UpdateSettlementPaymentInput {
  paymentId: string;
  newAmount: number;
}

export async function updateSettlementPaymentAmount(
  input: UpdateSettlementPaymentInput,
  externalTx?: Tx
): Promise<SettlementPaymentResult> {
  const { paymentId, newAmount } = input;

  if (!(newAmount > 0)) {
    throw new SettlementPaymentError("INVALID_AMOUNT", "Amount must be greater than zero.");
  }

  const body = async (tx: Tx) => {
    const existing = await tx.settlementPayment.findUnique({ where: { id: paymentId } });
    if (!existing) {
      throw new SettlementPaymentError("SETTLEMENT_PAYMENT_NOT_FOUND", "Settlement payment row not found.");
    }

    const component = existing.component as MultiPayerComponent;
    // Resolving context for a row that already exists (about to be
    // amended, not created) - see ResolveComponentContextOptions'
    // own doc comment for why PAID's create-time allocatability
    // check must not apply here.
    const context = await resolveComponentContext(
      tx,
      component,
      { challanId: existing.challanId, biltyId: existing.biltyId },
      { forExistingPaidRow: true }
    );

    // Recalculate the component's OTHER rows' total, EXCLUDING the
    // row being edited - mirrors updateAllocationAmount()'s exact
    // pattern in lib/payment-allocation.ts.
    const otherRows = await tx.settlementPayment.findMany({
      where: {
        challanId: component === "PAID" ? undefined : context.challanId,
        biltyId: component === "CARRIER_RENT" ? null : context.biltyId,
        component,
        id: { not: paymentId },
      },
    });
    const otherTotal = round2(otherRows.reduce((s, r) => s + Number(r.amount), 0));
    const requested = round2(newAmount);

    if (otherTotal + requested > context.componentTotal + EPS) {
      throw new SettlementPaymentError(
        "OVER_ALLOCATION",
        `New amount (${requested}) would exceed ${context.documentLabel}'s remaining amount (${round2(context.componentTotal - otherTotal)}).`
      );
    }

    const currentAmount = round2(Number(existing.amount));
    const delta = round2(requested - currentAmount);

    if (delta !== 0) {
      const lines =
        delta > 0
          ? buildLines(component, Math.abs(delta), existing.payerAccountId, context.grossAccountId)
          : buildReverseLines(component, Math.abs(delta), existing.payerAccountId, context.grossAccountId);

      const description = `Settlement Payment Correction - ${context.documentLabel} - ${currentAmount} -> ${requested}`;
      const sourceNumber = (component === "CARRIER_RENT" ? context.challanNo : context.biltyNo) as string;
      const referenceId = context.challanId ?? (context.biltyId as string);

      const payerNetBefore = context.challanId
        ? await getPartyNetFromSettlement(tx, context.challanId, existing.payerAccountId)
        : 0;

      await tx.journalEntry.create({
        data: {
          entryDate: new Date(),
          referenceType: "SETTLEMENT_PAYMENT_CORRECTION",
          referenceId,
          description,
          createdById: existing.createdById || undefined,
          lines: {
            create: lines.map((l) => ({
              accountId: l.accountId,
              debit: l.debit,
              credit: l.credit,
              description,
              sourceType: "SETTLEMENT_PAYMENT",
              sourceId: existing.id,
              sourceNumber,
            })),
          },
        },
      });

      if (context.challanId) {
        const payerNetAfter = await getPartyNetFromSettlement(tx, context.challanId, existing.payerAccountId);
        await adjustChallanOutstanding(tx, context.challanId, payerNetBefore, payerNetAfter);
      }
    }

    const updated = await tx.settlementPayment.update({
      where: { id: paymentId },
      data: { amount: requested },
    });

    // Re-sync the OLD Collection mechanism's floor to this PAID row's
    // NEW amount - handles both an increase (releases more to the
    // PAID party) and a decrease (restores the difference back to the
    // OLD Collection party).
    if (component === "PAID") {
      await syncCollectionFloorForBilty(tx, context.biltyId as string, existing.createdById);
    }

    // Re-sync the OLD Carrier Rent mechanism's default-party
    // attribution to this row's NEW amount - an increase releases
    // more from the default party, a decrease restores the
    // difference back to it.
    if (component === "CARRIER_RENT") {
      await syncCarrierRentFloorForChallan(tx, context.challanId as string, existing.createdById);
    }

    return {
      row: toRow(updated),
      componentTotal: context.componentTotal,
      totalPaid: round2(otherTotal + requested),
      remainingDue: Math.max(0, round2(context.componentTotal - (otherTotal + requested))),
    };
  };

  if (externalTx) {
    return body(externalTx);
  }

  try {
    return await prisma.$transaction(body, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new SettlementPaymentError(
        "CONCURRENT_SETTLEMENT_PAYMENT",
        "Another change to this settlement payment happened at the same time. Please retry."
      );
    }
    throw error;
  }
}

// ============================================================
// WRITE: DELETE (remove one row, reverse only its own effect)
// ============================================================

export interface DeleteSettlementPaymentResult {
  deletedRow: SettlementPaymentRow;
  componentTotal: number;
  totalPaid: number;
  remainingDue: number;
}

export async function deleteSettlementPayment(
  paymentId: string,
  externalTx?: Tx
): Promise<DeleteSettlementPaymentResult> {
  const body = async (tx: Tx) => {
    const existing = await tx.settlementPayment.findUnique({ where: { id: paymentId } });
    if (!existing) {
      throw new SettlementPaymentError("SETTLEMENT_PAYMENT_NOT_FOUND", "Settlement payment row not found.");
    }

    const component = existing.component as MultiPayerComponent;

    // SAFE REVERSAL, not delete-at-any-cost: a PAID row's own
    // reclassification (Dr Party / Cr Gross) can only be safely
    // reversed while NOTHING has yet been verified against it. Once a
    // real Daily Posting receipt exists (partial or full), that
    // receipt already cleared this exact Party/Bilty balance via a
    // real, historical JournalEntry - reversing the PAID
    // establishment underneath it would leave that Party with a
    // fabricated negative/credit balance for money they already paid.
    // Reject outright rather than silently deleting, reassigning, or
    // otherwise touching that historical receipt.
    if (component === "PAID") {
      const verification = await getBiltyPaidVerification(tx, existing.biltyId as string);
      if (verification.verifiedReceivedAmount > EPS) {
        throw new SettlementPaymentError(
          "PAID_DELETE_BLOCKED_VERIFIED_RECEIPT",
          `Cannot remove Paid responsibility: ${verification.verifiedReceivedAmount} has already been verified as received against this Bilty's Paid amount (${verification.paidAmount}). Reduce/reverse the relevant Daily Posting receipt first, or reassign responsibility instead of removing it.`
        );
      }
    }

    // Resolving context for a row that already exists (about to be
    // reversed, not created) - see ResolveComponentContextOptions'
    // own doc comment for why PAID's create-time allocatability
    // check must not apply here (this is exactly the bug this option
    // was added to fix: a Bilty's own advance may already have been
    // updated to 0 - a legitimate Paid -> To-Pay reversal, not "no
    // Paid amount to allocate" - by the SAME transaction's caller
    // just before this delete runs).
    const context = await resolveComponentContext(
      tx,
      component,
      { challanId: existing.challanId, biltyId: existing.biltyId },
      { forExistingPaidRow: true }
    );

    const amount = round2(Number(existing.amount));
    const lines = buildReverseLines(component, amount, existing.payerAccountId, context.grossAccountId);
    const description = `Settlement Payment Removed - ${context.documentLabel} - reversing ${amount}`;
    const sourceNumber = (component === "CARRIER_RENT" ? context.challanNo : context.biltyNo) as string;
    const referenceId = context.challanId ?? (context.biltyId as string);

    const payerNetBefore = context.challanId
      ? await getPartyNetFromSettlement(tx, context.challanId, existing.payerAccountId)
      : 0;

    await tx.journalEntry.create({
      data: {
        entryDate: new Date(),
        referenceType: "SETTLEMENT_PAYMENT_REVERSAL",
        referenceId,
        description,
        createdById: existing.createdById || undefined,
        lines: {
          create: lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            description,
            sourceType: "SETTLEMENT_PAYMENT",
            sourceId: existing.id,
            sourceNumber,
          })),
        },
      },
    });

    await tx.settlementPayment.delete({ where: { id: paymentId } });

    if (context.challanId) {
      const payerNetAfter = await getPartyNetFromSettlement(tx, context.challanId, existing.payerAccountId);
      await adjustChallanOutstanding(tx, context.challanId, payerNetBefore, payerNetAfter);
    }

    // Restore the OLD single-payer Collection mechanism's attribution
    // now that this Bilty's Paid slice is no longer separately
    // attributed - the other half of the double-drain protection, in
    // reverse. Verified-receipt-free by construction (rejected above
    // otherwise). A no-op for a Bilty with no settled Challan yet.
    if (component === "PAID") {
      await syncCollectionFloorForBilty(tx, existing.biltyId as string, existing.createdById);
    }

    // Restore the OLD Carrier Rent mechanism's default-party
    // attribution now that this row is gone - the other half of the
    // partial-payment fix, in reverse. No stale payer liability and
    // no duplicated transition lines: ensureOldAttributionWithinFloor()
    // recomputes the live delta from the ledger every time and is a
    // no-op once the target floor is already reached.
    if (component === "CARRIER_RENT") {
      await syncCarrierRentFloorForChallan(tx, context.challanId as string, existing.createdById);
    }

    const otherRows = await tx.settlementPayment.findMany({
      where: {
        challanId: component === "PAID" ? undefined : context.challanId,
        biltyId: component === "CARRIER_RENT" ? null : context.biltyId,
        component,
      },
    });
    const totalPaid = round2(otherRows.reduce((s, r) => s + Number(r.amount), 0));

    return {
      deletedRow: toRow(existing),
      componentTotal: context.componentTotal,
      totalPaid,
      remainingDue: Math.max(0, round2(context.componentTotal - totalPaid)),
    };
  };

  if (externalTx) {
    return body(externalTx);
  }

  try {
    return await prisma.$transaction(body, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new SettlementPaymentError(
        "CONCURRENT_SETTLEMENT_PAYMENT",
        "Another change to this settlement payment happened at the same time. Please retry."
      );
    }
    throw error;
  }
}

// ============================================================
// PAID RESPONSIBILITY REASSIGNMENT (Consignor <-> Consignee)
//
// Structurally the PAID analogue of applySettlementReassignment()
// (lib/settlement-correction.ts) - moves responsibility without
// re-requesting money already verified as received. Unlike Collection
// /Carrier Rent reassignment, PAID's "already verified" portion lives
// in a DIFFERENT referenceType (DAILY_POSTING, via Daily Posting -
// not a SETTLEMENT_CORRECTION-style entry), so the amount to move is
// computed via getBiltyPaidVerification()'s own live read (Bilty.
// advance minus verified-received) rather than getComponentNetAmount().
//
// MUST be called BEFORE the caller updates Bilty.paidResponsiblePartyId
// - it needs resolveBiltyPaidResponsibleParty() to still resolve the
// OLD party while computing what remains unverified.
//
// Always takes an explicit `tx` (the caller's own transaction) -
// never called standalone, since it only ever happens as part of a
// larger Bilty PATCH that also updates paidResponsiblePartyId itself.
// ============================================================

export interface ReassignPaidResponsibilityResult {
  reassigned: boolean;
  amountMoved: number;
}

export async function reassignPaidResponsibility(
  tx: Tx,
  biltyId: string,
  newPayerAccountId: string,
  createdById: string
): Promise<ReassignPaidResponsibilityResult> {
  // Imported lazily to avoid a require-cycle at module load time
  // (lib/bilty-paid-verification.ts imports lib/document-party-
  // resolution.ts, which does not import this module, so this is
  // safe, but kept local to keep the dependency direction obvious).
  const { getBiltyPaidVerification } = await import("@/lib/bilty-paid-verification");

  const existingRow = await tx.settlementPayment.findFirst({
    where: { component: "PAID", biltyId },
  });

  if (!existingRow) {
    // Nothing established yet - not a reassignment, the caller
    // should establish a fresh PAID row instead via
    // createSettlementPayment().
    return { reassigned: false, amountMoved: 0 };
  }

  if (existingRow.payerAccountId === newPayerAccountId) {
    return { reassigned: false, amountMoved: 0 };
  }

  await assertValidPayerAccount(tx, newPayerAccountId);

  // Read BEFORE any mutation - resolves the OLD party's remaining
  // unverified amount from the live ledger.
  const verification = await getBiltyPaidVerification(tx, biltyId);
  const remaining = round2(verification.unverifiedAmount);

  const bilty = await tx.bilty.findUniqueOrThrow({ where: { id: biltyId }, select: { biltyNo: true } });

  if (remaining > EPS) {
    const description = `Paid Responsibility Reassignment - Bilty ${bilty.biltyNo} - releasing ${remaining}`;
    await tx.journalEntry.create({
      data: {
        entryDate: new Date(),
        referenceType: "PAID_RESPONSIBILITY_REASSIGNMENT",
        referenceId: biltyId,
        description,
        createdById,
        lines: {
          create: [
            { accountId: newPayerAccountId, debit: remaining, credit: 0, description, sourceType: "BILTY", sourceId: biltyId, sourceNumber: bilty.biltyNo },
            { accountId: existingRow.payerAccountId, debit: 0, credit: remaining, description, sourceType: "BILTY", sourceId: biltyId, sourceNumber: bilty.biltyNo },
          ],
        },
      },
    });
  }

  // The row itself is updated to reflect who is NOW responsible -
  // its own `amount` stays the Bilty's total Paid claim (unchanged by
  // a pure responsibility move), matching how Bilty.advance itself
  // is unaffected by a reassignment.
  await tx.settlementPayment.update({
    where: { id: existingRow.id },
    data: { payerAccountId: newPayerAccountId },
  });

  return { reassigned: true, amountMoved: remaining };
}

// ============================================================
// OWNERSHIP GUARD (for API routes)
// ============================================================

export async function getSettlementPaymentOrThrow(paymentId: string): Promise<SettlementPaymentRow> {
  const row = await prisma.settlementPayment.findUnique({ where: { id: paymentId } });
  if (!row) {
    throw new SettlementPaymentError("SETTLEMENT_PAYMENT_NOT_FOUND", "Settlement payment row not found.");
  }
  return toRow(row);
}
