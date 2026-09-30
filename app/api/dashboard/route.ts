import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { accumulateBalances, netExpense, netIncome } from "@/lib/pnl";
import { DateRangeValidationError, resolveDateRange, safePercentChange, toISODate } from "@/lib/date-range";
import { bucketAgeing, getReceivablePayable } from "@/lib/receivable-payable";
import {
  getBillSummary,
  getBiltySummary,
  getChallanSummary,
  getPhonchComparison,
  getTopClientsByActivity,
  getTopClientsByRevenue,
  getTopTransportersByCarrierRent,
} from "@/lib/dashboard-analytics";

// ============================================================
// Dashboard API - now date-range aware (Phase 1 of the Dashboard
// Date Selector + Charts feature).
//
// GET /api/dashboard                                (legacy - unchanged numbers)
// GET /api/dashboard?preset=THIS_MONTH
// GET /api/dashboard?from=2026-09-01&to=2026-09-27
//
// This route remains STRICTLY READ-ONLY: it never creates a
// JournalEntry/JournalLine/Party/Account/AuditLog/Payment row, and it
// never recomputes accounting semantics independently - every
// Income/Expense/Profit number goes through the SAME lib/pnl.ts
// helper the P&L report uses, and every Receivable/Payable number
// goes through the SAME lib/receivable-payable.ts helper the
// Receivable/Payable reports use, so the Dashboard's figures always
// reconcile with those existing reports for an identical date range.
// ============================================================

type Bucket = "day" | "week" | "month";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function startOfWeekLocal(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = s.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  s.setDate(s.getDate() + diff);
  return s;
}

function pickBucketUnit(spanDays: number): Bucket {
  if (spanDays <= 31) return "day";
  if (spanDays <= 180) return "week";
  return "month";
}

