"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type TrialBalanceEntry = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  debit: number;
  credit: number;
};

type Summary = {
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
};

type TrialBalanceResponse = {
  success: boolean;
  trialBalance: TrialBalanceEntry[];
  summary: Summary;
  filters: { asOfDate: string | null };
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

export default function TrialBalancePage() {
  const [data, setData] = useState<TrialBalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [asOfDate, setAsOfDate] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const query = new URLSearchParams();
        if (asOfDate) query.set("asOfDate", asOfDate);

        const response = await fetch(`/api/reports/trial-balance?${query.toString()}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load trial balance");
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
  }, [asOfDate]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-gray-500">Loading trial balance...</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-red-600">{error || "Unable to load trial balance"}</p>
          <Link href="/dashboard" className="mt-4 inline-block border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
            Back to Dashboard
          </Link>
        </div>
      </main>
    );
  }

  const { trialBalance, summary } = data;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Trial Balance</h1>
          <p className="text-gray-600">
            {data.filters.asOfDate
              ? `As of ${new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "Asia/Karachi" }).format(new Date(data.filters.asOfDate))}`
              : "All periods"}
          </p>
        </div>

        {/* Warning */}
        {!summary.isBalanced && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Warning: Trial Balance is not balanced. Total Debit (Rs. {summary.totalDebit.toLocaleString()}) does not equal Total Credit (Rs. {summary.totalCredit.toLocaleString()}).
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <div className="md:col-span-2 flex justify-end">
              <button
                type="button"
                onClick={() => setAsOfDate("")}
                className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {trialBalance.length === 0 ? (
            <div className="p-10 text-center text-gray-500">No accounting transactions found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Account Code</th>
                    <th className="px-4 py-3">Account Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {trialBalance.map((entry) => (
                    <tr key={entry.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">{entry.accountCode || "—"}</td>
                      <td className="px-4 py-3 font-medium">{entry.accountName}</td>
                      <td className="px-4 py-3">{entry.accountType}</td>
                      <td className="px-4 py-3">{entry.category}</td>
                      <td className="px-4 py-3 text-right">
                        {entry.debit > 0 ? formatCurrency(entry.debit) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {entry.credit > 0 ? formatCurrency(entry.credit) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-semibold">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-right">
                      Total
                    </td>
                    <td className="px-4 py-3 text-right">{formatCurrency(summary.totalDebit)}</td>
                    <td className="px-4 py-3 text-right">{formatCurrency(summary.totalCredit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
