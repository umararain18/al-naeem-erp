// READ-ONLY AUDIT - no writes at all.
//
// SECTION 1 reuses the EXACT same
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
// SECTION 2 - for EVERY settled Challan (not just ones with a Paid
// Bilty), independently recomputes each account's own net DIRECTLY
// from raw JournalLines (SETTLEMENT_NET_REFERENCE_TYPES, PAID-
// lifecycle entries excluded by the exact same precise mechanism
// lib/challan-settlement-summary.ts uses - reimplemented here from
// scratch, never by calling that same shared function, so this is a
// genuine independent cross-check rather than a tautology) and
// compares it against what Position actually shows (the Collection/
// Carrier-Rent-sourced lines only - the Paid-unverified "(Bilty paid,
// not received)" line is informational-only by design and is
// excluded from this specific comparison, since it is never supposed
// to equal a settlement-ledger net in the first place). Lists every
// mismatch - expect 0 after the fix in lib/challan-position.ts that
// makes Position source its amount from this SAME per-account net,
// never from a separately-tracked blended field that can drift out
// of sync with it (the Challan 6486 bug).
//
// Usage:
//   npx tsx scripts/scan-challan-position-paid-bilty-changes.ts
import { PrismaClient } from "@prisma/client";
import { computeChallanSettlementSummaryBatch } from "../lib/challan-settlement-summary";
import { computeChallanPositionsBatch, resolvePaidUnverifiedEntries, type ChallanPosition, type ChallanPositionInput } from "../lib/challan-position";
import { SETTLEMENT_NET_REFERENCE_TYPES } from "../lib/settlement-correction";

const prisma = new PrismaClient();
const EPS = 0.009;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

async function runPaidBiltySection() {
  console.log("=".repeat(100));
  console.log("SECTION 1 - Position before/after the Paid-unverified-line fix, for Challans with a Paid Bilty");
  console.log("=".repeat(100));

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
}

// ============================================================
// SECTION 2 - Position vs. an INDEPENDENTLY recomputed per-party net
// of this Challan's own raw ledger lines. See this file's own header
// for the full reasoning. Never calls computeChallanSettlementSummaryBatch
// or anything else that itself feeds lib/challan-position.ts - this
// is deliberately a from-scratch reimplementation so it can actually
// catch a bug in that shared path instead of trivially agreeing with
// it.
// ============================================================

interface GroundTruthEntry {
  accountId: string;
  accountName: string;
  net: number; // debit - credit, same sign convention as PartyNetEntry.
}

