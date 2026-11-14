// AUTO FIFO ALLOCATION - BACKFILL
//
// Mirrors scripts/redate-dispatch-booking-entries.ts's own
// conventions exactly (dry-run by default, --apply --user=<username>
// to write, attributed via the same actor resolution).
//
// Two passes, run together every time (unless --party narrows it):
//
//   PASS 1 - VERIFY/REPORT ONLY (never writes). The migration itself
//   (prisma/migrations/20261112162129_party_payment_fifo_allocation)
//   already stamped every PaymentAllocation row that existed before
//   the `origin` column did to 'LEGACY' - there is nothing left to
//   WRITE here. This pass just reads and reports the count of LEGACY
//   rows per party, confirming the migration landed correctly.
//
//   PASS 2 - FIFO PASS. For every Party with an active account and
//   both directions (RECEIVABLE/PAYABLE), reports what
//   rerunFifoForParty() would do - documents cleared, partially
//   covered, and any advance (unallocated leftover) - without
//   writing, plus each party's own Opening Balance figure (the RAW,
//   uncapped figure - see lib/payment-allocation.ts's own
//   resolveOpeningBalanceTarget doc comment on why it is NEVER capped
//   to the account's current balance before FIFO runs) and its
//   source breakdown (official OPENING_BALANCE-tagged entry vs. an
//   untagged manual JE contra-ing the Opening Balance Equity
//   account). --apply commits it by calling the SAME rerunFifoForParty
//   the live app uses for every other trigger - never a second,
//   parallel write path.
//
//   RECONCILIATION (printed for every party+direction, read-only):
//   opening_remaining + sum(other doc remaining) - advance is
//   compared against the account's own current net ledger balance -
//   OK when they match, MISMATCH with the diff otherwise. A mismatch
//   means some ledger activity is moving the balance without being
//   accounted for by a recognized open document or a FIFO-tracked
//   payment; --verbose lists exactly which lines those are.
//
//   HARD INVARIANT (checkNoAdvanceWithOpenCapacity, shared with the
//   real rerunFifoForParty): a genuine advance can never coexist with
//   an open document that still has capacity - this pass checks it
//   read-only and flags any violation loudly; the live write path
//   throws on it outright rather than silently misallocating.
//
// A payment already stamped allocationMode: "MANUAL" is skipped by
// listEligibleFifoPayments() itself (same as every other FIFO
// rebuild) - never touched by this script either.
//
// DIAGNOSTICS (--party + --verbose, always read-only regardless of
// --apply): prints, for the one matched party, (1) every JournalLine
// on its account since opening with ELIGIBLE yes/no + a reason when
// not, (2) every candidate document per direction with INCLUDED
// yes/no + a reason when not (plus a one-line "alreadyPaid rule"
// explaining exactly which tagged lines that figure counts, so a
// same-party receipt tagged to a DIFFERENT document/component is
// immediately traceable instead of looking like a bug), (3) the
// planned allocations. A party with zero open FIFO-scope documents at
// all for a direction (e.g. a fuel pump only ever paid via Trip
// expense, never a real Bilty/Challan/Bill/Private Phonch/Opening
// Balance) reports "N/A - no FIFO documents" instead of a misleading
// "advance left unallocated" total.
//
// Usage:
//   npx tsx scripts/backfill-fifo-allocation.ts                              (dry-run, every party)
//   npx tsx scripts/backfill-fifo-allocation.ts --apply                      (writes)
//   npx tsx scripts/backfill-fifo-allocation.ts --apply --user=umar          (attribute to a specific username; defaults to the first active SUPER_ADMIN)
//   npx tsx scripts/backfill-fifo-allocation.ts --party="Ansari And Sons"    (restrict the FIFO pass to one party, case-insensitive substring match)
//   npx tsx scripts/backfill-fifo-allocation.ts --party="NKB" --verbose      (full line-by-line/document-by-document diagnostic for that party - read-only)

