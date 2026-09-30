"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import DateRangeSelector from "@/components/dashboard/DateRangeSelector";
import KpiCard, { KpiComparison } from "@/components/dashboard/KpiCard";
import IncomeExpenseProfitChart, {
  IncomeExpenseProfitPoint,
} from "@/components/dashboard/charts/IncomeExpenseProfitChart";
import ReceivablePayableChart from "@/components/dashboard/charts/ReceivablePayableChart";
import BreakdownChart, { BreakdownEntry } from "@/components/dashboard/charts/BreakdownChart";
import CollectionsPaymentsChart, {
  CollectionsPaymentsPoint,
} from "@/components/dashboard/charts/CollectionsPaymentsChart";
import OperationalVolumeChart, {
  OperationalVolumePoint,
} from "@/components/dashboard/charts/OperationalVolumeChart";
import TopClientsChart, {
  TopClientActivityRow,
  TopClientRevenueRow,
} from "@/components/dashboard/charts/TopClientsChart";
import TopTransportersChart, { TopTransporterRow } from "@/components/dashboard/charts/TopTransportersChart";
import AgeingChart, { AgeingBucket } from "@/components/dashboard/charts/AgeingChart";
import PhonchComparisonChart, {
  PrivatePhonchSummary,
  ShowroomPhonchSummary,
} from "@/components/dashboard/charts/PhonchComparisonChart";
import DocumentPerformanceCards, {
  BillSummary,
  BiltySummary,
  ChallanSummary,
} from "@/components/dashboard/DocumentPerformanceCards";
import ComparisonTable, { ComparisonRow } from "@/components/dashboard/ComparisonTable";
import ManagementSummary, { ManagementSummaryData } from "@/components/dashboard/ManagementSummary";
import { formatCurrency } from "@/components/dashboard/format";

type Financials = {
  receivable: number;
  payable: number;
  cashBalance: number;
  bankBalance: number;
  income: number;
  expense: number;
  profit: number;
  collections: number;
  payments: number;
};

type Comparison = Record<
  "revenue" | "expense" | "profit" | "receivable" | "payable" | "cashBalance" | "bankBalance" | "collections" | "payments",
  KpiComparison
>;

type NamedAccount = { id: string; accountName: string };

type RangeInfo = {
  preset: string;
  label: string;
  rangeLabel: string;
  fromISO: string | null;
  toISO: string | null;
  comparisonEnabled: boolean;
  comparisonFromISO: string | null;
  comparisonToISO: string | null;
  comparisonRangeLabel: string | null;
};

type BiltyStats = {
  total: number;
  pending: number;
  inTransit: number;
  delivered: number;
  cancelled: number;
};

type ChallanStats = {
  total: number;
  active: number;
  delivered: number;
  settled: number;
};

type RecentBilty = {
  id: string;
  biltyNo: string;
  date: string;
  status: string;
  toPay: number;
  fromLocation: { name: string };
  toLocation: { name: string };
};

type RecentChallan = {
  id: string;
  challanNo: string;
  loadingDate: string;
  status: string;
  isSettled: boolean;
  transporterParty: { partyName: string } | null;
};

type RecentEntry = {
  id: string;
  entryDate: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  totalDebit: number;
  totalCredit: number;
};

type Charts = {
  incomeExpenseProfit?: { unit: string; points: IncomeExpenseProfitPoint[] };
  receivablePayable?: { asOfLabel: string; receivable: number; payable: number };
  incomeBreakdown?: BreakdownEntry[];
  expenseBreakdown?: BreakdownEntry[];
  collectionsPayments?: { unit: string; points: CollectionsPaymentsPoint[] };
  operationalVolume?: { unit: string; series: string[]; points: OperationalVolumePoint[] };
};

type TopClients = {
  revenue: { rows: TopClientRevenueRow[]; totalRevenue: number } | null;
  activity: TopClientActivityRow[] | null;
};

type TopTransporters = { rows: TopTransporterRow[]; totalCarrierRent: number };

type Ageing = { asOfLabel: string; receivable: AgeingBucket[]; payable: AgeingBucket[] };

