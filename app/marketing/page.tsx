"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type CampaignStat = {
  id: string;
  name: string;
  sent: number;
  replied: number;
  leads: number;
  bookings: number;
  revenue: number;
  conversionRate: number;
};

type DashboardData = {
  totals: { totalContacts: number; activeLeads: number; followUpsDue: number };
  campaigns: CampaignStat[];
};

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export default function MarketingDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/marketing/dashboard");
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.message || "Unable to load dashboard");
          return;
        }
        setData(json);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <div className="mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Marketing</h1>
            <p className="text-gray-600">Contacts, segments, campaigns and leads</p>
          </div>
          <div className="flex gap-3">
            <Link href="/marketing/contacts" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Contacts</Link>
            <Link href="/marketing/campaigns" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Campaigns</Link>
            <Link href="/marketing/leads" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Leads</Link>
            <Link href="/marketing/segments" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Segments</Link>
            <Link href="/marketing/settings" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Settings</Link>
          </div>
        </div>

        {loading && <p className="text-gray-500">Loading...</p>}
        {error && <p className="text-red-600">{error}</p>}

        {data && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-white rounded-xl shadow-sm p-6">
                <p className="text-gray-500 text-sm">Total Contacts</p>
                <p className="text-2xl font-bold">{data.totals.totalContacts}</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-6">
                <p className="text-gray-500 text-sm">Active Leads</p>
                <p className="text-2xl font-bold">{data.totals.activeLeads}</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-6">
                <p className="text-gray-500 text-sm">Follow-ups Due</p>
                <p className="text-2xl font-bold">{data.totals.followUpsDue}</p>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-lg font-semibold mb-4">Campaign Performance</h2>
              {data.campaigns.length === 0 ? (
                <p className="text-gray-500 text-sm">No campaigns yet. <Link href="/marketing/campaigns" className="text-blue-600 hover:underline">Create one</Link>.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-4 py-3">Campaign</th>
                        <th className="px-4 py-3 text-right">Sent</th>
                        <th className="px-4 py-3 text-right">Replied</th>
                        <th className="px-4 py-3 text-right">Leads</th>
                        <th className="px-4 py-3 text-right">Bookings</th>
                        <th className="px-4 py-3 text-right">Revenue</th>
                        <th className="px-4 py-3 text-right">Conversion %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.campaigns.map((c) => (
                        <tr key={c.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <Link href={`/marketing/campaigns/${c.id}`} className="text-blue-600 hover:underline">{c.name}</Link>
                          </td>
                          <td className="px-4 py-3 text-right">{c.sent}</td>
                          <td className="px-4 py-3 text-right">{c.replied}</td>
                          <td className="px-4 py-3 text-right">{c.leads}</td>
                          <td className="px-4 py-3 text-right">{c.bookings}</td>
                          <td className="px-4 py-3 text-right">{formatCurrency(c.revenue)}</td>
                          <td className="px-4 py-3 text-right">{c.conversionRate.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
