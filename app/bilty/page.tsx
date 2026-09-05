"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type BiltyStatus = "PENDING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";

type Party = {
  id: string;
  partyName: string;
  phone: string | null;
  partyTypes: string[];
  account?: {
    id: string;
    accountCode: string | null;
    category: string;
    isActive: boolean;
  } | null;
};

type CommissionResponsibilityChoice = "CLEARING_AGENT" | "TRANSPORTER" | "THIRD_PARTY";

type Location = {
  id: string;
  name: string;
};

type Bilty = {
  id: string;
  biltyNo: string;
  date: string;
  fromLocation: Location;
  toLocation: Location;
  consignorParty: { id: string; partyName: string } | null;
  consigneeParty: { id: string; partyName: string } | null;
  paidResponsiblePartyId: string | null;
  consignorName: string;
  consignorPhone: string | null;
  consigneeName: string;
  consigneePhone: string | null;
  clearingAgentParty: { id: string; partyName: string } | null;
  clearingAgentName: string | null;
  vehicleType: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  registrationNumber: string | null;
  rent: number | null;
  insurance: number | null;
  expense: number | null;
  total: number | null;
  advance: number | null;
  toPay: number | null;
  agentParty: { id: string; partyName: string; account: { id: string; accountName: string } | null } | null;
  agentCommission: number | null;
  agentDescription: string | null;
  notes: string | null;
  status: BiltyStatus;
};

type SearchOption = {
  value: string;
  label: string;
  secondary?: string;
};

function SearchableSelect({
  value,
  options,
  placeholder,
  disabled = false,
  onChange,
  className = "w-full",
}: {
  value: string;
  options: SearchOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    setQuery(selected?.label || "");
  }, [value, selected?.label]);

  const filteredOptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return options;

    return options.filter((option) =>
      `${option.label} ${option.secondary || ""}`
        .toLowerCase()
        .includes(search)
    );
  }, [options, query]);

  return (
    <div className={`relative ${className}`}>
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
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 150);
        }}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
      />

      {open && !disabled && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(option.value);
                  setQuery(option.label);
                  setOpen(false);
                }}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-blue-50"
              >
                <div className="font-medium text-gray-900">{option.label}</div>
                {option.secondary && (
                  <div className="mt-0.5 text-xs text-gray-500">{option.secondary}</div>
                )}
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

