// READ-ONLY AUDIT - no writes, ever. Safe to run against production.
//
// This audit covers the Challan list redesign + "one financial
// position per Challan" change (lib/challan-position.ts). Two things
// are checked:
//
// 1. LIST vs DETAIL AGREEMENT (must be 0 disagreements). Both now
//    read the exact same computeChallanPositionsBatch()/
//    computeChallanPosition() - the list calls the batch form once
//    for every Challan on the page, the detail page calls the single
//    form for just its own Challan. Since both are thin wrappers
//    around the SAME per-Challan logic, they cannot disagree by
//    construction; this audit verifies that empirically rather than
//    just trusting the code, by calling BOTH forms for every Challan
//    and comparing bucket/lines/totals.
//
// 2. OLD vs NEW classification. The OLD list used to derive its
//    financial-status filter/badge from a FROZEN, reproduced-here
//    copy of the pre-this-PR compactStatus()/matchesFinancialFilter()
//    (challan.settlementSummary.partyNet-based - see app/api/challan/
//    route.ts's git history) - a DIFFERENT calculation from the one
//    the summary cards always used (challan.financials.
//    remainingReceivable/remainingPayable, lib/challan-financials.ts,
//    unchanged by this PR). That mismatch between two independently-
//    derived figures is exactly the reported bug ("filter 'Due' lists
//    6473/6454/6447/6422 while the cards show Rs 0"). The summary
//    cards' own AMOUNTS never change in this PR (still
//    challan.financials, read via lib/challan-position.ts, never
//    recomputed) - only the BUCKET/classification a Challan falls
//    into changes, so this audit prints every Challan whose OLD vs
//    NEW bucket differs, never a "the numbers changed" comparison
//    that doesn't exist.
//
// Usage:
//   npx tsx scripts/audit-challan-position.ts
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import { computeChallanPositionsBatch, computeChallanPosition, type ChallanPosition } from "../lib/challan-position";
import { computeChallanSettlementSummaryBatch } from "../lib/challan-settlement-summary";
import { getPartyLedgerData } from "../lib/ledger-description";

const prisma = new PrismaClient();
const EPS = 0.01;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ============================================================
// FROZEN pre-this-PR reference implementation - the exact
// compactStatus()/totalDueFromSummary() app/api/challan/route.ts and
// app/challan/page.tsx both used to run, reproduced verbatim so this
// script can show what the list USED to classify a Challan as,
// independent of what the real (now-fixed) code does today.
// ============================================================
type OldCompactStatus = "BEFORE SETTLEMENT" | "RECEIVABLE" | "PAYABLE" | "RECEIVABLE + PAYABLE" | "DUE" | "CLEARED";

function oldTotalDueFromSummary(summary: { bilties: { toPay: { remaining: number } }[]; carrierRent: { remaining: number } } | undefined): number {
  if (!summary) return 0;
  const toPayRemaining = summary.bilties.reduce((s, b) => s + b.toPay.remaining, 0);
  return toPayRemaining + summary.carrierRent.remaining;
}

function oldCompactStatus(
  isSettled: boolean,
  summary: { partyNet: { net: number }[]; bilties: { toPay: { remaining: number } }[]; carrierRent: { remaining: number } } | undefined
): OldCompactStatus {
  if (!isSettled) return "BEFORE SETTLEMENT";
  const partyNet = summary?.partyNet || [];
  const hasReceivable = partyNet.some((p) => p.net > 0);
  const hasPayable = partyNet.some((p) => p.net < 0);
  if (hasReceivable && hasPayable) return "RECEIVABLE + PAYABLE";
  if (hasReceivable) return "RECEIVABLE";
  if (hasPayable) return "PAYABLE";
  return oldTotalDueFromSummary(summary) > 0.009 ? "DUE" : "CLEARED";
}

function describePosition(position: ChallanPosition): string {
  if (position.bucket === "BEFORE_SETTLEMENT") return "Before Settlement";
  if (position.lines.length === 0) return "Cleared";
  return position.lines
    .map((l) => {
      const parties = l.parties.map((p) => p.partyName).join(" + ") || "(party not set)";
      return `${l.direction === "RECEIVABLE" ? "Receivable" : "Payable"} Rs. ${l.amount.toLocaleString()} ${l.direction === "RECEIVABLE" ? "from" : "to"} ${parties}`;
    })
    .join("; ");
}

