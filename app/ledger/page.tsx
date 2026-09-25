"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SearchableSelect, type SearchOption } from "@/app/daily-posting/SearchableSelect";
import { LedgerFilters } from "@/components/LedgerFilters";

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  party: { id: string; partyName: string } | null;
};

type LedgerHistoryItem = {
  date: string;
  referenceType: string | null;
  description: string;
  debit: number;
  credit: number;
};

// Matches lib/ledger-description.ts's FinalLedgerRow - the same
// business-readable, duplicate-collapsing row shape Party Ledger
// already uses, now shared by General Ledger for ANY account (see
// getAccountLedgerData()).
type LedgerEntry = {
  id: string;
  date: string;
  reference: string;
  referenceHref: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  balanceType: "RECEIVABLE" | "PAYABLE" | "SETTLED";
  isGrouped: boolean;
  isRemoved: boolean;
  history: LedgerHistoryItem[];
};

type Summary = {
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  balanceType?: "RECEIVABLE" | "PAYABLE" | "SETTLED";
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
  return `Rs. ${Math.round(value).toLocaleString()}`;
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

export default function LedgerPage() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // A drill-down link (e.g. a P&L account row) may deep-link
  // straight to an account via ?accountId=.
  const [accountId, setAccountId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("accountId") || "";
  });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  // Every active account is fetched ONCE (no accountId/date params) so
  // the account picker can filter instantly client-side - the same
  // dataset the dropdown always loaded, just no longer re-fetched from
  // the server on every keystroke.
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    async function loadAccounts() {
      try {
        const response = await fetch(`/api/ledger`);
        const result = await response.json();
        if (response.ok && result.success) setAccounts(result.accounts || []);
      } catch {
        // silent - the ledger fetch below will surface the real error state
      }
    }
    loadAccounts();
  }, []);

  useEffect(() => {
    async function load() {
      try {
        setError("");
        setLoading(true);
        const query = new URLSearchParams();
        if (accountId) query.set("accountId", accountId);
        if (from) query.set("from", from);
        if (to) query.set("to", to);
        if (search.trim()) query.set("q", search.trim());

        const response = await fetch(`/api/ledger?${query.toString()}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load ledger");
          return;
        }

        setData(result);
        setExpanded(new Set());
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [accountId, from, to, search]);

  const accountOptions: SearchOption[] = useMemo(
    () =>
      accounts.map((a) => ({
        value: a.id,
        label: `${a.accountCode ? `[${a.accountCode}] ` : ""}${a.accountName}`,
        secondary: a.party ? `Party: ${a.party.partyName}` : `${a.accountType} · ${a.category}`,
      })),
    [accounts]
  );

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedAccount = data?.selectedAccount || null;
  const entries = data?.entries || [];
  const summary = data?.summary || null;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">General Ledger</h1>
          <p className="text-gray-600">Search any account and view its ledger for any period.</p>
        </div>

        <LedgerFilters
          search={search}
          onSearchChange={setSearch}
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
          onReset={() => {
            setAccountId("");
            setFrom("");
            setTo("");
            setSearch("");
          }}
          resultLabel={
            data
              ? entries.length === 0
                ? "No transactions found"
                : `${entries.length} transaction${entries.length === 1 ? "" : "s"} found`
              : null
          }
          extra={
            <div className="mb-3">
              <SearchableSelect
                value={accountId}
                options={accountOptions}
                placeholder="Search account name or code..."
                onChange={setAccountId}
              />
            </div>
          }
        />

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
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entries.map((entry) => {
                    const isExpanded = expanded.has(entry.id);
                    const hasHistory = entry.history.length > 1 || entry.isRemoved;

                    return (
                      <Fragment key={entry.id}>
                        <tr className="hover:bg-gray-50">
                          <td className="px-4 py-3">{formatDate(entry.date)}</td>
                          <td className="px-4 py-3">
                            {entry.referenceHref ? (
                              <Link href={entry.referenceHref} className="text-blue-600 hover:underline" title="View source document">
                                {entry.reference}
                              </Link>
                            ) : (
                              entry.reference
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {entry.description || "—"}
                            {entry.isRemoved && <span className="ml-2 text-xs text-gray-400 italic">(removed)</span>}
                          </td>
                          <td className="px-4 py-3 text-right">{entry.debit > 0 ? formatCurrency(entry.debit) : "—"}</td>
                          <td className="px-4 py-3 text-right">{entry.credit > 0 ? formatCurrency(entry.credit) : "—"}</td>
                          <td className="px-4 py-3 text-right">
                            <span
                              className={
                                entry.balanceType === "RECEIVABLE"
                                  ? "text-green-600"
                                  : entry.balanceType === "PAYABLE"
                                    ? "text-red-600"
                                    : ""
                              }
                            >
                              {formatCurrency(entry.balance)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {hasHistory && (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(entry.id)}
                                className="text-xs border rounded-lg px-2 py-1 hover:bg-gray-50 text-gray-600"
                              >
                                {isExpanded ? "Hide details" : "View details"}
                              </button>
                            )}
                          </td>
                        </tr>
                        {isExpanded && hasHistory && (
                          <tr className="bg-gray-50">
                            <td colSpan={7} className="px-4 py-3">
                              <div className="text-xs text-gray-500 mb-2">
                                Underlying accounting entries ({entry.history.length}{" "}
                                {entry.history.length === 1 ? "entry" : "entries"}):
                              </div>
                              <table className="w-full text-xs border rounded-lg overflow-hidden">
                                <thead className="bg-white text-gray-500">
                                  <tr>
                                    <th className="px-3 py-2 text-left">Date</th>
                                    <th className="px-3 py-2 text-left">Type</th>
                                    <th className="px-3 py-2 text-left">Description</th>
                                    <th className="px-3 py-2 text-right">Debit</th>
                                    <th className="px-3 py-2 text-right">Credit</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y bg-white">
                                  {entry.history.map((h, i) => (
                                    <tr key={i}>
                                      <td className="px-3 py-2">{formatDate(h.date)}</td>
                                      <td className="px-3 py-2 text-gray-500">{h.referenceType || "Direct Entry"}</td>
                                      <td className="px-3 py-2">{h.description}</td>
                                      <td className="px-3 py-2 text-right">{h.debit > 0 ? formatCurrency(h.debit) : "—"}</td>
                                      <td className="px-3 py-2 text-right">{h.credit > 0 ? formatCurrency(h.credit) : "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
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
