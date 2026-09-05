"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getChallanShareMessage } from "@/lib/share-messages";
import { normalizePhone } from "@/lib/phone";
import FinalSettlementOperations from "./FinalSettlementOperations";

type PartyRef = {
  id: string;
  partyName: string;
  account?: { id: string; accountName: string } | null;
} | null;

export type Bilty = {
  id: string;
  biltyNo: string;
  fromLocation: { id: string; name: string };
  toLocation: { id: string; name: string };
  consigneeName: string;
  vehicleType: string | null;
  vehicleModel: string | null;
  registrationNumber: string | null;
  total: number | null;
  advance: number | null;
  toPay: number | null;
  paidResponsiblePartyId: string | null;
  consignorParty: PartyRef;
  consigneeParty: PartyRef;
  clearingAgentParty: PartyRef;
  agentParty: PartyRef;
  agentCommission: number | null;
};

// Mirrors lib/bilty-paid-verification.ts's BiltyPaidVerificationState -
// a pure read, never recomputed client-side.
export type BiltyPaidVerification = {
  biltyId: string;
  paidAmount: number;
  responsiblePartyAccountId: string | null;
  responsiblePartyName: string | null;
  verifiedReceivedAmount: number;
  unverifiedAmount: number;
  isInconsistent: boolean;
};

type ChallanStatus = "IN_TRANSIT" | "DELIVERED" | "CANCELLED";

type SettlementLine = {
  debit: number;
  credit: number;
  description: string | null;
  sourceNumber: string | null;
  account: {
    id: string;
    accountName: string;
    category: string;
    party: { id: string; partyName: string } | null;
  };
};

export type Challan = {
  id: string;
  challanNo: string;
  loadingDate: string;
  status: ChallanStatus;
  transporterParty: (PartyRef & { phone?: string | null; whatsapp?: string | null }) | null;
  driverName: string | null;
  driverPhone: string | null;
  carrierNumber: string | null;
  carrierRent: number | null;
  remarks: string | null;
  isSettled: boolean;
  settledAt: string | null;
  settlementNotes: string | null;
  settlementJournalEntryId: string | null;
  settlementJournalEntry: { id: string; lines: SettlementLine[] } | null;
  bilties: {
    bilty: Bilty;
  }[];
  financials?: {
    receivable: number;
    payable: number;
    received: number;
    paid: number;
    remainingReceivable: number;
    remainingPayable: number;
    excessReceived: number;
    excessPaid: number;
    isCleared: boolean;
    status: "OPEN" | "PARTIALLY_CLEARED" | "CLEARED" | "OVERPAID";
  } | null;
  // Purely informational - who the receivable/payable totals above
  // belong to. Never used to recalculate an amount.
  responsibleParties?: {
    receivable: { accountId: string; partyId: string; partyName: string }[];
    payable: { accountId: string; partyId: string; partyName: string }[];
  };
  // Purely informational (read-only) current per-component
  // responsibility, used only to pre-fill the Super Admin "Edit
  // Settlement" form with what is already established in the
  // ledger. Never used to recalculate an amount.
  settlementBreakdown?: {
    carrierRent: ResponsibilityChoiceUI | null;
    bilties: Record<string, { collection: ResponsibilityChoiceUI | null; commission: ResponsibilityChoiceUI | null }>;
  } | null;
  // Paid ("advance") verification - derived, read-only, straight from
  // lib/bilty-paid-verification.ts via the Challan GET response. Never
  // recomputed here; Final Settlement only displays it.
  paidVerification?: {
    perBilty: Record<string, BiltyPaidVerification>;
    aggregate: { paidAmount: number; verifiedReceivedAmount: number; unverifiedAmount: number; hasInconsistency: boolean };
  };
  // Dimensionally-separated settlement summary (Bilty Rent / To-Pay /
  // Carrier Rent, never blended into one Receivable/Payable number) -
  // the same authoritative source Final Settlement itself reads, via
  // lib/challan-settlement-summary.ts. Replaces the old
  // financials/responsibleParties pair for the Financial Summary card.
  settlementSummary?: SettlementSummary | null;
};

export type SettlementPayerBreakdown = {
  accountId: string;
  partyId: string | null;
  partyName: string;
  amount: number;
};

export type ComponentSummaryUI = {
  total: number;
  paidOrReceived: number;
  remaining: number;
  payers: SettlementPayerBreakdown[];
  isHistoricalFallback: boolean;
  // Carrier Rent only: the economic residual claimant for the unpaid
  // remainder (see lib/challan-settlement-summary.ts). Present only
  // when remaining > 0 and safely resolved - never a guess.
  residualPartyName?: string;
};

export type PartyNetEntryUI = {
  accountId: string;
  partyId: string | null;
  partyName: string;
  net: number;
  direction: "RECEIVABLE" | "PAYABLE";
};

