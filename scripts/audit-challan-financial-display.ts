// READ-ONLY AUDIT - no writes, ever. Safe to run against production.
//
// This audit is specific to the MINIMAL fix in this branch, which
// keeps lib/challan-financials.ts's and lib/challan-settlement-
// summary.ts's overall architecture exactly as it was (the e3449d6
// baseline) and patches only three narrow mechanisms:
//
//  (a) List "Received": computeChallanFinancialsBatch() used to
//      resolve ONE owner Challan per whole DAILY_POSTING JournalEntry
//      (first matching line wins), then sum EVERY PARTY-category line
//      in that entry onto that one owner. A combined/multi-document
//      Daily Posting voucher can legitimately carry several unrelated
//      Bilties'/Challans' own lines (each line has its OWN
//      sourceType/sourceId - see app/api/daily-posting/route.ts), so
//      this leaked an unrelated line's credit onto whichever Challan
//      happened to be checked first, inflating "Received".
//  (b) List "Payable" (same mechanism, debit side): the same per-
//      ENTRY attribution could also leak an unrelated PARTY line's
//      debit onto the wrong Challan, under/over-counting "Paid" and
//      therefore `remainingPayable`.
//  (c) Detail Carrier Rent / To-Pay card: computeChallanSettlementSummaryBatch()
//      used to fall back, whenever no live SettlementPayment row
//      existed for a component, to the settlement's own CURRENT
//      reclassification-entry attribution (getComponentNetAmount) and
//      treat that number AS IF it were a real payment/receipt. That
//      reclassification entry only records who currently owes/is owed
//      the amount - never that cash/bank actually moved - so this
//      could show a component as fully "Paid"/"Received" (CLEARED)
//      with zero actual payment anywhere.
//
// This script compares, for every non-deleted Challan, the CURRENT
// (fixed, this branch's) output of both functions against a FROZEN,
// self-contained reimplementation of the exact PRE-FIX buggy logic
// (reproduced verbatim below from the e3449d6 baseline) - never two
// different "models" being reconciled, just the same two functions'
// old vs new behavior. For every Challan where they differ, this
// script prints EXACTLY which bug (a/b/c) caused it, plus the
// relevant parties' CURRENT Party Ledger closing balance (via the
// same lib/ledger-description.ts getPartyLedgerData() the Party
// Ledger screen itself uses).
//
// Usage:
//   npx tsx scripts/audit-challan-financial-display.ts
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { computeChallanFinancialsBatch } from "../lib/challan-financials";
import { computeChallanSettlementSummaryBatch } from "../lib/challan-settlement-summary";
import { getComponentNetAmount, getSettledPartyAccountIdsBatch } from "../lib/settlement-correction";
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

// ============================================================
// FROZEN pre-fix reference implementation #1 (bugs a/b): the exact
// per-ENTRY attribution logic computeChallanFinancialsBatch() used to
// run before this branch's fix - "first matching line of the entry
// wins the WHOLE entry for every PARTY line", reproduced verbatim so
// this script can show what the list USED to display, independent of
// what the real (now-fixed) function in lib/challan-financials.ts
// does today.
// ============================================================
async function computeOldBuggyReceivedPaid(
  challanIds: string[],
  biltyToChallan: Map<string, string>
): Promise<{ receivedMap: Map<string, Decimal>; paidMap: Map<string, Decimal> }> {
  const receivedMap = new Map<string, Decimal>();
  const paidMap = new Map<string, Decimal>();
  for (const id of challanIds) {
    receivedMap.set(id, new Decimal(0));
    paidMap.set(id, new Decimal(0));
  }
  if (challanIds.length === 0) return { receivedMap, paidMap };

  const biltyIdList = [...biltyToChallan.keys()];
  const entries = await prisma.journalEntry.findMany({
    where: {
      referenceType: "DAILY_POSTING",
      isDeleted: false,
      lines: {
        some: {
          OR: [
            { sourceType: "CHALLAN", sourceId: { in: challanIds } },
            ...(biltyIdList.length > 0 ? [{ sourceType: "BILTY", sourceId: { in: biltyIdList } }] : []),
          ],
        },
      },
    },
    include: { lines: { include: { account: { select: { category: true } } } } },
  });

  for (const entry of entries) {
    // Resolve which Challan this ENTRY belongs to (once per entry) -
    // the pre-fix bug: the FIRST matching line wins for every other
    // line in the same entry too.
    let owner: string | null = null;
    for (const line of entry.lines) {
      const sid = line.sourceId;
      if (!sid) continue;
      if (line.sourceType === "CHALLAN" && challanIds.includes(sid)) {
        owner = sid;
        break;
      }
      if (line.sourceType === "BILTY" && biltyToChallan.has(sid)) {
        owner = biltyToChallan.get(sid) as string;
        break;
      }
    }
    if (!owner) continue;

    // Sum EVERY PARTY-side line of this entry onto that one owner -
    // including lines that actually belong to a DIFFERENT
    // Bilty/Challan than `owner` when the entry is a combined voucher.
    for (const line of entry.lines) {
      if (line.account?.category === "PARTY") {
        receivedMap.set(owner, receivedMap.get(owner)!.plus(new Decimal(line.credit)));
        paidMap.set(owner, paidMap.get(owner)!.plus(new Decimal(line.debit)));
      }
    }
  }

  return { receivedMap, paidMap };
}

