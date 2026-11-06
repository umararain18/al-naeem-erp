// READ-ONLY. Lists every Challan settled via the "nothing to settle"
// path (isSettled: true, settlementJournalEntryId: null - see
// app/api/challan/[id]/finalize-settlement/route.ts's own
// ownCarrierNothingToSettle) alongside each of its own Bilty's
// current Gross Bilty Receivable balance and expected Paid party -
// flagging any Bilty where Gross is still non-zero, the exact
// production Challan 6405 / Bilty 395 signature (Paid 150,000, Paid
// Account "DS Motors" resolvable, but never actually attributed out
// of Gross before this path marked the Challan settled with no entry
// at all).
//
// Never writes anything - this is purely diagnostic. Re-run
// scripts/scan-own-carrier-double-collected-bilties.ts separately for
// the DIFFERENT (over-collection) signature that script covers.
//
// Usage: npx tsx scripts/scan-nothing-to-settle-gross-leftover.ts

import { PrismaClient } from "@prisma/client";
import { getGrossBiltyReceivableAccountId } from "../lib/gross-accounts";
import { resolveBiltyPaidResponsibleParty } from "../lib/document-party-resolution";

const prisma = new PrismaClient();

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function main() {
  const grossAccountId = await getGrossBiltyReceivableAccountId(prisma);

  const challans = await prisma.challan.findMany({
    where: { isSettled: true, settlementJournalEntryId: null, isDeleted: false },
    select: {
      id: true,
      challanNo: true,
      ownCarrier: { select: { carrierNumber: true } },
      bilties: { select: { biltyId: true, bilty: { select: { biltyNo: true, advance: true, toPay: true, isDeleted: true } } } },
    },
  });

  console.log(`Found ${challans.length} Challan(s) settled via "nothing to settle" (settlementJournalEntryId = null).\n`);

  let flaggedCount = 0;
  let totalLeftover = 0;

  for (const challan of challans) {
    for (const cb of challan.bilties) {
      if (cb.bilty.isDeleted) continue;

      const lines = await prisma.journalLine.findMany({
        where: { accountId: grossAccountId, sourceType: "BILTY", sourceId: cb.biltyId, journalEntry: { isDeleted: false } },
        select: { debit: true, credit: true },
      });
      const grossBalance = round2(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));

      if (Math.abs(grossBalance) <= 0.009) continue; // genuinely nothing left - the common, correct case

      flaggedCount++;
      totalLeftover = round2(totalLeftover + grossBalance);

      const expectedPaidParty = await resolveBiltyPaidResponsibleParty(cb.biltyId, prisma);
      const paidRow = await prisma.settlementPayment.findFirst({ where: { component: "PAID", biltyId: cb.biltyId, isActive: true }, select: { id: true } });

      console.log(`FLAGGED: Challan ${challan.challanNo} (${challan.id})${challan.ownCarrier ? ` / Carrier ${challan.ownCarrier.carrierNumber}` : ""} / Bilty ${cb.bilty.biltyNo} (${cb.biltyId})`);
      console.log(`  Gross Bilty Receivable balance (debit-credit): Rs. ${grossBalance.toLocaleString()} ${grossBalance > 0 ? "(still a debit - Gross never cleared)" : "(credit - over-cleared, investigate)"}`);
      console.log(`  Bilty.advance (Paid): Rs. ${Number(cb.bilty.advance).toLocaleString()}  |  Bilty.toPay: Rs. ${Number(cb.bilty.toPay).toLocaleString()}`);
      console.log(`  Expected Paid party: ${expectedPaidParty ? `${expectedPaidParty.partyName} (${expectedPaidParty.accountId})` : "(unresolvable - no Consignor/Consignee/explicit choice)"}`);
      console.log(`  PAID SettlementPayment row already established: ${paidRow ? "YES" : "NO"}\n`);
    }
  }

  console.log("====================================================================");
  console.log(`${flaggedCount} Bilty(s) flagged with a non-zero Gross Bilty Receivable balance despite their own Challan being settled via "nothing to settle", total Rs. ${totalLeftover.toLocaleString()}.`);
  console.log("Read-only scan - no changes made. Re-run Finalize Settlement on each flagged Challan (after this PR's own fix) to establish the missing Paid attribution.");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
