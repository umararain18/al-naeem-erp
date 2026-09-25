"use client";

import { useEffect, useMemo, useState } from "react";

// ============================================================
// PRIVATE PHONCH - shared create/edit form
//
// Mirrors app/phonch/PhonchForm.tsx's own structure/patterns exactly
// (SearchableSelect, add/remove vehicle line, live totals) - the
// business-specific difference is the vehicle row's own fields
// (Clearing Agent instead of a generic Party, Total Rent/Delivery
// Charges/Carrier Payable as inputs with Net Rent/CA Payable always
// DERIVED and shown read-only, never independently editable) and a
// read-only Bill No. field (set only by a future Bill Book feature).
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

type DeliveryRecoveryParty = "TRANSPORTER" | "CLEARING_AGENT";

type VehicleRow = {
  key: number;
  biltyNo: string;
  challanNo: string;
  chassisNumber: string;
  engineNumber: string;
  vehicleName: string;
  clearingAgentPartyId: string;
  totalRent: string;
  deliveryCharges: string;
  carrierPayable: string;
  // Only meaningful when Total Rent = 0 and Delivery Charges > 0 - who
  // this vehicle's Delivery Charges are recovered FROM. Defaults to
  // "TRANSPORTER" (the pre-existing behavior).
  deliveryRecoveryParty: DeliveryRecoveryParty;
  note: string;
};

function emptyVehicleRow(key: number): VehicleRow {
  return {
    key,
    biltyNo: "",
    challanNo: "",
    chassisNumber: "",
    engineNumber: "",
    vehicleName: "",
    clearingAgentPartyId: "",
    totalRent: "",
    deliveryCharges: "",
    carrierPayable: "",
    deliveryRecoveryParty: "TRANSPORTER",
    note: "",
  };
}

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type PrivatePhonchFormInitialVehicle = {
  biltyNo: string | null;
  challanNo: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  vehicleName: string | null;
  clearingAgentParty: { id: string; partyName: string } | null;
  totalRent: string | number;
  deliveryCharges: string | number;
  carrierPayable: string | number;
  deliveryRecoveryParty?: string | null;
  note: string | null;
};

export type PrivatePhonchFormInitialData = {
  phonchNo: string;
  date: string;
  transporterParty: { id: string; partyName: string };
  billNo: string | null;
  vehicles: PrivatePhonchFormInitialVehicle[];
};