// ============================================================
// FROZEN pre-fix reference implementation #2 (bug c): the exact
// historical-fallback logic computeChallanSettlementSummaryBatch()
// used to run before this branch's fix, reproduced verbatim -
// whenever a component has zero live SettlementPayment rows on an
// already-settled Challan, treat the settlement's own current
// reclassification-entry attribution as if it were a real payment.
// ============================================================
async function computeOldFallbackAttributed(
  challanId: string,
  settlementJournalEntryId: string,
  component: "COLLECTION" | "CARRIER_RENT",
  incomeOrExpenseAccountId: string,
  biltyId: string | null,
  oldPartyAccountId: string | null
): Promise<number> {
  if (!oldPartyAccountId) return 0;
  const net = await getComponentNetAmount(
    prisma,
    challanId,
    settlementJournalEntryId,
    component,
    incomeOrExpenseAccountId,
    biltyId,
    oldPartyAccountId
  );
  // CARRIER_RENT's net convention is a CREDIT (negative); COLLECTION's
  // is a DEBIT (positive) - same sign-normalization the removed code used.
  return component === "CARRIER_RENT" ? Math.max(0, round2(-net)) : Math.max(0, round2(net));
}

async function main() {
  const challans = await prisma.challan.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      challanNo: true,
      carrierRent: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      isSettled: true,
      settlementJournalEntryId: true,
      transporterPartyId: true,
      bilties: {
        select: {
          biltyId: true,
          bilty: { select: { id: true, toPay: true, isDeleted: true, consignorPartyId: true, clearingAgentPartyId: true } },
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

  const challanIds = challans.map((c) => c.id);
  const biltyToChallan = new Map<string, string>();
  for (const c of challans) for (const cb of c.bilties) biltyToChallan.set(cb.biltyId, c.id);

  const [bookingIncomeAccount, carrierRentExpenseAccount] = await Promise.all([
    prisma.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } }),
    prisma.account.findFirst({ where: { category: "CARRIER_RENT", isActive: true }, select: { id: true } }),
  ]);

  const [newFinancials, newSettlementSummary, oldBuggy] = await Promise.all([
    computeChallanFinancialsBatch(
      challans.map((c) => ({
        id: c.id,
        outstandingReceivable: c.outstandingReceivable,
        outstandingPayable: c.outstandingPayable,
        biltyIds: c.bilties.map((b) => b.biltyId),
      }))
    ),
    computeChallanSettlementSummaryBatch(challanIds),
    computeOldBuggyReceivedPaid(challanIds, biltyToChallan),
  ]);

  let differing = 0;
  let bugACount = 0;
  let bugBCount = 0;
  let bugCCount = 0;
  let oldReceivableTotal = 0;
  let newReceivableTotal = 0;
  let oldPayableTotal = 0;
  let newPayableTotal = 0;
  let partyLedgerReceivableTotal = 0;
  let partyLedgerPayableTotal = 0;
  const countedPartyIds = new Set<string>();

  for (const c of challans) {
    const receivable = round2(Number(c.outstandingReceivable));
    const payable = round2(Number(c.outstandingPayable));

    const oldReceived = round2((oldBuggy.receivedMap.get(c.id) || new Decimal(0)).toNumber());
    const oldPaid = round2((oldBuggy.paidMap.get(c.id) || new Decimal(0)).toNumber());
    const oldRemainingReceivable = Math.max(0, round2(receivable - oldReceived));
    const oldRemainingPayable = Math.max(0, round2(payable - oldPaid));

    const fresh = newFinancials[c.id];
    const newReceived = round2(fresh.received);
    const newPaid = round2(fresh.paid);
    const newRemainingReceivable = round2(fresh.remainingReceivable);
    const newRemainingPayable = round2(fresh.remainingPayable);

    oldReceivableTotal = round2(oldReceivableTotal + oldRemainingReceivable);
    newReceivableTotal = round2(newReceivableTotal + newRemainingReceivable);
    oldPayableTotal = round2(oldPayableTotal + oldRemainingPayable);
    newPayableTotal = round2(newPayableTotal + newRemainingPayable);

    const bugA = Math.abs(oldReceived - newReceived) > EPS;
    const bugB = Math.abs(oldPaid - newPaid) > EPS;

    // Bug (c): detail Carrier Rent / To-Pay card. Only relevant for a
    // settled Challan with a settlement entry; only computed for a
    // component that has ZERO live SettlementPayment rows (the only
    // condition under which the removed fallback ever applied).
    let bugCToPay = false;
    let oldToPayFallbackTotal = 0;
    let bugCCarrierRent = false;
    let oldCarrierRentFallback = 0;

    const freshSummary = newSettlementSummary[c.id];

    if (c.isSettled && c.settlementJournalEntryId) {
      const settlementJournalEntryId = c.settlementJournalEntryId;

      if (bookingIncomeAccount) {
        const liveBilties = c.bilties.filter((cb) => !cb.bilty.isDeleted);
        const lookupRequests = liveBilties.map((cb) => ({
          component: "COLLECTION" as const,
          incomeOrExpenseAccountId: bookingIncomeAccount.id,
          biltyId: cb.bilty.id,
        }));
        const oldPartyAccountIds = lookupRequests.length > 0
          ? await getSettledPartyAccountIdsBatch(prisma, c.id, settlementJournalEntryId, lookupRequests)
          : [];

        for (let i = 0; i < liveBilties.length; i++) {
          const cb = liveBilties[i];
          const toPay = round2(Number(cb.bilty.toPay || 0));
          if (toPay <= 0) continue;
          const freshBilty = freshSummary?.bilties.find((b) => b.biltyId === cb.bilty.id);
          const hasLiveRows = (freshBilty?.toPay.payers.length || 0) > 0;
          if (hasLiveRows) continue; // live rows always took precedence, before AND after the fix.

          const attributed = await computeOldFallbackAttributed(
            c.id,
            settlementJournalEntryId,
            "COLLECTION",
            bookingIncomeAccount.id,
            cb.bilty.id,
            oldPartyAccountIds[i]
          );
          if (attributed > EPS) {
            oldToPayFallbackTotal = round2(oldToPayFallbackTotal + attributed);
          }
        }
        if (oldToPayFallbackTotal > EPS) bugCToPay = true;
      }

      const carrierRentTotal = round2(Number(c.carrierRent || 0));
      if (carrierRentExpenseAccount && carrierRentTotal > 0) {
        const hasLiveRows = (freshSummary?.carrierRent.payers.length || 0) > 0;
        if (!hasLiveRows) {
          const [oldCarrierRentPartyAccountId] = await getSettledPartyAccountIdsBatch(
            prisma,
            c.id,
            settlementJournalEntryId,
            [{ component: "CARRIER_RENT", incomeOrExpenseAccountId: carrierRentExpenseAccount.id, biltyId: null }]
          );
          oldCarrierRentFallback = await computeOldFallbackAttributed(
            c.id,
            settlementJournalEntryId,
            "CARRIER_RENT",
            carrierRentExpenseAccount.id,
            null,
            oldCarrierRentPartyAccountId
          );
          if (oldCarrierRentFallback > EPS) bugCCarrierRent = true;
        }
      }
    }

    if (!bugA && !bugB && !bugCToPay && !bugCCarrierRent) continue;
    differing++;
    if (bugA) bugACount++;
    if (bugB) bugBCount++;
    if (bugCToPay || bugCCarrierRent) bugCCount++;

    const bugsTriggered = [bugA && "a", bugB && "b", bugCToPay && "c(To-Pay)", bugCCarrierRent && "c(Carrier Rent)"].filter(Boolean).join(", ");

    console.log(`\nChallan ${c.challanNo} (${c.id}) - bug(s): ${bugsTriggered}`);
    if (bugA) {
      console.log(`  [a] List Received: before ${oldReceived} -> after ${newReceived} (${round2(newReceived - oldReceived) >= 0 ? "+" : ""}${round2(newReceived - oldReceived)})`);
      console.log(`      List Receivable: before ${oldRemainingReceivable} -> after ${newRemainingReceivable}`);
    }
    if (bugB) {
      console.log(`  [b] List Paid: before ${oldPaid} -> after ${newPaid} (${round2(newPaid - oldPaid) >= 0 ? "+" : ""}${round2(newPaid - oldPaid)})`);
      console.log(`      List Payable: before ${oldRemainingPayable} -> after ${newRemainingPayable}`);
    }
    if (bugCToPay && freshSummary) {
      const newToPayPaid = round2(freshSummary.bilties.reduce((s, b) => s + b.toPay.paidOrReceived, 0));
      const newToPayTotal = round2(freshSummary.bilties.reduce((s, b) => s + b.toPay.total, 0));
      const newToPayRemaining = round2(freshSummary.bilties.reduce((s, b) => s + b.toPay.remaining, 0));
      const oldToPayRemaining = round2(newToPayTotal - oldToPayFallbackTotal);
      console.log(`  [c] Detail To-Pay card: paidOrReceived before ${oldToPayFallbackTotal} (via settlement-reclassification fallback, NOT a real payment) -> after ${newToPayPaid}`);
      console.log(`      badge: before ${badge(oldToPayFallbackTotal, oldToPayRemaining, newToPayTotal)} -> after ${badge(newToPayPaid, newToPayRemaining, newToPayTotal)}`);
    }
    if (bugCCarrierRent && freshSummary) {
      const cr = freshSummary.carrierRent;
      const oldCarrierRentRemaining = round2(cr.total - oldCarrierRentFallback);
      console.log(`  [c] Detail Carrier Rent card: paidOrReceived before ${oldCarrierRentFallback} (via settlement-reclassification fallback, NOT a real payment) -> after ${cr.paidOrReceived}`);
      console.log(`      badge: before ${badge(oldCarrierRentFallback, oldCarrierRentRemaining, cr.total)} -> after ${badge(cr.paidOrReceived, cr.remaining, cr.total)}`);
    }

    // Relevant parties for this Challan - Transporter (Carrier Rent's
    // usual responsible party) and every Bilty's Consignor/Clearing
    // Agent (Collection's usual responsible party) - printed once per
    // distinct party across every differing Challan.
    const relevantPartyIds = new Set<string>();
    if (c.transporterPartyId) relevantPartyIds.add(c.transporterPartyId);
    for (const cb of c.bilties) {
      if (cb.bilty.consignorPartyId) relevantPartyIds.add(cb.bilty.consignorPartyId);
      if (cb.bilty.clearingAgentPartyId) relevantPartyIds.add(cb.bilty.clearingAgentPartyId);
    }
    for (const partyId of relevantPartyIds) {
      try {
        const ledger = await getPartyLedgerData(partyId, { order: "desc", includeOpeningBalanceRow: false });
        console.log(`  Party Ledger - ${ledger.party.partyName}: closing balance Rs. ${ledger.summary.closingBalance} (${ledger.summary.balanceType})`);
        if (!countedPartyIds.has(partyId)) {
          countedPartyIds.add(partyId);
          if (ledger.summary.closingBalance > EPS) partyLedgerReceivableTotal = round2(partyLedgerReceivableTotal + ledger.summary.closingBalance);
          else if (ledger.summary.closingBalance < -EPS) partyLedgerPayableTotal = round2(partyLedgerPayableTotal + Math.abs(ledger.summary.closingBalance));
        }
      } catch {
        // Party/account not resolvable (e.g. deactivated) - skip, never fabricate.
      }
    }
  }

  console.log(`\n=== ${differing} of ${challans.length} Challan(s) differ: bug(a)=${bugACount}, bug(b)=${bugBCount}, bug(c)=${bugCCount} ===`);
  console.log(`List Receivable totals: before ${oldReceivableTotal} -> after ${newReceivableTotal}  |  sum of every touched party's own ledger RECEIVABLE balance: ${partyLedgerReceivableTotal}`);
  console.log(`List Payable totals:    before ${oldPayableTotal} -> after ${newPayableTotal}  |  sum of every touched party's own ledger PAYABLE balance: ${partyLedgerPayableTotal}`);
  console.log(`(Party ledger totals are a cross-check, not a target to match exactly - a party's own ledger blends EVERY Challan/Bilty/Phonch/etc. they are involved in, not just the ones audited here.)`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
