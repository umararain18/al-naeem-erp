import { Decimal } from "@prisma/client/runtime/library";
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
  accountId: string;
  partyId: string | null;
  partyName: string;
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
}

function clearedPosition(): ChallanPosition {
  return { bucket: "CLEARED", lines: [], totalReceivable: 0, totalPayable: 0 };
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
    const rParties: ChallanPositionParty[] = parties.receivable.map((p) => ({
      accountId: p.accountId,
      partyId: p.partyId,
      partyName: p.partyName,
    }));
    const pParties: ChallanPositionParty[] = parties.payable.map((p) => ({
      accountId: p.accountId,
      partyId: p.partyId,
      partyName: p.partyName,
    }));

    // Net ONLY when both sides are non-zero AND resolve to exactly
    // the same single party - anything more ambiguous (zero, several
    // parties, or two different parties) is shown as two separate
    // lines below instead, never netted.
    if (
      remReceivable > EPS &&
      remPayable > EPS &&
      rParties.length === 1 &&
      pParties.length === 1 &&
      rParties[0].accountId === pParties[0].accountId
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