export default function BiltyPage() {
  const [bilties, setBilties] = useState<Bilty[]>([]);

  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);

  const [updating, setUpdating] = useState(false);

  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [editingBilty, setEditingBilty] = useState<Bilty | null>(null);

  const [error, setError] = useState("");

  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");
  // Debounced so typing doesn't fire a server request per keystroke
  // now that search runs server-side (P2-3).
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  });

  // A drill-down link (e.g. Dashboard's Bilty status counts) may
  // deep-link straight to a status filter via ?status=PENDING.
  const [statusFilter, setStatusFilter] = useState<BiltyStatus | "ALL">(() => {
    if (typeof window === "undefined") return "ALL";
    const urlStatus = new URLSearchParams(window.location.search).get("status");
    return (urlStatus as BiltyStatus | null) || "ALL";
  });

  const [biltyNo, setBiltyNo] = useState("");

  const [date, setDate] = useState("");

  const [fromLocationId, setFromLocationId] = useState("");

  const [toLocationId, setToLocationId] = useState("");

  const [consignorPartyId, setConsignorPartyId] = useState("");

  const [consignorName, setConsignorName] = useState("");

  const [consignorPhone, setConsignorPhone] = useState("");

  const [consigneePartyId, setConsigneePartyId] = useState("");

  const [consigneeName, setConsigneeName] = useState("");

  const [consigneePhone, setConsigneePhone] = useState("");

  const [clearingAgentPartyId, setClearingAgentPartyId] = useState("");

  const [clearingAgentName, setClearingAgentName] = useState("");

  const [vehicleType, setVehicleType] = useState("");

  const [vehicleModel, setVehicleModel] = useState("");

  const [vehicleColor, setVehicleColor] = useState("");

  const [engineNumber, setEngineNumber] = useState("");

  const [chassisNumber, setChassisNumber] = useState("");

  const [registrationNumber, setRegistrationNumber] = useState("");

  const [agentPartyId, setAgentPartyId] = useState("");

  const [agentCommission, setAgentCommission] = useState("");

  const [agentDescription, setAgentDescription] = useState("");

  const [rent, setRent] = useState("");

  const [insurance, setInsurance] = useState("");

  const [expense, setExpense] = useState("");

  const [advance, setAdvance] = useState("");

  const [notes, setNotes] = useState("");

  const [parties, setParties] = useState<Party[]>([]);

  const [locations, setLocations] = useState<Location[]>([]);

  const [loadingParties, setLoadingParties] = useState(true);

  const [loadingLocations, setLoadingLocations] = useState(true);

  const [status, setStatus] = useState<BiltyStatus>("PENDING");

  // Commission Responsibility - only surfaced reactively when the
  // server reports that commission is being introduced on an
  // already-settled Bilty with no established responsible party.
  const [needsCommissionResponsibility, setNeedsCommissionResponsibility] = useState(false);
  const [commissionResponsibilityChoice, setCommissionResponsibilityChoice] =
    useState<CommissionResponsibilityChoice>("CLEARING_AGENT");
  const [commissionThirdPartyAccountId, setCommissionThirdPartyAccountId] = useState("");

  // Paid Amount Account - who is responsible for the Paid ("advance")
  // amount, when it is ambiguous between Consignor/Consignee (both
  // have valid accounts). Mirrors the existing paidResponsibility
  // backend field 1:1 - see app/api/bilty/route.ts and
  // app/api/bilty/[id]/route.ts. Never a separate field.
  const [paidResponsibility, setPaidResponsibility] = useState<"" | "CONSIGNOR" | "CONSIGNEE">("");

  const total = useMemo(() => {
    const r = Number(rent) || 0;
    const i = Number(insurance) || 0;
    const e = Number(expense) || 0;
    return r + i + e;
  }, [rent, insurance, expense]);

  const toPay = useMemo(() => {
    const t = total;
    const a = Number(advance) || 0;
    return Math.max(t - a, 0);
  }, [total, advance]);

  // Paid Amount Account resolution - mirrors the backend's own
  // resolveBiltyPaidResponsibleParty() rule exactly (see
  // lib/document-party-resolution.ts): a valid account is one that
  // is active and of category PARTY. Purely for deciding what to
  // show/require in the form - the backend remains authoritative.
  function hasValidPartyAccount(partyId: string): boolean {
    const party = parties.find((p) => p.id === partyId);
    return !!(party?.account && party.account.isActive && party.account.category === "PARTY");
  }

  const consignorAccountValid = consignorPartyId ? hasValidPartyAccount(consignorPartyId) : false;
  const consigneeAccountValid = consigneePartyId ? hasValidPartyAccount(consigneePartyId) : false;

  const paidAccountState = useMemo<
    "NOT_APPLICABLE" | "BOTH" | "CONSIGNOR_ONLY" | "CONSIGNEE_ONLY" | "NONE"
  >(() => {
    if ((Number(advance) || 0) <= 0) return "NOT_APPLICABLE";
    if (consignorAccountValid && consigneeAccountValid) return "BOTH";
    if (consignorAccountValid) return "CONSIGNOR_ONLY";
    if (consigneeAccountValid) return "CONSIGNEE_ONLY";
    return "NONE";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advance, consignorAccountValid, consigneeAccountValid]);

  const clearingAgentOptions = useMemo(
    () =>
      parties
        .filter((party) =>
          party.partyTypes.includes("CLEARING_AGENT")
        )
        .map((party) => ({
          value: party.id,
          label: party.partyName,
          secondary: party.phone || undefined,
        })),
    [parties]
  );

  const agentOptions = useMemo(
    () =>
      parties.map((party) => ({
        value: party.id,
        label: party.partyName,
        secondary: party.phone || undefined,
      })),
    [parties]
  );

  const partyOptions = useMemo(
    () =>
      parties.map((party) => ({
        value: party.id,
        label: party.partyName,
        secondary: party.phone || undefined,
      })),
    [parties]
  );

  // Active PARTY accounts only - used for "Other Party" commission
  // responsibility. Never Income/Expense/Asset/system accounts.
  const partyAccountOptions = useMemo(
    () =>
      parties
        .filter((party) => party.account && party.account.isActive && party.account.category === "PARTY")
        .map((party) => ({
          value: party.account!.id,
          label: party.partyName,
          secondary: party.account!.accountCode || undefined,
        })),
    [parties]
  );

  const locationOptions = useMemo(
    () =>
      locations.map((location) => ({
        value: location.id,
        label: location.name,
      })),
    [locations]
  );

  function resetForm() {
    setBiltyNo("");
    setDate("");
    setFromLocationId("");
    setToLocationId("");
    setConsignorPartyId("");
    setConsignorName("");
    setConsignorPhone("");
    setConsigneePartyId("");
    setConsigneeName("");
    setConsigneePhone("");
    setClearingAgentPartyId("");
    setClearingAgentName("");
    setVehicleType("");
    setVehicleModel("");
    setVehicleColor("");
    setEngineNumber("");
    setChassisNumber("");
    setRegistrationNumber("");
    setAgentPartyId("");
    setAgentCommission("");
    setAgentDescription("");
    setRent("");
    setInsurance("");
    setExpense("");
    setAdvance("");
    setNotes("");
    setStatus("PENDING");
    setNeedsCommissionResponsibility(false);
    setCommissionResponsibilityChoice("CLEARING_AGENT");
    setCommissionThirdPartyAccountId("");
    setPaidResponsibility("");
  }

  async function loadBilties() {
    try {
      setError("");
      setLoading(true);

      const query = new URLSearchParams();
      if (debouncedSearch) query.set("search", debouncedSearch);
      if (statusFilter !== "ALL") query.set("status", statusFilter);
      query.set("page", String(page));
      query.set("pageSize", String(pagination.pageSize));

      const response = await fetch(`/api/bilty?${query.toString()}`);

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to load bilties");
        return;
      }

      setBilties(data.bilties);
      if (data.pagination) setPagination(data.pagination);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  async function loadParties() {
    try {
      setLoadingParties(true);
      setError("");

      const response = await fetch("/api/parties");

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to load parties");
        return;
      }

      setParties(data.parties || []);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoadingParties(false);
    }
  }

  async function loadLocations() {
    try {
      setLoadingLocations(true);
      setError("");

      const response = await fetch("/api/locations");

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to load locations");
        return;
      }

      setLocations(data.locations || []);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoadingLocations(false);
    }
  }

  useEffect(() => {
    loadParties();
    loadLocations();
  }, []);

  // Debounce search input before it reaches the server (P2-3). Also
  // resets to page 1 in the same update, so the reload effect below
  // fires once with the final (search, page) pair instead of once
  // with a stale page and again once it resets.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    loadBilties();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, statusFilter, page]);

  function handleConsignorChange(value: string) {
    setConsignorPartyId(value);

    const party = parties.find((p) => p.id === value);

    if (party) {
      setConsignorName(party.partyName);
      setConsignorPhone(party.phone || "");
    } else {
      setConsignorName("");
      setConsignorPhone("");
    }
  }

  function handleConsigneeChange(value: string) {
    setConsigneePartyId(value);

    const party = parties.find((p) => p.id === value);

    if (party) {
      setConsigneeName(party.partyName);
      setConsigneePhone(party.phone || "");
    } else {
      setConsigneeName("");
      setConsigneePhone("");
    }
  }

  function handleClearingAgentChange(value: string) {
    setClearingAgentPartyId(value);

    const party = parties.find((p) => p.id === value);

    if (party) {
      setClearingAgentName(party.partyName);
    } else {
      setClearingAgentName("");
    }
  }

  function handleAgentChange(value: string) {
    setAgentPartyId(value);
  }

  async function handleCreateBilty(event: FormEvent) {
    event.preventDefault();

    setError("");
    setMessage("");

    if (Number(advance) > total) {
      setError("Advance cannot be greater than total");
      return;
    }

    if (paidAccountState === "BOTH" && !paidResponsibility) {
      setError(
        "Both Consignor and Consignee have Party accounts - please select who the Paid amount should be posted against."
      );
      return;
    }

    setCreating(true);

    try {
      const response = await fetch("/api/bilty", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          biltyNo,
          date,
          fromLocationId,
          toLocationId,
          consignorPartyId: consignorPartyId || undefined,
          consignorName,
          consignorPhone: consignorPhone || undefined,
          consigneePartyId: consigneePartyId || undefined,
          consigneeName,
          consigneePhone: consigneePhone || undefined,
          clearingAgentPartyId: clearingAgentPartyId || undefined,
          clearingAgentName: clearingAgentName || undefined,
          vehicleType: vehicleType || undefined,
          vehicleModel: vehicleModel || undefined,
          vehicleColor: vehicleColor || undefined,
          engineNumber: engineNumber || undefined,
          chassisNumber: chassisNumber || undefined,
          registrationNumber: registrationNumber || undefined,
          rent: rent === "" ? undefined : Number(rent),
          insurance: insurance === "" ? undefined : Number(insurance),
          expense: expense === "" ? undefined : Number(expense),
          advance: advance === "" ? undefined : Number(advance),
          ...(paidAccountState === "BOTH" && paidResponsibility
            ? { paidResponsibility }
            : {}),
          agentPartyId: agentPartyId || undefined,
          agentCommission: agentCommission === "" ? undefined : Number(agentCommission),
          agentDescription: agentDescription || undefined,
          notes: notes || undefined,
          status,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to create bilty");
        return;
      }

      setMessage("Bilty created successfully.");

      resetForm();

      await loadBilties();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setCreating(false);
    }
  }

  function startEditingBilty(bilty: Bilty) {
    setEditingBilty(bilty);

    setBiltyNo(bilty.biltyNo);
    setDate(bilty.date.split("T")[0]);
    setFromLocationId(bilty.fromLocation.id);
    setToLocationId(bilty.toLocation.id);
    setConsignorPartyId(bilty.consignorParty?.id || "");
    setConsignorName(bilty.consignorName);
    setConsignorPhone(bilty.consignorPhone || "");
    setConsigneePartyId(bilty.consigneeParty?.id || "");
    setConsigneeName(bilty.consigneeName);
    setConsigneePhone(bilty.consigneePhone || "");
    setClearingAgentPartyId(bilty.clearingAgentParty?.id || "");
    setClearingAgentName(bilty.clearingAgentName || "");
    setVehicleType(bilty.vehicleType || "");
    setVehicleModel(bilty.vehicleModel || "");
    setVehicleColor(bilty.vehicleColor || "");
    setEngineNumber(bilty.engineNumber || "");
    setChassisNumber(bilty.chassisNumber || "");
    setRegistrationNumber(bilty.registrationNumber || "");
    setAgentPartyId(bilty.agentParty?.id || "");
    setAgentCommission(bilty.agentCommission ? String(bilty.agentCommission) : "");
    setAgentDescription(bilty.agentDescription || "");
    setRent(bilty.rent ? String(bilty.rent) : "");
    setInsurance(bilty.insurance ? String(bilty.insurance) : "");
    setExpense(bilty.expense ? String(bilty.expense) : "");
    setAdvance(bilty.advance ? String(bilty.advance) : "");
    setNotes(bilty.notes || "");
    setStatus(bilty.status);

    setNeedsCommissionResponsibility(false);
    setCommissionResponsibilityChoice("CLEARING_AGENT");
    setCommissionThirdPartyAccountId("");

    // Show whichever side is already stored, when it still matches
    // one of the current Consignor/Consignee - never assume otherwise.
    if (bilty.paidResponsiblePartyId && bilty.paidResponsiblePartyId === bilty.consignorParty?.id) {
      setPaidResponsibility("CONSIGNOR");
    } else if (bilty.paidResponsiblePartyId && bilty.paidResponsiblePartyId === bilty.consigneeParty?.id) {
      setPaidResponsibility("CONSIGNEE");
    } else {
      setPaidResponsibility("");
    }

    setError("");
    setMessage("");

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  async function handleUpdateBilty(event: FormEvent) {
    event.preventDefault();

    if (!editingBilty) {
      return;
    }

    setError("");
    setMessage("");

    if (paidAccountState === "BOTH" && !paidResponsibility) {
      setError(
        "Both Consignor and Consignee have Party accounts - please select who the Paid amount should be posted against."
      );
      return;
    }

    setUpdating(true);

    try {
      const response = await fetch(`/api/bilty/${editingBilty.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          biltyNo,
          date,
          fromLocationId,
          toLocationId,
          consignorPartyId: consignorPartyId === undefined ? undefined : consignorPartyId,
          consignorName,
          consignorPhone: consignorPhone === undefined ? undefined : consignorPhone,
          consigneePartyId: consigneePartyId === undefined ? undefined : consigneePartyId,
          consigneeName,
          consigneePhone: consigneePhone === undefined ? undefined : consigneePhone,
          clearingAgentPartyId: clearingAgentPartyId === undefined ? undefined : clearingAgentPartyId,
          clearingAgentName: clearingAgentName === undefined ? undefined : clearingAgentName,
          vehicleType: vehicleType === undefined ? undefined : vehicleType,
          vehicleModel: vehicleModel === undefined ? undefined : vehicleModel,
          vehicleColor: vehicleColor === undefined ? undefined : vehicleColor,
          engineNumber: engineNumber === undefined ? undefined : engineNumber,
          chassisNumber: chassisNumber === undefined ? undefined : chassisNumber,
          registrationNumber: registrationNumber === undefined ? undefined : registrationNumber,
          rent: rent === "" ? 0 : Number(rent),
          insurance: insurance === "" ? 0 : Number(insurance),
          expense: expense === "" ? 0 : Number(expense),
          advance: advance === "" ? 0 : Number(advance),
          ...(paidAccountState === "BOTH" && paidResponsibility
            ? { paidResponsibility }
            : {}),
          agentPartyId: agentPartyId === undefined ? undefined : agentPartyId,
          agentCommission: agentCommission === "" ? 0 : Number(agentCommission),
          agentDescription: agentDescription === undefined ? undefined : agentDescription,
          notes: notes === undefined ? undefined : notes,
          ...(needsCommissionResponsibility
            ? {
                commissionResponsibility: {
                  responsibility: commissionResponsibilityChoice,
                  thirdPartyAccountId:
                    commissionResponsibilityChoice === "THIRD_PARTY"
                      ? commissionThirdPartyAccountId
                      : undefined,
                },
              }
            : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.requiresCommissionResponsibility) {
          setNeedsCommissionResponsibility(true);
          setError(
            "This Bilty is already settled and has no established party for Commission yet. Please choose who is responsible below, then save again."
          );
          return;
        }

        setError(data.message || "Unable to update bilty");
        return;
      }

      setMessage("Bilty updated successfully.");

      setEditingBilty(null);

      resetForm();

      await loadBilties();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setUpdating(false);
    }
  }

  function cancelEdit() {
    setEditingBilty(null);
    resetForm();
    setError("");
    setMessage("");
  }

  async function deleteBilty(bilty: Bilty) {
    const confirmed = window.confirm(
      `Are you sure you want to move "${bilty.biltyNo}" to Bin?`
    );

    if (!confirmed) {
      return;
    }

    setActionLoading(bilty.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/bilty/${bilty.id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError(data.message || "Unable to delete bilty");
        return;
      }

      setMessage(data.message || "Bilty moved to Bin successfully.");

      await loadBilties();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  // Search/status filtering now happens server-side (P2-3) - the
  // API already returns exactly this page's matching Bilties.
  const filteredBilties = bilties;

  const statusColors: Record<BiltyStatus, string> = {
    PENDING: "text-yellow-600",
    IN_TRANSIT: "text-blue-600",
    DELIVERED: "text-green-600",
    CANCELLED: "text-red-600",
  };

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Bilty</h1>
          <p className="text-gray-600">Manage transport bilties and shipments.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* FORM */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-semibold mb-5">
              {editingBilty ? "Edit Bilty" : "New Bilty"}
            </h2>

            <form
              onSubmit={editingBilty ? handleUpdateBilty : handleCreateBilty}
              className="space-y-4"
            >
              <input
                type="text"
                placeholder="Bilty No."
                value={biltyNo}
                onChange={(e) => setBiltyNo(e.target.value)}
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full border rounded-lg px-4 py-3 bg-white"
                required
              />

              <SearchableSelect
                value={fromLocationId}
                options={locationOptions}
                placeholder={loadingLocations ? "Loading locations..." : "Select From Location"}
                disabled={loadingLocations}
                onChange={setFromLocationId}
              />

              <SearchableSelect
                value={toLocationId}
                options={locationOptions}
                placeholder={loadingLocations ? "Loading locations..." : "Select To Location"}
                disabled={loadingLocations}
                onChange={setToLocationId}
              />

              <p className="text-xs text-gray-500 -mt-2">
                From and To locations are required.
              </p>

              <div>
                <p className="text-sm font-medium mb-2">Consignor</p>

                <SearchableSelect
                  value={consignorPartyId}
                  options={partyOptions}
                  placeholder={loadingParties ? "Loading parties..." : "Search party (optional)..."}
                  disabled={loadingParties}
                  onChange={handleConsignorChange}
                />

                <input
                  type="text"
                  placeholder="Consignor Name"
                  value={consignorName}
                  onChange={(e) => setConsignorName(e.target.value)}
                  className="w-full border rounded-lg px-4 py-3 mt-2"
                />

                <input
                  type="text"
                  placeholder="Consignor Phone"
                  value={consignorPhone}
                  onChange={(e) => setConsignorPhone(e.target.value)}
                  className="w-full border rounded-lg px-4 py-3 mt-2"
                />
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Consignee</p>

                <SearchableSelect
                  value={consigneePartyId}
                  options={partyOptions}
                  placeholder={loadingParties ? "Loading parties..." : "Search party (optional)..."}
                  disabled={loadingParties}
                  onChange={handleConsigneeChange}
                />

                <input
                  type="text"
                  placeholder="Consignee Name"
                  value={consigneeName}
                  onChange={(e) => setConsigneeName(e.target.value)}
                  className="w-full border rounded-lg px-4 py-3 mt-2"
                />

                <input
                  type="text"
                  placeholder="Consignee Phone"
                  value={consigneePhone}
                  onChange={(e) => setConsigneePhone(e.target.value)}
                  className="w-full border rounded-lg px-4 py-3 mt-2"
                />
              </div>

              <SearchableSelect
                value={clearingAgentPartyId}
                options={clearingAgentOptions}
                placeholder={loadingParties ? "Loading parties..." : "Search clearing agent (optional)..."}
                disabled={loadingParties}
                onChange={handleClearingAgentChange}
              />

              <p className="text-xs text-gray-500 -mt-2">
                Only parties marked as Clearing Agent / Delivery Point are shown.
              </p>

              <div>
                <p className="text-sm font-medium mb-2">Vehicle Details</p>

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Vehicle Type"
                    value={vehicleType}
                    onChange={(e) => setVehicleType(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="text"
                    placeholder="Vehicle Model"
                    value={vehicleModel}
                    onChange={(e) => setVehicleModel(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="text"
                    placeholder="Vehicle Color"
                    value={vehicleColor}
                    onChange={(e) => setVehicleColor(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="text"
                    placeholder="Registration No."
                    value={registrationNumber}
                    onChange={(e) => setRegistrationNumber(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="text"
                    placeholder="Engine Number"
                    value={engineNumber}
                    onChange={(e) => setEngineNumber(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="text"
                    placeholder="Chassis Number"
                    value={chassisNumber}
                    onChange={(e) => setChassisNumber(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Freight & Expenses</p>

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Rent"
                    value={rent}
                    onChange={(e) => setRent(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Insurance"
                    value={insurance}
                    onChange={(e) => setInsurance(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Expense"
                    value={expense}
                    onChange={(e) => setExpense(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />

                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Advance"
                    value={advance}
                    onChange={(e) => setAdvance(e.target.value)}
                    className="w-full border rounded-lg px-4 py-3"
                  />
                </div>

                <div className="mt-2 rounded-lg bg-gray-50 p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Total</span>
                    <span className="font-semibold">Rs. {total.toFixed(2)}</span>
                  </div>

                  <div className="flex justify-between mt-1">
                    <span className="text-gray-600">To Pay</span>
                    <span className="font-semibold">Rs. {toPay.toFixed(2)}</span>
                  </div>
                </div>

                {editingBilty && (
                  <p className="mt-2 text-xs text-amber-600">
                    This Bilty has accounting activity. Changing Rent/Insurance/Expense
                    will automatically create an accounting adjustment. Existing
                    payment history will not be removed.
                  </p>
                )}

                {paidAccountState === "BOTH" && (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
                    <p className="text-sm font-medium mb-1">Paid Amount Account</p>
                    <p className="text-xs text-gray-600 mb-2">
                      Paid amount kis account mein post karna hai?
                    </p>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="paidResponsibility"
                          checked={paidResponsibility === "CONSIGNOR"}
                          onChange={() => setPaidResponsibility("CONSIGNOR")}
                        />
                        Consignor — {consignorName || "Party A"}
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="paidResponsibility"
                          checked={paidResponsibility === "CONSIGNEE"}
                          onChange={() => setPaidResponsibility("CONSIGNEE")}
                        />
                        Consignee — {consigneeName || "Party B"}
                      </label>
                    </div>
                  </div>
                )}

                {paidAccountState === "CONSIGNOR_ONLY" && (
                  <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
                    <span className="font-medium">Paid Amount Account</span>
                    <br />
                    ✓ Consignor — {consignorName || "Party A"}
                    <span className="text-xs text-gray-600"> (Automatically selected)</span>
                  </div>
                )}

                {paidAccountState === "CONSIGNEE_ONLY" && (
                  <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
                    <span className="font-medium">Paid Amount Account</span>
                    <br />
                    ✓ Consignee — {consigneeName || "Party B"}
                    <span className="text-xs text-gray-600"> (Automatically selected)</span>
                  </div>
                )}

                {paidAccountState === "NONE" && (
                  <div className="mt-3 rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm text-gray-600">
                    <span className="font-medium text-gray-800">Paid Amount Account</span>
                    <br />
                    ⚠ Not resolved — neither Consignor nor Consignee has a Party account
                    yet. The Paid amount will remain recorded on the Bilty without a
                    Party attribution until one is available.
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Commission / Referral</p>

                <SearchableSelect
                  value={agentPartyId}
                  options={agentOptions}
                  placeholder={loadingParties ? "Loading parties..." : "Search agent/referral party (optional)..."}
                  disabled={loadingParties}
                  onChange={handleAgentChange}
                />

                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Commission"
                  value={agentCommission}
                  onChange={(e) => setAgentCommission(e.target.value)}
                  className="w-full border rounded-lg px-4 py-3 mt-2"
                />

                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={agentDescription}
                  onChange={(e) => setAgentDescription(e.target.value)}
                  className="w-full border rounded-lg px-4 py-3 mt-2"
                />

                {editingBilty && Number(agentCommission || 0) > 0 && (
                  <p className="mt-2 text-xs text-amber-600">
                    This Bilty has accounting activity. Changes will automatically
                    create an accounting adjustment. Existing payment history will
                    not be removed.
                  </p>
                )}

                {needsCommissionResponsibility && (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
                    <p className="text-sm font-medium mb-2">
                      Who is responsible for this commission?
                    </p>
                    <div className="flex flex-wrap gap-4 mb-2">
                      {(
                        [
                          ["CLEARING_AGENT", "Clearing Agent"],
                          ["TRANSPORTER", "Driver / Transporter"],
                          ["THIRD_PARTY", "Other Party"],
                        ] as [CommissionResponsibilityChoice, string][]
                      ).map(([value, label]) => (
                        <label key={value} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="commissionResponsibility"
                            checked={commissionResponsibilityChoice === value}
                            onChange={() => setCommissionResponsibilityChoice(value)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    {commissionResponsibilityChoice === "THIRD_PARTY" && (
                      <SearchableSelect
                        value={commissionThirdPartyAccountId}
                        options={partyAccountOptions}
                        placeholder="Search party..."
                        onChange={setCommissionThirdPartyAccountId}
                      />
                    )}
                  </div>
                )}
              </div>

              <textarea
                placeholder="Notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full border rounded-lg px-4 py-3"
              />

              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as BiltyStatus)}
                disabled={editingBilty !== null}
                className="w-full border rounded-lg px-4 py-3 bg-white disabled:bg-gray-100"
              >
                <option value="PENDING">Pending</option>
                <option value="IN_TRANSIT">In Transit</option>
                <option value="DELIVERED">Delivered</option>
                <option value="CANCELLED">Cancelled</option>
              </select>

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              {message && (
                <p className="text-sm text-green-600">{message}</p>
              )}

              <button
                type="submit"
                disabled={creating || updating}
                className="w-full bg-black text-white py-3 rounded-lg disabled:opacity-50"
              >
                {editingBilty
                  ? updating
                    ? "Updating..."
                    : "Update Bilty"
                  : creating
                    ? "Creating..."
                    : "Create Bilty"}
              </button>

              {editingBilty && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="w-full border py-3 rounded-lg hover:bg-gray-50"
                >
                  Cancel Edit
                </button>
              )}
            </form>
          </section>

          {/* LIST */}

          <section className="lg:col-span-2 bg-white rounded-xl shadow-sm p-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
              <div>
                <h2 className="text-xl font-semibold">All Bilties</h2>
                <p className="text-sm text-gray-500">
                  {pagination.total} {pagination.total === 1 ? "bilty" : "bilties"}
                </p>
              </div>

              <button
                onClick={loadBilties}
                className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
            </div>

            <div className="mb-5">
              <input
                type="text"
                placeholder="Search bilty no, consignor, consignee, location, vehicle or agent..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full border rounded-lg px-4 py-3"
              />
            </div>

            <div className="mb-5">
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(
                    e.target.value as BiltyStatus | "ALL"
                  );
                  setPage(1);
                }}
                className="border rounded-lg px-4 py-3 bg-white"
              >
                <option value="ALL">All Statuses</option>
                <option value="PENDING">Pending</option>
                <option value="IN_TRANSIT">In Transit</option>
                <option value="DELIVERED">Delivered</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>

            {loading ? (
              <p className="text-gray-500">Loading bilties...</p>
            ) : filteredBilties.length === 0 ? (
              <p className="text-gray-500">
                {search ? "No matching bilties found." : "No bilties found."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-3 pr-4">Bilty No</th>
                      <th className="py-3 pr-4">Date</th>
                      <th className="py-3 pr-4">Route</th>
                      <th className="py-3 pr-4">Consignor</th>
                      <th className="py-3 pr-4">Consignee</th>
                      <th className="py-3 pr-4">Vehicle / Reg</th>
                      <th className="py-3 pr-4">Clearing Agent</th>
                      <th className="py-3 pr-4">Rent</th>
                      <th className="py-3 pr-4">Advance</th>
                      <th className="py-3 pr-4">To Pay</th>
                      <th className="py-3 pr-4">Status</th>
                      <th className="py-3 pr-4">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBilties.map((bilty) => (
                      <tr key={bilty.id} className="border-b">
                        <td className="py-3 pr-4">
                          <div className="font-medium">{bilty.biltyNo}</div>
                        </td>

                        <td className="py-3 pr-4">
                          {new Date(bilty.date).toLocaleDateString()}
                        </td>

                        <td className="py-3 pr-4">
                          {bilty.fromLocation.name} → {bilty.toLocation.name}
                        </td>

                        <td className="py-3 pr-4">{bilty.consignorName}</td>

                        <td className="py-3 pr-4">{bilty.consigneeName}</td>

                        <td className="py-3 pr-4">
                          {bilty.vehicleType
                            ? `${bilty.vehicleType}${bilty.registrationNumber ? ` / ${bilty.registrationNumber}` : ""}`
                            : bilty.registrationNumber || "-"}
                        </td>

                        <td className="py-3 pr-4">
                          {bilty.clearingAgentParty?.partyName ||
                            bilty.clearingAgentName ||
                            "-"}
                        </td>

                        <td className="py-3 pr-4">
                          Rs. {Number(bilty.rent || 0).toLocaleString()}
                        </td>

                        <td className="py-3 pr-4">
                          Rs. {Number(bilty.advance || 0).toLocaleString()}
                        </td>

                        <td className="py-3 pr-4">
                          Rs. {Number(bilty.toPay || 0).toLocaleString()}
                        </td>

                        <td className="py-3 pr-4">
                          <span className={statusColors[bilty.status]}>
                            {bilty.status.replace("_", " ")}
                          </span>
                        </td>

                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={`/bilty/${bilty.id}`}
                              className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50"
                            >
                              View
                            </Link>

                            <button
                              type="button"
                              onClick={() => startEditingBilty(bilty)}
                              className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50"
                            >
                              Edit
                            </button>

                            <button
                              type="button"
                              disabled={actionLoading === bilty.id}
                              onClick={() => deleteBilty(bilty)}
                              className="border border-red-300 text-red-600 rounded-lg px-3 py-1 text-sm hover:bg-red-50 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={pagination.page <= 1}
                  className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-500">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                  disabled={pagination.page >= pagination.totalPages}
                  className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
