import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  findSettledPartyAccountId,
  type SettlementComponent,
} from "@/lib/settlement-correction";
import { getActiveSettlementPayers } from "@/lib/settlement-payments";

// ============================================================
// PAYMENT ALLOCATION (Party Ledger 2.0, Step 2A)
//
// This module is a PURE reporting/reconciliation layer over the
// EXISTING, protected accounting architecture. It never creates,
// mutates, or reverses a JournalEntry/JournalLine, never touches
// lib/settlement-accounting.ts / lib/challan-financials.ts /
// lib/pnl.ts, and every figure it exposes is derived on read from
// the SAME sources those files already trust - never a second
// calculation engine.
//
// "Payment" = the Party-side JournalLine of an already-posted
// Daily Posting Cash/Bank <-> Party movement (see getPaymentLine()
// for the exact, conservative qualifying shape).
//
// "Allocation" = a PaymentAllocation row connecting that EXISTING,
// unmodified line to an outstanding Bilty/Challan for a specific
// amount. Many rows may share one journalLineId (one payment split
// across documents); many rows may share one target (many payments
// applied to one document over time).
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type AllocationTargetType = "BILTY" | "CHALLAN";
export type AllocationStatus = "UNALLOCATED" | "PARTIALLY_ALLOCATED" | "FULLY_ALLOCATED";

export class AllocationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AllocationError";
    this.code = code;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ============================================================
// PAYMENT IDENTIFICATION
//
// An arbitrary JournalLine does NOT qualify. A line qualifies as
// an allocatable payment only when ALL of the following hold:
//
//  1. Its own account.category is PARTY, and that account is
//     linked to a real Party (account.partyId is set).
//  2. Its JournalEntry.referenceType is "DAILY_POSTING" - the
//     ONLY referenceType that ever represents actual Cash/Bank
//     movement in this system (Settlement/Bilty/Challan creation
//     never touch Cash/Bank).
//  3. Its JournalEntry is not binned (isDeleted: false).
//  4. Its JournalEntry has EXACTLY TWO lines, and the OTHER line's
//     account.category is CASH or BANK.
//
// (4) is deliberately conservative. A single Daily Posting
// submission can bundle several unrelated DIRECT lines into one
// JournalEntry (see app/api/daily-posting/route.ts's per-document
// grouping) - such an entry has no reliable way to say which
// Cash/Bank line pairs with which Party line once persisted, so it
// is excluded rather than guessed at. Only the unambiguous
// single-pair shape qualifies.
//
// A qualifying line's own sourceType MUST ALSO be something other
// than "CHALLAN"/"BILTY" to be ELIGIBLE for NEW allocation (see
// isEligibleForAllocation below) - a line already tagged to a
// specific document at posting time is already fully attributed by
// the EXISTING lib/challan-financials.ts received/paid calculation;
// allocating it again would double-count that same money against
// both mechanisms.
// ============================================================

export interface PaymentLineInfo {
  journalLineId: string;
  amount: number;
  direction: "DEBIT" | "CREDIT";
  partyAccountId: string;
  partyId: string;
  entryDate: Date;
  isDeleted: boolean;
  sourceType: string | null;
}

export async function getPaymentLine(tx: Tx, journalLineId: string): Promise<PaymentLineInfo> {
  const line = await tx.journalLine.findUnique({
    where: { id: journalLineId },
    select: {
      id: true,
      debit: true,
      credit: true,
      sourceType: true,
      account: { select: { id: true, category: true, partyId: true } },
      journalEntry: {
        select: {
          referenceType: true,
          isDeleted: true,
          entryDate: true,
          lines: {
            select: { id: true, account: { select: { category: true } } },
          },
        },
      },
    },
  });

  if (!line) {
    throw new AllocationError("PAYMENT_NOT_FOUND", "Payment line not found.");
  }

  if (line.account.category !== "PARTY" || !line.account.partyId) {
    throw new AllocationError(
      "NOT_A_PAYMENT",
      "This JournalLine is not a Party-side accounting line and cannot be allocated."
    );
  }

  if (line.journalEntry.referenceType !== "DAILY_POSTING") {
    throw new AllocationError(
      "NOT_A_PAYMENT",
      "Only a Daily Posting entry represents an actual Cash/Bank movement - this line does not qualify as a payment."
    );
  }

  const entryLines = line.journalEntry.lines;
  if (entryLines.length !== 2) {
    throw new AllocationError(
      "AMBIGUOUS_PAYMENT",
      "This Daily Posting entry does not represent a single, unambiguous Cash/Bank <-> Party movement and cannot be allocated."
    );
  }

  const other = entryLines.find((l) => l.id !== line.id);
  if (!other || (other.account.category !== "CASH" && other.account.category !== "BANK")) {
    throw new AllocationError(
      "NOT_A_PAYMENT",
      "This JournalLine is not paired with a Cash/Bank movement and cannot be allocated."
    );
  }

  const debit = Number(line.debit);
  const credit = Number(line.credit);
  const amount = debit > 0 ? debit : credit;

  if (amount <= 0) {
    throw new AllocationError("NOT_A_PAYMENT", "This JournalLine has no amount.");
  }

  return {
    journalLineId: line.id,
    amount: round2(amount),
    direction: debit > 0 ? "DEBIT" : "CREDIT",
    partyAccountId: line.account.id,
    partyId: line.account.partyId,
    entryDate: line.journalEntry.entryDate,
    isDeleted: line.journalEntry.isDeleted,
    sourceType: line.sourceType,
  };
}

