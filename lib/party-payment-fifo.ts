import type { Prisma, PrismaClient } from "@prisma/client";
import {
  AllocationError,
  type AllocationDirection,
  type AllocationTargetType,
  getAllocatedAmountForPayment,
  getPaymentLine,
  getPartyDocumentStates,
  isEligibleForAllocation,
  resolveAllocationTarget,
} from "@/lib/payment-allocation";

type Tx = PrismaClient | Prisma.TransactionClient;

// ============================================================
// PARTY PAYMENT FIFO - Auto FIFO allocation of lumpsum party
// payments/receipts.
//
// Thin orchestration on top of lib/payment-allocation.ts - never
// duplicates its validation/transaction logic. A "receipt" (party
// pays ANC - the party's own JournalLine is CREDIT) only ever clears
// RECEIVABLE targets; a "payment" (ANC pays the party - the party's
// own JournalLine is DEBIT) only ever clears PAYABLE targets - see
// directionForPaymentLine() below.
//
// rerunFifoForParty is a REBUILD, not additive: every call deletes
// every origin="FIFO" PaymentAllocation row for this party's own
// payments in this ONE direction, then rebuilds from a clean slate,
// oldest payment -> oldest document. Deterministic and idempotent:
// running it twice with no intervening data change produces the
// identical row set. MANUAL/LEGACY/SETTLEMENT-origin rows are never
// touched, by this or any other code path - their amount still
// counts against a document's capacity via the shared,
// origin-blind getAllocatedAmountForDocument/getAllocatedAmountForPayment
// sums.
// ============================================================

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function directionForPaymentLine(direction: "DEBIT" | "CREDIT"): AllocationDirection {
  return direction === "CREDIT" ? "RECEIVABLE" : "PAYABLE";
}

// ============================================================
// PURE CORE - no DB, no I/O. Extracted so the actual FIFO ordering/
// tie-break/greedy-allocation algorithm can be unit tested directly
// (see lib/party-payment-fifo.test.ts) rather than only through a
// live database. rerunFifoForParty (below) is a thin DB-wiring layer
// around these three functions - it never re-implements this logic
// itself.
// ============================================================

export interface FifoCandidatePayment {
  journalLineId: string;
  /** This payment's own remaining (unallocated-so-far) amount - NOT
   * its full face value; a payment partly covered by a MANUAL/LEGACY/
   * SETTLEMENT row already has that amount excluded by the caller
   * before this function ever sees it. */
  remainingAmount: number;
  entryDate: Date;
}

export interface FifoCandidateDocument {
  targetSourceType: string;
  targetSourceId: string;
  documentNo: string;
  documentDate: Date;
  /** Already net of every existing allocation (any origin) and of
   * existingReceivedOrPaid - the true remaining capacity this
   * document can still accept. */
  remainingAllocatable: number;
}

export interface FifoAllocationPlanItem {
  journalLineId: string;
  targetSourceType: string;
  targetSourceId: string;
  amount: number;
}

/** Oldest payment first: entryDate asc, then journalLineId asc (stable tiebreak). */
export function sortFifoPayments<T extends { entryDate: Date; journalLineId: string }>(payments: T[]): T[] {
  return [...payments].sort((a, b) => {
    const dateDiff = a.entryDate.getTime() - b.entryDate.getTime();
    if (dateDiff !== 0) return dateDiff;
    return a.journalLineId.localeCompare(b.journalLineId);
  });
}

/** Oldest document first: documentDate asc, then documentNo asc (stable tiebreak). */
export function sortFifoDocuments<T extends { documentDate: Date; documentNo: string }>(documents: T[]): T[] {
  return [...documents].sort((a, b) => {
    const dateDiff = a.documentDate.getTime() - b.documentDate.getTime();
    if (dateDiff !== 0) return dateDiff;
    return a.documentNo.localeCompare(b.documentNo);
  });
}

/**
 * The greedy FIFO walk itself: oldest payment -> oldest document,
 * allocating min(payment's own remaining, document's own remaining)
 * each step, moving to the next document once a document is
 * exhausted and to the next payment once a payment is exhausted.
 * Pure and deterministic - the SAME inputs always produce the SAME
 * plan (idempotency), and a document/payment never receives more
 * than its own remaining capacity allowed (no over-allocation) since
 * every `take` is capped by both sides' own remaining amount.
 *
 * Does not sort its own inputs - callers pass already-FIFO-ordered
 * arrays (sortFifoPayments/sortFifoDocuments) so the exact ordering
 * rule lives in exactly one place.
 */