import { PrismaClient } from "@prisma/client";
import {
  AllocationError,
  getOpeningBalanceBreakdown,
  getPartyDocumentStates,
  getPartyDocumentCandidateRefs,
  getRemainingAllocatableAmountForDocument,
  getAllocatedAmountForPayment,
  getPaymentLine,
  isEligibleForAllocation,
  type AllocationDirection,
} from "../lib/payment-allocation";
import {
  listEligibleFifoPayments,
  rerunFifoForParty,
  sortFifoPayments,
  sortFifoDocuments,
  computeFifoAllocationPlan,
  checkNoAdvanceWithOpenCapacity,
  type FifoCandidateDocument,
  type FifoAllocationPlanItem,
} from "../lib/party-payment-fifo";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const verbose = process.argv.includes("--verbose");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;
const partyArg = process.argv.find((a) => a.startsWith("--party="));
const requestedPartyName = partyArg ? partyArg.slice("--party=".length).replace(/^"|"$/g, "") : null;

if (verbose && !requestedPartyName) {
  console.error('--verbose requires --party="<name>" - it only ever reports on one party at a time.');
  process.exit(1);
}

async function resolveActor() {
  const user = requestedUsername
    ? await prisma.user.findFirst({ where: { username: requestedUsername, isActive: true } })
    : await prisma.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true }, orderBy: { createdAt: "asc" } });
  if (!user) {
    throw new Error(
      requestedUsername
        ? `No active user found with username "${requestedUsername}".`
        : "No active SUPER_ADMIN user found - pass --user=<username> explicitly."
    );
  }
  return user;
}

async function reportLegacyBackfillStatus() {
  console.log("\n=== PASS 1 - Verify migration backfill (read-only) ===\n");

  const legacyRows = await prisma.paymentAllocation.findMany({
    where: { origin: "LEGACY" },
    select: {
      allocatedAmount: true,
      journalLine: { select: { account: { select: { partyId: true, party: { select: { partyName: true } } } } } },
    },
  });

  if (legacyRows.length === 0) {
    console.log("No LEGACY-origin PaymentAllocation rows found (either a fresh install, or every pre-existing row has already been migrated off LEGACY by a later manual pick/\"Back to Auto\").\n");
    return;
  }

  const byParty = new Map<string, { partyName: string; count: number; amount: number }>();
  for (const row of legacyRows) {
    const partyId = row.journalLine.account.partyId;
    const partyName = row.journalLine.account.party?.partyName || "(no party)";
    const key = partyId || "(no party)";
    const existing = byParty.get(key) || { partyName, count: 0, amount: 0 };
    existing.count += 1;
    existing.amount = Math.round((existing.amount + Number(row.allocatedAmount)) * 100) / 100;
    byParty.set(key, existing);
  }

  console.log(`${legacyRows.length} LEGACY row(s) across ${byParty.size} party(ies):`);
  for (const [, { partyName, count, amount }] of byParty) {
    console.log(`  - ${partyName}: ${count} row(s), Rs. ${amount.toLocaleString()}`);
  }
  console.log("");
}

interface PartyFifoReport {
  direction: AllocationDirection;
  /** True when this party has ZERO open FIFO-scope documents at all
   * for this direction (e.g. a fuel pump that only ever receives
   * Trip-expense payments, never a Bilty/Challan/Bill/Private Phonch/
   * Opening Balance) - FIFO is simply not applicable here, which is
   * a different situation from "everything is already allocated" or
   * "there's a genuine advance" and must be reported as such rather
   * than a misleading "advance left unallocated" for the party's
   * entire payment history. */
  noFifoDocuments: boolean;
  docsCleared: number;
  docsPartial: number;
  advanceLeft: number;
  /** Carried through so the reconciliation check (B3/B4) can reuse
   * the EXACT same documents/plan this preview computed, rather than
   * recomputing a second time and risking the two disagreeing. */
  documents: FifoCandidateDocument[];
  plan: FifoAllocationPlanItem[];
  /** Non-null when checkNoAdvanceWithOpenCapacity (B4) found a
   * violation - returned rather than printed here, so the CALLER can
   * attribute it under the correct party header (see runFifoPass's
   * own comment on why every line must be attributed explicitly). */
  invariantViolation: ReturnType<typeof checkNoAdvanceWithOpenCapacity>;
}

