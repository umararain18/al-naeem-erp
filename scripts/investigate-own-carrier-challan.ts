// READ-ONLY INVESTIGATION - no writes, ever. Safe to run against
// production (point DATABASE_URL at production, or run it there
// directly) to diagnose own-carrier Challan accounting discrepancies
// reported against Challan 6402/6406 (own carrier CBM-191).
//
// Prints, for each --challan=<No>[,<No>...]:
//  - The Challan's own fields (ownCarrier/transporter, carrierRent,
//    isSettled/settledAt, status).
//  - Every linked Trip (any carrier) with its own carrierRentAmount.
//  - Every Bilty on the Challan (total/toPay/advance/consignor/
//    consignee/clearingAgent).
//  - EVERY live JournalLine tagged to this Challan or any of its
//    Bilties (sourceType CHALLAN/sourceId=challanId, or sourceType
//    BILTY/sourceId in biltyIds) - date, account, party (if any),
//    Dr/Cr, referenceType, whether it is itself a reversal or has
//    BEEN reversed, and which CODE PATH that referenceType maps to.
//  - The resulting net balance per account from just those lines -
//    a nonzero PARTY account net here that nothing in the current
//    own-carrier settlement flow could have produced is the
//    smoking gun for a stale pre-conversion entry.
//  - Every CarrierTripLine COLLECTION row posted against this exact
//    document (any Trip), for cross-reference against what a Trip's
//    own "outstanding" figure currently shows.
//
// Run: npx tsx scripts/investigate-own-carrier-challan.ts --challan=6402,6406
// Against production: point DATABASE_URL at the production database
// for this one invocation (this script performs ZERO writes).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10) + " " + d.toISOString().slice(11, 16);
}

// referenceType -> the code path that actually posts it, for a human
// reading this dump to know where to look without re-deriving it.
const CODE_PATH_BY_REFERENCE_TYPE: Record<string, string> = {
  BILTY_BOOKING: "app/api/bilty/route.ts (Bilty creation - Dr Gross Bilty Receivable/Cr Unearned Revenue, or legacy direct Booking Income)",
  BILTY_REVENUE_RECOGNITION: "lib/bilty-revenue-recognition.ts (Bilty dispatch - Unearned Revenue -> Booking Income)",
  CHALLAN_DISPATCH: "app/api/challan/route.ts (Challan creation - LEGACY: Dr Carrier Rent Expense / Cr Transporter Party directly, never for an own-carrier Challan going forward)",
  CHALLAN_DISPATCH_CORRECTION: "app/api/challan/[id]/route.ts PATCH (Carrier Rent correction on a Transporter Challan)",
  CHALLAN_OWN_CARRIER_CONVERSION_REVERSAL: "lib/challan-own-carrier-conversion.ts convertChallanToOwnCarrier() (reverses legacy CHALLAN_DISPATCH/booking income when converting to Own Carrier)",
  SETTLEMENT: "lib/settlement-accounting.ts buildSettlementEntries() via app/api/challan/[id]/finalize-settlement/route.ts (or the older POST /settle route)",
  SETTLEMENT_CORRECTION: "lib/settlement-correction.ts (editing an already-settled Challan's responsibility)",
  SETTLEMENT_PAYMENT: "lib/settlement-payments.ts createSettlementPayment() (multi-payer Collection/Carrier Rent row)",
  SETTLEMENT_PAYMENT_CORRECTION: "lib/settlement-payments.ts updateSettlementPaymentAmount()",
  COLLECTION_MULTI_PAYER_TRANSITION: "lib/settlement-payments.ts ensureOldAttributionWithinFloor() (old-mechanism release/restore)",
  CARRIER_RENT_MULTI_PAYER_TRANSITION: "lib/settlement-payments.ts ensureOldAttributionWithinFloor() (old-mechanism release/restore)",
  CARRIER_TRIP_LINE: "lib/carrier-trip.ts postCollectionLine()/post*Line() via Trip Wasooli (app/own-carrier/.../trip/[tripId])",
  CARRIER_TRIP_LINE_REVERSAL: "lib/carrier-trip.ts reverseCarrierTripLine() (Trip Wasooli line reversed/edited)",
  CARRIER_TRIP_CLOSE: "lib/carrier-trip.ts recognizeCarrierTripChallanIncome() (Trip closed - own-carrier Challan income recognized)",
  CARRIER_TRIP_CLOSE_REVERSAL: "lib/carrier-trip.ts reverseCarrierTripChallanIncome() (Trip reopened)",
  DAILY_POSTING: "app/api/daily-posting/route.ts (manual Daily Posting receipt/payment)",
  JOURNAL_ENTRY: "app/api/journal-entries/route.ts (direct manual Journal Entry)",
};

function codePathFor(referenceType: string | null): string {
  if (!referenceType) return "(no referenceType)";
  return CODE_PATH_BY_REFERENCE_TYPE[referenceType] || `(unmapped referenceType: ${referenceType})`;
}

