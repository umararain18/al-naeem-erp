import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  findSettledPartyAccountId,
  type SettlementComponent,
} from "@/lib/settlement-correction";
import { getActiveSettlementPayers } from "@/lib/settlement-payments";
import { resolveBiltyPaidResponsibleParty } from "@/lib/document-party-resolution";
import { resolveBillClientAccountId } from "@/lib/bill-accounting";
import { getPrivatePhonchPartyBalances } from "@/lib/private-phonch-accounting";
import { OPENING_BALANCE_SENTINEL_DATE } from "@/lib/account-opening-balance";

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

export type AllocationTargetType =
  | "OPENING_BALANCE"
  | "BILTY"
  | "BILTY_PAID"
  | "BILL"
  | "PRIVATE_PHONCH_RECOVERY"
  | "CHALLAN"
  | "PRIVATE_PHONCH_PAYABLE";
export type AllocationDirection = "RECEIVABLE" | "PAYABLE";
export type AllocationStatus = "UNALLOCATED" | "PARTIALLY_ALLOCATED" | "FULLY_ALLOCATED";

// RECEIVABLE targets (party owes ANC) vs PAYABLE targets (ANC owes
// party) - see lib/party-payment-fifo.ts's own header comment for the
// direction-matching rule this drives ("a receipt only clears
// RECEIVABLE targets, a payment only clears PAYABLE ones").
const RECEIVABLE_TARGET_TYPES: AllocationTargetType[] = ["BILTY", "BILTY_PAID", "BILL", "PRIVATE_PHONCH_RECOVERY"];
const PAYABLE_TARGET_TYPES: AllocationTargetType[] = ["CHALLAN", "PRIVATE_PHONCH_PAYABLE"];

export function directionForTargetType(targetSourceType: AllocationTargetType): AllocationDirection | null {
  if (RECEIVABLE_TARGET_TYPES.includes(targetSourceType)) return "RECEIVABLE";
  if (PAYABLE_TARGET_TYPES.includes(targetSourceType)) return "PAYABLE";
  return null; // OPENING_BALANCE - direction depends on which way its own net balance runs, resolved per-party.
}

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
//  4. It pairs UNIQUELY with exactly one Cash/Bank line in the SAME
//     entry.
//
// (4) used to require the entry have EXACTLY TWO lines total - but
// app/api/daily-posting/route.ts's own DIRECT_GROUP grouping bundles
// EVERY non-CHALLAN/BILTY-tagged line from one submission into ONE
// shared JournalEntry (see that route's own comment: "every DIRECT/
// other line shares one remaining JournalEntry") - so a single
// Daily Posting submission recording, say, three different parties'
// lumpsum receipts in one go produces one 6-line entry (3 Cash/Bank
// legs + 3 Party legs), and EVERY one of those three real receipts
// was silently excluded as "AMBIGUOUS_PAYMENT" under the old
// EXACTLY-TWO rule - confirmed as the dominant cause of near-zero
// matches in production (most real postings ARE bundled this way).
//
// Fixed by pairing a line back to its own counterpart the same way
// app/api/cash-book/[id]/route.ts's own DELETE handler already
// re-identifies a bundled pair: match on the EXACT (sourceType,
// sourceId, sourceNumber, description) signature buildLinePair()
// gives both members of a pair, plus an exact opposite-amount debit/
// credit swap. A 2-line entry needs no such matching (the other line
// is simply whichever one isn't this one, exactly as before). For a
// bundled (>2-line) entry, if more than one Cash/Bank line matches
// that exact signature, the pairing is genuinely unidentifiable -
// never guessed, excluded instead, mirroring the cash-book route's
// own "refuse rather than guess wrong" precedent.
//
// A qualifying line's own sourceType MUST ALSO be something other
// than "CHALLAN"/"BILTY"/"BILL"/"PRIVATE_PHONCH"/"PHONCH" to be
// ELIGIBLE for NEW allocation (see isEligibleForAllocation below) -
// a line already tagged to a specific document at posting time is
// already fully attributed by that document's own EXISTING
// received/paid calculation (lib/challan-financials.ts for CHALLAN/
// BILTY, resolveBillTarget's own tagged-line sum for BILL,
// getPrivatePhonchPartyBalances for PRIVATE_PHONCH, lib/phonch-
// accounting.ts for the unrelated Showroom PHONCH); allocating it
// again would double-count that same money against
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

interface PairableEntryLine {
  id: string;
  debit: Prisma.Decimal | number;
  credit: Prisma.Decimal | number;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
  description: string | null;
  account: { category: string };
}

