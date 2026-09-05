"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  party: { id: string; partyName: string } | null;
};

type LedgerEntry = {
  id: string;
  journalEntryId: string;
  date: string;
  referenceType: string | null;
  referenceId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
};

type Summary = {
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
};

type LedgerResponse = {
  success: boolean;
  accounts: Account[];
  selectedAccount: Account | null;
  entries: LedgerEntry[];
  summary: Summary | null;
  filters: { from: string | null; to: string | null };
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

const REFERENCE_LABELS: Record<string, string> = {
  BILTY_BOOKING: "Bilty Booking",
  BILTY_BOOKING_CORRECTION: "Bilty Correction",
  CHALLAN_DISPATCH: "Challan Dispatch",
  CHALLAN_DISPATCH_CORRECTION: "Challan Correction",
  SETTLEMENT: "Settlement",
  SETTLEMENT_CORRECTION: "Settlement Correction",
  DAILY_POSTING: "Daily Posting",
  OPENING_BALANCE: "Opening Balance",
};

function friendlyReferenceLabel(referenceType: string | null) {
  if (!referenceType) return "Direct Entry";
  return REFERENCE_LABELS[referenceType] || referenceType;
}

// Reuses the existing accounting architecture only (JournalLine's
// own sourceType/sourceId, then the JournalEntry's referenceType/
// referenceId, then the generic Journal Entry viewer as a last
// resort) - see app/parties/[id]/ledger/page.tsx for the identical
// pattern used on the Party Ledger.
function resolveLedgerDestination(entry: LedgerEntry): { href: string; label: string } {
  const refLabel = friendlyReferenceLabel(entry.referenceType);

  if (entry.sourceType === "CHALLAN" && entry.sourceId) {
    return { href: `/challan/${entry.sourceId}`, label: `${refLabel} - Challan ${entry.sourceNumber || entry.sourceId}` };
  }
  if (entry.sourceType === "BILTY" && entry.sourceId) {
    return { href: `/bilty/${entry.sourceId}`, label: `${refLabel} - Bilty ${entry.sourceNumber || entry.sourceId}` };
  }

  if (
    (entry.referenceType === "BILTY_BOOKING" || entry.referenceType === "BILTY_BOOKING_CORRECTION") &&
    entry.referenceId
  ) {
    return { href: `/bilty/${entry.referenceId}`, label: refLabel };
  }
  if (
    (entry.referenceType === "CHALLAN_DISPATCH" ||
      entry.referenceType === "CHALLAN_DISPATCH_CORRECTION" ||
      entry.referenceType === "SETTLEMENT" ||
      entry.referenceType === "SETTLEMENT_CORRECTION") &&
    entry.referenceId
  ) {
    return { href: `/challan/${entry.referenceId}`, label: refLabel };
  }

  return { href: `/accounting-transactions/${entry.journalEntryId}`, label: refLabel };
}

export default function LedgerPage() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // A drill-down link (e.g. a P&L account row) may deep-link
  // straight to an account via ?accountId=.
  const [accountId, setAccountId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("accountId") || "";
  });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const query = new URLSearchParams();
        if (accountId) query.set("accountId", accountId);
        if (from) query.set("from", from);
        if (to) query.set("to", to);
        if (search) query.set("search", search);

        const response = await fetch(`/api/ledger?${query.toString()}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load ledger");
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
  }, [accountId, from, to, search]);

  const selectedAccount = data?.selectedAccount || null;
  const entries = data?.entries || [];
  const summary = data?.summary || null;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">General Ledger</h1>
          <p className="text-gray-600">Account-wise transaction history.</p>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Select Account</option>
              {data?.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.accountCode ? `[${account.accountCode}] ` : ""}
                  {account.accountName}
                  {account.party ? ` (${account.party.partyName})` : ""}
                </option>
              ))}
            </select>
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
            <input
              type="text"
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => {
                setAccountId("");
                setFrom("");
                setTo("");
                setSearch("");
              }}
              className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
            >
              Reset
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        {selectedAccount && (
          <>
            {/* Account Info */}
            <div className="bg-white rounded-xl shadow-sm p-5 mb-6">
              <h2 className="text-lg font-semibold mb-2">Account Details</h2>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Name:</span>{" "}
                  <span className="font-medium">{selectedAccount.accountName}</span>
                </div>
                <div>
                  <span className="text-gray-500">Code:</span>{" "}
                  <span className="font-medium">{selectedAccount.accountCode || "—"}</span>
                </div>
                <div>
                  <span className="text-gray-500">Type:</span>{" "}
                  <span className="font-medium">{selectedAccount.accountType}</span>
                </div>
                <div>
                  <span className="text-gray-500">Category:</span>{" "}
                  <span className="font-medium">{selectedAccount.category}</span>
                </div>
              </div>
            </div>

            {/* Summary */}
            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-white rounded-xl p-5 shadow-sm">
                  <p className="text-sm text-gray-500">Opening Balance</p>
                  <p className="text-xl font-bold mt-1">{formatCurrency(summary.openingBalance)}</p>
                </div>
                <div className="bg-white rounded-xl p-5 shadow-sm">
                  <p className="text-sm text-gray-500">Total Debit</p>
                  <p className="text-xl font-bold mt-1">{formatCurrency(summary.totalDebit)}</p>
                </div>
                <div className="bg-white rounded-xl p-5 shadow-sm">
                  <p className="text-sm text-gray-500">Total Credit</p>
                  <p className="text-xl font-bold mt-1">{formatCurrency(summary.totalCredit)}</p>
                </div>
                <div className="bg-white rounded-xl p-5 shadow-sm">
                  <p className="text-sm text-gray-500">Closing Balance</p>
                  <p className="text-xl font-bold mt-1">{formatCurrency(summary.closingBalance)}</p>
                </div>
              </div>
            )}
          </>
        )}

        {/* Ledger Table */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-gray-500">Loading ledger...</div>
          ) : !selectedAccount ? (
            <div className="p-10 text-center text-gray-500">Select an account to view transactions.</div>
          ) : entries.length === 0 ? (
            <div className="p-10 text-center text-gray-500">No accounting transactions found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Reference</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entries.map((entry) => {
                    const destination = resolveLedgerDestination(entry);

                    return (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">{formatDate(entry.date)}</td>
                        <td className="px-4 py-3">
                          <Link href={destination.href} className="text-blue-600 hover:underline" title="View source document">
                            {destination.label}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{entry.description || "—"}</td>
                        <td className="px-4 py-3 text-right">
                          {entry.debit > 0 ? formatCurrency(entry.debit) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {entry.credit > 0 ? formatCurrency(entry.credit) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {formatCurrency(entry.balance)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