async function computeGroundTruthPartyNets(
  challans: { id: string; biltyIds: string[] }[]
): Promise<Record<string, GroundTruthEntry[]>> {
  const result: Record<string, GroundTruthEntry[]> = {};
  if (challans.length === 0) return result;

  const allBiltyIds = [...new Set(challans.flatMap((c) => c.biltyIds))];

  // PAID-lifecycle exclusion - every JournalEntry that belongs to a
  // PAID SettlementPayment's own create/correction/reversal/
  // reassignment, for ANY Bilty across every Challan in this batch,
  // in two queries total (never per-Challan) - same precise
  // mechanism lib/challan-settlement-summary.ts uses, reimplemented
  // independently here.
  const paidRows = allBiltyIds.length > 0
    ? await prisma.settlementPayment.findMany({
        where: { component: "PAID", biltyId: { in: allBiltyIds } },
        select: { id: true, journalEntryId: true, biltyId: true, payerAccountId: true },
      })
    : [];
  const excludedJournalEntryIds = new Set(paidRows.map((r) => r.journalEntryId));
  // PAID-payer accounts per Bilty - a Daily Posting VERIFICATION
  // receipt for a PAID amount is its OWN, separate DAILY_POSTING
  // entry credited to this SAME account, tagged sourceType:"BILTY"/
  // sourceId:<biltyId> - the identical tag shape a legitimate
  // Collection Daily Posting on that same Bilty also uses (see
  // lib/bilty-paid-verification.ts's own header comment). The tag
  // alone cannot distinguish them - only the ACCOUNT can, which is
  // why this is excluded by account below, never by JournalEntry id
  // (same precise mechanism lib/challan-settlement-summary.ts uses).
  const paidPayerAccountIdsByBiltyId = new Map<string, Set<string>>();
  for (const row of paidRows) {
    if (!row.biltyId) continue;
    const set = paidPayerAccountIdsByBiltyId.get(row.biltyId) || new Set<string>();
    set.add(row.payerAccountId);
    paidPayerAccountIdsByBiltyId.set(row.biltyId, set);
  }
  if (paidRows.length > 0) {
    const paidLifecycleLines = await prisma.journalLine.findMany({
      where: {
        OR: [
          { sourceType: "SETTLEMENT_PAYMENT", sourceId: { in: paidRows.map((r) => r.id) } },
          { journalEntry: { referenceType: "PAID_RESPONSIBILITY_REASSIGNMENT", referenceId: { in: allBiltyIds } } },
        ],
      },
      select: { journalEntryId: true },
    });
    for (const l of paidLifecycleLines) excludedJournalEntryIds.add(l.journalEntryId);
  }

  // Real Daily Posting activity attributable to each Challan/Bilty -
  // `partyNet` (lib/challan-settlement-summary.ts) already folds this
  // in per account (its own step 5.5/6), so the ground truth must
  // too, or a Challan with real cash movement would show a false
  // mismatch here. Same correlation lib/challan-financials.ts's
  // computeChallanFinancialsBatch() already uses (sourceType
  // "CHALLAN"/this challanId or "BILTY"/one of its Bilty ids, PARTY-
  // category lines only), reimplemented independently, batched once
  // across every Challan in this call.
  const challanIds = challans.map((c) => c.id);
  const dailyPostingEntries = await prisma.journalEntry.findMany({
    where: {
      referenceType: "DAILY_POSTING",
      isDeleted: false,
      lines: {
        some: {
          OR: [
            { sourceType: "CHALLAN", sourceId: { in: challanIds } },
            ...(allBiltyIds.length > 0 ? [{ sourceType: "BILTY", sourceId: { in: allBiltyIds } }] : []),
          ],
        },
      },
    },
    select: { lines: { select: { accountId: true, sourceType: true, sourceId: true, debit: true, credit: true, account: { select: { category: true } } } } },
  });
  const biltyToChallan = new Map<string, string>();
  for (const c of challans) for (const b of c.biltyIds) biltyToChallan.set(b, c.id);
  const dpNetByChallanAccount = new Map<string, number>(); // key: `${challanId}:${accountId}`
  for (const entry of dailyPostingEntries) {
    for (const l of entry.lines) {
      if (l.account.category !== "PARTY" || !l.sourceId) continue;
      // PAID-verification exclusion - see this function's own PAID-
      // payer setup above for why this must be checked by account,
      // not by JournalEntry id.
      if (l.sourceType === "BILTY" && paidPayerAccountIdsByBiltyId.get(l.sourceId)?.has(l.accountId)) continue;
      let owner: string | null = null;
      if (l.sourceType === "CHALLAN" && challanIds.includes(l.sourceId)) owner = l.sourceId;
      else if (l.sourceType === "BILTY" && biltyToChallan.has(l.sourceId)) owner = biltyToChallan.get(l.sourceId)!;
      if (!owner) continue;
      const key = `${owner}:${l.accountId}`;
      dpNetByChallanAccount.set(key, round2((dpNetByChallanAccount.get(key) || 0) + Number(l.debit) - Number(l.credit)));
    }
  }

  for (const challan of challans) {
    const referenceIds = [challan.id, ...challan.biltyIds];
    const lines = await prisma.journalLine.findMany({
      where: {
        journalEntry: {
          isDeleted: false,
          referenceType: { in: SETTLEMENT_NET_REFERENCE_TYPES },
          referenceId: { in: referenceIds },
        },
      },
      select: { accountId: true, debit: true, credit: true, journalEntryId: true, account: { select: { accountName: true, category: true } } },
    });

    const netByAccount = new Map<string, GroundTruthEntry>();
    for (const l of lines) {
      // PARTY accounts only - the other half of every reclassification
      // line is a Gross/suspense clearing account (e.g. "Gross Carrier
      // Rent Payable (Unallocated)"), never a real party, and must
      // never be counted as one here - same precedent
      // computeChallanFinancialsBatch() itself already follows.
      if (l.account.category !== "PARTY") continue;
      if (excludedJournalEntryIds.has(l.journalEntryId)) continue;
      const existing = netByAccount.get(l.accountId);
      const delta = Number(l.debit) - Number(l.credit);
      if (existing) {
        existing.net = round2(existing.net + delta);
      } else {
        netByAccount.set(l.accountId, { accountId: l.accountId, accountName: l.account.accountName, net: round2(delta) });
      }
    }

    // Merge in the real Daily Posting contribution for this SAME
    // challan/account - exactly mirroring what `partyNet` itself
    // already does (see this function's own header comment above).
    for (const [key, dpNet] of dpNetByChallanAccount) {
      if (!key.startsWith(`${challan.id}:`) || dpNet === 0) continue;
      const accountId = key.slice(challan.id.length + 1);
      const existing = netByAccount.get(accountId);
      if (existing) {
        existing.net = round2(existing.net + dpNet);
      } else {
        const account = await prisma.account.findUnique({ where: { id: accountId }, select: { accountName: true } });
        netByAccount.set(accountId, { accountId, accountName: account?.accountName || accountId, net: dpNet });
      }
    }

    result[challan.id] = [...netByAccount.values()].filter((e) => Math.abs(e.net) > EPS);
  }

  return result;
}