/**
 * Finds the ONE Cash/Bank line in `entryLines` that pairs with `line`
 * - trivial when the entry has exactly two lines (the other one, by
 * elimination); for a bundled (>2-line) entry, matches on the exact
 * (sourceType, sourceId, sourceNumber, description) signature
 * buildLinePair() gives both members of a pair, plus an exact
 * opposite-amount debit/credit swap. Returns null when zero or more
 * than one line matches - never guesses. See this module's own
 * "PAYMENT IDENTIFICATION" header comment for the full reasoning.
 */
export function findPairedCashBankLine<T extends PairableEntryLine>(line: T, entryLines: T[]): T | null {
  if (entryLines.length === 2) {
    const other = entryLines.find((l) => l.id !== line.id);
    if (!other || (other.account.category !== "CASH" && other.account.category !== "BANK")) return null;
    return other;
  }

  const debit = Number(line.debit);
  const credit = Number(line.credit);

  const matches = entryLines.filter((l) => {
    if (l.id === line.id) return false;
    if (l.account.category !== "CASH" && l.account.category !== "BANK") return false;
    if (l.sourceType !== line.sourceType) return false;
    if ((l.sourceId || null) !== (line.sourceId || null)) return false;
    if ((l.sourceNumber || null) !== (line.sourceNumber || null)) return false;
    if ((l.description || null) !== (line.description || null)) return false;
    return Number(l.debit) === credit && Number(l.credit) === debit;
  });

  return matches.length === 1 ? matches[0] : null;
}

