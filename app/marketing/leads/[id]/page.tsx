"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Lead = {
  id: string;
  stage: string;
  source: string;
  followUpDate: string | null;
  notes: string | null;
  convertedBiltyId: string | null;
  convertedAt: string | null;
  contact: { id: string; name: string; phone: string };
  campaign: { id: string; name: string } | null;
};

const STAGES = ["NEW", "CONTACTED", "QUOTED", "BOOKED", "LOST"];

export default function MarketingLeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [leadId, setLeadId] = useState("");
  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [saving, setSaving] = useState(false);

  async function load(id: string) {
    try {
      const res = await fetch(`/api/marketing/leads/${id}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || "Unable to load lead");
        return;
      }
      setLead(json.lead);
      setNotes(json.lead.notes || "");
      setFollowUpDate(json.lead.followUpDate ? json.lead.followUpDate.slice(0, 10) : "");
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      const { id } = await params;
      setLeadId(id);
      await load(id);
    })();
  }, [params]);

  async function handleStageChange(stage: string) {
    await fetch(`/api/marketing/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
    load(leadId);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch(`/api/marketing/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes, followUpDate: followUpDate || null }),
      });
      load(leadId);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-gray-500">Loading...</p></main>;
  if (error || !lead) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-red-600">{error || "Lead not found"}</p></main>;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{lead.contact.name}</h1>
            <p className="text-gray-600">{lead.contact.phone}</p>
          </div>
          <Link href="/marketing/leads" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Back to Leads</Link>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <div className="grid grid-cols-2 gap-4 text-sm mb-4">
            <div><p className="text-gray-500">Source</p><p className="font-medium">{lead.source}</p></div>
            <div><p className="text-gray-500">Campaign</p><p className="font-medium">{lead.campaign?.name || "—"}</p></div>
            {lead.convertedBiltyId && (
              <div className="col-span-2">
                <p className="text-gray-500">Booked Bilty</p>
                <Link href={`/bilty/${lead.convertedBiltyId}`} className="text-blue-600 hover:underline font-medium">View Bilty</Link>
                {lead.convertedAt && <span className="text-xs text-gray-500 ml-2">on {new Date(lead.convertedAt).toLocaleDateString()}</span>}
              </div>
            )}
          </div>

          <div className="mb-4">
            <p className="text-gray-500 text-sm mb-1">Stage</p>
            <div className="flex gap-2">
              {STAGES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleStageChange(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs border ${lead.stage === s ? "bg-blue-600 text-white border-blue-600" : "bg-white hover:bg-gray-50"}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Follow-up Date</label>
              <input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="border rounded-lg px-3 py-2 text-sm w-full" />
            </div>
            <button type="submit" disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving..." : "Save"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
