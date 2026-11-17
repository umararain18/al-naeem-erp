"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ContactRole = "SENDER" | "RECEIVER" | "BILL_CLIENT" | "PARTY";

type Contact = {
  id: string;
  phone: string;
  name: string;
  roles: ContactRole[];
  city: string | null;
  route: string | null;
  lastDate: string;
  biltyCount: number;
  revenue: number;
  lastVehicle: string | null;
  linkedParty: { id: string; partyName: string } | null;
  isBroker: boolean;
  optedOut: boolean;
  sourceless: boolean;
  isVip: boolean;
};

type InvalidRow = { source: string; sourceId: string; name: string; rawPhone: string | null; date: string };

const TABS = [
  { key: "ALL", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "SLEEPING", label: "Sleeping" },
  { key: "LOST", label: "Lost" },
  { key: "ONE_TIME", label: "One-time" },
  { key: "VIP", label: "VIP" },
  { key: "BROKER", label: "Brokers" },
  { key: "PARTY", label: "Parties" },
  { key: "INVALID", label: "Invalid Numbers" },
] as const;

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export default function MarketingContactsPage() {
  const [tab, setTab] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [invalidRows, setInvalidRows] = useState<InvalidRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      if (tab === "INVALID") {
        const res = await fetch("/api/marketing/contacts/invalid");
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.message || "Unable to load");
          return;
        }
        setInvalidRows(json.invalid);
      } else {
        const params = new URLSearchParams({ segment: tab });
        if (search) params.set("search", search);
        const res = await fetch(`/api/marketing/contacts?${params}`);
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.message || "Unable to load");
          return;
        }
        setContacts(json.contacts);
      }
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    load();
  }

  function toggleSelect(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleMerge() {
    if (selected.length !== 2) {
      setError("Select exactly 2 contacts to merge");
      return;
    }
    const [primaryId, secondaryId] = selected;
    const res = await fetch("/api/marketing/contacts/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primaryId, secondaryId }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      setError(json.message || "Unable to merge");
      return;
    }
    setMessage("Contacts merged");
    setSelected([]);
    load();
  }

  async function handleOptOut(id: string, optedOut: boolean) {
    const res = await fetch(`/api/marketing/contacts/${id}/opt-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optedOut }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      setError(json.message || "Unable to update");
      return;
    }
    load();
  }

  async function handleRefreshNow() {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch("/api/marketing/contacts/refresh", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || "Unable to refresh");
        return;
      }
      setMessage(json.message);
      load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <div className="mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Marketing Contacts</h1>
            <p className="text-gray-600">Built from Bilty senders/receivers, Bill clients and Parties</p>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={handleRefreshNow} disabled={refreshing} className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50">
              {refreshing ? "Refreshing..." : "Refresh Now"}
            </button>
            <a href="/api/marketing/contacts/export/excel" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Export Excel</a>
            <a href="/api/marketing/contacts/export/google-csv" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Export Google CSV</a>
          </div>
        </div>

        {error && <p className="text-red-600 mb-4">{error}</p>}
        {message && <p className="text-green-600 mb-4">{message}</p>}

        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${tab === t.key ? "bg-blue-600 text-white border-blue-600" : "bg-white hover:bg-gray-50"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab !== "INVALID" && (
          <form onSubmit={handleSearch} className="flex gap-2 mb-4">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or phone..."
              className="border rounded-lg px-3 py-2 text-sm w-64"
            />
            <button type="submit" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Search</button>
            {selected.length > 0 && (
              <button type="button" onClick={handleMerge} className="border rounded-lg px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700">
                Merge Selected ({selected.length})
              </button>
            )}
          </form>
        )}

        {loading && <p className="text-gray-500">Loading...</p>}

        {!loading && tab === "INVALID" && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Raw Phone</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {invalidRows.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-xs">{r.source}</td>
                    <td className="px-4 py-3">{r.name}</td>
                    <td className="px-4 py-3 text-gray-500">{r.rawPhone || "—"}</td>
                    <td className="px-4 py-3">{new Date(r.date).toLocaleDateString()}</td>
                  </tr>
                ))}
                {invalidRows.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No invalid phone numbers found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && tab !== "INVALID" && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3"></th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Roles</th>
                  <th className="px-4 py-3">City / Route</th>
                  <th className="px-4 py-3 text-right">Bilties</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                  <th className="px-4 py-3">Last Vehicle</th>
                  <th className="px-4 py-3">Last Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {contacts.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggleSelect(c.id)} />
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/marketing/contacts/${c.id}`} className="text-blue-600 hover:underline font-medium">{c.name}</Link>
                      {c.linkedParty && <p className="text-xs text-gray-500">Party: {c.linkedParty.partyName}</p>}
                    </td>
                    <td className="px-4 py-3">{c.phone}</td>
                    <td className="px-4 py-3 text-xs">{c.roles.join(", ")}</td>
                    <td className="px-4 py-3 text-xs">{c.city || "—"}{c.route ? ` (${c.route})` : ""}</td>
                    <td className="px-4 py-3 text-right">{c.biltyCount}</td>
                    <td className="px-4 py-3 text-right">{formatCurrency(c.revenue)}</td>
                    <td className="px-4 py-3">{c.lastVehicle || "—"}</td>
                    <td className="px-4 py-3">{new Date(c.lastDate).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.isVip && <span className="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700">VIP</span>}
                        {c.isBroker && <span className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-700">Broker</span>}
                        {c.optedOut && <span className="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">Opted Out</span>}
                        {c.sourceless && <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">No Source</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => handleOptOut(c.id, !c.optedOut)}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        {c.optedOut ? "Re-enable" : "Opt-out"}
                      </button>
                    </td>
                  </tr>
                ))}
                {contacts.length === 0 && (
                  <tr><td colSpan={11} className="px-4 py-6 text-center text-gray-500">No contacts in this segment</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