export async function getPaymentLine(tx: Tx, journalLineId: string): Promise<PaymentLineInfo> {
  const line = await tx.journalLine.findUnique({
    where: { id: journalLineId },
    select: {
      id: true,
      debit: true,
      credit: true,
      sourceType: true,
      sourceId: true,
      sourceNumber: true,
      description: true,
      account: { select: { id: true, category: true, partyId: true } },
      journalEntry: {
        select: {
          referenceType: true,
          isDeleted: true,
          entryDate: true,
          lines: {
            select: {
              id: true,
              debit: true,
              credit: true,
              sourceType: true,
              sourceId: true,
              sourceNumber: true,
              description: true,
              account: { select: { category: true } },
            },
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

  const other = findPairedCashBankLine(line, line.journalEntry.lines);
  if (!other) {
    throw new AllocationError(
      "AMBIGUOUS_PAYMENT",
      "This Daily Posting entry does not represent a single, unambiguous Cash/Bank <-> Party movement and cannot be allocated."
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

/** Every Daily Posting sourceType whose own document reads its
 * tagged Daily Posting lines to compute an "already received/paid"
 * figure of its own - allocating one of these lines a SECOND time,
 * generically, would double-count that same money. CHALLAN/BILTY are
 * the original two (see lib/challan-financials.ts); BILL
 * (resolveBillTarget), PRIVATE_PHONCH (getPrivatePhonchPartyBalances),
 * and PHONCH (lib/phonch-accounting.ts - not itself a FIFO target
 * type, but still a document with its own received-amount tracking)
 * were added once this feature extended FIFO past Bilty/Challan. */
const ALREADY_DOCUMENT_LINKED_SOURCE_TYPES = ["CHALLAN", "BILTY", "BILL", "PRIVATE_PHONCH", "PHONCH"];

/**
 * A qualifying payment (getPaymentLine) is ELIGIBLE for NEW
 * allocation only if it was NOT already tagged to a specific
 * document at posting time - such a line is already fully counted in
 * that document's own received/paid figure, and allocating it again
 * would double-count the same money against two mechanisms.
 */
export function isEligibleForAllocation(payment: PaymentLineInfo): boolean {
  return !payment.sourceType || !ALREADY_DOCUMENT_LINKED_SOURCE_TYPES.includes(payment.sourceType);
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
  /** RECEIVABLE (party owes ANC) or PAYABLE (ANC owes party) - see directionForTargetType(). */
  direction: AllocationDirection;
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
    direction: "PAYABLE",
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
    direction: "RECEIVABLE",
  };
}

/**
 * Resolves a BILTY_PAID allocation target - the Bilty's own Paid
 * (advance) component, independent of Settlement/Challan dispatch
 * entirely (see resolveBiltyPaidResponsibleParty's own module-level
 * reasoning in lib/document-party-resolution.ts) - a genuinely
 * separate pool of money from BILTY's own Collection+Commission
 * above, never summed into the same ceiling (see this module's own
 * "Settlement interplay" guard, enforced by keeping these two target
 * types structurally disjoint, exactly like CHALLAN vs BILTY already
 * are for the same reason).
 */
async function resolveBiltyPaidTarget(tx: Tx, biltyId: string): Promise<ResolvedTarget> {
  // Same multi-payer guard as resolveChallanTarget/resolveBiltyTarget -
  // the "PAID" component of lib/settlement-payments.ts's own
  // MultiPayerComponent union is this exact same money.
  const paidPayers = await getActiveSettlementPayers(tx, "PAID", { biltyId });
  if (paidPayers.length > 0) {
    throw new AllocationError(
      "MULTI_PAYER_NOT_ALLOCATABLE",
      "This Bilty's Paid amount has multiple settlement payment rows recorded against it and cannot currently be targeted by Payment Allocation."
    );
  }

  const bilty = await tx.bilty.findUnique({
    where: { id: biltyId },
    select: { id: true, biltyNo: true, date: true, isDeleted: true, advance: true },
  });
  if (!bilty || bilty.isDeleted) {
    throw new AllocationError("DOCUMENT_NOT_FOUND", "Target Bilty not found.");
  }

  const advance = Number(bilty.advance);
  if (advance <= 0) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "This Bilty has no Paid amount due.");
  }

  const responsible = await resolveBiltyPaidResponsibleParty(biltyId, tx);
  if (!responsible) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "No responsible party is established for this Bilty's Paid amount yet.");
  }

  const taggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: bilty.id,
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      account: { category: "PARTY", id: responsible.accountId },
    },
    select: { debit: true, credit: true },
  });
  const receivedOrPaid = taggedLines.reduce((s, l) => s + Number(l.debit) + Number(l.credit), 0);

  return {
    targetSourceType: "BILTY_PAID",
    targetSourceId: bilty.id,
    documentNo: bilty.biltyNo,
    documentDate: bilty.date,
    responsiblePartyAccountId: responsible.accountId,
    totalDue: advance,
    existingReceivedOrPaid: receivedOrPaid,
    direction: "RECEIVABLE",
  };
}

/**
 * Resolves a BILL allocation target. A Bill always resolves to
 * exactly one party (the real Client, or the shared walk-in system
 * account - excluded below, since "the walk-in party" isn't a real
 * Party with other payments of its own to allocate against).
 */
async function resolveBillTarget(tx: Tx, billId: string): Promise<ResolvedTarget> {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: {
      id: true,
      billNo: true,
      date: true,
      isDeleted: true,
      clientPartyId: true,
      clientParty: { select: { account: { select: { id: true } } } },
      items: { select: { rent: true, delivery: true, otherExpense: true } },
    },
  });
  if (!bill || bill.isDeleted) {
    throw new AllocationError("DOCUMENT_NOT_FOUND", "Target Bill not found.");
  }
  if (!bill.clientPartyId) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "This Bill has no real Client Party (walk-in) and cannot be targeted by Payment Allocation.");
  }

  const partyAccountId = await resolveBillClientAccountId(tx, bill.clientParty);
  if (!partyAccountId) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "This Bill's Client has no active account.");
  }

  const total = round2(bill.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0));
  if (total <= 0) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "This Bill has no amount due (record only).");
  }

  const taggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILL",
      sourceId: bill.id,
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      account: { category: "PARTY", id: partyAccountId },
    },
    select: { debit: true, credit: true },
  });
  const receivedOrPaid = taggedLines.reduce((s, l) => s + Number(l.debit) + Number(l.credit), 0);

  return {
    targetSourceType: "BILL",
    targetSourceId: bill.id,
    documentNo: bill.billNo,
    documentDate: bill.date,
    responsiblePartyAccountId: partyAccountId,
    totalDue: total,
    existingReceivedOrPaid: receivedOrPaid,
    direction: "RECEIVABLE",
  };
}

/**
 * Resolves a PRIVATE_PHONCH_PAYABLE/PRIVATE_PHONCH_RECOVERY target.
 * targetSourceId is a composite "<phonchId>:<accountId>" string - a
 * Private Phonch is NEVER a single-party document (see
 * lib/private-phonch-accounting.ts's own module header: up to several
 * distinct payable/receivable parties at once), so (unlike every
 * other target type) one Phonch alone cannot identify a row; the
 * payer/payee account must be part of the id itself.
 */