async function previewFifoForParty(accountId: string, direction: AllocationDirection): Promise<PartyFifoReport | null> {
  const payments = await listEligibleFifoPayments(prisma, accountId, direction);
  if (payments.length === 0) return null;

  const documents = await getPartyDocumentStates(prisma, accountId, direction, { onlyWithRemainingBalance: true });
  if (documents.length === 0) {
    return { direction, noFifoDocuments: true, docsCleared: 0, docsPartial: 0, advanceLeft: 0, documents: [], plan: [], invariantViolation: null };
  }

  const candidatePayments = [];
  for (const payment of payments) {
    const alreadyAllocated = await getAllocatedAmountForPayment(prisma, payment.journalLineId);
    candidatePayments.push({
      journalLineId: payment.journalLineId,
      remainingAmount: Math.round((payment.amount - alreadyAllocated) * 100) / 100,
      entryDate: payment.entryDate,
    });
  }

  const sortedPayments = sortFifoPayments(candidatePayments);
  const sortedDocuments = sortFifoDocuments(documents);
  const plan = computeFifoAllocationPlan(sortedPayments, sortedDocuments);

  // B4 - same hard invariant rerunFifoForParty() itself asserts
  // before ever writing: leftover advance while an open document
  // still has capacity can only mean candidate discovery missed
  // something. The dry-run preview checks it too, read-only - the
  // CALLER prints it (see runFifoPass), never here, so it is always
  // correctly attributed under this party's own header.
  const invariantViolation = checkNoAdvanceWithOpenCapacity(sortedPayments, sortedDocuments, plan);

  const allocatedByDoc = new Map<string, number>();
  for (const item of plan) {
    const key = `${item.targetSourceType}:${item.targetSourceId}`;
    allocatedByDoc.set(key, Math.round(((allocatedByDoc.get(key) || 0) + item.amount) * 100) / 100);
  }

  let docsCleared = 0;
  let docsPartial = 0;
  for (const doc of sortedDocuments) {
    const allocated = allocatedByDoc.get(`${doc.targetSourceType}:${doc.targetSourceId}`) || 0;
    if (allocated <= 0.009) continue;
    if (allocated >= doc.remainingAllocatable - 0.009) docsCleared++;
    else docsPartial++;
  }

  const totalPaymentAmount = candidatePayments.reduce((s, p) => s + p.remainingAmount, 0);
  const totalAllocated = plan.reduce((s, p) => s + p.amount, 0);
  const advanceLeft = Math.round((totalPaymentAmount - totalAllocated) * 100) / 100;

  return { direction, noFifoDocuments: false, docsCleared, docsPartial, advanceLeft, documents: sortedDocuments, plan, invariantViolation };
}