export type SettlementSummary = {
  challanId: string;
  bilties: {
    biltyId: string;
    biltyNo: string;
    rent: number;
    paidAmount: number;
    paidVerified: number;
    paidUnverified: number;
    paidResponsiblePartyName: string | null;
    paidIsInconsistent: boolean;
    toPay: ComponentSummaryUI;
  }[];
  carrierRent: ComponentSummaryUI;
  // Cross-component party net position(s) - NEVER Carrier Rent or
  // To-Pay due, never blended with either. See
  // lib/challan-settlement-summary.ts's own doc comment.
  partyNet: PartyNetEntryUI[];
};

type ResponsibilityChoiceUI = {
  responsibility: "CLEARING_AGENT" | "TRANSPORTER" | "ANC" | "THIRD_PARTY";
  thirdPartyAccountId: string | null;
};

// Combines a payer breakdown that may span several Bilties (e.g. the
// Challan-level "To-Pay" tile aggregates each Bilty's own Collection
// payers) into one list, summing amounts for a party that appears
// more than once rather than listing them twice.
function mergePayers(payers: SettlementPayerBreakdown[]): SettlementPayerBreakdown[] {
  const byAccount = new Map<string, SettlementPayerBreakdown>();
  for (const p of payers) {
    const existing = byAccount.get(p.accountId);
    if (existing) existing.amount += p.amount;
    else byAccount.set(p.accountId, { ...p });
  }
  return [...byAccount.values()];
}

