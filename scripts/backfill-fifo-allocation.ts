// AUTO FIFO ALLOCATION - BACKFILL
//
// Mirrors scripts/redate-dispatch-booking-entries.ts's own
// conventions exactly (dry-run by default, --apply --user=<username>
// to write, attributed via the same actor resolution).
//
// Two passes, run together every time:
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
//   writing, plus each party's own Opening Balance amount and its
//   source breakdown (official OPENING_BALANCE-tagged entry vs. an
//   untagged manual JE contra-ing the Opening Balance Equity
//   account). --apply commits it by calling the SAME rerunFifoForParty
//   the live app uses for every other trigger - never a second,
//   parallel write path.
//
// A payment already stamped allocationMode: "MANUAL" is skipped by
// listEligibleFifoPayments() itself (same as every other FIFO
// rebuild) - never touched by this script either.
//
// Usage:
//   npx tsx scripts/backfill-fifo-allocation.ts                    (dry-run)
//   npx tsx scripts/backfill-fifo-allocation.ts --apply             (writes)
//   npx tsx scripts/backfill-fifo-allocation.ts --apply --user=umar (attribute to a specific username; defaults to the first active SUPER_ADMIN)

import { PrismaClient } from "@prisma/client";
import {
  getOpeningBalanceBreakdown,
  getPartyDocumentStates,
  getAllocatedAmountForPayment,
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
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

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
  partyName: string;
  direction: AllocationDirection;
  docsCleared: number;
  docsPartial: number;
  advanceLeft: number;
}

async function previewFifoForParty(
  accountId: string,
  partyName: string,
  direction: AllocationDirection
): Promise<PartyFifoReport | null> {
  const payments = await listEligibleFifoPayments(prisma, accountId, direction);
  if (payments.length === 0) return null;

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

  return { partyName, direction, docsCleared, docsPartial, advanceLeft };
}

async function runFifoPass(actorId: string | null) {
  console.log(`\n=== PASS 2 - FIFO ${apply ? "APPLY" : "dry-run"} ===\n`);

  const parties = await prisma.party.findMany({
    where: { isActive: true, account: { isActive: true } },
    select: { id: true, partyName: true, account: { select: { id: true } } },
    orderBy: { partyName: "asc" },
  });

  for (const party of parties) {
    if (!party.account) continue;

    const openingBreakdown = await getOpeningBalanceBreakdown(prisma, party.id);
    if (openingBreakdown && openingBreakdown.direction) {
      console.log(
        `${party.partyName}: Opening Balance Rs. ${openingBreakdown.totalDue.toLocaleString()} (${openingBreakdown.direction})` +
          ` - tagged entry Rs. ${openingBreakdown.taggedAmount.toLocaleString()}, untagged manual JE Rs. ${openingBreakdown.untaggedAmount.toLocaleString()}`
      );
    }

    for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
      const preview = await previewFifoForParty(party.account.id, party.partyName, direction);
      if (!preview) continue;

      console.log(
        `  [${direction}] docs fully cleared: ${preview.docsCleared}, partially covered: ${preview.docsPartial}, advance left unallocated: Rs. ${preview.advanceLeft.toLocaleString()}`
      );

      if (apply && actorId) {
        await prisma.$transaction((tx) => rerunFifoForParty(tx, party.account!.id, direction, actorId));
      }
    }
  }
}

async function main() {
  await reportLegacyBackfillStatus();

  let actorId: string | null = null;
  if (apply) {
    const actorUser = await resolveActor();
    actorId = actorUser.id;
    console.log(`Applying, attributed to user "${actorUser.username}".`);
  }

  await runFifoPass(actorId);

  if (!apply) {
    console.log("\nDry-run only - no writes made. Re-run with --apply to commit.\n");
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