async function resolvePrivatePhonchTarget(
  tx: Tx,
  targetSourceId: string,
  direction: "PAYABLE" | "RECEIVABLE"
): Promise<ResolvedTarget> {
  const [phonchId, accountId] = targetSourceId.split(":");
  if (!phonchId || !accountId) {
    throw new AllocationError("INVALID_TARGET_TYPE", "Malformed Private Phonch target id - expected \"<phonchId>:<accountId>\".");
  }

  const phonch = await tx.privatePhonch.findUnique({
    where: { id: phonchId },
    select: { id: true, phonchNo: true, date: true, isDeleted: true },
  });
  if (!phonch || phonch.isDeleted) {
    throw new AllocationError("DOCUMENT_NOT_FOUND", "Target Private Phonch not found.");
  }

  const balances = await getPrivatePhonchPartyBalances(tx, phonchId);
  const match = balances.find((b) => b.accountId === accountId && b.direction === direction);
  if (!match || match.totalDue <= 0) {
    throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "This Private Phonch has no such outstanding amount for this account.");
  }

  return {
    targetSourceType: direction === "PAYABLE" ? "PRIVATE_PHONCH_PAYABLE" : "PRIVATE_PHONCH_RECOVERY",
    targetSourceId,
    documentNo: phonch.phonchNo,
    documentDate: phonch.date,
    responsiblePartyAccountId: accountId,
    totalDue: match.totalDue,
    existingReceivedOrPaid: match.settledAmount,
    direction: direction === "PAYABLE" ? "PAYABLE" : "RECEIVABLE",
  };
}

const OPENING_BALANCE_EQUITY_CACHE = { id: null as string | null };

async function getOpeningBalanceEquityAccountId(tx: Tx): Promise<string | null> {
  if (OPENING_BALANCE_EQUITY_CACHE.id) return OPENING_BALANCE_EQUITY_CACHE.id;
  const account = await tx.account.findFirst({ where: { accountCode: "OPENING-BALANCE" }, select: { id: true } });
  if (!account) return null;
  OPENING_BALANCE_EQUITY_CACHE.id = account.id;
  return account.id;
}

/**
 * Resolves the OPENING_BALANCE virtual target - a party's own pre-ERP
 * opening position, which FIFO must always clear before every real
 * document (it is, by definition, older than anything else). Summed
 * from TWO sources (never just one, so a historical manual entry is
 * never silently missed):
 *  1. The official OPENING_BALANCE-tagged JournalEntry
 *     (referenceId = partyId) app/api/parties/route.ts's own Party
 *     creation flow posts, dated the party's own real creation date.
 *  2. Any OTHER live JournalLine on this party's own account whose
 *     sibling line in the same JournalEntry targets the shared
 *     "Opening Balance Equity" system account (accountCode
 *     "OPENING-BALANCE") - an untagged manual Journal Entry someone
 *     used historically to record an opening position outside the
 *     official flow.
 * targetSourceId for this target type is the party's own id (never an
 * account id), matching the OPENING_BALANCE entry's own referenceId
 * convention.
 */
export interface OpeningBalanceQualifyingLine {
  debit: number;
  credit: number;
  entryDate: Date;
  /** Either the official OPENING_BALANCE-tagged entry, OR an entry
   * with a sibling line on the Opening Balance Equity account - the
   * caller filters to only lines meeting one of these two conditions
   * (addition B's dual-source rule) before calling this function. */
}

/**
 * Pure derivation step of resolveOpeningBalanceTarget (DB I/O lives
 * only in the caller) - sums net debit-credit across every ALREADY-
 * FILTERED qualifying line (see OpeningBalanceQualifyingLine's own
 * doc comment: the caller decides which lines qualify, by EITHER the
 * official OPENING_BALANCE tag OR an Opening-Balance-Equity contra -
 * addition B's dual-source rule) and the earliest contributing date.
 * A net of ~0 (every source cancels out) or no qualifying lines at
 * all both correctly mean "no opening balance" - returns null.
 */
export function deriveOpeningBalanceFromLines(
  lines: OpeningBalanceQualifyingLine[]
): { totalDue: number; direction: AllocationDirection; earliestDate: Date } | null {
  let net = 0;
  let earliestDate: Date | null = null;
  for (const line of lines) {
    net += line.debit - line.credit;
    if (!earliestDate || line.entryDate < earliestDate) earliestDate = line.entryDate;
  }

  if (!earliestDate || Math.abs(round2(net)) <= 0.009) return null;

  return {
    totalDue: round2(Math.abs(net)),
    direction: net > 0 ? "RECEIVABLE" : "PAYABLE",
    earliestDate,
  };
}

