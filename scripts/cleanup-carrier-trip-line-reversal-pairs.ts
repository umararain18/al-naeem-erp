// Retires every historical CARRIER_TRIP_LINE / CARRIER_TRIP_LINE_REVERSAL
// pair (the OLD "reverse + repost" edit/delete mechanism, replaced by
// lib/carrier-trip.ts's editCarrierTripLine (true in-place mutation)
// and deleteCarrierTripLine (soft-delete into the accounting Bin)) by
// moving BOTH entries of each pair to the Bin (JournalEntry.isDeleted
// = true) - on ANY account (Carrier Profit, Trip in Progress, Driver
// Cash, vendor payables, office accounts, etc.), never just one.
//
// WHY: the pair always nets to exactly Rs. 0 on every account it
// touches (the reversal is a literal debit/credit-flipped mirror of
// the original's own lines - see the old reverseCarrierTripLine's own
// doc comment, since removed), so moving both to the Bin changes NO
// account's overall as-of-now balance. But a reversal dated
// differently from its own original (a bug fixed earlier this project
// - see scripts/dry-run-carrier-trip-reversal-dates.ts) corrupts any
// DATE-SCOPED calculation whose window falls between the two dates -
// most visibly Trip Previous Balance / Remaining With Driver
// (lib/carrier-trip.ts's getTripOpeningBalance / getTripCashBook),
// which sum Driver Cash strictly before/through a date boundary. Once
// both entries are Bin'd (excluded from every ledger/balance/P&L
// query), the line simply never existed from the ledger's point of
// view - exactly the correct state for something that was edited away
// - closing that gap for good.
//
// A pair missing its other half (reversal not found live, or original
// already isDeleted) is left COMPLETELY untouched and reported loudly -
// never moved one-sided. CarrierTripLine rows are NOT touched here -
// the dead original's own CarrierTripLine.isDeleted was already true
// from when it was edited/deleted years ago; this script only ever
// changes JournalEntry.isDeleted.
//
// DEFAULT (no flag): DRY-RUN. Every write below runs inside ONE
// database transaction that is always rolled back in dry-run mode -
// so the "after" figures (per-account balances, and the Previous/
// Remaining consistency check) are computed by the SAME functions
// production uses, against the REAL post-cleanup state, without
// anything actually being written. Safe to run against production.
//
// --apply: commits the transaction (after taking a database backup).
// Requires --user=<username> to attribute the AuditLog rows (defaults
// to the first active SUPER_ADMIN).
//
// Usage:
//   npx tsx scripts/cleanup-carrier-trip-line-reversal-pairs.ts                       (dry-run)
//   npx tsx scripts/cleanup-carrier-trip-line-reversal-pairs.ts --apply --user=umar     (writes)

import { PrismaClient, Prisma } from "@prisma/client";
import { getTripCashBook } from "../lib/carrier-trip";
import { auditDelete, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

async function resolveActor(tx: Prisma.TransactionClient | PrismaClient) {
  const user = requestedUsername
    ? await tx.user.findFirst({ where: { username: requestedUsername, isActive: true } })
    : await tx.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true }, orderBy: { createdAt: "asc" } });
  if (!user) {
    throw new Error(requestedUsername ? `No active user found with username "${requestedUsername}".` : "No active SUPER_ADMIN user found - pass --user=<username> explicitly.");
  }
  return user;
}

type Pair = {
  originalId: string;
  reversalId: string;
  originalDate: Date;
  reversalDate: Date;
  tripId: string;
  description: string;
  // accountId -> { originalDelta, reversalDelta } (debit - credit), for
  // the per-account / per-month report below.
  linesByAccount: Map<string, { originalDelta: number; originalMonth: string; reversalDelta: number; reversalMonth: string }>;
};

