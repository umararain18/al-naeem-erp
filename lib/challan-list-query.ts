import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeChallanFinancialsBatch, type ChallanFinancials } from "@/lib/challan-financials";
import { getChallanResponsiblePartiesBatch, type ChallanResponsibleParties } from "@/lib/document-party-resolution";
import { computeChallanSettlementSummaryBatch, type ChallanSettlementSummary } from "@/lib/challan-settlement-summary";
import { computeChallanPositionsBatch, resolvePaidUnverifiedEntries, type ChallanPosition } from "@/lib/challan-position";

// ============================================================
// CHALLAN LIST QUERY - shared "which Challans match, and what's
// their financial position" pass between app/api/challan/route.ts
// (the paginated list) and app/api/challan/summary/route.ts (the
// lightweight Receivable/Payable/Net totals), so the two can never
// drift onto two different computations of the same numbers (the
// requirement that drove splitting the summary into its own
// endpoint in the first place).
//
// Deliberately split into a LIGHTWEIGHT pass (this file) - minimal
// `select`, no bilty/location/clearing-agent display data, no
// pagination - versus the heavy nested `include` either caller
// layers on top ONLY for the handful of ids it actually needs to
// render (see route.ts's own PAGE-SCOPED HEAVY FETCH comment). The
// "financial" filter (RECEIVABLE/PAYABLE/.../CLEARED) is a COMPUTED
// value, not a column Postgres can filter on directly - every
// Challan matching the plain column filters (status/search/date) is
// read and positioned here, then `financial` narrows the in-memory
// result. This used to cost one query per Bilty/Challan in a loop at
// list-page volume (see computeChallanSettlementSummaryBatch's own
// doc comment); now a small, FIXED number of batched queries
// regardless of how many Challans match, which is what makes doing
// this full-set pass on every list/summary request affordable.
// ============================================================

export type FinancialFilterValue = "BEFORE_SETTLEMENT" | "AFTER_SETTLEMENT" | "RECEIVABLE" | "PAYABLE" | "RECEIVABLE_PAYABLE" | "CLEARED";
export const FINANCIAL_FILTER_VALUES: FinancialFilterValue[] = ["BEFORE_SETTLEMENT", "AFTER_SETTLEMENT", "RECEIVABLE", "PAYABLE", "RECEIVABLE_PAYABLE", "CLEARED"];

export function matchesFinancialFilter(item: { isSettled: boolean; position?: ChallanPosition }, filter: FinancialFilterValue): boolean {
  switch (filter) {
    case "BEFORE_SETTLEMENT":
      return !item.isSettled;
    case "AFTER_SETTLEMENT":
      return item.isSettled;
    case "RECEIVABLE":
      return item.position?.bucket === "RECEIVABLE";
    case "PAYABLE":
      return item.position?.bucket === "PAYABLE";
    case "RECEIVABLE_PAYABLE":
      return item.position?.bucket === "RECEIVABLE_PAYABLE";
    case "CLEARED":
      return item.position?.bucket === "CLEARED";
    default:
      return true;
  }
}

