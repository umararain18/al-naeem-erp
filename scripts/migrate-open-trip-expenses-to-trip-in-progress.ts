// Moves every OPEN trip's own expense/diesel/salary JournalLine OFF
// Carrier Profit onto Trip in Progress by RE-POINTING
// JournalLine.accountId IN PLACE (never a new correcting entry) plus
// one AuditLog row per CarrierTripLine moved. This is a deliberate
// exception to this codebase's usual append-only correction pattern
// (see scripts/reclass-legacy-bilty-revenue.ts) - requested so this
// one-time cleanup leaves no extra ledger entries. Trade-off accepted:
// a Trial Balance / ledger run "as of" a date BEFORE this script's own
// run will now show the amount already on Trip in Progress, not where
// it actually sat on that historical date - unlike an additive
// correction, which would have kept historical as-of reports intact.
//
// Moves BOTH lines of a CARRIER_TRIP_LINE / CARRIER_TRIP_LINE_REVERSAL
// pair together (the dead original CarrierTripLine's own entry AND
// its reversal) so Carrier Profit's ledger carries ZERO trace of an
// OPEN trip's expense activity, live or historical - not just a net
// zero. A pair missing its other half (reversal not found live, e.g.
// already binned/removed by some other cleanup) is left COMPLETELY
// untouched and reported loudly - NEVER moved one-sided.
//
// DEFAULT (no flag): DRY-RUN. Read-only - safe to run against
// production. Shows, per Trip: how many live lines / historical dead
// pairs / incomplete (skipped) pairs were found, plus a per-account
// before -> after balance projection (Carrier Profit, Trip in
// Progress) computed from the planned moves without writing anything.
//
// --apply: performs the moves found above. Requires an attributable
// user for the AuditLog rows: --user=<username> (defaults to the
// first active SUPER_ADMIN, same convention as
// scripts/reclass-legacy-bilty-revenue.ts). TAKE A DATABASE BACKUP
// FIRST.
//
// Idempotent: every decision is made from the JournalLine's CURRENT
// accountId at run time (never a stored "already migrated" flag), so
// re-running after a partial apply, or after new OPEN-trip lines were
// posted by the live Trip-in-Progress feature itself (which already
// post directly to Trip in Progress and are therefore simply not
// found here), is always safe.
//
// Usage:
//   npx tsx scripts/migrate-open-trip-expenses-to-trip-in-progress.ts                       (dry-run)
//   npx tsx scripts/migrate-open-trip-expenses-to-trip-in-progress.ts --apply --user=umar     (writes)

import { PrismaClient, Prisma } from "@prisma/client";
import { getOrCreateTripInProgressAccountId } from "../lib/own-carrier";
import { auditUpdate, actorFromUser } from "../lib/audit-log";

const prisma = new PrismaClient();
const EXPENSE_LINE_TYPES = ["EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY"] as const;

const apply = process.argv.includes("--apply");
const userArg = process.argv.find((a) => a.startsWith("--user="));
const requestedUsername = userArg ? userArg.slice("--user=".length) : null;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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

type MoveSingle = { kind: "single"; lineId: string; amount: number; isDebit: boolean };
type MovePair = { kind: "pair"; originalLineId: string; reversalLineId: string };
type Incomplete = { carrierTripLineId: string; journalEntryId: string; reason: string };

async function planForTrip(carrierProfitAccountId: string, tripId: string) {
  const lines = await prisma.carrierTripLine.findMany({
    where: { tripId, lineType: { in: [...EXPENSE_LINE_TYPES] } },
    select: {
      id: true,
      lineType: true,
      amount: true,
      date: true,
      description: true,
      isDeleted: true,
      journalEntryId: true,
      journalEntry: { select: { id: true, isDeleted: true, lines: { select: { id: true, accountId: true, debit: true, credit: true } } } },
    },
    orderBy: { date: "asc" },
  });

  const moves: (MoveSingle | MovePair)[] = [];
  const incomplete: Incomplete[] = [];
  let liveTotal = 0;
  let deadPairCount = 0;

  for (const line of lines) {
    if (line.journalEntry.isDeleted) continue; // already binned by something else - nothing to move

    const cpLine = line.journalEntry.lines.find((l) => l.accountId === carrierProfitAccountId);
    if (!cpLine) continue; // not currently on Carrier Profit (already migrated, or never was) - nothing to do

    if (!line.isDeleted) {
      const amount = Number(cpLine.debit) > 0 ? Number(cpLine.debit) : Number(cpLine.credit);
      const isDebit = Number(cpLine.debit) > 0;
      moves.push({ kind: "single", lineId: cpLine.id, amount, isDebit });
      liveTotal = round2(liveTotal + amount);
      continue;
    }

    // Dead line (edited/replaced) - only move it together with its
    // reversal, never alone.
    const reversal = await prisma.journalEntry.findFirst({
      where: { reversesEntryId: line.journalEntry.id, isDeleted: false },
      select: { id: true, lines: { select: { id: true, accountId: true } } },
    });
    if (!reversal) {
      incomplete.push({
        carrierTripLineId: line.id,
        journalEntryId: line.journalEntry.id,
        reason: "Dead CarrierTripLine has no live reversal entry - skipped, left untouched.",
      });
      continue;
    }
    const reversalCpLine = reversal.lines.find((l) => l.accountId === carrierProfitAccountId);
    if (!reversalCpLine) {
      incomplete.push({
        carrierTripLineId: line.id,
        journalEntryId: line.journalEntry.id,
        reason: "Reversal entry found but its own line is no longer on Carrier Profit - skipped, left untouched.",
      });
      continue;
    }
    moves.push({ kind: "pair", originalLineId: cpLine.id, reversalLineId: reversalCpLine.id });
    deadPairCount++;
  }

  return { lines, moves, incomplete, liveTotal, deadPairCount };
}