async function main() {
  const challans = await prisma.challan.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      challanNo: true,
      isSettled: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      transporterPartyId: true,
      transporterParty: { select: { id: true, partyName: true } },
      bilties: {
        select: {
          biltyId: true,
          bilty: {
            select: {
              id: true,
              isDeleted: true,
              consignorPartyId: true,
              clearingAgentPartyId: true,
              consignorParty: { select: { id: true, partyName: true } },
              consigneeParty: { select: { id: true, partyName: true } },
              clearingAgentParty: { select: { id: true, partyName: true } },
            },
          },
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
  const positionInputs = challans.map((c) => ({
    id: c.id,
    isSettled: c.isSettled,
    outstandingReceivable: c.outstandingReceivable,
    outstandingPayable: c.outstandingPayable,
    biltyIds: c.bilties.map((cb) => cb.biltyId),
    transporterParty: c.transporterParty
      ? { partyId: c.transporterParty.id, partyName: c.transporterParty.partyName }
      : null,
    biltyParties: c.bilties.map((cb) => ({
      clearingAgent: cb.bilty.clearingAgentParty
        ? { partyId: cb.bilty.clearingAgentParty.id, partyName: cb.bilty.clearingAgentParty.partyName }
        : null,
      consignor: cb.bilty.consignorParty
        ? { partyId: cb.bilty.consignorParty.id, partyName: cb.bilty.consignorParty.partyName }
        : null,
      consignee: cb.bilty.consigneeParty
        ? { partyId: cb.bilty.consigneeParty.id, partyName: cb.bilty.consigneeParty.partyName }
        : null,
    })),
  }));

  const [listPositions, oldSettlementSummaries] = await Promise.all([
    computeChallanPositionsBatch(positionInputs),
    computeChallanSettlementSummaryBatch(challanIds),
  ]);

  // ------------------------------------------------------------
  // Check 1: list (batch) vs detail (single) agreement.
  // ------------------------------------------------------------
  let disagreements = 0;
  for (const inp of positionInputs) {
    const listPosition = listPositions[inp.id];
    const detailPosition = await computeChallanPosition(inp);
    const same =
      listPosition.bucket === detailPosition.bucket &&
      round2(listPosition.totalReceivable) === round2(detailPosition.totalReceivable) &&
      round2(listPosition.totalPayable) === round2(detailPosition.totalPayable) &&
      listPosition.lines.length === detailPosition.lines.length;
    if (!same) {
      disagreements++;
      const challan = challans.find((c) => c.id === inp.id);
      console.log(`\n!!! LIST/DETAIL DISAGREEMENT - Challan ${challan?.challanNo} !!!`);
      console.log(`  list:   ${describePosition(listPosition)}`);
      console.log(`  detail: ${describePosition(detailPosition)}`);
    }
  }
  if (disagreements === 0) {
    console.log("List/Detail agreement check passed: 0 disagreements across every Challan.\n");
  } else {
    console.log(`\n!!! ${disagreements} Challan(s) show a LIST vs DETAIL disagreement - this is a bug !!!\n`);
  }

  // ------------------------------------------------------------
  // Check 2: OLD (settlementSummary.partyNet-based) vs NEW
  // (financials + responsible-parties-based) classification.
  // ------------------------------------------------------------
  let changed = 0;
  let oldReceivableCount = 0;
  let oldPayableCount = 0;
  let oldDueCount = 0;
  let oldClearedCount = 0;
  let newReceivableTotal = 0;
  let newPayableTotal = 0;
  let partyLedgerReceivableTotal = 0;
  let partyLedgerPayableTotal = 0;
  const countedPartyIds = new Set<string>();

  for (const c of challans) {
    const newPosition = listPositions[c.id];
    const oldStatus = oldCompactStatus(c.isSettled, oldSettlementSummaries[c.id]);

    if (oldStatus === "RECEIVABLE") oldReceivableCount++;
    else if (oldStatus === "PAYABLE") oldPayableCount++;
    else if (oldStatus === "DUE") oldDueCount++;
    else if (oldStatus === "CLEARED") oldClearedCount++;

    newReceivableTotal = round2(newReceivableTotal + newPosition.totalReceivable);
    newPayableTotal = round2(newPayableTotal + newPosition.totalPayable);

    const newBucketAsOldLabel: Record<string, string> = {
      BEFORE_SETTLEMENT: "BEFORE SETTLEMENT",
      RECEIVABLE: "RECEIVABLE",
      PAYABLE: "PAYABLE",
      RECEIVABLE_PAYABLE: "RECEIVABLE + PAYABLE",
      CLEARED: "CLEARED",
    };
    const bucketChanged = newBucketAsOldLabel[newPosition.bucket] !== oldStatus;

    if (!bucketChanged) continue;
    changed++;

    console.log(`\nChallan ${c.challanNo} (${c.id})`);
    console.log(`  Old bucket: ${oldStatus}`);
    console.log(`  New position: ${describePosition(newPosition)}  (bucket: ${newPosition.bucket})`);

    const relevantPartyIds = new Set<string>();
    if (c.transporterPartyId) relevantPartyIds.add(c.transporterPartyId);
    for (const cb of c.bilties) {
      if (cb.bilty.isDeleted) continue;
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

  console.log(`\n=== ${changed} of ${challans.length} Challan(s) changed bucket (old vs new classification) ===`);
  console.log(`Old buckets: RECEIVABLE=${oldReceivableCount}, PAYABLE=${oldPayableCount}, DUE=${oldDueCount}, CLEARED=${oldClearedCount} (DUE no longer exists after this fix)`);
  console.log(`New totals: Receivable Rs. ${newReceivableTotal}, Payable Rs. ${newPayableTotal}  |  sum of every touched party's own ledger RECEIVABLE balance: ${partyLedgerReceivableTotal}, PAYABLE balance: ${partyLedgerPayableTotal}`);
  console.log(`(Party ledger totals are a cross-check, not a target to match exactly - a party's own ledger blends EVERY Challan/Bilty/Phonch/etc. they are involved in, not just the ones audited here.)`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
