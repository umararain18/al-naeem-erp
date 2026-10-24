import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { computeChallanFinancialsBatch, type ChallanFinancialInput } from "./challan-financials";
import { getChallanResponsiblePartiesBatch } from "./document-party-resolution";

// ============================================================
// ONE FINANCIAL POSITION PER CHALLAN - the single shared calculation
// the Challan list (table, filter, summary cards) and the Challan
// Detail page must all read, so they can never disagree again.
//
// Deliberately built ONLY from two already-existing, already-
// approved primitives - never a new amount calculation:
//
//  - computeChallanFinancialsBatch() (lib/challan-financials.ts) -
//    the AMOUNTS. `remainingReceivable`/`remainingPayable` already
//    read Challan.outstandingReceivable/outstandingPayable (which the
//    SettlementPayment multi-payer engine keeps continuously adjusted
//    - see adjustChallanOutstanding() in lib/settlement-payments.ts)
//    minus real, per-line-attributed Daily Posting receipts/payments.
//    Never the settlement reclassification entry, never both sources
//    summed, never negative. This function is UNCHANGED here.
//
//  - getChallanResponsiblePartiesBatch() (lib/document-party-
//    resolution.ts) - the PARTY NAME(s) those amounts belong to.
//    Purely informational (its own doc comment: "does NOT recompute
//    or duplicate the amounts") - never used for an amount here
//    either, only for the label.
//
// A Challan's position is:
//  - BEFORE_SETTLEMENT: not settled yet - no Receivable/Payable/
//    Cleared classification is attempted (that classification is
//    only meaningful once Final Settlement has run).
//  - CLEARED: both remaining amounts are ~0.
//  - RECEIVABLE / PAYABLE: only one side has a remaining amount.
//  - Both sides have a remaining amount:
//     - same single party on both sides -> netted into ONE line
//       ((party owes ANC) - (ANC owes party)), bucket RECEIVABLE or
//       PAYABLE by the net's sign (or CLEARED if the net is ~0).
//     - anything else (different parties, or either side resolving
//       to zero/multiple parties) -> TWO separate lines, never
//       netted - bucket RECEIVABLE_PAYABLE.
// ============================================================

const EPS = 0.009;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface ChallanPositionParty {
  // null for a party resolved only through a role field (Transporter/
  // Clearing Agent/Consignor/Consignee) below, where no Account id is
  // already on hand and none is needed for display - partyId is the
  // unique identity that matters (it drives the Party Ledger link).
  accountId: string | null;
  partyId: string | null;
  partyName: string;
}

export interface ChallanPositionBiltyPartyRoles {
  clearingAgent: { partyId: string; partyName: string } | null;
  consignor: { partyId: string; partyName: string } | null;
  consignee: { partyId: string; partyName: string } | null;
}

export interface ChallanPositionLine {
  direction: "RECEIVABLE" | "PAYABLE";
  amount: number;
  parties: ChallanPositionParty[];
}

export type ChallanPositionBucket =
  | "BEFORE_SETTLEMENT"
  | "RECEIVABLE"
  | "PAYABLE"
  | "RECEIVABLE_PAYABLE"
  | "CLEARED";

export interface ChallanPosition {
  bucket: ChallanPositionBucket;
  lines: ChallanPositionLine[];
  // Convenience totals for this one Challan - sum of this challan's
  // own RECEIVABLE/PAYABLE lines (0 or 1 each, by construction). The
  // list's 3 summary cards sum these same fields across every
  // filtered Challan, so cards and filter can never disagree.
  totalReceivable: number;
  totalPayable: number;
}

export interface ChallanPositionInput {
  id: string;
  isSettled: boolean;
  outstandingReceivable: number | string | Decimal;
  outstandingPayable: number | string | Decimal;
  biltyIds: string[];
  // Fallback-only party candidates (display, never an amount) - see
  // resolveFallbackParty()'s own doc comment for when/why these are
  // used. The caller already has these fields selected for its own
  // other display needs (Transporter/Clearing Agent name columns
  // etc.) - passed straight through, never a new query here.
  transporterParty: { partyId: string; partyName: string } | null;
  biltyParties: ChallanPositionBiltyPartyRoles[];
}

function clearedPosition(): ChallanPosition {
  return { bucket: "CLEARED", lines: [], totalReceivable: 0, totalPayable: 0 };
}