export function computeFifoAllocationPlan(
  payments: FifoCandidatePayment[],
  documents: FifoCandidateDocument[]
): FifoAllocationPlanItem[] {
  const plan: FifoAllocationPlanItem[] = [];
  const remainingByDoc = new Map<string, number>();
  for (const doc of documents) {
    remainingByDoc.set(`${doc.targetSourceType}:${doc.targetSourceId}`, doc.remainingAllocatable);
  }

  for (const payment of payments) {
    let remainingPayment = round2(payment.remainingAmount);
    if (remainingPayment <= 0.009) continue;

    for (const doc of documents) {
      if (remainingPayment <= 0.009) break;
      const key = `${doc.targetSourceType}:${doc.targetSourceId}`;
      const docRemaining = remainingByDoc.get(key) ?? 0;
      if (docRemaining <= 0.009) continue;

      const take = round2(Math.min(remainingPayment, docRemaining));
      if (take <= 0.009) continue;

      plan.push({ journalLineId: payment.journalLineId, targetSourceType: doc.targetSourceType, targetSourceId: doc.targetSourceId, amount: take });
      remainingByDoc.set(key, round2(docRemaining - take));
      remainingPayment = round2(remainingPayment - take);
    }
  }

  return plan;
}

export interface FifoInvariantViolation {
  totalAdvance: number;
  openDocumentsWithCapacity: { targetSourceType: string; targetSourceId: string; remaining: number }[];
}

/**
 * Hard correctness invariant on the greedy walk's own OUTPUT: if any
 * payment amount is left over as "advance" (unallocated) after a
 * rebuild, EVERY candidate document passed in must have been filled
 * to its own full remainingAllocatable - computeFifoAllocationPlan's
 * algorithm walks every document for every payment before moving on,
 * so this should hold by construction given a correct candidate
 * list. A violation here means candidate discovery itself missed
 * something (a real open document that should have been in
 * `documents` but wasn't) - exactly the class of bug this feature has
 * repeatedly hit on production data. Returns the violation (never
 * throws itself - the caller decides whether to hard-fail) so it can
 * be asserted in both rerunFifoForParty and a pure unit test.
 */
export function checkNoAdvanceWithOpenCapacity(
  payments: FifoCandidatePayment[],
  documents: FifoCandidateDocument[],
  plan: FifoAllocationPlanItem[]
): FifoInvariantViolation | null {
  const totalPayments = round2(payments.reduce((s, p) => s + p.remainingAmount, 0));
  const totalAllocated = round2(plan.reduce((s, p) => s + p.amount, 0));
  const advance = round2(totalPayments - totalAllocated);
  if (advance <= 0.009) return null;

  const allocatedByDoc = new Map<string, number>();
  for (const item of plan) {
    const key = `${item.targetSourceType}:${item.targetSourceId}`;
    allocatedByDoc.set(key, round2((allocatedByDoc.get(key) ?? 0) + item.amount));
  }

  const openDocumentsWithCapacity: FifoInvariantViolation["openDocumentsWithCapacity"] = [];
  for (const doc of documents) {
    const key = `${doc.targetSourceType}:${doc.targetSourceId}`;
    const allocated = allocatedByDoc.get(key) ?? 0;
    const remaining = round2(doc.remainingAllocatable - allocated);
    if (remaining > 0.009) {
      openDocumentsWithCapacity.push({ targetSourceType: doc.targetSourceType, targetSourceId: doc.targetSourceId, remaining });
    }
  }

  if (openDocumentsWithCapacity.length === 0) return null;
  return { totalAdvance: advance, openDocumentsWithCapacity };
}

async function getPartyPaymentLineIdsByDirection(
  tx: Tx,
  partyAccountId: string,
  direction: AllocationDirection
): Promise<string[]> {
  const wantDebit = direction === "PAYABLE";
  const lines = await tx.journalLine.findMany({
    where: {
      accountId: partyAccountId,
      account: { category: "PARTY" },
      journalEntry: { referenceType: "DAILY_POSTING" },
      ...(wantDebit ? { debit: { gt: 0 } } : { credit: { gt: 0 } }),
    },
    select: { id: true },
  });
  return lines.map((l) => l.id);
}

export interface EligibleFifoPayment {
  journalLineId: string;
  amount: number;
  entryDate: Date;
}

export async function listEligibleFifoPayments(
  tx: Tx,
  partyAccountId: string,
  direction: AllocationDirection
): Promise<EligibleFifoPayment[]> {
  const candidates = await tx.journalLine.findMany({
    where: {
      accountId: partyAccountId,
      account: { category: "PARTY" },
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
    },
    select: { id: true, allocationMode: true },
  });

  const results: EligibleFifoPayment[] = [];
  for (const candidate of candidates) {
    if (candidate.allocationMode === "MANUAL") continue;
    try {
      const payment = await getPaymentLine(tx, candidate.id);
      if (payment.isDeleted || !isEligibleForAllocation(payment)) continue;
      if (directionForPaymentLine(payment.direction) !== direction) continue;
      results.push({ journalLineId: payment.journalLineId, amount: payment.amount, entryDate: payment.entryDate });
    } catch {
      // Not a qualifying payment line (ambiguous entry, wrong shape, etc.) - skip.
    }
  }

  return results;
}

