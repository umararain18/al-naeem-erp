"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type SavedSegment = {
  id: string;
  name: string;
  filterJson: {
    roles?: string[];
    city?: string;
    route?: string;
    lastActivityWithinDays?: number;
    minRevenue?: number;
    includeBrokers?: boolean;
    includeParty?: boolean;
  };
};

const ROLE_OPTIONS = ["SENDER", "RECEIVER", "BILL_CLIENT", "PARTY"];

export default function MarketingSegmentsPage() {
  const [savedSegments, setSavedSegments] = useState<SavedSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [city, setCity] = useState("");
  const [route, setRoute] = useState("");
  const [lastActivityWithinDays, setLastActivityWithinDays] = useState("");
  const [minRevenue, setMinRevenue] = useState("");
  const [includeBrokers, setIncludeBrokers] = useState(false);
  const [includeParty, setIncludeParty] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/marketing/saved-segments");
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || "Unable to load");
        return;
      }
      setSavedSegments(json.savedSegments);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toggleRole(role: string) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const filter: SavedSegment["filterJson"] = {};
      if (roles.length > 0) filter.roles = roles;
      if (city) filter.city = city;
      if (route) filter.route = route;
      if (lastActivityWithinDays) filter.lastActivityWithinDays = Number(lastActivityWithinDays);
      if (minRevenue) filter.minRevenue = Number(minRevenue);
      if (includeBrokers) filter.includeBrokers = true;
      if (includeParty) filter.includeParty = true;

      const res = await fetch("/api/marketing/saved-segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, filter }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || "Unable to create");
        return;
      }
      setName("");
      setRoles([]);
      setCity("");
      setRoute("");
      setLastActivityWithinDays("");
      setMinRevenue("");
      setIncludeBrokers(false);
      setIncludeParty(false);
      load();
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/marketing/saved-segments/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (res.ok && json.success) load();
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Custom Segments</h1>
            <p className="text-gray-600">Saved filters for use in campaigns</p>
          </div>
          <Link href="/marketing" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Back to Marketing</Link>
        </div>

        {error && <p className="text-red-600 mb-4">{error}</p>}

        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">New Saved Segment</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              <input type="text" required value={name} onChange={(e) => setName(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Roles (any of)</label>
              <div className="flex gap-3">
                {ROLE_OPTIONS.map((r) => (
                  <label key={r} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} /> {r}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">City</label>
                <input type="text" value={city} onChange={(e) => setCity(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Route (e.g. Karachi -&gt; Lahore)</label>
                <input type="text" value={route} onChange={(e) => setRoute(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Last active within (days)</label>
                <input type="number" min="1" value={lastActivityWithinDays} onChange={(e) => setLastActivityWithinDays(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Minimum revenue</label>
                <input type="number" min="0" value={minRevenue} onChange={(e) => setMinRevenue(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
              </div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={includeBrokers} onChange={(e) => setIncludeBrokers(e.target.checked)} /> Include Brokers</label>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={includeParty} onChange={(e) => setIncludeParty(e.target.checked)} /> Include Parties</label>
            </div>
            <button type="submit" disabled={creating} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
              {creating ? "Creating..." : "Create Segment"}
            </button>
          </form>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Saved Segments</h2>
          {loading ? (
            <p className="text-gray-500">Loading...</p>
          ) : savedSegments.length === 0 ? (
            <p className="text-gray-500 text-sm">No saved segments yet.</p>
          ) : (
            <div className="divide-y">
              {savedSegments.map((s) => (
                <div key={s.id} className="py-3 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-gray-500">{JSON.stringify(s.filterJson)}</p>
                  </div>
                  <button type="button" onClick={() => handleDelete(s.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
