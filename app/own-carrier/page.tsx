"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SearchableSelect } from "@/app/daily-posting/SearchableSelect";

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

type CarrierItem = {
  id: string;
  carrierNumber: string;
  driverName: string | null;
  driverPhone: string | null;
  isActive: boolean;
  currentDriver: { id: string; name: string } | null;
  tripCount: number;
  driverCashBalance: number;
};

type Capabilities = { canCreate: boolean; canEdit: boolean; canBin: boolean };

export default function OwnCarrierListPage() {
  const [items, setItems] = useState<CarrierItem[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({ canCreate: false, canEdit: false, canBin: false });
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<{ mode: "new" | "edit"; id?: string } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/own-carrier?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load Own Carriers");
      setItems(data.items || []);
      setCapabilities(data.capabilities || { canCreate: false, canEdit: false, canBin: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Own Carriers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  function refresh() {
    setRefreshToken((k) => k + 1);
  }

  async function handleBin(item: CarrierItem) {
    if (item.tripCount > 0) {
      alert("This carrier still has active Trips - move them to Bin first.");
      return;
    }
    if (!window.confirm(`Move carrier ${item.carrierNumber} to Bin?`)) return;
    const res = await fetch(`/api/own-carrier/${item.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || "Unable to move to Bin.");
      return;
    }
    refresh();
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Own Carrier</h1>
            <p className="mt-1 text-sm text-gray-500">Carriers, Driver Cash and Trips.</p>
          </div>
          <Link href="/own-carrier/bin" className="text-xs text-gray-500 hover:underline">
            View Bin
          </Link>
        </div>

        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="Search carrier no, driver..."
              className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            <button type="button" onClick={load} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
              Search
            </button>
          </div>
          {capabilities.canCreate && (
            <button type="button" onClick={() => setDrawer({ mode: "new" })} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              + New Carrier
            </button>
          )}
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          {loading ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">Loading carriers...</div>
          ) : items.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">No carriers found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Carrier No.</th>
                    <th className="px-4 py-3">Current Driver</th>
                    <th className="px-4 py-3 text-right">Trips</th>
                    <th className="px-4 py-3 text-right">Driver Cash</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Link href={`/own-carrier/${item.id}`} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
                            Open
                          </Link>
                          {capabilities.canEdit && (
                            <button type="button" onClick={() => setDrawer({ mode: "edit", id: item.id })} className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50">
                              Edit
                            </button>
                          )}
                          {capabilities.canBin && (
                            <button type="button" onClick={() => handleBin(item)} className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
                              Move to Bin
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{item.carrierNumber}</td>
                      <td className="px-4 py-3 text-gray-600">{item.currentDriver?.name || item.driverName || "—"}</td>
                      <td className="px-4 py-3 text-right">{item.tripCount}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">Rs. {formatMoney(item.driverCashBalance)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${item.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                          {item.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <CarrierDrawer
        state={drawer}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          refresh();
        }}
      />
    </div>
  );
}

function CarrierDrawer({ state, onClose, onSaved }: { state: { mode: "new" | "edit"; id?: string } | null; onClose: () => void; onSaved: () => void }) {
  const [carrierNumber, setCarrierNumber] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [currentDriverId, setCurrentDriverId] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [employees, setEmployees] = useState<{ id: string; name: string; employeeCode: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/employees?status=ACTIVE");
      const json = await res.json();
      if (res.ok && json.success) setEmployees(json.items || []);
    })();
  }, []);

  useEffect(() => {
    if (!state) return;
    setError("");
    if (state.mode === "new") {
      setCarrierNumber("");
      setDriverName("");
      setDriverPhone("");
      setNotes("");
      setCurrentDriverId("");
      setIsActive(true);
    } else if (state.id) {
      (async () => {
        const res = await fetch(`/api/own-carrier/${state.id}`);
        const json = await res.json();
        if (res.ok && json.success) {
          const c = json.carrier;
          setCarrierNumber(c.carrierNumber);
          setDriverName(c.driverName || "");
          setDriverPhone(c.driverPhone || "");
          setNotes(c.notes || "");
          setCurrentDriverId(c.currentDriverId || "");
          setIsActive(c.isActive);
        }
      })();
    }
  }, [state]);

  async function handleSave() {
    setError("");
    if (!carrierNumber.trim()) {
      setError("Carrier number is required.");
      return;
    }
    try {
      setSaving(true);
      const payload = {
        carrierNumber: carrierNumber.trim(),
        driverName: driverName.trim() || undefined,
        driverPhone: driverPhone.trim() || undefined,
        notes: notes.trim() || undefined,
        currentDriverId: currentDriverId || null,
        ...(state?.mode === "edit" ? { isActive } : {}),
      };
      const url = state?.mode === "edit" ? `/api/own-carrier/${state.id}` : "/api/own-carrier";
      const method = state?.mode === "edit" ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to save carrier.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save carrier.");
    } finally {
      setSaving(false);
    }
  }

  const employeeOptions = employees.map((e) => ({ value: e.id, label: e.name, secondary: e.employeeCode }));

  return (
    <Drawer open={!!state} onClose={onClose} title={state?.mode === "edit" ? "Edit Carrier" : "New Carrier"}>
      <div className="space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Carrier Number *</label>
          <input type="text" value={carrierNumber} onChange={(e) => setCarrierNumber(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Current Driver</label>
          <SearchableSelect value={currentDriverId} options={employeeOptions} placeholder="Select driver (optional)..." onChange={setCurrentDriverId} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Driver Name (if not an Employee)</label>
          <input type="text" value={driverName} onChange={(e) => setDriverName(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Driver Phone</label>
          <input type="text" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>
        {state?.mode === "edit" && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        )}
        <div className="flex justify-end gap-2 border-t pt-4">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={handleSave} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