/**
 * Rebuilds every auto-FIFO allocation for one party, in one
 * direction, from a clean slate. Must be called inside the SAME
 * transaction as whatever triggered it (payment create/edit/delete/
 * restore, document create/edit/delete/restore, or Settlement
 * create/edit/Unsettle) - see each integration point's own call
 * site for why re-running synchronously, in-transaction, is correct
 * here (no background job/async re-run in this design).
 */
export async function rerunFifoForParty(
  tx: Tx,
  partyAccountId: string,
  direction: AllocationDirection,
  createdById: string
): Promise<void> {
  const directionLineIds = await getPartyPaymentLineIdsByDirection(tx, partyAccountId, direction);

  if (directionLineIds.length > 0) {
    await tx.paymentAllocation.deleteMany({
      where: { origin: "FIFO", journalLineId: { in: directionLineIds } },
    });
  }

  const payments = await listEligibleFifoPayments(tx, partyAccountId, direction);
  if (payments.length === 0) return;

  const documents = await getPartyDocumentStates(tx, partyAccountId, direction, { onlyWithRemainingBalance: true });
  if (documents.length === 0) return;

  const candidatePayments: FifoCandidatePayment[] = [];
  for (const payment of payments) {
    const alreadyAllocated = await getAllocatedAmountForPayment(tx, payment.journalLineId);
    candidatePayments.push({
      journalLineId: payment.journalLineId,
      remainingAmount: round2(payment.amount - alreadyAllocated),
      entryDate: payment.entryDate,
    });
  }

  const sortedPayments = sortFifoPayments(candidatePayments);
  const sortedDocuments = sortFifoDocuments(documents);
  const plan = computeFifoAllocationPlan(sortedPayments, sortedDocuments);

  const violation = checkNoAdvanceWithOpenCapacity(sortedPayments, sortedDocuments, plan);
  if (violation) {
    throw new AllocationError(
      "FIFO_INVARIANT_VIOLATION",
      `Rs. ${violation.totalAdvance} left unallocated as advance while ${violation.openDocumentsWithCapacity.length} document(s) still have open capacity (${violation.openDocumentsWithCapacity
        .map((d) => `${d.targetSourceType} ${d.targetSourceId}: Rs. ${d.remaining}`)
        .join(", ")}) - this should never happen; candidate discovery likely missed something.`
    );
  }

  for (const item of plan) {
    await tx.paymentAllocation.create({
      data: {
        journalLineId: item.journalLineId,
        targetSourceType: item.targetSourceType,
        targetSourceId: item.targetSourceId,
        allocatedAmount: item.amount,
        createdById,
        origin: "FIFO",
      },
    });
  }
}

/**
 * Document delete/Bin/amount-edit/party-reassignment trigger: clears
 * EVERY allocation row (any origin) for this one specific document -
 * since the document's own totalDue/existence just changed, every
 * row allocated against its OLD state is stale - then reruns the
 * FIFO rebuild for whichever party those rows (or the document's own
 * fresh resolution) say is affected, so freed-up/newly-resolvable
 * money is immediately picked back up.
 */
export async function clearAndRerunForDocument(
  tx: Tx,
  targetSourceType: AllocationTargetType,
  targetSourceId: string,
  createdById: string
): Promise<void> {
  const existingRows = await tx.paymentAllocation.findMany({
    where: { targetSourceType, targetSourceId },
    select: { journalLineId: true },
  });

  let partyAccountId: string | null = null;
  let direction: AllocationDirection | null = null;

  try {
    const target = await resolveAllocationTarget(tx, targetSourceType, targetSourceId);
    partyAccountId = target.responsiblePartyAccountId;
    direction = target.direction;
  } catch {
    // Document deleted/zero/ambiguous now - fall back to whichever
    // party its own pre-existing allocation rows were against, so
    // that party's FIFO is still rebuilt once this document's own
    // rows are cleared below.
    if (existingRows.length > 0) {
      try {
        const payment = await getPaymentLine(tx, existingRows[0].journalLineId);
        partyAccountId = payment.partyAccountId;
        direction = directionForPaymentLine(payment.direction);
      } catch {
        // Nothing left to resolve - no rebuild needed beyond clearing below.
      }
    }
  }

  await tx.paymentAllocation.deleteMany({ where: { targetSourceType, targetSourceId } });

  if (partyAccountId && direction) {
    await rerunFifoForParty(tx, partyAccountId, direction, createdById);
  }
}

interface EntryLineForFifo {
  accountId: string;
  debit: Prisma.Decimal | number;
  credit: Prisma.Decimal | number;
  account: { category: string };
}

