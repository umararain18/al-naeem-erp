// READ-ONLY AUDIT - no writes, ever. Safe to run against production.
//
// Covers three things for the Challan list/detail "one financial
// position" feature (lib/challan-position.ts):
//
// 1. LIST vs DETAIL AGREEMENT (must be 0 disagreements). Both read
//    the exact same computeChallanPositionsBatch()/
//    computeChallanPosition() - verified empirically by calling BOTH
//    forms for every Challan and comparing bucket/lines/totals.
//
// 2. PARTY RESOLUTION correctness - the bug this script's current
//    version was written to confirm the fix for: Challan 6425 showed
//    "Receivable Rs. 9,000 from Mumtaz Ali Digree" (the Bilty's
//    Clearing Agent, attributed at a FIRST settlement that was later
//    Unsettled) when the CURRENT, active settlement had already
//    reassigned Collection to Nawab Broker. Root cause:
//    getChallanResponsibleParties() (lib/document-party-resolution.ts)
//    only reads SETTLEMENT/SETTLEMENT_CORRECTION JournalLines -
//    Unsettle never edits/deletes those, it posts a SEPARATE
//    SETTLEMENT_UNSETTLE_REVERSAL-tagged entry instead (lib/challan-
//    lifecycle.ts), so that resolver still sees the ORIGINAL,
//    now-reversed party as if still valid. lib/challan-position.ts no
//    longer uses that function at all - it now resolves through three
//    tiers (partyNet, live "Collected by"/"Paid by" payers, then
//    document role fields, never Clearing Agent as a guess).
//
//    This script checks, for every Challan with a Receivable/Payable
//    line:
//    (a) the shown party is backed by a REAL ledger line for this
//        Challan (tier 1 or 2 - partyNet or a live payer) - flags any
//        line resolved only through tier 3 (a role-field guess, never
//        ledger-backed by definition) as a diagnostic, and
//    (b) what the OLD, buggy getChallanResponsibleParties() would
//        have shown instead, for direct comparison.
//
// 3. UNSETTLED-AT-LEAST-ONCE Challans - every Challan with any
//    SETTLEMENT_UNSETTLE_REVERSAL-referenced JournalEntry against it
//    or one of its Bilties, with its CURRENT position/party next to
//    what the OLD resolver would have shown - flags any Challan where
//    those two disagree (expect 0 after this fix; a disagreement here
//    is the exact "resettled, OLD resolver stuck on the pre-Unsettle
//    party" bug class).
//
// Usage:
//   npx tsx scripts/audit-challan-position.ts
// (reads DATABASE_URL from the environment exactly like the app itself.)
import { PrismaClient } from "@prisma/client";
import { computeChallanPositionsBatch, computeChallanPosition, type ChallanPosition } from "../lib/challan-position";
import { computeChallanSettlementSummaryBatch } from "../lib/challan-settlement-summary";
import { getChallanResponsiblePartiesBatch } from "../lib/document-party-resolution";
import { getPartyLedgerData } from "../lib/ledger-description";

const prisma = new PrismaClient();
const EPS = 0.01;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

function describeOldParties(old: { receivable: { partyName: string }[]; payable: { partyName: string }[] } | undefined): string {
  if (!old) return "(none)";
  const r = old.receivable.map((p) => p.partyName).join(" + ");
  const p = old.payable.map((p) => p.partyName).join(" + ");
  const parts: string[] = [];
  if (r) parts.push(`Receivable from ${r}`);
  if (p) parts.push(`Payable to ${p}`);
  return parts.length > 0 ? parts.join("; ") : "(none)";
}