type DocumentPerformance = { bilty: BiltySummary | null; challan: ChallanSummary | null; bill: BillSummary | null };

type PhonchComparison = { showroom: ShowroomPhonchSummary | null; private: PrivatePhonchSummary | null };

type PeriodComparison = { comparisonRangeLabel: string | null; rows: ComparisonRow[] };

type DashboardData = {
  success: boolean;
  capabilities: {
    canViewFinancials: boolean;
    canViewBiltyStats: boolean;
    canViewChallanStats: boolean;
    canViewAccountingActivity: boolean;
    canViewBillStats: boolean;
  };
  range: RangeInfo;
  financials?: Financials;
  comparison?: Comparison;
  cashAccounts?: NamedAccount[];
  bankAccounts?: NamedAccount[];
  charts?: Charts;
  biltyStats?: BiltyStats;
  challanStats?: ChallanStats;
  recentBilties?: RecentBilty[];
  recentChallans?: RecentChallan[];
  recentAccountingEntries?: RecentEntry[];
  recentDailyPostings?: RecentEntry[];
  topClients?: TopClients;
  topTransporters?: TopTransporters;
  ageing?: Ageing;
  documentPerformance?: DocumentPerformance;
  phonchComparison?: PhonchComparison;
  periodComparison?: PeriodComparison;
  managementSummary?: ManagementSummaryData;
};

function getStatusColor(status: string) {
  switch (status) {
    case "PENDING":
      return "text-yellow-600 bg-yellow-50";
    case "IN_TRANSIT":
      return "text-blue-600 bg-blue-50";
    case "DELIVERED":
      return "text-green-600 bg-green-50";
    case "CANCELLED":
      return "text-red-600 bg-red-50";
    default:
      return "text-gray-600 bg-gray-50";
  }
}

function buildQuery(preset: string, customFrom: string, customTo: string): string {
  const params = new URLSearchParams();
  if (preset === "CUSTOM") {
    if (customFrom) params.set("from", customFrom);
    if (customTo) params.set("to", customTo);
  } else {
    params.set("preset", preset);
  }
  return params.toString();
}

