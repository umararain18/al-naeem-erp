// READ-ONLY. Scans every SETTLED own-carrier Challan's own Bilties
// for the exact double-counting bug found in production (Challan
// 6435 / Bilty 453): a driver collects a Bilty's To-Pay via Trip
// Wasooli, and Finalize Settlement's OLD deterministic-default
// (fixed in this same PR - see app/api/challan/[id]/finalize-
// settlement/route.ts) ALSO reclassified the same amount to the
// Clearing Agent, crediting Gross Bilty Receivable twice for one
// real-world collection.
//
// For every settled own-carrier Challan's own Bilty, sums every
// JournalLine ever posted against Gross Bilty Receivable tagged
// sourceType:"BILTY"/sourceId:<thisBilty>, bucketed by its own
// JournalEntry.referenceType into:
//   - Trip collection      (CARRIER_TRIP_LINE / CARRIER_TRIP_LINE_REVERSAL)
//   - Settlement/CA reclass (SETTLEMENT / SETTLEMENT_PAYMENT / SETTLEMENT_PAYMENT_REVERSAL / SETTLEMENT_PAYMENT_CORRECTION / PAID_RESPONSIBILITY_REASSIGNMENT)
//   - Daily Posting        (DAILY_POSTING)
//   - Other                (anything else - reported so nothing is silently dropped)
// Each bucket's own "claimed" amount is its own CREDIT minus DEBIT
// net (a credit claims against the receivable; a later reversal's
// debit correctly un-claims it) - never raw credit alone, which would
// double-count an already-reversed claim.
//
// Flags a Bilty when the THREE buckets' combined claimed amount
// exceeds its own To-Pay (beyond a 1-paisa rounding tolerance) -
// exactly the "claimed more than was ever owed" signature. Never
// writes anything.
//
// Usage: npx tsx scripts/scan-own-carrier-double-collected-bilties.ts

import { PrismaClient } from "@prisma/client";
import { getGrossBiltyReceivableAccountId } from "../lib/gross-accounts";

const prisma = new PrismaClient();

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const TRIP_TYPES = new Set(["CARRIER_TRIP_LINE", "CARRIER_TRIP_LINE_REVERSAL"]);
const SETTLEMENT_TYPES = new Set([
  "SETTLEMENT",
  "SETTLEMENT_PAYMENT",
  "SETTLEMENT_PAYMENT_REVERSAL",
  "SETTLEMENT_PAYMENT_CORRECTION",
  "PAID_RESPONSIBILITY_REASSIGNMENT",
]);
const DAILY_POSTING_TYPES = new Set(["DAILY_POSTING"]);

async function main() {
  const grossAccountId = await getGrossBiltyReceivableAccountId(prisma);

  const challans = await prisma.challan.findMany({
    where: { ownCarrierId: { not: null }, isSettled: true, isDeleted: false },
    select: {
      id: true,
      challanNo: true,
      ownCarrier: { select: { carrierNumber: true } },
      bilties: { select: { biltyId: true, bilty: { select: { biltyNo: true, toPay: true, isDeleted: true } } } },
    },
  });

  console.log(`Scanning ${challans.length} settled own-carrier Challan(s)...\n`);

  let flaggedCount = 0;
  let totalExcess = 0;

  for (const challan of challans) {
    for (const cb of challan.bilties) {
      if (cb.bilty.isDeleted) continue;
      const toPay = round2(Number(cb.bilty.toPay));
      if (toPay <= 0.009) continue;

      const lines = await prisma.journalLine.findMany({
        where: { accountId: grossAccountId, sourceType: "BILTY", sourceId: cb.biltyId, journalEntry: { isDeleted: false } },
        select: { debit: true, credit: true, journalEntry: { select: { referenceType: true } } },
      });

      let tripClaimed = 0;
      let settlementClaimed = 0;
      let dailyPostingClaimed = 0;
      let otherClaimed = 0;
      const otherReferenceTypes = new Set<string>();

      for (const line of lines) {
        const net = round2(Number(line.credit) - Number(line.debit));
        const refType = line.journalEntry.referenceType || "(none)";
        if (TRIP_TYPES.has(refType)) tripClaimed = round2(tripClaimed + net);
        else if (SETTLEMENT_TYPES.has(refType)) settlementClaimed = round2(settlementClaimed + net);
        else if (DAILY_POSTING_TYPES.has(refType)) dailyPostingClaimed = round2(dailyPostingClaimed + net);
        else {
          otherClaimed = round2(otherClaimed + net);
          otherReferenceTypes.add(refType);
        }
      }

      const totalClaimed = round2(tripClaimed + settlementClaimed + dailyPostingClaimed + otherClaimed);
      const excess = round2(totalClaimed - toPay);

      if (excess > 0.009) {
        flaggedCount++;
        totalExcess = round2(totalExcess + excess);
        console.log(`Challan ${challan.challanNo} (${challan.id}) / Carrier ${challan.ownCarrier?.carrierNumber || "?"} / Bilty ${cb.bilty.biltyNo} (${cb.biltyId})`);
        console.log(`  To-Pay: Rs. ${toPay.toLocaleString()}`);
        console.log(`  Trip collection: Rs. ${tripClaimed.toLocaleString()}  |  Settlement/CA reclass: Rs. ${settlementClaimed.toLocaleString()}  |  Daily Posting: Rs. ${dailyPostingClaimed.toLocaleString()}${otherClaimed !== 0 ? `  |  Other (${[...otherReferenceTypes].join(", ")}): Rs. ${otherClaimed.toLocaleString()}` : ""}`);
        console.log(`  TOTAL CLAIMED: Rs. ${totalClaimed.toLocaleString()}  ->  EXCESS over To-Pay: Rs. ${excess.toLocaleString()}\n`);
      }
    }
  }

  console.log("====================================================================");
  console.log(`${flaggedCount} Bilty(s) found claimed beyond their own To-Pay, total excess Rs. ${totalExcess.toLocaleString()}.`);
  console.log("Read-only scan - no changes made.");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