// Newest-Challan-first list ordering. challanNo is a plain String
// column (real data: "4028", "4029", ... - no fixed-width guarantee,
// so a lexicographic sort/orderBy would wrongly rank "10000" behind
// "9999" once the sequence crosses a digit boundary) - Prisma has no
// numeric-cast `orderBy`, so this compares the trailing digit run of
// each challanNo as a BigInt (safe for any length) instead. Falls
// back to a plain string compare only when a challanNo has no digits
// at all, so a genuinely non-numeric value still sorts deterministically
// instead of crashing. createdAt (desc) is the secondary tiebreak for a
// genuine tie (e.g. two Challans sharing a challanNo pattern) - never
// loadingDate (a user-editable, often-backdated business field) and
// never vehicle/updatedAt/DB default order.
function extractChallanSeq(challanNo: string): bigint | null {
  const match = challanNo.match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

export function compareChallanNoDesc(a: string, b: string): number {
  const seqA = extractChallanSeq(a);
  const seqB = extractChallanSeq(b);
  if (seqA !== null && seqB !== null && seqA !== seqB) {
    return seqA > seqB ? -1 : 1;
  }
  return b.localeCompare(a);
}

export interface FilteredChallanPositions {
  // Every id matching `where` AND (if given) `financial`, sorted
  // newest-challanNo-first - the full, definitive order/membership
  // the list route paginates over and the summary route sums over.
  orderedIds: string[];
  challanNoById: Map<string, string>;
  isSettledById: Map<string, boolean>;
  financialsMap: Record<string, ChallanFinancials>;
  responsiblePartiesMap: Record<string, ChallanResponsibleParties>;
  settlementSummaryMap: Record<string, ChallanSettlementSummary>;
  positionsMap: Record<string, ChallanPosition>;
  incomePendingSet: Set<string>;
}

export async function computeFilteredChallanPositions(
  where: Prisma.ChallanWhereInput,
  financial: FinancialFilterValue | null
): Promise<FilteredChallanPositions> {
  // Lightweight `select` only - the full bilty/location/clearing-
  // agent/agent-party display shape lives entirely in route.ts's own
  // page-scoped heavy fetch, never here. consignor/consignee are
  // selected (id + name) because lib/challan-position.ts's tier-3
  // fallback can resolve a party from them even with no ledger line -
  // it cannot borrow from the heavy fetch since this pass runs first
  // and decides WHICH ids even get a heavy fetch.
  const challans = await prisma.challan.findMany({
    where,
    select: {
      id: true,
      challanNo: true,
      createdAt: true,
      isSettled: true,
      carrierRent: true,
      settlementJournalEntryId: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      ownCarrierId: true,
      transporterParty: { select: { id: true, partyName: true } },
      bilties: {
        select: {
          biltyId: true,
          bilty: {
            select: {
              id: true,
              isDeleted: true,
              consignorParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
              consigneeParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
            },
          },
        },
        orderBy: { addedAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  challans.sort((a, b) => compareChallanNoDesc(a.challanNo, b.challanNo) || b.createdAt.getTime() - a.createdAt.getTime());

  const ownCarrierChallanIds = challans.filter((c) => c.ownCarrierId).map((c) => c.id);
  const incomePendingSet = new Set<string>();
  if (ownCarrierChallanIds.length > 0) {
    const [recognized, reversed] = await Promise.all([
      prisma.journalEntry.groupBy({
        by: ["referenceId"],
        where: { referenceType: "CARRIER_TRIP_CLOSE", referenceId: { in: ownCarrierChallanIds }, isDeleted: false },
        _count: { _all: true },
      }),
      prisma.journalEntry.groupBy({
        by: ["referenceId"],
        where: { referenceType: "CARRIER_TRIP_CLOSE_REVERSAL", referenceId: { in: ownCarrierChallanIds }, isDeleted: false },
        _count: { _all: true },
      }),
    ]);
    const recognizedMap = new Map(recognized.map((r) => [r.referenceId as string, r._count._all]));
    const reversedMap = new Map(reversed.map((r) => [r.referenceId as string, r._count._all]));
    for (const id of ownCarrierChallanIds) {
      const net = (recognizedMap.get(id) || 0) - (reversedMap.get(id) || 0);
      if (net <= 0) incomePendingSet.add(id);
    }
  }

  const financialsMap = await computeChallanFinancialsBatch(
    challans.map((c) => ({
      id: c.id,
      outstandingReceivable: c.outstandingReceivable,
      outstandingPayable: c.outstandingPayable,
      biltyIds: c.bilties.map((cb) => cb.biltyId),
    }))
  );

  const responsiblePartiesMap = await getChallanResponsiblePartiesBatch(challans.filter((c) => c.isSettled).map((c) => c.id));

  const settlementSummaryMap = await computeChallanSettlementSummaryBatch(challans.map((c) => c.id));

  const positionsMap = await computeChallanPositionsBatch(
    challans.map((c) => {
      const summary = settlementSummaryMap[c.id];
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
    })
  );

  const orderedIds = financial
    ? challans.filter((c) => matchesFinancialFilter({ isSettled: c.isSettled, position: positionsMap[c.id] }, financial)).map((c) => c.id)
    : challans.map((c) => c.id);

  return {
    orderedIds,
    challanNoById: new Map(challans.map((c) => [c.id, c.challanNo])),
    isSettledById: new Map(challans.map((c) => [c.id, c.isSettled])),
    financialsMap,
    responsiblePartiesMap,
    settlementSummaryMap,
    positionsMap,
    incomePendingSet,
  };
}
