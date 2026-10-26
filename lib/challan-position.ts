import { Decimal } from "@prisma/client/runtime/library";
import { computeChallanFinancialsBatch, type ChallanFinancialInput } from "./challan-financials";
import type { ChallanSettlementSummary } from "./challan-settlement-summary";

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
  // Set ONLY on a Bilty-Paid-but-unverified line (see
  // ChallanPositionInput.paidUnverified below) - lets the UI render
  // "(Bilty paid, not received)" next to it so it is never confused
  // with a genuine Collection/Carrier-Rent receivable. Undefined for
  // every other line (unchanged).
  note?: string;
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
  // One entry per Bilty on this Challan whose Paid (advance) amount
  // is not yet verified via a real Daily Posting receipt
  // (getBiltyPaidVerification's own unverifiedAmount) - see this
  // module's own doc comment for why this is NEVER folded into
  // partyNet/remReceivable above. Each entry becomes its OWN,
  // separate RECEIVABLE line - never netted against ANY Payable
  // (even one for the identical party), and never combined with a
  // Collection/Carrier-Rent-sourced receivable. Entries for the same
  // party (partyId, else accountId) ARE summed together into one
  // line, same as every other tier's own dedup. Omit/empty when this
  // Challan has no unverified Paid amount at all.
  paidUnverified?: { accountId: string; partyId: string | null; partyName: string; amount: number }[];
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

    // Bilty-Paid-but-unverified amounts, grouped by responsible party
    // (same dedup key as everywhere else: partyId, else accountId) -
    // computed BEFORE anything else below, and merged in at the very
    // end, so there is only ONE place that ever decides how these
    // combine with the Collection/Carrier-Rent position (nowhere:
    // they never net against it, by construction - see
    // ChallanPositionInput.paidUnverified's own doc comment and this
    // module's header).
    const paidUnverifiedLines = groupPaidUnverified(inp.paidUnverified);

    const base = computeBasePosition(inp, financialsMap[inp.id]);
    result[inp.id] = mergePaidUnverified(base, paidUnverifiedLines);
  }

  return result;
}

/** Groups ChallanPositionInput.paidUnverified entries by party
 * identity (partyId, else accountId) into one ChallanPositionLine
 * per distinct party, amounts summed - the same dedup key
 * dedupeParties() uses elsewhere in this file. Drops any entry whose
 * amount rounds to ~0. */
function groupPaidUnverified(
  entries: ChallanPositionInput["paidUnverified"]
): ChallanPositionLine[] {
  if (!entries || entries.length === 0) return [];
  const byKey = new Map<string, { party: ChallanPositionParty; amount: number }>();
  for (const e of entries) {
    if (e.amount <= EPS) continue;
    const key = e.partyId || e.accountId;
    const existing = byKey.get(key);
    if (existing) {
      existing.amount = round2(existing.amount + e.amount);
    } else {
      byKey.set(key, {
        party: { accountId: e.accountId, partyId: e.partyId, partyName: e.partyName },
        amount: round2(e.amount),
      });
    }
  }
  return [...byKey.values()]
    .filter((v) => v.amount > EPS)
    .map((v) => ({
      direction: "RECEIVABLE" as const,
      amount: v.amount,
      parties: [v.party],
      note: "Bilty paid, not received",
    }));
}

/** The Collection/Carrier-Rent-sourced position only - everything
 * this module computed BEFORE the Paid-unverified feature existed,
 * unchanged. Never returns null; `clearedPosition()` when both sides
 * are ~0. */
function computeBasePosition(
  inp: ChallanPositionInput,
  fin: { remainingReceivable: number; remainingPayable: number } | undefined
): ChallanPosition {
  const remReceivable = round2(fin?.remainingReceivable || 0);
  const remPayable = round2(fin?.remainingPayable || 0);

  if (remReceivable <= EPS && remPayable <= EPS) {
    return clearedPosition();
  }

  const rParties = resolveParties(inp, "RECEIVABLE");
  const pParties = resolveParties(inp, "PAYABLE");

  // Net ONLY when both sides are non-zero AND resolve to exactly the
  // same single party - anything more ambiguous (zero, several
  // parties, or two different parties) is shown as two separate
  // lines below instead, never netted. Compared by partyId first
  // (accountId is null for a role-fallback-sourced party - see
  // resolveParties() above - so two DIFFERENT role-fallback parties
  // must never compare equal just because both have a null
  // accountId); falls back to accountId only when neither side has a
  // partyId at all.
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
      return clearedPosition();
    }
    if (net > 0) {
      return {
        bucket: "RECEIVABLE",
        lines: [{ direction: "RECEIVABLE", amount: net, parties: rParties }],
        totalReceivable: net,
        totalPayable: 0,
      };
    }
    return {
      bucket: "PAYABLE",
      lines: [{ direction: "PAYABLE", amount: -net, parties: rParties }],
      totalReceivable: 0,
      totalPayable: -net,
    };
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

  if (lines.length === 0) return clearedPosition();
  const bucket: ChallanPositionBucket = lines.length === 2 ? "RECEIVABLE_PAYABLE" : lines[0].direction;
  return { bucket, lines, totalReceivable, totalPayable };
}

