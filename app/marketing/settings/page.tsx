"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Settings = {
  activeDays: number;
  sleepingMinDays: number;
  sleepingMaxDays: number;
  lostDays: number;
  vipPercentile: number;
  defaultDailyLimit: number;
  conversionWindowDays: number;
};

export default function MarketingSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/marketing/settings");
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.message || "Unable to load settings");
          return;
        }
        setSettings(json.settings);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function update<K extends keyof Settings>(key: K, value: number) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/marketing/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || "Unable to save settings");
        return;
      }
      setMessage("Settings saved");
      setSettings(json.settings);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-gray-500">Loading...</p></main>;
  if (!settings) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-red-600">{error}</p></main>;

  const fields: { key: keyof Settings; label: string; help: string }[] = [
    { key: "activeDays", label: "Active (days since last activity)", help: "<= this many days = Active" },
    { key: "sleepingMinDays", label: "Sleeping min days", help: "Sleeping window starts here" },
    { key: "sleepingMaxDays", label: "Sleeping max days", help: "Sleeping window ends here" },
    { key: "lostDays", label: "Lost (days since last activity)", help: "> this many days = Lost" },
    { key: "vipPercentile", label: "VIP percentile", help: "Top X% of revenue = VIP" },
    { key: "defaultDailyLimit", label: "Default daily send limit", help: "Default for new campaigns" },
    { key: "conversionWindowDays", label: "Conversion window (days)", help: "A Bilty within this many days of a send auto-converts a Lead to Booked" },
  ];

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Marketing Settings</h1>
            <p className="text-gray-600">Segment thresholds and campaign defaults</p>
          </div>
          <Link href="/marketing" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Back to Marketing</Link>
        </div>

        {error && <p className="text-red-600 mb-4">{error}</p>}
        {message && <p className="text-green-600 mb-4">{message}</p>}

        <div className="bg-white rounded-xl shadow-sm p-6">
          <form onSubmit={handleSave} className="space-y-4">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-sm text-gray-600 mb-1">{f.label}</label>
                <input
                  type="number"
                  min="1"
                  value={settings[f.key]}
                  onChange={(e) => update(f.key, Number(e.target.value))}
                  className="border rounded-lg px-3 py-2 text-sm w-full"
                />
                <p className="text-xs text-gray-400 mt-1">{f.help}</p>
              </div>
            ))}
            <button type="submit" disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
