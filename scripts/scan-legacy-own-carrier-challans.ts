// READ-ONLY AUDIT SCRIPT - makes no writes of any kind. Safe to run
// against any database (including production) for a one-time
// inspection.
//
// Finds legacy Challans dispatched BEFORE the Own Carrier module
// existed, under a real external Transporter Party (typically "Al
// Naeem Cargo" or a close spelling of it) that is actually ANC's own
// fleet - matched either by that Party, or by Challan.carrierNumber
// matching a real OwnCarrier's own carrierNumber (normalizing the
// documented "CBM"/"CMB" transposition typo). For each match, prints
// exactly what lib/challan-own-carrier-conversion.ts's
// computeConversionImpact() would reverse if converted, plus whether
// it is currently eligible (see that function's own `blockers`).
//
// Usage:  npx tsx scripts/scan-legacy-own-carrier-challans.ts [partyNameContains]
// (reads DATABASE_URL from the environment exactly like the app
// itself - point it at whichever database you intend to inspect.
// Defaults to "Al Naeem Cargo" if no argument is given.)
import { PrismaClient } from "@prisma/client";
import { computeConversionImpact, normalizeCarrierNumber } from "../lib/challan-own-carrier-conversion";

const prisma = new PrismaClient();

async function main() {
  const partyNameContains = process.argv[2] || "Al Naeem Cargo";

  const party = await prisma.party.findFirst({
    where: { partyName: { contains: partyNameContains, mode: "insensitive" } },
    select: { id: true, partyName: true },
  });
  console.log(`Matching Party ("${partyNameContains}"):`, party ? `${party.partyName} (${party.id})` : "none found");

  const carriers = await prisma.ownCarrier.findMany({
    where: { isDeleted: false },
    select: { id: true, carrierNumber: true },
  });
  const byNormalizedNumber = new Map(carriers.map((c) => [normalizeCarrierNumber(c.carrierNumber), c]));
  console.log(`Active Own Carriers: ${carriers.map((c) => c.carrierNumber).join(", ") || "none"}`);

  const candidates = await prisma.challan.findMany({
    where: {
      isDeleted: false,
      ownCarrierId: null,
      OR: [
        ...(party ? [{ transporterPartyId: party.id }] : []),
        { carrierNumber: { not: null } },
      ],
    },
    select: {
      id: true,
      challanNo: true,
      loadingDate: true,
      carrierNumber: true,
      transporterPartyId: true,
      transporterParty: { select: { partyName: true } },
    },
    orderBy: { loadingDate: "asc" },
  });

  const matches = candidates.filter((c) => {
    if (party && c.transporterPartyId === party.id) return true;
    if (c.carrierNumber && byNormalizedNumber.has(normalizeCarrierNumber(c.carrierNumber))) return true;
    return false;
  });

  if (matches.length === 0) {
    console.log("\nNo legacy own-carrier Challans found.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\nFound ${matches.length} legacy Challan(s):\n`);

  let totalCarrierRent = 0;
  let totalBookingIncome = 0;
  let eligibleCount = 0;

  for (const c of matches) {
    const impact = await computeConversionImpact(prisma, c.id);
    totalCarrierRent += impact.totalCarrierRentToReverse;
    totalBookingIncome += impact.totalBookingIncomeToReverse;
    if (impact.blockers.length === 0) eligibleCount++;

    console.log(`--- Challan ${c.challanNo} (${c.id}) ---`);
    console.log(`  Date: ${c.loadingDate.toISOString().slice(0, 10)} | Status: ${impact.status} | Settled: ${impact.isSettled}`);
    console.log(`  Transporter: ${c.transporterParty?.partyName ?? "-"} | carrierNumber field: ${c.carrierNumber ?? "-"}`);
    console.log(`  Current Carrier Rent (Challan.carrierRent field): Rs. ${impact.challanCarrierRentField.toLocaleString()}`);
    console.log(`  Carrier Rent to reverse (signed net of every live entry below): Rs. ${impact.totalCarrierRentToReverse.toLocaleString()}`);
    for (const e of impact.carrierRentEntries) {
      console.log(`    - ${e.referenceType} (${e.journalEntryId}): ${e.amount >= 0 ? "+" : ""}Rs. ${e.amount.toLocaleString()} dated ${e.entryDate.toISOString().slice(0, 10)}`);
    }
    console.log(`  Current Booking Income (total to reverse): Rs. ${impact.totalBookingIncomeToReverse.toLocaleString()}`);
    for (const b of impact.bilties) {
      console.log(`    - Bilty ${b.biltyNo}: total Rs. ${b.total.toLocaleString()}, currently in Booking Income Rs. ${b.currentBookingIncomeNet.toLocaleString()}${b.needsManualReview ? " [NEEDS MANUAL REVIEW]" : ""} (from ${b.sourceEntries.length} source entry/entries)`);
    }
    console.log(`  Settlement entries present: ${impact.settlementEntriesPresent}`);
    console.log(`  Active Daily Posting payment rows: ${impact.activeSettlementPaymentCount}${impact.activeSettlementPaymentCount > 0 ? " (kept - real receipts, unaffected by this conversion)" : ""}`);
    if (impact.ancPartyNetBalanceBefore !== null) {
      console.log(`  ${c.transporterParty?.partyName ?? "Party"} balance from this Challan - before: Rs. ${impact.ancPartyNetBalanceBefore.toLocaleString()}, after conversion: Rs. ${(impact.ancPartyNetBalanceAfter ?? 0).toLocaleString()}`);
    }
    if (impact.blockers.length > 0) {
      console.log(`  BLOCKED: ${impact.blockers.join(" | ")}`);
    } else {
      console.log(`  Eligible for automatic conversion.`);
    }
    console.log("");
  }

  console.log("=== TOTALS ===");
  console.log(`Challans found: ${matches.length} (${eligibleCount} currently eligible for automatic conversion)`);
  console.log(`Total Booking Income that would move back to Unearned Revenue: Rs. ${totalBookingIncome.toLocaleString()}`);
  console.log(`Total Carrier Rent expense/payable that would be reversed: Rs. ${totalCarrierRent.toLocaleString()}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
