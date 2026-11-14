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

// ============================================================
// Timing note for computePartyFifoPreview/checkPartyReconciliation
// below: both run extra read queries beyond the minimum
// rerunFifoForParty itself needs. This is accepted and explicit per
// the live-engine reconciliation warning's own instructions (see
// rerunFifoForParty) - it is a diagnostic, never a behavior change,
// and it only runs once per rerunFifoForParty call (every write
// trigger already in the codebase), not on every page load.
// ============================================================

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

export interface PartyFifoPreview {
  direction: AllocationDirection;
  /** True when this party has ZERO open FIFO-scope documents at all
   * for this direction - FIFO is simply not applicable here. */
  noFifoDocuments: boolean;
  documents: FifoCandidateDocument[];
  plan: FifoAllocationPlanItem[];
  advanceLeft: number;
  docsCleared: number;
  docsPartial: number;
  invariantViolation: FifoInvariantViolation | null;
}

/**
 * The ONE shared, read-only FIFO-planning computation: builds the
 * exact same candidate-payment/candidate-document/greedy-plan/
 * invariant-check pipeline rerunFifoForParty itself writes from, and
 * that scripts/backfill-fifo-allocation.ts's dry-run preview and
 * --verbose report against. Previously each caller re-implemented
 * this pipeline separately, which is exactly how the Summary vs.
 * --verbose vs. live-engine disagreement this feature has hit on
 * production happens - from here on there is only one place this
 * logic can drift. Returns null when there is nothing to plan at all
 * (zero eligible payments) - the caller decides what that means.
 */
export async function computePartyFifoPreview(tx: Tx, accountId: string, direction: AllocationDirection): Promise<PartyFifoPreview | null> {
  const payments = await listEligibleFifoPayments(tx, accountId, direction);
  if (payments.length === 0) return null;

  const documents = await getPartyDocumentStates(tx, accountId, direction, { onlyWithRemainingBalance: true });
  if (documents.length === 0) {
    return { direction, noFifoDocuments: true, documents: [], plan: [], advanceLeft: 0, docsCleared: 0, docsPartial: 0, invariantViolation: null };
  }

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
  const invariantViolation = checkNoAdvanceWithOpenCapacity(sortedPayments, sortedDocuments, plan);

  const allocatedByDoc = new Map<string, number>();
  for (const item of plan) {
    const key = `${item.targetSourceType}:${item.targetSourceId}`;
    allocatedByDoc.set(key, round2((allocatedByDoc.get(key) ?? 0) + item.amount));
  }

  let docsCleared = 0;
  let docsPartial = 0;
  for (const doc of sortedDocuments) {
    const allocated = allocatedByDoc.get(`${doc.targetSourceType}:${doc.targetSourceId}`) ?? 0;
    if (allocated <= 0.009) continue;
    if (allocated >= doc.remainingAllocatable - 0.009) docsCleared++;
    else docsPartial++;
  }

  const totalPaymentAmount = round2(candidatePayments.reduce((s, p) => s + p.remainingAmount, 0));
  const totalAllocated = round2(plan.reduce((s, p) => s + p.amount, 0));
  const advanceLeft = round2(totalPaymentAmount - totalAllocated);

  return { direction, noFifoDocuments: false, documents: sortedDocuments, plan, advanceLeft, docsCleared, docsPartial, invariantViolation };
}

// ============================================================
// RECONCILIATION - ONE combined check per PARTY (both directions
// together), never per-direction. See checkPartyReconciliation's own
// doc comment below for why. Shared by scripts/backfill-fifo-
// allocation.ts (the dry-run report), scripts/report-document-ledger-
// drift.ts (root-causing a MISMATCH), and rerunFifoForParty itself
// (a live, read-only warning - see its own doc comment).
// ============================================================

/** Every sourceType that ALWAYS means "already tagged to a specific
 * document at posting time" (same set isEligibleForAllocation excludes
 * in lib/payment-allocation.ts) - a line carrying one of these is, by
 * definition, never a generic unattributed payment FIFO should have
 * an opinion about. When its OWN document happens to resolve right
 * now, that's already captured via bucket 3 (resolvedDocumentKeys,
 * checked first); when it does NOT (MULTI_PAYER_NOT_ALLOCATABLE, no
 * responsible party established yet, a historical reassignment, etc.),
 * the PROTECTED Settlement/Phonch/Bill/Private-Phonch systems still
 * own this money's true disposition, independently of FIFO - so it is
 * never "unexplained" either way. Plus SETTLEMENT_PAYMENT (the
 * multi-payer engine's own correction tag, never itself a document)
 * and MANUAL_JOURNAL (never document-linked by design). */
const DOCUMENT_LINKED_SOURCE_TYPES = new Set(["CHALLAN", "BILTY", "BILL", "PRIVATE_PHONCH", "PHONCH"]);

