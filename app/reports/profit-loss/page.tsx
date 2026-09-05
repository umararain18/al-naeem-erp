"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type PnLAccount = {
  id: string;
  accountName: string;
  accountCode: string | null;
  category: string;
  amount: number;
};

type Summary = {
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
};

type ProfitLossResponse = {
  success: boolean;
  income: PnLAccount[];
  expenses: PnLAccount[];
  summary: Summary;
  filters: { from: string | null; to: string | null };
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

export default function ProfitLossPage() {
  const [data, setData] = useState<ProfitLossResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Preserve the date range a drill-down link (e.g. Dashboard's
  // "Monthly Income/Expense/Profit") was computed with, instead of
  // silently falling back to all-time. Read directly from the
  // browser URL rather than next/navigation's useSearchParams,
  // since this only needs to run once on initial mount.
  const initialParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;

  const [from, setFrom] = useState(initialParams?.get("from") || "");
  const [to, setTo] = useState(initialParams?.get("to") || "");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const query = new URLSearchParams();
        if (from) query.set("from", from);
        if (to) query.set("to", to);

        const response = await fetch(`/api/reports/profit-loss?${query.toString()}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load profit and loss");
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
  }, [from, to]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-gray-500">Loading profit and loss...</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-red-600">{error || "Unable to load profit and loss"}</p>
          <Link href="/dashboard" className="mt-4 inline-block border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
            Back to Dashboard
          </Link>
        </div>
      </main>
    );
  }

  const { income, expenses, summary } = data;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Profit & Loss</h1>
          <p className="text-gray-600">
            {data.filters.from || data.filters.to
              ? `${data.filters.from ? `From ${data.filters.from}` : ""} ${data.filters.to ? `To ${data.filters.to}` : ""}`
              : "All periods"}
          </p>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <div className="md:col-span-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setFrom("");
                  setTo("");
                }}
                className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Income */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">Income</h2>
            </div>
            {income.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">No income accounts found.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-3">Account</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {income.map((entry) => (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Link href={`/ledger?accountId=${entry.id}`} className="text-blue-600 hover:underline">
                            {entry.accountCode ? `[${entry.accountCode}] ` : ""}
                            {entry.accountName}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{entry.category}</td>
                        <td className="px-4 py-3 text-right">
                          <Link href={`/ledger?accountId=${entry.id}`} className="hover:underline">
                            {formatCurrency(entry.amount)}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr>
                      <td colSpan={2} className="px-4 py-3 text-right">
                        Total Income
                      </td>
                      <td className="px-4 py-3 text-right">{formatCurrency(summary.totalIncome)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Expenses */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">Expenses</h2>
            </div>
            {expenses.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">No expense accounts found.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-3">Account</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {expenses.map((entry) => (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Link href={`/ledger?accountId=${entry.id}`} className="text-blue-600 hover:underline">
                            {entry.accountCode ? `[${entry.accountCode}] ` : ""}
                            {entry.accountName}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{entry.category}</td>
                        <td className="px-4 py-3 text-right">
                          <Link href={`/ledger?accountId=${entry.id}`} className="hover:underline">
                            {formatCurrency(entry.amount)}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr>
                      <td colSpan={2} className="px-4 py-3 text-right">
                        Total Expenses
                      </td>
                      <td className="px-4 py-3 text-right">{formatCurrency(summary.totalExpenses)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Net Profit */}
        <div className="mt-6 bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Net Profit / Loss</h2>
            <p className={`text-2xl font-bold ${summary.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
              {formatCurrency(Math.abs(summary.netProfit))}
              {summary.netProfit < 0 ? " Loss" : " Profit"}
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