/**
 * A qualifying payment (getPaymentLine) is ELIGIBLE for NEW
 * allocation only if it was NOT already tagged to a specific
 * Challan/Bilty at posting time - such a line is already fully
 * counted in that document's own received/paid via
 * lib/challan-financials.ts, and allocating it again would
 * double-count the same money against two mechanisms.
 */
export function isEligibleForAllocation(payment: PaymentLineInfo): boolean {
  return payment.sourceType !== "CHALLAN" && payment.sourceType !== "BILTY";
}

// ============================================================
// PAYMENT-SIDE READ HELPERS
// ============================================================

export async function getAllocatedAmountForPayment(tx: Tx, journalLineId: string): Promise<number> {
  const rows = await tx.paymentAllocation.findMany({
    where: { journalLineId },
    select: { allocatedAmount: true },
  });
  return round2(rows.reduce((sum, r) => sum + Number(r.allocatedAmount), 0));
}

export async function getUnallocatedAmountForPayment(tx: Tx, journalLineId: string): Promise<number> {
  const payment = await getPaymentLine(tx, journalLineId);
  const allocated = await getAllocatedAmountForPayment(tx, journalLineId);
  return Math.max(0, round2(payment.amount - allocated));
}

export async function getAllocationStatusForPayment(tx: Tx, journalLineId: string): Promise<AllocationStatus> {
  const payment = await getPaymentLine(tx, journalLineId);
  const allocated = await getAllocatedAmountForPayment(tx, journalLineId);
  if (allocated <= 0.009) return "UNALLOCATED";
  if (allocated >= payment.amount - 0.009) return "FULLY_ALLOCATED";
  return "PARTIALLY_ALLOCATED";
}

// ============================================================
// DOCUMENT-SIDE READ HELPERS
// ============================================================

export async function getAllocatedAmountForDocument(
  tx: Tx,
  targetSourceType: AllocationTargetType,
  targetSourceId: string
): Promise<number> {
  const rows = await tx.paymentAllocation.findMany({
    where: { targetSourceType, targetSourceId },
    select: { allocatedAmount: true },
  });
  return round2(rows.reduce((sum, r) => sum + Number(r.allocatedAmount), 0));
}

interface ResolvedTarget {
  targetSourceType: AllocationTargetType;
  targetSourceId: string;
  documentNo: string;
  documentDate: Date;
  /** The one account this target's dues currently belong to. */
  responsiblePartyAccountId: string;
  /** The document's original total dues attributable to that one party. */
  totalDue: number;
  /** Already received/paid via EXISTING sourceType/sourceId-tagged Daily Postings (lib/challan-financials.ts's own figures - never recomputed here). */
  existingReceivedOrPaid: number;
}

const BOOKING_INCOME_CACHE = { id: null as string | null };
const OTHER_EXPENSE_CACHE = { id: null as string | null };
const CARRIER_RENT_CACHE = { id: null as string | null };

async function getBookingIncomeAccountId(tx: Tx): Promise<string> {
  if (BOOKING_INCOME_CACHE.id) return BOOKING_INCOME_CACHE.id;
  const account = await tx.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } });
  if (!account) throw new AllocationError("CONFIG_MISSING", "Required BOOKING_INCOME account is not configured.");
  BOOKING_INCOME_CACHE.id = account.id;
  return account.id;
}

async function getOtherExpenseAccountId(tx: Tx): Promise<string> {
  if (OTHER_EXPENSE_CACHE.id) return OTHER_EXPENSE_CACHE.id;
  const account = await tx.account.findFirst({ where: { category: "OTHER_EXPENSE", isActive: true }, select: { id: true } });
  if (!account) throw new AllocationError("CONFIG_MISSING", "Required OTHER_EXPENSE account is not configured.");
  OTHER_EXPENSE_CACHE.id = account.id;
  return account.id;
}

async function getCarrierRentAccountId(tx: Tx): Promise<string> {
  if (CARRIER_RENT_CACHE.id) return CARRIER_RENT_CACHE.id;
  const account = await tx.account.findFirst({ where: { category: "CARRIER_RENT", isActive: true }, select: { id: true } });
  if (!account) throw new AllocationError("CONFIG_MISSING", "Required CARRIER_RENT account is not configured.");
  CARRIER_RENT_CACHE.id = account.id;
  return account.id;
}