/** Position's Collection/Carrier-Rent-sourced lines ONLY - excludes
 * any Paid-unverified ("Bilty paid, not received") line, which is
 * informational-only by design and never supposed to equal a
 * settlement-ledger net (see this file's own header). */
function settlementSourcedLines(position: ChallanPosition): ChallanPosition["lines"] {
  return position.lines.filter((l) => !l.note);
}

async function runLedgerNetSection() {
  console.log("\n" + "=".repeat(100));
  console.log("SECTION 2 - Position vs. independently recomputed per-party ledger net, for EVERY settled Challan");
  console.log("=".repeat(100));

  const challans = await prisma.challan.findMany({
    where: { isDeleted: false, isSettled: true },
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

  console.log(`Found ${challans.length} settled Challan(s) total.`);
  if (challans.length === 0) return;

  const summaryMap = await computeChallanSettlementSummaryBatch(challans.map((c) => c.id));
  const groundTruthMap = await computeGroundTruthPartyNets(challans.map((c) => ({ id: c.id, biltyIds: c.bilties.map((cb) => cb.biltyId) })));

  const positionInputs: ChallanPositionInput[] = challans.map((c) => {
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
      paidUnverified: resolvePaidUnverifiedEntries(c.bilties, summary),
    };
  });

  const positionMap = await computeChallanPositionsBatch(positionInputs);

  let mismatchCount = 0;
  for (const c of challans) {
    const position = positionMap[c.id];
    const groundTruth = groundTruthMap[c.id] || [];
    const shownLines = settlementSourcedLines(position);

    const groundTruthReceivable = round2(groundTruth.filter((e) => e.net > 0).reduce((s, e) => s + e.net, 0));
    const groundTruthPayable = round2(groundTruth.filter((e) => e.net < 0).reduce((s, e) => s - e.net, 0));
    const shownReceivable = round2(shownLines.filter((l) => l.direction === "RECEIVABLE").reduce((s, l) => s + l.amount, 0));
    const shownPayable = round2(shownLines.filter((l) => l.direction === "PAYABLE").reduce((s, l) => s + l.amount, 0));

    const mismatch = Math.abs(groundTruthReceivable - shownReceivable) > EPS || Math.abs(groundTruthPayable - shownPayable) > EPS;
    if (!mismatch) continue;

    mismatchCount++;
    console.log(`\nChallan ${c.challanNo} (${c.id}): MISMATCH`);
    console.log(
      `  Ledger net:  Receivable Rs. ${fmtMoney(groundTruthReceivable)}, Payable Rs. ${fmtMoney(groundTruthPayable)}` +
        (groundTruth.length > 0 ? ` [${groundTruth.map((e) => `${e.accountName}: ${e.net > 0 ? "Dr" : "Cr"} ${fmtMoney(Math.abs(e.net))}`).join(", ")}]` : "")
    );
    console.log(
      `  Position:    Receivable Rs. ${fmtMoney(shownReceivable)}, Payable Rs. ${fmtMoney(shownPayable)}` +
        (shownLines.length > 0 ? ` [${shownLines.map(describeLine).join("; ")}]` : "")
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log(`${mismatchCount} of ${challans.length} settled Challan(s) have a Position that disagrees with their own ledger net (expect 0).`);
}

async function main() {
  await runPaidBiltySection();
  await runLedgerNetSection();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
