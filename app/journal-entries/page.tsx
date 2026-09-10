"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// ============================================================
// MANUAL JOURNAL ENTRY REGISTER
//
// Newest -> oldest (matches every other normal ERP list screen's
// established Rule A ordering this session). Only active
// (non-deleted) MANUAL_JOURNAL entries - binned ones live in the
// existing, unmodified /bin page instead.
// ============================================================

type JournalEntryItem = {
  id: string;
  manualJournalNo: string | null;
  date: string;
  narration: string | null;
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
  createdBy: { id: string; fullName: string; username: string } | null;
  canBin: boolean;
  binProtectedReason: string | null;
};

type Capabilities = { canCreate: boolean; canEdit: boolean; canBin: boolean };

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Karachi" }).format(new Date(iso));
}

export default function JournalEntriesPage() {
  const [items, setItems] = useState<JournalEntryItem[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({ canCreate: false, canEdit: false, canBin: false });
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (from) params.set("from", from);
      if (to) params.set("to", to);

      const response = await fetch(`/api/journal-entries?${params.toString()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to load journal entries");
      }
      setItems(data.items || []);
      setCapabilities(data.capabilities || { canCreate: false, canEdit: false, canBin: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load journal entries");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  // Same confirmation wording already used for every other Move-to-
  // Bin action in the app (Cash Book, Daily Posting Register) - no
  // new UI pattern.
  async function handleMoveToBin(item: JournalEntryItem) {
    const confirmed = window.confirm(
      "Move this complete Journal Entry to Bin?\n\nAll of its journal lines will be excluded from normal accounting. This is not permanent deletion."
    );
    if (!confirmed) return;
    try {
      setError("");
      const response = await fetch(`/api/journal-entries/${item.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to move transaction to Bin.");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move transaction to Bin.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Journal Entries</h1>
            <p className="mt-1 text-sm text-gray-500">Manual accounting journal entries, newest first.</p>
          </div>
          {capabilities.canCreate && (
            <Link
              href="/journal-entries/new"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 text-center"
            >
              + New Journal Entry
            </Link>
          )}
        </div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-600">Search (Narration / Manual Journal No.)</label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Date From</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Date To</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setFrom("");
                setTo("");
                load();
              }}
              className="rounded-lg border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={load}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Search
            </button>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-xl border bg-white shadow-sm">
          {loading ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">Loading journal entries...</div>
          ) : items.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">No journal entries found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Manual Journal No.</th>
                    <th className="px-4 py-3">Narration</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-600">{formatDate(item.date)}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{item.manualJournalNo || "—"}</td>
                      <td className="px-4 py-3 text-gray-600">{item.narration || "—"}</td>
                      <td className="px-4 py-3 text-right">Rs. {formatMoney(item.totalDebit)}</td>
                      <td className="px-4 py-3 text-right">Rs. {formatMoney(item.totalCredit)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            item.isBalanced ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                          }`}
                        >
                          {item.isBalanced ? "Balanced" : "Not Balanced"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Link href={`/accounting-transactions/${item.id}`} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
                            View
                          </Link>
                          {capabilities.canEdit && (
                            <Link
                              href={`/journal-entries/${item.id}/edit`}
                              className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                            >
                              Edit
                            </Link>
                          )}
                          {item.canBin ? (
                            <button
                              type="button"
                              onClick={() => handleMoveToBin(item)}
                              className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              Move to Bin
                            </button>
                          ) : capabilities.canBin && item.binProtectedReason ? (
                            <span className="px-1 py-1.5 text-xs text-gray-500" title={item.binProtectedReason}>
                              {item.binProtectedReason}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
