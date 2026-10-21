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
// diagnostic (never a guessed single "reason") of which tier/mechanism
// produced the new figure - plus each differing Challan's relevant
// parties' CURRENT party-ledger closing balance (via the exact same
// lib/ledger-description.ts's getPartyLedgerData() the Party Ledger
// screen itself uses). Ends with totals across every Challan checked,
// INCLUDING the sum of every printed party's own ledger closing
// balance next to the new Receivable/Payable totals, so a reviewer
// can sanity-check the two against each other directly.
//
// Invariant this audit itself checks and flags (never silently
// passes over): "paidOrReceived" must never exceed a component's own
// `total` - if it ever does, that is a bug in
// computeChallanSettlementSummaryBatch() itself, not a display
// difference, and is reported separately, loudly, at the top.
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
//     it has genuinely been settled.
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
//  4. The OLD "historical fallback" in a PRIOR version of
//     computeChallanSettlementSummaryBatch (since fixed) treated a
//     settlement's own reclassification entry as if it were an
//     actual payment/receipt whenever no live SettlementPayment row
//     existed yet - this script's own "new" figures are already past
//     that fix (see the module's own doc comment for the current,
//     corrected 3-tier precedence: live rows -> real, correctly-
//     scoped Daily Posting -> settlement-time verified advance).
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

  // Hard invariant check FIRST, loudly, separate from the diff report
  // below - a violation here is a real bug in the new calculation
  // itself, never just a display difference.
  const invariantViolations: string[] = [];
  for (const c of challans) {
    const fresh = newMap[c.id];
    if (!fresh) continue;
    for (const b of fresh.bilties) {
      if (round2(b.toPay.paidOrReceived) > round2(b.toPay.total) + EPS) {
        invariantViolations.push(`Challan ${c.challanNo} Bilty ${b.biltyNo}: To-Pay paidOrReceived ${b.toPay.paidOrReceived} > total ${b.toPay.total}`);
      }
    }
    if (round2(fresh.carrierRent.paidOrReceived) > round2(fresh.carrierRent.total) + EPS) {
      invariantViolations.push(`Challan ${c.challanNo}: Carrier Rent paidOrReceived ${fresh.carrierRent.paidOrReceived} > total ${fresh.carrierRent.total}`);
    }
  }
  if (invariantViolations.length > 0) {
    console.log("\n!!! INVARIANT VIOLATION - paidOrReceived exceeded total - this is a BUG, not a display difference !!!");
    for (const v of invariantViolations) console.log(`  ${v}`);
    console.log("");
  } else {
    console.log("Invariant check passed: no component's paidOrReceived ever exceeds its own total.\n");
  }

  let differing = 0;
  let oldReceivableTotal = 0;
  let newReceivableTotal = 0;
  let oldPayableTotal = 0;
  let newPayableTotal = 0;
  let partyLedgerReceivableTotal = 0;
  let partyLedgerPayableTotal = 0;
  const countedPartyAccountIds = new Set<string>();

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

    // Relevant parties for this Challan: the Transporter (Carrier
    // Rent's usual responsible party) and every Bilty's Consignor/
    // Clearing Agent (Collection's usual responsible party).
    const relevantPartyIds = new Set<string>();
    if (c.transporterPartyId) relevantPartyIds.add(c.transporterPartyId);
    for (const cb of c.bilties) {
      if (cb.bilty.consignorPartyId) relevantPartyIds.add(cb.bilty.consignorPartyId);
      if (cb.bilty.clearingAgentPartyId) relevantPartyIds.add(cb.bilty.clearingAgentPartyId);
    }
    // Party-ledger totals (every distinct party across every Challan,
    // counted once) - accumulated regardless of whether THIS Challan
    // differs, so the final totals reflect every party touched.
    const ledgerRowsForTotals: { accountName: string; closingBalance: number; balanceType: string }[] = [];
    for (const partyId of relevantPartyIds) {
      if (countedPartyAccountIds.has(partyId)) continue;
      countedPartyAccountIds.add(partyId);
      try {
        const ledger = await getPartyLedgerData(partyId, { order: "desc", includeOpeningBalanceRow: false });
        ledgerRowsForTotals.push({ accountName: ledger.account.accountName, closingBalance: ledger.summary.closingBalance, balanceType: ledger.summary.balanceType });
        if (ledger.summary.closingBalance > EPS) partyLedgerReceivableTotal = round2(partyLedgerReceivableTotal + ledger.summary.closingBalance);
        else if (ledger.summary.closingBalance < -EPS) partyLedgerPayableTotal = round2(partyLedgerPayableTotal + Math.abs(ledger.summary.closingBalance));
      } catch {
        // Party/account not resolvable (e.g. deactivated) - skip, never fabricate.
      }
    }

    const receivedDiff = round2(toPayPaid - oldReceived);
    const receivableDiff = round2(newReceivable - oldReceivable);
    const payableDiff = round2(newPayable - oldPayable);

    if (Math.abs(receivedDiff) <= EPS && Math.abs(receivableDiff) <= EPS && Math.abs(payableDiff) <= EPS) {
      continue; // unchanged - never printed.
    }
    differing++;

    // Diagnostic facts (never a single guessed "reason") - lets a
    // reviewer see which tier/mechanism is at play (see this script's
    // own header comment for the 4 possible causes).
    const hasLiveToPayRows = fresh.bilties.some((b) => b.toPay.payers.length > 0 && !b.toPay.isHistoricalFallback);
    const hasLiveCarrierRentRows = fresh.carrierRent.payers.length > 0 && !fresh.carrierRent.isHistoricalFallback;
    const toPayViaFallback = fresh.bilties.some((b) => b.toPay.isHistoricalFallback && b.toPay.paidOrReceived > EPS);
    const carrierRentViaFallback = fresh.carrierRent.isHistoricalFallback && fresh.carrierRent.paidOrReceived > EPS;
    const collectionPartyIds = new Set(fresh.bilties.flatMap((b) => b.toPay.payers.map((p) => p.partyId).filter(Boolean)));
    const carrierRentPartyIds = new Set(fresh.carrierRent.payers.map((p) => p.partyId).filter(Boolean));
    const sharedPartyAcrossComponents = [...collectionPartyIds].some((id) => carrierRentPartyIds.has(id));

    console.log(`\nChallan ${c.challanNo} (${c.id})`);
    console.log(`  Received:   before ${oldReceived}  ->  after ${toPayPaid}  (${receivedDiff >= 0 ? "+" : ""}${receivedDiff})`);
    console.log(`  Receivable: before ${oldReceivable}  ->  after ${newReceivable}  (${receivableDiff >= 0 ? "+" : ""}${receivableDiff})  badge: ${old.status} -> ${badge(toPayPaid, newReceivable, toPayTotal)}`);
    console.log(`  Payable:    before ${oldPayable}  ->  after ${newPayable}  (${payableDiff >= 0 ? "+" : ""}${payableDiff})  badge: ${old.status} -> ${badge(fresh.carrierRent.paidOrReceived, newPayable, fresh.carrierRent.total)}`);
    console.log(
      `  Diagnostic: live To-Pay rows=${hasLiveToPayRows}, live Carrier Rent rows=${hasLiveCarrierRentRows}, To-Pay via Daily-Posting/advance fallback=${toPayViaFallback}, Carrier Rent via fallback=${carrierRentViaFallback}, same party responsible for both components=${sharedPartyAcrossComponents}`
    );
    for (const row of ledgerRowsForTotals) {
      console.log(`  Party Ledger - ${row.accountName}: closing balance Rs. ${row.closingBalance} (${row.balanceType})`);
    }
  }

  console.log(`\n=== ${differing} of ${challans.length} Challan(s) show a different Received/Receivable/Payable figure after this fix ===`);
  console.log(`Receivable totals: before ${oldReceivableTotal}  ->  after ${newReceivableTotal}  |  sum of every touched party's own ledger RECEIVABLE balance: ${partyLedgerReceivableTotal}`);
  console.log(`Payable totals:    before ${oldPayableTotal}  ->  after ${newPayableTotal}  |  sum of every touched party's own ledger PAYABLE balance: ${partyLedgerPayableTotal}`);
  console.log(`(Party ledger totals are a cross-check, not a target to match exactly - a party's own ledger blends EVERY Challan/Bilty/Phonch/etc. they are involved in, not just the ones audited here.)`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