/**
 * Resolves a CHALLAN allocation target - the Challan's Carrier Rent
 * component ONLY (see Section F of the Party Ledger 2.0 inspection:
 * "Bilty for Collection/Commission, Challan for Carrier Rent").
 *
 * IMPORTANT: this deliberately does NOT use the Challan's blended
 * outstandingReceivable/outstandingPayable aggregate (as an earlier
 * version of this function did). That aggregate mixes Collection +
 * Carrier Rent + Commission together, which - for the common case
 * of a single-Bilty Challan - is the SAME money resolveBiltyTarget()
 * already exposes as that Bilty's own Collection/Commission target.
 * Live testing during this feature's own build caught exactly that:
 * a single-Bilty Challan let the same underlying debt be allocated
 * once as "the Challan" and again as "the Bilty", double-counting a
 * single receipt against what was really one Rs. 2,000 debt. Scoping
 * CHALLAN targets to Carrier Rent alone (via the same per-component
 * findSettledPartyAccountId() every correction/reassignment already
 * uses) makes CHALLAN and BILTY targets structurally disjoint money,
 * so this can never happen again.
 */
async function resolveChallanTarget(tx: Tx, challanId: string): Promise<ResolvedTarget> {
  // The new multi-payer Settlement Payment engine (lib/settlement-
  // payments.ts) can split this Challan's Carrier Rent across
  // several simultaneous payers, each responsible for only part of
  // it. This module's per-document model (one target = one
  // responsiblePartyAccountId = one totalDue) cannot represent that
  // split without a deeper redesign, which is explicitly out of
  // scope here - rather than silently picking one payer (or the sum,
  // misattributing it to whichever party happens to be first),
  // allocation against this Challan's Carrier Rent is refused
  // outright whenever ANY multi-payer row exists for it. A document
  // that has never used the new engine is completely unaffected -
  // this check is a no-op (empty array) for every historical/
  // single-payer Challan.
  const carrierRentPayers = await getActiveSettlementPayers(tx, "CARRIER_RENT", { challanId });
  if (carrierRentPayers.length > 0) {
    throw new AllocationError(
      "MULTI_PAYER_NOT_ALLOCATABLE",
      "This Challan's Carrier Rent has multiple settlement payment rows recorded against it and cannot currently be targeted by Payment Allocation. Use the Settlement Payment breakdown instead."
    );
  }

  const challan = await tx.challan.findUnique({
    where: { id: challanId },
    select: {
      id: true,
      challanNo: true,
      loadingDate: true,
      isDeleted: true,
      isSettled: true,
      settlementJournalEntryId: true,
      carrierRent: true,
    },
  });

  if (!challan || challan.isDeleted) {
    throw new AllocationError("DOCUMENT_NOT_FOUND", "Target Challan not found.");
  }
  if (!challan.isSettled || !challan.settlementJournalEntryId) {
    throw new AllocationError(
      "DOCUMENT_NOT_ALLOCATABLE",
      "This Challan has not been settled yet - it has no established outstanding dues to allocate against."
    );
  }

  const carrierRent = Number(challan.carrierRent);
  if (carrierRent <= 0) {
    throw new AllocationError(
      "DOCUMENT_NOT_ALLOCATABLE",
      "This Challan has no Carrier Rent due - allocate against its Bilty(ies) for Collection/Commission instead."
    );
  }

  const carrierRentAccountId = await getCarrierRentAccountId(tx);
  const partyAccountId = await findSettledPartyAccountId(
    tx,
    challan.id,
    challan.settlementJournalEntryId,
    "CARRIER_RENT",
    carrierRentAccountId,
    null
  );

  if (!partyAccountId) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "No responsible party is established for this Challan's Carrier Rent yet.");
  }

  // Existing received/paid tagged specifically at the Challan level.
  // Collection/Commission Daily Postings are always Bilty-tagged
  // (see resolveBiltyTarget) - this never overlaps with that query.
  const taggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "CHALLAN",
      sourceId: challan.id,
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      account: { category: "PARTY", id: partyAccountId },
    },
    select: { debit: true, credit: true },
  });
  const receivedOrPaid = taggedLines.reduce((s, l) => s + Number(l.debit) + Number(l.credit), 0);

  return {
    targetSourceType: "CHALLAN",
    targetSourceId: challan.id,
    documentNo: challan.challanNo,
    documentDate: challan.loadingDate,
    responsiblePartyAccountId: partyAccountId,
    totalDue: carrierRent,
    existingReceivedOrPaid: receivedOrPaid,
  };
}

/**
 * Resolves a BILTY allocation target. A Bilty can have up to two
 * independent components - Collection (Bilty.total) and Commission
 * (Bilty.agentCommission) - each with its OWN responsible party
 * (see the multi-party Settlement tests). Reuses
 * findSettledPartyAccountId() (the same per-component lookup
 * Settlement corrections/reassignments already rely on) rather than
 * a new resolution formula. If the two components resolve to
 * DIFFERENT parties, rejects as ambiguous rather than guessing which
 * portion of a blended "received" figure belongs to which party -
 * the same principle the Daily Posting P0 fix already established
 * at the Challan level.
 */
