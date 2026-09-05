"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type PayableEntry = {
  partyId: string;
  partyName: string;
  accountId: string;
  accountName: string;
  accountCode: string | null;
  totalDebit: number;
  totalCredit: number;
  balance: number;
};

type PayableResponse = {
  success: boolean;
  payable: PayableEntry[];
  summary: {
    totalPayable: number;
    partyCount: number;
  };
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

export default function PayablePage() {
  const [data, setData] = useState<PayableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const response = await fetch("/api/reports/payable");
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load payable report");
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
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-gray-500">Loading payable report...</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-red-600">{error || "Unable to load payable report"}</p>
          <Link href="/dashboard" className="mt-4 inline-block border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
            Back to Dashboard
          </Link>
        </div>
      </main>
    );
  }

  const { payable, summary } = data;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Payable Report</h1>
          <p className="text-gray-600">Parties with outstanding payables (Credit balance).</p>
        </div>

        {/* Summary */}
        <div className="bg-white rounded-xl shadow-sm p-5 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-500">Total Payable</p>
              <p className="text-2xl font-bold mt-1">{formatCurrency(summary.totalPayable)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Parties</p>
              <p className="text-2xl font-bold mt-1">{summary.partyCount}</p>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {payable.length === 0 ? (
            <div className="p-10 text-center text-gray-500">No payables found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Party</th>
                    <th className="px-4 py-3">Account</th>
                    <th className="px-4 py-3 text-right">Total Debit</th>
                    <th className="px-4 py-3 text-right">Total Credit</th>
                    <th className="px-4 py-3 text-right">Payable Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {payable.map((entry) => (
                    <tr key={entry.partyId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">
                        <Link href={`/parties/${entry.partyId}/ledger`} className="text-blue-600 hover:underline">
                          {entry.partyName}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {entry.accountCode ? `[${entry.accountCode}] ` : ""}
                        {entry.accountName}
                      </td>
                      <td className="px-4 py-3 text-right">{formatCurrency(entry.totalDebit)}</td>
                      <td className="px-4 py-3 text-right">{formatCurrency(entry.totalCredit)}</td>
                      <td className="px-4 py-3 text-right text-red-600 font-medium">
                        <Link href={`/parties/${entry.partyId}/ledger`} className="hover:underline">
                          {formatCurrency(entry.balance)}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-semibold">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-right">
                      Total Payable
                    </td>
                    <td className="px-4 py-3 text-right text-red-600">
                      {formatCurrency(summary.totalPayable)}
                    </td>
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