// ============================================================
// PARTY-RESOLUTION FALLBACK (display only - never an amount).
//
// getChallanResponsiblePartiesBatch() only reads SETTLEMENT/
// SETTLEMENT_CORRECTION JournalLines - it is structurally blind to a
// party whose ENTIRE attribution came through the newer multi-payer
// SettlementPayment engine (referenceType "SETTLEMENT_PAYMENT", a
// different set). This is the exact same gap lib/party-outstanding.ts
// documents for its own identical Carrier Rent/Collection resolution
// ("Confirmed live: Challan 4028's Carrier Rent is multi-payer... and
// was silently dropped"). When that happens here, a real Receivable/
// Payable amount would otherwise render with no party name at all.
//
// Two fallback tiers, in order, used ONLY when
// getChallanResponsiblePartiesBatch found nobody for that direction:
//  1. Live SettlementPayment payer(s) for that component (CARRIER_RENT
//     for Payable, COLLECTION for Receivable) - one batched query,
//     mirroring lib/challan-settlement-summary.ts's own identical
//     SettlementPayment read.
//  2. The document's own role field(s): the Challan's Transporter for
//     Payable; a linked Bilty's own Clearing Agent, else Consignor,
//     else Consignee, for Receivable (all already selected by the
//     caller for its own display needs - no new query here).
// If NEITHER resolves anyone, `parties` stays empty and the caller
// shows "Party not set" - never silently blank, never a guess.
// ============================================================