async function findPairs(): Promise<{ pairs: Pair[]; anomalies: string[] }> {
  const reversals = await prisma.journalEntry.findMany({
    where: { referenceType: "CARRIER_TRIP_LINE_REVERSAL", isDeleted: false, reversesEntryId: { not: null } },
    include: { lines: true },
    orderBy: { entryDate: "asc" },
  });

  const pairs: Pair[] = [];
  const anomalies: string[] = [];

  for (const reversal of reversals) {
    const original = await prisma.journalEntry.findUnique({
      where: { id: reversal.reversesEntryId! },
      include: { lines: true },
    });
    if (!original) {
      anomalies.push(`Reversal ${reversal.id} (dated ${reversal.entryDate.toISOString().slice(0, 10)}) points at a missing original - SKIPPED.`);
      continue;
    }
    if (original.isDeleted) {
      anomalies.push(`Reversal ${reversal.id}'s own original ${original.id} is already Bin'd (isDeleted) - SKIPPED (nothing to do, or needs manual review).`);
      continue;
    }
    if (original.referenceType !== "CARRIER_TRIP_LINE") {
      anomalies.push(`Reversal ${reversal.id}'s own original ${original.id} has referenceType "${original.referenceType}", not CARRIER_TRIP_LINE - SKIPPED (not this script's target).`);
      continue;
    }

    // Verify the pair nets to EXACTLY zero on every account it
    // touches - defensive; by construction it always should (the old
    // reverseCarrierTripLine posted the literal debit/credit-flipped
    // mirror of the original's own lines).
    const byAccount = new Map<string, { originalDelta: number; originalMonth: string; reversalDelta: number; reversalMonth: string }>();
    for (const l of original.lines) {
      const d = byAccount.get(l.accountId) || { originalDelta: 0, originalMonth: monthKey(original.entryDate), reversalDelta: 0, reversalMonth: monthKey(reversal.entryDate) };
      d.originalDelta = round2(d.originalDelta + Number(l.debit) - Number(l.credit));
      byAccount.set(l.accountId, d);
    }
    for (const l of reversal.lines) {
      const d = byAccount.get(l.accountId) || { originalDelta: 0, originalMonth: monthKey(original.entryDate), reversalDelta: 0, reversalMonth: monthKey(reversal.entryDate) };
      d.reversalDelta = round2(d.reversalDelta + Number(l.debit) - Number(l.credit));
      byAccount.set(l.accountId, d);
    }
    let allZero = true;
    for (const [, d] of byAccount) {
      if (Math.abs(round2(d.originalDelta + d.reversalDelta)) > 0.009) allZero = false;
    }
    if (!allZero) {
      anomalies.push(`Pair ${original.id}/${reversal.id} does NOT net to zero on every account (one side may have been hand-edited since) - SKIPPED, needs manual review.`);
      continue;
    }

    pairs.push({
      originalId: original.id,
      reversalId: reversal.id,
      originalDate: original.entryDate,
      reversalDate: reversal.entryDate,
      tripId: (original.referenceId as string) || (reversal.referenceId as string) || "",
      description: original.description || reversal.description || "",
      linesByAccount: byAccount,
    });
  }

  return { pairs, anomalies };
}

/** For every CARRIER with 2+ trips (ordered by dateFrom), checks
 * Remaining(trip N) == Previous Balance(trip N+1) for every
 * consecutive pair - reusing getTripCashBook exactly as the Trip page
 * itself does, so this is never a second, independently-maintained
 * calculation. */
async function checkPreviousRemainingConsistency(tx: Prisma.TransactionClient | PrismaClient) {
  const carriers = await tx.ownCarrier.findMany({ where: { isDeleted: false }, select: { id: true, carrierNumber: true } });
  const mismatches: { carrierNumber: string; tripNNo: string; tripNPlus1No: string; remaining: number; previous: number; diff: number }[] = [];

  for (const carrier of carriers) {
    const trips = await tx.carrierTrip.findMany({
      where: { carrierId: carrier.id, isDeleted: false },
      orderBy: [{ dateFrom: "asc" }, { createdAt: "asc" }],
      select: { id: true, tripNo: true },
    });
    for (let i = 0; i < trips.length - 1; i++) {
      const tripN = trips[i];
      const tripNPlus1 = trips[i + 1];
      const [cashBookN, cashBookNPlus1] = await Promise.all([getTripCashBook(tx, tripN.id), getTripCashBook(tx, tripNPlus1.id)]);
      const diff = round2(cashBookNPlus1.openingBalance - cashBookN.closingBalance);
      if (Math.abs(diff) > 0.009) {
        mismatches.push({
          carrierNumber: carrier.carrierNumber,
          tripNNo: tripN.tripNo,
          tripNPlus1No: tripNPlus1.tripNo,
          remaining: cashBookN.closingBalance,
          previous: cashBookNPlus1.openingBalance,
          diff,
        });
      }
    }
  }
  return mismatches;
}

