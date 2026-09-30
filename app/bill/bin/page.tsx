"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Mirrors app/private-phonch/bin/page.tsx exactly.

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

type BinnedBill = {
  id: string;
  billNo: string;
  date: string;
  clientParty: { id: string; partyName: string } | null;
  clientName: string;
  vehicleCount: number;
  deletedAt: string | null;
  deletedBy: { fullName: string; username: string } | null;
};

export default function BillBinPage() {
  const [bills, setBills] = useState<BinnedBill[]>([]);
  const [capabilities, setCapabilities] = useState({ canRestore: false, canPermanentlyDelete: false });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BinnedBill | null>(null);
  const [confirmation, setConfirmation] = useState("");

  async function loadBin() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch(`/api/bill/bin?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load the Bill Bin");
      setBills(data.bills || []);
      setCapabilities(data.capabilities || { canRestore: false, canPermanentlyDelete: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the Bill Bin");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadBin(), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function restore(id: string) {
    if (!window.confirm("Restore this Bill?")) return;
    try {
      setActionId(id);
      setError("");
      const res = await fetch(`/api/bill/${id}/restore`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to restore");
      setMessage(data.message);
      await loadBin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore");
    } finally {
      setActionId(null);
    }
  }

  async function permanentlyDelete() {
    if (!deleteTarget) return;
    try {
      setActionId(deleteTarget.id);
      setError("");
      const res = await fetch(`/api/bill/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to permanently delete");
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

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <Link href="/bill" className="text-xs text-gray-500 hover:underline">
            ← Back to Bill Book
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">Bin — Bill Book</h1>
        </div>

        {(error || message) && (
          <div
            className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
              error ? "border-red-200 bg-red-50 text-red-700" : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {error || message}
          </div>
        )}

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Bill No..."
            className="w-72 rounded-lg border px-3 py-1.5 text-sm"
          />
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border bg-white shadow-sm">
          {loading ? (
            <div className="p-10 text-center text-sm text-gray-500">Loading...</div>
          ) : bills.length === 0 ? (
            <div className="p-10 text-center text-sm text-gray-500">No binned Bill records found.</div>
          ) : (
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Bill No</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Vehicles</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bills.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{b.billNo}</td>
                    <td className="px-4 py-3">{formatDate(b.date)}</td>
                    <td className="px-4 py-3">{b.clientName}</td>
                    <td className="px-4 py-3">{b.vehicleCount}</td>
                    <td className="px-4 py-3">
                      <div>{formatDate(b.deletedAt)}</div>
                      <div className="text-xs text-gray-500">{b.deletedBy ? `${b.deletedBy.fullName} (${b.deletedBy.username})` : "Unknown user"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {capabilities.canRestore && (
                          <button
                            type="button"
                            disabled={actionId === b.id}
                            onClick={() => void restore(b.id)}
                            className="rounded border border-green-200 px-3 py-1.5 text-xs text-green-700 disabled:opacity-50"
                          >
                            Restore
                          </button>
                        )}
                        {capabilities.canPermanentlyDelete && (
                          <button
                            type="button"
                            onClick={() => { setDeleteTarget(b); setConfirmation(""); }}
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

        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
              <div className="border-b px-6 py-4">
                <h2 className="font-semibold text-red-700">Permanently delete Bill</h2>
                <p className="mt-1 text-sm text-gray-500">This permanently deletes this Bill and cannot be undone.</p>
              </div>
              <div className="space-y-4 p-6">
                <label className="block text-sm">
                  Type <strong>DELETE</strong> to confirm.
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    className="mt-2 w-full rounded border px-3 py-2"
                  />
                </label>
              </div>
              <div className="flex justify-end gap-3 border-t p-4">
                <button type="button" onClick={() => { setDeleteTarget(null); setConfirmation(""); }} className="rounded border px-4 py-2 text-sm">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={confirmation !== "DELETE" || actionId === deleteTarget.id}
                  onClick={() => void permanentlyDelete()}
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
