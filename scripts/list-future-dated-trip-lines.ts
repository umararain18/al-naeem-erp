// READ-ONLY - no writes, ever. Safe to run against production.
//
// Lists every existing, non-deleted CarrierTripLine dated AFTER
// today - these predate the new future-date block in
// lib/carrier-trip.ts (postTripLineByType's own assertLineDateValid)
// and were never rejected at write time. Reported for manual review/
// correction only; makes no changes.
//
// Run: npx tsx scripts/list-future-dated-trip-lines.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const lines = await prisma.carrierTripLine.findMany({
    where: { isDeleted: false, date: { gt: todayEnd } },
    orderBy: [{ date: "asc" }],
    select: {
      id: true,
      date: true,
      lineType: true,
      description: true,
      amount: true,
      trip: { select: { id: true, tripNo: true, carrier: { select: { carrierNumber: true } } } },
    },
  });

  console.log(`Today: ${ymd(new Date())}`);
  console.log(`Found ${lines.length} future-dated CarrierTripLine row(s):\n`);

  for (const l of lines) {
    console.log(
      `Carrier ${l.trip.carrier.carrierNumber} / Trip ${l.trip.tripNo} - ${l.lineType} Rs. ${Number(l.amount).toLocaleString()} dated ${ymd(l.date)} - "${l.description || l.lineType}" (line id ${l.id})`
    );
  }

  const cbm191 = lines.filter((l) => l.trip.carrier.carrierNumber === "CBM-191");
  console.log(`\nOf these, ${cbm191.length} belong to carrier CBM-191 specifically.`);

  console.log(`\n=== ${lines.length} future-dated line(s) found. No changes have been made. ===`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
