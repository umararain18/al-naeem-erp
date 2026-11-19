import { prisma } from "@/lib/prisma";
import { accumulateBalances, netIncome, netExpense } from "@/lib/pnl";
import { getReceivablePayable, ageingBucketForDays, AGEING_BUCKET_LABELS, type PartyBalanceRow } from "@/lib/receivable-payable";
import { getTopTransportersByCarrierRent } from "@/lib/dashboard-analytics";
import { getLatestOpenTrip, getTripProfitReport } from "@/lib/carrier-trip";
import { getUnearnedRevenueAccountId } from "@/lib/gross-accounts";
import { getPartyDocumentStates } from "@/lib/payment-allocation";
import { computePartyFifoPreview, checkPartyReconciliation, type PartyFifoPreview } from "@/lib/party-payment-fifo";
import { getBusinessSettings } from "@/lib/business-settings";
import { resolveDateRange, safePercentChange as rawPercentChange, toISODate, type DatePreset } from "@/lib/date-range";
import { computeRouteMargins, detectEmptyReturnCities, type RouteBiltyInput, type RouteChallanInput } from "./route-margins";
import { applyDailySummaryPermissions, type DailySummaryPermissions } from "./daily-summary-permissions";

// ============================================================
// DAILY SUMMARY - the ONE typed read-only aggregation every Dashboard
// card (and, later, the AI WhatsApp report) is built from. No card
// computes its own numbers separately - see app/api/reports/daily-
// summary/route.ts, the thin wrapper that calls ONLY this file.
//
// Field names are STABLE - this is also the eventual AI WhatsApp
// report's own data source, so a field is renamed only with a real
// reason, never casually.
//
// Reuses, never re-derives: lib/pnl.ts (Income/Expense netting),
// lib/receivable-payable.ts (Receivable/Payable + Ageing),
// lib/dashboard-analytics.ts (Top Clients by activity, Top
// Transporters by Carrier Rent), lib/carrier-trip.ts (Own Carrier Trip
// profit), lib/party-payment-fifo.ts (FIFO reconciliation),
// lib/gross-accounts.ts (Unearned Revenue system account),
// lib/date-range.ts (period resolution + period-over-period % deltas).
// ============================================================

export interface DrilldownRow {
  rank: number;
  name: string;
  link: string | null;
  count: number;
  amount: number;
}

export interface DrilldownDataset {
  title: string;
  subtitle: string;
  columns: [string, string, string]; // [name column label, count column label, amount column label]
  rows: DrilldownRow[];
}

export type DrilldownKey =
  | "cust" | "ca" | "sr" | "ch" | "rec" | "pay" | "routes" | "exp" | "inc"
  | "tb" | "tc" | "tbill" | "tsr" | "tpp" | "tin" | "tout" | "loss" | "settle";

// Permission gating (see lib/reports/daily-summary-permissions.ts's own
// doc comment): every field below that can be `null` is null ONLY
// because the requesting user lacks the permission that guards it -
// never a legitimate "zero" value wearing a null costume. `[]` (an
// empty array) still means "you have access, there's just nothing to
// show" - a genuinely different, non-sensitive state from `null`.
export interface DailySummaryResponse {
  meta: {
    // The date "Aaj ka khulasa" actually reflects - defaults to
    // latestPostedDateISO (see below), NOT the server's own clock
    // date, unless the caller passed an explicit `date` param (the
    // date picker / "Kal"/"Aaj" quick buttons).
    todayISO: string;
    // The most recent date ANY JournalEntry was posted for, server-
    // wide - always computed, regardless of what `date` was
    // requested, so the "Aakhri posted din" quick button always has
    // a real target even when the picker is showing some other date.
    latestPostedDateISO: string | null;
    period: DatePreset;
    periodLabel: string;
    periodFromISO: string | null;
    periodToISO: string | null;
    comparisonLabel: string | null;
    generatedAt: string;
  };
  today: {
    // bilty.view
    biltyCount: number | null;
    biltyBookingAmount: number | null;
    // challan.view
    challanCount: number | null;
    challanDispatchedCount: number | null;
    // bill.view
    billCount: number | null;
    billAmount: number | null;
    // phonch.view
    showroomPhonchVehicleCount: number | null;
    showroomPhonchDeliveryCharges: number | null;
    // privatePhonch.view
    privatePhonchVehicleCount: number | null;
    privatePhonchRent: number | null;
    // reports.view
    cashIn: number | null;
    cashOut: number | null;
    netCash: number | null;
    cashByAccount: { accountId: string; accountName: string; balance: number }[] | null;
    totalCash: number | null;
  };
  // reports.view
  profit: {
    totalIncome: number;
    totalExpense: number;
    profit: number;
    incomeDeltaPct: number | null;
    expenseDeltaPct: number | null;
    profitDeltaPct: number | null;
    bookingIncome: number;
    carrierRent: number;
    grossMargin: number;
    grossMarginPct: number;
    otherIncome: number;
  } | null;
  // reports.view
  wasooli: { partyId: string | null; name: string; phone: string | null; amount: number; days: number }[] | null;
  wasooliTotal: number | null;
  denaHai: { partyId: string; name: string; amount: number; oldestDocNo: string | null; oldestDocDays: number | null }[] | null;
  denaHaiTotal: number | null;
  alerts: {
    lossChallanCount: number;
    settlementPendingCount: number;
    unearnedRevenueBalance: number;
    noPhoneBiltyCount: number;
  };
  // Lazy-loaded separately (GET /api/reports/daily-summary/fifo-mismatch)
  // - see this module's own PERFORMANCE doc comment - never computed as
  // part of the main summary, which every FIFO-reconciliation sweep
  // (one per Party account) made too slow to be on the hot path.
  // reports.view (all 4 - each list shows Rs amounts, not just counts)
  topCustomers: { partyId: string; name: string; count: number; amount: number }[] | null;
  topClearingAgents: { partyId: string; name: string; count: number; amount: number }[] | null;
  topShowroomTransporters: { partyId: string; name: string; count: number; amount: number }[] | null;
  topChallanTransporters: { partyId: string; name: string; count: number; amount: number }[] | null;
  routes: ReturnType<typeof computeRouteMargins>;
  emptyReturnCities: ReturnType<typeof detectEmptyReturnCities>;
  ownCarriers: {
    carrierId: string;
    carrierNumber: string;
    activeTrip: { tripId: string; tripNo: string; route: string | null; daysRunning: number; expenseSoFar: number } | null;
    recentTrips: { tripId: string; tripNo: string; profit: number }[];
  }[];
  marketing: {
    followUpsDueToday: number;
    messagesSentThisPeriod: number;
    leadsThisPeriod: number;
    campaignBookingsCount: number;
    campaignBookingsAmount: number;
  };
  // reports.view
  charts: {
    incomeExpense6mo: { month: string; income: number; expense: number }[];
    expenseBreakdown: { account: string; amount: number }[];
    receivableAgeing: { bucket: string; amount: number }[];
  } | null;
  // Gated keys are simply absent (never sent to the client at all) -
  // see lib/reports/daily-summary-permissions.ts.
  drilldowns: Partial<Record<DrilldownKey, DrilldownDataset>>;
  // reports.view (the WhatsApp summary itself is financial)
  ownerWhatsapp: string | null;
}

