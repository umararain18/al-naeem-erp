"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LedgerFilters } from "@/components/LedgerFilters";

type PayableEntry = {
  partyId: string;
  partyName: string;
  accountId: string;
  accountName: string;
  accountCode: string | null;
  totalDebit: number;
  totalCredit: number;
  balance: number;
  // An inactive Party only ever appears here when its balance is
  // genuinely non-zero - see lib/receivable-payable.ts.
  isActive: boolean;
  phone: string | null;
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

  // See the identical comment on app/reports/receivable/page.tsx -
  // client-side search over the already-fetched list; "to" is the
  // one date filter meaningful for a point-in-time Payable balance
  // (an "as of" date, reusing the existing asOfExclusive parameter);
  // "from" is kept only for the shared LedgerFilters component's
  // controlled-input shape and is never sent to the API.
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const query = to ? `?to=${encodeURIComponent(to)}` : "";
        const response = await fetch(`/api/reports/payable${query}`);
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
  }, [to]);

  const filteredPayable = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.payable;
    return data.payable.filter((entry) => {
      return (
        entry.partyName.toLowerCase().includes(q) ||
        entry.accountName.toLowerCase().includes(q) ||
        (entry.accountCode || "").toLowerCase().includes(q) ||
        (entry.phone || "").toLowerCase().includes(q)
      );
    });
  }, [data, search]);

  const filteredTotal = useMemo(
    () => filteredPayable.reduce((sum, entry) => sum + entry.balance, 0),
    [filteredPayable]
  );

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

  const { summary } = data;
  const isFiltered = search.trim().length > 0;

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

        <LedgerFilters
          search={search}
          onSearchChange={setSearch}
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
          onReset={() => {
            setSearch("");
            setFrom("");
            setTo("");
          }}
          resultLabel={
            isFiltered
              ? `${filteredPayable.length} of ${data.payable.length} found, ${formatCurrency(filteredTotal)}`
              : null
          }
          searchPlaceholder="Search party, account, or phone..."
        />

        {/* Table */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {filteredPayable.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              {isFiltered ? "No matching payables found." : "No payables found."}
            </div>
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
                  {filteredPayable.map((entry) => (
                    <tr key={entry.partyId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">
                        <Link href={`/parties/${entry.partyId}/ledger`} className="text-blue-600 hover:underline">
                          {entry.partyName}
                        </Link>
                        {!entry.isActive && <span className="ml-1.5 text-xs font-normal text-gray-400">(Inactive)</span>}
                        {entry.phone && <span className="block text-xs text-gray-400">{entry.phone}</span>}
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
                      Total{isFiltered ? " (filtered)" : ""}
                    </td>
                    <td className="px-4 py-3 text-right text-red-600">
                      {formatCurrency(isFiltered ? filteredTotal : summary.totalPayable)}
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