async function resolveBiltyTarget(tx: Tx, biltyId: string): Promise<ResolvedTarget> {
  // Same reasoning as resolveChallanTarget()'s Carrier Rent guard
  // above, for this Bilty's Collection (Remaining To-Pay) component.
  // Need the owning Challan first to scope the lookup correctly.
  const owningLink = await tx.challanBilty.findFirst({
    where: { biltyId, challan: { isDeleted: false, status: { not: "CANCELLED" } } },
    select: { challanId: true },
  });
  if (owningLink) {
    const collectionPayers = await getActiveSettlementPayers(tx, "COLLECTION", {
      challanId: owningLink.challanId,
      biltyId,
    });
    if (collectionPayers.length > 0) {
      throw new AllocationError(
        "MULTI_PAYER_NOT_ALLOCATABLE",
        "This Bilty's Collection has multiple settlement payment rows recorded against it and cannot currently be targeted by Payment Allocation. Use the Settlement Payment breakdown instead."
      );
    }
  }

  const bilty = await tx.bilty.findUnique({
    where: { id: biltyId },
    select: {
      id: true,
      biltyNo: true,
      date: true,
      isDeleted: true,
      total: true,
      agentCommission: true,
      challanBilties: {
        where: { challan: { isDeleted: false, status: { not: "CANCELLED" } } },
        select: {
          challan: {
            select: { id: true, challanNo: true, isSettled: true, settlementJournalEntryId: true },
          },
        },
      },
    },
  });

  if (!bilty || bilty.isDeleted) {
    throw new AllocationError("DOCUMENT_NOT_FOUND", "Target Bilty not found.");
  }

  const activeChallan = bilty.challanBilties[0]?.challan;
  if (!activeChallan || !activeChallan.isSettled || !activeChallan.settlementJournalEntryId) {
    throw new AllocationError(
      "DOCUMENT_NOT_ALLOCATABLE",
      "This Bilty's Challan has not been settled yet - it has no established outstanding dues to allocate against."
    );
  }

  const total = Number(bilty.total);
  const commission = Number(bilty.agentCommission);

  const components: { component: SettlementComponent; amount: number; incomeOrExpenseAccountId: string }[] = [];
  if (total > 0) components.push({ component: "COLLECTION", amount: total, incomeOrExpenseAccountId: await getBookingIncomeAccountId(tx) });
  if (commission > 0) components.push({ component: "COMMISSION", amount: commission, incomeOrExpenseAccountId: await getOtherExpenseAccountId(tx) });

  if (components.length === 0) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "This Bilty has no outstanding amount.");
  }

  const resolved = await Promise.all(
    components.map(async (c) => ({
      ...c,
      partyAccountId: await findSettledPartyAccountId(
        tx,
        activeChallan.id,
        activeChallan.settlementJournalEntryId!,
        c.component,
        c.incomeOrExpenseAccountId,
        bilty.id
      ),
    }))
  );

  const distinctParties = new Set(resolved.filter((r) => r.partyAccountId).map((r) => r.partyAccountId));

  if (distinctParties.size === 0) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "No responsible party is established for this Bilty yet.");
  }
  if (distinctParties.size > 1) {
    throw new AllocationError(
      "AMBIGUOUS_DOCUMENT",
      "This Bilty's Collection and Commission are owed by different parties. Allocation cannot target this Bilty as a whole."
    );
  }

  const partyAccountId = [...distinctParties][0]!;
  const totalDue = resolved.filter((r) => r.partyAccountId === partyAccountId).reduce((s, r) => s + r.amount, 0);

  // Existing received/paid tagged specifically to this Bilty (same
  // matching convention lib/challan-financials.ts already uses for
  // its own Challan-level aggregate - just scoped to one Bilty here,
  // since a payment eligible for allocation is, by construction,
  // never already tagged this way; see isEligibleForAllocation).
  const taggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: bilty.id,
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      account: { category: "PARTY", id: partyAccountId },
    },
    select: { debit: true, credit: true },
  });

  const receivedOrPaid = taggedLines.reduce((s, l) => s + Number(l.debit) + Number(l.credit), 0);

  return {
    targetSourceType: "BILTY",
    targetSourceId: bilty.id,
    documentNo: bilty.biltyNo,
    documentDate: bilty.date,
    responsiblePartyAccountId: partyAccountId,
    totalDue,
    existingReceivedOrPaid: receivedOrPaid,
  };
}

export async function resolveAllocationTarget(
  tx: Tx,
  targetSourceType: AllocationTargetType,
  targetSourceId: string
): Promise<ResolvedTarget> {
  if (targetSourceType === "CHALLAN") return resolveChallanTarget(tx, targetSourceId);
  if (targetSourceType === "BILTY") return resolveBiltyTarget(tx, targetSourceId);
  throw new AllocationError("INVALID_TARGET_TYPE", `Unsupported allocation target type: ${targetSourceType}`);
}

export interface DocumentAllocationState extends ResolvedTarget {
  allocatedViaTable: number;
  remainingAllocatable: number;
}

