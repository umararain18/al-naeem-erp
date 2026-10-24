import { Decimal } from "@prisma/client/runtime/library";
import { computeChallanFinancialsBatch, type ChallanFinancialInput } from "./challan-financials";

// ============================================================
// ONE FINANCIAL POSITION PER CHALLAN - the single shared calculation
// the Challan list (table, filter, summary cards) and the Challan
// Detail page must all read, so they can never disagree again.
//
// The AMOUNTS (remainingReceivable/remainingPayable) come from
// computeChallanFinancialsBatch() (lib/challan-financials.ts),
// UNCHANGED - `remainingReceivable`/`remainingPayable` already read
// Challan.outstandingReceivable/outstandingPayable (which the
// SettlementPayment multi-payer engine keeps continuously adjusted -
// see adjustChallanOutstanding() in lib/settlement-payments.ts) minus
// real, per-line-attributed Daily Posting receipts/payments. Never
// the settlement reclassification entry, never both sources summed,
// never negative.
//
// The PARTY NAME(s) those amounts belong to are resolved through
// THREE tiers, in order (see resolveParties() below for the full
// reasoning) - deliberately NOT getChallanResponsiblePartiesBatch()
// (lib/document-party-resolution.ts): that function only reads
// SETTLEMENT/SETTLEMENT_CORRECTION JournalLines, which makes it
// structurally blind to a Challan that was Unsettled and re-Settled -
// Unsettle never edits or deletes the original entries, it posts a
// NEW, separate SETTLEMENT_UNSETTLE_REVERSAL-tagged entry instead
// (lib/challan-lifecycle.ts's reverseChallanSettlementEntries()) -
// so a resolver that only reads SETTLEMENT/SETTLEMENT_CORRECTION
// still sees the ORIGINAL, now-reversed party as if still valid. This
// was the exact cause of Challan 6425 showing "Receivable ... from
// Mumtaz Ali Digree" (the Bilty's Clearing Agent, attributed at the
// FIRST settlement) when the CURRENT, active settlement had already
// reassigned Collection to Nawab Broker:
//  1. getChallanResponsibleParties() (OLD) found Mumtaz Ali Digree -
//     a real, non-empty result, so the bug was never "found nobody,
//     fell back to a guess" (that would have been caught already) -
//     it was "found a STALE answer and trusted it".
//  2. SETTLEMENT_UNSETTLE_REVERSAL IS already included in
//     SETTLEMENT_NET_REFERENCE_TYPES (lib/settlement-correction.ts),
//     so partyNet (lib/challan-settlement-summary.ts, computed the
//     SAME way getPartyNetFromSettlement() does) already correctly
//     nets the reversal to zero for Mumtaz Ali Digree and shows the
//     CURRENT reassignment to Nawab Broker instead - this is why
//     tier 1 below reads partyNet, never getChallanResponsibleParties().
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
  // Deliberately NO Clearing Agent field here - Clearing Agent must
  // never be used as a blind role-based guess (tier 3 below); it may
  // still be the CORRECT answer, but only by actually appearing in
  // the ledger (tier 1) or as a live "Collected by" payer (tier 2).
  consignor: { partyId: string; partyName: string } | null;
  consignee: { partyId: string; partyName: string } | null;
}