export default function DashboardPage() {
  const initialParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initialFrom = initialParams?.get("from") || "";
  const initialTo = initialParams?.get("to") || "";
  const initialPresetParam = initialParams?.get("preset") || "";
  const initialPreset = initialPresetParam || (initialFrom || initialTo ? "CUSTOM" : "THIS_MONTH");

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preset, setPreset] = useState(initialPreset);
  const [customFrom, setCustomFrom] = useState(initialFrom);
  const [customTo, setCustomTo] = useState(initialTo);
  const [compareEnabled, setCompareEnabled] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const query = buildQuery(preset, customFrom, customTo);
        const response = await fetch(`/api/dashboard?${query}`);
        const result = await response.json();
        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load dashboard");
          return;
        }
        setData(result);
        const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
        window.history.replaceState(null, "", url);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [preset, customFrom, customTo]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto p-6">
          <p className="text-gray-500">Loading dashboard...</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto p-6">
          <p className="text-red-600">{error || "Unable to load dashboard"}</p>
        </div>
      </main>
    );
  }

  const { range } = data;
  const profitLossHref =
    range.fromISO && range.toISO
      ? `/reports/profit-loss?from=${range.fromISO}&to=${range.toISO}`
      : "/reports/profit-loss";

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">ANC Dashboard</h1>
            <p className="text-sm text-gray-500 mt-1">Overview for the selected period</p>
          </div>
          <DateRangeSelector
            preset={range.preset}
            label={range.label}
            rangeLabel={range.rangeLabel}
            compareEnabled={compareEnabled}
            onCompareChange={setCompareEnabled}
            onSelectPreset={(next) => {
              setPreset(next);
              setCustomFrom("");
              setCustomTo("");
            }}
            onApplyCustomRange={(from, to) => {
              setPreset("CUSTOM");
              setCustomFrom(from);
              setCustomTo(to);
            }}
            initialCustomFrom={range.fromISO || ""}
            initialCustomTo={range.toISO || ""}
          />
        </div>

        {/* Management Summary */}
        {data.managementSummary && (
          <section className="mb-8">
            <ManagementSummary data={data.managementSummary} />
          </section>
        )}

        {/* Financial KPI Cards */}
        {data.capabilities.canViewFinancials && data.financials && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Financial Overview</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KpiCard
                label="Revenue"
                value={data.financials.income}
                href={profitLossHref}
                comparison={data.comparison?.revenue}
                compareEnabled={compareEnabled}
                comparisonLabel={`vs ${range.comparisonRangeLabel || "previous period"}`}
                valueClassName="text-green-600"
              />
              <KpiCard
                label="Expense"
                value={data.financials.expense}
                href={profitLossHref}
                comparison={data.comparison?.expense}
                compareEnabled={compareEnabled}
                comparisonLabel={`vs ${range.comparisonRangeLabel || "previous period"}`}
                valueClassName="text-red-600"
              />
              <KpiCard
                label="Net Profit"
                value={data.financials.profit}
                href={profitLossHref}
                comparison={data.comparison?.profit}
                compareEnabled={compareEnabled}
                comparisonLabel={`vs ${range.comparisonRangeLabel || "previous period"}`}
                valueClassName={data.financials.profit >= 0 ? "text-green-600" : "text-red-600"}
              />
              <KpiCard
                label="Receivable"
                value={data.financials.receivable}
                href="/reports/receivable"
                comparison={data.comparison?.receivable}
                compareEnabled={compareEnabled}
                comparisonLabel="vs previous period end"
                footnote={`As of ${range.rangeLabel.split(" - ").pop()}`}
              />
              <KpiCard
                label="Payable"
                value={data.financials.payable}
                href="/reports/payable"
                comparison={data.comparison?.payable}
                compareEnabled={compareEnabled}
                comparisonLabel="vs previous period end"
              />
              <KpiCard
                label="Cash + Bank"
                value={data.financials.cashBalance + data.financials.bankBalance}
                href={
                  data.cashAccounts?.length === 1
                    ? `/cash-book?accountId=${data.cashAccounts[0].id}`
                    : "/cash-book"
                }
                comparison={
                  data.comparison
                    ? {
                        current: data.comparison.cashBalance.current + data.comparison.bankBalance.current,
                        previous:
                          data.comparison.cashBalance.previous !== null &&
                          data.comparison.bankBalance.previous !== null
                            ? data.comparison.cashBalance.previous + data.comparison.bankBalance.previous
                            : null,
                        changePercent: null,
                      }
                    : undefined
                }
                compareEnabled={false}
              />
              <KpiCard
                label="Collections"
                value={data.financials.collections}
                href="/cash-book"
                comparison={data.comparison?.collections}
                compareEnabled={compareEnabled}
                comparisonLabel={`vs ${range.comparisonRangeLabel || "previous period"}`}
                valueClassName="text-green-600"
              />
              <KpiCard
                label="Payments"
                value={data.financials.payments}
                href="/cash-book"
                comparison={data.comparison?.payments}
                compareEnabled={compareEnabled}
                comparisonLabel={`vs ${range.comparisonRangeLabel || "previous period"}`}
                valueClassName="text-red-600"
              />
            </div>
          </section>
        )}

        {/* Main financial chart */}
        {data.charts?.incomeExpenseProfit && (
          <section className="mb-6">
            <IncomeExpenseProfitChart points={data.charts.incomeExpenseProfit.points} />
          </section>
        )}

        {/* Second row */}
        {(data.charts?.receivablePayable || data.charts?.incomeBreakdown) && (
          <section className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {data.charts?.receivablePayable && (
              <ReceivablePayableChart
                receivable={data.charts.receivablePayable.receivable}
                payable={data.charts.receivablePayable.payable}
                asOfLabel={data.charts.receivablePayable.asOfLabel}
              />
            )}
            {data.charts?.incomeBreakdown && (
              <BreakdownChart
                title="Income Breakdown"
                description="By income category, same source as the Profit & Loss report."
                entries={data.charts.incomeBreakdown}
                color="#16a34a"
              />
            )}
          </section>
        )}

        {/* Third row */}
        {(data.charts?.expenseBreakdown || data.charts?.collectionsPayments) && (
          <section className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {data.charts?.expenseBreakdown && (
              <BreakdownChart
                title="Expense Breakdown"
                description="By expense category, same source as the Profit & Loss report."
                entries={data.charts.expenseBreakdown}
                color="#dc2626"
              />
            )}
            {data.charts?.collectionsPayments && (
              <CollectionsPaymentsChart points={data.charts.collectionsPayments.points} />
            )}
          </section>
        )}

        {/* Client & Transporter */}
        {(data.topClients || data.topTransporters) && (
          <section className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {data.topClients && (
              <TopClientsChart revenue={data.topClients.revenue} activity={data.topClients.activity} />
            )}
            {data.topTransporters && <TopTransportersChart data={data.topTransporters} />}
          </section>
        )}

        {/* Ageing */}
        {data.ageing && (
          <section className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <AgeingChart
              title="Receivable Ageing"
              buckets={data.ageing.receivable}
              asOfLabel={data.ageing.asOfLabel}
              color="#2563eb"
            />
            <AgeingChart
              title="Payable Ageing"
              buckets={data.ageing.payable}
              asOfLabel={data.ageing.asOfLabel}
              color="#f59e0b"
            />
          </section>
        )}

        {/* Fourth row */}
        {data.charts?.operationalVolume && (
          <section className="mb-8">
            <OperationalVolumeChart
              points={data.charts.operationalVolume.points}
              series={data.charts.operationalVolume.series}
            />
          </section>
        )}

        {/* Document Performance */}
        {data.documentPerformance && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Document Performance</h2>
            <DocumentPerformanceCards
              bilty={data.documentPerformance.bilty}
              challan={data.documentPerformance.challan}
              bill={data.documentPerformance.bill}
            />
          </section>
        )}

        {/* Phonch */}
        {data.phonchComparison && (
          <section className="mb-8">
            <PhonchComparisonChart
              showroom={data.phonchComparison.showroom}
              privatePhonch={data.phonchComparison.private}
            />
          </section>
        )}

        {/* Period Comparison */}
        {data.periodComparison && data.periodComparison.rows.length > 0 && (
          <section className="mb-8">
            <ComparisonTable
              rows={data.periodComparison.rows}
              comparisonRangeLabel={data.periodComparison.comparisonRangeLabel}
            />
          </section>
        )}

        {/* Operations - all-time / current-state, unaffected by the date selector */}
        {(data.capabilities.canViewBiltyStats || data.capabilities.canViewChallanStats) && (
          <section className="mb-8">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Operations</h2>
              <span className="text-xs text-gray-400">All-time / current status</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {data.capabilities.canViewBiltyStats && data.biltyStats && (
                <>
                  <Link href="/bilty" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">Total Bilties</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">{data.biltyStats.total}</p>
                  </Link>
                  <Link href="/bilty?status=PENDING" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">Pending</p>
                    <p className="text-2xl font-bold text-yellow-600 mt-1">{data.biltyStats.pending}</p>
                  </Link>
                  <Link href="/bilty?status=IN_TRANSIT" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">In Transit</p>
                    <p className="text-2xl font-bold text-blue-600 mt-1">{data.biltyStats.inTransit}</p>
                  </Link>
                  <Link href="/bilty?status=DELIVERED" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">Delivered</p>
                    <p className="text-2xl font-bold text-green-600 mt-1">{data.biltyStats.delivered}</p>
                  </Link>
                </>
              )}
              {data.capabilities.canViewChallanStats && data.challanStats && (
                <>
                  <Link href="/challan" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">Total Challans</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">{data.challanStats.total}</p>
                  </Link>
                  <Link href="/challan?status=IN_TRANSIT" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">Active</p>
                    <p className="text-2xl font-bold text-blue-600 mt-1">{data.challanStats.active}</p>
                  </Link>
                  <Link href="/challan?status=DELIVERED" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">Delivered</p>
                    <p className="text-2xl font-bold text-green-600 mt-1">{data.challanStats.delivered}</p>
                  </Link>
                  <Link href="/challan?financial=AFTER_SETTLEMENT" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                    <p className="text-sm text-gray-500">Settled</p>
                    <p className="text-2xl font-bold text-purple-600 mt-1">{data.challanStats.settled}</p>
                  </Link>
                </>
              )}
            </div>
          </section>
        )}

        {/* Recent Activity */}
        {(data.capabilities.canViewBiltyStats || data.capabilities.canViewChallanStats || data.capabilities.canViewAccountingActivity) && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {data.capabilities.canViewBiltyStats && data.recentBilties && data.recentBilties.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm p-5">
                  <h3 className="text-sm font-medium text-gray-500 mb-3">Recent Bilties</h3>
                  <div className="space-y-3">
                    {data.recentBilties.map((bilty) => (
                      <Link
                        key={bilty.id}
                        href={`/bilty/${bilty.id}`}
                        className="block hover:bg-gray-50 rounded-lg p-2 -mx-2"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-900">{bilty.biltyNo}</p>
                            <p className="text-xs text-gray-500">
                              {bilty.fromLocation.name} → {bilty.toLocation.name}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-medium text-gray-900">{formatCurrency(bilty.toPay || 0)}</p>
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(bilty.status)}`}>
                              {bilty.status}
                            </span>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {data.capabilities.canViewChallanStats && data.recentChallans && data.recentChallans.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm p-5">
                  <h3 className="text-sm font-medium text-gray-500 mb-3">Recent Challans</h3>
                  <div className="space-y-3">
                    {data.recentChallans.map((challan) => (
                      <Link
                        key={challan.id}
                        href={`/challan/${challan.id}`}
                        className="block hover:bg-gray-50 rounded-lg p-2 -mx-2"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-900">{challan.challanNo}</p>
                            <p className="text-xs text-gray-500">
                              {challan.transporterParty?.partyName || "—"}
                            </p>
                          </div>
                          <div className="text-right">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(challan.status)}`}>
                              {challan.status}
                            </span>
                            {challan.isSettled && (
                              <p className="text-xs text-purple-600 mt-1">Settled</p>
                            )}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {data.capabilities.canViewAccountingActivity && data.recentAccountingEntries && data.recentAccountingEntries.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm p-5">
                  <h3 className="text-sm font-medium text-gray-500 mb-3">Recent Accounting Entries</h3>
                  <div className="space-y-3">
                    {data.recentAccountingEntries.map((entry) => (
                      <Link
                        key={entry.id}
                        href={`/accounting-transactions/${entry.id}`}
                        className="block hover:bg-gray-50 rounded-lg p-2 -mx-2"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {entry.referenceType || "Journal Entry"}
                            </p>
                            <p className="text-xs text-gray-500">
                              {entry.description || entry.referenceId || entry.id}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs text-gray-500">
                              Dr: {formatCurrency(entry.totalDebit)}
                            </p>
                            <p className="text-xs text-gray-500">
                              Cr: {formatCurrency(entry.totalCredit)}
                            </p>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Quick Actions */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {data.capabilities.canViewBiltyStats && (
              <Link
                href="/bilty"
                className="bg-white border rounded-xl px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 text-center"
              >
                New Bilty
              </Link>
            )}
            {data.capabilities.canViewChallanStats && (
              <Link
                href="/challan"
                className="bg-white border rounded-xl px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 text-center"
              >
                New Challan
              </Link>
            )}
            {data.capabilities.canViewAccountingActivity && (
              <Link
                href="/daily-posting"
                className="bg-white border rounded-xl px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 text-center"
              >
                Daily Posting
              </Link>
            )}
            {data.capabilities.canViewFinancials && (
              <Link
                href="/reports/profit-loss"
                className="bg-white border rounded-xl px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 text-center"
              >
                Reports
              </Link>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