/**
 * Caps a derived opening balance to the account's CURRENT total net
 * balance (every live JournalLine on the account, not just the
 * qualifying opening-balance-sourced ones) - the historical opening
 * figure is, by construction, frozen at whatever it was tagged at
 * creation/edit time, but the party's REAL outstanding balance since
 * then may have already been reduced (even to zero) by activity this
 * FIFO engine never tracks as a "payment" at all: a multi-line
 * bundled Daily Posting, a direct fuel/trip expense JournalEntry, a
 * Settlement/Settlement Correction line, etc. Treating the stale,
 * uncapped opening figure as still fully outstanding would leave it
 * permanently "open" even though the account has genuinely settled
 * down to (or past) zero - exactly the bug reported against
 * production (Ansari And Sons / NKB / Jaecco / Sitara Hilal Pump
 * Hyderabad / Kisan Tractors / Umar Khan Dera Ismail Khan: real
 * receipts/other postings already reduced these accounts, but
 * Opening Balance never reflected it).
 *
 * `currentNetBalance` must be `debit - credit` summed across EVERY
 * live line on the account (the same convention deriveOpeningBalance
 * FromLines itself uses) - not just the qualifying subset.
 *
 * - Same direction as the opening, and its magnitude is SMALLER than
 *   the opening amount -> the opening has been partially offset;
 *   remaining = that smaller current magnitude.
 * - Same direction, magnitude >= the opening amount -> the party has
 *   only grown MORE indebted since opening via channels outside this
 *   opening figure (e.g. real Bilty/Bill dues, already their own
 *   separate FIFO targets) - the opening itself stays capped at its
 *   own original amount, never inflated by unrelated activity.
 * - Opposite direction (or exactly zero) -> the opening has been
 *   fully offset and then some - nothing left open at all (null).
 */
export function capOpeningBalanceByCurrentBalance(
  derived: { totalDue: number; direction: AllocationDirection; earliestDate: Date },
  currentNetBalance: number
): { totalDue: number; direction: AllocationDirection; earliestDate: Date } | null {
  const sameDirectionMagnitude = derived.direction === "RECEIVABLE" ? Math.max(0, currentNetBalance) : Math.max(0, -currentNetBalance);
  const cappedTotalDue = round2(Math.min(derived.totalDue, sameDirectionMagnitude));
  if (cappedTotalDue <= 0.009) return null;
  return { ...derived, totalDue: cappedTotalDue };
}

async function resolveOpeningBalanceTarget(tx: Tx, partyId: string): Promise<ResolvedTarget | null> {
  const party = await tx.party.findUnique({ where: { id: partyId }, select: { id: true, partyName: true, account: { select: { id: true } } } });
  if (!party?.account) return null;

  const openingEquityAccountId = await getOpeningBalanceEquityAccountId(tx);

  const partyLines = await tx.journalLine.findMany({
    where: { accountId: party.account.id, journalEntry: { isDeleted: false } },
    select: {
      debit: true,
      credit: true,
      journalEntry: {
        select: { entryDate: true, referenceType: true, lines: { select: { accountId: true } } },
      },
    },
  });

  const qualifyingLines: OpeningBalanceQualifyingLine[] = [];
  let currentNetBalance = 0;
  for (const line of partyLines) {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    currentNetBalance += debit - credit;

    const isOfficiallyTagged = line.journalEntry.referenceType === "OPENING_BALANCE";
    const hasOpeningEquityContra = openingEquityAccountId != null && line.journalEntry.lines.some((l) => l.accountId === openingEquityAccountId);
    if (!isOfficiallyTagged && !hasOpeningEquityContra) continue;
    qualifyingLines.push({ debit, credit, entryDate: line.journalEntry.entryDate });
  }

  const derived = deriveOpeningBalanceFromLines(qualifyingLines);
  if (!derived) return null;

  // Cap to the account's CURRENT total net balance - see
  // capOpeningBalanceByCurrentBalance's own doc comment.
  const capped = capOpeningBalanceByCurrentBalance(derived, currentNetBalance);
  if (!capped) return null;

  return {
    targetSourceType: "OPENING_BALANCE",
    targetSourceId: partyId,
    documentNo: "Opening Balance",
    // ALWAYS the sentinel, never the real earliest contributing
    // line's date - a Party's own OPENING_BALANCE entry is dated its
    // real creation date (app/api/parties/route.ts), which can easily
    // fall AFTER a real document already on file (e.g. a backfilled
    // party created today with Bilties dated weeks ago) - FIFO must
    // still clear the opening balance FIRST, regardless of its own
    // recorded date, since it represents money owed from before
    // every other transaction by definition. sortFifoDocuments sorts
    // purely on this field, so the sentinel (2000-01-01, earlier than
    // any real document) is what guarantees that. The TRUE earliest
    // date is still shown separately for reporting - see
    // getOpeningBalanceBreakdown's own earliestDate field.
    documentDate: OPENING_BALANCE_SENTINEL_DATE,
    responsiblePartyAccountId: party.account.id,
    totalDue: capped.totalDue,
    existingReceivedOrPaid: 0,
    direction: capped.direction,
  };
}