async function accountBalances(accountIds: string[]) {
  const agg = await prisma.journalLine.aggregate({
    where: { accountId: { in: accountIds }, journalEntry: { isDeleted: false } },
    _sum: { debit: true, credit: true },
  });
  return round2(Number(agg._sum.debit || 0) - Number(agg._sum.credit || 0)); // debit - credit (ASSET convention)
}

async function main() {
  const carriers = await prisma.ownCarrier.findMany({ where: { isDeleted: false }, select: { id: true, carrierNumber: true } });
  console.log(`Scanning ${carriers.length} own carrier(s)...\n`);

  let actorUser: { id: string; username: string; role: string } | null = null;
  if (apply) actorUser = await resolveActor();

  let grandLiveTotal = 0;
  let grandDeadPairs = 0;
  let grandIncomplete = 0;

  for (const carrier of carriers) {
    const openTrips = await prisma.carrierTrip.findMany({
      where: { carrierId: carrier.id, isDeleted: false, status: "OPEN" },
      select: { id: true, tripNo: true },
    });
    if (openTrips.length === 0) continue;

    const carrierProfitAccount = await prisma.account.findUnique({ where: { ownCarrierIncomeId: carrier.id }, select: { id: true, accountName: true } });
    if (!carrierProfitAccount) continue;
    const tripInProgressAccount = await prisma.account.findUnique({ where: { ownCarrierTripInProgressId: carrier.id }, select: { id: true, accountName: true } });

    // Captured BEFORE any write below, in both modes - debit - credit
    // convention throughout (ASSET-style); Carrier Profit's own net
    // INCOME is credit - debit, the negative of this figure (see
    // lib/pnl.ts netIncome).
    const cpBefore = await accountBalances([carrierProfitAccount.id]);
    const tipBefore = tripInProgressAccount ? await accountBalances([tripInProgressAccount.id]) : 0;

    let carrierHasOutput = false;
    let carrierSignedTotal = 0; // sum of (debit - credit) for every LIVE line moving - the actual balance delta
    let carrierDeadPairs = 0;

    for (const trip of openTrips) {
      const { moves, incomplete, liveTotal, deadPairCount } = await planForTrip(carrierProfitAccount.id, trip.id);
      if (moves.length === 0 && incomplete.length === 0) continue;

      if (!carrierHasOutput) {
        console.log(`=== Carrier ${carrier.carrierNumber} ===`);
        console.log(`  Carrier Profit account: ${carrierProfitAccount.accountName} (${carrierProfitAccount.id})`);
        console.log(`  Trip in Progress account: ${tripInProgressAccount ? `${tripInProgressAccount.accountName} (${tripInProgressAccount.id})` : "(does not exist yet - will be created on first --apply)"}\n`);
        carrierHasOutput = true;
      }

      console.log(`  Trip ${trip.tripNo}: ${liveTotal > 0 ? `Rs. ${liveTotal.toLocaleString()} live (will move, changes balances)` : "no live lines on Carrier Profit"}${deadPairCount > 0 ? `; ${deadPairCount} dead reversal-pair(s) (net Rs. 0, moved for ledger cleanliness only)` : ""}`);
      if (incomplete.length > 0) {
        console.log(`    SKIPPED (incomplete, left untouched):`);
        for (const inc of incomplete) console.log(`      - CarrierTripLine ${inc.carrierTripLineId} / JournalEntry ${inc.journalEntryId}: ${inc.reason}`);
      }

      for (const move of moves) {
        if (move.kind === "single") carrierSignedTotal = round2(carrierSignedTotal + (move.isDebit ? move.amount : -move.amount));
      }
      carrierDeadPairs += deadPairCount;

      grandLiveTotal = round2(grandLiveTotal + liveTotal);
      grandDeadPairs += deadPairCount;
      grandIncomplete += incomplete.length;

      if (apply && moves.length > 0 && actorUser) {
        const actor = actorFromUser({ userId: actorUser.id, username: actorUser.username, role: actorUser.role });
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, carrier.id);
          for (const move of moves) {
            if (move.kind === "single") {
              const before = await tx.journalLine.findUniqueOrThrow({ where: { id: move.lineId }, select: { accountId: true } });
              await tx.journalLine.update({ where: { id: move.lineId }, data: { accountId: tripInProgressAccountId } });
              await auditUpdate(tx, {
                actor,
                module: "OWN_CARRIER",
                entityType: "JournalLine",
                entityId: move.lineId,
                documentNo: trip.tripNo,
                description: `Moved Rs. ${move.amount.toLocaleString()} from Carrier Profit to Trip in Progress for OPEN Trip ${trip.tripNo} (carrier ${carrier.carrierNumber}) via scripts/migrate-open-trip-expenses-to-trip-in-progress.ts`,
                oldValues: { accountId: before.accountId },
                newValues: { accountId: tripInProgressAccountId },
              });
            } else {
              const beforeOriginal = await tx.journalLine.findUniqueOrThrow({ where: { id: move.originalLineId }, select: { accountId: true } });
              const beforeReversal = await tx.journalLine.findUniqueOrThrow({ where: { id: move.reversalLineId }, select: { accountId: true } });
              await tx.journalLine.update({ where: { id: move.originalLineId }, data: { accountId: tripInProgressAccountId } });
              await tx.journalLine.update({ where: { id: move.reversalLineId }, data: { accountId: tripInProgressAccountId } });
              await auditUpdate(tx, {
                actor,
                module: "OWN_CARRIER",
                entityType: "JournalLine",
                entityId: move.originalLineId,
                documentNo: trip.tripNo,
                description: `Moved a dead/historical (edited-away) reversal pair from Carrier Profit to Trip in Progress for OPEN Trip ${trip.tripNo} (carrier ${carrier.carrierNumber}) - net Rs. 0, ledger-cleanliness only - via scripts/migrate-open-trip-expenses-to-trip-in-progress.ts`,
                oldValues: { originalLineAccountId: beforeOriginal.accountId, reversalLineAccountId: beforeReversal.accountId },
                newValues: { originalLineAccountId: tripInProgressAccountId, reversalLineAccountId: tripInProgressAccountId },
              });
            }
          }
        });
      }
    }

    if (carrierHasOutput) {
      if (apply) {
        const cpAfter = await accountBalances([carrierProfitAccount.id]);
        const tripInProgressAccountNow = await prisma.account.findUnique({ where: { ownCarrierTripInProgressId: carrier.id }, select: { id: true } });
        const tipAfter = tripInProgressAccountNow ? await accountBalances([tripInProgressAccountNow.id]) : 0;
        console.log(`\n  Carrier Profit (debit-credit): ${cpBefore} -> ${cpAfter}`);
        console.log(`  Trip in Progress (debit-credit): ${tipBefore} -> ${tipAfter}\n`);
      } else {
        const cpAfterProjected = round2(cpBefore - carrierSignedTotal);
        const tipAfterProjected = round2(tipBefore + carrierSignedTotal);
        console.log(`\n  Carrier Profit (debit-credit) now: ${cpBefore}  -> projected after --apply: ${cpAfterProjected}`);
        console.log(`  Trip in Progress (debit-credit) now: ${tipBefore}  -> projected after --apply: ${tipAfterProjected}\n`);
      }
    }
  }

  console.log("====================================================================");
  if (apply) {
    console.log(`APPLIED: Rs. ${grandLiveTotal.toLocaleString()} moved (live lines, in place), ${grandDeadPairs} dead reversal-pair(s) relocated (net Rs. 0), ${grandIncomplete} incomplete pair(s) skipped untouched.`);
  } else {
    console.log(`DRY RUN: Rs. ${grandLiveTotal.toLocaleString()} would move (live lines, in place), ${grandDeadPairs} dead reversal-pair(s) would relocate (net Rs. 0), ${grandIncomplete} incomplete pair(s) would be skipped untouched.`);
    console.log("No changes have been made. Re-run with --apply --user=<username> (after taking a database backup) to perform the moves.");
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
