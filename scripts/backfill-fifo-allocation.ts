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
}

async function previewFifoForParty(accountId: string, direction: AllocationDirection): Promise<PartyFifoReport | null> {
  const payments = await listEligibleFifoPayments(prisma, accountId, direction);
  if (payments.length === 0) return null;

  const documents = await getPartyDocumentStates(prisma, accountId, direction, { onlyWithRemainingBalance: true });
  if (documents.length === 0) {
    return { direction, noFifoDocuments: true, docsCleared: 0, docsPartial: 0, advanceLeft: 0, documents: [], plan: [] };
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
  // something. The dry-run preview checks it too, read-only, so a
  // violation surfaces here before anyone runs --apply.
  const violation = checkNoAdvanceWithOpenCapacity(sortedPayments, sortedDocuments, plan);
  if (violation) {
    console.log(
      `  [${direction}] *** FIFO INVARIANT VIOLATION *** Rs. ${violation.totalAdvance} left as advance while ` +
        `${violation.openDocumentsWithCapacity.length} document(s) still have open capacity: ` +
        violation.openDocumentsWithCapacity.map((d) => `${d.targetSourceType} ${d.targetSourceId} (Rs. ${d.remaining})`).join(", ")
    );
  }

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

  return { direction, noFifoDocuments: false, docsCleared, docsPartial, advanceLeft, documents: sortedDocuments, plan };
}

function reasonFromError(error: unknown): string {
  if (error instanceof AllocationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

// ============================================================
// B3 - RECONCILIATION: opening_remaining + sum(other doc remaining)
// - advance  vs  the account's own current net balance.
//
// Every document's own remainingAllocatable (including Opening
// Balance, now RAW per the B1/B2 fix) already reflects the FIFO
// ceiling minus what FIFO itself has attributed. If the plan's own
// bookkeeping is complete and correct, "what's left open across every
// document, minus any genuine advance sitting unapplied" must equal
// the account's own real ledger balance - any gap means SOME ledger
// activity (an ambiguous/bundled Daily Posting line, a direct JE, a
// Settlement entry, etc.) is moving the account's balance without
// being accounted for by either a recognized open document or a
// FIFO-tracked payment. --verbose lists exactly which lines those are
// for any mismatch.
// ============================================================

async function computeCurrentNetBalanceInDirection(accountId: string, direction: AllocationDirection): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { accountId, journalEntry: { isDeleted: false } },
    select: { debit: true, credit: true },
  });
  const net = lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
  const magnitude = direction === "RECEIVABLE" ? Math.max(0, net) : Math.max(0, -net);
  return Math.round(magnitude * 100) / 100;
}

interface ReconciliationResult {
  lhs: number;
  currentNetBalance: number;
  diff: number;
  isMatch: boolean;
}

async function checkReconciliation(accountId: string, direction: AllocationDirection, preview: PartyFifoReport): Promise<ReconciliationResult> {
  const allocatedByDoc = new Map<string, number>();
  for (const item of preview.plan) {
    const key = `${item.targetSourceType}:${item.targetSourceId}`;
    allocatedByDoc.set(key, Math.round(((allocatedByDoc.get(key) || 0) + item.amount) * 100) / 100);
  }

  const totalDocsRemainingAfterPlan = preview.documents.reduce((s, doc) => {
    const allocated = allocatedByDoc.get(`${doc.targetSourceType}:${doc.targetSourceId}`) || 0;
    return s + Math.max(0, Math.round((doc.remainingAllocatable - allocated) * 100) / 100);
  }, 0);

  const lhs = Math.round((totalDocsRemainingAfterPlan - preview.advanceLeft) * 100) / 100;
  const currentNetBalance = await computeCurrentNetBalanceInDirection(accountId, direction);
  const diff = Math.round((lhs - currentNetBalance) * 100) / 100;

  return { lhs, currentNetBalance, diff, isMatch: Math.abs(diff) <= 0.01 };
}

/**
 * --verbose-only, for a MISMATCH: lists every live JournalLine on the
 * account that is NOT accounted for by either (a) the Opening
 * Balance's own qualifying lines, (b) a tagged line belonging to one
 * of this party's own recognized open/candidate documents, or (c) a
 * FIFO-eligible payment line - i.e. exactly the ledger activity the
 * reconciliation diff is attributing the gap to.
 */