export interface GetDailySummaryParams {
  date?: string | null; // YYYY-MM-DD, defaults to server-local today - "Aaj ka khulasa" is ALWAYS this date, never period-filtered
  period?: string | null; // DatePreset for everything else (Profit, Top Parties, Routes, charts) - defaults to THIS_MONTH
  // Required - the caller (app/api/reports/daily-summary/route.ts)
  // must compute this from the REAL requesting user's own
  // hasPermission() checks. Every section/field this permission set
  // doesn't allow is nulled out (never computed-then-hidden client-
  // side) before this function returns - see
  // lib/reports/daily-summary-permissions.ts's own doc comment.
  permissions: DailySummaryPermissions;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function endOfDayExclusive(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}
function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function drillRows<T>(items: T[], map: (t: T, i: number) => { name: string; link: string | null; count: number; amount: number }): DrilldownRow[] {
  return items.map((t, i) => ({ rank: i + 1, ...map(t, i) }));
}

// A "previous period" value that's zero, or negligible relative to the
// current value (< 1% of it), produces a meaningless/explosive percent
// change (e.g. previous=Rs 5, current=Rs 400,000 -> "+7,999,900%") -
// not a real trend, just division by almost-nothing. Shown as "—"
// instead of a number (see Delta's own rendering in app/dashboard/
// page.tsx) rather than the raw lib/date-range.ts safePercentChange()
// value, which only guards the exact previous===0 case and is left
// unchanged for every OTHER report that already relies on it.
function significantPercentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  if (Math.abs(previous) < Math.abs(current) * 0.01) return null;
  return rawPercentChange(current, previous);
}

type DateFilter = { gte: Date | undefined; lt: Date | undefined };

async function sumIncomeExpense(where: DateFilter): Promise<{ income: number; expense: number; bookingIncome: number; carrierRent: number }> {
  const [incomeLines, expenseLines] = await Promise.all([
    prisma.journalLine.findMany({
      where: { account: { accountType: "INCOME", isActive: true }, journalEntry: { entryDate: where, isDeleted: false } },
      select: { accountId: true, debit: true, credit: true, account: { select: { category: true } } },
    }),
    prisma.journalLine.findMany({
      where: { account: { accountType: "EXPENSE", isActive: true }, journalEntry: { entryDate: where, isDeleted: false } },
      select: { accountId: true, debit: true, credit: true, account: { select: { category: true } } },
    }),
  ]);

  const incomeBalances = accumulateBalances(incomeLines);
  const expenseBalances = accumulateBalances(expenseLines);

  let income = 0;
  let bookingIncome = 0;
  for (const [, bal] of incomeBalances) income += netIncome(bal);

  const bookingBalances = new Map<string, { debit: number; credit: number }>();
  for (const line of incomeLines) {
    if (line.account.category !== "BOOKING_INCOME") continue;
    const cur = bookingBalances.get(line.accountId) ?? { debit: 0, credit: 0 };
    cur.debit += Number(line.debit);
    cur.credit += Number(line.credit);
    bookingBalances.set(line.accountId, cur);
  }
  for (const [, bal] of bookingBalances) bookingIncome += netIncome(bal);

  let expense = 0;
  for (const [, bal] of expenseBalances) expense += netExpense(bal);
  const rentBalances = new Map<string, { debit: number; credit: number }>();
  for (const line of expenseLines) {
    if (line.account.category !== "CARRIER_RENT") continue;
    const cur = rentBalances.get(line.accountId) ?? { debit: 0, credit: 0 };
    cur.debit += Number(line.debit);
    cur.credit += Number(line.credit);
    rentBalances.set(line.accountId, cur);
  }
  let carrierRent = 0;
  for (const [, bal] of rentBalances) carrierRent += netExpense(bal);

  return { income, expense, bookingIncome, carrierRent };
}

