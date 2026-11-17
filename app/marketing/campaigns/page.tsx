"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type SavedSegment = { id: string; name: string };

type Campaign = {
  id: string;
  name: string;
  segmentType: string;
  dailyLimit: number;
  isActive: boolean;
  recipientCount: number;
  statusCounts: Record<string, number>;
  createdAt: string;
};

const SEGMENT_OPTIONS = ["ACTIVE", "SLEEPING", "LOST", "ONE_TIME", "VIP", "ROUTE", "BROKER", "PARTY", "SAVED", "ALL"];

export default function MarketingCampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [savedSegments, setSavedSegments] = useState<SavedSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [templateText, setTemplateText] = useState("Hi {name}, we haven't heard from you since {lastDate}. Let us know if you need a carrier for {city}!");
  const [dailyLimit, setDailyLimit] = useState("50");
  const [segmentType, setSegmentType] = useState("ACTIVE");
  const [route, setRoute] = useState("");
  const [savedSegmentId, setSavedSegmentId] = useState("");

  async function load() {
    try {
      const [cRes, sRes] = await Promise.all([fetch("/api/marketing/campaigns"), fetch("/api/marketing/saved-segments")]);
      const cJson = await cRes.json();
      const sJson = await sRes.json();
      if (!cRes.ok || !cJson.success) {
        setError(cJson.message || "Unable to load campaigns");
        return;
      }
      setCampaigns(cJson.campaigns);
      if (sRes.ok && sJson.success) setSavedSegments(sJson.savedSegments);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const segmentParams =
        segmentType === "ROUTE" ? { route } : segmentType === "SAVED" ? { savedSegmentId } : null;

      const res = await fetch("/api/marketing/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, templateText, dailyLimit: Number(dailyLimit), segmentType, segmentParams }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || "Unable to create campaign");
        return;
      }
      setName("");
      load();
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Campaigns</h1>
            <p className="text-gray-600">Manual WhatsApp outreach, segmented and rate-limited</p>
          </div>
          <Link href="/marketing" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Back to Marketing</Link>
        </div>

        {error && <p className="text-red-600 mb-4">{error}</p>}

        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">New Campaign</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              <input type="text" required value={name} onChange={(e) => setName(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Template ({"{name} {city} {vehicle} {lastDate} {role} {direction}"})</label>
              <textarea required value={templateText} onChange={(e) => setTemplateText(e.target.value)} rows={3} className="border rounded-lg px-3 py-2 text-sm w-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Daily Limit</label>
                <input type="number" min="1" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Segment</label>
                <select value={segmentType} onChange={(e) => setSegmentType(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full">
                  {SEGMENT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            {segmentType === "ROUTE" && (
              <div>
                <label className="block text-sm text-gray-600 mb-1">Route (e.g. Karachi -&gt; Lahore)</label>
                <input type="text" required value={route} onChange={(e) => setRoute(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full" />
              </div>
            )}
            {segmentType === "SAVED" && (
              <div>
                <label className="block text-sm text-gray-600 mb-1">Saved Segment</label>
                <select required value={savedSegmentId} onChange={(e) => setSavedSegmentId(e.target.value)} className="border rounded-lg px-3 py-2 text-sm w-full">
                  <option value="">Select...</option>
                  {savedSegments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            <button type="submit" disabled={creating} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
              {creating ? "Creating..." : "Create Campaign"}
            </button>
          </form>
        </div>

        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Segment</th>
                <th className="px-4 py-3 text-right">Recipients</th>
                <th className="px-4 py-3 text-right">Sent</th>
                <th className="px-4 py-3 text-right">Daily Limit</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
              ) : campaigns.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No campaigns yet</td></tr>
              ) : (
                campaigns.map((c) => {
                  const sentCount = Object.entries(c.statusCounts).filter(([k]) => k !== "QUEUED").reduce((s, [, v]) => s + v, 0);
                  return (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3"><Link href={`/marketing/campaigns/${c.id}`} className="text-blue-600 hover:underline font-medium">{c.name}</Link></td>
                      <td className="px-4 py-3 text-xs">{c.segmentType}</td>
                      <td className="px-4 py-3 text-right">{c.recipientCount}</td>
                      <td className="px-4 py-3 text-right">{sentCount}</td>
                      <td className="px-4 py-3 text-right">{c.dailyLimit}</td>
                      <td className="px-4 py-3">{new Date(c.createdAt).toLocaleDateString()}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