function reasonFromError(error: unknown): string {
  if (error instanceof AllocationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

// ============================================================
// B3 - RECONCILIATION - ONE combined check per PARTY (both
// directions together), never per-direction.
//
// An account that carries BOTH a receivable and a payable at once
// (e.g. a Transporter/Clearing Agent who is both Collection-
// responsible for some Bilties AND Carrier-Rent-responsible for a
// Challan - confirmed on production: Nawab Broker) cannot be
// reconciled one direction at a time: the account's own signed net
// balance is a single number blending both, so checking only
// "RECEIVABLE documents vs. the RECEIVABLE-filtered balance" makes
// every genuinely-explained PAYABLE-side line look "unexplained",
// and vice versa. This checks the FULL signed net instead:
//
//   expectedSignedNet = lhs(RECEIVABLE) - lhs(PAYABLE)
//   (each lhs = sum of that direction's own doc-remaining-after-plan,
//    minus that direction's own advance - see previewFifoForParty)
//
// compared against the account's REAL signed net balance (every live
// line, debit - credit), AFTER subtracting out every line that is
// explained by a mechanism OTHER than FIFO's own document/payment
// model but still legitimately moves the balance:
//   - a Settlement-family entry (SETTLEMENT/SETTLEMENT_CORRECTION/
//     SETTLEMENT_PAYMENT/SETTLEMENT_PAYMENT_CORRECTION/
//     CARRIER_RENT_MULTI_PAYER_TRANSITION) for a document that did
//     NOT resolve as one of this party's own current documents - the
//     protected Settlement/multi-payer engine has already decided
//     this money's true disposition independently of FIFO (it may
//     have been reassigned since), so FIFO is right to stay out of it.
//   - a Manual Journal line (referenceType=MANUAL_JOURNAL) - never
//     document-linked by design (decision #12), always non-FIFO.
// Any OTHER unexplained line is a genuine gap - exactly what
// --verbose lists for a MISMATCH.
// ============================================================

/** Every sourceType that ALWAYS means "already tagged to a specific
 * document at posting time" (same set isEligibleForAllocation excludes
 * in lib/payment-allocation.ts) - a line carrying one of these is, by
 * definition, never a generic unattributed payment FIFO should have
 * an opinion about. When its OWN document happens to resolve right
 * now, that's already captured via bucket 3 (resolvedDocumentKeys,
 * checked first); when it does NOT (MULTI_PAYER_NOT_ALLOCATABLE, no
 * responsible party established yet, a historical reassignment, etc.
 * - confirmed on production: Jaecco Hyderabad, Al furqan), the
 * PROTECTED Settlement/Phonch/Bill/Private-Phonch systems still own
 * this money's true disposition, independently of FIFO - so it is
 * never "unexplained" either way. Plus SETTLEMENT_PAYMENT (the
 * multi-payer engine's own correction tag, never itself a document)
 * and MANUAL_JOURNAL (never document-linked by design, decision #12). */
const DOCUMENT_LINKED_SOURCE_TYPES = new Set(["CHALLAN", "BILTY", "BILL", "PRIVATE_PHONCH", "PHONCH"]);

/** Maps an AllocationTargetType to the LITERAL JournalLine.sourceType
 * tag its own document-linked lines actually carry - these are NOT
 * always the same string (BILTY_PAID's own lines are still tagged
 * sourceType="BILTY"; PHONCH_RECOVERY's are tagged "PHONCH", not
 * "PHONCH_RECOVERY"; PRIVATE_PHONCH_PAYABLE/RECOVERY's are tagged
 * "PRIVATE_PHONCH") - a classifier that assumes identity between the
 * two silently fails to recognize a document's own lines as
 * explained (confirmed bug: MRK Faisalabad's PHONCH-tagged lines). */
function sourceTypeTagForTarget(targetSourceType: string): string | null {
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

interface LedgerLineClassification {
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

interface ReconciliationResult {
  expectedSignedNet: number;
  adjustedActualSignedNet: number;
  diff: number;
  isMatch: boolean;
  unexplainedLines: LedgerLineClassification[];
}

async function checkPartyReconciliation(
  accountId: string,
  directionReports: { direction: AllocationDirection; preview: PartyFifoReport }[]
): Promise<ReconciliationResult> {
  const previewByDirection = new Map(directionReports.map((r) => [r.direction, r.preview]));

  const lhsByDirection = new Map<AllocationDirection, number>();
  const resolvedDocumentKeys = new Set<string>();
  const fifoPaymentLineIds = new Set<string>();

  for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
    // ALWAYS fetch this direction's FULL (unfiltered) document list,
    // regardless of whether there happens to be any FIFO-eligible
    // payment to plan against - a document can be tagged-received
    // (existingReceivedOrPaid, or getPrivatePhonchPartyBalances's own
    // settledAmount) with no OTHER FIFO-eligible payment on the
    // account at all (confirmed: Khalid Goods has a CHALLAN- and a
    // PRIVATE_PHONCH-tagged receipt/payment but ZERO eligible PAYABLE
    // payments, so previewFifoForParty(..., "PAYABLE") returns null -
    // the document itself, and its own tagged lines, still need to be
    // recognized here independently of that).
    const documents = await getPartyDocumentStates(prisma, accountId, direction, { onlyWithRemainingBalance: false });
    for (const doc of documents) {
      const tag = sourceTypeTagForTarget(doc.targetSourceType);
      if (!tag) continue; // OPENING_BALANCE has no sourceType tag to match against.
      const rawId = doc.targetSourceType === "PRIVATE_PHONCH_PAYABLE" || doc.targetSourceType === "PRIVATE_PHONCH_RECOVERY"
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
      // No eligible payments at all for this direction (or none of
      // the documents have remaining capacity) - nothing new to
      // allocate, so lhs is simply every document's own current
      // remaining amount.
      lhsByDirection.set(direction, round2(documents.reduce((s, doc) => s + doc.remainingAllocatable, 0)));
    }

    // EVERY FIFO-eligible payment line for this direction, not just
    // the ones THIS fresh plan has something left to allocate - a
    // line already fully consumed by a PRIOR real allocation (the 17
    // pre-existing PaymentAllocation rows on this production copy,
    // for instance) has remainingAmount=0 and so never appears in
    // `preview.plan` at all, but its own JournalLine is still real,
    // still FIFO-eligible, and still explains the ledger.
    const eligiblePayments = await listEligibleFifoPayments(prisma, accountId, direction);
    for (const p of eligiblePayments) fifoPaymentLineIds.add(p.journalLineId);
  }

  const expectedSignedNet = round2((lhsByDirection.get("RECEIVABLE") || 0) - (lhsByDirection.get("PAYABLE") || 0));

  const openingEquityAccount = await prisma.account.findFirst({ where: { accountCode: "OPENING-BALANCE" }, select: { id: true } });

  const lines = await prisma.journalLine.findMany({
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function printUnexplainedLedgerLines(unexplainedLines: LedgerLineClassification[]) {
  if (unexplainedLines.length === 0) {
    console.log(`      no unexplained lines found - the gap may be from a document resolution that failed silently; re-check with --verbose section (2) above.`);
    return;
  }
  console.log(`      unexplained ledger line(s) (contribute to the account's balance but match no recognized open document, FIFO-eligible payment, or known non-FIFO mechanism):`);
  for (const line of unexplainedLines) {
    const drCr = line.debit > 0 ? `Dr ${line.debit}` : `Cr ${line.credit}`;
    const date = line.entryDate.toISOString().slice(0, 10);
    console.log(
      `        ${date}  entry=${line.entryId}  ${drCr}  sourceType=${line.sourceType ?? "-"}  sourceId=${line.sourceId ?? "-"}  referenceType=${line.referenceType ?? "-"}  referenceId=${line.referenceId ?? "-"}`
    );
  }
}

/**
 * Explains, in plain terms, exactly which Daily Posting lines
 * "alreadyPaid" counts for a given target type - so a verbose report
 * showing alreadyPaid=0 next to an obviously-nonzero receipt
 * elsewhere on the SAME party's ledger (section (1)) is immediately
 * traceable instead of looking like a bug: that other receipt is
 * tagged to a DIFFERENT document/component and was never eligible to
 * count here in the first place.
 */
function explainAlreadyPaidRule(targetSourceType: string, targetSourceId: string): string {
  switch (targetSourceType) {
    case "BILTY":
      return `counts Daily Posting lines tagged sourceType=BILTY sourceId=${targetSourceId} on the Collection/Commission-responsible account, PLUS this party's own oldest-Bilty-first share of any sourceType=CHALLAN-tagged receipt on the same Challan - but only when this party has NO Carrier Rent due on that Challan (otherwise the CHALLAN-tagged receipt is ambiguous and never auto-attributed)`;
    case "BILTY_PAID":
      return `counts only Daily Posting lines tagged sourceType=BILTY sourceId=${targetSourceId} on the Paid-responsible account (independent of Settlement/Challan) - a CHALLAN-tagged receipt belongs to BILTY's own Collection/Commission share rule instead, never here`;
    case "CHALLAN":
      return `counts only Daily Posting lines tagged sourceType=CHALLAN sourceId=${targetSourceId} on the Carrier-Rent-responsible account - a BILTY-tagged receipt on this same account belongs to that Bilty's own Collection/Commission/Paid, a separate pool, and never counts here (the reverse direction - a CHALLAN-tagged receipt counting toward a Bilty's own Collection - is handled by BILTY's own rule above, not this one)`;
    case "BILL":
      return `counts only Daily Posting lines tagged sourceType=BILL sourceId=${targetSourceId} on the Client account`;
    case "PRIVATE_PHONCH_PAYABLE":
    case "PRIVATE_PHONCH_RECOVERY":
      return "derived from getPrivatePhonchPartyBalances's own live, vehicle-based recomputation (settledAmount) - never a direct tagged-Daily-Posting-line sum";
    case "PHONCH_RECOVERY":
      return `counts only Daily Posting lines tagged sourceType=PHONCH sourceId=${targetSourceId} on the Transporter's own account (this is a Showroom Phonch, NOT a Private Phonch - a separate target type)`;
    case "OPENING_BALANCE":
      return "always 0 by definition - the RAW opening figure is reduced only via real FIFO allocation (never pre-capped to the account's current balance before FIFO runs - see the reconciliation report below for how much of it other, non-FIFO ledger activity has already offset)";
    default:
      return "no rule on file for this target type";
  }
}

// ============================================================
// VERBOSE DIAGNOSTIC (--party + --verbose) - read-only.
// ============================================================

async function reportLedgerLines(accountId: string) {
  console.log("\n  --- (1) Every JournalLine on this party's account, oldest first ---\n");

  const lines = await prisma.journalLine.findMany({
    where: { accountId },
    select: {
      id: true,
      debit: true,
      credit: true,
      sourceType: true,
      sourceId: true,
      allocationMode: true,
      journalEntry: { select: { id: true, entryDate: true, referenceType: true, referenceId: true, isDeleted: true } },
    },
    orderBy: { journalEntry: { entryDate: "asc" } },
  });

  for (const line of lines) {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const drCr = debit > 0 ? `Dr ${debit}` : `Cr ${credit}`;
    const date = line.journalEntry.entryDate.toISOString().slice(0, 10);
    const base = `  ${date}  entry=${line.journalEntry.id}  ${drCr}  sourceType=${line.sourceType ?? "-"}  sourceId=${line.sourceId ?? "-"}  referenceType=${line.journalEntry.referenceType ?? "-"}  referenceId=${line.journalEntry.referenceId ?? "-"}  allocationMode=${line.allocationMode ?? "-"}`;

    if (line.journalEntry.isDeleted) {
      console.log(`${base}  ELIGIBLE=no (entry is binned)`);
      continue;
    }

    try {
      const payment = await getPaymentLine(prisma, line.id);
      if (!isEligibleForAllocation(payment)) {
        console.log(`${base}  ELIGIBLE=no (already document-linked: sourceType=${payment.sourceType})`);
        continue;
      }
      if (line.allocationMode === "MANUAL") {
        console.log(`${base}  ELIGIBLE=no (allocationMode=MANUAL - user picked documents manually)`);
        continue;
      }
      console.log(`${base}  ELIGIBLE=yes`);
    } catch (error) {
      console.log(`${base}  ELIGIBLE=no (${reasonFromError(error)})`);
    }
  }
}

async function reportCandidateDocuments(accountId: string) {
  console.log("\n  --- (2) Every candidate document, per direction ---\n");

  for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
    const candidates = await getPartyDocumentCandidateRefs(prisma, accountId, direction);
    if (candidates.length === 0) {
      console.log(`  [${direction}] no candidates at all`);
      continue;
    }

    for (const candidate of candidates) {
      try {
        const state = await getRemainingAllocatableAmountForDocument(prisma, candidate.targetSourceType, candidate.targetSourceId);
        const partyMatches = state.responsiblePartyAccountId === accountId;
        const directionMatches = state.direction === direction;
        const alreadyPaid = Math.round((state.existingReceivedOrPaid + state.allocatedViaTable) * 100) / 100;
        const included = partyMatches && directionMatches;
        const reason = !partyMatches ? "responsible party is a different account" : !directionMatches ? `direction is actually ${state.direction}` : "";

        console.log(
          `  [${direction}] ${candidate.targetSourceType} ${state.documentNo} (${state.documentDate.toISOString().slice(0, 10)})` +
            ` totalDue=${state.totalDue} alreadyPaid=${alreadyPaid} remaining=${state.remainingAllocatable}` +
            ` INCLUDED=${included ? "yes" : "no"}${reason ? ` (${reason})` : ""}`
        );
        console.log(`      alreadyPaid rule: ${explainAlreadyPaidRule(candidate.targetSourceType, candidate.targetSourceId)}`);
      } catch (error) {
        console.log(`  [${direction}] ${candidate.targetSourceType} ${candidate.targetSourceId} INCLUDED=no (${reasonFromError(error)})`);
      }
    }
  }
}

async function reportPlannedAllocations(accountId: string) {
  console.log("\n  --- (3) Planned allocations ---\n");

  for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
    const payments = await listEligibleFifoPayments(prisma, accountId, direction);
    const documents = await getPartyDocumentStates(prisma, accountId, direction, { onlyWithRemainingBalance: true });

    const candidatePayments = [];
    for (const payment of payments) {
      const alreadyAllocated = await getAllocatedAmountForPayment(prisma, payment.journalLineId);
      candidatePayments.push({
        journalLineId: payment.journalLineId,
        remainingAmount: Math.round((payment.amount - alreadyAllocated) * 100) / 100,
        entryDate: payment.entryDate,
      });
    }

    const plan = computeFifoAllocationPlan(sortFifoPayments(candidatePayments), sortFifoDocuments(documents));
    if (plan.length === 0) {
      console.log(`  [${direction}] nothing planned (${payments.length} eligible payment(s), ${documents.length} open document(s))`);
      continue;
    }
    for (const item of plan) {
      console.log(`  [${direction}] payment ${item.journalLineId} -> ${item.targetSourceType} ${item.targetSourceId}: Rs. ${item.amount.toLocaleString()}`);
    }
  }
}

async function runVerboseDiagnostic(party: { id: string; partyName: string; account: { id: string } }) {
  console.log(`\n\n=== VERBOSE DIAGNOSTIC: ${party.partyName} (read-only) ===`);

  const openingBreakdown = await getOpeningBalanceBreakdown(prisma, party.id);
  if (openingBreakdown) {
    console.log(
      `\nOpening Balance - raw Rs. ${openingBreakdown.rawTotalDue.toLocaleString()}` +
        ` (tagged entry Rs. ${openingBreakdown.taggedAmount.toLocaleString()}, untagged manual JE Rs. ${openingBreakdown.untaggedAmount.toLocaleString()}),` +
        ` account's current net balance Rs. ${openingBreakdown.currentNetBalance.toLocaleString()},` +
        ` capped remaining = Rs. ${openingBreakdown.totalDue.toLocaleString()}${openingBreakdown.direction ? ` (${openingBreakdown.direction})` : " (CLEARED - fully offset by other ledger activity)"}`
    );
  } else {
    console.log("\nOpening Balance - none on record for this party.");
  }

  await reportLedgerLines(party.account.id);
  await reportCandidateDocuments(party.account.id);
  await reportPlannedAllocations(party.account.id);
}

// ============================================================
// PASS 2 - FIFO preview/apply.
// ============================================================

async function runFifoPass(actorId: string | null) {
  console.log(`\n=== PASS 2 - FIFO ${apply ? "APPLY" : "dry-run"} ===\n`);

  const parties = await prisma.party.findMany({
    where: {
      isActive: true,
      account: { isActive: true },
      ...(requestedPartyName ? { partyName: { contains: requestedPartyName, mode: "insensitive" } } : {}),
    },
    select: { id: true, partyName: true, account: { select: { id: true } } },
    orderBy: { partyName: "asc" },
  });

  if (requestedPartyName && parties.length === 0) {
    console.log(`No active party matching "${requestedPartyName}" found.`);
    return;
  }

  let mismatchCount = 0;
  let okCount = 0;
  let invariantViolationCount = 0;

  for (const party of parties) {
    if (!party.account) continue;

    const openingBreakdown = await getOpeningBalanceBreakdown(prisma, party.id);

    // Compute every direction's own report BEFORE printing anything -
    // a party with no Opening Balance on record still needs its OWN
    // header line printed whenever it has real preview output, or
    // that output is silently "headerless" and visually absorbed into
    // whichever OTHER party's own header happened to print last (the
    // exact bug this caused on production: Zaheer Maluk Godam
    // Karachi's real 1-doc-cleared/Rs. 25,500-advance result had no
    // Opening Balance of its own, so it printed with no header at all
    // and was misread as belonging to "Zafar Niazi Cargo Karachi" -
    // the previous party that DID have a header - even though that
    // party's own isolated --verbose run correctly showed nothing).
    const directionReports: { direction: AllocationDirection; preview: PartyFifoReport }[] = [];
    for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
      const preview = await previewFifoForParty(party.account.id, direction);
      if (!preview) continue;
      directionReports.push({ direction, preview });
    }

    if (!openingBreakdown && directionReports.length === 0) continue;

    console.log(`${party.partyName}:`);

    if (openingBreakdown) {
      console.log(
        `  Opening Balance raw Rs. ${openingBreakdown.rawTotalDue.toLocaleString()}` +
          ` -> capped remaining Rs. ${openingBreakdown.totalDue.toLocaleString()}${openingBreakdown.direction ? ` (${openingBreakdown.direction})` : " (CLEARED)"}` +
          ` [current net balance Rs. ${openingBreakdown.currentNetBalance.toLocaleString()}, tagged Rs. ${openingBreakdown.taggedAmount.toLocaleString()}, untagged Rs. ${openingBreakdown.untaggedAmount.toLocaleString()}]`
      );
    } else {
      console.log(`  (no Opening Balance on record)`);
    }

    for (const { direction, preview } of directionReports) {
      if (preview.noFifoDocuments) {
        console.log(`  [${direction}] N/A - no FIFO documents`);
      } else {
        console.log(
          `  [${direction}] docs fully cleared: ${preview.docsCleared}, partially covered: ${preview.docsPartial}, advance left unallocated: Rs. ${preview.advanceLeft.toLocaleString()}`
        );

        if (preview.invariantViolation) {
          invariantViolationCount++;
          console.log(
            `  [${direction}] *** FIFO INVARIANT VIOLATION *** Rs. ${preview.invariantViolation.totalAdvance} left as advance while ` +
              `${preview.invariantViolation.openDocumentsWithCapacity.length} document(s) still have open capacity: ` +
              preview.invariantViolation.openDocumentsWithCapacity.map((d) => `${d.targetSourceType} ${d.targetSourceId} (Rs. ${d.remaining})`).join(", ")
          );
        }
      }

      if (apply && actorId && !preview.noFifoDocuments) {
        await prisma.$transaction((tx) => rerunFifoForParty(tx, party.account!.id, direction, actorId));
      }
    }

    // ONE combined reconciliation per party (both directions together)
    // - see checkPartyReconciliation's own doc comment on why a
    // per-direction check is unsound for an account carrying both a
    // receivable and a payable at once.
    // Only check reconciliation when this party is actually within
    // FIFO's own conceptual scope at all (an Opening Balance, or at
    // least one eligible payment for some direction) - a party with
    // NEITHER (e.g. a fuel pump whose only activity is Trip expense
    // postings on OTHER accounts entirely) is correctly already
    // reported as out of scope elsewhere ("N/A - no FIFO documents"
    // or no header at all) and checking it here would just manufacture
    // noise from activity this feature was never meant to explain.
    const nonSkippedReports = directionReports.filter((r) => !r.preview.noFifoDocuments);
    if (openingBreakdown || nonSkippedReports.length > 0) {
      const reconciliation = await checkPartyReconciliation(party.account.id, nonSkippedReports);
      if (reconciliation.isMatch) {
        okCount++;
        console.log(`  reconciliation: OK (expected ${reconciliation.expectedSignedNet} vs adjusted actual ${reconciliation.adjustedActualSignedNet})`);
      } else {
        mismatchCount++;
        console.log(
          `  reconciliation: MISMATCH diff=${reconciliation.diff} ` +
            `(expected ${reconciliation.expectedSignedNet} vs adjusted actual ${reconciliation.adjustedActualSignedNet})`
        );
        if (verbose) {
          printUnexplainedLedgerLines(reconciliation.unexplainedLines);
        }
      }
    }

    if (verbose) {
      await runVerboseDiagnostic({ id: party.id, partyName: party.partyName, account: party.account });
    }
  }

  console.log(`\n=== RECONCILIATION TOTALS: ${okCount} OK, ${mismatchCount} MISMATCH, ${invariantViolationCount} invariant violation(s) ===`);
}

async function main() {
  if (!verbose) {
    await reportLegacyBackfillStatus();
  }

  let actorId: string | null = null;
  if (apply) {
    if (verbose) {
      console.log("--verbose is read-only diagnostics - ignoring --apply for this run.");
    } else {
      const actorUser = await resolveActor();
      actorId = actorUser.id;
      console.log(`Applying, attributed to user "${actorUser.username}".`);
    }
  }

  await runFifoPass(actorId);

  if (!apply || verbose) {
    console.log("\nDry-run only - no writes made. Re-run with --apply (without --verbose) to commit.\n");
  } else {
    console.log("\nFIFO backfill applied.\n");
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