async function accountBalance(tx: Prisma.TransactionClient | PrismaClient, accountId: string): Promise<number> {
  const agg = await tx.journalLine.aggregate({
    where: { accountId, journalEntry: { isDeleted: false } },
    _sum: { debit: true, credit: true },
  });
  return round2(Number(agg._sum.debit || 0) - Number(agg._sum.credit || 0));
}

class DryRunRollback extends Error {}

async function main() {
  const { pairs, anomalies } = await findPairs();

  console.log(`Found ${pairs.length} reversal pair(s) eligible for cleanup, ${anomalies.length} anomal(y/ies) skipped.\n`);
  if (anomalies.length > 0) {
    console.log("=== ANOMALIES (skipped, untouched) ===");
    for (const a of anomalies) console.log(`  - ${a}`);
    console.log("");
  }
  if (pairs.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  // Per-account / per-month report, and the set of accounts touched.
  const accountIds = new Set<string>();
  const perAccountMonth = new Map<string, { account: Prisma.AccountGetPayload<{}> | null; month: string; delta: number }>();
  for (const pair of pairs) {
    for (const [accountId, d] of pair.linesByAccount) {
      accountIds.add(accountId);
      const originalKey = `${accountId}|${d.originalMonth}`;
      const existingOriginal = perAccountMonth.get(originalKey) || { account: null, month: d.originalMonth, delta: 0 };
      existingOriginal.delta = round2(existingOriginal.delta - d.originalDelta); // removing the original's own contribution from that month
      perAccountMonth.set(originalKey, existingOriginal);

      const reversalKey = `${accountId}|${d.reversalMonth}`;
      const existingReversal = perAccountMonth.get(reversalKey) || { account: null, month: d.reversalMonth, delta: 0 };
      existingReversal.delta = round2(existingReversal.delta - d.reversalDelta);
      perAccountMonth.set(reversalKey, existingReversal);
    }
  }
  const accounts = await prisma.account.findMany({ where: { id: { in: [...accountIds] } }, select: { id: true, accountName: true } });
  const accountNameById = new Map(accounts.map((a) => [a.id, a.accountName]));

  console.log("=== PAIRS TO RETIRE (move both entries to Bin) ===");
  for (const pair of pairs) {
    console.log(`  Original ${pair.originalId} (${pair.originalDate.toISOString().slice(0, 10)}) <-> Reversal ${pair.reversalId} (${pair.reversalDate.toISOString().slice(0, 10)}) - "${pair.description}"`);
  }

  console.log("\n=== PER-MONTH EFFECT (period total changes even though overall balance doesn't) ===");
  const sortedMonthRows = [...perAccountMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, row] of sortedMonthRows) {
    const accountId = key.split("|")[0];
    if (Math.abs(row.delta) < 0.009) continue;
    console.log(`  ${accountNameById.get(accountId) || accountId} / ${row.month}: period total changes by ${row.delta >= 0 ? "+" : ""}${row.delta.toLocaleString()}`);
  }

  console.log("\n=== PER-ACCOUNT BEFORE -> AFTER (overall, as-of-now - must be UNCHANGED) ===");
  const beforeBalances = new Map<string, number>();
  for (const accountId of accountIds) {
    beforeBalances.set(accountId, await accountBalance(prisma, accountId));
  }

  console.log("\nChecking Previous Balance / Remaining consistency BEFORE cleanup...");
  const mismatchesBefore = await checkPreviousRemainingConsistency(prisma);
  if (mismatchesBefore.length === 0) {
    console.log("  No mismatches found before cleanup either (this cleanup may not be the cause for any carrier currently in this database).");
  } else {
    console.log(`  ${mismatchesBefore.length} mismatch(es) found BEFORE cleanup:`);
    for (const m of mismatchesBefore) {
      console.log(`    ${m.carrierNumber}: Trip ${m.tripNNo} Remaining (${m.remaining.toLocaleString()}) != Trip ${m.tripNPlus1No} Previous Balance (${m.previous.toLocaleString()}) - diff ${m.diff.toLocaleString()}`);
    }
  }

  let afterBalances = new Map<string, number>();
  let mismatchesAfter: Awaited<ReturnType<typeof checkPreviousRemainingConsistency>> = [];
  let actorUsername = "";

  try {
    await prisma.$transaction(async (tx) => {
      let actor;
      if (apply) {
        const actorUser = await resolveActor(tx);
        actorUsername = actorUser.username;
        actor = actorFromUser({ userId: actorUser.id, username: actorUser.username, role: actorUser.role });
      }
      const deletedAt = new Date();
      for (const pair of pairs) {
        await tx.journalEntry.update({ where: { id: pair.originalId }, data: { isDeleted: true, deletedAt, deletedById: apply ? actor!.userId : undefined } });
        await tx.journalEntry.update({ where: { id: pair.reversalId }, data: { isDeleted: true, deletedAt, deletedById: apply ? actor!.userId : undefined } });
        if (apply && actor) {
          await auditDelete(tx, {
            actor,
            module: "CARRIER_TRIP_LINE",
            entityType: "JournalEntry",
            entityId: pair.originalId,
            description: `Retired historical reversal pair (original ${pair.originalId} / reversal ${pair.reversalId}, net Rs. 0) - moved both to Bin via scripts/cleanup-carrier-trip-line-reversal-pairs.ts`,
            oldValues: { originalIsDeleted: false, reversalIsDeleted: false },
            newValues: { originalIsDeleted: true, reversalIsDeleted: true },
          });
        }
      }

      for (const accountId of accountIds) {
        afterBalances.set(accountId, await accountBalance(tx, accountId));
      }
      mismatchesAfter = await checkPreviousRemainingConsistency(tx);

      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  for (const accountId of accountIds) {
    const before = beforeBalances.get(accountId) ?? 0;
    const after = afterBalances.get(accountId) ?? before;
    const changed = Math.abs(round2(after - before)) > 0.009;
    console.log(`  ${accountNameById.get(accountId) || accountId}: ${before.toLocaleString()} -> ${after.toLocaleString()}${changed ? "  *** CHANGED - investigate before applying ***" : "  (unchanged, as expected)"}`);
  }

  console.log("\nChecking Previous Balance / Remaining consistency AFTER cleanup...");
  if (mismatchesAfter.length === 0) {
    console.log("  No mismatches - every Trip's own Previous Balance now matches the prior Trip's own Remaining, for every carrier.");
  } else {
    console.log(`  ${mismatchesAfter.length} mismatch(es) REMAIN after cleanup (not caused by a reversal-dating pair - needs separate investigation):`);
    for (const m of mismatchesAfter) {
      console.log(`    ${m.carrierNumber}: Trip ${m.tripNNo} Remaining (${m.remaining.toLocaleString()}) != Trip ${m.tripNPlus1No} Previous Balance (${m.previous.toLocaleString()}) - diff ${m.diff.toLocaleString()}`);
    }
  }

  console.log("\n====================================================================");
  if (apply) {
    console.log(`APPLIED: ${pairs.length} pair(s) retired to Bin, attributed to user "${actorUsername}".`);
  } else {
    console.log(`DRY RUN: ${pairs.length} pair(s) would be retired to Bin. No changes have been made (transaction rolled back).`);
    console.log("Re-run with --apply --user=<username> (after taking a database backup) to perform the moves.");
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
