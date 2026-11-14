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
//   npx tsx scripts/backfill-fifo-allocation.ts --apply --skip-mismatch      (writes ONLY for parties whose combined reconciliation is OK; every
//                                                                              party with a MISMATCH is left entirely untouched - neither direction
//                                                                              applied - and printed in a "skipped" list at the end, by diff)

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
  computePartyFifoPreview,
  checkPartyReconciliation,
  type PartyFifoPreview,
  type ReconciliationResult,
  type LedgerLineClassification,
} from "../lib/party-payment-fifo";

const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const verbose = process.argv.includes("--verbose");
const skipMismatch = process.argv.includes("--skip-mismatch");
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

// previewFifoForParty is now just computePartyFifoPreview from
// lib/party-payment-fifo.ts - the SAME function rerunFifoForParty
// itself plans from (and, in turn, the same one checkPartyReconciliation
// reads) - see that function's own doc comment on why this used to be
// a separately re-implemented pipeline here.
const previewFifoForParty = (accountId: string, direction: AllocationDirection) => computePartyFifoPreview(prisma, accountId, direction);

function reasonFromError(error: unknown): string {
  if (error instanceof AllocationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

// checkPartyReconciliation itself now lives in lib/party-payment-fifo.ts,
// shared with rerunFifoForParty's own live reconciliation warning and
// scripts/report-document-ledger-drift.ts - see its own doc comment
// there for the full reconciliation design (why it is ONE combined
// check per party across both directions, and the 5-bucket line
// classification).

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
  const skippedParties: { partyName: string; diff: number }[] = [];

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
    const directionReports: { direction: AllocationDirection; preview: PartyFifoPreview }[] = [];
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
    //
    // Computed BEFORE the apply step below (not after) so --skip-mismatch
    // can gate on it - reconciliation is inherently a per-PARTY (both
    // directions combined) verdict, never per-direction, so a MISMATCH
    // skips applying BOTH of this party's directions, not just one.
    const nonSkippedReports = directionReports.filter((r) => !r.preview.noFifoDocuments);
    let reconciliation: ReconciliationResult | null = null;
    if (openingBreakdown || nonSkippedReports.length > 0) {
      reconciliation = await checkPartyReconciliation(prisma, party.account.id, nonSkippedReports);
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

    const skipThisParty = skipMismatch && reconciliation != null && !reconciliation.isMatch;
    if (skipThisParty) {
      skippedParties.push({ partyName: party.partyName, diff: reconciliation!.diff });
      console.log(`  --skip-mismatch: NOT applying either direction for this party (reconciliation MISMATCH).`);
    } else if (apply && actorId) {
      for (const { direction, preview } of directionReports) {
        if (!preview.noFifoDocuments) {
          await prisma.$transaction((tx) => rerunFifoForParty(tx, party.account!.id, direction, actorId));
        }
      }
    }

    if (verbose) {
      await runVerboseDiagnostic({ id: party.id, partyName: party.partyName, account: party.account });
    }
  }

  console.log(`\n=== RECONCILIATION TOTALS: ${okCount} OK, ${mismatchCount} MISMATCH, ${invariantViolationCount} invariant violation(s) ===`);

  if (skipMismatch) {
    console.log(`\n=== --skip-mismatch: ${skippedParties.length} part${skippedParties.length === 1 ? "y" : "ies"} skipped (reconciliation MISMATCH, not applied) ===`);
    for (const s of skippedParties) {
      console.log(`  - ${s.partyName} (diff=${s.diff})`);
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