export async function getRemainingAllocatableAmountForDocument(
  tx: Tx,
  targetSourceType: AllocationTargetType,
  targetSourceId: string
): Promise<DocumentAllocationState> {
  const target = await resolveAllocationTarget(tx, targetSourceType, targetSourceId);
  const allocatedViaTable = await getAllocatedAmountForDocument(tx, targetSourceType, targetSourceId);
  const remaining = Math.max(0, round2(target.totalDue - target.existingReceivedOrPaid - allocatedViaTable));
  return { ...target, allocatedViaTable, remainingAllocatable: remaining };
}

// ============================================================
// VALIDATION
// ============================================================

interface AllocationRequestItem {
  targetSourceType: AllocationTargetType;
  targetSourceId: string;
  amount: number;
}

async function validateSingleAllocation(
  tx: Tx,
  payment: PaymentLineInfo,
  item: AllocationRequestItem
): Promise<DocumentAllocationState> {
  if (item.amount <= 0) {
    throw new AllocationError("INVALID_AMOUNT", "Allocation amount must be greater than zero.");
  }

  const state = await getRemainingAllocatableAmountForDocument(tx, item.targetSourceType, item.targetSourceId);

  if (state.responsiblePartyAccountId !== payment.partyAccountId) {
    throw new AllocationError(
      "PARTY_MISMATCH",
      `This payment belongs to a different Party than the one responsible for ${item.targetSourceType} ${state.documentNo}.`
    );
  }

  if (round2(item.amount) > state.remainingAllocatable + 0.009) {
    throw new AllocationError(
      "DOCUMENT_LIMIT_EXCEEDED",
      `Allocation of ${item.amount} exceeds ${item.targetSourceType} ${state.documentNo}'s remaining allocatable amount of ${state.remainingAllocatable}.`
    );
  }

  return state;
}

// ============================================================
// WRITE: MANUAL ALLOCATION (atomic, all-or-nothing)
// ============================================================

export interface CreateAllocationsInput {
  journalLineId: string;
  allocations: AllocationRequestItem[];
  createdById: string;
  /** Optional - reuses the same idempotency-key-as-id trick used by
   * Daily Posting (see app/api/daily-posting/route.ts) so an exact
   * resubmission of the same request cannot create duplicate rows,
   * without any new schema/column. */
  idempotencyKey?: string;
}

export interface AllocationRowResult {
  id: string;
  targetSourceType: AllocationTargetType;
  targetSourceId: string;
  allocatedAmount: number;
}

export interface CreateAllocationsResult {
  created: AllocationRowResult[];
  totalAllocated: number;
  remainingUnallocated: number;
  idempotentReplay?: boolean;
}

/**
 * Creates one or more PaymentAllocation rows against a single
 * payment, atomically: if ANY requested allocation is invalid, NONE
 * are created. Uses a SERIALIZABLE transaction so two concurrent
 * requests racing for the same remaining payment/document balance
 * cannot both succeed (Postgres aborts one with a serialization
 * failure, which is surfaced as a clear, retryable error) - the
 * final allocated total can never exceed the payment amount or any
 * target document's remaining allocatable amount.
 */
export async function createAllocations(input: CreateAllocationsInput): Promise<CreateAllocationsResult> {
  const { journalLineId, allocations, createdById, idempotencyKey } = input;

  if (allocations.length === 0) {
    throw new AllocationError("NO_ALLOCATIONS", "At least one allocation is required.");
  }

  const derivedIds = idempotencyKey
    ? allocations.map((_, i) => `idem_${idempotencyKey}_${i}`)
    : null;

  const run = () =>
    prisma.$transaction(
      async (tx) => {
        const payment = await getPaymentLine(tx, journalLineId);

        if (payment.isDeleted) {
          throw new AllocationError("PAYMENT_DELETED", "This payment has been moved to Bin and cannot be allocated.");
        }
        if (!isEligibleForAllocation(payment)) {
          throw new AllocationError(
            "PAYMENT_ALREADY_DOCUMENT_LINKED",
            "This payment was already posted against a specific Challan/Bilty and is already fully attributed - it cannot also be manually allocated."
          );
        }

        const unallocated = await getUnallocatedAmountForPayment(tx, journalLineId);
        const requestedTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));

        if (requestedTotal > unallocated + 0.009) {
          throw new AllocationError(
            "PAYMENT_LIMIT_EXCEEDED",
            `Requested allocation total (${requestedTotal}) exceeds this payment's unallocated amount (${unallocated}).`
          );
        }

        // Validate EVERY line before creating ANY row - all-or-nothing.
        // Re-validated against the SAME transaction's live reads, so
        // a concurrent competing allocation is either serialized
        // before or after this one, never interleaved.
        for (const item of allocations) {
          await validateSingleAllocation(tx, payment, item);
        }

        const created: AllocationRowResult[] = [];
        for (let i = 0; i < allocations.length; i++) {
          const item = allocations[i];
          const row = await tx.paymentAllocation.create({
            data: {
              ...(derivedIds ? { id: derivedIds[i] } : {}),
              journalLineId,
              targetSourceType: item.targetSourceType,
              targetSourceId: item.targetSourceId,
              allocatedAmount: round2(item.amount),
              createdById,
            },
          });
          created.push({
            id: row.id,
            targetSourceType: row.targetSourceType as AllocationTargetType,
            targetSourceId: row.targetSourceId,
            allocatedAmount: Number(row.allocatedAmount),
          });
        }

        const totalAllocated = await getAllocatedAmountForPayment(tx, journalLineId);
        const remainingUnallocated = await getUnallocatedAmountForPayment(tx, journalLineId);

        return { created, totalAllocated, remainingUnallocated };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

  try {
    return await run();
  } catch (error) {
    const isIdempotencyCollision =
      derivedIds && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

    if (isIdempotencyCollision) {
      const existing = await prisma.paymentAllocation.findMany({ where: { id: { in: derivedIds! } } });
      if (existing.length === derivedIds!.length) {
        const totalAllocated = await getAllocatedAmountForPayment(prisma, journalLineId);
        const remainingUnallocated = await getUnallocatedAmountForPayment(prisma, journalLineId);
        return {
          created: existing.map((row) => ({
            id: row.id,
            targetSourceType: row.targetSourceType as AllocationTargetType,
            targetSourceId: row.targetSourceId,
            allocatedAmount: Number(row.allocatedAmount),
          })),
          totalAllocated,
          remainingUnallocated,
          idempotentReplay: true,
        };
      }
    }

    // A Postgres serialization failure under SERIALIZABLE isolation
    // (code 40001) means a genuinely concurrent, conflicting
    // allocation won the race - surface a clear, retryable error
    // rather than a generic 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new AllocationError(
        "CONCURRENT_ALLOCATION",
        "Another allocation was made to the same payment/document at the same time. Please retry."
      );
    }

    throw error;
  }
}