async function computeProfitSection(periodWhere: DateFilter, comparisonWhere: DateFilter) {
  const [current, previous] = await Promise.all([sumIncomeExpense(periodWhere), sumIncomeExpense(comparisonWhere)]);

  const profit = current.income - current.expense;
  const previousProfit = previous.income - previous.expense;
  const grossMargin = current.bookingIncome - current.carrierRent;

  return {
    totalIncome: current.income,
    totalExpense: current.expense,
    profit,
    incomeDeltaPct: significantPercentChange(current.income, previous.income),
    expenseDeltaPct: significantPercentChange(current.expense, previous.expense),
    profitDeltaPct: significantPercentChange(profit, previousProfit),
    bookingIncome: current.bookingIncome,
    carrierRent: current.carrierRent,
    grossMargin,
    grossMarginPct: current.bookingIncome > 0 ? Math.round((grossMargin / current.bookingIncome) * 1000) / 10 : 0,
    otherIncome: current.income - current.bookingIncome,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Real per-document ageing, NOT "days since last ledger activity"
// (that was the bug: a party whose balance is old but who happened to
// make SOME unrelated recent transaction looked "Current"). Reuses
// the SAME FIFO document-resolution engine the Allocation UI/Party
// Ledger already use (lib/payment-allocation.ts's getPartyDocumentStates)
// - never a separate ageing-specific accounting rule. One party's own
// open documents' remaining amounts are SCALED to sum to exactly that
// party's own ledger balance (never the other way around) - so this
// is always consistent with the Receivable/Payable report's own
// totals even on the rare party where FIFO-document remaining drifts
// slightly from the ledger balance (the same drift the FIFO-mismatch
// alert itself flags); a party with no resolvable open document at
// all (e.g. a pure Opening Balance never tied to a document) falls
// back to its own last-activity date so its balance is never dropped
// from the bucket totals.
interface PartyOpenDocs {
  oldestDocNo: string | null;
  oldestDocDate: Date | null;
  documents: { date: Date; remaining: number }[];
}

async function computePartyOpenDocuments(accountIds: string[], direction: "RECEIVABLE" | "PAYABLE"): Promise<Map<string, PartyOpenDocs>> {
  const result = new Map<string, PartyOpenDocs>();
  await Promise.all(
    accountIds.map(async (accountId) => {
      const docs = await getPartyDocumentStates(prisma, accountId, direction, { onlyWithRemainingBalance: true });
      if (docs.length === 0) {
        result.set(accountId, { oldestDocNo: null, oldestDocDate: null, documents: [] });
        return;
      }
      const sorted = [...docs].sort((a, b) => a.documentDate.getTime() - b.documentDate.getTime());
      result.set(accountId, {
        oldestDocNo: sorted[0].documentNo,
        oldestDocDate: sorted[0].documentDate,
        documents: sorted.map((d) => ({ date: d.documentDate, remaining: d.remainingAllocatable })),
      });
    })
  );
  return result;
}

function bucketAgeingByDocument(rows: PartyBalanceRow[], docsByAccount: Map<string, PartyOpenDocs>, today: Date): { bucket: string; amount: number }[] {
  const totals = new Map<string, number>();
  for (const label of AGEING_BUCKET_LABELS) totals.set(label, 0);

  for (const row of rows) {
    const docState = docsByAccount.get(row.accountId);
    if (!docState || docState.documents.length === 0) {
      const days = row.lastActivityDate ? daysBetween(row.lastActivityDate, today) : Infinity;
      const bucket = ageingBucketForDays(days);
      totals.set(bucket, (totals.get(bucket) ?? 0) + row.balance);
      continue;
    }
    const documentSum = docState.documents.reduce((s, d) => s + d.remaining, 0);
    const scale = documentSum > 0 ? row.balance / documentSum : 0;
    for (const doc of docState.documents) {
      const days = daysBetween(doc.date, today);
      const bucket = ageingBucketForDays(days);
      totals.set(bucket, (totals.get(bucket) ?? 0) + doc.remaining * scale);
    }
  }

  return AGEING_BUCKET_LABELS.map((label) => ({ bucket: label, amount: round2(totals.get(label) ?? 0) }));
}

async function computeAlerts(periodWhere: DateFilter) {
  const [periodChallans, allUnsettledChallans, unearnedAccountId, noPhoneCount] = await Promise.all([
    prisma.challan.findMany({
      where: { isDeleted: false, loadingDate: periodWhere },
      select: { id: true, challanNo: true, carrierRent: true, transporterParty: { select: { partyName: true } }, bilties: { select: { bilty: { select: { total: true } } } } },
    }),
    // "Settlement baaqi" = the Challan list's own "Before Settlement"
    // filter (lib/challan-list-query.ts's matchesFinancialFilter:
    // `!item.isSettled`, nothing else) - ALL-time, never period-scoped,
    // and no status/own-carrier narrowing beyond that exact definition,
    // so this always matches what that list itself shows.
    prisma.challan.findMany({
      where: { isDeleted: false, isSettled: false },
      select: { id: true, challanNo: true, carrierRent: true, ownCarrierId: true, transporterParty: { select: { partyName: true } }, bilties: { select: { bilty: { select: { total: true } } } } },
    }),
    getUnearnedRevenueAccountId(prisma),
    prisma.bilty.count({ where: { isDeleted: false, noPhoneProvided: true, date: periodWhere } }),
  ]);

  const lossChallanRows = periodChallans
    .map((c) => {
      const booking = c.bilties.reduce((s, cb) => s + Number(cb.bilty.total), 0);
      const carrierRent = Number(c.carrierRent);
      return { id: c.id, label: `${c.challanNo} - ${c.transporterParty?.partyName ?? "Own Carrier"}`, biltyCount: c.bilties.length, loss: carrierRent - booking };
    })
    .filter((c) => c.loss > 0)
    .sort((a, b) => b.loss - a.loss);

  const settlementPendingRows = allUnsettledChallans.map((c) => ({
    id: c.id,
    label: `${c.challanNo} - ${c.transporterParty?.partyName ?? (c.ownCarrierId ? "Own Carrier" : "-")}`,
    biltyCount: c.bilties.length,
    carrierRent: Number(c.carrierRent),
  }));

  return {
    alerts: {
      lossChallanCount: lossChallanRows.length,
      settlementPendingCount: settlementPendingRows.length,
      unearnedRevenueBalance: await getAccountCurrentBalance(unearnedAccountId, "LIABILITY"),
      noPhoneBiltyCount: noPhoneCount,
    },
    lossChallanRows,
    settlementPendingRows,
  };
}

async function getAccountCurrentBalance(accountId: string, kind: "LIABILITY" | "ASSET"): Promise<number> {
  const agg = await prisma.journalLine.aggregate({
    where: { accountId, journalEntry: { isDeleted: false } },
    _sum: { debit: true, credit: true },
  });
  const debit = Number(agg._sum.debit || 0);
  const credit = Number(agg._sum.credit || 0);
  return kind === "LIABILITY" ? credit - debit : debit - credit;
}

async function computeTopParties(periodWhere: DateFilter) {
  const [biltyGroups, parties, privatePhonchVehicles, phonches, transporterRows] = await Promise.all([
    prisma.bilty.groupBy({
      by: ["consignorPartyId"],
      where: { isDeleted: false, date: periodWhere, consignorPartyId: { not: null } },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.party.findMany({ select: { id: true, partyName: true } }),
    prisma.privatePhonchVehicle.findMany({
      where: { clearingAgentPartyId: { not: null }, phonch: { isDeleted: false, date: periodWhere } },
      select: { clearingAgentPartyId: true, totalRent: true },
    }),
    prisma.phonch.findMany({
      where: { isDeleted: false, date: periodWhere },
      select: { transporterPartyId: true, transporterParty: { select: { partyName: true } }, vehicles: { select: { deliveryCharges: true } } },
    }),
    getTopTransportersByCarrierRent(periodWhere.gte ?? null, periodWhere.lt ?? null, 50),
  ]);

  const partyNameById = new Map(parties.map((p) => [p.id, p.partyName]));

  const customers = biltyGroups
    .filter((g) => g.consignorPartyId)
    .map((g) => ({ partyId: g.consignorPartyId!, name: partyNameById.get(g.consignorPartyId!) || "Unknown Party", count: g._count._all, amount: Number(g._sum.total || 0) }))
    .sort((a, b) => b.count - a.count);

  const clearingAgentMap = new Map<string, { count: number; amount: number }>();
  for (const v of privatePhonchVehicles) {
    if (!v.clearingAgentPartyId) continue;
    const cur = clearingAgentMap.get(v.clearingAgentPartyId) ?? { count: 0, amount: 0 };
    cur.count += 1;
    cur.amount += Number(v.totalRent);
    clearingAgentMap.set(v.clearingAgentPartyId, cur);
  }
  const clearingAgents = [...clearingAgentMap.entries()]
    .map(([partyId, v]) => ({ partyId, name: partyNameById.get(partyId) || "Unknown Party", ...v }))
    .sort((a, b) => b.count - a.count);

  const showroomMap = new Map<string, { count: number; amount: number; name: string }>();
  for (const p of phonches) {
    if (!p.transporterPartyId) continue;
    const cur = showroomMap.get(p.transporterPartyId) ?? { count: 0, amount: 0, name: p.transporterParty?.partyName || "Unknown Party" };
    cur.count += p.vehicles.length;
    cur.amount += p.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0);
    showroomMap.set(p.transporterPartyId, cur);
  }
  const showroomTransporters = [...showroomMap.entries()].map(([partyId, v]) => ({ partyId, ...v })).sort((a, b) => b.count - a.count);

  const challanTransporters = [...transporterRows.rows]
    .sort((a, b) => b.challanCount - a.challanCount)
    .map((r) => ({ partyId: r.partyId, name: r.name, count: r.challanCount, amount: r.carrierRent }));

  return { customers, clearingAgents, showroomTransporters, challanTransporters };
}

async function computeRoutesAndOwnCarrier(periodWhere: DateFilter) {
  const [bilties, challans] = await Promise.all([
    prisma.bilty.findMany({
      where: { isDeleted: false, date: periodWhere },
      select: { id: true, total: true, fromLocation: { select: { name: true } }, toLocation: { select: { name: true } }, challanBilties: { select: { challanId: true }, take: 1 } },
    }),
    prisma.challan.findMany({ where: { isDeleted: false, loadingDate: periodWhere }, select: { id: true, carrierRent: true, ownCarrierId: true } }),
  ]);

  const biltyInputs: RouteBiltyInput[] = bilties.map((b) => ({
    biltyId: b.id,
    challanId: b.challanBilties[0]?.challanId ?? null,
    fromLocation: b.fromLocation.name,
    toLocation: b.toLocation.name,
    total: Number(b.total),
  }));

  // Own Carrier dispatch: Challan.carrierRent is ALWAYS kept at 0 for
  // these (see Challan's own schema comment) - the real rent lives on
  // CarrierTripDocument.carrierRentAmount instead. Without this, an
  // own-carrier route's margin silently equals its full booking
  // amount (the exact "looks like booking, not margin" bug).
  const ownCarrierChallanIds = challans.filter((c) => c.ownCarrierId).map((c) => c.id);
  const tripRentByChallanId = new Map<string, number>();
  if (ownCarrierChallanIds.length > 0) {
    const tripDocs = await prisma.carrierTripDocument.findMany({
      where: { documentType: "CHALLAN", documentId: { in: ownCarrierChallanIds }, unlinkedAt: null },
      select: { documentId: true, carrierRentAmount: true },
    });
    for (const doc of tripDocs) tripRentByChallanId.set(doc.documentId, Number(doc.carrierRentAmount));
  }

  const challanInputs: RouteChallanInput[] = challans.map((c) => ({
    challanId: c.id,
    carrierRent: c.ownCarrierId ? tripRentByChallanId.get(c.id) ?? 0 : Number(c.carrierRent),
  }));

  return {
    routes: computeRouteMargins(biltyInputs, challanInputs),
    emptyReturnCities: detectEmptyReturnCities(biltyInputs),
  };
}

async function computeOwnCarriers() {
  const carriers = await prisma.ownCarrier.findMany({ where: { isActive: true }, select: { id: true, carrierNumber: true } });
  if (carriers.length === 0) return [];

  return Promise.all(
    carriers.map(async (carrier) => {
      const openTrip = await getLatestOpenTrip(prisma, carrier.id);
      let activeTrip: { tripId: string; tripNo: string; route: string | null; daysRunning: number; expenseSoFar: number } | null = null;
      if (openTrip) {
        const report = await getTripProfitReport(prisma, openTrip.id);
        activeTrip = {
          tripId: openTrip.id,
          tripNo: openTrip.tripNo,
          route: openTrip.route,
          daysRunning: daysBetween(openTrip.dateFrom, new Date()),
          expenseSoFar: report.totalCarrierExpense,
        };
      }

      const closedTrips = await prisma.carrierTrip.findMany({
        where: { carrierId: carrier.id, isDeleted: false, status: "CLOSED" },
        orderBy: [{ dateFrom: "desc" }],
        take: 3,
        select: { id: true, tripNo: true },
      });
      const recentTrips = await Promise.all(
        closedTrips.map(async (t) => {
          const report = await getTripProfitReport(prisma, t.id);
          return { tripId: t.id, tripNo: t.tripNo, profit: report.ownCarrierProfit };
        })
      );

      return { carrierId: carrier.id, carrierNumber: carrier.carrierNumber, activeTrip, recentTrips };
    })
  );
}

async function computeMarketing(today: Date, periodWhere: DateFilter) {
  const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

  const [followUpsDueToday, messagesSentThisPeriod, leadsThisPeriod, campaignBookings] = await Promise.all([
    prisma.marketingLead.count({ where: { stage: { notIn: ["BOOKED", "LOST"] }, followUpDate: { lte: endOfToday, not: null } } }),
    prisma.marketingCampaignRecipient.count({ where: { status: { not: "QUEUED" }, statusUpdatedAt: periodWhere } }),
    prisma.marketingLead.count({ where: { createdAt: periodWhere } }),
    prisma.marketingLead.findMany({
      where: { stage: "BOOKED", source: "CAMPAIGN", convertedAt: periodWhere, convertedBiltyId: { not: null } },
      select: { convertedBiltyId: true },
    }),
  ]);

  const biltyIds = campaignBookings.map((b) => b.convertedBiltyId!).filter(Boolean);
  const bilties = biltyIds.length > 0 ? await prisma.bilty.findMany({ where: { id: { in: biltyIds } }, select: { total: true } }) : [];
  const campaignBookingsAmount = bilties.reduce((s, b) => s + Number(b.total), 0);

  return { followUpsDueToday, messagesSentThisPeriod, leadsThisPeriod, campaignBookingsCount: campaignBookings.length, campaignBookingsAmount };
}

async function computeCharts(periodWhere: DateFilter) {
  const now = new Date();
  const months: { label: string; from: Date; to: Date }[] = [];
  for (let i = 5; i >= 0; i--) {
    const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    months.push({ label: from.toLocaleDateString("en-US", { month: "short" }), from, to });
  }
  const incomeExpense6moRaw = await Promise.all(
    months.map(async (m) => {
      const totals = await sumIncomeExpense({ gte: m.from, lt: m.to });
      return { month: m.label, income: totals.income, expense: totals.expense };
    })
  );
  // Only months with actual ERP data - a month before this business
  // started posting entries is empty, not legitimately "Rs 0 income
  // and Rs 0 expense", so it's dropped rather than drawn as a flat
  // zero bar.
  const incomeExpense6mo = incomeExpense6moRaw.filter((m) => m.income !== 0 || m.expense !== 0);

  const expenseLines = await prisma.journalLine.findMany({
    where: { account: { accountType: "EXPENSE", isActive: true }, journalEntry: { entryDate: periodWhere, isDeleted: false } },
    select: { accountId: true, debit: true, credit: true, account: { select: { accountName: true } } },
  });
  const incomeLines = await prisma.journalLine.findMany({
    where: { account: { accountType: "INCOME", isActive: true }, journalEntry: { entryDate: periodWhere, isDeleted: false } },
    select: { accountId: true, debit: true, credit: true, account: { select: { accountName: true } } },
  });

  function breakdown(lines: typeof expenseLines, net: (bal: { debit: number; credit: number }) => number) {
    const byAccount = new Map<string, { account: string; entries: number; debit: number; credit: number }>();
    for (const l of lines) {
      const cur = byAccount.get(l.accountId) ?? { account: l.account.accountName, entries: 0, debit: 0, credit: 0 };
      cur.entries += 1;
      cur.debit += Number(l.debit);
      cur.credit += Number(l.credit);
      byAccount.set(l.accountId, cur);
    }
    return [...byAccount.values()]
      .map((v) => ({ account: v.account, entries: v.entries, amount: net(v) }))
      .filter((v) => v.amount !== 0)
      .sort((a, b) => b.amount - a.amount);
  }

  return {
    incomeExpense6mo,
    expenseBreakdownFull: breakdown(expenseLines, netExpense),
    incomeBreakdownFull: breakdown(incomeLines, netIncome),
  };
}

async function computeTodaySection(todayStart: Date, todayEnd: Date) {
  const dateRange = { gte: todayStart, lt: todayEnd };

  const [bilties, challans, bills, phonches, privatePhonches, cashBankAccounts] = await Promise.all([
    prisma.bilty.findMany({
      where: { isDeleted: false, date: dateRange },
      select: { id: true, biltyNo: true, total: true, consignorName: true, fromLocation: { select: { name: true } }, toLocation: { select: { name: true } } },
    }),
    prisma.challan.findMany({
      where: { isDeleted: false, loadingDate: dateRange },
      select: { id: true, challanNo: true, status: true, carrierRent: true, transporterParty: { select: { partyName: true } }, bilties: { select: { biltyId: true } } },
    }),
    prisma.bill.findMany({
      where: { isDeleted: false, date: dateRange },
      select: { id: true, billNo: true, clientName: true, items: { select: { rent: true, delivery: true, otherExpense: true } } },
    }),
    prisma.phonch.findMany({
      where: { isDeleted: false, date: dateRange },
      select: { id: true, phonchNo: true, transporterParty: { select: { partyName: true } }, vehicles: { select: { deliveryCharges: true } } },
    }),
    prisma.privatePhonch.findMany({
      where: { isDeleted: false, date: dateRange },
      select: { id: true, phonchNo: true, transporterParty: { select: { partyName: true } }, vehicles: { select: { totalRent: true } } },
    }),
    prisma.account.findMany({
      where: { isActive: true, OR: [{ category: "CASH" }, { category: "BANK" }] },
      select: { id: true, accountName: true },
    }),
  ]);

  const biltyBookingAmount = bilties.reduce((s, b) => s + Number(b.total), 0);
  const billRowsRaw = bills.map((b) => ({ id: b.id, label: `${b.billNo} - ${b.clientName}`, amount: b.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0) }));
  const billAmount = billRowsRaw.reduce((s, b) => s + b.amount, 0);

  const showroomPhonchRows = phonches.map((p) => ({
    id: p.id,
    label: `${p.phonchNo} - ${p.transporterParty?.partyName ?? "-"}`,
    vehicleCount: p.vehicles.length,
    amount: p.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0),
  }));
  const showroomPhonchVehicleCount = showroomPhonchRows.reduce((s, p) => s + p.vehicleCount, 0);
  const showroomPhonchDeliveryCharges = showroomPhonchRows.reduce((s, p) => s + p.amount, 0);

  const privatePhonchRows = privatePhonches.map((p) => ({
    id: p.id,
    label: `${p.phonchNo} - ${p.transporterParty?.partyName ?? "-"}`,
    vehicleCount: p.vehicles.length,
    amount: p.vehicles.reduce((s, v) => s + Number(v.totalRent), 0),
  }));
  const privatePhonchVehicleCount = privatePhonchRows.reduce((s, p) => s + p.vehicleCount, 0);
  const privatePhonchRent = privatePhonchRows.reduce((s, p) => s + p.amount, 0);

  const challanRows = challans.map((c) => ({ id: c.id, label: `${c.challanNo} - ${c.transporterParty?.partyName ?? "Own Carrier"}`, vehicleCount: c.bilties.length, amount: Number(c.carrierRent) }));
  const challanDispatchedCount = challans.filter((c) => c.status === "IN_TRANSIT" || c.status === "DELIVERED").length;

  // Cash In/Out today - the Main (Cash/Bank) account's OWN side of
  // every JournalLine posted today, exactly Cash Book's own Debit=In/
  // Credit=Out convention (app/api/cash-book/route.ts) - never derived
  // from a counter line.
  const cashBankIds = cashBankAccounts.map((a) => a.id);
  const todayCashLines = cashBankIds.length
    ? await prisma.journalLine.findMany({
        where: { accountId: { in: cashBankIds }, journalEntry: { entryDate: dateRange, isDeleted: false } },
        select: { accountId: true, debit: true, credit: true, description: true, sourceType: true },
      })
    : [];
  const cashIn = todayCashLines.reduce((s, l) => s + Number(l.debit), 0);
  const cashOut = todayCashLines.reduce((s, l) => s + Number(l.credit), 0);

  function groupCashRows(lines: typeof todayCashLines, side: "debit" | "credit") {
    const byLabel = new Map<string, { entries: number; amount: number }>();
    for (const l of lines) {
      const amount = Number(l[side]);
      if (amount <= 0) continue;
      const label = l.description || l.sourceType || "Direct";
      const cur = byLabel.get(label) ?? { entries: 0, amount: 0 };
      cur.entries += 1;
      cur.amount += amount;
      byLabel.set(label, cur);
    }
    return [...byLabel.entries()].map(([label, v]) => ({ label, entries: v.entries, amount: v.amount })).sort((a, b) => b.amount - a.amount);
  }

  // Current balance per Cash/Bank account - all-time sum of debit -
  // credit on that account's own JournalLines, no date filter (this is
  // "right now", not a period total).
  const allTimeCashLines = cashBankIds.length
    ? await prisma.journalLine.groupBy({
        by: ["accountId"],
        where: { accountId: { in: cashBankIds }, journalEntry: { isDeleted: false } },
        _sum: { debit: true, credit: true },
      })
    : [];
  const balanceByAccountId = new Map(allTimeCashLines.map((l) => [l.accountId, Number(l._sum.debit || 0) - Number(l._sum.credit || 0)]));
  const cashByAccount = cashBankAccounts.map((a) => ({ accountId: a.id, accountName: a.accountName, balance: balanceByAccountId.get(a.id) ?? 0 }));
  const totalCash = cashByAccount.reduce((s, a) => s + a.balance, 0);

  return {
    summary: {
      biltyCount: bilties.length,
      biltyBookingAmount,
      challanCount: challans.length,
      challanDispatchedCount,
      billCount: bills.length,
      billAmount,
      showroomPhonchVehicleCount,
      showroomPhonchDeliveryCharges,
      privatePhonchVehicleCount,
      privatePhonchRent,
      cashIn,
      cashOut,
      netCash: cashIn - cashOut,
      cashByAccount,
      totalCash,
    },
    biltyRows: bilties.map((b) => ({ id: b.id, label: `${b.biltyNo} - ${b.fromLocation.name} -> ${b.toLocation.name}`, amount: Number(b.total) })),
    challanRows,
    billRows: billRowsRaw,
    showroomPhonchRows,
    privatePhonchRows,
    cashInRows: groupCashRows(todayCashLines, "debit"),
    cashOutRows: groupCashRows(todayCashLines, "credit"),
  };
}

// The most recent date ANY non-deleted JournalEntry was posted for -
// "Aaj ka khulasa"'s own default (per the user's own correction: the
// day's data is usually posted the NEXT day, so "today" is often
// empty and misleading as a default) and the "Aakhri posted din"
// quick button's target.
async function getLatestPostedDate(): Promise<Date | null> {
  const latest = await prisma.journalEntry.findFirst({
    where: { isDeleted: false },
    orderBy: { entryDate: "desc" },
    select: { entryDate: true },
  });
  return latest?.entryDate ?? null;
}

export async function getDailySummary(params: GetDailySummaryParams): Promise<DailySummaryResponse> {
  const now = new Date();
  const latestPostedDate = await getLatestPostedDate();
  const today = params.date ? new Date(`${params.date}T00:00:00`) : startOfDay(latestPostedDate ?? now);
  const todayStart = startOfDay(today);
  const todayEnd = endOfDayExclusive(today);

  const periodPreset = (params.period || "THIS_MONTH") as DatePreset;
  const range = resolveDateRange({ preset: periodPreset }, now);
  const periodWhere = { gte: range.from ?? undefined, lt: range.to ?? undefined };
  const comparisonWhere = { gte: range.comparisonFrom ?? undefined, lt: range.comparisonTo ?? undefined };

  const [
    todaySection,
    profitSection,
    receivablePayable,
    alertsResult,
    topPartiesRaw,
    routesRaw,
    ownCarriersRaw,
    marketingRaw,
    chartsRaw,
    businessSettings,
  ] = await Promise.all([
    computeTodaySection(todayStart, todayEnd),
    computeProfitSection(periodWhere, comparisonWhere),
    getReceivablePayable(),
    computeAlerts(periodWhere),
    computeTopParties(periodWhere),
    computeRoutesAndOwnCarrier(periodWhere),
    computeOwnCarriers(),
    computeMarketing(today, periodWhere),
    computeCharts(periodWhere),
    getBusinessSettings(prisma),
  ]);

  // ALL receivable/payable parties (never a >30-day filter - that was
  // the bug: it dropped every party into the header TOTAL too, so the
  // card header stopped matching the Receivable/Payable report's own
  // total). The header/total below always uses receivablePayable's own
  // totalReceivable/totalPayable directly - the exact same figure the
  // Receivable/Payable reports show, by construction (same shared
  // lib/receivable-payable.ts call) - never re-summed from a filtered
  // or sliced row subset.
  const [receivableDocsByAccount, payableDocsByAccount] = await Promise.all([
    computePartyOpenDocuments(receivablePayable.receivable.map((r) => r.accountId), "RECEIVABLE"),
    computePartyOpenDocuments(receivablePayable.payable.map((p) => p.accountId), "PAYABLE"),
  ]);

  const wasooliRows = receivablePayable.receivable
    .map((r) => {
      const docState = receivableDocsByAccount.get(r.accountId);
      const oldestDate = docState?.oldestDocDate ?? r.lastActivityDate;
      return { partyId: r.partyId, name: r.partyName, phone: r.phone, amount: r.balance, days: oldestDate ? daysBetween(oldestDate, today) : Infinity };
    })
    .sort((a, b) => b.amount - a.amount);

  const denaHaiRows = receivablePayable.payable
    .map((p) => {
      const docState = payableDocsByAccount.get(p.accountId);
      const oldestDate = docState?.oldestDocDate ?? p.lastActivityDate;
      return {
        partyId: p.partyId!,
        name: p.partyName,
        amount: p.balance,
        oldestDocNo: docState?.oldestDocNo ?? null,
        oldestDocDays: oldestDate ? daysBetween(oldestDate, today) : null,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const ageingBuckets = bucketAgeingByDocument(receivablePayable.receivable, receivableDocsByAccount, today);

  const drilldowns: Record<DrilldownKey, DrilldownDataset> = {
    cust: {
      title: "Top Customers",
      subtitle: "Sab se zyada bilties banwayin - top se lowest",
      columns: ["Customer", "Bilties", "Booking Rs"],
      rows: drillRows(topPartiesRaw.customers, (c) => ({ name: c.name, link: `/parties/${c.partyId}/ledger`, count: c.count, amount: c.amount })),
    },
    ca: {
      title: "Top Clearing Agents",
      subtitle: "Private Phonch par gaariyan - top se lowest",
      columns: ["Clearing Agent", "Gaariyan", "Kiraya Rs"],
      rows: drillRows(topPartiesRaw.clearingAgents, (c) => ({ name: c.name, link: `/parties/${c.partyId}/ledger`, count: c.count, amount: c.amount })),
    },
    sr: {
      title: "Top Transporters - Showroom Phonch",
      subtitle: "Showroom Phonch par gaariyan - top se lowest",
      columns: ["Transporter", "Gaariyan", "Charges Rs"],
      rows: drillRows(topPartiesRaw.showroomTransporters, (c) => ({ name: c.name, link: `/parties/${c.partyId}/ledger`, count: c.count, amount: c.amount })),
    },
    ch: {
      title: "Top Transporters - Challan",
      subtitle: "Hamari gaariyan load kin - top se lowest",
      columns: ["Transporter", "Challan", "Carrier Rent Rs"],
      rows: drillRows(topPartiesRaw.challanTransporters, (c) => ({ name: c.name, link: `/parties/${c.partyId}/ledger`, count: c.count, amount: c.amount })),
    },
    rec: {
      title: "Receivable - Wasooli",
      subtitle: "Sab parties - zyada raqam upar",
      columns: ["Party", "Baaqi Rs", "Din"],
      rows: drillRows(wasooliRows, (r) => ({ name: r.name, link: r.partyId ? `/parties/${r.partyId}/ledger` : null, count: Math.round(r.amount), amount: r.days === Infinity ? 0 : r.days })),
    },
    pay: {
      title: "Payable - Dena hai",
      subtitle: "Sab carriers / transporters - zyada raqam upar",
      columns: ["Party", "Dena Rs", "Din"],
      rows: drillRows(denaHaiRows, (r) => ({ name: r.name, link: `/parties/${r.partyId}/ledger`, count: Math.round(r.amount), amount: r.oldestDocDays ?? 0 })),
    },
    routes: {
      title: "Routes",
      subtitle: "Gross margin - top se lowest",
      columns: ["Route", "Bilties", "Margin Rs"],
      rows: drillRows(routesRaw.routes, (r) => ({ name: r.route, link: null, count: r.biltyCount, amount: r.margin })),
    },
    exp: {
      title: "Kharcha",
      subtitle: "Period - zyada se kam",
      columns: ["Account", "Entries", "Rs"],
      rows: drillRows(chartsRaw.expenseBreakdownFull, (e) => ({ name: e.account, link: null, count: e.entries, amount: e.amount })),
    },
    inc: {
      title: "Income",
      subtitle: "Period - har income account",
      columns: ["Account", "Entries", "Rs"],
      rows: drillRows(chartsRaw.incomeBreakdownFull, (e) => ({ name: e.account, link: null, count: e.entries, amount: e.amount })),
    },
    tb: {
      title: "Aaj ki bilties",
      subtitle: toISODate(today),
      columns: ["Bilty / Customer", "Gaariyan", "Booking Rs"],
      rows: drillRows(todaySection.biltyRows, (b) => ({ name: b.label, link: `/bilty/${b.id}`, count: 1, amount: b.amount })),
    },
    tc: {
      title: "Aaj ke challan",
      subtitle: toISODate(today),
      columns: ["Challan / Transporter", "Gaariyan", "Rent Rs"],
      rows: drillRows(todaySection.challanRows, (c) => ({ name: c.label, link: `/challan/${c.id}`, count: c.vehicleCount, amount: c.amount })),
    },
    tbill: {
      title: "Aaj ke bill",
      subtitle: toISODate(today),
      columns: ["Bill / Client", "Gaariyan", "Rs"],
      rows: drillRows(todaySection.billRows, (b) => ({ name: b.label, link: `/bill/${b.id}`, count: 1, amount: b.amount })),
    },
    tsr: {
      title: "Showroom Phonch - aaj",
      subtitle: toISODate(today),
      columns: ["Phonch / Transporter", "Gaariyan", "Rs"],
      rows: drillRows(todaySection.showroomPhonchRows, (p) => ({ name: p.label, link: `/phonch/${p.id}`, count: p.vehicleCount, amount: p.amount })),
    },
    tpp: {
      title: "Private Phonch - aaj",
      subtitle: toISODate(today),
      columns: ["Phonch / Clearing Agent", "Gaariyan", "Rs"],
      rows: drillRows(todaySection.privatePhonchRows, (p) => ({ name: p.label, link: `/private-phonch/${p.id}`, count: p.vehicleCount, amount: p.amount })),
    },
    tin: {
      title: "Paise aaye - aaj",
      subtitle: "Cash + Bank",
      columns: ["Kis se", "Entries", "Rs"],
      rows: drillRows(todaySection.cashInRows, (r) => ({ name: r.label, link: null, count: r.entries, amount: r.amount })),
    },
    tout: {
      title: "Paise gaye - aaj",
      subtitle: "Cash + Bank",
      columns: ["Kis ko", "Entries", "Rs"],
      rows: drillRows(todaySection.cashOutRows, (r) => ({ name: r.label, link: null, count: r.entries, amount: r.amount })),
    },
    loss: {
      title: "Nuqsan wale challan",
      subtitle: "Carrier rent booking se zyada",
      columns: ["Challan", "Gaariyan", "Nuqsan Rs"],
      rows: drillRows(alertsResult.lossChallanRows, (c) => ({ name: c.label, link: `/challan/${c.id}`, count: c.biltyCount, amount: c.loss })),
    },
    settle: {
      title: "Settlement baaqi",
      subtitle: "Delivered, settlement pending",
      columns: ["Challan", "Gaariyan", "Rent Rs"],
      rows: drillRows(alertsResult.settlementPendingRows, (c) => ({ name: c.label, link: `/challan/${c.id}`, count: c.biltyCount, amount: c.carrierRent })),
    },
  };

  const full: DailySummaryResponse = {
    meta: {
      todayISO: toISODate(today),
      latestPostedDateISO: latestPostedDate ? toISODate(latestPostedDate) : null,
      period: range.preset,
      periodLabel: range.label,
      periodFromISO: range.fromISO,
      periodToISO: range.toISO,
      comparisonLabel: range.comparisonRangeLabel,
      generatedAt: now.toISOString(),
    },
    today: todaySection.summary,
    profit: profitSection,
    wasooli: wasooliRows.slice(0, 10),
    wasooliTotal: receivablePayable.totalReceivable,
    denaHai: denaHaiRows.slice(0, 10),
    denaHaiTotal: receivablePayable.totalPayable,
    alerts: alertsResult.alerts,
    topCustomers: topPartiesRaw.customers.slice(0, 5),
    topClearingAgents: topPartiesRaw.clearingAgents.slice(0, 5),
    topShowroomTransporters: topPartiesRaw.showroomTransporters.slice(0, 5),
    topChallanTransporters: topPartiesRaw.challanTransporters.slice(0, 5),
    routes: routesRaw.routes.slice(0, 5),
    emptyReturnCities: routesRaw.emptyReturnCities,
    ownCarriers: ownCarriersRaw,
    marketing: marketingRaw,
    charts: {
      incomeExpense6mo: chartsRaw.incomeExpense6mo,
      expenseBreakdown: chartsRaw.expenseBreakdownFull.slice(0, 5).map((e) => ({ account: e.account, amount: e.amount })),
      receivableAgeing: ageingBuckets.map((b) => ({ bucket: b.bucket, amount: b.amount })),
    },
    drilldowns,
    ownerWhatsapp: businessSettings.ownerWhatsapp ?? null,
  };

  return applyDailySummaryPermissions(full, params.permissions);
}

// PERFORMANCE: lazy, NOT part of getDailySummary() above - a full FIFO
// reconciliation sweep (lib/party-payment-fifo.ts's own
// computePartyFifoPreview + checkPartyReconciliation, the exact same
// pipeline scripts/backfill-fifo-allocation.ts's dry-run uses) took
// ~5s alone on real data, which alone blew the Dashboard's <2s load
// target. Scoped to accounts with a NONZERO current Receivable/Payable
// balance only (a party owing/owed nothing has nothing worth alerting
// on even if its own historical ledger has an unreconciled line) -
// called by its own GET /api/reports/daily-summary/fifo-mismatch route,
// fetched by the Alerts card AFTER the main dashboard has already
// rendered, never blocking it.
export async function getFifoMismatchCount(): Promise<number> {
  const receivablePayable = await getReceivablePayable();
  const accountIds = new Set<string>();
  for (const r of receivablePayable.receivable) accountIds.add(r.accountId);
  for (const p of receivablePayable.payable) accountIds.add(p.accountId);

  let fifoMismatchCount = 0;
  await Promise.all(
    [...accountIds].map(async (accountId) => {
      const directionReports: { direction: "RECEIVABLE" | "PAYABLE"; preview: PartyFifoPreview }[] = [];
      for (const direction of ["RECEIVABLE", "PAYABLE"] as const) {
        const preview = await computePartyFifoPreview(prisma, accountId, direction);
        if (preview) directionReports.push({ direction, preview });
      }
      if (directionReports.length === 0) return;
      const reconciliation = await checkPartyReconciliation(prisma, accountId, directionReports);
      if (!reconciliation.isMatch) fifoMismatchCount++;
    })
  );
  return fifoMismatchCount;
}