/** Maps an AllocationTargetType to the LITERAL JournalLine.sourceType
 * tag its own document-linked lines actually carry - these are NOT
 * always the same string (BILTY_PAID's own lines are still tagged
 * sourceType="BILTY"; PHONCH_RECOVERY's are tagged "PHONCH", not
 * "PHONCH_RECOVERY"; PRIVATE_PHONCH_PAYABLE/RECOVERY's are tagged
 * "PRIVATE_PHONCH") - a classifier that assumes identity between the
 * two silently fails to recognize a document's own lines as explained. */
export function sourceTypeTagForTarget(targetSourceType: string): string | null {
  switch (targetSourceType) {
    case "BILTY":
    case "BILTY_PAID":
      return "BILTY";
    case "BILL":
      return "BILL";
    case "CHALLAN":
      return "CHALLAN";
    case "PRIVATE_PHONCH_PAYABLE":
    case "PRIVATE_PHONCH_RECOVERY":
      return "PRIVATE_PHONCH";
    case "PHONCH_RECOVERY":
      return "PHONCH";
    default:
      return null; // OPENING_BALANCE - no sourceType tag at all.
  }
}

export interface LedgerLineClassification {
  id: string;
  debit: number;
  credit: number;
  sourceType: string | null;
  sourceId: string | null;
  entryId: string;
  entryDate: Date;
  referenceType: string | null;
  referenceId: string | null;
}

export interface ReconciliationResult {
  expectedSignedNet: number;
  adjustedActualSignedNet: number;
  diff: number;
  isMatch: boolean;
  unexplainedLines: LedgerLineClassification[];
}

/**
 * expectedSignedNet = lhs(RECEIVABLE) - lhs(PAYABLE), each lhs = sum
 * of that direction's own doc-remaining-after-plan minus that
 * direction's own advance (see computePartyFifoPreview) - compared
 * against the account's REAL signed net balance (every live line,
 * debit - credit), after subtracting out every line explained by a
 * mechanism OTHER than FIFO's own document/payment model but that
 * still legitimately moves the balance (an unresolved Settlement-
 * family/document-linked line, a Manual Journal line, an Own-Carrier
 * trip fuel/expense posting). Any OTHER unexplained line is a genuine
 * gap. `directionReports` only needs to carry a preview for whichever
 * direction(s) the caller already computed - a direction with none
 * falls back to a plain remainingAllocatable sum (no plan to net an
 * advance against).
 */