async function reportUnexplainedLedgerLines(accountId: string, direction: AllocationDirection, preview: PartyFifoReport) {
  const openingEquityAccount = await prisma.account.findFirst({ where: { accountCode: "OPENING-BALANCE" }, select: { id: true } });

  const candidateRefs = await getPartyDocumentCandidateRefs(prisma, accountId, direction);
  const explainedSourceKeys = new Set<string>();
  for (const ref of candidateRefs) {
    if (ref.targetSourceType === "PRIVATE_PHONCH_PAYABLE" || ref.targetSourceType === "PRIVATE_PHONCH_RECOVERY") {
      explainedSourceKeys.add(`PRIVATE_PHONCH:${ref.targetSourceId.split(":")[0]}`);
    } else if (ref.targetSourceType !== "OPENING_BALANCE") {
      explainedSourceKeys.add(`${ref.targetSourceType}:${ref.targetSourceId}`);
    }
  }

  const explainedPaymentLineIds = new Set(preview.plan.map((p) => p.journalLineId));
  const eligiblePayments = await listEligibleFifoPayments(prisma, accountId, direction);
  for (const p of eligiblePayments) explainedPaymentLineIds.add(p.journalLineId);

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

  const unexplained = lines.filter((line) => {
    const isOfficiallyTaggedOpening = line.journalEntry.referenceType === "OPENING_BALANCE";
    const hasOpeningEquityContra = openingEquityAccount != null && line.journalEntry.lines.some((l) => l.accountId === openingEquityAccount.id);
    if (isOfficiallyTaggedOpening || hasOpeningEquityContra) return false;

    if (line.sourceType && line.sourceId && explainedSourceKeys.has(`${line.sourceType}:${line.sourceId}`)) return false;
    if (explainedPaymentLineIds.has(line.id)) return false;

    return true;
  });

  if (unexplained.length === 0) {
    console.log(`      no unexplained lines found - the gap may be from a document resolution that failed silently; re-check with --verbose section (2) above.`);
    return;
  }

  console.log(`      unexplained ledger line(s) (contribute to the account's balance but match no recognized open document or FIFO-eligible payment):`);
  for (const line of unexplained) {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const drCr = debit > 0 ? `Dr ${debit}` : `Cr ${credit}`;
    const date = line.journalEntry.entryDate.toISOString().slice(0, 10);
    console.log(
      `        ${date}  entry=${line.journalEntry.id}  ${drCr}  sourceType=${line.sourceType ?? "-"}  sourceId=${line.sourceId ?? "-"}  referenceType=${line.journalEntry.referenceType ?? "-"}  referenceId=${line.journalEntry.referenceId ?? "-"}`
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
    const base = `  ${date}  entry=${line.journalEntry.id}  ${drCr}  sourceType=${line.sourceType ?? "-"}  referenceType=${line.journalEntry.referenceType ?? "-"}  referenceId=${line.journalEntry.referenceId ?? "-"}  allocationMode=${line.allocationMode ?? "-"}`;

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

  for (const party of parties) {
    if (!party.account) continue;

    const openingBreakdown = await getOpeningBalanceBreakdown(prisma, party.id);
    if (openingBreakdown) {
      console.log(
        `${party.partyName}: Opening Balance raw Rs. ${openingBreakdown.rawTotalDue.toLocaleString()}` +
          ` -> capped remaining Rs. ${openingBreakdown.totalDue.toLocaleString()}${openingBreakdown.direction ? ` (${openingBreakdown.direction})` : " (CLEARED)"}` +
          ` [current net balance Rs. ${openingBreakdown.currentNetBalance.toLocaleString()}, tagged Rs. ${openingBreakdown.taggedAmount.toLocaleString()}, untagged Rs. ${openingBreakdown.untaggedAmount.toLocaleString()}]`
      );
    }

    for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
      const preview = await previewFifoForParty(party.account.id, direction);
      if (!preview) continue;

      if (preview.noFifoDocuments) {
        console.log(`  [${direction}] N/A - no FIFO documents`);
      } else {
        console.log(
          `  [${direction}] docs fully cleared: ${preview.docsCleared}, partially covered: ${preview.docsPartial}, advance left unallocated: Rs. ${preview.advanceLeft.toLocaleString()}`
        );

        const reconciliation = await checkReconciliation(party.account.id, direction, preview);
        if (reconciliation.isMatch) {
          console.log(`  [${direction}] reconciliation: OK (${reconciliation.lhs} vs current net balance ${reconciliation.currentNetBalance})`);
        } else {
          console.log(
            `  [${direction}] reconciliation: MISMATCH diff=${reconciliation.diff} ` +
              `(opening_remaining + sum(doc remaining) - advance = ${reconciliation.lhs}, current net balance = ${reconciliation.currentNetBalance})`
          );
          if (verbose) {
            await reportUnexplainedLedgerLines(party.account.id, direction, preview);
          }
        }
      }

      if (apply && actorId && !preview.noFifoDocuments) {
        await prisma.$transaction((tx) => rerunFifoForParty(tx, party.account!.id, direction, actorId));
      }
    }

    if (verbose) {
      await runVerboseDiagnostic({ id: party.id, partyName: party.partyName, account: party.account });
    }
  }
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
