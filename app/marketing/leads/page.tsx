"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Lead = {
  id: string;
  stage: string;
  source: string;
  followUpDate: string | null;
  notes: string | null;
  contact: { id: string; name: string; phone: string };
  campaign: { id: string; name: string } | null;
};

const STAGES = ["NEW", "CONTACTED", "QUOTED", "BOOKED", "LOST"];

export default function MarketingLeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [todayLeads, setTodayLeads] = useState<Lead[]>([]);
  const [showFollowUpsOnly, setShowFollowUpsOnly] = useState(false);
  const [stageFilter, setStageFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    try {
      const params = new URLSearchParams();
      if (stageFilter) params.set("stage", stageFilter);
      const [listRes, todayRes] = await Promise.all([
        fetch(`/api/marketing/leads?${params}`),
        fetch("/api/marketing/leads/today"),
      ]);
      const listJson = await listRes.json();
      const todayJson = await todayRes.json();
      if (!listRes.ok || !listJson.success) {
        setError(listJson.message || "Unable to load leads");
        return;
      }
      setLeads(listJson.leads);
      if (todayRes.ok && todayJson.success) setTodayLeads(todayJson.leads);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageFilter]);

  async function handleStageChange(id: string, stage: string) {
    const res = await fetch(`/api/marketing/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
    const json = await res.json();
    if (res.ok && json.success) load();
  }

  const displayed = showFollowUpsOnly ? todayLeads : leads;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Leads</h1>
            <p className="text-gray-600">Pipeline: New → Contacted → Quoted → Booked/Lost</p>
          </div>
          <Link href="/marketing" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Back to Marketing</Link>
        </div>

        {error && <p className="text-red-600 mb-4">{error}</p>}

        <div className="flex flex-wrap gap-2 mb-4">
          <button
            type="button"
            onClick={() => setShowFollowUpsOnly((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm border ${showFollowUpsOnly ? "bg-amber-500 text-white border-amber-500" : "bg-white hover:bg-gray-50"}`}
          >
            Today&apos;s Follow-ups ({todayLeads.length})
          </button>
          {!showFollowUpsOnly && (
            <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
              <option value="">All Stages</option>
              {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Campaign</th>
                <th className="px-4 py-3">Follow-up</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
              ) : displayed.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No leads</td></tr>
              ) : (
                displayed.map((l) => (
                  <tr key={l.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/marketing/leads/${l.id}`} className="text-blue-600 hover:underline font-medium">{l.contact.name}</Link>
                      <span className="text-gray-500 text-xs"> ({l.contact.phone})</span>
                    </td>
                    <td className="px-4 py-3">
                      <select value={l.stage} onChange={(e) => handleStageChange(l.id, e.target.value)} className="border rounded px-2 py-1 text-xs">
                        {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs">{l.source}</td>
                    <td className="px-4 py-3 text-xs">{l.campaign?.name || "—"}</td>
                    <td className="px-4 py-3 text-xs">{l.followUpDate ? new Date(l.followUpDate).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-3"><Link href={`/marketing/leads/${l.id}`} className="text-xs text-blue-600 hover:underline">View</Link></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
