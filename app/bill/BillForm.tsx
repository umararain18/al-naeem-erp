"use client";

import { useEffect, useMemo, useState } from "react";

// ============================================================
// BILL BOOK - shared create/edit form
//
// Mirrors app/private-phonch/PrivatePhonchForm.tsx's own structure/
// patterns exactly (SearchableSelect, add/remove vehicle line, live
// totals). Business-specific difference: an optional Source Type +
// Source Document picker with a "Fetch Details" step that appends
// pre-populated (but still fully editable) vehicle rows from the
// chosen Private Phonch/Showroom Phonch vehicles - never required,
// a Bill may be entirely manual.
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

type SourceType = "PRIVATE_PHONCH" | "SHOWROOM_PHONCH";

type VehicleRow = {
  key: number;
  vehicleName: string;
  fromText: string;
  toText: string;
  engineNumber: string;
  chassisNumber: string;
  regdNumber: string;
  rent: string;
  delivery: string;
  otherExpense: string;
  source: { sourceType: SourceType; privatePhonchVehicleId?: string; phonchVehicleId?: string } | null;
};

function emptyVehicleRow(key: number): VehicleRow {
  return {
    key,
    vehicleName: "",
    fromText: "",
    toText: "",
    engineNumber: "",
    chassisNumber: "",
    regdNumber: "",
    rent: "",
    delivery: "",
    otherExpense: "",
    source: null,
  };
}

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type BillFormInitialItem = {
  vehicleName: string | null;
  fromText: string | null;
  toText: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  regdNumber: string | null;
  rent: string | number;
  delivery: string | number;
  otherExpense: string | number;
  sourceLink?: {
    sourceType: SourceType;
    privatePhonchVehicleId: string | null;
    phonchVehicleId: string | null;
  } | null;
};

export type BillFormInitialData = {
  billNo: string;
  date: string;
  clientPartyId: string | null;
  clientName: string;
  clientPhone: string | null;
  sourceType: SourceType | null;
  items: BillFormInitialItem[];
};