function dedupeParties(parties: ChallanPositionParty[]): ChallanPositionParty[] {
  const seen = new Map<string, ChallanPositionParty>();
  for (const p of parties) {
    const key = p.partyId || p.accountId || p.partyName;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

export async function computeChallanPositionsBatch(
  inputs: ChallanPositionInput[]
): Promise<Record<string, ChallanPosition>> {
  const result: Record<string, ChallanPosition> = {};
  if (inputs.length === 0) return result;

  const financialInputs: ChallanFinancialInput[] = inputs.map((i) => ({
    id: i.id,
    outstandingReceivable: i.outstandingReceivable,
    outstandingPayable: i.outstandingPayable,
    biltyIds: i.biltyIds,
  }));
  const financialsMap = await computeChallanFinancialsBatch(financialInputs);

  const settledIds = inputs.filter((i) => i.isSettled).map((i) => i.id);
  const partiesMap = await getChallanResponsiblePartiesBatch(settledIds);

  // Fallback tier 1: live SettlementPayment payers, batched once
  // across every settled Challan - never per-document.
  const livePaymentRows = settledIds.length > 0
    ? await prisma.settlementPayment.findMany({
        where: { challanId: { in: settledIds }, component: { in: ["CARRIER_RENT", "COLLECTION"] } },
        select: { challanId: true, component: true, payerAccountId: true },
      })
    : [];
  const livePayerAccountIdsByChallan = new Map<string, { receivable: Set<string>; payable: Set<string> }>();
  for (const row of livePaymentRows) {
    if (!row.challanId) continue;
    const entry = livePayerAccountIdsByChallan.get(row.challanId) || { receivable: new Set(), payable: new Set() };
    if (row.component === "COLLECTION") entry.receivable.add(row.payerAccountId);
    else if (row.component === "CARRIER_RENT") entry.payable.add(row.payerAccountId);
    livePayerAccountIdsByChallan.set(row.challanId, entry);
  }
  const allLivePayerAccountIds = [...new Set(livePaymentRows.map((r) => r.payerAccountId))];
  const livePayerAccounts = allLivePayerAccountIds.length > 0
    ? await prisma.account.findMany({
        where: { id: { in: allLivePayerAccountIds } },
        select: { id: true, accountName: true, party: { select: { id: true, partyName: true } } },
      })
    : [];
  const livePayerAccountById = new Map(livePayerAccounts.map((a) => [a.id, a]));

  function liveFallbackParties(challanId: string, direction: "RECEIVABLE" | "PAYABLE"): ChallanPositionParty[] {
    const accountIds = livePayerAccountIdsByChallan.get(challanId);
    const ids = direction === "RECEIVABLE" ? accountIds?.receivable : accountIds?.payable;
    if (!ids || ids.size === 0) return [];
    return [...ids].map((accountId) => {
      const account = livePayerAccountById.get(accountId);
      return {
        accountId,
        partyId: account?.party?.id || null,
        partyName: account?.party?.partyName || account?.accountName || "Party",
      };
    });
  }

  function roleFallbackParties(inp: ChallanPositionInput, direction: "RECEIVABLE" | "PAYABLE"): ChallanPositionParty[] {
    if (direction === "PAYABLE") {
      return inp.transporterParty
        ? [{ accountId: null, partyId: inp.transporterParty.partyId, partyName: inp.transporterParty.partyName }]
        : [];
    }
    const clearingAgents = inp.biltyParties.map((b) => b.clearingAgent).filter((p): p is { partyId: string; partyName: string } => Boolean(p));
    if (clearingAgents.length > 0) return clearingAgents.map((p) => ({ accountId: null, partyId: p.partyId, partyName: p.partyName }));
    const consignors = inp.biltyParties.map((b) => b.consignor).filter((p): p is { partyId: string; partyName: string } => Boolean(p));
    if (consignors.length > 0) return consignors.map((p) => ({ accountId: null, partyId: p.partyId, partyName: p.partyName }));
    const consignees = inp.biltyParties.map((b) => b.consignee).filter((p): p is { partyId: string; partyName: string } => Boolean(p));
    return consignees.map((p) => ({ accountId: null, partyId: p.partyId, partyName: p.partyName }));
  }

  function resolveParties(inp: ChallanPositionInput, direction: "RECEIVABLE" | "PAYABLE", primary: ChallanPositionParty[]): ChallanPositionParty[] {
    if (primary.length > 0) return primary;
    const live = liveFallbackParties(inp.id, direction);
    if (live.length > 0) return dedupeParties(live);
    return dedupeParties(roleFallbackParties(inp, direction));
  }

  for (const inp of inputs) {
    if (!inp.isSettled) {
      result[inp.id] = { bucket: "BEFORE_SETTLEMENT", lines: [], totalReceivable: 0, totalPayable: 0 };
      continue;
    }

    const fin = financialsMap[inp.id];
    const remReceivable = round2(fin?.remainingReceivable || 0);
    const remPayable = round2(fin?.remainingPayable || 0);

    if (remReceivable <= EPS && remPayable <= EPS) {
      result[inp.id] = clearedPosition();
      continue;
    }

    const parties = partiesMap[inp.id] || { receivable: [], payable: [] };
    const rParties = resolveParties(inp, "RECEIVABLE", parties.receivable.map((p) => ({
      accountId: p.accountId,
      partyId: p.partyId,
      partyName: p.partyName,
    })));
    const pParties = resolveParties(inp, "PAYABLE", parties.payable.map((p) => ({
      accountId: p.accountId,
      partyId: p.partyId,
      partyName: p.partyName,
    })));

    // Net ONLY when both sides are non-zero AND resolve to exactly
    // the same single party - anything more ambiguous (zero, several
    // parties, or two different parties) is shown as two separate
    // lines below instead, never netted. Compared by partyId first
    // (accountId is null for a role-fallback-sourced party - see
    // resolveParties() above - so two DIFFERENT role-fallback parties
    // must never compare equal just because both have a null
    // accountId); falls back to accountId only when neither side has
    // a partyId at all.
    const rIdentity = rParties.length === 1 ? rParties[0].partyId || rParties[0].accountId : null;
    const pIdentity = pParties.length === 1 ? pParties[0].partyId || pParties[0].accountId : null;
    if (
      remReceivable > EPS &&
      remPayable > EPS &&
      rParties.length === 1 &&
      pParties.length === 1 &&
      rIdentity !== null &&
      rIdentity === pIdentity
    ) {
      const net = round2(remReceivable - remPayable);
      if (Math.abs(net) <= EPS) {
        result[inp.id] = clearedPosition();
      } else if (net > 0) {
        result[inp.id] = {
          bucket: "RECEIVABLE",
          lines: [{ direction: "RECEIVABLE", amount: net, parties: rParties }],
          totalReceivable: net,
          totalPayable: 0,
        };
      } else {
        result[inp.id] = {
          bucket: "PAYABLE",
          lines: [{ direction: "PAYABLE", amount: -net, parties: rParties }],
          totalReceivable: 0,
          totalPayable: -net,
        };
      }
      continue;
    }

    const lines: ChallanPositionLine[] = [];
    let totalReceivable = 0;
    let totalPayable = 0;
    if (remReceivable > EPS) {
      lines.push({ direction: "RECEIVABLE", amount: remReceivable, parties: rParties });
      totalReceivable = remReceivable;
    }
    if (remPayable > EPS) {
      lines.push({ direction: "PAYABLE", amount: remPayable, parties: pParties });
      totalPayable = remPayable;
    }

    const bucket: ChallanPositionBucket = lines.length === 2 ? "RECEIVABLE_PAYABLE" : lines[0].direction;
    result[inp.id] = { bucket, lines, totalReceivable, totalPayable };
  }

  return result;
}

export async function computeChallanPosition(input: ChallanPositionInput): Promise<ChallanPosition> {
  const batch = await computeChallanPositionsBatch([input]);
  return batch[input.id] || clearedPosition();
}
