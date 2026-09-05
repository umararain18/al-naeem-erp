"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type ItemType = "BILTY" | "CHALLAN" | "JOURNAL_ENTRY" | "DAILY_POSTING";

type BinItem = {
  type: ItemType;
  id: string;
  reference: string;
  title: string;
  deletedAt: string;
  deletedBy: { id: string; fullName: string; username: string } | null;
  moduleUrl: string;
  capabilities: {
    canRestore: boolean;
    canPermanentlyDelete: boolean;
  };
};

type Capabilities = {
  canRestoreBilty: boolean;
  canPermanentlyDeleteBilty: boolean;
  canRestoreChallan: boolean;
  canPermanentlyDeleteChallan: boolean;
  canRestoreJournalEntry: boolean;
  canPermanentlyDeleteJournalEntry: boolean;
};

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

export default function BinPage() {
  const [items, setItems] = useState<BinItem[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    canRestoreBilty: false,
    canPermanentlyDeleteBilty: false,
    canRestoreChallan: false,
    canPermanentlyDeleteChallan: false,
    canRestoreJournalEntry: false,
    canPermanentlyDeleteJournalEntry: false,
  });
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<BinItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BinItem | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (typeFilter !== "ALL") params.set("type", typeFilter);
    if (search.trim()) params.set("search", search.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [typeFilter, search, from, to]);

  async function loadBin() {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`/api/bin?${query}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to load Bin");
      }
      setItems(data.items || []);
      setCapabilities(data.capabilities || {
        canRestoreBilty: false,
        canPermanentlyDeleteBilty: false,
        canRestoreChallan: false,
        canPermanentlyDeleteChallan: false,
        canRestoreJournalEntry: false,
        canPermanentlyDeleteJournalEntry: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Bin");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBin();
    }, 0);

    return () => window.clearTimeout(timer);
    // Search runs when the user explicitly selects Search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function restoreItem(item: BinItem) {
    if (!window.confirm(`Restore this ${item.type.replace("_", " ")}?`)) return;
    try {
      setActionId(item.id);
      setError("");
      let restoreUrl = "";
      if (item.type === "BILTY") {
        restoreUrl = `/api/bilty/${item.id}/restore`;
      } else if (item.type === "CHALLAN") {
        restoreUrl = `/api/challan/${item.id}/restore`;
      } else {
        restoreUrl = `/api/accounting-transactions/${item.id}/restore`;
      }

      const response = await fetch(restoreUrl, { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Unable to restore");
      setMessage(data.message);
      setSelected(null);
      await loadBin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore");
    } finally {
      setActionId(null);
    }
  }

  async function permanentlyDeleteItem() {
    if (!deleteTarget) return;
    try {
      setActionId(deleteTarget.id);
      setError("");
      let deleteUrl = "";
      if (deleteTarget.type === "BILTY") {
        deleteUrl = `/api/bilty/${deleteTarget.id}`;
      } else if (deleteTarget.type === "CHALLAN") {
        deleteUrl = `/api/challan/${deleteTarget.id}`;
      } else {
        deleteUrl = `/api/accounting-transactions/${deleteTarget.id}`;
      }

      const response = await fetch(deleteUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Unable to permanently delete");
      setMessage(data.message);
      setDeleteTarget(null);
      setConfirmation("");
      await loadBin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to permanently delete");
    } finally {
      setActionId(null);
    }
  }

  const getTypeLabel = (type: ItemType) => {
    switch (type) {
      case "BILTY":
        return "Bilty";
      case "CHALLAN":
        return "Challan";
      case "DAILY_POSTING":
        return "Daily Posting";
      case "JOURNAL_ENTRY":
        return "Journal Entry";
    }
  };

  const canRestore = (item: BinItem) => {
    if (item.type === "BILTY") return capabilities.canRestoreBilty;
    if (item.type === "CHALLAN") return capabilities.canRestoreChallan;
    return capabilities.canRestoreJournalEntry;
  };

  const canPermanentlyDelete = (item: BinItem) => {
    if (item.type === "BILTY") return capabilities.canPermanentlyDeleteBilty;
    if (item.type === "CHALLAN") return capabilities.canPermanentlyDeleteChallan;
    return capabilities.canPermanentlyDeleteJournalEntry;
  };

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Bin</h1>
          <p className="mt-1 text-sm text-gray-500">
            Deleted records from across the ERP
          </p>
        </div>

        {(error || message) && (
          <div
            className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
              error
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {error || message}
          </div>
        )}

        <div className="grid gap-4 rounded-xl border bg-white p-5 shadow-sm md:grid-cols-4">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
          >
            <option value="ALL">All</option>
            <option value="BILTY">Bilty</option>
            <option value="CHALLAN">Challan</option>
            <option value="DAILY_POSTING">Daily Posting</option>
            <option value="JOURNAL_ENTRY">Journal Entries</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reference, details..."
            className="rounded-lg border px-3 py-2 text-sm md:col-span-2"
          />
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <div className="md:col-span-4 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setTypeFilter("ALL");
                setSearch("");
                setFrom("");
                setTo("");
              }}
              className="rounded-lg border px-4 py-2 text-sm"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => loadBin()}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Search
            </button>
          </div>
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          {loading ? (
            <div className="p-10 text-center text-sm text-gray-500">Loading Bin...</div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-sm text-gray-500">No deleted records found.</div>
          ) : (
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Details</th>
                  <th className="px-4 py-3">Deleted By</th>
                  <th className="px-4 py-3">Deleted At</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((item) => (
                  <tr key={`${item.type}-${item.id}`} className="align-top hover:bg-gray-50">
                    <td className="px-4 py-4">
                      <span className="rounded bg-gray-100 px-2 py-1 text-xs font-medium">
                        {getTypeLabel(item.type)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{item.reference}</div>
                    </td>
                    <td className="px-4 py-4">{item.title}</td>
                    <td className="px-4 py-4">
                      <div>{item.deletedBy?.fullName || "—"}</div>
                      <div className="text-xs text-gray-500">{item.deletedBy?.username || ""}</div>
                    </td>
                    <td className="px-4 py-4">{formatDate(item.deletedAt)}</td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        <Link
                          href={item.moduleUrl}
                          className="rounded border px-3 py-1.5 text-xs hover:bg-gray-50"
                        >
                          View
                        </Link>
                        {canRestore(item) && (
                          <button
                            type="button"
                            disabled={actionId === item.id}
                            onClick={() => {
                              setSelected(item);
                            }}
                            className="rounded border border-green-200 px-3 py-1.5 text-xs text-green-700 disabled:opacity-50"
                          >
                            Restore
                          </button>
                        )}
                        {canPermanentlyDelete(item) && (
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteTarget(item);
                              setConfirmation("");
                            }}
                            className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700"
                          >
                            Permanent Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-xl">
              <div className="flex items-center justify-between border-b px-6 py-4">
                <div>
                  <h2 className="font-semibold">Restore {getTypeLabel(selected.type)}</h2>
                  <p className="text-xs text-gray-500">{selected.reference}</p>
                </div>
                <button type="button" onClick={() => setSelected(null)} className="text-xl">
                  ×
                </button>
              </div>
              <div className="space-y-4 p-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Reference</span>
                    <p className="font-medium">{selected.reference}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Deleted At</span>
                    <p>{formatDate(selected.deletedAt)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Deleted By</span>
                    <p>{selected.deletedBy ? `${selected.deletedBy.fullName} (${selected.deletedBy.username})` : "Unknown user"}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Details</span>
                    <p>{selected.title}</p>
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 border-t p-4">
                <button type="button" onClick={() => setSelected(null)} className="rounded border px-4 py-2 text-sm">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={actionId === selected.id}
                  onClick={() => void restoreItem(selected)}
                  className="rounded bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  Restore
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
              <div className="border-b px-6 py-4">
                <h2 className="font-semibold text-red-700">Permanently delete {getTypeLabel(deleteTarget.type)}</h2>
                <p className="mt-1 text-sm text-gray-500">
                  This permanently deletes this record and cannot be undone.
                </p>
              </div>
              <div className="space-y-4 p-6">
                <label className="block text-sm">
                  Type <strong>DELETE</strong> to confirm.
                  <input
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    className="mt-2 w-full rounded border px-3 py-2"
                  />
                </label>
              </div>
              <div className="flex justify-end gap-3 border-t p-4">
                <button
                  type="button"
                  onClick={() => {
                    setDeleteTarget(null);
                    setConfirmation("");
                  }}
                  className="rounded border px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={confirmation !== "DELETE" || actionId === deleteTarget.id}
                  onClick={() => void permanentlyDeleteItem()}
                  className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  Permanently Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
