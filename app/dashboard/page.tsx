"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Financials = {
  receivable: number;
  payable: number;
  cashBalance: number;
  bankBalance: number;
  monthlyIncome: number;
  monthlyExpense: number;
  monthlyProfit: number;
};

type NamedAccount = { id: string; accountName: string };
type DateRange = { from: string; to: string };

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

type DashboardData = {
  success: boolean;
  capabilities: {
    canViewFinancials: boolean;
    canViewBiltyStats: boolean;
    canViewChallanStats: boolean;
    canViewAccountingActivity: boolean;
  };
  financials?: Financials;
  cashAccounts?: NamedAccount[];
  bankAccounts?: NamedAccount[];
  monthlyRange?: DateRange;
  biltyStats?: BiltyStats;
  challanStats?: ChallanStats;
  recentBilties?: RecentBilty[];
  recentChallans?: RecentChallan[];
  recentAccountingEntries?: RecentEntry[];
  recentDailyPostings?: RecentEntry[];
};

function formatCurrency(value: number | undefined | null) {
  const safeValue = typeof value === "number" && !Number.isNaN(value) ? value : 0;
  return `Rs. ${safeValue.toLocaleString()}`;
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString();
}

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

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const response = await fetch("/api/dashboard");
        const result = await response.json();
        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load dashboard");
          return;
        }
        setData(result);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

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

  const today = new Date().toLocaleDateString("en-PK", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">{today}</p>
        </div>

        {/* Financial Overview */}
        {data.capabilities.canViewFinancials && data.financials && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Financial Overview</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Link href="/reports/receivable" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                <p className="text-sm text-gray-500">Receivable</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{formatCurrency(data.financials.receivable)}</p>
              </Link>
              <Link href="/reports/payable" className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
                <p className="text-sm text-gray-500">Payable</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{formatCurrency(data.financials.payable)}</p>
              </Link>
              <Link
                href={
                  data.cashAccounts?.length === 1
                    ? `/cash-book?accountId=${data.cashAccounts[0].id}`
                    : "/cash-book"
                }
                className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <p className="text-sm text-gray-500">Cash</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{formatCurrency(data.financials.cashBalance)}</p>
              </Link>
              <Link
                href={
                  data.bankAccounts?.length === 1
                    ? `/cash-book?accountId=${data.bankAccounts[0].id}`
                    : "/cash-book"
                }
                className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <p className="text-sm text-gray-500">Bank</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{formatCurrency(data.financials.bankBalance)}</p>
              </Link>
            </div>

            <div className="grid grid-cols-3 gap-4 mt-4">
              <Link
                href={`/reports/profit-loss${data.monthlyRange ? `?from=${data.monthlyRange.from}&to=${data.monthlyRange.to}` : ""}`}
                className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <p className="text-sm text-gray-500">Monthly Income</p>
                <p className="text-xl font-bold text-green-600 mt-1">{formatCurrency(data.financials.monthlyIncome)}</p>
              </Link>
              <Link
                href={`/reports/profit-loss${data.monthlyRange ? `?from=${data.monthlyRange.from}&to=${data.monthlyRange.to}` : ""}`}
                className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <p className="text-sm text-gray-500">Monthly Expense</p>
                <p className="text-xl font-bold text-red-600 mt-1">{formatCurrency(data.financials.monthlyExpense)}</p>
              </Link>
              <Link
                href={`/reports/profit-loss${data.monthlyRange ? `?from=${data.monthlyRange.from}&to=${data.monthlyRange.to}` : ""}`}
                className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <p className="text-sm text-gray-500">Monthly Profit</p>
                <p className={`text-xl font-bold mt-1 ${data.financials.monthlyProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {formatCurrency(data.financials.monthlyProfit)}
                </p>
              </Link>
            </div>
          </section>
        )}

        {/* Operations */}
        {(data.capabilities.canViewBiltyStats || data.capabilities.canViewChallanStats) && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Operations</h2>
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
