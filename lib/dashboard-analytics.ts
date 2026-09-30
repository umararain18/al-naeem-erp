import { prisma } from "@/lib/prisma";
import { findBillWalkInReceivableAccountId } from "@/lib/gross-accounts";
import { computeChallanFinancialsBatch, ChallanFinancialStatus } from "@/lib/challan-financials";

// ============================================================
// Dashboard Phase 2 - internal, server-only aggregation helpers.
//
// Not a public API - imported only by app/api/dashboard/route.ts, per
// the Phase 2 spec's own instruction to keep ONE dashboard API rather
// than adding new public endpoints.
//
// Every function here is READ-ONLY and batched (one or a small fixed
// number of queries regardless of how many Bills/Challans/Bilties/
// Phonch records fall in the selected period) - never one query per
// row. Where an authoritative per-record helper already exists
// (lib/challan-financials.ts's computeChallanFinancialsBatch) it is
// reused directly. Where no batch variant exists (Bill's
// getBillPaymentState, Private/Showroom Phonch's payment-state
// functions), this file does NOT call the per-record function in a
// loop (that would be exactly the N+1 pattern Phase 2 forbids).
// Instead, for Bill it re-applies that function's own documented
// credit-minus-debit formula across every Bill's lines in ONE grouped
// query (see getBillSummary) - never a different accounting rule. For
// Private/Showroom Phonch, only the safely-aggregatable BOOKED amounts
// (raw stored fields, summed) are computed here - actual paid/
// received-via-Daily-Posting per record is intentionally NOT
// implemented in this phase (see the Phase 2 report's own
// "limitations" section) since no batch helper exists for it yet and
// building one is out of this task's scope.
// ============================================================

function orUndefined(d: Date | null): Date | undefined {
  return d ?? undefined;
}

// ------------------------------------------------------------
// TOP CLIENTS - Revenue (Bill-based; see the Phase 2 report for why
// Bill, not Bilty, is the revenue source used here: Bills are the
// client-facing invoice document, and a Bilty that has already been
// billed would double-count if both were summed as "client revenue").
// ------------------------------------------------------------

export interface TopClientRevenueRow {
  key: string;
  name: string;
  phone: string | null;
  isParty: boolean;
  partyId: string | null;
  mostRecentBillId: string;
  revenue: number;
  billCount: number;
  percentOfTotal: number;
}

export async function getTopClientsByRevenue(
  from: Date | null,
  to: Date | null,
  limit: number
): Promise<{ rows: TopClientRevenueRow[]; totalRevenue: number }> {
  const bills = await prisma.bill.findMany({
    where: { isDeleted: false, date: { gte: orUndefined(from), lt: orUndefined(to) } },
    select: {
      id: true,
      date: true,
      clientPartyId: true,
      clientName: true,
      clientPhone: true,
      items: { select: { rent: true, delivery: true, otherExpense: true } },
    },
  });

  type Accum = TopClientRevenueRow & { _lastDate: Date };
  const map = new Map<string, Accum>();
  let totalRevenue = 0;

  for (const bill of bills) {
    const amount = bill.items.reduce(
      (s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense),
      0
    );
    totalRevenue += amount;

    const key = bill.clientPartyId
      ? `party:${bill.clientPartyId}`
      : `walkin:${bill.clientName.trim().toLowerCase()}|${(bill.clientPhone || "").trim()}`;

    const existing = map.get(key);
    if (existing) {
      existing.revenue += amount;
      existing.billCount += 1;
      if (bill.date > existing._lastDate) {
        existing._lastDate = bill.date;
        existing.mostRecentBillId = bill.id;
      }
    } else {
      map.set(key, {
        key,
        name: bill.clientName,
        phone: bill.clientPhone,
        isParty: Boolean(bill.clientPartyId),
        partyId: bill.clientPartyId,
        mostRecentBillId: bill.id,
        revenue: amount,
        billCount: 1,
        percentOfTotal: 0,
        _lastDate: bill.date,
      });
    }
  }

  const rows = [...map.values()]
    .map((entry): TopClientRevenueRow => {
      const { _lastDate, ...row } = entry;
      void _lastDate;
      return row;
    })
    .sort((a, b) => b.revenue - a.revenue);

  for (const row of rows) {
    row.percentOfTotal = totalRevenue > 0 ? Math.round((row.revenue / totalRevenue) * 1000) / 10 : 0;
  }

  return { rows: rows.slice(0, limit), totalRevenue };
}

