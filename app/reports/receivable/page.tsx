"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LedgerFilters } from "@/components/LedgerFilters";

type ReceivableEntry = {
  partyId: string | null;
  partyName: string;
  accountId: string;
  accountName: string;
  accountCode: string | null;
  totalDebit: number;
  totalCredit: number;
  balance: number;
  // true only for the shared system BILL-WALKIN-RECEIVABLE row - it has
  // no Party (partyId null), so it renders as plain text instead of a
  // Party Ledger link.
  isSystemAccount?: boolean;
  phone: string | null;
};

type ReceivableResponse = {
  success: boolean;
  receivable: ReceivableEntry[];
  summary: {
    totalReceivable: number;
    partyCount: number;
  };
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

export default function ReceivablePage() {
  const [data, setData] = useState<ReceivableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Search is client-side (the same small, already-fully-fetched list
  // every render - no server round-trip needed, unlike a transaction
  // ledger). "to" is the one date filter genuinely meaningful for a
  // point-in-time Receivable balance (an "as of" date, reusing
  // getReceivablePayable's existing asOfExclusive parameter - never a
  // new calculation); "from" has no defined meaning for a closing
  // balance and is kept only so the shared LedgerFilters component's
  // controlled inputs render consistently with every other ledger
  // screen - it is never sent to the API.
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const query = to ? `?to=${encodeURIComponent(to)}` : "";
        const response = await fetch(`/api/reports/receivable${query}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load receivable report");
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

  const filteredReceivable = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.receivable;
    return data.receivable.filter((entry) => {
      return (
        entry.partyName.toLowerCase().includes(q) ||
        entry.accountName.toLowerCase().includes(q) ||
        (entry.accountCode || "").toLowerCase().includes(q) ||
        (entry.phone || "").toLowerCase().includes(q)
      );
    });
  }, [data, search]);

  const filteredTotal = useMemo(
    () => filteredReceivable.reduce((sum, entry) => sum + entry.balance, 0),
    [filteredReceivable]
  );

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-gray-500">Loading receivable report...</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-red-600">{error || "Unable to load receivable report"}</p>
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
          <h1 className="text-2xl font-bold">Receivable Report</h1>
          <p className="text-gray-600">Parties with outstanding receivables (Debit balance).</p>
        </div>

        {/* Summary */}
        <div className="bg-white rounded-xl shadow-sm p-5 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-500">Total Receivable</p>
              <p className="text-2xl font-bold mt-1">{formatCurrency(summary.totalReceivable)}</p>
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
              ? `${filteredReceivable.length} of ${data.receivable.length} found, ${formatCurrency(filteredTotal)}`
              : null
          }
          searchPlaceholder="Search party, account, or phone..."
        />

        {/* Table */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {filteredReceivable.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              {isFiltered ? "No matching receivables found." : "No receivables found."}
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
                    <th className="px-4 py-3 text-right">Receivable Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredReceivable.map((entry) => (
                    <tr key={entry.partyId ?? entry.accountId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">
                        {entry.partyId ? (
                          <Link href={`/parties/${entry.partyId}/ledger`} className="text-blue-600 hover:underline">
                            {entry.partyName}
                          </Link>
                        ) : (
                          <span className="text-gray-700">
                            {entry.partyName}
                            <span className="ml-1.5 text-xs font-normal text-gray-400">(system account)</span>
                          </span>
                        )}
                        {entry.phone && <span className="block text-xs text-gray-400">{entry.phone}</span>}
                      </td>
                      <td className="px-4 py-3">
                        {entry.accountCode ? `[${entry.accountCode}] ` : ""}
                        {entry.accountName}
                      </td>
                      <td className="px-4 py-3 text-right">{formatCurrency(entry.totalDebit)}</td>
                      <td className="px-4 py-3 text-right">{formatCurrency(entry.totalCredit)}</td>
                      <td className="px-4 py-3 text-right text-green-600 font-medium">
                        {entry.partyId ? (
                          <Link href={`/parties/${entry.partyId}/ledger`} className="hover:underline">
                            {formatCurrency(entry.balance)}
                          </Link>
                        ) : (
                          formatCurrency(entry.balance)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-semibold">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-right">
                      Total{isFiltered ? " (filtered)" : ""}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600">
                      {formatCurrency(isFiltered ? filteredTotal : summary.totalReceivable)}
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