// ============================================================
// AUTO ALLOCATION (oldest-first)
// ============================================================

/**
 * Finds every settled Challan/Bilty where the given party account is
 * the SOLE responsible party for at least one component (never an
 * ambiguous one - see resolveAllocationTarget), by reading the same
 * SETTLEMENT/SETTLEMENT_CORRECTION ledger lines every other
 * resolution helper in this codebase already reads. This is the
 * single, shared "which documents belong to this party" lookup -
 * used both by auto-allocation (filtered to a remaining balance) and
 * by the Party Ledger 2.0 Documents/Outstanding views (unfiltered,
 * so fully-settled documents still appear for history).
 *
 * Ordering is deterministic: primary by the document's own date
 * field (Challan.loadingDate / Bilty.date), secondary by id (cuid,
 * effectively creation order) as a stable tiebreaker - never
 * database-default/random order.
 */
export async function getPartyDocumentStates(
  tx: Tx,
  partyAccountId: string,
  options: { onlyWithRemainingBalance?: boolean } = {}
): Promise<DocumentAllocationState[]> {
  const partyLines = await tx.journalLine.findMany({
    where: {
      accountId: partyAccountId,
      journalEntry: { referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] }, isDeleted: false },
    },
    select: { journalEntry: { select: { referenceId: true } }, sourceType: true, sourceId: true },
  });

  const candidateChallanIds = new Set<string>();
  const candidateBiltyIds = new Set<string>();

  for (const line of partyLines) {
    const challanId = line.journalEntry.referenceId;
    if (challanId) candidateChallanIds.add(challanId);
    if (line.sourceType === "BILTY" && line.sourceId) candidateBiltyIds.add(line.sourceId);
  }

  const results: DocumentAllocationState[] = [];

  for (const challanId of candidateChallanIds) {
    try {
      const state = await getRemainingAllocatableAmountForDocument(tx, "CHALLAN", challanId);
      if (
        state.responsiblePartyAccountId === partyAccountId &&
        (!options.onlyWithRemainingBalance || state.remainingAllocatable > 0.009)
      ) {
        results.push(state);
      }
    } catch {
      // Ambiguous / not settled / not found - simply not eligible.
    }
  }

  for (const biltyId of candidateBiltyIds) {
    try {
      const state = await getRemainingAllocatableAmountForDocument(tx, "BILTY", biltyId);
      if (
        state.responsiblePartyAccountId === partyAccountId &&
        (!options.onlyWithRemainingBalance || state.remainingAllocatable > 0.009)
      ) {
        results.push(state);
      }
    } catch {
      // Ambiguous / not settled / not found - simply not eligible.
    }
  }

  results.sort((a, b) => {
    const dateDiff = a.documentDate.getTime() - b.documentDate.getTime();
    if (dateDiff !== 0) return dateDiff;
    return a.targetSourceId.localeCompare(b.targetSourceId);
  });

  return results;
}

export interface AutoAllocateInput {
  journalLineId: string;
  createdById: string;
  idempotencyKey?: string;
}

export interface AutoAllocateResult {
  allocations: AllocationRowResult[];
  totalAllocated: number;
  remainingUnallocated: number;
  documentsAffected: { targetSourceType: AllocationTargetType; targetSourceId: string; amount: number }[];
  idempotentReplay?: boolean;
}

