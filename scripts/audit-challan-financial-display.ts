// READ-ONLY AUDIT - no writes, ever. Safe to run against production.
//
// Compares, for every non-deleted Challan, what the Challan list/
// detail's Financial Summary used to show (lib/challan-
// financials.ts's computeChallanFinancialsBatch(), the OLD, now-
// unused-by-display calculation) against what it shows now
// (lib/challan-settlement-summary.ts's computeChallanSettlementSummaryBatch(),
// the ONE shared calculation the list, its summary cards, the Challan
// Detail page, and Final Settlement all now read).
//
// Prints ONLY the Challans whose numbers actually differ - challanNo,
// old vs new Received/Receivable/Payable, old vs new badge, and a
// short diagnostic (not a guess) of which mechanism explains the
// difference - plus each differing Challan's relevant parties'
// CURRENT party-ledger closing balance (via the exact same
// lib/ledger-description.ts's getPartyLedgerData() the Party Ledger
// screen itself uses), so a reviewer can cross-check against a
// trusted, independent source. Ends with totals across every
// Challan checked.
//
// FOUR independent reasons a Challan's old/new figures can differ:
//  1. computeChallanFinancialsBatch() (lib/challan-financials.ts) has
//     ZERO awareness of the SettlementPayment multi-payer engine -
//     it predates it and was never updated to read it. Its only
//     notion of "actually paid/received" is a DAILY_POSTING
//     JournalLine; a Challan settled via the (newer) SettlementPayment
//     engine - "live To-Pay/Carrier Rent payment rows" below - keeps
//     showing its full original outstandingReceivable/outstandingPayable
//     forever under the old calculation, never reduced, even though
//     it has genuinely been settled. In this dev data this is the
//     DOMINANT pattern: every Challan below with "live ... payment
//     rows=true" for a component whose old Receivable/Payable still
//     equals its full original amount is hitting exactly this.
//  2. STRUCTURAL: the OLD figure is one BLENDED Receivable/Payable
//     per Challan (Challan.outstandingReceivable/outstandingPayable,
//     set at settlement as each party's NET position across BOTH
//     Collection and Carrier Rent together); the NEW figure is two
//     DIMENSIONALLY-SEPARATED numbers (To-Pay remaining, Carrier Rent
//     remaining), never netted against each other even when the same
//     party holds both. Whenever one party is responsible for BOTH
//     components, the two models disagree by construction - with no
//     bug involved at all.
//  3. computeChallanFinancialsBatch() can misattribute an entire
//     multi-line DAILY_POSTING JournalEntry's party lines onto
//     whichever Challan/Bilty its FIRST matching line happens to
//     belong to - a combined voucher touching several
//     Bilties/Challans at once leaks amounts between them.
//  4. The OLD "historical fallback" in
//     computeChallanSettlementSummaryBatch (removed by this fix)
//     treated a settlement's own reclassification entry as if it
//     were an actual payment/receipt whenever no live
//     SettlementPayment row existed yet.
//
// Usage:
//   npx tsx scripts/audit-challan-financial-display.ts
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import { computeChallanFinancialsBatch } from "../lib/challan-financials";
import { computeChallanSettlementSummaryBatch } from "../lib/challan-settlement-summary";
import { getPartyLedgerData } from "../lib/ledger-description";

const prisma = new PrismaClient();
const EPS = 0.01;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function badge(paidOrReceived: number, remaining: number, total: number): string {
  if (total <= EPS) return "N/A";
  if (remaining <= EPS) return "CLEARED";
  if (paidOrReceived > EPS) return "PARTIAL";
  return "DUE";
}

