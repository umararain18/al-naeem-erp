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
//   writing, plus each party's own Opening Balance figure (capped to
//   the account's CURRENT live balance - see
//   capOpeningBalanceByCurrentBalance in lib/payment-allocation.ts)
//   and its source breakdown (official OPENING_BALANCE-tagged entry
//   vs. an untagged manual JE contra-ing the Opening Balance Equity
//   account). --apply commits it by calling the SAME rerunFifoForParty
//   the live app uses for every other trigger - never a second,
//   parallel write path.
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
}

async function previewFifoForParty(accountId: string, direction: AllocationDirection): Promise<PartyFifoReport | null> {
  const payments = await listEligibleFifoPayments(prisma, accountId, direction);
  if (payments.length === 0) return null;

  const documents = await getPartyDocumentStates(prisma, accountId, direction, { onlyWithRemainingBalance: true });
  if (documents.length === 0) {
    return { direction, noFifoDocuments: true, docsCleared: 0, docsPartial: 0, advanceLeft: 0 };
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

  const plan = computeFifoAllocationPlan(sortFifoPayments(candidatePayments), sortFifoDocuments(documents));

  const allocatedByDoc = new Map<string, number>();
  for (const item of plan) {
    const key = `${item.targetSourceType}:${item.targetSourceId}`;
    allocatedByDoc.set(key, Math.round(((allocatedByDoc.get(key) || 0) + item.amount) * 100) / 100);
  }

  let docsCleared = 0;
  let docsPartial = 0;
  for (const doc of documents) {
    const allocated = allocatedByDoc.get(`${doc.targetSourceType}:${doc.targetSourceId}`) || 0;
    if (allocated <= 0.009) continue;
    if (allocated >= doc.remainingAllocatable - 0.009) docsCleared++;
    else docsPartial++;
  }

  const totalPaymentAmount = candidatePayments.reduce((s, p) => s + p.remainingAmount, 0);
  const totalAllocated = plan.reduce((s, p) => s + p.amount, 0);
  const advanceLeft = Math.round((totalPaymentAmount - totalAllocated) * 100) / 100;

  return { direction, noFifoDocuments: false, docsCleared, docsPartial, advanceLeft };
}

function reasonFromError(error: unknown): string {
  if (error instanceof AllocationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
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
    case "OPENING_BALANCE":
      return "always 0 by definition - the opening figure is reduced only via FIFO allocation and the current-live-balance cap, never via a tagged Daily Posting line";
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
