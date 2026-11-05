// READ-ONLY DRY RUN - no writes, ever. Safe to run against production.
//
// Lists every existing CARRIER_TRIP_LINE_REVERSAL JournalEntry whose
// own entryDate does not match the ORIGINAL (reversed) entry's
// entryDate - the exact bug fixed in lib/carrier-trip.ts's
// reverseCarrierTripLine (previously dated every reversal "today"
// instead of the original line's own date). Reports a correction
// plan per mismatch; makes NO ledger changes. Any actual correction
// requires separate, explicit approval.
//
// Run: npx tsx scripts/dry-run-carrier-trip-reversal-dates.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const reversals = await prisma.journalEntry.findMany({
    where: { referenceType: "CARRIER_TRIP_LINE_REVERSAL", isDeleted: false, reversesEntryId: { not: null } },
    orderBy: { entryDate: "asc" },
    select: { id: true, entryDate: true, description: true, reversesEntryId: true, referenceId: true, createdAt: true },
  });

  console.log(`Found ${reversals.length} CARRIER_TRIP_LINE_REVERSAL entries total.`);

  const originalIds = [...new Set(reversals.map((r) => r.reversesEntryId).filter((x): x is string => Boolean(x)))];
  const originals = await prisma.journalEntry.findMany({
    where: { id: { in: originalIds } },
    select: { id: true, entryDate: true, description: true },
  });
  const originalById = new Map(originals.map((o) => [o.id, o]));

  const tripIds = [...new Set(reversals.map((r) => r.referenceId).filter((x): x is string => Boolean(x)))];
  const trips = await prisma.carrierTrip.findMany({
    where: { id: { in: tripIds } },
    select: { id: true, tripNo: true, carrier: { select: { carrierNumber: true } } },
  });
  const tripById = new Map(trips.map((t) => [t.id, t]));

  const mismatches: {
    reversalId: string;
    reversalDate: string;
    originalId: string;
    originalDate: string;
    description: string;
    tripNo: string;
    carrierNumber: string;
  }[] = [];

  for (const r of reversals) {
    if (!r.reversesEntryId) continue;
    const original = originalById.get(r.reversesEntryId);
    if (!original) continue; // orphan reference - not this bug's concern
    if (ymd(r.entryDate) !== ymd(original.entryDate)) {
      const trip = r.referenceId ? tripById.get(r.referenceId) : undefined;
      mismatches.push({
        reversalId: r.id,
        reversalDate: ymd(r.entryDate),
        originalId: original.id,
        originalDate: ymd(original.entryDate),
        description: r.description || "",
        tripNo: trip?.tripNo || "(unknown)",
        carrierNumber: trip?.carrier.carrierNumber || "(unknown)",
      });
    }
  }

  console.log(`\n${mismatches.length} reversal(s) dated differently from their own original entry:\n`);
  for (const m of mismatches) {
    console.log(`Carrier ${m.carrierNumber} / Trip ${m.tripNo}`);
    console.log(`  Reversal JournalEntry ${m.reversalId} - "${m.description}"`);
    console.log(`    currently dated: ${m.reversalDate}`);
    console.log(`    original entry ${m.originalId} dated: ${m.originalDate}`);
    console.log(`  CORRECTION PLAN: update JournalEntry.entryDate on ${m.reversalId} from ${m.reversalDate} -> ${m.originalDate} (no other field changes; no ledger balances change - entryDate is a display/period-attribution field only, not a debit/credit amount).`);
    console.log("");
  }

  console.log(`=== ${mismatches.length} reversal(s) need correction. No changes have been made - this is a dry run. ===`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