async function main() {
  const challans = await prisma.challan.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      challanNo: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      transporterPartyId: true,
      bilties: {
        select: {
          biltyId: true,
          bilty: { select: { consignorPartyId: true, clearingAgentPartyId: true } },
        },
      },
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
  let oldReceivableTotal = 0;
  let newReceivableTotal = 0;
  let oldPayableTotal = 0;
  let newPayableTotal = 0;

  for (const c of challans) {
    const old = oldMap[c.id];
    const fresh = newMap[c.id];
    if (!old || !fresh) continue;

    const oldReceived = round2(old.received);
    const oldReceivable = round2(old.remainingReceivable);
    const oldPayable = round2(old.remainingPayable);

    const toPayPaid = round2(fresh.bilties.reduce((s, b) => s + b.toPay.paidOrReceived, 0));
    const toPayTotal = round2(fresh.bilties.reduce((s, b) => s + b.toPay.total, 0));
    const newReceivable = round2(fresh.bilties.reduce((s, b) => s + b.toPay.remaining, 0));
    const newPayable = round2(fresh.carrierRent.remaining);

    oldReceivableTotal = round2(oldReceivableTotal + oldReceivable);
    newReceivableTotal = round2(newReceivableTotal + newReceivable);
    oldPayableTotal = round2(oldPayableTotal + oldPayable);
    newPayableTotal = round2(newPayableTotal + newPayable);

    const receivedDiff = round2(toPayPaid - oldReceived);
    const receivableDiff = round2(newReceivable - oldReceivable);
    const payableDiff = round2(newPayable - oldPayable);

    if (Math.abs(receivedDiff) <= EPS && Math.abs(receivableDiff) <= EPS && Math.abs(payableDiff) <= EPS) {
      continue; // unchanged - never printed.
    }
    differing++;

    // Diagnostic facts (never a single guessed "reason" label) - lets
    // a reviewer see which of the three mechanisms above is at play.
    const hasLiveToPayRows = fresh.bilties.some((b) => b.toPay.payers.length > 0);
    const hasLiveCarrierRentRows = fresh.carrierRent.payers.length > 0;
    const collectionPartyIds = new Set(fresh.bilties.flatMap((b) => b.toPay.payers.map((p) => p.partyId).filter(Boolean)));
    const carrierRentPartyIds = new Set(fresh.carrierRent.payers.map((p) => p.partyId).filter(Boolean));
    const sharedPartyAcrossComponents = [...collectionPartyIds].some((id) => carrierRentPartyIds.has(id));

    console.log(`\nChallan ${c.challanNo} (${c.id})`);
    console.log(`  Received:   before ${oldReceived}  ->  after ${toPayPaid}  (${receivedDiff >= 0 ? "+" : ""}${receivedDiff})`);
    console.log(`  Receivable: before ${oldReceivable}  ->  after ${newReceivable}  (${receivableDiff >= 0 ? "+" : ""}${receivableDiff})  badge: ${old.status} -> ${badge(toPayPaid, newReceivable, toPayTotal)}`);
    console.log(`  Payable:    before ${oldPayable}  ->  after ${newPayable}  (${payableDiff >= 0 ? "+" : ""}${payableDiff})  badge: ${old.status} -> ${badge(fresh.carrierRent.paidOrReceived, newPayable, fresh.carrierRent.total)}`);
    console.log(
      `  Diagnostic: live To-Pay payment rows=${hasLiveToPayRows}, live Carrier Rent payment rows=${hasLiveCarrierRentRows} (if a component has live rows but its OLD figure still equals its full original amount, that is reason 1 below); same party responsible for both components=${sharedPartyAcrossComponents} (if true, part of the difference is reason 2, STRUCTURAL)`
    );

    // Relevant parties for this Challan: the Transporter (Carrier
    // Rent's usual responsible party) and every Bilty's Consignor/
    // Clearing Agent (Collection's usual responsible party) - purely
    // informational cross-check against the Party Ledger screen's own
    // authoritative figure, never used to compute anything above.
    const relevantPartyIds = new Set<string>();
    if (c.transporterPartyId) relevantPartyIds.add(c.transporterPartyId);
    for (const cb of c.bilties) {
      if (cb.bilty.consignorPartyId) relevantPartyIds.add(cb.bilty.consignorPartyId);
      if (cb.bilty.clearingAgentPartyId) relevantPartyIds.add(cb.bilty.clearingAgentPartyId);
    }
    for (const partyId of relevantPartyIds) {
      try {
        const ledger = await getPartyLedgerData(partyId, { order: "desc", includeOpeningBalanceRow: false });
        console.log(`  Party Ledger - ${ledger.account.accountName}: closing balance Rs. ${ledger.summary.closingBalance} (${ledger.summary.balanceType})`);
      } catch {
        // Party/account not resolvable (e.g. deactivated) - skip, never fabricate.
      }
    }
  }

  console.log(`\n=== ${differing} of ${challans.length} Challan(s) show a different Received/Receivable/Payable figure after this fix ===`);
  console.log(`Receivable totals: before ${oldReceivableTotal}  ->  after ${newReceivableTotal}`);
  console.log(`Payable totals:    before ${oldPayableTotal}  ->  after ${newPayableTotal}`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