// Compact multi-party display - never collapses several distinct
// payers into a single invented "the" party. One party: name only.
// Several: a short per-party amount list.
function PayersList({ payers, label }: { payers: SettlementPayerBreakdown[]; label: string }) {
  if (payers.length === 0) return null;
  if (payers.length === 1) {
    const p = payers[0];
    return (
      <p className="mt-1 text-xs text-gray-500">
        {label}:{" "}
        {p.partyId ? (
          <Link href={`/parties/${p.partyId}/ledger`} className="text-blue-600 hover:underline">
            {p.partyName}
          </Link>
        ) : (
          p.partyName
        )}
      </p>
    );
  }
  return (
    <div className="mt-1 text-xs text-gray-500">
      <p>{label}: {payers.length} parties</p>
      <ul className="mt-0.5 space-y-0.5">
        {payers.map((p) => (
          <li key={p.accountId} className="flex justify-between gap-2">
            <span>{p.partyId ? <Link href={`/parties/${p.partyId}/ledger`} className="text-blue-600 hover:underline">{p.partyName}</Link> : p.partyName}</span>
            <span>Rs. {p.amount.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClearedOrDueBadge({ remaining, total }: { remaining: number; total: number }) {
  if (total <= 0.009) return null;
  if (remaining <= 0.009) {
    return <span className="text-xs font-semibold text-green-700">CLEARED ✓</span>;
  }
  return <span className="text-xs font-semibold text-amber-700">DUE Rs. {remaining.toLocaleString()}</span>;
}

// The dimensionally-separated Financial Summary tiles - Bilty Rent /
// Paid (+ Verified/Unverified) / To-Pay (Due/Received/Remaining) /
// Carrier Rent (Due/Paid/Remaining). Sourced entirely from
// challan.settlementSummary (lib/challan-settlement-summary.ts) and
// challan.paidVerification (unchanged, existing) - never recomputed
// here. Works for both an unsettled and a settled Challan; a
// Challan with no settlementSummary yet (still loading) renders
// nothing rather than guessing.
function FinancialSummaryCards({ challan }: { challan: Challan }) {
  const summary = challan.settlementSummary;
  if (!summary) return <p className="text-sm text-gray-500">Loading...</p>;

  const rentTotal = challan.bilties.reduce((sum, cb) => sum + Number(cb.bilty.total || 0), 0);
  const pv = challan.paidVerification?.aggregate;

  const toPayDue = summary.bilties.reduce((s, b) => s + b.toPay.total, 0);
  const toPayReceived = summary.bilties.reduce((s, b) => s + b.toPay.paidOrReceived, 0);
  const toPayRemaining = summary.bilties.reduce((s, b) => s + b.toPay.remaining, 0);
  const toPayPayers = mergePayers(summary.bilties.flatMap((b) => b.toPay.payers));

  const cr = summary.carrierRent;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="rounded-lg border p-3">
        <p className="text-xs text-gray-500">Bilty Rent</p>
        <p className="font-semibold text-lg">Rs. {rentTotal.toLocaleString()}</p>
      </div>

      <div className="rounded-lg border p-3">
        <p className="text-xs text-gray-500">Paid</p>
        <p className="font-semibold text-lg">Rs. {(pv?.paidAmount || 0).toLocaleString()}</p>
        {(pv?.paidAmount || 0) > 0 && (
          <p className="mt-1 text-xs">
            {(pv?.unverifiedAmount || 0) > 0.009 ? (
              <span className="font-semibold text-amber-700">🟡 Paid but Not Received: Rs. {(pv?.unverifiedAmount || 0).toLocaleString()}</span>
            ) : (
              <span className="font-semibold text-green-700">🟢 Paid Verified</span>
            )}
          </p>
        )}
        {pv?.hasInconsistency && (
          <p className="mt-1 text-xs text-red-600">⚠ Verification inconsistency</p>
        )}
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">To-Pay</p>
          <ClearedOrDueBadge remaining={toPayRemaining} total={toPayDue} />
        </div>
        <p className="font-semibold text-lg">Rs. {toPayDue.toLocaleString()}</p>
        <p className="mt-1 text-xs text-gray-600">Received: Rs. {toPayReceived.toLocaleString()}</p>
        <PayersList payers={toPayPayers} label="Collected by" />
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">Carrier Rent</p>
          <ClearedOrDueBadge remaining={cr.remaining} total={cr.total} />
        </div>
        <p className="font-semibold text-lg">Rs. {cr.total.toLocaleString()}</p>
        <p className="mt-1 text-xs text-gray-600">Paid: Rs. {cr.paidOrReceived.toLocaleString()}</p>
        <PayersList payers={cr.payers} label="Paid by" />
        {cr.remaining > 0.009 && cr.residualPartyName && (
          <p className="mt-1 text-xs text-gray-500">Payable to: {cr.residualPartyName}</p>
        )}
      </div>
    </div>
  );
}

// Cross-component PARTY NET POSITION - deliberately a SEPARATE block
// from the component tiles above (never a 5th tile inside that grid,
// never merged into Carrier Rent/To-Pay's own remaining figure). A
// party's net here reflects their TOTAL Collection + Carrier Rent
// position on this Challan (see lib/challan-settlement-summary.ts) -
// e.g. a Clearing Agent who collected more than they paid out in
// Carrier Rent shows as a receivable here even when both components
// are individually CLEARED above. Renders nothing when every party's
// net is zero - never fabricates a balance.
function PartyNetPosition({ challan }: { challan: Challan }) {
  const partyNet = challan.settlementSummary?.partyNet || [];
  if (partyNet.length === 0) return null;

  return (
    <div className="rounded-lg border p-4 bg-gray-50 mt-4">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Party Net Position</p>
      <div className="space-y-2">
        {partyNet.map((p) => (
          <div key={p.accountId} className="flex items-center justify-between text-sm">
            <span>
              {p.direction === "RECEIVABLE" ? "Receivable from" : "Payable to"}{" "}
              {p.partyId ? (
                <Link href={`/parties/${p.partyId}/ledger`} className="text-blue-600 hover:underline font-medium">
                  {p.partyName}
                </Link>
              ) : (
                <span className="font-medium">{p.partyName}</span>
              )}
            </span>
            <span className={`font-semibold ${p.direction === "RECEIVABLE" ? "text-blue-700" : "text-purple-700"}`}>
              Rs. {Math.abs(p.net).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Party responsibility type still used by the Edit Challan form's
// Carrier Rent responsibility picker (unrelated to Final Settlement,
// which now lives entirely in FinalSettlementOperations.tsx).
// ============================================================

type CarrierRentResponsibility = "CLEARING_AGENT" | "ANC" | "THIRD_PARTY";

export type PartyAccountOption = {
  accountId: string;
  partyName: string;
  accountCode: string | null;
};

// A small searchable dropdown restricted to active PARTY accounts,
// used for every "Third Party / Other" selection (Part 4).
export function PartyAccountSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: PartyAccountOption[];
  placeholder: string;
  onChange: (accountId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = options.find((o) => o.accountId === value);

  useEffect(() => {
    setQuery(selected ? selected.partyName : "");
  }, [value, selected?.partyName]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.partyName} ${o.accountCode || ""}`.toLowerCase().includes(q)
    );
  }, [options, query]);

  return (
    <div className="relative w-full">
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (value) onChange("");
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
      />
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-56 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-sm text-gray-500">No party found.</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.accountId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o.accountId);
                  setQuery(o.partyName);
                  setOpen(false);
                }}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-blue-50"
              >
                <div className="font-medium text-gray-900">{o.partyName}</div>
                {o.accountCode && (
                  <div className="text-xs text-gray-500">{o.accountCode}</div>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function ChallanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [challan, setChallan] = useState<Challan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // ------------------------------------------------------------
  // EDIT
  // ------------------------------------------------------------
  const [showEditForm, setShowEditForm] = useState(false);
  const [editLoadingDate, setEditLoadingDate] = useState("");
  const [editTransporterPartyId, setEditTransporterPartyId] = useState("");
  const [editDriverName, setEditDriverName] = useState("");
  const [editDriverPhone, setEditDriverPhone] = useState("");
  const [editCarrierNumber, setEditCarrierNumber] = useState("");
  const [editCarrierRent, setEditCarrierRent] = useState("");
  const [editRemarks, setEditRemarks] = useState("");
  const [transporters, setTransporters] = useState<{ id: string; partyName: string }[]>([]);

  const [biltySearchTerm, setBiltySearchTerm] = useState("");
  const [biltySearchResults, setBiltySearchResults] = useState<Bilty[]>([]);
  const [biltiesToAdd, setBiltiesToAdd] = useState<Bilty[]>([]);
  const [biltyIdsToRemove, setBiltyIdsToRemove] = useState<Set<string>>(new Set());

  // Carrier Rent Responsibility - only surfaced reactively when the
  // server reports that Carrier Rent is being introduced on an
  // already-settled Challan with no established responsible party.
  const [needsCarrierRentResponsibility, setNeedsCarrierRentResponsibility] = useState(false);
  const [editCarrierRentRespChoice, setEditCarrierRentRespChoice] =
    useState<CarrierRentResponsibility>("CLEARING_AGENT");
  const [editCarrierRentThirdPartyAccountId, setEditCarrierRentThirdPartyAccountId] = useState("");

  // ------------------------------------------------------------
  // SETTLEMENT - the actual Final Settlement UI lives entirely in
  // FinalSettlementOperations.tsx now; this page only needs to load
  // the Party Account options the Edit Challan form's Carrier Rent
  // responsibility picker still uses.
  // ------------------------------------------------------------
  const [partyAccountOptions, setPartyAccountOptions] = useState<PartyAccountOption[]>([]);

  // Edit Settlement is restricted to SUPER_ADMIN - enforced for real
  // on the backend (see PATCH /api/challan/[id]/settle); this is
  // only used to decide whether to show the button at all.
  const [currentUserRole, setCurrentUserRole] = useState<"SUPER_ADMIN" | "MANAGER" | "VIEWER" | null>(null);

  useEffect(() => {
    async function loadCurrentUser() {
      try {
        const response = await fetch("/api/auth/me");
        const data = await response.json();
        if (response.ok && data.success) {
          setCurrentUserRole(data.user.role);
        }
      } catch {
        // silent - the button simply stays hidden
      }
    }
    loadCurrentUser();
  }, []);

  async function loadChallan() {
    try {
      setError("");
      const { id } = await params;
      const response = await fetch(`/api/challan/${id}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to load challan");
        return;
      }
      setChallan({
        ...data.challan,
        financials: data.financials,
        responsibleParties: data.responsibleParties,
        settlementBreakdown: data.settlementBreakdown,
        paidVerification: data.paidVerification,
        settlementSummary: data.settlementSummary,
      });
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadChallan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function loadTransporters() {
    try {
      const response = await fetch("/api/parties");
      const data = await response.json();
      if (!response.ok || !data.success) return;
      setTransporters(
        (data.parties || []).filter((p: any) => p.partyTypes?.includes("TRANSPORTER"))
      );
    } catch {
      // silent
    }
  }

  async function loadPartyAccountOptions() {
    try {
      const response = await fetch("/api/parties");
      const data = await response.json();
      if (!response.ok || !data.success) return;
      const options: PartyAccountOption[] = (data.parties || [])
        .filter((p: any) => p.account && p.account.isActive && p.account.category === "PARTY")
        .map((p: any) => ({
          accountId: p.account.id,
          partyName: p.partyName,
          accountCode: p.account.accountCode || null,
        }));
      setPartyAccountOptions(options);
    } catch {
      // silent
    }
  }

  // ------------------------------------------------------------
  // EDIT actions
  // ------------------------------------------------------------

  function openEditForm() {
    if (!challan) return;
    setEditLoadingDate(new Date(challan.loadingDate).toISOString().split("T")[0]);
    setEditTransporterPartyId(challan.transporterParty?.id || "");
    setEditDriverName(challan.driverName || "");
    setEditDriverPhone(challan.driverPhone || "");
    setEditCarrierNumber(challan.carrierNumber || "");
    setEditCarrierRent(challan.carrierRent != null ? String(challan.carrierRent) : "");
    setEditRemarks(challan.remarks || "");
    setBiltiesToAdd([]);
    setBiltyIdsToRemove(new Set());
    setBiltySearchTerm("");
    setBiltySearchResults([]);
    setNeedsCarrierRentResponsibility(false);
    setEditCarrierRentRespChoice("CLEARING_AGENT");
    setEditCarrierRentThirdPartyAccountId("");
    setError("");
    setShowEditForm(true);
    loadTransporters();
    loadPartyAccountOptions();
  }

  async function searchBiltiesForEdit() {
    if (!biltySearchTerm.trim()) return;
    try {
      const response = await fetch("/api/bilty");
      const data = await response.json();
      if (!response.ok || !data.success) return;
      const term = biltySearchTerm.trim().toLowerCase();
      const alreadyLinked = new Set((challan?.bilties || []).map((cb) => cb.bilty.id));
      const alreadyQueued = new Set(biltiesToAdd.map((b) => b.id));
      const results = (data.bilties || []).filter(
        (b: any) =>
          b.status === "PENDING" &&
          !b.isDeleted &&
          !alreadyLinked.has(b.id) &&
          !alreadyQueued.has(b.id) &&
          (b.biltyNo.toLowerCase().includes(term) ||
            b.consigneeName?.toLowerCase().includes(term))
      );
      setBiltySearchResults(results);
    } catch {
      // silent
    }
  }

  function queueBiltyToAdd(bilty: Bilty) {
    setBiltiesToAdd((current) => [...current, bilty]);
    setBiltySearchResults((current) => current.filter((b) => b.id !== bilty.id));
    setBiltySearchTerm("");
  }

  function unqueueBiltyToAdd(biltyId: string) {
    setBiltiesToAdd((current) => current.filter((b) => b.id !== biltyId));
  }

  function toggleRemoveBilty(biltyId: string) {
    setBiltyIdsToRemove((current) => {
      const next = new Set(current);
      if (next.has(biltyId)) next.delete(biltyId);
      else next.add(biltyId);
      return next;
    });
  }

  async function submitEdit() {
    if (!challan) return;
    setActionLoading("edit");
    setError("");

    try {
      const response = await fetch(`/api/challan/${challan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loadingDate: editLoadingDate,
          transporterPartyId: editTransporterPartyId || "",
          driverName: editDriverName || "",
          driverPhone: editDriverPhone || "",
          carrierNumber: editCarrierNumber || "",
          carrierRent: editCarrierRent === "" ? 0 : Number(editCarrierRent),
          remarks: editRemarks || "",
          addBiltyIds: biltiesToAdd.map((b) => b.id),
          removeBiltyIds: [...biltyIdsToRemove],
          ...(needsCarrierRentResponsibility
            ? {
                carrierRentResponsibility: {
                  responsibility: editCarrierRentRespChoice,
                  thirdPartyAccountId:
                    editCarrierRentRespChoice === "THIRD_PARTY"
                      ? editCarrierRentThirdPartyAccountId
                      : undefined,
                },
              }
            : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        if (data.requiresCarrierRentResponsibility) {
          setNeedsCarrierRentResponsibility(true);
          setError(
            "This Challan is already settled and has no established party for Carrier Rent yet. Please choose who is responsible below, then save again."
          );
          return;
        }

        setError(data.message || "Unable to update challan");
        return;
      }
      setShowEditForm(false);
      await loadChallan();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  async function deliverChallan() {
    if (!challan) return;
    const confirmed = window.confirm(`Mark challan ${challan.challanNo} as delivered?`);
    if (!confirmed) return;

    setActionLoading("deliver");
    setError("");

    try {
      const response = await fetch(`/api/challan/${challan.id}/deliver`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to deliver challan");
        return;
      }
      await loadChallan();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  async function cancelChallan() {
    if (!challan) return;
    const confirmed = window.confirm(`Cancel challan ${challan.challanNo}?`);
    if (!confirmed) return;

    setActionLoading("cancel");
    setError("");

    try {
      const response = await fetch(`/api/challan/${challan.id}/cancel`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to cancel challan");
        return;
      }
      await loadChallan();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  async function downloadPdf() {
    if (!challan) return;
    try {
      setActionLoading("pdf");
      setError("");
      const response = await fetch(`/api/challan/${challan.id}/pdf`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.message || "Unable to download PDF");
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `challan-${challan.challanNo}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  async function shareChallan() {
    if (!challan) return;
    const pdfUrl = `/api/challan/${challan.id}/pdf`;

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        const response = await fetch(pdfUrl);
        const blob = await response.blob();
        const file = new File([blob], `challan-${challan.challanNo}.pdf`, { type: "application/pdf" });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: `Challan ${challan.challanNo}`,
            text: `Al Naeem Car Carriers Service - Challan ${challan.challanNo}`,
            files: [file],
          });
        } else {
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `challan-${challan.challanNo}.pdf`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        }
      } catch {
        // User cancelled or sharing failed
      }
    } else {
      await downloadPdf();
    }
  }

  const statusColors: Record<ChallanStatus, string> = {
    IN_TRANSIT: "text-blue-600",
    DELIVERED: "text-green-600",
    CANCELLED: "text-red-600",
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-5xl mx-auto p-6">
          <p className="text-gray-500">Loading challan...</p>
        </div>
      </main>
    );
  }

  if (error || !challan) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-5xl mx-auto p-6">
          <p className="text-red-600">{error || "Challan not found"}</p>
          <Link href="/challan" className="mt-4 inline-block border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
            Back to Challan
          </Link>
        </div>
      </main>
    );
  }

  const canEditBilties = challan.status === "IN_TRANSIT" && !challan.isSettled;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6">
          <div className="text-xs text-gray-500 mb-1">Al Naeem Car Carriers Service</div>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">Challan #{challan.challanNo}</h1>
              <p className="text-gray-600">
                {new Date(challan.loadingDate).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-sm font-medium ${statusColors[challan.status]}`}>
                {challan.status.replace("_", " ")}
              </span>
              {challan.isSettled && (
                <span className="text-sm text-gray-500">(Settled)</span>
              )}
              <Link href="/challan" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
                Back
              </Link>
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Challan Details</h2>
              {!showEditForm && (
                <button
                  type="button"
                  onClick={openEditForm}
                  className="border rounded-lg px-3 py-1.5 text-xs hover:bg-gray-50"
                >
                  Edit
                </button>
              )}
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-gray-500">Transporter</p>
                <p className="font-medium">{challan.transporterParty?.partyName || "—"}</p>
              </div>
              <div>
                <p className="text-gray-500">Driver</p>
                <p className="font-medium">
                  {challan.driverName || "—"}
                  {challan.driverPhone && <span className="text-gray-500"> ({challan.driverPhone})</span>}
                </p>
              </div>
              <div>
                <p className="text-gray-500">Carrier Number</p>
                <p className="font-medium">{challan.carrierNumber || "—"}</p>
              </div>
              <div>
                <p className="text-gray-500">Carrier Rent</p>
                <p className="font-medium">Rs. {Number(challan.carrierRent || 0).toLocaleString()}</p>
              </div>
              {challan.remarks && (
                <div>
                  <p className="text-gray-500">Remarks</p>
                  <p className="font-medium">{challan.remarks}</p>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Settlement</h2>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-gray-500">Status</p>
                <p className="font-medium">{challan.isSettled ? "Settled" : "Pending"}</p>
              </div>
              {challan.settledAt && (
                <div>
                  <p className="text-gray-500">Settled At</p>
                  <p className="font-medium">{new Date(challan.settledAt).toLocaleString()}</p>
                </div>
              )}
              {challan.settlementNotes && (
                <div>
                  <p className="text-gray-500">Notes</p>
                  <p className="font-medium">{challan.settlementNotes}</p>
                </div>
              )}
              {challan.settlementJournalEntryId && (
                <div>
                  <p className="text-gray-500">Accounting Reference</p>
                  <Link
                    href={`/accounting-transactions/${challan.settlementJournalEntryId}`}
                    className="text-blue-600 hover:underline text-sm"
                  >
                    View Accounting Entry
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Financial Summary - dimensionally separated (Bilty Rent /
            Paid / To-Pay / Carrier Rent, never blended into one
            Receivable/Payable number), sourced from the SAME
            authoritative data Final Settlement itself reads - see
            lib/challan-settlement-summary.ts. Works identically
            whether the Challan is settled or not. */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Financial Summary</h2>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                challan.isSettled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
              }`}
            >
              {challan.isSettled ? "SETTLED" : "NOT YET SETTLED"}
            </span>
          </div>
          <FinancialSummaryCards challan={challan} />
          <PartyNetPosition challan={challan} />
        </div>

        {/* Settlement Breakdown (who ended up responsible for what) */}
        {challan.isSettled && challan.settlementJournalEntry && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4">Settlement Breakdown</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Bilty</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2">Party</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {challan.settlementJournalEntry.lines
                    .filter((l) => l.account.category === "PARTY")
                    .map((line, idx) => {
                      const biltyForLine = challan.bilties.find(
                        (cb) => cb.bilty.biltyNo === line.sourceNumber
                      )?.bilty;

                      return (
                        <tr key={idx}>
                          <td className="px-3 py-2">
                            {biltyForLine ? (
                              <Link href={`/bilty/${biltyForLine.id}`} className="text-blue-600 hover:underline">
                                {line.sourceNumber}
                              </Link>
                            ) : (
                              line.sourceNumber || "—"
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-600">{line.description}</td>
                          <td className="px-3 py-2 font-medium">
                            {line.account.party ? (
                              <Link href={`/parties/${line.account.party.id}/ledger`} className="text-blue-600 hover:underline">
                                {line.account.party.partyName}
                              </Link>
                            ) : (
                              line.account.accountName
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {Number(line.debit) > 0 ? `Rs. ${Number(line.debit).toLocaleString()}` : "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {Number(line.credit) > 0 ? `Rs. ${Number(line.credit).toLocaleString()}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Debit = that party owes ANC (receivable). Credit = ANC owes that party (payable).
            </p>
          </div>
        )}

        {/* THE ONE Final Settlement screen - shown for a DELIVERED
            Challan regardless of isSettled. Before settlement, it
            collects the user's intended payments as local drafts and
            finalizes everything atomically; after settlement, it
            reads/writes live through the existing SettlementPayment
            engine and Bilty Paid verification. This component never
            computes its own accounting - see
            FinalSettlementOperations.tsx and
            /api/challan/[id]/finalize-settlement. */}
        {challan.status === "DELIVERED" && (
          <FinalSettlementOperations
            challan={challan}
            currentUserRole={currentUserRole}
            onChanged={loadChallan}
          />
        )}

        {/* Edit Form */}
        {showEditForm && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-lg font-semibold mb-2">Edit Challan</h2>
            {challan.isSettled && (
              <p className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
                This document has accounting activity. Changes will automatically
                create an accounting adjustment. Existing payment history will not
                be removed.
              </p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium mb-1">Loading Date</label>
                <input
                  type="date"
                  value={editLoadingDate}
                  onChange={(e) => setEditLoadingDate(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Transporter</label>
                <select
                  value={editTransporterPartyId}
                  onChange={(e) => setEditTransporterPartyId(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2"
                >
                  <option value="">Select Transporter</option>
                  {transporters.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.partyName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Driver Name</label>
                <input
                  type="text"
                  value={editDriverName}
                  onChange={(e) => setEditDriverName(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Driver Phone</label>
                <input
                  type="text"
                  value={editDriverPhone}
                  onChange={(e) => setEditDriverPhone(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Carrier Number</label>
                <input
                  type="text"
                  value={editCarrierNumber}
                  onChange={(e) => setEditCarrierNumber(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Carrier Rent</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editCarrierRent}
                  onChange={(e) => setEditCarrierRent(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2"
                />
                {needsCarrierRentResponsibility && (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
                    <p className="text-sm font-medium mb-2">
                      Who is responsible for this carrier rent?
                    </p>
                    <div className="flex flex-wrap gap-4 mb-2">
                      {(
                        [
                          ["CLEARING_AGENT", "Clearing Agent"],
                          ["ANC", "ANC"],
                          ["THIRD_PARTY", "Other Party"],
                        ] as [CarrierRentResponsibility, string][]
                      ).map(([value, label]) => (
                        <label key={value} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="editCarrierRentResponsibility"
                            checked={editCarrierRentRespChoice === value}
                            onChange={() => setEditCarrierRentRespChoice(value)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    {editCarrierRentRespChoice === "THIRD_PARTY" && (
                      <PartyAccountSelect
                        value={editCarrierRentThirdPartyAccountId}
                        options={partyAccountOptions}
                        placeholder="Search party..."
                        onChange={setEditCarrierRentThirdPartyAccountId}
                      />
                    )}
                  </div>
                )}
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium mb-1">Remarks</label>
                <textarea
                  value={editRemarks}
                  onChange={(e) => setEditRemarks(e.target.value)}
                  rows={2}
                  className="w-full border rounded-lg px-3 py-2"
                />
              </div>
            </div>

            {/* Bilty relinking - only while IN_TRANSIT */}
            <div className="border-t pt-4">
              <h3 className="font-medium mb-2">Linked Bilties</h3>
              {!canEditBilties && (
                <p className="text-xs text-gray-500 mb-3">
                  Bilty composition can only be changed while the Challan is In Transit.
                </p>
              )}

              <div className="border rounded-lg overflow-hidden mb-3">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left">Bilty No</th>
                      <th className="px-3 py-2 text-left">Route</th>
                      <th className="px-3 py-2 text-left">Consignee</th>
                      {canEditBilties && <th className="px-3 py-2 text-left">Action</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {challan.bilties.map((cb) => (
                      <tr
                        key={cb.bilty.id}
                        className={`border-t ${biltyIdsToRemove.has(cb.bilty.id) ? "bg-red-50" : ""}`}
                      >
                        <td className="px-3 py-2 font-medium">{cb.bilty.biltyNo}</td>
                        <td className="px-3 py-2">
                          {cb.bilty.fromLocation.name} → {cb.bilty.toLocation.name}
                        </td>
                        <td className="px-3 py-2">{cb.bilty.consigneeName}</td>
                        {canEditBilties && (
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => toggleRemoveBilty(cb.bilty.id)}
                              className={`text-xs ${
                                biltyIdsToRemove.has(cb.bilty.id)
                                  ? "text-gray-600 hover:underline"
                                  : "text-red-600 hover:underline"
                              }`}
                            >
                              {biltyIdsToRemove.has(cb.bilty.id) ? "Undo Remove" : "Remove"}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                    {biltiesToAdd.map((bilty) => (
                      <tr key={`add-${bilty.id}`} className="border-t bg-green-50">
                        <td className="px-3 py-2 font-medium">{bilty.biltyNo} (new)</td>
                        <td className="px-3 py-2">
                          {bilty.fromLocation.name} → {bilty.toLocation.name}
                        </td>
                        <td className="px-3 py-2">{bilty.consigneeName}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => unqueueBiltyToAdd(bilty.id)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            Undo Add
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {canEditBilties && (
                <div>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      placeholder="Search pending bilty no, consignee..."
                      value={biltySearchTerm}
                      onChange={(e) => setBiltySearchTerm(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && searchBiltiesForEdit()}
                      className="flex-1 border rounded-lg px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={searchBiltiesForEdit}
                      className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
                    >
                      Search
                    </button>
                  </div>
                  {biltySearchResults.length > 0 && (
                    <div className="border rounded-lg max-h-48 overflow-y-auto">
                      {biltySearchResults.map((bilty) => (
                        <div
                          key={bilty.id}
                          className="flex items-center justify-between p-2 border-b last:border-b-0 hover:bg-gray-50"
                        >
                          <div>
                            <div className="font-medium text-sm">{bilty.biltyNo}</div>
                            <div className="text-xs text-gray-500">
                              {bilty.fromLocation.name} → {bilty.toLocation.name} • {bilty.consigneeName}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => queueBiltyToAdd(bilty)}
                            className="text-xs bg-blue-600 text-white px-2 py-1 rounded"
                          >
                            Add
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-red-600 mt-4">{error}</p>}

            <div className="flex gap-3 mt-4">
              <button
                type="button"
                onClick={submitEdit}
                disabled={actionLoading === "edit"}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {actionLoading === "edit" ? "Saving..." : "Save Changes"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowEditForm(false);
                  setError("");
                }}
                className="border px-6 py-2 rounded-lg text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Bilties */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">
            Bilties ({challan.bilties.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Bilty No</th>
                  <th className="px-4 py-3">Route</th>
                  <th className="px-4 py-3">Consignee</th>
                  <th className="px-4 py-3">Vehicle</th>
                  <th className="px-4 py-3">To Pay</th>
                  <th className="px-4 py-3">Clearing Agent</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {challan.bilties.map((cb) => (
                  <tr key={cb.bilty.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{cb.bilty.biltyNo}</td>
                    <td className="px-4 py-3">
                      {cb.bilty.fromLocation.name} → {cb.bilty.toLocation.name}
                    </td>
                    <td className="px-4 py-3">{cb.bilty.consigneeName}</td>
                    <td className="px-4 py-3">
                      {[cb.bilty.vehicleType, cb.bilty.vehicleModel, cb.bilty.registrationNumber].filter(Boolean).join(" / ") || "—"}
                    </td>
                    <td className="px-4 py-3">
                      Rs. {Number(cb.bilty.toPay || 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      {cb.bilty.clearingAgentParty?.partyName || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/bilty/${cb.bilty.id}`}
                        className="border rounded-lg px-3 py-1 text-xs hover:bg-gray-50"
                      >
                        View Bilty
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={downloadPdf}
            disabled={actionLoading === "pdf"}
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {actionLoading === "pdf" ? "Generating..." : "Download PDF"}
          </button>
           <button
             type="button"
             onClick={shareChallan}
             disabled={actionLoading === "pdf"}
             className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
           >
             Share PDF
           </button>
          {challan.status === "IN_TRANSIT" && (
            <>
              <button
                type="button"
                onClick={deliverChallan}
                disabled={actionLoading === "deliver"}
                className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
              >
                {actionLoading === "deliver" ? "Delivering..." : "Mark Delivered"}
              </button>
              <button
                type="button"
                onClick={cancelChallan}
                disabled={actionLoading === "cancel"}
                className="border border-red-300 text-red-600 px-4 py-2 rounded-lg text-sm hover:bg-red-50 disabled:opacity-50"
              >
                {actionLoading === "cancel" ? "Cancelling..." : "Cancel Challan"}
              </button>
            </>
          )}
         </div>

         {/* Communication */}

         <div className="mt-4">
           <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Send Document</p>
           <div className="flex flex-wrap gap-2">
             <SendChallanButton
               challan={challan}
               recipientLabel="Transporter"
               recipientName={challan.transporterParty?.partyName}
               phone={challan.transporterParty?.whatsapp || challan.transporterParty?.phone || null}
             />
             <SendChallanButton
               challan={challan}
               recipientLabel="Driver"
               recipientName={challan.driverName || undefined}
               phone={challan.driverPhone}
             />
           </div>
         </div>

       </div>
     </main>
   );
 }

 type SendChallanButtonProps = {
   challan: Challan | null;
   recipientLabel: string;
   recipientName: string | undefined;
   phone: string | null | undefined;
 };

 function SendChallanButton({ challan, recipientLabel, recipientName, phone }: SendChallanButtonProps) {
   const [sending, setSending] = useState(false);

   if (!challan) return null;

   const handleClick = async () => {
     try {
       setSending(true);
       const response = await fetch(`/api/challan/${challan.id}/pdf`);
       if (!response.ok) {
         const data = await response.json().catch(() => ({}));
         alert(data.message || "Unable to generate PDF");
         return;
       }

       const blob = await response.blob();
       const file = new File([blob], `Challan-${challan.challanNo}.pdf`, { type: "application/pdf" });
       const title = recipientName ? `Send Challan ${challan.challanNo} to ${recipientName}` : `Challan ${challan.challanNo}`;
       const text = getChallanShareMessage({
         challanNo: challan.challanNo,
         loadingDate: new Date(challan.loadingDate).toLocaleDateString(),
       });

       if (navigator.canShare && navigator.canShare({ files: [file] })) {
         await navigator.share({
           title,
           text,
           files: [file],
         });
         return;
       }

       const url = window.URL.createObjectURL(blob);
       const a = document.createElement("a");
       a.href = url;
       a.download = `Challan-${challan.challanNo}.pdf`;
       document.body.appendChild(a);
       a.click();
       document.body.removeChild(a);
       window.URL.revokeObjectURL(url);

       const normalizedPhone = normalizePhone(phone);
       if (normalizedPhone) {
         const encodedText = encodeURIComponent(text);
         const whatsappUrl = `https://wa.me/${normalizedPhone}?text=${encodedText}`;
         window.open(whatsappUrl, "_blank");
       }
     } catch {
       // User cancelled or sharing failed
     } finally {
       setSending(false);
     }
   };

   return (
     <button
       type="button"
       onClick={handleClick}
       disabled={sending}
       className="border rounded-lg px-3 py-2 text-xs sm:text-sm hover:bg-gray-50 disabled:opacity-50"
     >
       {sending ? "Preparing..." : `Send to ${recipientLabel}`}
     </button>
   );
 }