export default function PrivatePhonchForm({
  mode,
  phonchId,
  initialData,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit";
  phonchId?: string;
  initialData?: PrivatePhonchFormInitialData;
  onSaved: (phonch: { id: string; phonchNo: string }) => void;
  onCancel?: () => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [parties, setParties] = useState<{ id: string; partyName: string; partyTypes: string[] }[]>([]);

  const [phonchNo, setPhonchNo] = useState(initialData?.phonchNo || "");
  const [date, setDate] = useState(
    initialData?.date ? initialData.date.slice(0, 10) : new Date().toISOString().slice(0, 10)
  );
  const [transporterPartyId, setTransporterPartyId] = useState(initialData?.transporterParty.id || "");

  const initialVehicles: VehicleRow[] = initialData?.vehicles.length
    ? initialData.vehicles.map((v, index) => ({
        key: index,
        biltyNo: v.biltyNo || "",
        challanNo: v.challanNo || "",
        chassisNumber: v.chassisNumber || "",
        engineNumber: v.engineNumber || "",
        vehicleName: v.vehicleName || "",
        clearingAgentPartyId: v.clearingAgentParty?.id || "",
        totalRent: String(Number(v.totalRent) || ""),
        deliveryCharges: Number(v.deliveryCharges) > 0 ? String(Number(v.deliveryCharges)) : "",
        carrierPayable: Number(v.carrierPayable) > 0 ? String(Number(v.carrierPayable)) : "",
        deliveryRecoveryParty: v.deliveryRecoveryParty === "CLEARING_AGENT" ? "CLEARING_AGENT" : "TRANSPORTER",
        note: v.note || "",
      }))
    : [emptyVehicleRow(0)];

  const [nextKey, setNextKey] = useState(initialVehicles.length);
  const [vehicles, setVehicles] = useState<VehicleRow[]>(initialVehicles);

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

  // Clearing Agent is selected from existing ERP Party accounts -
  // per the spec, any Party may act as a Clearing Agent (no dedicated
  // CLEARING_AGENT partyType gate, matching how the Bilty module's own
  // Clearing Agent field already offers every Party, not a filtered
  // subset).
  const clearingAgentOptions: SearchOption[] = parties.map((p) => ({ value: p.id, label: p.partyName }));

  function updateVehicle(key: number, field: keyof VehicleRow, value: string) {
    setVehicles((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function setDeliveryRecoveryParty(key: number, value: DeliveryRecoveryParty) {
    setVehicles((rows) => rows.map((r) => (r.key === key ? { ...r, deliveryRecoveryParty: value } : r)));
  }

  function addLine() {
    setVehicles((rows) => [...rows, emptyVehicleRow(nextKey)]);
    setNextKey((k) => k + 1);
  }

  function removeLine(key: number) {
    setVehicles((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== key) : rows));
  }

  // Net Rent = Total Rent - Delivery Charges; CA Payable = Net Rent -
  // Carrier Payable - ALWAYS derived, never independently entered, so
  // the formula can never drift from what the server will itself
  // recompute (lib/private-phonch-accounting.ts's own
  // resolvePrivatePhonchInput()). Clamped only for DISPLAY (never lets
  // a negative figure render) - the real rejection happens on submit.
  //
  // Zero-rent exception: when Total Rent is 0, Net Rent and CA Payable
  // are pinned at 0 regardless of Delivery Charges - a zero-rent
  // vehicle's Delivery Charges are recovered from the Transporter as a
  // separate receivable (Transporter Delivery Recovery), handled
  // entirely server-side; they must never make Net Rent/CA Payable go
  // negative on this row.
  const rowsWithDerived = useMemo(
    () =>
      vehicles.map((v) => {
        const totalRent = Number(v.totalRent) || 0;
        const deliveryCharges = Number(v.deliveryCharges) || 0;
        const carrierPayable = Number(v.carrierPayable) || 0;
        const isZeroRent = totalRent <= 0.009;
        const netRent = isZeroRent ? 0 : round2(totalRent - deliveryCharges);
        const caPayable = isZeroRent ? 0 : round2(netRent - carrierPayable);
        // Only a zero-rent vehicle with actual Delivery Charges needs a
        // recovery-party choice - a normal vehicle's Delivery Charges
        // are already absorbed into Net Rent/CA Payable above.
        const showRecoveryPartyChoice = isZeroRent && deliveryCharges > 0.009;
        const recoveryCaPartyMissing =
          showRecoveryPartyChoice && v.deliveryRecoveryParty === "CLEARING_AGENT" && !v.clearingAgentPartyId;
        return {
          ...v,
          netRent,
          caPayable,
          showRecoveryPartyChoice,
          recoveryCaPartyMissing,
          deliveryChargesExceedsTotal: !isZeroRent && deliveryCharges > totalRent + 0.009,
          carrierPayableExceedsNetRent: carrierPayable > netRent + 0.009,
          caPayableNegative: caPayable < -0.009,
          caPartyMissing: caPayable > 0.009 && !v.clearingAgentPartyId,
        };
      }),
    [vehicles]
  );

  const totals = useMemo(() => {
    const totalRent = vehicles.reduce((s, v) => s + (Number(v.totalRent) || 0), 0);
    const totalDeliveryCharges = vehicles.reduce((s, v) => s + (Number(v.deliveryCharges) || 0), 0);
    const totalCarrierPayable = vehicles.reduce((s, v) => s + (Number(v.carrierPayable) || 0), 0);
    // Summed from each row's own (zero-rent-aware) derived value, not
    // recomputed from aggregate Total Rent/Delivery Charges - a mixed
    // phonch (one normal-rent vehicle + one zero-rent vehicle) must not
    // let the zero-rent vehicle's Delivery Charges bleed into the
    // normal vehicle's Net Rent/CA Payable total.
    const totalNetRent = round2(rowsWithDerived.reduce((s, v) => s + v.netRent, 0));
    const totalCaPayable = round2(rowsWithDerived.reduce((s, v) => s + v.caPayable, 0));
    return { totalRent, totalDeliveryCharges, totalCarrierPayable, totalNetRent, totalCaPayable };
  }, [vehicles, rowsWithDerived]);

  function resetForm() {
    setPhonchNo("");
    setDate(new Date().toISOString().slice(0, 10));
    setTransporterPartyId("");
    setVehicles([emptyVehicleRow(0)]);
    setNextKey(1);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    const invalidRow = rowsWithDerived.findIndex(
      (v) =>
        v.deliveryChargesExceedsTotal ||
        v.carrierPayableExceedsNetRent ||
        v.caPayableNegative ||
        v.caPartyMissing ||
        v.recoveryCaPartyMissing
    );
    if (invalidRow >= 0) {
      setError(`Vehicle line ${invalidRow + 1}: please correct the highlighted amount before saving.`);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        phonchNo,
        date,
        transporterPartyId,
        ...(mode === "create" ? { idempotencyKey: crypto.randomUUID() } : {}),
        vehicles: vehicles.map((v) => ({
          biltyNo: v.biltyNo,
          challanNo: v.challanNo,
          chassisNumber: v.chassisNumber,
          engineNumber: v.engineNumber,
          vehicleName: v.vehicleName,
          clearingAgentPartyId: v.clearingAgentPartyId || undefined,
          totalRent: Number(v.totalRent) || 0,
          deliveryCharges: Number(v.deliveryCharges) || 0,
          carrierPayable: Number(v.carrierPayable) || 0,
          deliveryRecoveryParty: v.deliveryRecoveryParty,
          note: v.note,
        })),
      };

      const response = await fetch(mode === "create" ? "/api/private-phonch" : `/api/private-phonch/${phonchId}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || `Unable to ${mode === "create" ? "create" : "update"} Private Phonch`);
      }
      if (mode === "create") resetForm();
      onSaved(data.phonch || { id: phonchId!, phonchNo });
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${mode === "create" ? "create" : "update"} Private Phonch`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-gray-700">
        {mode === "create" ? "New Private Phonch" : "Edit Private Phonch"}
      </h2>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Private Phonch No.</span>
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
          <span className="mb-1 block text-gray-600">Bill No.</span>
          <input
            value={initialData?.billNo || ""}
            disabled
            placeholder="Set automatically when a Bill is linked"
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
          />
        </label>
      </div>

      <div className="mt-5">
        <span className="text-sm font-semibold text-gray-700">Vehicles</span>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1300px] text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-2 py-2">Sr</th>
              <th className="px-2 py-2">Bilty No.</th>
              <th className="px-2 py-2">Challan No.</th>
              <th className="px-2 py-2">Chassis</th>
              <th className="px-2 py-2">Engine</th>
              <th className="px-2 py-2">Vehicle</th>
              <th className="px-2 py-2">Clearing Agent</th>
              <th className="px-2 py-2">Total Rent</th>
              <th className="px-2 py-2">Delivery Charges</th>
              <th className="px-2 py-2">Net Rent</th>
              <th className="px-2 py-2">Carrier Payable</th>
              <th className="px-2 py-2">CA Payable</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rowsWithDerived.map((v, idx) => (
              <tr key={v.key} className="align-top">
                <td className="px-2 py-1.5 text-gray-500">{idx + 1}</td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.biltyNo}
                    onChange={(e) => updateVehicle(v.key, "biltyNo", e.target.value)}
                    className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.challanNo}
                    onChange={(e) => updateVehicle(v.key, "challanNo", e.target.value)}
                    className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.chassisNumber}
                    onChange={(e) => updateVehicle(v.key, "chassisNumber", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.engineNumber}
                    onChange={(e) => updateVehicle(v.key, "engineNumber", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.vehicleName}
                    onChange={(e) => updateVehicle(v.key, "vehicleName", e.target.value)}
                    className="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <div className="w-36">
                    <SearchableSelect
                      value={v.clearingAgentPartyId}
                      options={clearingAgentOptions}
                      placeholder="Clearing Agent..."
                      onChange={(val) => updateVehicle(v.key, "clearingAgentPartyId", val)}
                    />
                  </div>
                  {v.caPartyMissing && <p className="mt-1 text-xs text-red-600">Required - CA Payable &gt; 0</p>}
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={v.totalRent}
                    onChange={(e) => updateVehicle(v.key, "totalRent", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={v.deliveryCharges}
                    onChange={(e) => updateVehicle(v.key, "deliveryCharges", e.target.value)}
                    className={`w-24 rounded border px-2 py-1 text-sm ${
                      v.deliveryChargesExceedsTotal ? "border-red-400" : "border-gray-300"
                    }`}
                  />
                  {v.deliveryChargesExceedsTotal && <p className="mt-1 text-xs text-red-600">Exceeds Total Rent</p>}
                  {v.showRecoveryPartyChoice && (
                    <div className="mt-1 whitespace-nowrap text-xs text-gray-600">
                      <div>Recovery From:</div>
                      <label className="mr-2 inline-flex items-center gap-1">
                        <input
                          type="radio"
                          name={`recoveryParty-${v.key}`}
                          checked={v.deliveryRecoveryParty === "TRANSPORTER"}
                          onChange={() => setDeliveryRecoveryParty(v.key, "TRANSPORTER")}
                        />
                        Transporter
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <input
                          type="radio"
                          name={`recoveryParty-${v.key}`}
                          checked={v.deliveryRecoveryParty === "CLEARING_AGENT"}
                          onChange={() => setDeliveryRecoveryParty(v.key, "CLEARING_AGENT")}
                        />
                        Clearing Agent
                      </label>
                      {v.recoveryCaPartyMissing && <p className="mt-0.5 text-red-600">Select a Clearing Agent above</p>}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 pt-2 font-medium text-gray-700">{formatCurrency(v.netRent)}</td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={v.carrierPayable}
                    onChange={(e) => updateVehicle(v.key, "carrierPayable", e.target.value)}
                    className={`w-24 rounded border px-2 py-1 text-sm ${
                      v.carrierPayableExceedsNetRent ? "border-red-400" : "border-gray-300"
                    }`}
                  />
                  {v.carrierPayableExceedsNetRent && <p className="mt-1 text-xs text-red-600">Exceeds Net Rent</p>}
                </td>
                <td className={`px-2 py-1.5 pt-2 font-medium ${v.caPayableNegative ? "text-red-600" : "text-gray-700"}`}>
                  {formatCurrency(v.caPayable)}
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

      <div className="mt-5 flex flex-col items-end gap-1 border-t pt-4 text-sm">
        <div className="flex w-64 justify-between">
          <span className="text-gray-600">Total Rent</span>
          <span className="font-medium">{formatCurrency(totals.totalRent)}</span>
        </div>
        <div className="flex w-64 justify-between">
          <span className="text-gray-600">Total Delivery Charges</span>
          <span className="font-medium">{formatCurrency(totals.totalDeliveryCharges)}</span>
        </div>
        <div className="flex w-64 justify-between">
          <span className="text-gray-600">Total Net Rent</span>
          <span className="font-medium">{formatCurrency(totals.totalNetRent)}</span>
        </div>
        <div className="flex w-64 justify-between">
          <span className="text-gray-600">Total Carrier Payable</span>
          <span className="font-medium">{formatCurrency(totals.totalCarrierPayable)}</span>
        </div>
        <div className="flex w-64 justify-between border-t pt-1 font-semibold">
          <span>Total CA Payable</span>
          <span>{formatCurrency(totals.totalCaPayable)}</span>
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
          {saving ? "Saving..." : mode === "create" ? "Create Private Phonch" : "Update Private Phonch"}
        </button>
      </div>
    </form>
  );
}
