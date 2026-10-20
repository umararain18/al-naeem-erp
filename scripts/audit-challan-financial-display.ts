// READ-ONLY AUDIT - no writes, ever.
//
// Compares, for every non-deleted Challan, what the Challan list's
// Financial Summary used to show (lib/challan-financials.ts's
// computeChallanFinancialsBatch(), the OLD calculation) against what
// it shows now (lib/challan-settlement-summary.ts's
// computeChallanSettlementSummaryBatch(), the ONE shared calculation
// the list, its summary cards, the Challan Detail page, and Final
// Settlement all now read). Reports every Challan where the two
// disagree, so a production operator can see exactly which Challans'
// displayed numbers changed - and in which direction - when this fix
// deploys.
//
// Two independent root causes this fix addresses, either of which
// can make a Challan's old/new figures differ:
//  1. computeChallanFinancialsBatch() can misattribute an entire
//     multi-line DAILY_POSTING JournalEntry's party lines onto
//     whichever Challan/Bilty its FIRST matching line happens to
//     belong to - a combined receipt/payment voucher touching
//     several Bilties/Challans at once leaks amounts that belong to
//     OTHER documents onto this one.
//  2. The OLD "historical fallback" in computeChallanSettlementSummaryBatch
//     (removed by this fix) treated a settlement's own reclassification
//     entry (Dr responsible party / Cr Gross ...) as if it were an
//     actual payment/receipt whenever no live SettlementPayment row
//     existed yet - showing a genuinely unpaid Carrier Rent/To-Pay as
//     fully "Paid"/"Received" the moment settlement ran.
//
// Usage:
//   npx tsx scripts/audit-challan-financial-display.ts
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import { computeChallanFinancialsBatch } from "../lib/challan-financials";
import { computeChallanSettlementSummaryBatch } from "../lib/challan-settlement-summary";

const prisma = new PrismaClient();
const EPS = 0.01;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main() {
  const challans = await prisma.challan.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      challanNo: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      bilties: { select: { biltyId: true } },
    },
    orderBy: { challanNo: "asc" },
  });

  if (challans.length === 0) {
    console.log("No Challans found.");
    await prisma.$disconnect();
    return;
  }

  const [oldMap, newMap] = await Promise.all([
    computeChallanFinancialsBatch(
      challans.map((c) => ({
        id: c.id,
        outstandingReceivable: c.outstandingReceivable,
        outstandingPayable: c.outstandingPayable,
        biltyIds: c.bilties.map((b) => b.biltyId),
      }))
    ),
    computeChallanSettlementSummaryBatch(challans.map((c) => c.id)),
  ]);

  let differing = 0;

  for (const c of challans) {
    const old = oldMap[c.id];
    const fresh = newMap[c.id];
    if (!old || !fresh) continue;

    const oldReceived = round2(old.received);
    const oldReceivable = round2(old.remainingReceivable);
    const oldPayable = round2(old.remainingPayable);

    const newReceived = round2(fresh.bilties.reduce((s, b) => s + b.toPay.paidOrReceived, 0));
    const newReceivable = round2(fresh.bilties.reduce((s, b) => s + b.toPay.remaining, 0));
    const newPayable = round2(fresh.carrierRent.remaining);

    const receivedDiff = round2(newReceived - oldReceived);
    const receivableDiff = round2(newReceivable - oldReceivable);
    const payableDiff = round2(newPayable - oldPayable);

    if (Math.abs(receivedDiff) > EPS || Math.abs(receivableDiff) > EPS || Math.abs(payableDiff) > EPS) {
      differing++;
      console.log(`\nChallan ${c.challanNo} (${c.id})`);
      console.log(`  Received:   before ${oldReceived}  ->  after ${newReceived}  (${receivedDiff >= 0 ? "+" : ""}${receivedDiff})`);
      console.log(`  Receivable: before ${oldReceivable}  ->  after ${newReceivable}  (${receivableDiff >= 0 ? "+" : ""}${receivableDiff})`);
      console.log(`  Payable:    before ${oldPayable}  ->  after ${newPayable}  (${payableDiff >= 0 ? "+" : ""}${payableDiff})`);
    }
  }

  console.log(`\n=== ${differing} of ${challans.length} Challan(s) show a different Received/Receivable/Payable figure after this fix ===`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