/**
 * Shared by every Bin/Restore/Delete integration point that already
 * has a JournalEntry's own `lines` (with `account.category` selected)
 * in hand: collects the distinct {accountId, direction} pairs for
 * every PARTY-category line on it, then reruns FIFO for each - one
 * call covers "this payment is gone/back, rebuild whatever party it
 * touched" without each call site re-deriving the direction mapping
 * (DEBIT on the party's own line = PAYABLE, CREDIT = RECEIVABLE - see
 * directionForPaymentLine above) by hand.
 */
export async function rerunFifoForEntryLines(
  tx: Tx,
  lines: EntryLineForFifo[],
  createdById: string
): Promise<void> {
  const parties = new Map<string, { accountId: string; direction: AllocationDirection }>();
  for (const line of lines) {
    if (line.account.category !== "PARTY") continue;
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (debit <= 0 && credit <= 0) continue;
    const direction: AllocationDirection = debit > 0 ? "PAYABLE" : "RECEIVABLE";
    parties.set(`${line.accountId}:${direction}`, { accountId: line.accountId, direction });
  }
  for (const { accountId, direction } of parties.values()) {
    await rerunFifoForParty(tx, accountId, direction, createdById);
  }
}

/**
 * Settlement create/edit/Unsettle trigger: a Challan's own Settlement
 * state change can newly ESTABLISH or newly EXCLUDE (via the
 * multi-payer guard - see resolveChallanTarget/resolveBiltyTarget/
 * resolveBiltyPaidTarget's own doc comments) several distinct
 * parties' CHALLAN/BILTY/BILTY_PAID targets at once. Rather than
 * tracking exactly which party gained/lost which target, this reruns
 * BOTH directions for every party account genuinely associated with
 * this Challan (its own Transporter, plus every Bilty's Consignor/
 * Consignee/Clearing Agent/Agent/Paid-responsible party) - a no-op
 * for any direction/party that has nothing to rebuild, and the only
 * way to be certain every newly (un)available target is picked up
 * without re-deriving Settlement's own, considerably more intricate
 * resolution chain here a second time.
 */
export async function rerunFifoForChallanParties(tx: Tx, challanId: string, createdById: string): Promise<void> {
  const challan = await tx.challan.findUnique({
    where: { id: challanId },
    select: {
      transporterParty: { select: { account: { select: { id: true } } } },
      bilties: {
        select: {
          bilty: {
            select: {
              consignorParty: { select: { account: { select: { id: true } } } },
              consigneeParty: { select: { account: { select: { id: true } } } },
              clearingAgentParty: { select: { account: { select: { id: true } } } },
              agentParty: { select: { account: { select: { id: true } } } },
              paidResponsibleParty: { select: { account: { select: { id: true } } } },
            },
          },
        },
      },
    },
  });
  if (!challan) return;

  const accountIds = new Set<string>();
  if (challan.transporterParty?.account) accountIds.add(challan.transporterParty.account.id);
  for (const cb of challan.bilties) {
    const b = cb.bilty;
    for (const p of [b.consignorParty, b.consigneeParty, b.clearingAgentParty, b.agentParty, b.paidResponsibleParty]) {
      if (p?.account) accountIds.add(p.account.id);
    }
  }

  for (const accountId of accountIds) {
    await rerunFifoForParty(tx, accountId, "RECEIVABLE", createdById);
    await rerunFifoForParty(tx, accountId, "PAYABLE", createdById);
  }
}

/**
 * Private Phonch create/edit/delete/restore trigger - mirrors
 * rerunFifoForChallanParties's own reasoning: a Private Phonch's edit
 * can change several distinct parties' PRIVATE_PHONCH_PAYABLE/
 * PRIVATE_PHONCH_RECOVERY targets at once (its own Transporter, plus
 * every distinct Clearing Agent named on a vehicle row) - rerun both
 * directions for every one of them rather than tracking exactly which
 * target changed.
 */
export async function rerunFifoForPrivatePhonchParties(tx: Tx, phonchId: string, createdById: string): Promise<void> {
  const phonch = await tx.privatePhonch.findUnique({
    where: { id: phonchId },
    select: {
      transporterParty: { select: { account: { select: { id: true } } } },
      vehicles: { select: { clearingAgentParty: { select: { account: { select: { id: true } } } } } },
    },
  });
  if (!phonch) return;

  const accountIds = new Set<string>();
  if (phonch.transporterParty?.account) accountIds.add(phonch.transporterParty.account.id);
  for (const v of phonch.vehicles) {
    if (v.clearingAgentParty?.account) accountIds.add(v.clearingAgentParty.account.id);
  }

  for (const accountId of accountIds) {
    await rerunFifoForParty(tx, accountId, "RECEIVABLE", createdById);
    await rerunFifoForParty(tx, accountId, "PAYABLE", createdById);
  }
}

export { AllocationError };
