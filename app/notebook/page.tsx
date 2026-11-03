"use client";

import { useEffect, useMemo, useState } from "react";
import { toBusinessDateInputValue, formatBusinessDate } from "@/lib/date-range";

type VehicleStatus = "AVAILABLE" | "LOADING" | "DISPATCHED";

type VehicleRow = {
  key: number;
  vehicleNumber: string;
  status: VehicleStatus;
  note: string;
};

type HistoryEntry = {
  date: string;
  hasNotes: boolean;
  vehicleCount: number;
};

const STATUS_LABEL: Record<VehicleStatus, string> = {
  AVAILABLE: "Available",
  LOADING: "Loading",
  DISPATCHED: "Dispatched",
};

const STATUS_BADGE_CLASS: Record<VehicleStatus, string> = {
  AVAILABLE: "bg-green-50 text-green-700 border-green-200",
  LOADING: "bg-amber-50 text-amber-700 border-amber-200",
  DISPATCHED: "bg-gray-100 text-gray-600 border-gray-200",
};

function emptyVehicleRow(key: number): VehicleRow {
  return { key, vehicleNumber: "", status: "AVAILABLE", note: "" };
}

function todayInputValue() {
  return toBusinessDateInputValue(new Date());
}

export default function NotebookPage() {
  const [date, setDate] = useState(todayInputValue());
  const [notes, setNotes] = useState("");
  const [vehicles, setVehicles] = useState<VehicleRow[]>([emptyVehicleRow(0)]);
  const [nextKey, setNextKey] = useState(1);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  async function load(forDate: string) {
    setLoading(true);
    setError("");
    setSavedAt(null);
    try {
      const res = await fetch(`/api/notebook/${forDate}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load Notebook");

      setNotes(data.notebook.notes || "");
      const rows: VehicleRow[] = (data.notebook.vehicles || []).map((v: { vehicleNumber: string; status: VehicleStatus; note: string | null }, index: number) => ({
        key: index,
        vehicleNumber: v.vehicleNumber,
        status: v.status,
        note: v.note || "",
      }));
      setVehicles(rows.length > 0 ? rows : [emptyVehicleRow(0)]);
      setNextKey(rows.length > 0 ? rows.length : 1);
      setCanEdit(data.capabilities?.canEdit ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Notebook");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  useEffect(() => {
    fetch("/api/notebook?limit=30", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setHistory(d.entries || []);
      })
      .catch(() => {});
  }, [savedAt]);

  function shiftDay(delta: number) {
    const current = new Date(`${date}T00:00:00`);
    current.setDate(current.getDate() + delta);
    setDate(toBusinessDateInputValue(current));
  }

  function updateVehicle(key: number, field: "vehicleNumber" | "note", value: string) {
    setVehicles((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function updateStatus(key: number, status: VehicleStatus) {
    setVehicles((rows) => rows.map((r) => (r.key === key ? { ...r, status } : r)));
  }

  function addLine() {
    setVehicles((rows) => [...rows, emptyVehicleRow(nextKey)]);
    setNextKey((k) => k + 1);
  }

  function removeLine(key: number) {
    setVehicles((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== key) : rows));
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const payload = {
        notes,
        vehicles: vehicles
          .filter((v) => v.vehicleNumber.trim().length > 0)
          .map((v) => ({ vehicleNumber: v.vehicleNumber.trim(), status: v.status, note: v.note.trim() || undefined })),
      };
      const res = await fetch(`/api/notebook/${date}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to save Notebook");
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save Notebook");
    } finally {
      setSaving(false);
    }
  }

  const isToday = date === todayInputValue();
  const displayDate = useMemo(() => formatBusinessDate(`${date}T00:00:00`), [date]);

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Notebook</h1>
            <p className="text-sm text-gray-500">Shared daily notes - available vehicles, today&apos;s tasks, routine remarks.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => shiftDay(-1)} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
              ← Prev
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            {!isToday && (
              <button type="button" onClick={() => setDate(todayInputValue())} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
                Today
              </button>
            )}
            <button type="button" onClick={() => shiftDay(1)} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
              Next →
            </button>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {loading ? (
          <div className="rounded-xl border bg-white p-6 text-sm text-gray-500">Loading...</div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
            <div className="space-y-5">
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-700">{displayDate}</h2>
                  {!canEdit && <span className="text-xs text-gray-400">View only</span>}
                </div>

                <label className="block text-sm">
                  <span className="mb-1 block text-gray-600">Notes - aaj kiya karna hai, routine baatein</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    disabled={!canEdit}
                    rows={6}
                    placeholder="Jo likhna hai yahan likh dein..."
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
                  />
                </label>
              </div>

              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <h2 className="mb-3 text-sm font-semibold text-gray-700">Loading/Dispatch ke liye Gariyan</h2>

                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-2 py-2">Sr</th>
                        <th className="px-2 py-2">Vehicle No. / Naam</th>
                        <th className="px-2 py-2">Status</th>
                        <th className="px-2 py-2">Note</th>
                        {canEdit && <th className="px-2 py-2"></th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {vehicles.map((v, idx) => (
                        <tr key={v.key}>
                          <td className="px-2 py-1.5 text-gray-500">{idx + 1}</td>
                          <td className="px-2 py-1.5">
                            {canEdit ? (
                              <input
                                value={v.vehicleNumber}
                                onChange={(e) => updateVehicle(v.key, "vehicleNumber", e.target.value)}
                                placeholder="e.g. LEA-1234"
                                className="w-36 rounded border border-gray-300 px-2 py-1 text-sm"
                              />
                            ) : (
                              v.vehicleNumber
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {canEdit ? (
                              <select
                                value={v.status}
                                onChange={(e) => updateStatus(v.key, e.target.value as VehicleStatus)}
                                className="rounded border border-gray-300 px-2 py-1 text-sm"
                              >
                                {(["AVAILABLE", "LOADING", "DISPATCHED"] as VehicleStatus[]).map((s) => (
                                  <option key={s} value={s}>
                                    {STATUS_LABEL[s]}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_BADGE_CLASS[v.status]}`}>{STATUS_LABEL[v.status]}</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {canEdit ? (
                              <input
                                value={v.note}
                                onChange={(e) => updateVehicle(v.key, "note", e.target.value)}
                                className="w-48 rounded border border-gray-300 px-2 py-1 text-sm"
                              />
                            ) : (
                              v.note
                            )}
                          </td>
                          {canEdit && (
                            <td className="px-2 py-1.5">
                              <button type="button" onClick={() => removeLine(v.key)} className="text-xs text-red-600 hover:underline">
                                Remove
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {canEdit && (
                  <button type="button" onClick={addLine} className="mt-2 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50">
                    + Add Vehicle
                  </button>
                )}
              </div>

              {canEdit && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="rounded-lg bg-black px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                  {savedAt && <span className="text-sm text-green-600">Saved.</span>}
                </div>
              )}
            </div>

            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Recent Entries</h2>
              {history.length === 0 ? (
                <p className="text-xs text-gray-400">Koi purani entry nahi.</p>
              ) : (
                <ul className="space-y-1">
                  {history.map((h) => {
                    const inputValue = toBusinessDateInputValue(h.date);
                    return (
                      <li key={h.date}>
                        <button
                          type="button"
                          onClick={() => setDate(inputValue)}
                          className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-gray-50 ${
                            inputValue === date ? "bg-gray-100 font-medium" : ""
                          }`}
                        >
                          <span>{formatBusinessDate(h.date)}</span>
                          <span className="text-gray-400">{h.vehicleCount > 0 ? `${h.vehicleCount} veh.` : h.hasNotes ? "notes" : ""}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