/** Appends `paidUnverifiedLines` to `base` - always additive, never
 * netted against base's own RECEIVABLE/PAYABLE line(s) even when a
 * paid-unverified party happens to coincide with one of them (a
 * Bilty-Paid-but-unverified amount is informational/context only per
 * the approved business rule, categorically different from a real
 * Collection/Carrier-Rent position - see this module's own header).
 * A Challan can therefore never show CLEARED while a genuine
 * unverified Paid amount is outstanding. */
function mergePaidUnverified(base: ChallanPosition, paidUnverifiedLines: ChallanPositionLine[]): ChallanPosition {
  if (paidUnverifiedLines.length === 0) return base;

  const addedReceivable = round2(paidUnverifiedLines.reduce((s, l) => s + l.amount, 0));
  const lines = [...base.lines, ...paidUnverifiedLines];
  const totalReceivable = round2(base.totalReceivable + addedReceivable);
  const totalPayable = base.totalPayable;

  const bucket: ChallanPositionBucket =
    totalPayable > EPS ? "RECEIVABLE_PAYABLE" : "RECEIVABLE";

  return { bucket, lines, totalReceivable, totalPayable };
}

export async function computeChallanPosition(input: ChallanPositionInput): Promise<ChallanPosition> {
  const batch = await computeChallanPositionsBatch([input]);
  return batch[input.id] || clearedPosition();
}

/**
 * Resolves each Bilty's own Paid-but-unverified amount (already
 * computed once by computeChallanSettlementSummaryBatch/
 * computeChallanSettlementSummary - never recalculated here) into
 * this module's own ChallanPositionInput.paidUnverified shape - its
 * own `accountId` is enough for display, but the Party Ledger link
 * needs a real `partyId` too, which getBiltyPaidVerification never
 * resolves (it only ever returns the account). The Paid-responsible
 * party is always either this Bilty's own Consignor or Consignee
 * (see resolveBiltyPaidResponsibleParty's own fallback chain) -
 * matched here by account id against those two relations, which the
 * caller must already have loaded for its own tier-3 role-fallback
 * construction (ChallanPositionInput.biltyParties) - never a new
 * query. Falls back to partyId: null (still fully displayable, just
 * without a Party Ledger link) only for the rare explicit
 * paidResponsibleParty override that is neither the Consignor nor
 * Consignee.
 */
export function resolvePaidUnverifiedEntries(
  bilties: {
    bilty: {
      id: string;
      consignorParty: { id: string; account: { id: string } | null } | null;
      consigneeParty: { id: string; account: { id: string } | null } | null;
    };
  }[],
  summary: ChallanSettlementSummary | null | undefined
): NonNullable<ChallanPositionInput["paidUnverified"]> {
  if (!summary) return [];
  const result: NonNullable<ChallanPositionInput["paidUnverified"]> = [];
  for (const b of summary.bilties) {
    if (b.paidUnverified <= EPS || !b.paidResponsiblePartyAccountId || !b.paidResponsiblePartyName) continue;
    const cb = bilties.find((x) => x.bilty.id === b.biltyId);
    const consignorAccountId = cb?.bilty.consignorParty?.account?.id;
    const consigneeAccountId = cb?.bilty.consigneeParty?.account?.id;
    const partyId =
      consignorAccountId === b.paidResponsiblePartyAccountId
        ? cb!.bilty.consignorParty!.id
        : consigneeAccountId === b.paidResponsiblePartyAccountId
          ? cb!.bilty.consigneeParty!.id
          : null;
    result.push({
      accountId: b.paidResponsiblePartyAccountId,
      partyId,
      partyName: b.paidResponsiblePartyName,
      amount: b.paidUnverified,
    });
  }
  return result;
}