export async function checkPartyReconciliation(
  tx: Tx,
  accountId: string,
  directionReports: { direction: AllocationDirection; preview: PartyFifoPreview }[]
): Promise<ReconciliationResult> {
  const previewByDirection = new Map(directionReports.map((r) => [r.direction, r.preview]));

  const lhsByDirection = new Map<AllocationDirection, number>();
  const resolvedDocumentKeys = new Set<string>();
  const fifoPaymentLineIds = new Set<string>();

  for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
    const documents = await getPartyDocumentStates(tx, accountId, direction, { onlyWithRemainingBalance: false });
    for (const doc of documents) {
      const tag = sourceTypeTagForTarget(doc.targetSourceType);
      if (!tag) continue; // OPENING_BALANCE has no sourceType tag to match against.
      const rawId =
        doc.targetSourceType === "PRIVATE_PHONCH_PAYABLE" || doc.targetSourceType === "PRIVATE_PHONCH_RECOVERY"
          ? doc.targetSourceId.split(":")[0]
          : doc.targetSourceId;
      resolvedDocumentKeys.add(`${tag}:${rawId}`);
    }

    const preview = previewByDirection.get(direction);
    if (preview && !preview.noFifoDocuments) {
      const allocatedByDoc = new Map<string, number>();
      for (const item of preview.plan) {
        const key = `${item.targetSourceType}:${item.targetSourceId}`;
        allocatedByDoc.set(key, round2((allocatedByDoc.get(key) || 0) + item.amount));
        fifoPaymentLineIds.add(item.journalLineId);
      }
      const totalDocsRemainingAfterPlan = documents.reduce((s, doc) => {
        const allocated = allocatedByDoc.get(`${doc.targetSourceType}:${doc.targetSourceId}`) || 0;
        return s + Math.max(0, round2(doc.remainingAllocatable - allocated));
      }, 0);
      lhsByDirection.set(direction, round2(totalDocsRemainingAfterPlan - preview.advanceLeft));
    } else {
      lhsByDirection.set(direction, round2(documents.reduce((s, doc) => s + doc.remainingAllocatable, 0)));
    }

    const eligiblePayments = await listEligibleFifoPayments(tx, accountId, direction);
    for (const p of eligiblePayments) fifoPaymentLineIds.add(p.journalLineId);
  }

  const expectedSignedNet = round2((lhsByDirection.get("RECEIVABLE") || 0) - (lhsByDirection.get("PAYABLE") || 0));

  const openingEquityAccount = await tx.account.findFirst({ where: { accountCode: "OPENING-BALANCE" }, select: { id: true } });

  const lines = await tx.journalLine.findMany({
    where: { accountId, journalEntry: { isDeleted: false } },
    select: {
      id: true,
      debit: true,
      credit: true,
      sourceType: true,
      sourceId: true,
      journalEntry: { select: { id: true, entryDate: true, referenceType: true, referenceId: true, lines: { select: { accountId: true } } } },
    },
    orderBy: { journalEntry: { entryDate: "asc" } },
  });

  let trueSignedNet = 0;
  let adjustmentNet = 0;
  const unexplainedLines: LedgerLineClassification[] = [];

  for (const line of lines) {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    trueSignedNet += debit - credit;

    const isOfficiallyTaggedOpening = line.journalEntry.referenceType === "OPENING_BALANCE";
    // Mirrors lib/payment-allocation.ts's isGenuineOpeningEquityContraPair: only a
    // genuine, unambiguous 2-line party-vs-Opening-Balance-Equity JE counts - never a
    // bundled multi-line entry that merely happens to also contain an unrelated
    // Opening-Balance-Equity line for a different party/purpose in the same submission.
    const hasOpeningEquityContra =
      openingEquityAccount != null &&
      line.journalEntry.lines.length === 2 &&
      line.journalEntry.lines.some((l) => l.accountId === openingEquityAccount.id);
    if (isOfficiallyTaggedOpening || hasOpeningEquityContra) continue; // bucket 1 - captured via lhs's own OPENING_BALANCE document.

    if (fifoPaymentLineIds.has(line.id)) continue; // bucket 2 - captured via lhs's own advance/allocated math.

    if (line.sourceType && line.sourceId && resolvedDocumentKeys.has(`${line.sourceType}:${line.sourceId}`)) continue; // bucket 3.

    const isDocumentLinkedButUnresolved = line.sourceType != null && DOCUMENT_LINKED_SOURCE_TYPES.has(line.sourceType);
    const isSettlementPaymentCorrection = line.sourceType === "SETTLEMENT_PAYMENT";
    const isManualJournal = line.journalEntry.referenceType === "MANUAL_JOURNAL";
    // Own-Carrier trip fuel/other-expense postings (lib/carrier-trip.ts) - a party-account
    // charge unrelated to any Bilty/Challan/Phonch/Bill document and never FIFO-eligible
    // (not a Daily Posting payment), the exact "non-FIFO line like fuel/expense" case.
    const isCarrierTripExpense =
      line.journalEntry.referenceType === "CARRIER_TRIP_LINE" || line.journalEntry.referenceType === "CARRIER_TRIP_LINE_REVERSAL";
    if (isDocumentLinkedButUnresolved || isSettlementPaymentCorrection || isManualJournal || isCarrierTripExpense) {
      adjustmentNet += debit - credit; // bucket 4 - explained by a different, protected mechanism.
      continue;
    }

    unexplainedLines.push({
      id: line.id,
      debit,
      credit,
      sourceType: line.sourceType,
      sourceId: line.sourceId,
      entryId: line.journalEntry.id,
      entryDate: line.journalEntry.entryDate,
      referenceType: line.journalEntry.referenceType,
      referenceId: line.journalEntry.referenceId,
    }); // bucket 5 - genuinely unexplained.
  }

  const adjustedActualSignedNet = round2(trueSignedNet - adjustmentNet);
  const diff = round2(expectedSignedNet - adjustedActualSignedNet);

  return { expectedSignedNet, adjustedActualSignedNet, diff, isMatch: Math.abs(diff) <= 0.01, unexplainedLines };
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

  const preview = await computePartyFifoPreview(tx, partyAccountId, direction);
  if (!preview || preview.noFifoDocuments) return;

  if (preview.invariantViolation) {
    const violation = preview.invariantViolation;
    throw new AllocationError(
      "FIFO_INVARIANT_VIOLATION",
      `Rs. ${violation.totalAdvance} left unallocated as advance while ${violation.openDocumentsWithCapacity.length} document(s) still have open capacity (${violation.openDocumentsWithCapacity
        .map((d) => `${d.targetSourceType} ${d.targetSourceId}: Rs. ${d.remaining}`)
        .join(", ")}) - this should never happen; candidate discovery likely missed something.`
    );
  }

  for (const item of preview.plan) {
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

  // Read-only reconciliation diagnostic, never a behavior change: this
  // party's own ledger is checked against the SAME shared FIFO model
  // that was just written, and a mismatch is only ever logged, never
  // thrown or excluded from the rebuild above. No exclusion list - this
  // runs for every party, every trigger, exactly as before; a party
  // whose underlying Settlement/multi-payer history has drifted from
  // its own document totals (see scripts/report-document-ledger-
  // drift.ts for root-causing WHY) still gets its normal FIFO rebuild,
  // just with a warning alongside it.
  try {
    const reconciliation = await checkPartyReconciliation(tx, partyAccountId, [{ direction, preview }]);
    if (!reconciliation.isMatch) {
      console.warn(
        `[FIFO] reconciliation MISMATCH for party account ${partyAccountId} (${direction}): diff=${reconciliation.diff} ` +
          `(expected ${reconciliation.expectedSignedNet} vs adjusted actual ${reconciliation.adjustedActualSignedNet})`
      );
    }
  } catch (error) {
    console.warn(
      `[FIFO] reconciliation check failed for party account ${partyAccountId} (${direction}): ${error instanceof Error ? error.message : String(error)}`
    );
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
