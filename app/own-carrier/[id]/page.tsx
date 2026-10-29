"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatBusinessDate } from "@/lib/date-range";

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
}

function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-xl text-gray-500 hover:bg-gray-100">
            ×
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

type Carrier = {
  id: string;
  carrierNumber: string;
  driverName: string | null;
  driverPhone: string | null;
  notes: string | null;
  isActive: boolean;
  currentDriver: { id: string; name: string; employeeCode: string } | null;
};

type TripItem = {
  id: string;
  tripNo: string;
  route: string | null;
  dateFrom: string;
  dateTo: string | null;
  status: "OPEN" | "CLOSED";
  documentCount: number;
  lineCount: number;
};

export default function OwnCarrierDetailPage() {
  const params = useParams();
  const carrierId = params.id as string;

  const [carrier, setCarrier] = useState<Carrier | null>(null);
  const [driverCashBalance, setDriverCashBalance] = useState(0);
  const [trips, setTrips] = useState<TripItem[]>([]);
  const [capabilities, setCapabilities] = useState({ canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [newTripOpen, setNewTripOpen] = useState(false);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch(`/api/own-carrier/${carrierId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load carrier");
      setCarrier(data.carrier);
      setDriverCashBalance(data.driverCashBalance || 0);
      setTrips(data.trips || []);
      setCapabilities(data.capabilities || { canEdit: false, canBin: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load carrier");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carrierId, refreshToken]);

  function refresh() {
    setRefreshToken((k) => k + 1);
  }

  async function handleBinTrip(trip: TripItem) {
    if (trip.lineCount > 0 || trip.documentCount > 0) {
      alert("This Trip still has active lines/linked documents - reverse/unlink them first.");
      return;
    }
    if (!window.confirm(`Move Trip ${trip.tripNo} to Bin?`)) return;
    const res = await fetch(`/api/own-carrier/${carrierId}/trips/${trip.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || "Unable to move Trip to Bin.");
      return;
    }
    refresh();
  }

  if (loading) {
    return <div className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">Loading...</div>;
  }
  if (error || !carrier) {
    return <div className="min-h-screen bg-gray-50 p-6 text-sm text-red-700">{error || "Carrier not found"}</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <Link href="/own-carrier" className="text-xs text-gray-500 hover:underline">
          ← Back to Own Carrier
        </Link>

        <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{carrier.carrierNumber}</h1>
            <p className="mt-1 text-sm text-gray-500">
              Driver: {carrier.currentDriver?.name || carrier.driverName || "—"}
              {carrier.driverPhone ? ` • ${carrier.driverPhone}` : ""}
            </p>
          </div>
          <div className="rounded-xl border bg-white px-5 py-3 text-right shadow-sm">
            <p className="text-xs text-gray-500">Driver Cash Balance</p>
            <p className="text-xl font-bold text-gray-900">Rs. {formatMoney(driverCashBalance)}</p>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Trips</h2>
          {capabilities.canEdit && (
            <button type="button" onClick={() => setNewTripOpen(true)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              + New Trip
            </button>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          {trips.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">No trips yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[800px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Trip No.</th>
                    <th className="px-4 py-3">Route</th>
                    <th className="px-4 py-3">Dates</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Lines</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {trips.map((t) => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Link href={`/own-carrier/${carrierId}/trip/${t.id}`} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
                            Open
                          </Link>
                          {capabilities.canBin && (
                            <button type="button" onClick={() => handleBinTrip(t)} className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
                              Move to Bin
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{t.tripNo}</td>
                      <td className="px-4 py-3 text-gray-600">{t.route || "—"}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatBusinessDate(t.dateFrom)}
                        {t.dateTo ? ` - ${formatBusinessDate(t.dateTo)}` : ""}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${t.status === "OPEN" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">{t.lineCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <NewTripDrawer
        carrierId={carrierId}
        open={newTripOpen}
        onClose={() => setNewTripOpen(false)}
        onCreated={() => {
          setNewTripOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

function todayYMD(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function NewTripDrawer({ carrierId, open, onClose, onCreated }: { carrierId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const [tripNo, setTripNo] = useState("");
  const [route, setRoute] = useState("");
  const [dateFrom, setDateFrom] = useState(todayYMD());
  const [dateTo, setDateTo] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setRoute("");
    setDateFrom(todayYMD());
    setDateTo("");
    setNotes("");
    (async () => {
      const res = await fetch(`/api/own-carrier/${carrierId}/trips`);
      const json = await res.json();
      if (res.ok && json.success) setTripNo(json.suggestedNextTripNo || "1");
    })();
  }, [open, carrierId]);

  async function handleCreate() {
    setError("");
    if (!tripNo.trim()) {
      setError("Trip No. is required.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(`/api/own-carrier/${carrierId}/trips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripNo: tripNo.trim(), route: route.trim() || undefined, dateFrom, dateTo: dateTo || undefined, notes: notes.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to create Trip.");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create Trip.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="New Trip">
      <div className="space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Trip No. *</label>
          <input type="text" value={tripNo} onChange={(e) => setTripNo(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Route</label>
          <input type="text" value={route} onChange={(e) => setRoute(e.target.value)} placeholder="e.g. Karachi - Tarnol - Karachi" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Date From *</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Date To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <div className="flex justify-end gap-2 border-t pt-4">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={handleCreate} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving..." : "Create Trip"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