function bucketKeyFor(date: Date, unit: Bucket): string {
  if (unit === "day") return toISODate(date);
  if (unit === "week") return toISODate(startOfWeekLocal(date));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function bucketLabelFor(key: string, unit: Bucket): string {
  if (unit === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MONTHS_SHORT[m - 1]} ${y}`;
  }
  const d = new Date(`${key}T00:00:00`);
  const label = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return unit === "week" ? `Wk of ${label}` : label;
}

function stepBucket(date: Date, unit: Bucket): Date {
  const d = new Date(date);
  if (unit === "day") d.setDate(d.getDate() + 1);
  else if (unit === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function buildBucketTimeline(from: Date, toExclusive: Date, unit: Bucket): string[] {
  const keys: string[] = [];
  let cursor =
    unit === "week"
      ? startOfWeekLocal(from)
      : unit === "month"
        ? new Date(from.getFullYear(), from.getMonth(), 1)
        : new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let guard = 0;
  while (cursor < toExclusive && guard < 2000) {
    keys.push(bucketKeyFor(cursor, unit));
    cursor = stepBucket(cursor, unit);
    guard++;
  }
  if (keys.length === 0) keys.push(bucketKeyFor(from, unit));
  return keys;
}

function orUndefined(d: Date | null): Date | undefined {
  return d ?? undefined;
}

interface PnlLine {
  accountId: string;
  debit: number | string | Decimal;
  credit: number | string | Decimal;
  entryDate: Date;
}

function splitByBoundary<T extends { entryDate: Date }>(
  rows: T[],
  boundary: Date | null
): { primary: T[]; comparison: T[] } {
  if (!boundary) return { primary: rows, comparison: [] };
  const primary: T[] = [];
  const comparison: T[] = [];
  for (const row of rows) {
    if (row.entryDate >= boundary) primary.push(row);
    else comparison.push(row);
  }
  return { primary, comparison };
}

function kpiComparison(current: number, previous: number | null) {
  if (previous === null) {
    return { current: Math.round(current), previous: null, changePercent: null as number | null };
  }
  const changePercent = safePercentChange(current, previous);
  return {
    current: Math.round(current),
    previous: Math.round(previous),
    changePercent: changePercent === null ? null : Math.round(changePercent * 10) / 10,
  };
}

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const range = resolveDateRange({
      preset: searchParams.get("preset"),
      from: searchParams.get("from"),
      to: searchParams.get("to"),
    });

    const canViewFinancials = hasPermission(currentUser, "reports.view");
    const canViewBiltyStats = hasPermission(currentUser, "bilty.view");
    const canViewChallanStats = hasPermission(currentUser, "challan.view");
    const canViewAccountingActivity = hasPermission(currentUser, "accounts.view");
    const canViewBillStats = hasPermission(currentUser, "bill.view");

    const data: Record<string, unknown> = {
      success: true,
      capabilities: {
        canViewFinancials,
        canViewBiltyStats,
        canViewChallanStats,
        canViewAccountingActivity,
        canViewBillStats,
      },
      range: {
        preset: range.preset,
        label: range.label,
        rangeLabel: range.rangeLabel,
        fromISO: range.fromISO,
        toISO: range.toISO,
        comparisonEnabled: Boolean(range.comparisonFrom),
        comparisonFromISO: range.comparisonFromISO,
        comparisonToISO: range.comparisonToISO,
        comparisonRangeLabel: range.comparisonRangeLabel,
      },
    };

    // --------------------------------------------------------
    // Shared bucket timeline for every trend chart (Income vs
    // Expense vs Profit / Collections vs Payments / Operational
    // Volume) - resolved once, independent of any single section's
    // permission, so every chart the user CAN see shares one x-axis.
    // For ALL_TIME (no lower bound), the earliest JournalEntry date
    // sizes the timeline; this is a date-only aggregate, never an
    // amount, so it is safe to compute regardless of financial
    // permission.
    // --------------------------------------------------------
    const now = new Date();
    const nowExclusive = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    let effectiveFrom = range.from;
    const effectiveTo = range.to ?? nowExclusive;

    if (!effectiveFrom) {
      const earliest = await prisma.journalEntry.aggregate({
        _min: { entryDate: true },
        where: { isDeleted: false },
      });
      effectiveFrom = earliest._min.entryDate ?? new Date(nowExclusive.getTime() - 86400000);
    }

    const spanDays = Math.max(
      1,
      Math.round((effectiveTo.getTime() - effectiveFrom.getTime()) / 86400000)
    );
    const bucketUnit = pickBucketUnit(spanDays);
    const timeline = buildBucketTimeline(effectiveFrom, effectiveTo, bucketUnit);

    if (canViewFinancials) {
      // ---- Income / Expense / Profit (+ trend + breakdown) --------
      const pnlAccounts = await prisma.account.findMany({
        where: { isActive: true, accountType: { in: ["INCOME", "EXPENSE"] } },
        select: { id: true, accountName: true, accountCode: true, category: true, accountType: true },
      });
      const pnlAccountIds = pnlAccounts.map((a) => a.id);

      const pnlLinesRaw = await prisma.journalLine.findMany({
        where: {
          accountId: { in: pnlAccountIds },
          journalEntry: {
            is: {
              isDeleted: false,
              entryDate: {
                gte: orUndefined(range.comparisonFrom ?? range.from),
                lt: orUndefined(range.to),
              },
            },
          },
        },
        select: {
          accountId: true,
          debit: true,
          credit: true,
          journalEntry: { select: { entryDate: true } },
        },
      });

      const pnlLines: PnlLine[] = pnlLinesRaw.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        entryDate: l.journalEntry.entryDate,
      }));

      const { primary: pnlPrimary, comparison: pnlComparison } = splitByBoundary(
        pnlLines,
        range.from
      );

      const primaryBalances = accumulateBalances(pnlPrimary);
      let income = 0;
      let expense = 0;
      const incomeBreakdown: { id: string; accountName: string; accountCode: string | null; category: string; amount: number }[] = [];
      const expenseBreakdown: { id: string; accountName: string; accountCode: string | null; category: string; amount: number }[] = [];

      for (const acct of pnlAccounts) {
        const bal = primaryBalances.get(acct.id);
        if (acct.accountType === "INCOME") {
          const amt = netIncome(bal);
          income += amt;
          if (amt !== 0) {
            incomeBreakdown.push({
              id: acct.id,
              accountName: acct.accountName,
              accountCode: acct.accountCode,
              category: acct.category,
              amount: Math.round(amt),
            });
          }
        } else {
          const amt = netExpense(bal);
          expense += amt;
          if (amt !== 0) {
            expenseBreakdown.push({
              id: acct.id,
              accountName: acct.accountName,
              accountCode: acct.accountCode,
              category: acct.category,
              amount: Math.round(amt),
            });
          }
        }
      }

      const profit = income - expense;
      incomeBreakdown.sort((a, b) => b.amount - a.amount);
      expenseBreakdown.sort((a, b) => b.amount - a.amount);

      let previousIncome: number | null = null;
      let previousExpense: number | null = null;
      let previousProfit: number | null = null;

      if (range.comparisonFrom) {
        const comparisonBalances = accumulateBalances(pnlComparison);
        let pIncome = 0;
        let pExpense = 0;
        for (const acct of pnlAccounts) {
          const bal = comparisonBalances.get(acct.id);
          if (acct.accountType === "INCOME") pIncome += netIncome(bal);
          else pExpense += netExpense(bal);
        }
        previousIncome = pIncome;
        previousExpense = pExpense;
        previousProfit = pIncome - pExpense;
      }

      // Chart 1: Income vs Expense vs Profit trend, bucketed from the
      // SAME pnlPrimary lines used for the KPI totals above - never a
      // second, independently-derived number.
      const pnlLinesByBucket = new Map<string, PnlLine[]>();
      for (const key of timeline) pnlLinesByBucket.set(key, []);
      for (const line of pnlPrimary) {
        const key = bucketKeyFor(line.entryDate, bucketUnit);
        const arr = pnlLinesByBucket.get(key);
        if (arr) arr.push(line);
      }
      const incomeExpenseProfitPoints = timeline.map((key) => {
        const balances = accumulateBalances(pnlLinesByBucket.get(key) || []);
        let bucketIncome = 0;
        let bucketExpense = 0;
        for (const acct of pnlAccounts) {
          const bal = balances.get(acct.id);
          if (!bal) continue;
          if (acct.accountType === "INCOME") bucketIncome += netIncome(bal);
          else bucketExpense += netExpense(bal);
        }
        return {
          key,
          label: bucketLabelFor(key, bucketUnit),
          income: Math.round(bucketIncome),
          expense: Math.round(bucketExpense),
          profit: Math.round(bucketIncome - bucketExpense),
        };
      });

      // ---- Receivable / Payable (closing balance as of period end) -
      const {
        receivable: receivableRows,
        payable: payableRows,
        totalReceivable,
        totalPayable,
      } = await getReceivablePayable(range.to);
      let previousReceivable: number | null = null;
      let previousPayable: number | null = null;
      if (range.comparisonFrom) {
        const comparisonRP = await getReceivablePayable(range.comparisonTo);
        previousReceivable = comparisonRP.totalReceivable;
        previousPayable = comparisonRP.totalPayable;
      }

      // ---- Receivable / Payable Ageing (Phase 2) - bucketed from the
      // SAME rows just fetched above, zero extra queries. See
      // lib/receivable-payable.ts's own header comment on bucketAgeing()
      // for why this is an approximation (days since last activity),
      // not true per-invoice ageing.
      const ageingAsOf = range.to ?? new Date();
      data.ageing = {
        asOfLabel: range.rangeLabel,
        receivable: bucketAgeing(receivableRows, ageingAsOf),
        payable: bucketAgeing(payableRows, ageingAsOf),
      };

      // ---- Cash / Bank balance (as of period end) + Collections /
      // Payments (actual movement during the period) - both derived
      // from ONE unbounded Cash/Bank JournalLine fetch (the same
      // pattern the pre-existing dashboard already used for its
      // all-time Cash/Bank balance), filtered in memory so no extra
      // round trips are needed for the comparison period or the chart.
      const cashBankAccounts = await prisma.account.findMany({
        where: { isActive: true, OR: [{ category: "CASH" }, { category: "BANK" }] },
        select: { id: true, accountName: true, category: true },
      });
      const cashBankIds = cashBankAccounts.map((a) => a.id);

      const cashBankLinesRaw = cashBankIds.length
        ? await prisma.journalLine.findMany({
            where: { accountId: { in: cashBankIds }, journalEntry: { is: { isDeleted: false } } },
            select: {
              accountId: true,
              debit: true,
              credit: true,
              journalEntry: { select: { entryDate: true } },
            },
          })
        : [];
      const cashBankLines = cashBankLinesRaw.map((l) => ({
        accountId: l.accountId,
        debit: Number(l.debit),
        credit: Number(l.credit),
        entryDate: l.journalEntry.entryDate,
      }));

      function cashBankBalanceAsOf(asOfExclusive: Date | null) {
        const totals = new Map<string, { debit: number; credit: number }>();
        for (const l of cashBankLines) {
          if (asOfExclusive && l.entryDate >= asOfExclusive) continue;
          const cur = totals.get(l.accountId) || { debit: 0, credit: 0 };
          cur.debit += l.debit;
          cur.credit += l.credit;
          totals.set(l.accountId, cur);
        }
        let cash = 0;
        let bank = 0;
        for (const acct of cashBankAccounts) {
          const t = totals.get(acct.id) || { debit: 0, credit: 0 };
          const net = t.debit - t.credit;
          if (acct.category === "CASH") cash += net;
          else if (acct.category === "BANK") bank += net;
        }
        return { cash, bank };
      }

      function cashFlowInRange(gte: Date | null, lt: Date | null) {
        let collections = 0;
        let payments = 0;
        for (const l of cashBankLines) {
          if (gte && l.entryDate < gte) continue;
          if (lt && l.entryDate >= lt) continue;
          collections += l.debit;
          payments += l.credit;
        }
        return { collections, payments };
      }

      const currentCashBank = cashBankBalanceAsOf(range.to);
      const previousCashBank = range.comparisonFrom ? cashBankBalanceAsOf(range.comparisonTo) : null;
      const primaryCashFlow = cashFlowInRange(range.from, range.to);
      const comparisonCashFlow = range.comparisonFrom
        ? cashFlowInRange(range.comparisonFrom, range.comparisonTo)
        : null;

      // Chart 5: Collections vs Payments trend.
      const chart5Buckets = new Map<string, { collections: number; payments: number }>();
      for (const key of timeline) chart5Buckets.set(key, { collections: 0, payments: 0 });
      for (const line of cashBankLines) {
        if (range.from && line.entryDate < range.from) continue;
        if (range.to && line.entryDate >= range.to) continue;
        const key = bucketKeyFor(line.entryDate, bucketUnit);
        const b = chart5Buckets.get(key);
        if (!b) continue;
        b.collections += line.debit;
        b.payments += line.credit;
      }
      const collectionsPaymentsPoints = timeline.map((key) => {
        const b = chart5Buckets.get(key)!;
        return {
          key,
          label: bucketLabelFor(key, bucketUnit),
          collections: Math.round(b.collections),
          payments: Math.round(b.payments),
        };
      });

      data.financials = {
        receivable: Math.round(totalReceivable),
        payable: Math.round(totalPayable),
        cashBalance: Math.round(currentCashBank.cash),
        bankBalance: Math.round(currentCashBank.bank),
        income: Math.round(income),
        expense: Math.round(expense),
        profit: Math.round(profit),
        collections: Math.round(primaryCashFlow.collections),
        payments: Math.round(primaryCashFlow.payments),
      };

      data.comparison = {
        revenue: kpiComparison(income, previousIncome),
        expense: kpiComparison(expense, previousExpense),
        profit: kpiComparison(profit, previousProfit),
        receivable: kpiComparison(totalReceivable, previousReceivable),
        payable: kpiComparison(totalPayable, previousPayable),
        cashBalance: kpiComparison(currentCashBank.cash, previousCashBank?.cash ?? null),
        bankBalance: kpiComparison(currentCashBank.bank, previousCashBank?.bank ?? null),
        collections: kpiComparison(primaryCashFlow.collections, comparisonCashFlow?.collections ?? null),
        payments: kpiComparison(primaryCashFlow.payments, comparisonCashFlow?.payments ?? null),
      };

      data.cashAccounts = cashBankAccounts
        .filter((a) => a.category === "CASH")
        .map((a) => ({ id: a.id, accountName: a.accountName }));
      data.bankAccounts = cashBankAccounts
        .filter((a) => a.category === "BANK")
        .map((a) => ({ id: a.id, accountName: a.accountName }));

      data.charts = {
        incomeExpenseProfit: { unit: bucketUnit, points: incomeExpenseProfitPoints },
        receivablePayable: {
          asOfLabel: range.rangeLabel,
          receivable: Math.round(totalReceivable),
          payable: Math.round(totalPayable),
        },
        incomeBreakdown,
        expenseBreakdown,
        collectionsPayments: { unit: bucketUnit, points: collectionsPaymentsPoints },
      };
    }

    // -------------------- Operational sections --------------------
    // Bilty/Challan status counts remain ALL-TIME/current-state, same
    // as before the date selector existed - these describe current
    // pipeline state, not a period's activity, so they are
    // intentionally NOT re-scoped to the selected range.
    if (canViewBiltyStats) {
      const [
        totalBilties,
        pendingBilties,
        inTransitBilties,
        deliveredBilties,
        cancelledBilties,
      ] = await Promise.all([
        prisma.bilty.count({ where: { isDeleted: false } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "PENDING" } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "IN_TRANSIT" } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "DELIVERED" } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "CANCELLED" } }),
      ]);

      data.biltyStats = {
        total: totalBilties,
        pending: pendingBilties,
        inTransit: inTransitBilties,
        delivered: deliveredBilties,
        cancelled: cancelledBilties,
      };
    }

    if (canViewChallanStats) {
      const [
        totalChallans,
        activeChallans,
        deliveredChallans,
        settledChallans,
      ] = await Promise.all([
        prisma.challan.count({ where: { isDeleted: false } }),
        prisma.challan.count({ where: { isDeleted: false, status: "IN_TRANSIT" } }),
        prisma.challan.count({ where: { isDeleted: false, status: "DELIVERED" } }),
        prisma.challan.count({ where: { isDeleted: false, isSettled: true } }),
      ]);

      data.challanStats = {
        total: totalChallans,
        active: activeChallans,
        delivered: deliveredChallans,
        settled: settledChallans,
      };
    }

    // Chart 6: Operational Volume - counts WITHIN the selected period,
    // one series per module the current user is permitted to view.
    // Never blended into a single "activity" number.
    if (canViewBiltyStats || canViewChallanStats || canViewBillStats) {
      const rangeGte = orUndefined(range.from);
      const rangeLt = orUndefined(range.to);

      const [biltyDates, challanDates, billDates] = await Promise.all([
        canViewBiltyStats
          ? prisma.bilty.findMany({
              where: { isDeleted: false, date: { gte: rangeGte, lt: rangeLt } },
              select: { date: true },
            })
          : Promise.resolve(null),
        canViewChallanStats
          ? prisma.challan.findMany({
              where: { isDeleted: false, loadingDate: { gte: rangeGte, lt: rangeLt } },
              select: { loadingDate: true },
            })
          : Promise.resolve(null),
        canViewBillStats
          ? prisma.bill.findMany({
              where: { isDeleted: false, date: { gte: rangeGte, lt: rangeLt } },
              select: { date: true },
            })
          : Promise.resolve(null),
      ]);

      function countByBucket(dates: Date[] | null): Map<string, number> | null {
        if (!dates) return null;
        const m = new Map<string, number>();
        for (const d of dates) {
          const key = bucketKeyFor(d, bucketUnit);
          m.set(key, (m.get(key) || 0) + 1);
        }
        return m;
      }

      const biltyBuckets = countByBucket(biltyDates?.map((b) => b.date) ?? null);
      const challanBuckets = countByBucket(challanDates?.map((c) => c.loadingDate) ?? null);
      const billBuckets = countByBucket(billDates?.map((b) => b.date) ?? null);

      const series: string[] = [
        ...(canViewBiltyStats ? ["bilty"] : []),
        ...(canViewChallanStats ? ["challan"] : []),
        ...(canViewBillStats ? ["bill"] : []),
      ];

      const points = timeline.map((key) => {
        const point: Record<string, unknown> = { key, label: bucketLabelFor(key, bucketUnit) };
        if (biltyBuckets) point.bilty = biltyBuckets.get(key) || 0;
        if (challanBuckets) point.challan = challanBuckets.get(key) || 0;
        if (billBuckets) point.bill = billBuckets.get(key) || 0;
        return point;
      });

      const existingCharts = (data.charts as Record<string, unknown>) || {};
      data.charts = {
        ...existingCharts,
        operationalVolume: { unit: bucketUnit, series, points },
      };
    }

    if (canViewBiltyStats) {
      const recentBilties = await prisma.bilty.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          biltyNo: true,
          date: true,
          status: true,
          toPay: true,
          fromLocation: { select: { name: true } },
          toLocation: { select: { name: true } },
        },
      });

      data.recentBilties = recentBilties;
    }

    if (canViewChallanStats) {
      const recentChallans = await prisma.challan.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          challanNo: true,
          loadingDate: true,
          status: true,
          isSettled: true,
          transporterParty: { select: { partyName: true } },
        },
      });

      data.recentChallans = recentChallans;
    }

    if (canViewAccountingActivity) {
      const recentEntries = await prisma.journalEntry.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          entryDate: true,
          referenceType: true,
          referenceId: true,
          description: true,
          lines: { select: { debit: true, credit: true } },
        },
      });

      const recentPostings = await prisma.journalEntry.findMany({
        where: { isDeleted: false, referenceType: "DAILY_POSTING" },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          entryDate: true,
          referenceType: true,
          referenceId: true,
          description: true,
          lines: { select: { debit: true, credit: true } },
        },
      });

      data.recentAccountingEntries = recentEntries.map((entry) => ({
        id: entry.id,
        entryDate: entry.entryDate,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        description: entry.description,
        totalDebit: entry.lines.reduce((sum, line) => sum + Number(line.debit), 0),
        totalCredit: entry.lines.reduce((sum, line) => sum + Number(line.credit), 0),
      }));

      data.recentDailyPostings = recentPostings.map((entry) => ({
        id: entry.id,
        entryDate: entry.entryDate,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        description: entry.description,
        totalDebit: entry.lines.reduce((sum, line) => sum + Number(line.debit), 0),
        totalCredit: entry.lines.reduce((sum, line) => sum + Number(line.credit), 0),
      }));
    }

    // ============================================================
    // PHASE 2 - Management Analytics.
    //
    // Every section below is independently permission-gated. Where
    // the underlying figures are financial (Top Clients' Revenue, Top
    // Transporters' Carrier Rent, Bilty/Challan/Bill amounts, Phonch
    // comparison), the section ALSO requires reports.view - the data
    // is omitted from this response entirely for an unauthorized user
    // (never sent and merely hidden client-side), per the Phase 2
    // spec's own explicit instruction.
    // ============================================================
    const canViewPhonchStats = hasPermission(currentUser, "phonch.view");
    const canViewPrivatePhonchStats = hasPermission(currentUser, "privatePhonch.view");

    const canViewTopClients = canViewFinancials && canViewBillStats;
    const canViewTopTransporters = canViewFinancials && canViewChallanStats;
    const canViewBiltyAnalytics = canViewFinancials && canViewBiltyStats;
    const canViewChallanAnalytics = canViewFinancials && canViewChallanStats;
    const canViewBillAnalytics = canViewFinancials && canViewBillStats;
    const canViewPhonchComparison = canViewFinancials && (canViewPhonchStats || canViewPrivatePhonchStats);

    const rangeGteP2 = orUndefined(range.from);
    const rangeLtP2 = orUndefined(range.to);
    const comparisonGteP2 = orUndefined(range.comparisonFrom);
    const comparisonLtP2 = orUndefined(range.comparisonTo);

    const [
      topClientsRevenue,
      topClientsActivity,
      topTransporters,
      biltySummary,
      challanSummary,
      billSummary,
      phonchComparison,
      primaryBiltyCount,
      primaryChallanCount,
      primaryBillCount,
      comparisonBiltyCount,
      comparisonChallanCount,
      comparisonBillCount,
    ] = await Promise.all([
      canViewTopClients ? getTopClientsByRevenue(range.from, range.to, 10) : Promise.resolve(null),
      canViewTopClients ? getTopClientsByActivity(range.from, range.to, 10) : Promise.resolve(null),
      canViewTopTransporters ? getTopTransportersByCarrierRent(range.from, range.to, 10) : Promise.resolve(null),
      canViewBiltyAnalytics ? getBiltySummary(range.from, range.to) : Promise.resolve(null),
      canViewChallanAnalytics ? getChallanSummary(range.from, range.to) : Promise.resolve(null),
      canViewBillAnalytics ? getBillSummary(range.from, range.to) : Promise.resolve(null),
      canViewPhonchComparison ? getPhonchComparison(range.from, range.to) : Promise.resolve(null),
      canViewBiltyStats
        ? prisma.bilty.count({ where: { isDeleted: false, date: { gte: rangeGteP2, lt: rangeLtP2 } } })
        : Promise.resolve(null),
      canViewChallanStats
        ? prisma.challan.count({ where: { isDeleted: false, loadingDate: { gte: rangeGteP2, lt: rangeLtP2 } } })
        : Promise.resolve(null),
      canViewBillStats
        ? prisma.bill.count({ where: { isDeleted: false, date: { gte: rangeGteP2, lt: rangeLtP2 } } })
        : Promise.resolve(null),
      canViewBiltyStats && range.comparisonFrom
        ? prisma.bilty.count({ where: { isDeleted: false, date: { gte: comparisonGteP2, lt: comparisonLtP2 } } })
        : Promise.resolve(null),
      canViewChallanStats && range.comparisonFrom
        ? prisma.challan.count({ where: { isDeleted: false, loadingDate: { gte: comparisonGteP2, lt: comparisonLtP2 } } })
        : Promise.resolve(null),
      canViewBillStats && range.comparisonFrom
        ? prisma.bill.count({ where: { isDeleted: false, date: { gte: comparisonGteP2, lt: comparisonLtP2 } } })
        : Promise.resolve(null),
    ]);

    if (topClientsRevenue || topClientsActivity) {
      data.topClients = {
        revenue: topClientsRevenue
          ? { rows: topClientsRevenue.rows, totalRevenue: Math.round(topClientsRevenue.totalRevenue) }
          : null,
        activity: topClientsActivity,
      };
    }

    if (topTransporters) {
      data.topTransporters = {
        rows: topTransporters.rows,
        totalCarrierRent: Math.round(topTransporters.totalCarrierRent),
      };
    }

    if (biltySummary || challanSummary || billSummary) {
      data.documentPerformance = {
        bilty: biltySummary,
        challan: challanSummary,
        bill: billSummary,
      };
    }

    if (phonchComparison) {
      // Each side is independently gated by its OWN permission, never
      // exposed just because the other side's permission is granted.
      data.phonchComparison = {
        showroom: canViewPhonchStats ? phonchComparison.showroom : null,
        private: canViewPrivatePhonchStats ? phonchComparison.private : null,
      };
    }

    // ---- Detailed Period Comparison table - reuses the SAME
    // data.comparison figures already computed above (never a second,
    // independently-derived Revenue/Expense/Profit/Receivable/
    // Payable/Collections/Payments number) plus the Bilty/Challan/Bill
    // counts just fetched. All Time / no comparison period -> omitted
    // entirely, never a misleading blank-vs-current row.
    if (range.comparisonFrom) {
      const financialComparison = data.comparison as
        | Record<string, { current: number; previous: number | null; changePercent: number | null }>
        | undefined;

      const rows: { metric: string; current: number; previous: number | null; changePercent: number | null }[] = [];

      if (financialComparison) {
        rows.push(
          { metric: "Revenue", ...financialComparison.revenue },
          { metric: "Expense", ...financialComparison.expense },
          { metric: "Profit", ...financialComparison.profit },
          { metric: "Collections", ...financialComparison.collections },
          { metric: "Payments", ...financialComparison.payments },
          { metric: "Receivable", ...financialComparison.receivable },
          { metric: "Payable", ...financialComparison.payable }
        );
      }
      if (canViewBiltyStats && primaryBiltyCount !== null) {
        rows.push({ metric: "Bilty Bookings", ...kpiComparison(primaryBiltyCount, comparisonBiltyCount) });
      }
      if (canViewChallanStats && primaryChallanCount !== null) {
        rows.push({ metric: "Challans", ...kpiComparison(primaryChallanCount, comparisonChallanCount) });
      }
      if (canViewBillStats && primaryBillCount !== null) {
        rows.push({ metric: "Bills", ...kpiComparison(primaryBillCount, comparisonBillCount) });
      }

      if (rows.length > 0) {
        data.periodComparison = { comparisonRangeLabel: range.comparisonRangeLabel, rows };
      }
    }

    // ---- Management Summary - purely a data recap of figures already
    // computed above, never a speculative/judgmental statement. Each
    // field is null when its underlying permission is not granted.
    const financialsForSummary = data.financials as
      | {
          income: number;
          expense: number;
          profit: number;
          receivable: number;
          payable: number;
          collections: number;
          payments: number;
        }
      | undefined;

    data.managementSummary = {
      rangeLabel: range.rangeLabel,
      revenue: financialsForSummary?.income ?? null,
      expense: financialsForSummary?.expense ?? null,
      profit: financialsForSummary?.profit ?? null,
      collections: financialsForSummary?.collections ?? null,
      outstandingReceivable: financialsForSummary?.receivable ?? null,
      outstandingPayable: financialsForSummary?.payable ?? null,
      bookings: primaryBiltyCount,
      dispatches: primaryChallanCount,
      bills: primaryBillCount,
    };

    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof DateRangeValidationError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: error.status }
      );
    }
    console.error("Dashboard API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load dashboard" },
      { status: 500 }
    );
  }
}
