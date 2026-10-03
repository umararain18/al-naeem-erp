"use client";

import { useEffect, useMemo, useState } from "react";
import { toBusinessDateInputValue } from "@/lib/date-range";

// ============================================================
// SHOWROOM PHONCH / DELIVERY - shared create/edit form
//
// Extracted from app/phonch/page.tsx so the Phonch detail page's
// "Edit" action can reuse the EXACT same form/validation UX instead
// of a second, parallel implementation - Create's own usage is
// unaffected (mode="create" is the same behavior as before).
// ============================================================

type SearchOption = { value: string; label: string; secondary?: string };

function SearchableSelect({
  value,
  options,
  placeholder,
  disabled = false,
  onChange,
}: {
  value: string;
  options: SearchOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    setQuery(selected?.label || "");
  }, [value, selected?.label]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.secondary || ""}`.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="relative w-full">
      <input
        type="text"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => {
          if (!disabled) {
            setOpen(true);
            setQuery("");
          }
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
      />
      {open && !disabled && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {filtered.length > 0 ? (
            filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o.value);
                  setQuery(o.label);
                  setOpen(false);
                }}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-blue-50"
              >
                <div className="font-medium text-gray-900">{o.label}</div>
                {o.secondary && <div className="mt-0.5 text-xs text-gray-500">{o.secondary}</div>}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-gray-500">No results found</div>
          )}
        </div>
      )}
    </div>
  );
}

type PhonchVehicleRow = {
  key: number;
  biltyNo: string;
  challanNo: string;
  chassisNumber: string;
  engineNumber: string;
  vehicleName: string;
  partyId: string;
  deliveryCharges: string;
  note: string;
  otherExpenseAmount: string;
  otherExpenseReason: string;
  claimAmount: string;
  claimReason: string;
};

function emptyVehicleRow(key: number): PhonchVehicleRow {
  return {
    key,
    biltyNo: "",
    challanNo: "",
    chassisNumber: "",
    engineNumber: "",
    vehicleName: "",
    partyId: "",
    deliveryCharges: "",
    note: "",
    otherExpenseAmount: "",
    otherExpenseReason: "",
    claimAmount: "",
    claimReason: "",
  };
}

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export type PhonchFormInitialVehicle = {
  biltyNo: string | null;
  challanNo: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  vehicleName: string | null;
  party: { id: string; partyName: string } | null;
  deliveryCharges: string | number;
  note: string | null;
  otherExpenseAmount: string | number;
  otherExpenseReason: string | null;
  claimAmount: string | number;
  claimReason: string | null;
};

export type PhonchFormInitialData = {
  phonchNo: string;
  date: string;
  transporterParty: { id: string; partyName: string };
  carrierNumber: string | null;
  description: string | null;
  vehicles: PhonchFormInitialVehicle[];
};

export default function PhonchForm({
  mode,
  phonchId,
  initialData,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit";
  phonchId?: string;
  initialData?: PhonchFormInitialData;
  onSaved: (phonch: { id: string; phonchNo: string }) => void;
  onCancel?: () => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [parties, setParties] = useState<{ id: string; partyName: string; partyTypes: string[] }[]>([]);

  const [phonchNo, setPhonchNo] = useState(initialData?.phonchNo || "");
  const [date, setDate] = useState(
    initialData?.date ? toBusinessDateInputValue(initialData.date) : toBusinessDateInputValue(new Date())
  );
  const [transporterPartyId, setTransporterPartyId] = useState(initialData?.transporterParty.id || "");
  const [carrierNumber, setCarrierNumber] = useState(initialData?.carrierNumber || "");
  const [description, setDescription] = useState(initialData?.description || "");
  const [showDescription, setShowDescription] = useState(!!initialData?.description);

  const initialVehicles: PhonchVehicleRow[] = initialData?.vehicles.length
    ? initialData.vehicles.map((v, index) => ({
        key: index,
        biltyNo: v.biltyNo || "",
        challanNo: v.challanNo || "",
        chassisNumber: v.chassisNumber || "",
        engineNumber: v.engineNumber || "",
        vehicleName: v.vehicleName || "",
        partyId: v.party?.id || "",
        deliveryCharges: String(Number(v.deliveryCharges) || ""),
        note: v.note || "",
        otherExpenseAmount: Number(v.otherExpenseAmount) > 0 ? String(Number(v.otherExpenseAmount)) : "",
        otherExpenseReason: v.otherExpenseReason || "",
        claimAmount: Number(v.claimAmount) > 0 ? String(Number(v.claimAmount)) : "",
        claimReason: v.claimReason || "",
      }))
    : [emptyVehicleRow(0)];

  const [showOtherExpense, setShowOtherExpense] = useState(
    initialData?.vehicles.some((v) => Number(v.otherExpenseAmount) > 0) || false
  );
  const [showClaim, setShowClaim] = useState(initialData?.vehicles.some((v) => Number(v.claimAmount) > 0) || false);

  const [nextKey, setNextKey] = useState(initialVehicles.length);
  const [vehicles, setVehicles] = useState<PhonchVehicleRow[]>(initialVehicles);

  async function loadParties() {
    const res = await fetch("/api/parties", { cache: "no-store" });
    const data = await res.json();
    if (data.success) setParties(data.parties || []);
  }

  useEffect(() => {
    loadParties();
  }, []);

  const transporterOptions: SearchOption[] = parties
    .filter((p) => p.partyTypes?.includes("TRANSPORTER"))
    .map((p) => ({ value: p.id, label: p.partyName }));

  const partyOptions: SearchOption[] = parties.map((p) => ({ value: p.id, label: p.partyName }));

  function updateVehicle(key: number, field: keyof PhonchVehicleRow, value: string) {
    setVehicles((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function addLine() {
    setVehicles((rows) => [...rows, emptyVehicleRow(nextKey)]);
    setNextKey((k) => k + 1);
  }

  function removeLine(key: number) {
    setVehicles((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== key) : rows));
  }

  // Removing an optional component clears its data across every
  // vehicle line and hides the column - it never removes the vehicle
  // line itself, and never leaves a stale "label: , Rs. 0"-style
  // fragment for the server to render into the ledger description.
  function removeOtherExpense() {
    setVehicles((rows) => rows.map((r) => ({ ...r, otherExpenseAmount: "", otherExpenseReason: "" })));
    setShowOtherExpense(false);
  }

  function removeClaim() {
    setVehicles((rows) => rows.map((r) => ({ ...r, claimAmount: "", claimReason: "" })));
    setShowClaim(false);
  }

  function removeDescription() {
    setDescription("");
    setShowDescription(false);
  }

  const totals = useMemo(() => {
    const totalDeliveryCharges = vehicles.reduce((s, v) => s + (Number(v.deliveryCharges) || 0), 0);
    const totalOtherExpense = vehicles.reduce((s, v) => s + (Number(v.otherExpenseAmount) || 0), 0);
    const totalClaim = vehicles.reduce((s, v) => s + (Number(v.claimAmount) || 0), 0);
    return {
      totalDeliveryCharges,
      totalOtherExpense,
      totalClaim,
      totalAmount: totalDeliveryCharges + totalOtherExpense + totalClaim,
    };
  }, [vehicles]);

  function resetForm() {
    setPhonchNo("");
    setDate(toBusinessDateInputValue(new Date()));
    setTransporterPartyId("");
    setCarrierNumber("");
    setDescription("");
    setShowDescription(false);
    setShowOtherExpense(false);
    setShowClaim(false);
    setVehicles([emptyVehicleRow(0)]);
    setNextKey(1);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const payload = {
        phonchNo,
        date,
        transporterPartyId,
        carrierNumber,
        description: showDescription ? description : "",
        ...(mode === "create" ? { idempotencyKey: crypto.randomUUID() } : {}),
        vehicles: vehicles.map((v) => ({
          biltyNo: v.biltyNo,
          challanNo: v.challanNo,
          chassisNumber: v.chassisNumber,
          engineNumber: v.engineNumber,
          vehicleName: v.vehicleName,
          partyId: v.partyId || undefined,
          deliveryCharges: Number(v.deliveryCharges) || 0,
          note: v.note,
          otherExpenseAmount: showOtherExpense ? Number(v.otherExpenseAmount) || 0 : 0,
          otherExpenseReason: showOtherExpense ? v.otherExpenseReason : "",
          claimAmount: showClaim ? Number(v.claimAmount) || 0 : 0,
          claimReason: showClaim ? v.claimReason : "",
        })),
      };

      const response = await fetch(mode === "create" ? "/api/phonch" : `/api/phonch/${phonchId}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || `Unable to ${mode === "create" ? "create" : "update"} Phonch`);
      }
      if (mode === "create") resetForm();
      onSaved(data.phonch || { id: phonchId!, phonchNo });
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${mode === "create" ? "create" : "update"} Phonch`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-gray-700">{mode === "create" ? "New Phonch" : "Edit Phonch"}</h2>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Phonch No.</span>
          <input
            value={phonchNo}
            onChange={(e) => setPhonchNo(e.target.value)}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Transporter</span>
          <SearchableSelect
            value={transporterPartyId}
            options={transporterOptions}
            placeholder="Search transporter..."
            onChange={setTransporterPartyId}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Carrier No.</span>
          <input
            value={carrierNumber}
            onChange={(e) => setCarrierNumber(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">Vehicles</span>
        <div className="flex-1" />
        {!showOtherExpense && (
          <button
            type="button"
            onClick={() => setShowOtherExpense(true)}
            className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
          >
            + Add Other Expense
          </button>
        )}
        {showOtherExpense && (
          <button
            type="button"
            onClick={removeOtherExpense}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50"
          >
            − Remove Other Expense
          </button>
        )}
        {!showClaim && (
          <button
            type="button"
            onClick={() => setShowClaim(true)}
            className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
          >
            + Add Claim
          </button>
        )}
        {showClaim && (
          <button
            type="button"
            onClick={removeClaim}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50"
          >
            − Remove Claim
          </button>
        )}
        {!showDescription && (
          <button
            type="button"
            onClick={() => setShowDescription(true)}
            className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
          >
            + Add Description
          </button>
        )}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-2 py-2">No.</th>
              <th className="px-2 py-2">Bilty No</th>
              <th className="px-2 py-2">Challan No</th>
              <th className="px-2 py-2">Chassis No</th>
              <th className="px-2 py-2">Engine No</th>
              <th className="px-2 py-2">Vehicle Name</th>
              <th className="px-2 py-2">Party</th>
              <th className="px-2 py-2">Delivery Charges</th>
              {showOtherExpense && <th className="px-2 py-2">Other Expense</th>}
              {showClaim && <th className="px-2 py-2">Claim</th>}
              <th className="px-2 py-2">Note / Condition</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {vehicles.map((v, idx) => (
              <tr key={v.key} className="align-top">
                <td className="px-2 py-1.5 text-gray-500">{idx + 1}</td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.biltyNo}
                    onChange={(e) => updateVehicle(v.key, "biltyNo", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.challanNo}
                    onChange={(e) => updateVehicle(v.key, "challanNo", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.chassisNumber}
                    onChange={(e) => updateVehicle(v.key, "chassisNumber", e.target.value)}
                    className="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.engineNumber}
                    onChange={(e) => updateVehicle(v.key, "engineNumber", e.target.value)}
                    className="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.vehicleName}
                    onChange={(e) => updateVehicle(v.key, "vehicleName", e.target.value)}
                    className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <div className="w-40">
                    <SearchableSelect
                      value={v.partyId}
                      options={partyOptions}
                      placeholder="Party..."
                      onChange={(val) => updateVehicle(v.key, "partyId", val)}
                    />
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={v.deliveryCharges}
                    onChange={(e) => updateVehicle(v.key, "deliveryCharges", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                {showOtherExpense && (
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      min={0}
                      value={v.otherExpenseAmount}
                      onChange={(e) => updateVehicle(v.key, "otherExpenseAmount", e.target.value)}
                      placeholder="Amount"
                      className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <input
                      value={v.otherExpenseReason}
                      onChange={(e) => updateVehicle(v.key, "otherExpenseReason", e.target.value)}
                      placeholder="Reason (required)"
                      className="mt-1 w-32 rounded border border-gray-300 px-2 py-1 text-xs"
                    />
                  </td>
                )}
                {showClaim && (
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      min={0}
                      value={v.claimAmount}
                      onChange={(e) => updateVehicle(v.key, "claimAmount", e.target.value)}
                      placeholder="Amount"
                      className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <input
                      value={v.claimReason}
                      onChange={(e) => updateVehicle(v.key, "claimReason", e.target.value)}
                      placeholder="Damage/reason (required)"
                      className="mt-1 w-32 rounded border border-gray-300 px-2 py-1 text-xs"
                    />
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <input
                    value={v.note}
                    onChange={(e) => updateVehicle(v.key, "note", e.target.value)}
                    className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <button type="button" onClick={() => removeLine(v.key)} className="text-xs text-red-600 hover:underline">
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button type="button" onClick={addLine} className="mt-2 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50">
        + Add Line
      </button>

      {showDescription && (
        <label className="mt-4 block text-sm">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-gray-600">Description (optional)</span>
            <button type="button" onClick={removeDescription} className="text-xs text-red-600 hover:underline">
              Remove Description
            </button>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </label>
      )}

      <div className="mt-5 flex flex-col items-end gap-1 border-t pt-4 text-sm">
        <div className="flex w-64 justify-between">
          <span className="text-gray-600">Total Delivery Charges</span>
          <span className="font-medium">{formatCurrency(totals.totalDeliveryCharges)}</span>
        </div>
        {showOtherExpense && totals.totalOtherExpense > 0 && (
          <div className="flex w-64 justify-between">
            <span className="text-gray-600">Total Other Expense</span>
            <span className="font-medium">{formatCurrency(totals.totalOtherExpense)}</span>
          </div>
        )}
        {showClaim && totals.totalClaim > 0 && (
          <div className="flex w-64 justify-between">
            <span className="text-gray-600">Total Claim</span>
            <span className="font-medium">{formatCurrency(totals.totalClaim)}</span>
          </div>
        )}
        <div className="flex w-64 justify-between border-t pt-1 font-semibold">
          <span>Total Amount</span>
          <span>{formatCurrency(totals.totalAmount)}</span>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        {mode === "edit" && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border px-5 py-2 text-sm font-medium hover:bg-gray-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-black px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {saving ? "Saving..." : mode === "create" ? "Create Phonch" : "Update Phonch"}
        </button>
      </div>
    </form>
  );
}