export async function autoAllocateOldestFirst(input: AutoAllocateInput): Promise<AutoAllocateResult> {
  const { journalLineId, createdById, idempotencyKey } = input;

  const payment = await getPaymentLine(prisma, journalLineId);
  if (payment.isDeleted) {
    throw new AllocationError("PAYMENT_DELETED", "This payment has been moved to Bin and cannot be allocated.");
  }
  if (!isEligibleForAllocation(payment)) {
    throw new AllocationError(
      "PAYMENT_ALREADY_DOCUMENT_LINKED",
      "This payment was already posted against a specific Challan/Bilty and is already fully attributed."
    );
  }

  let unallocated = await getUnallocatedAmountForPayment(prisma, journalLineId);
  if (unallocated <= 0.009) {
    return { allocations: [], totalAllocated: await getAllocatedAmountForPayment(prisma, journalLineId), remainingUnallocated: 0, documentsAffected: [] };
  }

  const documents = await getPartyDocumentStates(prisma, payment.partyAccountId, { onlyWithRemainingBalance: true });

  // getPartyDocumentStates() already returned each document's fresh
  // remainingAllocatable; the actual write below (createAllocations)
  // re-validates everything again inside its own SERIALIZABLE
  // transaction regardless, so this plan is just a proposal.
  const plan: AllocationRequestItem[] = [];
  for (const doc of documents) {
    if (unallocated <= 0.009) break;
    const take = Math.min(unallocated, doc.remainingAllocatable);
    if (take <= 0.009) continue;
    plan.push({ targetSourceType: doc.targetSourceType, targetSourceId: doc.targetSourceId, amount: round2(take) });
    unallocated = round2(unallocated - take);
  }

  if (plan.length === 0) {
    return { allocations: [], totalAllocated: await getAllocatedAmountForPayment(prisma, journalLineId), remainingUnallocated: await getUnallocatedAmountForPayment(prisma, journalLineId), documentsAffected: [] };
  }

  const result = await createAllocations({ journalLineId, allocations: plan, createdById, idempotencyKey });

  return {
    allocations: result.created,
    totalAllocated: result.totalAllocated,
    remainingUnallocated: result.remainingUnallocated,
    documentsAffected: result.created.map((c) => ({ targetSourceType: c.targetSourceType, targetSourceId: c.targetSourceId, amount: c.allocatedAmount })),
    idempotentReplay: result.idempotentReplay,
  };
}

// ============================================================
// EDIT / DELETE (Party Ledger 2.0, Step 2C)
//
// An allocation is a pure relationship row - editing/deleting it
// NEVER creates, mutates, or removes a JournalEntry/JournalLine, and
// never changes Cash/Bank, Party accounting balance, P&L, or Trial
// Balance. It only changes which EXISTING payment money is marked as
// applied to which EXISTING document, freeing/consuming
// "unallocated" amount on the payment side and "remainingAllocatable"
// on the document side.
// ============================================================

export interface UpdateAllocationInput {
  allocationId: string;
  newAmount: number;
  /** Ownership gate only - never trusted beyond this, exactly like assertPaymentBelongsToParty. */
  partyId: string;
}

export interface UpdateAllocationResult {
  allocation: AllocationRowResult;
  paymentTotalAllocated: number;
  paymentUnallocated: number;
  documentAllocatedTotal: number;
  documentRemainingAllocatable: number;
}

/**
 * Changes an existing allocation's amount in place (no row is
 * created or removed). Re-validates everything fresh, inside one
 * SERIALIZABLE transaction, EXCLUDING the row being edited from both
 * the payment-side and document-side totals - so the new amount is
 * checked against exactly the same limits a brand-new allocation
 * would be, just with this row's own current amount first "returned"
 * to the pool.
 */