export interface ChallanPositionPartyNetEntry {
  accountId: string;
  partyId: string | null;
  partyName: string;
  direction: "RECEIVABLE" | "PAYABLE";
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

export interface ChallanPositionLivePayer {
  accountId: string;
  partyId: string | null;
  partyName: string;
}

export interface ChallanPositionInput {
  id: string;
  isSettled: boolean;
  outstandingReceivable: number | string | Decimal;
  outstandingPayable: number | string | Decimal;
  biltyIds: string[];
  // TIER 1 - the Challan's own current, active, cross-component party
  // net (lib/challan-settlement-summary.ts's partyNet - computed the
  // same way getPartyNetFromSettlement() does, reading
  // SETTLEMENT_NET_REFERENCE_TYPES, which already includes
  // SETTLEMENT_UNSETTLE_REVERSAL). The caller already computes this
  // for its own Bilty-Rent-total/Final-Settlement needs - passed
  // straight through, never a new query here.
  partyNet: ChallanPositionPartyNetEntry[];
  // TIER 2 - the live "Collected by" (To-Pay) / "Paid by" (Carrier
  // Rent) payers already shown on the Detail page's own component
  // cards (challan.settlementSummary.bilties[].toPay.payers /
  // .carrierRent.payers) - per-component, catching a party whose
  // cross-component net (tier 1) happens to net to zero while one
  // component individually still has a live payer.
  collectedByParties: ChallanPositionLivePayer[];
  paidByParties: ChallanPositionLivePayer[];
  // TIER 3 - document role fields, display-only fallback for the
  // (rare) Challan where neither tier above resolves anyone. Never
  // Clearing Agent (see ChallanPositionBiltyPartyRoles's own comment).
  transporterParty: { partyId: string; partyName: string } | null;
  biltyParties: ChallanPositionBiltyPartyRoles[];
}

function clearedPosition(): ChallanPosition {
  return { bucket: "CLEARED", lines: [], totalReceivable: 0, totalPayable: 0 };
}

// ============================================================
// PARTY RESOLUTION - THREE TIERS, in order (display only, never an
// amount). See this file's own module header above for the full
// Challan 6425 case study this fixes.
//
//  1. partyNet, filtered to this direction - the Challan's own
//     current, active, cross-component net (already correctly nets
//     out an Unsettle reversal, a correction, or a multi-payer
//     reassignment - see SETTLEMENT_NET_REFERENCE_TYPES).
//  2. The live "Collected by"/"Paid by" payers already shown on the
//     Detail page's own component cards - catches a party whose
//     CROSS-component net (tier 1) nets to zero while THIS component
//     alone still has a real, live payer.
//  3. Document role fields - the Transporter for Payable; a linked
//     Bilty's own Consignor, else Consignee, for Receivable. Never
//     Clearing Agent here - only tiers 1/2 above may ever surface a
//     Clearing Agent, and only when the ledger itself says so.
// If none of the three resolves anyone, `parties` stays empty and
// the caller shows "Party not set" - never silently blank, never a
// guess presented as fact.
// ============================================================

function dedupeParties(parties: ChallanPositionParty[]): ChallanPositionParty[] {
  const seen = new Map<string, ChallanPositionParty>();
  for (const p of parties) {
    const key = p.partyId || p.accountId || p.partyName;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

function toPositionParty(p: { accountId: string; partyId: string | null; partyName: string }): ChallanPositionParty {
  return { accountId: p.accountId, partyId: p.partyId, partyName: p.partyName };
}

function roleFallbackParties(inp: ChallanPositionInput, direction: "RECEIVABLE" | "PAYABLE"): ChallanPositionParty[] {
  if (direction === "PAYABLE") {
    return inp.transporterParty
      ? [{ accountId: null, partyId: inp.transporterParty.partyId, partyName: inp.transporterParty.partyName }]
      : [];
  }
  const consignors = inp.biltyParties.map((b) => b.consignor).filter((p): p is { partyId: string; partyName: string } => Boolean(p));
  if (consignors.length > 0) return consignors.map((p) => ({ accountId: null, partyId: p.partyId, partyName: p.partyName }));
  const consignees = inp.biltyParties.map((b) => b.consignee).filter((p): p is { partyId: string; partyName: string } => Boolean(p));
  return consignees.map((p) => ({ accountId: null, partyId: p.partyId, partyName: p.partyName }));
}

function resolveParties(inp: ChallanPositionInput, direction: "RECEIVABLE" | "PAYABLE"): ChallanPositionParty[] {
  const tier1 = inp.partyNet.filter((p) => p.direction === direction).map(toPositionParty);
  if (tier1.length > 0) return dedupeParties(tier1);

  const tier2 = (direction === "RECEIVABLE" ? inp.collectedByParties : inp.paidByParties).map(toPositionParty);
  if (tier2.length > 0) return dedupeParties(tier2);

  return dedupeParties(roleFallbackParties(inp, direction));
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

    const rParties = resolveParties(inp, "RECEIVABLE");
    const pParties = resolveParties(inp, "PAYABLE");

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