export interface OpeningBalanceBreakdown {
  taggedAmount: number;
  untaggedAmount: number;
  /** The raw, uncapped opening figure (tagged + untagged combined). */
  rawTotalDue: number;
  /** debit - credit across EVERY live line on the account - see capOpeningBalanceByCurrentBalance. */
  currentNetBalance: number;
  /** The capped figure actually used as the OPENING_BALANCE target's totalDue (0 if fully offset). */
  totalDue: number;
  direction: AllocationDirection | null;
  earliestDate: Date | null;
}

/**
 * Reporting-only variant of resolveOpeningBalanceTarget - same dual-
 * source qualifying-line gathering, but keeps the OPENING_BALANCE-
 * tagged contribution and the untagged-OBE-contra contribution
 * separate (never merged until the final net) so
 * scripts/backfill-fifo-allocation.ts's own dry-run report can show
 * each party's opening amount broken down by source, per the plan.
 */
export async function getOpeningBalanceBreakdown(tx: Tx, partyId: string): Promise<OpeningBalanceBreakdown | null> {
  const party = await tx.party.findUnique({ where: { id: partyId }, select: { account: { select: { id: true } } } });
  if (!party?.account) return null;

  const openingEquityAccountId = await getOpeningBalanceEquityAccountId(tx);

  const partyLines = await tx.journalLine.findMany({
    where: { accountId: party.account.id, journalEntry: { isDeleted: false } },
    select: {
      debit: true,
      credit: true,
      journalEntry: { select: { entryDate: true, referenceType: true, lines: { select: { accountId: true } } } },
    },
  });

  const taggedLines: OpeningBalanceQualifyingLine[] = [];
  const untaggedLines: OpeningBalanceQualifyingLine[] = [];
  let currentNetBalance = 0;
  for (const line of partyLines) {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    currentNetBalance += debit - credit;

    const isOfficiallyTagged = line.journalEntry.referenceType === "OPENING_BALANCE";
    const hasOpeningEquityContra = openingEquityAccountId != null && line.journalEntry.lines.some((l) => l.accountId === openingEquityAccountId);
    const entry: OpeningBalanceQualifyingLine = { debit, credit, entryDate: line.journalEntry.entryDate };
    if (isOfficiallyTagged) taggedLines.push(entry);
    else if (hasOpeningEquityContra) untaggedLines.push(entry);
  }

  if (taggedLines.length === 0 && untaggedLines.length === 0) return null;

  const taggedNet = taggedLines.reduce((s, l) => s + l.debit - l.credit, 0);
  const untaggedNet = untaggedLines.reduce((s, l) => s + l.debit - l.credit, 0);
  const derived = deriveOpeningBalanceFromLines([...taggedLines, ...untaggedLines]);
  const capped = derived ? capOpeningBalanceByCurrentBalance(derived, currentNetBalance) : null;

  return {
    taggedAmount: round2(Math.abs(taggedNet)),
    untaggedAmount: round2(Math.abs(untaggedNet)),
    rawTotalDue: derived?.totalDue ?? 0,
    currentNetBalance: round2(currentNetBalance),
    totalDue: capped?.totalDue ?? 0,
    direction: capped?.direction ?? derived?.direction ?? null,
    earliestDate: capped?.earliestDate ?? derived?.earliestDate ?? null,
  };
}