export async function updateAllocationAmount(input: UpdateAllocationInput): Promise<UpdateAllocationResult> {
  const { allocationId, newAmount, partyId } = input;

  if (!(newAmount > 0)) {
    throw new AllocationError("INVALID_AMOUNT", "Allocation amount must be greater than zero.");
  }

  const run = () =>
    prisma.$transaction(
      async (tx) => {
        // (1) Load existing allocation.
        const existing = await tx.paymentAllocation.findUnique({ where: { id: allocationId } });
        if (!existing) {
          throw new AllocationError("ALLOCATION_NOT_FOUND", "Allocation not found.");
        }
        const targetSourceType = existing.targetSourceType as AllocationTargetType;

        // (2) Validate payment still exists/qualifies.
        const payment = await getPaymentLine(tx, existing.journalLineId);
        if (payment.isDeleted) {
          throw new AllocationError("PAYMENT_DELETED", "This payment has been moved to Bin and its allocations cannot be edited.");
        }

        // (3) Validate Party ownership.
        if (payment.partyId !== partyId) {
          throw new AllocationError("PARTY_MISMATCH", "This allocation does not belong to the specified Party.");
        }

        // (4) Validate target still belongs to the same Party.
        const target = await resolveAllocationTarget(tx, targetSourceType, existing.targetSourceId);
        if (target.responsiblePartyAccountId !== payment.partyAccountId) {
          throw new AllocationError(
            "PARTY_MISMATCH",
            `${targetSourceType} ${target.documentNo} is no longer the responsibility of this payment's Party.`
          );
        }

        // (5) Recalculate payment allocation total EXCLUDING this row.
        const otherPaymentRows = await tx.paymentAllocation.findMany({
          where: { journalLineId: existing.journalLineId, id: { not: allocationId } },
          select: { allocatedAmount: true },
        });
        const paymentAllocatedExcl = round2(otherPaymentRows.reduce((s, r) => s + Number(r.allocatedAmount), 0));
        const paymentRemainingExcl = round2(payment.amount - paymentAllocatedExcl);

        // (6) Recalculate target document allocation total EXCLUDING this row.
        const otherDocRows = await tx.paymentAllocation.findMany({
          where: { targetSourceType, targetSourceId: existing.targetSourceId, id: { not: allocationId } },
          select: { allocatedAmount: true },
        });
        const docAllocatedExcl = round2(otherDocRows.reduce((s, r) => s + Number(r.allocatedAmount), 0));
        const docRemainingExcl = Math.max(0, round2(target.totalDue - target.existingReceivedOrPaid - docAllocatedExcl));

        // (7) Validate new amount against both freshly-excluded limits.
        const requested = round2(newAmount);
        if (requested > paymentRemainingExcl + 0.009) {
          throw new AllocationError(
            "PAYMENT_LIMIT_EXCEEDED",
            `New amount (${requested}) exceeds this payment's available amount (${paymentRemainingExcl}).`
          );
        }
        if (requested > docRemainingExcl + 0.009) {
          throw new AllocationError(
            "DOCUMENT_LIMIT_EXCEEDED",
            `New amount (${requested}) exceeds ${targetSourceType} ${target.documentNo}'s remaining allocatable amount (${docRemainingExcl}).`
          );
        }

        // (8) Commit atomically.
        const updated = await tx.paymentAllocation.update({
          where: { id: allocationId },
          data: { allocatedAmount: requested },
        });

        return {
          allocation: {
            id: updated.id,
            targetSourceType: updated.targetSourceType as AllocationTargetType,
            targetSourceId: updated.targetSourceId,
            allocatedAmount: Number(updated.allocatedAmount),
          },
          paymentTotalAllocated: round2(paymentAllocatedExcl + requested),
          paymentUnallocated: Math.max(0, round2(payment.amount - (paymentAllocatedExcl + requested))),
          documentAllocatedTotal: round2(docAllocatedExcl + requested),
          documentRemainingAllocatable: Math.max(0, round2(target.totalDue - target.existingReceivedOrPaid - (docAllocatedExcl + requested))),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

  try {
    return await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new AllocationError("CONCURRENT_ALLOCATION", "Another allocation change happened at the same time. Please retry.");
    }
    throw error;
  }
}

export interface DeleteAllocationInput {
  allocationId: string;
  /** Ownership gate only - never trusted beyond this. */
  partyId: string;
}

export interface DeleteAllocationResult {
  deletedAllocation: AllocationRowResult;
  paymentTotalAllocated: number;
  paymentUnallocated: number;
}

/**
 * Removes one PaymentAllocation row entirely, releasing its amount
 * back to the payment's unallocated pool. Never touches accounting -
 * it is exactly as if that allocation had never been made.
 */
export async function deleteAllocation(input: DeleteAllocationInput): Promise<DeleteAllocationResult> {
  const { allocationId, partyId } = input;

  const run = () =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.paymentAllocation.findUnique({ where: { id: allocationId } });
        if (!existing) {
          throw new AllocationError("ALLOCATION_NOT_FOUND", "Allocation not found.");
        }

        const payment = await getPaymentLine(tx, existing.journalLineId);
        if (payment.partyId !== partyId) {
          throw new AllocationError("PARTY_MISMATCH", "This allocation does not belong to the specified Party.");
        }

        await tx.paymentAllocation.delete({ where: { id: allocationId } });

        const paymentTotalAllocated = await getAllocatedAmountForPayment(tx, existing.journalLineId);
        const paymentUnallocated = Math.max(0, round2(payment.amount - paymentTotalAllocated));

        return {
          deletedAllocation: {
            id: existing.id,
            targetSourceType: existing.targetSourceType as AllocationTargetType,
            targetSourceId: existing.targetSourceId,
            allocatedAmount: Number(existing.allocatedAmount),
          },
          paymentTotalAllocated,
          paymentUnallocated,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

  try {
    return await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new AllocationError("CONCURRENT_ALLOCATION", "Another allocation change happened at the same time. Please retry.");
    }
    throw error;
  }
}

// ============================================================
// PARTY OWNERSHIP GUARD (for API routes)
// ============================================================

/** Throws if the payment does not belong to the given Party. Never
 * trust a Party ID supplied by the frontend for anything else. */
export async function assertPaymentBelongsToParty(tx: Tx, journalLineId: string, partyId: string): Promise<PaymentLineInfo> {
  const payment = await getPaymentLine(tx, journalLineId);
  if (payment.partyId !== partyId) {
    throw new AllocationError("PARTY_MISMATCH", "This payment does not belong to the specified Party.");
  }
  return payment;
}
