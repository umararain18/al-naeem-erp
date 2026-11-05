// DRY-RUN BY DEFAULT - no writes unless --apply is passed. Safe to
// run against production in dry-run mode (read-only).
//
// Every open Trip's own expense/diesel/salary lines were posted
// before the "Trip in Progress" clearing account existed, debiting
// Carrier Profit directly (so they already count in P&L even though
// the Trip is still open - exactly the bug this whole feature fixes).
// This script finds every such line still live on an OPEN Trip and
// posts ONE additive correction per line - Dr Trip in Progress / Cr
// Carrier Profit, for that line's own amount, dated that line's own
// date (never today) - which, netted against the original entry,
// leaves Carrier Profit untouched for that line and the debit sitting
// on Trip in Progress instead, exactly where the NEW code would have
// put it. No original entry is ever edited, reversed, or deleted.
//
// Idempotent: a line that already has a correction (tracked via
// referenceType CARRIER_TRIP_EXPENSE_MIGRATION, sourceId = the
// original CarrierTripLine's own id) is skipped on a second run.
//
// Run (dry-run, always safe): npx tsx scripts/migrate-open-trip-expenses-to-trip-in-progress.ts
// Apply (after reviewing the dry-run output AND taking a database
// backup first): npx tsx scripts/migrate-open-trip-expenses-to-trip-in-progress.ts --apply

import { PrismaClient } from "@prisma/client";
import { getOrCreateTripInProgressAccountId } from "../lib/own-carrier";

const prisma = new PrismaClient();
const MIGRATION_REFERENCE_TYPE = "CARRIER_TRIP_EXPENSE_MIGRATION";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const carriers = await prisma.ownCarrier.findMany({ where: { isDeleted: false }, select: { id: true, carrierNumber: true } });
  console.log(`Scanning ${carriers.length} own carrier(s)...\n`);

  let totalLinesPlanned = 0;
  let totalAmountPlanned = 0;
  let totalLinesApplied = 0;
  let totalAmountApplied = 0;

  for (const carrier of carriers) {
    const openTrips = await prisma.carrierTrip.findMany({
      where: { carrierId: carrier.id, isDeleted: false, status: "OPEN" },
      select: { id: true, tripNo: true },
    });
    if (openTrips.length === 0) continue;

    const carrierProfitAccount = await prisma.account.findUnique({ where: { ownCarrierIncomeId: carrier.id }, select: { id: true, accountName: true } });
    if (!carrierProfitAccount) continue;

    for (const trip of openTrips) {
      const expenseLines = await prisma.carrierTripLine.findMany({
        where: { tripId: trip.id, isDeleted: false, lineType: { in: ["EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY"] } },
        select: { id: true, date: true, amount: true, description: true, lineType: true, journalEntryId: true },
        orderBy: { date: "asc" },
      });
      if (expenseLines.length === 0) continue;

      // Already-migrated lines (idempotency) - skip them.
      const alreadyMigrated = new Set(
        (
          await prisma.journalEntry.findMany({
            where: { referenceType: MIGRATION_REFERENCE_TYPE, isDeleted: false, referenceId: { in: expenseLines.map((l) => l.id) } },
            select: { referenceId: true },
          })
        ).map((e) => e.referenceId)
      );
      const toMigrate = expenseLines.filter((l) => !alreadyMigrated.has(l.id));
      if (toMigrate.length === 0) continue;

      const tripTotal = round2(toMigrate.reduce((s, l) => s + Number(l.amount), 0));
      console.log(`Carrier ${carrier.carrierNumber} / Trip ${trip.tripNo}: ${toMigrate.length} line(s), total Rs. ${tripTotal.toLocaleString()}`);
      for (const l of toMigrate) {
        console.log(`  [${l.date.toISOString().slice(0, 10)}] ${l.lineType} Rs. ${Number(l.amount).toLocaleString()} - "${l.description}" (line ${l.id})`);
      }

      totalLinesPlanned += toMigrate.length;
      totalAmountPlanned = round2(totalAmountPlanned + tripTotal);

      if (apply) {
        const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(prisma, carrier.id);
        for (const l of toMigrate) {
          const amount = round2(Number(l.amount));
          const description = `Migration - moving Trip ${trip.tripNo} expense ("${l.description}") from Carrier Profit to Trip in Progress (one-time, pre-Trip-in-Progress-feature correction)`;
          await prisma.journalEntry.create({
            data: {
              entryDate: l.date,
              referenceType: MIGRATION_REFERENCE_TYPE,
              referenceId: l.id,
              description,
              lines: {
                create: [
                  { accountId: tripInProgressAccountId, debit: amount, credit: 0, description, sourceType: "CARRIER_TRIP", sourceId: trip.id, sourceNumber: trip.tripNo },
                  { accountId: carrierProfitAccount.id, debit: 0, credit: amount, description, sourceType: "CARRIER_TRIP", sourceId: trip.id, sourceNumber: trip.tripNo },
                ],
              },
            },
          });
          totalLinesApplied++;
          totalAmountApplied = round2(totalAmountApplied + amount);
        }
      }
      console.log("");
    }
  }

  if (apply) {
    console.log(`=== APPLIED: ${totalLinesApplied} line(s) migrated, total Rs. ${totalAmountApplied.toLocaleString()} moved from Carrier Profit to Trip in Progress. ===`);
  } else {
    console.log(`=== DRY RUN: ${totalLinesPlanned} line(s) would be migrated, total Rs. ${totalAmountPlanned.toLocaleString()}. No changes have been made. ===`);
    console.log(`Re-run with --apply (after taking a database backup) to actually post these corrections.`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