async function investigateChallan(challanNo: string) {
  console.log(`\n${"=".repeat(100)}`);
  console.log(`CHALLAN ${challanNo}`);
  console.log("=".repeat(100));

  const challan = await prisma.challan.findFirst({
    where: { challanNo },
    include: {
      ownCarrier: { select: { id: true, carrierNumber: true } },
      transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
      bilties: {
        select: {
          bilty: {
            select: {
              id: true,
              biltyNo: true,
              total: true,
              toPay: true,
              advance: true,
              consignorName: true,
              consigneeName: true,
              clearingAgentParty: { select: { id: true, partyName: true } },
              isDeleted: true,
            },
          },
        },
        orderBy: { addedAt: "asc" },
      },
    },
  });

  if (!challan) {
    console.log(`NOT FOUND - no Challan with challanNo "${challanNo}" in this database.`);
    return;
  }

  console.log(`id: ${challan.id}`);
  console.log(`status: ${challan.status}  isDeleted: ${challan.isDeleted}`);
  console.log(`ownCarrierId: ${challan.ownCarrierId} (${challan.ownCarrier?.carrierNumber ?? "-"})`);
  console.log(`transporterPartyId: ${challan.transporterPartyId} (${challan.transporterParty?.partyName ?? "-"})`);
  console.log(`carrierRent (Challan's own field): Rs. ${Number(challan.carrierRent).toLocaleString()}`);
  console.log(`isSettled: ${challan.isSettled}  settledAt: ${challan.settledAt ? ymd(challan.settledAt) : "-"}  settlementJournalEntryId: ${challan.settlementJournalEntryId}`);
  console.log(`loadingDate: ${ymd(challan.loadingDate)}`);

  if (challan.ownCarrierId && challan.transporterPartyId) {
    console.log(`\n*** DATA INTEGRITY WARNING: ownCarrierId AND transporterPartyId are BOTH set - these must be mutually exclusive. ***`);
  }

  // Linked Trip(s), any carrier, active or unlinked.
  const links = await prisma.carrierTripDocument.findMany({
    where: { documentType: "CHALLAN", documentId: challan.id },
    include: { trip: { select: { id: true, tripNo: true, status: true, carrierId: true, carrier: { select: { carrierNumber: true } } } } },
    orderBy: { linkedAt: "asc" },
  });
  console.log(`\n--- LINKED TRIPS (${links.length}) ---`);
  for (const l of links) {
    console.log(
      `  Trip ${l.trip.tripNo} (carrier ${l.trip.carrier.carrierNumber}, status ${l.trip.status}) - carrierRentAmount on this link: Rs. ${Number(l.carrierRentAmount).toLocaleString()} - ${l.unlinkedAt ? `UNLINKED at ${ymd(l.unlinkedAt)}` : "ACTIVE LINK"}`
    );
  }

  const activeBilties = challan.bilties.filter((cb) => !cb.bilty.isDeleted).map((cb) => cb.bilty);
  console.log(`\n--- BILTIES (${activeBilties.length}) ---`);
  for (const b of activeBilties) {
    console.log(
      `  Bilty ${b.biltyNo}: total=${Number(b.total).toLocaleString()} toPay=${Number(b.toPay).toLocaleString()} advance(Paid)=${Number(b.advance).toLocaleString()} consignor="${b.consignorName}" consignee="${b.consigneeName}" clearingAgent=${b.clearingAgentParty?.partyName ?? "-"}`
    );
  }
  const biltyIds = activeBilties.map((b) => b.id);
  const biltyNoById = new Map(activeBilties.map((b) => [b.id, b.biltyNo]));

  // Every live JournalLine tagged to this Challan or any of its Bilties.
  const lines = await prisma.journalLine.findMany({
    where: {
      OR: [
        { sourceType: "CHALLAN", sourceId: challan.id },
        { sourceType: "BILTY", sourceId: { in: biltyIds } },
      ],
    },
    include: {
      journalEntry: { select: { id: true, entryDate: true, referenceType: true, referenceId: true, description: true, reversesEntryId: true, isDeleted: true, createdAt: true } },
      account: { select: { id: true, accountName: true, category: true, party: { select: { partyName: true } } } },
    },
    orderBy: [{ journalEntry: { entryDate: "asc" } }],
  });

  const entryIds = [...new Set(lines.map((l) => l.journalEntryId))];
  const reversalsOf = await prisma.journalEntry.findMany({
    where: { reversesEntryId: { in: entryIds }, isDeleted: false },
    select: { id: true, reversesEntryId: true },
  });
  const reversedEntryIds = new Set(reversalsOf.map((r) => r.reversesEntryId));

  console.log(`\n--- JOURNAL LINES tagged to this Challan or its Bilties (${lines.length}) ---`);
  const netByAccount = new Map<string, { name: string; net: number }>();
  for (const l of lines) {
    const je = l.journalEntry;
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    const sourceLabel = l.sourceType === "BILTY" ? `Bilty ${biltyNoById.get(l.sourceId || "") ?? l.sourceId}` : `Challan ${challan.challanNo}`;
    const isReversal = Boolean(je.reversesEntryId);
    const hasBeenReversed = reversedEntryIds.has(je.id);
    const partyName = l.account.party?.partyName;

    if (!je.isDeleted) {
      const cur = netByAccount.get(l.accountId) || { name: `${l.account.accountName}${partyName ? ` (party: ${partyName})` : ""}`, net: 0 };
      cur.net += debit - credit;
      netByAccount.set(l.accountId, cur);
    }

    console.log(
      `  [${ymd(je.entryDate)}] ${je.isDeleted ? "DELETED " : ""}${isReversal ? "[REVERSAL] " : ""}${hasBeenReversed ? "[LATER REVERSED] " : ""}` +
        `${je.referenceType} - ${sourceLabel} - ${l.account.accountName}${partyName ? ` (${partyName})` : ""} [${l.account.category}]: ` +
        `Dr ${debit.toLocaleString()} / Cr ${credit.toLocaleString()} - "${je.description}"`
    );
    console.log(`      code path: ${codePathFor(je.referenceType)}  (journalEntryId=${je.id}${je.reversesEntryId ? `, reverses=${je.reversesEntryId}` : ""})`);
  }

  console.log(`\n--- NET BALANCE per account from the lines above (live/non-deleted only) ---`);
  for (const [accountId, v] of netByAccount.entries()) {
    if (Math.abs(v.net) < 0.01) continue;
    console.log(`  ${v.name} [${accountId}]: net ${v.net > 0 ? "DEBIT" : "CREDIT"} Rs. ${Math.abs(v.net).toLocaleString()} ${v.net > 0 ? "(RECEIVABLE-side)" : "(PAYABLE-side, if this is a Party account)"}`);
  }

  // The SETTLEMENT entry itself, called out separately.
  const settlementEntries = await prisma.journalEntry.findMany({
    where: { referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] }, referenceId: challan.id, isDeleted: false },
    include: { lines: { include: { account: { select: { accountName: true, category: true, party: { select: { partyName: true } } } } } } },
    orderBy: { entryDate: "asc" },
  });
  console.log(`\n--- SETTLEMENT entries for this Challan (${settlementEntries.length}) ---`);
  for (const e of settlementEntries) {
    console.log(`  JournalEntry ${e.id} [${ymd(e.entryDate)}] ${e.referenceType} - "${e.description}"`);
    for (const l of e.lines) {
      console.log(`      ${l.account.accountName}${l.account.party?.partyName ? ` (${l.account.party.partyName})` : ""} [${l.account.category}]: Dr ${Number(l.debit).toLocaleString()} / Cr ${Number(l.credit).toLocaleString()}`);
    }
  }

  // Every CarrierTripLine COLLECTION row ever posted against this exact document (any Trip) - what a Trip's own "outstanding" figure currently sums.
  const collectionLines = await prisma.carrierTripLine.findMany({
    where: { documentType: "CHALLAN", documentId: challan.id, isDeleted: false, lineType: "COLLECTION" },
    include: { trip: { select: { tripNo: true } } },
    orderBy: { date: "asc" },
  });
  const totalToPay = activeBilties.reduce((s, b) => s + Number(b.toPay), 0);
  const totalCollectionViaTrip = collectionLines.reduce((s, l) => s + Number(l.amount), 0);
  console.log(`\n--- CarrierTripLine COLLECTION rows against this Challan (any Trip) (${collectionLines.length}) ---`);
  for (const l of collectionLines) {
    console.log(`  Trip ${l.trip.tripNo} [${ymd(l.date)}]: Rs. ${Number(l.amount).toLocaleString()} - "${l.description}"`);
  }
  console.log(`  Sum of Bilty.toPay across all Bilties: Rs. ${totalToPay.toLocaleString()}`);
  console.log(`  Sum of CarrierTripLine COLLECTION rows (any Trip): Rs. ${totalCollectionViaTrip.toLocaleString()}`);
  console.log(
    `  getDocumentOutstandingAmount()-style figure (Trip's own linked-document "outstanding"): Rs. ${Math.max(0, totalToPay - totalCollectionViaTrip).toLocaleString()} ` +
      `- this ONLY sees Trip Wasooli Collection rows, never a Daily Posting receipt or a Settlement Payment row against the same Bilties.`
  );
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--challan="));
  if (!arg) {
    console.error("Usage: npx tsx scripts/investigate-own-carrier-challan.ts --challan=6402,6406");
    process.exitCode = 1;
    return;
  }
  const challanNos = arg.slice("--challan=".length).split(",").map((s) => s.trim()).filter(Boolean);

  for (const no of challanNos) {
    await investigateChallan(no);
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log("Done. This script made NO changes.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