// Party-identity-only comparison (names per direction, NEVER amounts
// or wording) - describePosition()/describeOldParties() above are
// for DISPLAY only; comparing those full strings directly would flag
// a false "differs" for every Challan merely because the new wording
// includes the amount and the old one doesn't. This is what actually
// decides whether OLD and NEW resolved to the SAME party or not.
function partyNamesDiffer(
  position: ChallanPosition,
  old: { receivable: { partyName: string }[]; payable: { partyName: string }[] } | undefined
): boolean {
  const newReceivable = new Set(position.lines.find((l) => l.direction === "RECEIVABLE")?.parties.map((p) => p.partyName) || []);
  const newPayable = new Set(position.lines.find((l) => l.direction === "PAYABLE")?.parties.map((p) => p.partyName) || []);
  const oldReceivable = new Set((old?.receivable || []).map((p) => p.partyName));
  const oldPayable = new Set((old?.payable || []).map((p) => p.partyName));
  const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  return !sameSet(newReceivable, oldReceivable) || !sameSet(newPayable, oldPayable);
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
  const settledIds = challans.filter((c) => c.isSettled).map((c) => c.id);

  const [settlementSummaries, oldResponsibleParties] = await Promise.all([
    computeChallanSettlementSummaryBatch(challanIds),
    getChallanResponsiblePartiesBatch(settledIds),
  ]);

  const positionInputs = challans.map((c) => {
    const summary = settlementSummaries[c.id];
    return {
      id: c.id,
      isSettled: c.isSettled,
      outstandingReceivable: c.outstandingReceivable,
      outstandingPayable: c.outstandingPayable,
      biltyIds: c.bilties.map((cb) => cb.biltyId),
      partyNet: summary?.partyNet || [],
      collectedByParties: summary?.bilties.flatMap((b) => b.toPay.payers) || [],
      paidByParties: summary?.carrierRent.payers || [],
      transporterParty: c.transporterParty
        ? { partyId: c.transporterParty.id, partyName: c.transporterParty.partyName }
        : null,
      biltyParties: c.bilties.map((cb) => ({
        consignor: cb.bilty.consignorParty
          ? { partyId: cb.bilty.consignorParty.id, partyName: cb.bilty.consignorParty.partyName }
          : null,
        consignee: cb.bilty.consigneeParty
          ? { partyId: cb.bilty.consigneeParty.id, partyName: cb.bilty.consigneeParty.partyName }
          : null,
      })),
    };
  });

  const listPositions = await computeChallanPositionsBatch(positionInputs);

  // ------------------------------------------------------------
  // Section 1: list (batch) vs detail (single) agreement.
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
  console.log(
    disagreements === 0
      ? "Section 1 - List/Detail agreement: PASSED, 0 disagreements across every Challan.\n"
      : `\n!!! Section 1 - ${disagreements} Challan(s) show a LIST vs DETAIL disagreement - this is a bug !!!\n`
  );

  // ------------------------------------------------------------
  // Section 2: party resolution - every Receivable/Payable line,
  // which tier resolved it (ledger-backed tier 1/2, or a tier-3
  // role-field guess), and what the OLD resolver would have shown.
  // ------------------------------------------------------------
  let tier3Count = 0;
  let oldVsNewDiffCount = 0;
  console.log("=== Section 2: party resolution per Challan (Receivable/Payable only) ===");
  for (const c of challans) {
    const position = listPositions[c.id];
    if (position.lines.length === 0) continue;

    const summary = settlementSummaries[c.id];
    const partyNetAccountIds = new Set((summary?.partyNet || []).map((p) => p.accountId));
    const liveAccountIds = new Set([
      ...(summary?.bilties.flatMap((b) => b.toPay.payers.map((p) => p.accountId)) || []),
      ...(summary?.carrierRent.payers.map((p) => p.accountId) || []),
    ]);

    const oldForThis = oldResponsibleParties[c.id];
    const oldDescription = describeOldParties(oldForThis);
    const newDescription = describePosition(position);
    const differs = partyNamesDiffer(position, oldForThis);
    if (differs) oldVsNewDiffCount++;

    let anyTier3 = false;
    for (const line of position.lines) {
      for (const p of line.parties) {
        const ledgerBacked = (p.accountId && (partyNetAccountIds.has(p.accountId) || liveAccountIds.has(p.accountId)));
        if (!ledgerBacked) anyTier3 = true;
      }
    }
    if (anyTier3) tier3Count++;

    if (differs || anyTier3) {
      console.log(`\nChallan ${c.challanNo} (${c.id})`);
      console.log(`  OLD (getChallanResponsibleParties, buggy): ${oldDescription}`);
      console.log(`  NEW (lib/challan-position.ts, 3-tier):      ${newDescription}`);
      if (anyTier3) console.log(`  NOTE: at least one party above came from tier 3 (role field, no real ledger line for this Challan) - diagnostic only, not necessarily wrong.`);
    }
  }
  console.log(`\n=== Section 2 totals: ${challans.length} Challans checked, ${oldVsNewDiffCount} where OLD vs NEW differ, ${tier3Count} using a tier-3 (non-ledger-backed) party ===\n`);

  // ------------------------------------------------------------
  // Section 3: Challans that have been Unsettled at least once -
  // current position/party vs what the OLD resolver shows, flagging
  // any disagreement (the exact "stuck on a reversed entry" bug).
  // ------------------------------------------------------------
  const allBiltyIds = challans.flatMap((c) => c.bilties.map((cb) => cb.biltyId));
  const reversalEntries = await prisma.journalEntry.findMany({
    where: {
      referenceType: "SETTLEMENT_UNSETTLE_REVERSAL",
      referenceId: { in: [...challanIds, ...allBiltyIds] },
      isDeleted: false,
    },
    select: { referenceId: true },
  });
  const biltyIdToChallanId = new Map<string, string>();
  for (const c of challans) for (const cb of c.bilties) biltyIdToChallanId.set(cb.biltyId, c.id);
  const unsettledAtLeastOnceChallanIds = new Set<string>();
  for (const e of reversalEntries) {
    if (!e.referenceId) continue;
    if (challanIds.includes(e.referenceId)) unsettledAtLeastOnceChallanIds.add(e.referenceId);
    const viaChallan = biltyIdToChallanId.get(e.referenceId);
    if (viaChallan) unsettledAtLeastOnceChallanIds.add(viaChallan);
  }

  console.log(`=== Section 3: Challans Unsettled at least once (${unsettledAtLeastOnceChallanIds.size} found) ===`);
  let section3Mismatches = 0;
  const partyLedgerCache = new Map<string, { partyName: string; closingBalance: number; balanceType: string }>();
  for (const challanId of unsettledAtLeastOnceChallanIds) {
    const c = challans.find((x) => x.id === challanId);
    if (!c) continue;
    const position = listPositions[challanId];
    const oldForThis = oldResponsibleParties[challanId];
    const oldDescription = describeOldParties(oldForThis);
    const newDescription = describePosition(position);
    const mismatch = partyNamesDiffer(position, oldForThis);
    if (mismatch) section3Mismatches++;

    console.log(`\nChallan ${c.challanNo} (${c.id})`);
    console.log(`  Current position: ${newDescription}`);
    console.log(`  OLD resolver would show: ${oldDescription}${mismatch ? "  <-- DIFFERS (this Challan would have shown the wrong party under the old code)" : "  (same - no visible difference for this one)"}`);

    // Party Ledger cross-check for every party actually shown.
    for (const line of position.lines) {
      for (const p of line.parties) {
        if (!p.partyId || partyLedgerCache.has(p.partyId)) continue;
        try {
          const ledger = await getPartyLedgerData(p.partyId, { order: "desc", includeOpeningBalanceRow: false });
          partyLedgerCache.set(p.partyId, {
            partyName: ledger.party.partyName,
            closingBalance: ledger.summary.closingBalance,
            balanceType: ledger.summary.balanceType,
          });
        } catch {
          // Party/account not resolvable - skip, never fabricate.
        }
      }
    }
    for (const line of position.lines) {
      for (const p of line.parties) {
        const cached = p.partyId ? partyLedgerCache.get(p.partyId) : null;
        if (cached) console.log(`  Party Ledger - ${cached.partyName}: closing balance Rs. ${cached.closingBalance} (${cached.balanceType})`);
      }
    }
  }
  console.log(
    `\n=== Section 3 totals: ${unsettledAtLeastOnceChallanIds.size} Challan(s) ever Unsettled, ${section3Mismatches} where the shown party differs from what the OLD (reversal-blind) resolver would show (expect 0 after this fix for any that are STILL wrong - differing is EXPECTED and CORRECT for one that was previously bugged) ===\n`
  );

  console.log("Done. Party Ledger totals above are a cross-check, not a target to match exactly - a party's own ledger blends EVERY Challan/Bilty/Phonch/etc. they are involved in, not just the ones audited here.");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
