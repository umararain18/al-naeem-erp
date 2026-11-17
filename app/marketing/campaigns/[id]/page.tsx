"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Campaign = { id: string; name: string; templateText: string; dailyLimit: number; segmentType: string };
type Stats = { sent: number; replied: number; leads: number; bookings: number; revenue: number; conversionRate: number; leadRate: number; total: number };
type Recipient = {
  id: string;
  status: string;
  sentAt: string | null;
  contact: { id: string; name: string; phone: string };
  lead: { id: string; stage: string } | null;
};
type QueueItem = { recipientId: string; contact: { id: string; name: string; phone: string }; message: string; waLink: string };

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export default function MarketingCampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tab, setTab] = useState<"QUEUE" | "SENT">("QUEUE");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(id: string) {
    try {
      const [detailRes, queueRes] = await Promise.all([
        fetch(`/api/marketing/campaigns/${id}`),
        fetch(`/api/marketing/campaigns/${id}/queue`),
      ]);
      const detailJson = await detailRes.json();
      const queueJson = await queueRes.json();
      if (!detailRes.ok || !detailJson.success) {
        setError(detailJson.message || "Unable to load campaign");
        return;
      }
      setCampaign(detailJson.campaign);
      setStats(detailJson.stats);
      setRecipients(detailJson.recipients);
      if (queueRes.ok && queueJson.success) setQueue(queueJson.items);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      const { id } = await params;
      setCampaignId(id);
      await load(id);
    })();
  }, [params]);

  async function handleMarkSent(recipientId: string) {
    const res = await fetch(`/api/marketing/campaigns/${campaignId}/recipients/${recipientId}/sent`, { method: "POST" });
    const json = await res.json();
    if (res.ok && json.success) load(campaignId);
  }

  async function handleStatus(recipientId: string, status: string) {
    const res = await fetch(`/api/marketing/campaigns/${campaignId}/recipients/${recipientId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const json = await res.json();
    if (res.ok && json.success) load(campaignId);
  }

  if (loading) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-gray-500">Loading...</p></main>;
  if (error || !campaign || !stats) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-red-600">{error || "Campaign not found"}</p></main>;

  const sentRecipients = recipients.filter((r) => r.status !== "QUEUED");

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{campaign.name}</h1>
            <p className="text-gray-600">{campaign.segmentType} · Daily limit {campaign.dailyLimit}</p>
          </div>
          <Link href="/marketing/campaigns" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Back to Campaigns</Link>
        </div>

        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
          {[
            ["Total", stats.total],
            ["Sent", stats.sent],
            ["Replied", stats.replied],
            ["Leads", stats.leads],
            ["Bookings", stats.bookings],
            ["Conversion %", `${stats.conversionRate.toFixed(1)}%`],
          ].map(([label, value]) => (
            <div key={label as string} className="bg-white rounded-xl shadow-sm p-4">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="text-lg font-bold">{value}</p>
            </div>
          ))}
        </div>
        <p className="text-sm text-gray-600 mb-6">Revenue from booked conversions: <span className="font-semibold">{formatCurrency(stats.revenue)}</span></p>

        <div className="flex gap-2 mb-4">
          <button type="button" onClick={() => setTab("QUEUE")} className={`px-3 py-1.5 rounded-lg text-sm border ${tab === "QUEUE" ? "bg-blue-600 text-white border-blue-600" : "bg-white hover:bg-gray-50"}`}>
            Today&apos;s Queue ({queue.length})
          </button>
          <button type="button" onClick={() => setTab("SENT")} className={`px-3 py-1.5 rounded-lg text-sm border ${tab === "SENT" ? "bg-blue-600 text-white border-blue-600" : "bg-white hover:bg-gray-50"}`}>
            Sent ({sentRecipients.length})
          </button>
        </div>

        {tab === "QUEUE" && (
          <div className="bg-white rounded-xl shadow-sm divide-y">
            {queue.length === 0 ? (
              <p className="p-6 text-gray-500 text-sm">No recipients queued right now (daily limit reached, or none left).</p>
            ) : (
              queue.map((item) => (
                <div key={item.recipientId} className="p-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">{item.contact.name} <span className="text-gray-500 text-sm">({item.contact.phone})</span></p>
                    <p className="text-sm text-gray-600">{item.message}</p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <a href={item.waLink} target="_blank" rel="noopener noreferrer" className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-700">
                      Open WhatsApp
                    </a>
                    <button type="button" onClick={() => handleMarkSent(item.recipientId)} className="border rounded-lg px-3 py-1.5 text-sm hover:bg-gray-50">
                      Mark Sent
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "SENT" && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Sent At</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sentRecipients.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/marketing/contacts/${r.contact.id}`} className="text-blue-600 hover:underline">{r.contact.name}</Link>
                      <span className="text-gray-500 text-xs"> ({r.contact.phone})</span>
                    </td>
                    <td className="px-4 py-3 text-xs">{r.status}{r.lead ? ` → Lead: ${r.lead.stage}` : ""}</td>
                    <td className="px-4 py-3">{r.sentAt ? new Date(r.sentAt).toLocaleString() : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 flex-wrap">
                        <button type="button" onClick={() => handleStatus(r.id, "REPLIED")} className="text-xs text-blue-600 hover:underline">Replied</button>
                        <button type="button" onClick={() => handleStatus(r.id, "LEAD")} className="text-xs text-blue-600 hover:underline">Lead</button>
                        <button type="button" onClick={() => handleStatus(r.id, "NOT_INTERESTED")} className="text-xs text-gray-500 hover:underline">Not interested</button>
                        <button type="button" onClick={() => handleStatus(r.id, "OPTED_OUT")} className="text-xs text-red-600 hover:underline">Opt-out</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {sentRecipients.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">Nothing sent yet</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
