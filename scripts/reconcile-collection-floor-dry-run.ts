// READ-ONLY DIAGNOSTIC SCRIPT - makes no writes of any kind. Safe to
// run against the production database for a one-time inspection.
//
// Reports exactly what lib/settlement-payments.ts's
// previewCollectionFloorForBilty() (dry-run counterpart of the real
// syncCollectionFloorForBilty()) would currently find for one or more
// Bilties: the OLD single-payer Collection default's CURRENT live
// attribution, the CORRECT target floor under the fixed formula
// (computeCollectionFloorForBilty - see lib/settlement-payments.ts),
// and the release/restore delta a real PAID-row edit-and-revert would
// post. Also reports the Challan's Carrier Rent side
// (previewCarrierRentFloorForChallan - never buggy, included only to
// project the SAME party's full net payable before/after) when the
// Carrier Rent default party is the same account as the Collection
// default party.
//
// This is the RH International Goods forensic report (PR #15,
// Challan #6423-style sequence: Final Settlement Collection
// allocations recorded, then a Bilty Paid edit raised/updated the
// PAID row AFTER those allocations already existed) - every Bilty
// this script flags as "AFFECTED" (delta != 0) is a live instance of
// that exact bug, regardless of which Challan/party it is.
//
// Usage:
//   npx tsx scripts/reconcile-collection-floor-dry-run.ts                      (every settled Bilty with a PAID row)
//   npx tsx scripts/reconcile-collection-floor-dry-run.ts --challan=6423       (scoped to one Challan)
//   npx tsx scripts/reconcile-collection-floor-dry-run.ts --bilty=B-1025       (scoped to one Bilty)
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import { previewCollectionFloorForBilty, previewCarrierRentFloorForChallan } from "../lib/settlement-payments";
import { getPartyNetFromSettlement } from "../lib/settlement-correction";

const prisma = new PrismaClient();

const challanArg = process.argv.find((a) => a.startsWith("--challan="))?.slice("--challan=".length) || null;
const biltyArg = process.argv.find((a) => a.startsWith("--bilty="))?.slice("--bilty=".length) || null;

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function findCandidateBiltyIds(): Promise<string[]> {
  if (biltyArg) {
    const bilty = await prisma.bilty.findUnique({ where: { biltyNo: biltyArg }, select: { id: true } });
    return bilty ? [bilty.id] : [];
  }

  const where = challanArg
    ? {
        component: "PAID" as const,
        bilty: { challanBilties: { some: { challan: { challanNo: challanArg, isDeleted: false } } } },
      }
    : { component: "PAID" as const };

  const paidRows = await prisma.settlementPayment.findMany({
    where,
    select: { biltyId: true },
  });
  return [...new Set(paidRows.map((r) => r.biltyId).filter((id): id is string => !!id))];
}

async function main() {
  const biltyIds = await findCandidateBiltyIds();

  if (biltyIds.length === 0) {
    console.log("No matching Bilty with an active PAID settlement-payment row found - nothing to inspect.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== Collection Floor Reconciliation Dry-Run (${biltyIds.length} Bilty(s) checked) ===\n`);

  let affectedCount = 0;

  for (const biltyId of biltyIds) {
    const collectionPreview = await previewCollectionFloorForBilty(prisma, biltyId);
    if (!collectionPreview) continue;

    const isAffected = Math.abs(collectionPreview.delta) > 0.009;
    console.log(`--- Bilty ${collectionPreview.biltyNo} (Challan ${collectionPreview.challanNo}) ${isAffected ? "*** AFFECTED ***" : "(in sync)"}`);
    console.log(`    Bilty total:              Rs. ${fmt(collectionPreview.biltyTotal)}`);
    console.log(`    Paid amount:               Rs. ${fmt(collectionPreview.paidAmount)}`);
    console.log(`    Active Collection rows:    Rs. ${fmt(collectionPreview.activeCollectionTotal)}`);
    console.log(`    Old party (Collection):    ${collectionPreview.oldPartyAccountId}`);
    console.log(`    Currently attributed:      Rs. ${fmt(collectionPreview.currentlyAttributed)}`);
    console.log(`    Correct target floor:      Rs. ${fmt(collectionPreview.floor)}`);
    console.log(
      `    Proposed adjustment:       ${collectionPreview.isRestore ? "RESTORE" : "RELEASE"} Rs. ${fmt(collectionPreview.adjustAmount)}${
        isAffected ? "" : " (none needed)"
      }`
    );

    if (isAffected) affectedCount++;

    const currentPartyNet = await getPartyNetFromSettlement(prisma, collectionPreview.challanId, collectionPreview.oldPartyAccountId);
    // getPartyNetFromSettlement() is debit-minus-credit: positive means
    // the party owes ANC (receivable), negative means ANC owes the
    // party (payable) - see its own doc comment in
    // lib/settlement-correction.ts. A COLLECTION release CREDITS the
    // old party (buildReverseLines) - debit-credit therefore DECREASES;
    // a restore DEBITS it (buildLines) - debit-credit INCREASES. This
    // is the exact sign ensureOldAttributionWithinFloor()'s own
    // oldPartyNetBefore/oldPartyNetAfter diff would observe.
    const projectedPartyNetFromCollectionOnly =
      currentPartyNet + (collectionPreview.isRestore ? collectionPreview.adjustAmount : -collectionPreview.adjustAmount);

    const carrierRentPreview = await previewCarrierRentFloorForChallan(prisma, collectionPreview.challanId);
    if (carrierRentPreview && carrierRentPreview.oldPartyAccountId === collectionPreview.oldPartyAccountId) {
      console.log(`    Carrier Rent (same party): total Rs. ${fmt(carrierRentPreview.carrierRentTotal)}, currently attributed Rs. ${fmt(carrierRentPreview.currentlyAttributed)}${
        Math.abs(carrierRentPreview.delta) > 0.009 ? ` (Carrier Rent side itself also out of sync - adjustment: Rs. ${fmt(carrierRentPreview.adjustAmount)})` : " (in sync, unaffected by this bug)"
      }`);
      console.log(`    Current party net (actual ledger, before any correction): Rs. ${fmt(currentPartyNet)}`);
      console.log(`    Projected party net AFTER the Collection-side correction:  Rs. ${fmt(projectedPartyNetFromCollectionOnly)}`);
    } else {
      console.log(`    Current party net on this Challan (actual ledger, Collection party only): Rs. ${fmt(currentPartyNet)}`);
      console.log(`    Projected net for this party AFTER the Collection-side correction:          Rs. ${fmt(projectedPartyNetFromCollectionOnly)}`);
    }
    console.log("");
  }

  console.log(`${affectedCount} of ${biltyIds.length} checked Bilty(s) are affected (stale over-attribution still live).`);
  console.log("No writes were made. See PR #15's description for the safe remediation workflow (a trivial Paid edit-and-revert, AFTER this fix is deployed, re-runs the now-corrected sync for exactly the affected Bilty).\n");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
