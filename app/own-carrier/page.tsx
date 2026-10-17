"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Carrier = {
  id: string;
  carrierNumber: string;
  driverName: string | null;
  driverPhone: string | null;
  isActive: boolean;
  isDeleted: boolean;
  _count: { slips: number };
};

export default function OwnCarrierPage() {
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"ACTIVE" | "INACTIVE" | "BINNED" | "">("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ carrierNumber: "", driverName: "", driverPhone: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    const res = await fetch(`/api/own-carriers?${params.toString()}`);
    const json = await res.json();
    if (json.success) setCarriers(json.carriers);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch("/api/own-carriers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    setSaving(false);
    if (!json.success) {
      setError(json.message || "Failed to create carrier");
      return;
    }
    setShowAdd(false);
    setForm({ carrierNumber: "", driverName: "", driverPhone: "", notes: "" });
    load();
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-gray-500">Fleet Management</div>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">Own Carrier Register</h1>
          <p className="text-sm text-gray-500 mt-1">Carrier trips, driver cash, return loads and outstanding payments.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
        >
          + Add Carrier
        </button>
      </div>

      <div className="flex gap-3 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Search carrier / driver"
          className="flex-1 max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">All active/inactive</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="BINNED">Binned</option>
        </select>
        <button type="button" onClick={load} className="rounded-md border border-gray-300 px-4 py-2 text-sm">
          Search
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : carriers.length === 0 ? (
        <div className="text-sm text-gray-500 border border-dashed rounded-md p-8 text-center">No carriers found.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {carriers.map((c) => (
            <Link
              key={c.id}
              href={c.isDeleted ? "#" : `/own-carrier/${c.id}`}
              className={`block rounded-lg border border-gray-200 bg-white p-4 shadow-sm ${c.isDeleted ? "opacity-60 pointer-events-none" : "hover:border-gray-400"}`}
            >
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-semibold text-gray-900">{c.carrierNumber}</h3>
                  <div className="text-xs text-gray-500 mt-0.5">Driver: {c.driverName || "—"}</div>
                </div>
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    c.isDeleted ? "bg-red-100 text-red-700" : c.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {c.isDeleted ? "Binned" : c.isActive ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
                Trip slips: <b className="text-gray-800">{c._count.slips}</b>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={handleAdd} className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold mb-4">Add Carrier</h2>
            {error && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm p-2">{error}</div>}
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Carrier / Vehicle Number *</label>
                <input
                  required
                  value={form.carrierNumber}
                  onChange={(e) => setForm({ ...form, carrierNumber: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="e.g. KHI-4521"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Driver Name</label>
                <input
                  value={form.driverName}
                  onChange={(e) => setForm({ ...form, driverName: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Driver Phone</label>
                <input
                  value={form.driverPhone}
                  onChange={(e) => setForm({ ...form, driverPhone: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  rows={2}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setShowAdd(false)} className="rounded-md border border-gray-300 px-4 py-2 text-sm">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving ? "Saving..." : "Save Carrier"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