export default function BillForm({
  mode,
  billId,
  initialData,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit";
  billId?: string;
  initialData?: BillFormInitialData;
  onSaved: (bill: { id: string; billNo: string }) => void;
  onCancel?: () => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [parties, setParties] = useState<{ id: string; partyName: string; partyTypes: string[] }[]>([]);

  const [billNo, setBillNo] = useState(initialData?.billNo || "");
  const [date, setDate] = useState(
    initialData?.date ? initialData.date.slice(0, 10) : new Date().toISOString().slice(0, 10)
  );
  const [clientPartyId, setClientPartyId] = useState(initialData?.clientPartyId || "");
  const [clientName, setClientName] = useState(initialData?.clientName || "");
  const [clientPhone, setClientPhone] = useState(initialData?.clientPhone || "");

  const [sourceType, setSourceType] = useState<SourceType | "">(initialData?.sourceType || "");
  const [sourceDocs, setSourceDocs] = useState<{ id: string; phonchNo: string }[]>([]);
  const [sourceDocPick, setSourceDocPick] = useState("");
  const [sourceOptions, setSourceOptions] = useState<SearchOption[]>([]);
  const [fetching, setFetching] = useState(false);

  const initialVehicles: VehicleRow[] = initialData?.items.length
    ? initialData.items.map((item, index) => ({
        key: index,
        vehicleName: item.vehicleName || "",
        fromText: item.fromText || "",
        toText: item.toText || "",
        engineNumber: item.engineNumber || "",
        chassisNumber: item.chassisNumber || "",
        regdNumber: item.regdNumber || "",
        rent: Number(item.rent) > 0 ? String(Number(item.rent)) : "",
        delivery: Number(item.delivery) > 0 ? String(Number(item.delivery)) : "",
        otherExpense: Number(item.otherExpense) > 0 ? String(Number(item.otherExpense)) : "",
        source: item.sourceLink
          ? {
              sourceType: item.sourceLink.sourceType,
              privatePhonchVehicleId: item.sourceLink.privatePhonchVehicleId || undefined,
              phonchVehicleId: item.sourceLink.phonchVehicleId || undefined,
            }
          : null,
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

  const clientOptions: SearchOption[] = parties.map((p) => ({ value: p.id, label: p.partyName }));

  // Source document search - reuses the same search-as-you-type pattern,
  // scoped to whichever source type is currently selected.
  useEffect(() => {
    if (!sourceType) {
      setSourceOptions([]);
      return;
    }
    const endpoint = sourceType === "PRIVATE_PHONCH" ? "/api/private-phonch" : "/api/phonch";
    const timer = window.setTimeout(async () => {
      const res = await fetch(`${endpoint}?search=${encodeURIComponent(sourceDocPick)}`, { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        const list = data.items || [];
        setSourceOptions(
          list
            .filter((d: { id: string }) => !sourceDocs.some((s) => s.id === d.id))
            .map((d: { id: string; phonchNo: string }) => ({ value: d.id, label: d.phonchNo }))
        );
      }
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, sourceDocPick, sourceDocs]);

  function addSourceDoc(id: string) {
    const opt = sourceOptions.find((o) => o.value === id);
    if (!opt) return;
    setSourceDocs((docs) => [...docs, { id, phonchNo: opt.label }]);
    setSourceDocPick("");
  }

  function removeSourceDoc(id: string) {
    setSourceDocs((docs) => docs.filter((d) => d.id !== id));
  }

  async function fetchDetails() {
    if (!sourceType || sourceDocs.length === 0) return;
    setFetching(true);
    setError("");
    try {
      const ids = sourceDocs.map((d) => d.id).join(",");
      const res = await fetch(`/api/bill/fetch-source-vehicles?sourceType=${sourceType}&ids=${ids}`, { cache: "no-store" });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "Unable to fetch source vehicles");

      type FetchedVehicle = {
        sourceType: SourceType;
        id: string;
        phonchNo: string;
        vehicleName: string | null;
        chassisNumber: string | null;
        engineNumber: string | null;
        regdNumber: string | null;
        fromText: string | null;
        toText: string | null;
        rent: number;
        delivery: number;
        otherExpense: number;
        billed: { billId: string; billNo: string } | null;
      };

      const alreadyLinkedIds = new Set(
        vehicles
          .map((v) => v.source?.privatePhonchVehicleId || v.source?.phonchVehicleId)
          .filter((id): id is string => !!id)
      );

      const newRows: VehicleRow[] = [];
      let skippedCount = 0;
      let nk = nextKey;
      for (const v of data.vehicles as FetchedVehicle[]) {
        if (alreadyLinkedIds.has(v.id)) continue;
        if (v.billed) {
          skippedCount++;
          continue;
        }
        newRows.push({
          key: nk,
          vehicleName: v.vehicleName || "",
          fromText: v.fromText || "",
          toText: v.toText || "",
          engineNumber: v.engineNumber || "",
          chassisNumber: v.chassisNumber || "",
          regdNumber: v.regdNumber || "",
          rent: v.rent > 0 ? String(v.rent) : "",
          delivery: v.delivery > 0 ? String(v.delivery) : "",
          otherExpense: v.otherExpense > 0 ? String(v.otherExpense) : "",
          source:
            v.sourceType === "PRIVATE_PHONCH"
              ? { sourceType: "PRIVATE_PHONCH", privatePhonchVehicleId: v.id }
              : { sourceType: "SHOWROOM_PHONCH", phonchVehicleId: v.id },
        });
        nk++;
      }

      if (newRows.length === 0 && skippedCount === 0) {
        setError("No vehicles found for the selected document(s).");
      } else {
        setVehicles((rows) => {
          // Drop a single still-empty manual row before appending fetched ones.
          const base = rows.length === 1 && !rows[0].vehicleName && !rows[0].source ? [] : rows;
          return [...base, ...newRows];
        });
        setNextKey(nk);
        if (skippedCount > 0) {
          setError(`${skippedCount} vehicle(s) were skipped because they are already billed on another Bill.`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to fetch source vehicles");
    } finally {
      setFetching(false);
    }
  }

  function updateVehicle(key: number, field: keyof VehicleRow, value: string) {
    setVehicles((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function addLine() {
    setVehicles((rows) => [...rows, emptyVehicleRow(nextKey)]);
    setNextKey((k) => k + 1);
  }

  function removeLine(key: number) {
    setVehicles((rows) => (rows.length > 1 ? rows.filter((r) => r.key !== key) : rows));
  }

  const rowsWithDerived = useMemo(
    () =>
      vehicles.map((v) => {
        const rent = Number(v.rent) || 0;
        const delivery = Number(v.delivery) || 0;
        const otherExpense = Number(v.otherExpense) || 0;
        return { ...v, total: round2(rent + delivery + otherExpense) };
      }),
    [vehicles]
  );

  const billTotal = useMemo(() => round2(rowsWithDerived.reduce((s, v) => s + v.total, 0)), [rowsWithDerived]);

  function resetForm() {
    setBillNo("");
    setDate(new Date().toISOString().slice(0, 10));
    setClientPartyId("");
    setClientName("");
    setClientPhone("");
    setSourceType("");
    setSourceDocs([]);
    setVehicles([emptyVehicleRow(0)]);
    setNextKey(1);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (!clientName.trim()) {
      setError("Client Name is required");
      return;
    }
    if (billTotal <= 0) {
      setError("Bill Total must be greater than zero");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        billNo,
        date,
        clientPartyId: clientPartyId || undefined,
        clientName,
        clientPhone,
        ...(mode === "create" ? { idempotencyKey: crypto.randomUUID() } : {}),
        items: vehicles.map((v) => ({
          vehicleName: v.vehicleName,
          fromText: v.fromText,
          toText: v.toText,
          engineNumber: v.engineNumber,
          chassisNumber: v.chassisNumber,
          regdNumber: v.regdNumber,
          rent: Number(v.rent) || 0,
          delivery: Number(v.delivery) || 0,
          otherExpense: Number(v.otherExpense) || 0,
          source: v.source || undefined,
        })),
      };

      const response = await fetch(mode === "create" ? "/api/bill" : `/api/bill/${billId}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || `Unable to ${mode === "create" ? "create" : "update"} Bill`);
      }
      if (mode === "create") resetForm();
      onSaved(data.bill || { id: billId!, billNo });
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${mode === "create" ? "create" : "update"} Bill`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-gray-700">{mode === "create" ? "New Bill" : "Edit Bill"}</h2>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-4 md:grid-cols-4">
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Bill No.</span>
          <input
            value={billNo}
            onChange={(e) => setBillNo(e.target.value)}
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
          <span className="mb-1 block text-gray-600">Client</span>
          <SearchableSelect
            value={clientPartyId}
            options={clientOptions}
            placeholder="Search or type new client..."
            onChange={(val) => {
              setClientPartyId(val);
              const p = parties.find((pp) => pp.id === val);
              if (p) setClientName(p.partyName);
            }}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Client Name</span>
          <input
            value={clientName}
            onChange={(e) => {
              setClientName(e.target.value);
              setClientPartyId("");
            }}
            required
            placeholder="Type a new client name if not found above"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Phone</span>
          <input
            value={clientPhone}
            onChange={(e) => setClientPhone(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </label>
      </div>

      <div className="mt-5 rounded-lg border bg-gray-50 p-3">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">Link Type</span>
            <select
              value={sourceType}
              onChange={(e) => {
                setSourceType(e.target.value as SourceType | "");
                setSourceDocs([]);
              }}
              disabled={vehicles.some((v) => v.source)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
            >
              <option value="">Manual (no source)</option>
              <option value="PRIVATE_PHONCH">Private Phonch</option>
              <option value="SHOWROOM_PHONCH">Showroom Phonch</option>
            </select>
          </label>
          {sourceType && (
            <label className="block text-sm md:col-span-2">
              <span className="mb-1 block text-gray-600">Select Documents</span>
              <SearchableSelect
                value={sourceDocPick}
                options={sourceOptions}
                placeholder="Search Phonch No..."
                onChange={addSourceDoc}
              />
            </label>
          )}
        </div>
        {sourceDocs.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {sourceDocs.map((d) => (
              <span key={d.id} className="flex items-center gap-1 rounded-full border bg-white px-2 py-0.5 text-xs">
                {d.phonchNo}
                <button type="button" onClick={() => removeSourceDoc(d.id)} className="text-red-600 hover:underline">
                  ✕
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => void fetchDetails()}
              disabled={fetching}
              className="rounded-lg border bg-white px-3 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
            >
              {fetching ? "Fetching..." : "Fetch Details"}
            </button>
          </div>
        )}
      </div>

      <div className="mt-5">
        <span className="text-sm font-semibold text-gray-700">Vehicles</span>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1300px] text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-2 py-2">Sr</th>
              <th className="px-2 py-2">Vehicle</th>
              <th className="px-2 py-2">From</th>
              <th className="px-2 py-2">To</th>
              <th className="px-2 py-2">Engine</th>
              <th className="px-2 py-2">Chassis</th>
              <th className="px-2 py-2">Regd</th>
              <th className="px-2 py-2">Rent</th>
              <th className="px-2 py-2">Delivery</th>
              <th className="px-2 py-2">Other Expense</th>
              <th className="px-2 py-2">Total</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rowsWithDerived.map((v, idx) => (
              <tr key={v.key} className="align-top">
                <td className="px-2 py-1.5 text-gray-500">
                  {idx + 1}
                  {v.source && <div className="mt-1 text-xs text-blue-600">linked</div>}
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.vehicleName}
                    onChange={(e) => updateVehicle(v.key, "vehicleName", e.target.value)}
                    className="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.fromText}
                    onChange={(e) => updateVehicle(v.key, "fromText", e.target.value)}
                    className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.toText}
                    onChange={(e) => updateVehicle(v.key, "toText", e.target.value)}
                    className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
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
                    value={v.chassisNumber}
                    onChange={(e) => updateVehicle(v.key, "chassisNumber", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={v.regdNumber}
                    onChange={(e) => updateVehicle(v.key, "regdNumber", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={v.rent}
                    onChange={(e) => updateVehicle(v.key, "rent", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={v.delivery}
                    onChange={(e) => updateVehicle(v.key, "delivery", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={v.otherExpense}
                    onChange={(e) => updateVehicle(v.key, "otherExpense", e.target.value)}
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
                <td className="px-2 py-1.5 pt-2 font-medium text-gray-700">{formatCurrency(v.total)}</td>
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
        <div className="flex w-64 justify-between border-t pt-1 font-semibold">
          <span>Bill Total</span>
          <span>{formatCurrency(billTotal)}</span>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        {mode === "edit" && onCancel && (
          <button type="button" onClick={onCancel} className="rounded-lg border px-5 py-2 text-sm font-medium hover:bg-gray-50">
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-black px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {saving ? "Saving..." : mode === "create" ? "Create Bill" : "Update Bill"}
        </button>
      </div>
    </form>
  );
}
