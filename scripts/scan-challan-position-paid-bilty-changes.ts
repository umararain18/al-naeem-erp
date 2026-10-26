// READ-ONLY AUDIT - no writes at all. Reuses the EXACT same
// computeChallanPositionsBatch()/computeChallanSettlementSummaryBatch()
// (lib/challan-position.ts, lib/challan-settlement-summary.ts) the
// live Challan list/detail routes call, never a separate/duplicate
// calculation.
//
// For every settled Challan that has at least one Bilty with
// advance > 0 (a "Paid" Bilty), computes the Position TWICE:
//   BEFORE - with paidUnverified omitted entirely, i.e. exactly what
//            every caller got before this fix (the Bilty-Paid-but-
//            unverified amount silently dropped, never shown, never
//            protecting the bucket from falsely reading CLEARED).
//   AFTER  - with paidUnverified populated, i.e. live, current
//            behavior - the real fix.
// Reports every Challan whose bucket or line amounts/parties differ
// between the two, so a reviewer can see exactly what this change
// moves before trusting it against production data.
//
// Usage:
//   npx tsx scripts/scan-challan-position-paid-bilty-changes.ts
import { PrismaClient } from "@prisma/client";
import { computeChallanSettlementSummaryBatch } from "../lib/challan-settlement-summary";
import { computeChallanPositionsBatch, resolvePaidUnverifiedEntries, type ChallanPosition, type ChallanPositionInput } from "../lib/challan-position";

const prisma = new PrismaClient();

function fmtMoney(n: number): string {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function describeLine(l: ChallanPosition["lines"][number]): string {
  const who = l.parties.length > 0 ? l.parties.map((p) => p.partyName).join(" + ") : "Party not set";
  const noteSuffix = l.note ? ` (${l.note})` : "";
  return `${l.direction} Rs. ${fmtMoney(l.amount)} ${l.direction === "RECEIVABLE" ? "from" : "to"} ${who}${noteSuffix}`;
}

function describePosition(p: ChallanPosition): string {
  if (p.lines.length === 0) return p.bucket;
  return `${p.bucket}: ${p.lines.map(describeLine).join("; ")}`;
}

function positionsDiffer(before: ChallanPosition, after: ChallanPosition): boolean {
  if (before.bucket !== after.bucket) return true;
  if (before.lines.length !== after.lines.length) return true;
  if (Math.abs(before.totalReceivable - after.totalReceivable) > 0.009) return true;
  if (Math.abs(before.totalPayable - after.totalPayable) > 0.009) return true;
  return JSON.stringify(before.lines) !== JSON.stringify(after.lines);
}

async function main() {
  // Every settled, non-deleted Challan with at least one non-deleted
  // Bilty whose advance > 0 - the only Challans this fix could ever
  // possibly change anything for (computeChallanPositionsBatch's own
  // paidUnverified merge is a pure no-op otherwise).
  const challans = await prisma.challan.findMany({
    where: {
      isDeleted: false,
      isSettled: true,
      bilties: { some: { bilty: { isDeleted: false, advance: { gt: 0 } } } },
    },
    select: {
      id: true,
      challanNo: true,
      isSettled: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      transporterParty: { select: { id: true, partyName: true } },
      bilties: {
        select: {
          biltyId: true,
          bilty: {
            select: {
              id: true,
              consignorParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
              consigneeParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
            },
          },
        },
        orderBy: { addedAt: "asc" },
      },
    },
  });

  console.log(`Found ${challans.length} settled Challan(s) with at least one Paid Bilty.`);
  if (challans.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const summaryMap = await computeChallanSettlementSummaryBatch(challans.map((c) => c.id));

  const beforeInputs: ChallanPositionInput[] = challans.map((c) => {
    const summary = summaryMap[c.id];
    return {
      id: c.id,
      isSettled: c.isSettled,
      outstandingReceivable: c.outstandingReceivable,
      outstandingPayable: c.outstandingPayable,
      biltyIds: c.bilties.map((cb) => cb.biltyId),
      partyNet: summary?.partyNet || [],
      collectedByParties: summary?.bilties.flatMap((b) => b.toPay.payers) || [],
      paidByParties: summary?.carrierRent.payers || [],
      transporterParty: c.transporterParty ? { partyId: c.transporterParty.id, partyName: c.transporterParty.partyName } : null,
      biltyParties: c.bilties.map((cb) => ({
        consignor: cb.bilty.consignorParty ? { partyId: cb.bilty.consignorParty.id, partyName: cb.bilty.consignorParty.partyName } : null,
        consignee: cb.bilty.consigneeParty ? { partyId: cb.bilty.consigneeParty.id, partyName: cb.bilty.consigneeParty.partyName } : null,
      })),
      // BEFORE - omitted entirely, simulating every caller's exact
      // pre-fix behavior.
    };
  });

  const afterInputs: ChallanPositionInput[] = challans.map((c, i) => ({
    ...beforeInputs[i],
    paidUnverified: resolvePaidUnverifiedEntries(c.bilties, summaryMap[c.id]),
  }));

  const [beforeMap, afterMap] = await Promise.all([
    computeChallanPositionsBatch(beforeInputs),
    computeChallanPositionsBatch(afterInputs),
  ]);

  console.log("=".repeat(100));
  let changedCount = 0;
  for (const c of challans) {
    const before = beforeMap[c.id];
    const after = afterMap[c.id];
    if (!before || !after || !positionsDiffer(before, after)) continue;
    changedCount++;
    console.log(`\nChallan ${c.challanNo} (${c.id}):`);
    console.log(`  BEFORE: ${describePosition(before)}`);
    console.log(`  AFTER:  ${describePosition(after)}`);
  }
  console.log("=".repeat(100));
  console.log(`\n${changedCount} of ${challans.length} Challan(s) with a Paid Bilty have a DIFFERENT Position after this fix.`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
