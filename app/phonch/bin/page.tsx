"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

type BinnedPhonch = {
  id: string;
  phonchNo: string;
  date: string;
  carrierNumber: string | null;
  transporterParty: { id: string; partyName: string };
  vehicleCount: number;
  deletedAt: string | null;
  deletedBy: { fullName: string; username: string } | null;
};

export default function PhonchBinPage() {
  const [phonches, setPhonches] = useState<BinnedPhonch[]>([]);
  const [capabilities, setCapabilities] = useState({ canRestore: false, canPermanentlyDelete: false });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BinnedPhonch | null>(null);
  const [confirmation, setConfirmation] = useState("");

  async function loadBin() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch(`/api/phonch/bin?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load the Phonch Bin");
      setPhonches(data.phonches || []);
      setCapabilities(data.capabilities || { canRestore: false, canPermanentlyDelete: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the Phonch Bin");
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
    if (!window.confirm("Restore this Phonch?")) return;
    try {
      setActionId(id);
      setError("");
      const res = await fetch(`/api/phonch/${id}/restore`, { method: "POST" });
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
      const res = await fetch(`/api/phonch/${deleteTarget.id}`, {
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
          <Link href="/phonch" className="text-xs text-gray-500 hover:underline">
            ← Back to Phonch
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">Bin — Phonch</h1>
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
            placeholder="Search Phonch No, Carrier No..."
            className="w-72 rounded-lg border px-3 py-1.5 text-sm"
          />
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border bg-white shadow-sm">
          {loading ? (
            <div className="p-10 text-center text-sm text-gray-500">Loading...</div>
          ) : phonches.length === 0 ? (
            <div className="p-10 text-center text-sm text-gray-500">No binned Phonch records found.</div>
          ) : (
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Phonch No</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Transporter</th>
                  <th className="px-4 py-3">Vehicles</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {phonches.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{p.phonchNo}</td>
                    <td className="px-4 py-3">{formatDate(p.date)}</td>
                    <td className="px-4 py-3">{p.transporterParty.partyName}</td>
                    <td className="px-4 py-3">{p.vehicleCount}</td>
                    <td className="px-4 py-3">
                      <div>{formatDate(p.deletedAt)}</div>
                      <div className="text-xs text-gray-500">
                        {p.deletedBy ? `${p.deletedBy.fullName} (${p.deletedBy.username})` : "Unknown user"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {capabilities.canRestore && (
                          <button
                            type="button"
                            disabled={actionId === p.id}
                            onClick={() => void restore(p.id)}
                            className="rounded border border-green-200 px-3 py-1.5 text-xs text-green-700 disabled:opacity-50"
                          >
                            Restore
                          </button>
                        )}
                        {capabilities.canPermanentlyDelete && (
                          <button
                            type="button"
                            onClick={() => { setDeleteTarget(p); setConfirmation(""); }}
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
                <h2 className="font-semibold text-red-700">Permanently delete Phonch</h2>
                <p className="mt-1 text-sm text-gray-500">This permanently deletes this Phonch and cannot be undone.</p>
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
                <button
                  type="button"
                  onClick={() => { setDeleteTarget(null); setConfirmation(""); }}
                  className="rounded border px-4 py-2 text-sm"
                >
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