// ------------------------------------------------------------
// TOP CLIENTS - Booking/Activity (separate tab; counts only, never
// summed into one blended amount with Bill revenue above).
// ------------------------------------------------------------

export interface TopClientActivityRow {
  partyId: string;
  name: string;
  biltyCount: number;
  billCount: number;
}

export async function getTopClientsByActivity(
  from: Date | null,
  to: Date | null,
  limit: number
): Promise<TopClientActivityRow[]> {
  const [biltyGroups, billGroups, parties] = await Promise.all([
    prisma.bilty.groupBy({
      by: ["consignorPartyId"],
      where: {
        isDeleted: false,
        date: { gte: orUndefined(from), lt: orUndefined(to) },
        consignorPartyId: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.bill.groupBy({
      by: ["clientPartyId"],
      where: {
        isDeleted: false,
        date: { gte: orUndefined(from), lt: orUndefined(to) },
        clientPartyId: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.party.findMany({ select: { id: true, partyName: true } }),
  ]);

  const partyNameById = new Map(parties.map((p) => [p.id, p.partyName]));
  const combined = new Map<string, TopClientActivityRow>();

  for (const g of biltyGroups) {
    if (!g.consignorPartyId) continue;
    combined.set(g.consignorPartyId, {
      partyId: g.consignorPartyId,
      name: partyNameById.get(g.consignorPartyId) || "Unknown Party",
      biltyCount: g._count._all,
      billCount: 0,
    });
  }
  for (const g of billGroups) {
    if (!g.clientPartyId) continue;
    const existing = combined.get(g.clientPartyId);
    if (existing) existing.billCount = g._count._all;
    else
      combined.set(g.clientPartyId, {
        partyId: g.clientPartyId,
        name: partyNameById.get(g.clientPartyId) || "Unknown Party",
        biltyCount: 0,
        billCount: g._count._all,
      });
  }

  return [...combined.values()]
    .sort((a, b) => b.biltyCount + b.billCount - (a.biltyCount + a.billCount))
    .slice(0, limit);
}

// ------------------------------------------------------------
// TOP TRANSPORTERS - Carrier Rent (Challan-based, reusing
// computeChallanFinancialsBatch so Payable/Paid figures never diverge
// from the Challan Detail page's own numbers). Clearing Agent Payable
// lives on a different Party/Account entirely (Bilty.clearingAgentPartyId)
// and is never read here.
// ------------------------------------------------------------

export interface TopTransporterRow {
  partyId: string;
  name: string;
  carrierRent: number;
  challanCount: number;
  paid: number;
  outstandingPayable: number;
  percentOfTotal: number;
}

export async function getTopTransportersByCarrierRent(
  from: Date | null,
  to: Date | null,
  limit: number
): Promise<{ rows: TopTransporterRow[]; totalCarrierRent: number }> {
  const challans = await prisma.challan.findMany({
    where: {
      isDeleted: false,
      loadingDate: { gte: orUndefined(from), lt: orUndefined(to) },
      transporterPartyId: { not: null },
    },
    select: {
      id: true,
      carrierRent: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      transporterPartyId: true,
      transporterParty: { select: { partyName: true } },
      bilties: { select: { biltyId: true } },
    },
  });

  if (challans.length === 0) return { rows: [], totalCarrierRent: 0 };

  const financials = await computeChallanFinancialsBatch(
    challans.map((c) => ({
      id: c.id,
      outstandingReceivable: c.outstandingReceivable,
      outstandingPayable: c.outstandingPayable,
      biltyIds: c.bilties.map((b) => b.biltyId),
    }))
  );

  const map = new Map<string, TopTransporterRow>();
  let totalCarrierRent = 0;

  for (const c of challans) {
    if (!c.transporterPartyId) continue;
    const fin = financials[c.id];
    const carrierRent = Number(c.carrierRent);
    totalCarrierRent += carrierRent;

    const row =
      map.get(c.transporterPartyId) ||
      ({
        partyId: c.transporterPartyId,
        name: c.transporterParty?.partyName || "—",
        carrierRent: 0,
        challanCount: 0,
        paid: 0,
        outstandingPayable: 0,
        percentOfTotal: 0,
      } as TopTransporterRow);

    row.carrierRent += carrierRent;
    row.challanCount += 1;
    row.paid += fin?.paid || 0;
    row.outstandingPayable += fin?.remainingPayable || 0;
    map.set(c.transporterPartyId, row);
  }

  const rows = [...map.values()].sort((a, b) => b.carrierRent - a.carrierRent);
  for (const row of rows) {
    row.percentOfTotal = totalCarrierRent > 0 ? Math.round((row.carrierRent / totalCarrierRent) * 1000) / 10 : 0;
  }

  return { rows: rows.slice(0, limit), totalCarrierRent };
}

// ------------------------------------------------------------
// BILTY SUMMARY - one aggregate query. "Paid" here is the Bilty's own
// stored Advance/Paid field, exactly as recorded on the document -
// NOT independently verified against actual Daily Posting Cash/Bank
// receipt (that verification is lib/bilty-paid-verification.ts's own
// per-Bilty job, with no batch variant; see the Phase 2 report's
// limitations section for why it is not reused here).
// ------------------------------------------------------------

export interface BiltySummary {
  count: number;
  totalBookingAmount: number;
  paidAmount: number;
  toPayAmount: number;
}

export async function getBiltySummary(from: Date | null, to: Date | null): Promise<BiltySummary> {
  const agg = await prisma.bilty.aggregate({
    where: { isDeleted: false, date: { gte: orUndefined(from), lt: orUndefined(to) } },
    _count: { _all: true },
    _sum: { total: true, advance: true, toPay: true },
  });

  return {
    count: agg._count._all,
    totalBookingAmount: Number(agg._sum.total || 0),
    paidAmount: Number(agg._sum.advance || 0),
    toPayAmount: Number(agg._sum.toPay || 0),
  };
}

// ------------------------------------------------------------
// CHALLAN SUMMARY - batched via computeChallanFinancialsBatch; status
// counts use ONLY the 4 real statuses that function already defines
// (OPEN / PARTIALLY_CLEARED / CLEARED / OVERPAID) - no invented model.
// ------------------------------------------------------------

export interface ChallanSummary {
  count: number;
  totalCarrierRent: number;
  totalReceivable: number;
  totalPayable: number;
  statusCounts: Record<ChallanFinancialStatus, number>;
}

export async function getChallanSummary(from: Date | null, to: Date | null): Promise<ChallanSummary> {
  const empty: ChallanSummary = {
    count: 0,
    totalCarrierRent: 0,
    totalReceivable: 0,
    totalPayable: 0,
    statusCounts: { OPEN: 0, PARTIALLY_CLEARED: 0, CLEARED: 0, OVERPAID: 0 },
  };

  const challans = await prisma.challan.findMany({
    where: { isDeleted: false, loadingDate: { gte: orUndefined(from), lt: orUndefined(to) } },
    select: {
      id: true,
      carrierRent: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      bilties: { select: { biltyId: true } },
    },
  });

  if (challans.length === 0) return empty;

  const financials = await computeChallanFinancialsBatch(
    challans.map((c) => ({
      id: c.id,
      outstandingReceivable: c.outstandingReceivable,
      outstandingPayable: c.outstandingPayable,
      biltyIds: c.bilties.map((b) => b.biltyId),
    }))
  );

  const result = { ...empty, statusCounts: { ...empty.statusCounts } };
  result.count = challans.length;

  for (const c of challans) {
    result.totalCarrierRent += Number(c.carrierRent);
    const fin = financials[c.id];
    if (!fin) continue;
    result.totalReceivable += fin.remainingReceivable;
    result.totalPayable += fin.remainingPayable;
    result.statusCounts[fin.status] += 1;
  }

  return result;
}

// ------------------------------------------------------------
// BILL SUMMARY - batched re-application of getBillPaymentState()'s own
// documented formula (client-account CREDIT minus DEBIT, filtered to
// sourceType "BILL" + this Bill's own sourceId + this Bill's own
// resolved client account - the exact same triple that function
// filters by, including its own defense against the Cash/Bank-side
// double-tag bug its header comment describes) across every Bill in
// the period in ONE JournalLine query, instead of calling that
// function once per Bill (which would be a real N+1 - Bill has no
// batch variant of its own, unlike Challan).
// ------------------------------------------------------------

export interface BillSummary {
  count: number;
  totalAmount: number;
  collected: number;
  outstanding: number;
  paidCount: number;
  partiallyPaidCount: number;
  unpaidCount: number;
}

const EPS = 0.009;

export async function getBillSummary(from: Date | null, to: Date | null): Promise<BillSummary> {
  const empty: BillSummary = {
    count: 0,
    totalAmount: 0,
    collected: 0,
    outstanding: 0,
    paidCount: 0,
    partiallyPaidCount: 0,
    unpaidCount: 0,
  };

  const bills = await prisma.bill.findMany({
    where: { isDeleted: false, date: { gte: orUndefined(from), lt: orUndefined(to) } },
    select: {
      id: true,
      clientPartyId: true,
      clientParty: { select: { account: { select: { id: true } } } },
      items: { select: { rent: true, delivery: true, otherExpense: true } },
    },
  });

  if (bills.length === 0) return empty;

  const walkinAccountId = await findBillWalkInReceivableAccountId(prisma);
  const accountIdByBillId = new Map<string, string | null>();
  for (const b of bills) {
    accountIdByBillId.set(b.id, b.clientParty?.account?.id || walkinAccountId);
  }

  const billIds = bills.map((b) => b.id);
  const relevantAccountIds = [...new Set([...accountIdByBillId.values()].filter((v): v is string => Boolean(v)))];

  const lines =
    relevantAccountIds.length > 0
      ? await prisma.journalLine.findMany({
          where: {
            sourceType: "BILL",
            sourceId: { in: billIds },
            accountId: { in: relevantAccountIds },
            journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
          },
          select: { sourceId: true, accountId: true, debit: true, credit: true },
        })
      : [];

  const receivedByBillId = new Map<string, number>();
  for (const l of lines) {
    if (!l.sourceId) continue;
    // Same defense getBillPaymentState() itself applies: only the
    // CLIENT account's own line counts, never the Cash/Bank side of
    // the same Daily Posting entry (which shares this sourceId too).
    if (accountIdByBillId.get(l.sourceId) !== l.accountId) continue;
    receivedByBillId.set(
      l.sourceId,
      (receivedByBillId.get(l.sourceId) || 0) + Number(l.credit) - Number(l.debit)
    );
  }

  const result = { ...empty };
  result.count = bills.length;

  for (const b of bills) {
    const amount = b.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0);
    result.totalAmount += amount;

    const rawReceived = Math.max(0, receivedByBillId.get(b.id) || 0);
    const received = Math.min(rawReceived, amount); // never let a data inconsistency show as "collected > billed"
    result.collected += received;

    if (received >= amount - EPS) result.paidCount += 1;
    else if (received > EPS) result.partiallyPaidCount += 1;
    else result.unpaidCount += 1;
  }

  result.outstanding = Math.max(0, result.totalAmount - result.collected);
  return result;
}

// ------------------------------------------------------------
// PRIVATE vs SHOWROOM PHONCH - operational counts + BOOKED financial
// amounts only (established at creation, from raw stored fields).
// Actual paid/received-via-Daily-Posting per record is intentionally
// NOT computed here (see this file's own header comment) - never
// blended into one combined "Phonch" number, since the two modules'
// accounting dimensions are genuinely different (a receivable for
// Showroom, a payable-plus-recovery for Private).
// ------------------------------------------------------------

export interface ShowroomPhonchSummary {
  recordCount: number;
  vehicleCount: number;
  deliveryCharges: number;
  otherExpense: number;
  claimAmount: number;
}

export interface PrivatePhonchSummary {
  recordCount: number;
  vehicleCount: number;
  totalRent: number;
  deliveryCharges: number;
  netRent: number;
  carrierPayable: number;
  caPayable: number;
  deliveryRecovery: number;
}

/**
 * Pure derivation of a single Private Phonch vehicle's Net Rent/CA
 * Payable/Delivery Recovery from its raw stored fields - the EXACT
 * formula documented in lib/private-phonch-accounting.ts's
 * resolvePrivatePhonchInput() (never a different rule): a fully-paid
 * vehicle (totalRent <= 0) recognizes its Delivery Charges as a
 * Delivery Recovery instead of a negative Net Rent.
 */
export function derivePrivatePhonchVehicleAmounts(vehicle: {
  totalRent: number;
  deliveryCharges: number;
  carrierPayable: number;
}): { netRent: number; caPayable: number; deliveryRecovery: number } {
  if (vehicle.totalRent <= EPS) {
    return { netRent: 0, caPayable: 0, deliveryRecovery: vehicle.deliveryCharges };
  }
  const netRent = vehicle.totalRent - vehicle.deliveryCharges;
  const caPayable = Math.max(0, netRent - vehicle.carrierPayable);
  return { netRent, caPayable, deliveryRecovery: 0 };
}

export async function getPhonchComparison(
  from: Date | null,
  to: Date | null
): Promise<{ showroom: ShowroomPhonchSummary; private: PrivatePhonchSummary }> {
  const dateFilter = { gte: orUndefined(from), lt: orUndefined(to) };

  const [showroomAgg, showroomCount, privateVehicles, privateCount] = await Promise.all([
    prisma.phonchVehicle.aggregate({
      where: { phonch: { isDeleted: false, date: dateFilter } },
      _count: { _all: true },
      _sum: { deliveryCharges: true, otherExpenseAmount: true, claimAmount: true },
    }),
    prisma.phonch.count({ where: { isDeleted: false, date: dateFilter } }),
    prisma.privatePhonchVehicle.findMany({
      where: { phonch: { isDeleted: false, date: dateFilter } },
      select: { totalRent: true, deliveryCharges: true, carrierPayable: true },
    }),
    prisma.privatePhonch.count({ where: { isDeleted: false, date: dateFilter } }),
  ]);

  const privateSummary: PrivatePhonchSummary = {
    recordCount: privateCount,
    vehicleCount: privateVehicles.length,
    totalRent: 0,
    deliveryCharges: 0,
    netRent: 0,
    carrierPayable: 0,
    caPayable: 0,
    deliveryRecovery: 0,
  };

  for (const v of privateVehicles) {
    const totalRent = Number(v.totalRent);
    const deliveryCharges = Number(v.deliveryCharges);
    const carrierPayable = Number(v.carrierPayable);
    const derived = derivePrivatePhonchVehicleAmounts({ totalRent, deliveryCharges, carrierPayable });

    privateSummary.totalRent += totalRent;
    privateSummary.deliveryCharges += deliveryCharges;
    privateSummary.netRent += derived.netRent;
    privateSummary.carrierPayable += carrierPayable;
    privateSummary.caPayable += derived.caPayable;
    privateSummary.deliveryRecovery += derived.deliveryRecovery;
  }

  return {
    showroom: {
      recordCount: showroomCount,
      vehicleCount: showroomAgg._count._all,
      deliveryCharges: Number(showroomAgg._sum.deliveryCharges || 0),
      otherExpense: Number(showroomAgg._sum.otherExpenseAmount || 0),
      claimAmount: Number(showroomAgg._sum.claimAmount || 0),
    },
    private: privateSummary,
  };
}
