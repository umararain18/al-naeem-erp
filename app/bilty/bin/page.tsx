"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Bilty = {
  id: string;
  biltyNo: string;
  date: string;
  fromLocation: { id: string; name: string };
  toLocation: { id: string; name: string };
  consignorParty: { id: string; partyName: string } | null;
  consigneeParty: { id: string; partyName: string } | null;
  clearingAgentParty: { id: string; partyName: string } | null;
  agentParty: { id: string; partyName: string } | null;
  deletedAt: string | null;
  deletedBy: { id: string; fullName: string; username: string } | null;
};

type Capabilities = {
  canRestore: boolean;
  canPermanentlyDelete: boolean;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

export default function BiltyBinPage() {
  const [bilties, setBilties] = useState<Bilty[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    canRestore: false,
    canPermanentlyDelete: false,
  });
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Bilty | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bilty | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [from, search, to]);

  async function loadBin() {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`/api/bilty/bin?${query}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to load the Bilty Bin");
      }
      setBilties(data.bilties || []);
      setCapabilities(data.capabilities || {
        canRestore: false,
        canPermanentlyDelete: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the Bilty Bin");
      setBilties([]);
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

  async function restoreBilty(bilty: Bilty) {
    if (!window.confirm("Restore this Bilty?")) return;
    try {
      setActionId(bilty.id);
      setError("");
      const response = await fetch(
        `/api/bilty/${bilty.id}/restore`,
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Unable to restore bilty");
      setMessage(data.message);
      setSelected(null);
      await loadBin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore bilty");
    } finally {
      setActionId(null);
    }
  }

  async function permanentlyDeleteBilty() {
    if (!deleteTarget) return;
    try {
      setActionId(deleteTarget.id);
      setError("");
      const response = await fetch(`/api/bilty/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Unable to permanently delete bilty");
      setMessage(data.message);
      setDeleteTarget(null);
      setConfirmation("");
      await loadBin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to permanently delete bilty");
    } finally {
      setActionId(null);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Bin — Bilties</h1>
          <p className="mt-1 text-sm text-gray-500">
            This category currently contains binned Bilties. They are excluded from normal Bilty list until restored.
          </p>
        </div>

        {(error || message) && (
          <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${error ? "border-red-200 bg-red-50 text-red-700" : "border-green-200 bg-green-50 text-green-700"}`}>
            {error || message}
          </div>
        )}

        <div className="grid gap-4 rounded-xl border bg-white p-5 shadow-sm md:grid-cols-4">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search bilty no, consignor, consignee..." className="rounded-lg border px-3 py-2 text-sm md:col-span-2" />
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="rounded-lg border px-3 py-2 text-sm" />
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="rounded-lg border px-3 py-2 text-sm" />
          <div className="md:col-span-4 flex justify-end gap-3">
            <button type="button" onClick={() => { setSearch(""); setFrom(""); setTo(""); }} className="rounded-lg border px-4 py-2 text-sm">Reset</button>
            <button type="button" onClick={() => { setSearch(""); setFrom(""); setTo(""); void loadBin(); }} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">Search</button>
          </div>
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          {loading ? <div className="p-10 text-center text-sm text-gray-500">Loading Bin...</div> : bilties.length === 0 ? <div className="p-10 text-center text-sm text-gray-500">No binned bilties found.</div> : (
            <table className="min-w-[1150px] w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Bilty No</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Route</th>
                  <th className="px-4 py-3">Consignor</th>
                  <th className="px-4 py-3">Consignee</th>
                  <th className="px-4 py-3">Clearing Agent</th>
                  <th className="px-4 py-3">Agent / Referral</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bilties.map((bilty) => (
                  <tr key={bilty.id} className="align-top hover:bg-gray-50">
                    <td className="px-4 py-4">
                      <div className="font-medium">{bilty.biltyNo}</div>
                    </td>
                    <td className="px-4 py-4">{formatDate(bilty.date)}</td>
                    <td className="px-4 py-4">{bilty.fromLocation.name} → {bilty.toLocation.name}</td>
                    <td className="px-4 py-4">{bilty.consignorParty?.partyName || "—"}</td>
                    <td className="px-4 py-4">{bilty.consigneeParty?.partyName || "—"}</td>
                    <td className="px-4 py-4">{bilty.clearingAgentParty?.partyName || "—"}</td>
                    <td className="px-4 py-4">{bilty.agentParty?.partyName || "—"}</td>
                    <td className="px-4 py-4">
                      <div>{formatDate(bilty.deletedAt)}</div>
                      <div className="mt-1 text-xs text-gray-500">{bilty.deletedBy ? `${bilty.deletedBy.fullName} (${bilty.deletedBy.username})` : "Unknown user"}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setSelected(bilty)} className="rounded border px-3 py-1.5 text-xs">View</button>
                        {capabilities.canRestore && (
                          <button
                            type="button"
                            disabled={actionId === bilty.id}
                            onClick={() => void restoreBilty(bilty)}
                            className="rounded border border-green-200 px-3 py-1.5 text-xs text-green-700 disabled:opacity-50"
                          >
                            Restore
                          </button>
                        )}
                        {capabilities.canPermanentlyDelete && (
                          <button
                            type="button"
                            onClick={() => { setDeleteTarget(bilty); setConfirmation(""); }}
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
                  <h2 className="font-semibold">Binned Bilty</h2>
                  <p className="text-xs text-gray-500">{selected.id}</p>
                </div>
                <button type="button" onClick={() => setSelected(null)} className="text-xl">×</button>
              </div>
              <div className="space-y-4 p-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Bilty No</span>
                    <p className="font-medium">{selected.biltyNo}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Date</span>
                    <p>{formatDate(selected.date)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Route</span>
                    <p>{selected.fromLocation.name} → {selected.toLocation.name}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Deleted date</span>
                    <p>{formatDate(selected.deletedAt)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Deleted by</span>
                    <p>{selected.deletedBy ? `${selected.deletedBy.fullName} (${selected.deletedBy.username})` : "Unknown user"}</p>
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 border-t p-4">
                <button type="button" onClick={() => setSelected(null)} className="rounded border px-4 py-2 text-sm">Close</button>
                {capabilities.canRestore && (
                  <button
                    type="button"
                    disabled={actionId === selected.id}
                    onClick={() => void restoreBilty(selected)}
                    className="rounded bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
              <div className="border-b px-6 py-4">
                <h2 className="font-semibold text-red-700">Permanently delete Bilty</h2>
                <p className="mt-1 text-sm text-gray-500">This permanently deletes this bilty and cannot be undone.</p>
              </div>
              <div className="space-y-4 p-6">
                <label className="block text-sm">Type <strong>DELETE</strong> to confirm.<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 w-full rounded border px-3 py-2" /></label>
              </div>
              <div className="flex justify-end gap-3 border-t p-4">
                <button type="button" onClick={() => { setDeleteTarget(null); setConfirmation(""); }} className="rounded border px-4 py-2 text-sm">Cancel</button>
                <button
                  type="button"
                  disabled={confirmation !== "DELETE" || actionId === deleteTarget.id}
                  onClick={() => void permanentlyDeleteBilty()}
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
