// READ-ONLY SCAN - no writes, ever. Safe to run against production.
//
// Lists every own-carrier Challan (ownCarrierId set, not deleted)
// that still has:
//  (a) a LIVE (non-reversed) CHALLAN_DISPATCH/CHALLAN_DISPATCH_
//      CORRECTION entry whose Carrier Rent reclassification credits
//      a PARTY account DIRECTLY (the pre-Gross-accounting-era
//      dispatch pattern - see lib/challan-own-carrier-conversion.ts's
//      own header) rather than the Gross Carrier Rent Payable
//      suspense account, and/or
//  (b) a nonzero NET balance on any PARTY account from Carrier-Rent-
//      scoped lines (sourceType=CHALLAN, sourceId=this Challan) -
//      checked independently of (a)'s reversal status, since a
//      reversal computed with the wrong amount (see
//      computeConversionImpact's own doc comment referencing the
//      Challan 6506/6402 production bug) can leave genuine residue
//      even though a reversal entry technically exists.
//
// An own-carrier Challan must NEVER have either - this is the exact
// production symptom ("Payable Rs X to [Transporter]" on an own-
// carrier Challan) reported against Challan 6402. No writes; any
// correction requires separate, explicit approval per Challan.
//
// Run: npx tsx scripts/scan-own-carrier-stale-dispatch.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function main() {
  const grossCarrierRentAccount = await prisma.account.findFirst({
    where: { accountCode: "GROSS-CARRIER-RENT-PAYABLE" },
    select: { id: true },
  });
  const grossAccountId = grossCarrierRentAccount?.id ?? null;

  const ownCarrierChallans = await prisma.challan.findMany({
    where: { ownCarrierId: { not: null }, isDeleted: false },
    select: { id: true, challanNo: true, ownCarrier: { select: { carrierNumber: true } }, carrierRent: true, isSettled: true },
    orderBy: { challanNo: "asc" },
  });

  console.log(`Scanning ${ownCarrierChallans.length} own-carrier Challan(s)...\n`);

  let flaggedCount = 0;

  for (const challan of ownCarrierChallans) {
    const dispatchEntries = await prisma.journalEntry.findMany({
      where: {
        referenceType: { in: ["CHALLAN_DISPATCH", "CHALLAN_DISPATCH_CORRECTION"] },
        referenceId: challan.id,
        isDeleted: false,
      },
      include: { lines: { include: { account: { select: { id: true, accountName: true, category: true, party: { select: { partyName: true } } } } } } },
    });

    const reversedIds = new Set(
      (
        await prisma.journalEntry.findMany({
          where: { reversesEntryId: { in: dispatchEntries.map((e) => e.id) }, isDeleted: false },
          select: { reversesEntryId: true },
        })
      ).map((e) => e.reversesEntryId)
    );

    const liveDirectPartyEntries = dispatchEntries.filter(
      (e) =>
        !reversedIds.has(e.id) &&
        e.lines.some((l) => l.account.category === "PARTY" && Number(l.credit) > 0.009 && l.accountId !== grossAccountId)
    );

    // Independent net-balance check across EVERY line (reversed or
    // not) tagged to this Challan on a PARTY account - catches a
    // wrongly-sized reversal too, not just a missing one.
    const allChallanLines = await prisma.journalLine.findMany({
      where: { sourceType: "CHALLAN", sourceId: challan.id, journalEntry: { isDeleted: false } },
      include: { account: { select: { id: true, accountName: true, category: true, party: { select: { partyName: true } } } } },
    });
    const netByPartyAccount = new Map<string, { name: string; net: number }>();
    for (const l of allChallanLines) {
      if (l.account.category !== "PARTY") continue;
      const cur = netByPartyAccount.get(l.accountId) || { name: `${l.account.accountName}${l.account.party ? ` (${l.account.party.partyName})` : ""}`, net: 0 };
      cur.net += Number(l.debit) - Number(l.credit);
      netByPartyAccount.set(l.accountId, cur);
    }
    const nonzeroPartyBalances = [...netByPartyAccount.entries()].filter(([, v]) => Math.abs(v.net) > 0.01);

    if (liveDirectPartyEntries.length === 0 && nonzeroPartyBalances.length === 0) continue;

    flaggedCount++;
    console.log(`Challan ${challan.challanNo} (own carrier ${challan.ownCarrier?.carrierNumber}) - carrierRent field: Rs. ${Number(challan.carrierRent).toLocaleString()}, isSettled: ${challan.isSettled}`);

    for (const e of liveDirectPartyEntries) {
      const partyLine = e.lines.find((l) => l.account.category === "PARTY" && Number(l.credit) > 0.009);
      console.log(
        `  LIVE legacy direct-to-party entry: JournalEntry ${e.id} [${e.referenceType}] dated ${e.entryDate.toISOString().slice(0, 10)} - credits ${partyLine?.account.accountName}${partyLine?.account.party ? ` (${partyLine.account.party.partyName})` : ""} Rs. ${Number(partyLine?.credit || 0).toLocaleString()} - "${e.description}"`
      );
    }
    for (const [accountId, v] of nonzeroPartyBalances) {
      console.log(`  NONZERO party balance from Carrier-Rent-scoped lines: ${v.name} [${accountId}]: net ${v.net > 0 ? "DEBIT" : "CREDIT"} Rs. ${round2(Math.abs(v.net)).toLocaleString()}`);
    }
    console.log("");
  }

  console.log(`=== ${flaggedCount} of ${ownCarrierChallans.length} own-carrier Challan(s) flagged. No changes have been made - this is a read-only scan. ===`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