export async function resolveAllocationTarget(
  tx: Tx,
  targetSourceType: AllocationTargetType,
  targetSourceId: string
): Promise<ResolvedTarget> {
  if (targetSourceType === "CHALLAN") return resolveChallanTarget(tx, targetSourceId);
  if (targetSourceType === "BILTY") return resolveBiltyTarget(tx, targetSourceId);
  if (targetSourceType === "BILTY_PAID") return resolveBiltyPaidTarget(tx, targetSourceId);
  if (targetSourceType === "BILL") return resolveBillTarget(tx, targetSourceId);
  if (targetSourceType === "PRIVATE_PHONCH_PAYABLE") return resolvePrivatePhonchTarget(tx, targetSourceId, "PAYABLE");
  if (targetSourceType === "PRIVATE_PHONCH_RECOVERY") return resolvePrivatePhonchTarget(tx, targetSourceId, "RECEIVABLE");
  if (targetSourceType === "OPENING_BALANCE") {
    const target = await resolveOpeningBalanceTarget(tx, targetSourceId);
    if (!target) throw new AllocationError("DOCUMENT_NOT_ALLOCATABLE", "This Party has no opening balance to allocate against.");
    return target;
  }
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

export type AllocationOrigin = "FIFO" | "SETTLEMENT" | "MANUAL" | "LEGACY";

export interface CreateAllocationsInput {
  journalLineId: string;
  allocations: AllocationRequestItem[];
  createdById: string;
  /** Optional - reuses the same idempotency-key-as-id trick used by
   * Daily Posting (see app/api/daily-posting/route.ts) so an exact
   * resubmission of the same request cannot create duplicate rows,
   * without any new schema/column. */
  idempotencyKey?: string;
  /** Which mechanism is writing these rows - see schema.prisma's own
   * doc comment on PaymentAllocation.origin. Defaults to "MANUAL":
   * this function is the manual-picker's own write path (the FIFO
   * rebuild engine in lib/party-payment-fifo.ts writes directly,
   * reusing its own already-open transaction instead). */
  origin?: AllocationOrigin;
  /** When true (the default for a MANUAL write), stamps this
   * payment's own JournalLine.allocationMode = "MANUAL" in the same
   * transaction, exempting it from every future auto-FIFO rebuild
   * until the user picks "Back to Auto". */
  markPaymentManual?: boolean;
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
  const { journalLineId, allocations, createdById, idempotencyKey, origin = "MANUAL", markPaymentManual = origin === "MANUAL" } = input;

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
              origin,
            },
          });
          created.push({
            id: row.id,
            targetSourceType: row.targetSourceType as AllocationTargetType,
            targetSourceId: row.targetSourceId,
            allocatedAmount: Number(row.allocatedAmount),
          });
        }

        if (markPaymentManual) {
          await tx.journalLine.update({ where: { id: journalLineId }, data: { allocationMode: "MANUAL" } });
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
export interface AllocationCandidateRef {
  targetSourceType: AllocationTargetType;
  targetSourceId: string;
}

/**
 * Gathers every RAW candidate (targetSourceType, targetSourceId)
 * worth attempting resolveAllocationTarget against for this party +
 * direction - deliberately a SUPERSET (each candidate is still fully
 * re-validated, including its real responsible party, by
 * getRemainingAllocatableAmountForDocument). Extracted out of
 * getPartyDocumentStates so scripts/backfill-fifo-allocation.ts's own
 * --verbose diagnostic can report WHY a specific candidate was
 * excluded (party mismatch, direction mismatch, multi-payer guard,
 * not settled, etc.) instead of only ever seeing the final, already-
 * filtered list.
 */
export async function getPartyDocumentCandidateRefs(
  tx: Tx,
  partyAccountId: string,
  direction: AllocationDirection
): Promise<AllocationCandidateRef[]> {
  const account = await tx.account.findUnique({ where: { id: partyAccountId }, select: { partyId: true } });
  const partyId = account?.partyId ?? null;

  const refs: AllocationCandidateRef[] = [];

  const settlementLines = await tx.journalLine.findMany({
    where: {
      accountId: partyAccountId,
      journalEntry: { referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] }, isDeleted: false },
    },
    select: { journalEntry: { select: { referenceId: true } }, sourceType: true, sourceId: true },
  });

  const candidateChallanIds = new Set<string>();
  const candidateBiltyIds = new Set<string>();
  for (const line of settlementLines) {
    const challanId = line.journalEntry.referenceId;
    if (challanId) candidateChallanIds.add(challanId);
    if (line.sourceType === "BILTY" && line.sourceId) candidateBiltyIds.add(line.sourceId);
  }

  // BILTY_PAID candidates - any Bilty where this party is explicitly
  // or implicitly the Paid-responsible party (resolveBiltyPaidTarget
  // re-validates the exact responsibility chain; this query is
  // deliberately a superset).
  if (partyId && direction === "RECEIVABLE") {
    const paidBilties = await tx.bilty.findMany({
      where: {
        isDeleted: false,
        advance: { gt: 0 },
        OR: [{ paidResponsiblePartyId: partyId }, { consignorPartyId: partyId }, { consigneePartyId: partyId }],
      },
      select: { id: true },
    });
    for (const b of paidBilties) candidateBiltyIds.add(b.id);
  }

  refs.push({ targetSourceType: "OPENING_BALANCE", targetSourceId: partyId ?? "" });

  if (direction === "PAYABLE") {
    for (const challanId of candidateChallanIds) refs.push({ targetSourceType: "CHALLAN", targetSourceId: challanId });
  }

  if (direction === "RECEIVABLE") {
    for (const biltyId of candidateBiltyIds) {
      refs.push({ targetSourceType: "BILTY", targetSourceId: biltyId });
      refs.push({ targetSourceType: "BILTY_PAID", targetSourceId: biltyId });
    }

    if (partyId) {
      const bills = await tx.bill.findMany({ where: { isDeleted: false, clientPartyId: partyId }, select: { id: true } });
      for (const b of bills) refs.push({ targetSourceType: "BILL", targetSourceId: b.id });
    }
  }

  if (partyId) {
    const candidatePhonchIds = new Set<string>();

    const phonches = await tx.privatePhonch.findMany({
      where: {
        isDeleted: false,
        OR: [{ transporterPartyId: partyId }, { vehicles: { some: { clearingAgentPartyId: partyId } } }],
      },
      select: { id: true },
    });
    for (const p of phonches) candidatePhonchIds.add(p.id);

    // Ledger-truth safety net, mirroring the CHALLAN/BILTY candidate
    // gathering above: the LIVE PrivatePhonch/PrivatePhonchVehicle
    // table's own transporterPartyId/clearingAgentPartyId reflect
    // only the CURRENT assignment - if a Phonch was edited and this
    // party's role was later reassigned away, a real, still-live
    // PRIVATE_PHONCH-tagged Daily Posting line already sitting on
    // this account would otherwise never surface as a candidate at
    // all (confirmed missing on production for a party whose
    // ledger plainly carried such lines). Any live JournalLine on
    // this account tagged sourceType="PRIVATE_PHONCH" names its own
    // Phonch directly via sourceId - added here regardless of what
    // the live table currently says; resolvePrivatePhonchTarget
    // re-validates the real, current balance either way.
    const privatePhonchLedgerLines = await tx.journalLine.findMany({
      where: { accountId: partyAccountId, sourceType: "PRIVATE_PHONCH", sourceId: { not: null } },
      select: { sourceId: true },
    });
    for (const line of privatePhonchLedgerLines) {
      if (line.sourceId) candidatePhonchIds.add(line.sourceId);
    }

    const phonchTargetType = direction === "PAYABLE" ? "PRIVATE_PHONCH_PAYABLE" : "PRIVATE_PHONCH_RECOVERY";
    for (const phonchId of candidatePhonchIds) refs.push({ targetSourceType: phonchTargetType, targetSourceId: `${phonchId}:${partyAccountId}` });
  }

  return refs;
}

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
 * field (Challan.loadingDate / Bilty.date), secondary by documentNo
 * as a stable tiebreaker - never database-default/random order.
 */
export async function getPartyDocumentStates(
  tx: Tx,
  partyAccountId: string,
  direction: AllocationDirection,
  options: { onlyWithRemainingBalance?: boolean } = {}
): Promise<DocumentAllocationState[]> {
  const candidates = await getPartyDocumentCandidateRefs(tx, partyAccountId, direction);
  const results: DocumentAllocationState[] = [];

  for (const candidate of candidates) {
    try {
      const state = await getRemainingAllocatableAmountForDocument(tx, candidate.targetSourceType, candidate.targetSourceId);
      if (
        state.responsiblePartyAccountId === partyAccountId &&
        state.direction === direction &&
        (!options.onlyWithRemainingBalance || state.remainingAllocatable > 0.009)
      ) {
        results.push(state);
      }
    } catch {
      // Ambiguous / not settled / multi-payer / wrong party / not found - simply not eligible.
    }
  }

  results.sort((a, b) => {
    const dateDiff = a.documentDate.getTime() - b.documentDate.getTime();
    if (dateDiff !== 0) return dateDiff;
    return a.documentNo.localeCompare(b.documentNo);
  });

  return results;
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
