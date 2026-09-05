"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PartyAccountSelect, type Challan, type Bilty } from "./page";

// ============================================================
// THE ONE FINAL SETTLEMENT SCREEN
//
// Renders identically whether the Challan is settled or not (see
// page.tsx: `{challan.status === "DELIVERED" && <FinalSettlementOperations ...>}`).
//
// BEFORE settlement (challan.isSettled === false): Collection/Carrier
// Rent rows the user enters are held as local DRAFT state only - the
// backend's SettlementPayment engine categorically cannot accept them
// yet (CHALLAN_NOT_SETTLED). Clicking "Finalize Settlement" submits
// everything (the initial settlement AND every drafted allocation) in
// ONE atomic call to POST /api/challan/[id]/finalize-settlement,
// which performs both inside a single transaction - see that route
// for the full reasoning. If anything is rejected, NOTHING is
// committed: the Challan stays unsettled and every draft row stays
// exactly as the user left it, so they can fix and retry.
//
// AFTER settlement (challan.isSettled === true): rows are fetched
// and mutated LIVE through the existing, already-tested
// /settlement-payments endpoints - unchanged from before.
//
// PAID is never staged, never drafted, never submitted from here at
// all - it is pure Bilty-sourced reference data in both modes.
// ============================================================

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

type PartyOption = {
  partyId: string;
  partyName: string;
  partyTypes: string[];
  accountId: string | null;
  accountActive: boolean;
};

type LiveRow = {
  id: string;
  payerAccountId: string;
  amount: number;
  isDraft: false;
};

type DraftRow = {
  id: string;
  payerAccountId: string;
  amount: number;
  isDraft: true;
};

type DisplayRow = LiveRow | DraftRow;

function deriveCollectorLabel(partyTypes: string[] | undefined): string {
  if (!partyTypes) return "Other Party";
  if (partyTypes.includes("CLEARING_AGENT")) return "Clearing Agent";
  if (partyTypes.includes("TRANSPORTER")) return "Driver / Transporter";
  return "Other Party";
}

function VerifiedBadge({ label, amount, tone }: { label: string; amount: number; tone: "green" | "amber" }) {
  const styles = tone === "green" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700";
  const dot = tone === "green" ? "🟢" : "🟡";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${styles}`}>
      {dot} {label}: {formatCurrency(amount)}
    </span>
  );
}

type CollectorOption = { key: string; label: string; filter: (p: PartyOption) => boolean };

// ------------------------------------------------------------
// Shared, mode-agnostic presentational block: summary tiles, a
// payment history table, and an add-payment form. The PARENT owns
// all state/fetching/mutation and hands this component plain data +
// callbacks - it never talks to an API itself.
// ------------------------------------------------------------

function PaymentRowsPanel({
  dueLabel,
  paidLabel,
  remainingLabel,
  componentTotal,
  totalPaid,
  remainingDue,
  rows,
  partyLookup,
  collectorOptions,
  canManage,
  loading,
  error,
  onAdd,
  onEdit,
  onRemove,
  addButtonLabel,
  historyColumnLabel,
}: {
  dueLabel: string;
  paidLabel: string;
  remainingLabel: string;
  componentTotal: number;
  totalPaid: number;
  remainingDue: number;
  rows: DisplayRow[];
  partyLookup: Map<string, PartyOption>;
  collectorOptions: CollectorOption[];
  canManage: boolean;
  loading: boolean;
  error: string;
  onAdd: (payerAccountId: string, amount: number) => Promise<string | void>;
  onEdit?: (rowId: string, newAmount: number) => Promise<string | void>;
  onRemove: (row: DisplayRow) => Promise<string | void>;
  addButtonLabel: string;
  historyColumnLabel: string;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [collectedByKey, setCollectedByKey] = useState(collectorOptions[0]?.key || "");
  const [payerAccountId, setPayerAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const filteredPartyOptions = useMemo(() => {
    const current = collectorOptions.find((o) => o.key === collectedByKey);
    const parties = [...partyLookup.values()];
    const filtered = current ? parties.filter(current.filter) : parties;
    return filtered
      .filter((p) => p.accountId && p.accountActive)
      .map((p) => ({ accountId: p.accountId as string, partyName: p.partyName, accountCode: null }));
  }, [partyLookup, collectedByKey, collectorOptions]);

  const amountExceedsRemaining = Number(amount) > 0 && Number(amount) > remainingDue + 0.009;

  function openAddForm() {
    setShowAddForm(true);
    setCollectedByKey(collectorOptions[0]?.key || "");
    setPayerAccountId("");
    setAmount("");
    setLocalError("");
  }

  async function submitAdd() {
    if (!payerAccountId) {
      setLocalError("Select a party.");
      return;
    }
    const numericAmount = Number(amount);
    if (!(numericAmount > 0)) {
      setLocalError("Amount must be greater than zero.");
      return;
    }
    if (amountExceedsRemaining) {
      setLocalError(`Amount exceeds remaining ${dueLabel.toLowerCase()} of ${formatCurrency(remainingDue)}.`);
      return;
    }
    setBusy(true);
    setLocalError("");
    const err = await onAdd(payerAccountId, numericAmount);
    setBusy(false);
    if (err) {
      setLocalError(err);
      return;
    }
    setShowAddForm(false);
    setPayerAccountId("");
    setAmount("");
  }

  function startEdit(row: DisplayRow) {
    setLocalError("");
    setEditingId(row.id);
    setEditValue(String(row.amount));
  }

  async function submitEdit(row: DisplayRow) {
    const newAmount = Number(editValue);
    if (!(newAmount > 0)) {
      setLocalError("Amount must be greater than zero.");
      return;
    }
    setBusy(true);
    setLocalError("");
    const err = onEdit ? await onEdit(row.id, newAmount) : undefined;
    setBusy(false);
    if (err) {
      setLocalError(err);
      return;
    }
    setEditingId(null);
    setEditValue("");
  }

  async function handleRemove(row: DisplayRow) {
    const party = partyLookup.get(row.payerAccountId);
    if (
      !window.confirm(
        `Remove this ${row.isDraft ? "draft " : ""}payment of ${formatCurrency(row.amount)} ${
          party ? `from ${party.partyName}` : ""
        }?`
      )
    ) {
      return;
    }
    setBusy(true);
    setLocalError("");
    const err = await onRemove(row);
    setBusy(false);
    if (err) setLocalError(err);
  }

  if (loading) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">{dueLabel}</p>
          <p className="font-semibold">{formatCurrency(componentTotal)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">{paidLabel}</p>
          <p className="font-semibold text-green-700">{formatCurrency(totalPaid)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">{remainingLabel}</p>
          <p className={`font-semibold ${remainingDue > 0 ? "text-amber-700" : "text-gray-900"}`}>
            {formatCurrency(remainingDue)}
          </p>
        </div>
      </div>

      {(error || localError) && (
        <p className="text-sm text-red-600 mb-3 bg-red-50 border border-red-200 rounded-lg p-3">⚠ {error || localError}</p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">{historyColumnLabel}</th>
                <th className="px-3 py-2">Party</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Status</th>
                {canManage && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => {
                const party = partyLookup.get(row.payerAccountId);
                return (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">{deriveCollectorLabel(party?.partyTypes)}</td>
                    <td className="px-3 py-2">
                      {party ? (
                        row.isDraft ? (
                          party.partyName
                        ) : (
                          <Link href={`/parties/${party.partyId}/ledger`} className="text-blue-600 hover:underline">
                            {party.partyName}
                          </Link>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editingId === row.id ? (
                        <input
                          type="number"
                          min={0.01}
                          step="0.01"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="border rounded-lg px-2 py-1 text-sm w-28 text-right"
                          autoFocus
                        />
                      ) : (
                        <span className="font-medium">{formatCurrency(row.amount)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {row.isDraft ? (
                        <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-gray-100 text-gray-600">
                          Draft — not yet saved
                        </span>
                      ) : (
                        <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-700">
                          Received
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-3 py-2 text-right">
                        {editingId === row.id ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => submitEdit(row)}
                              disabled={busy}
                              className="text-xs bg-green-600 text-white rounded-lg px-2 py-1 hover:bg-green-700 disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              disabled={busy}
                              className="text-xs border rounded-lg px-2 py-1 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            {!row.isDraft && onEdit && (
                              <button
                                type="button"
                                onClick={() => startEdit(row)}
                                disabled={busy}
                                className="text-xs border rounded-lg px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                              >
                                Edit
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleRemove(row)}
                              disabled={busy}
                              className="text-xs border border-red-200 text-red-600 rounded-lg px-2 py-1 hover:bg-red-50 disabled:opacity-50"
                            >
                              {row.isDraft ? "Remove" : "Delete"}
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 0 && <p className="text-sm text-gray-500 mb-3">No payments recorded yet.</p>}

      {canManage && remainingDue > 0.009 && (
        <>
          {!showAddForm ? (
            <button type="button" onClick={openAddForm} className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
              + {addButtonLabel}
            </button>
          ) : (
            <div className="rounded-lg border p-4 bg-gray-50">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">
                    {historyColumnLabel === "Paid By" ? "Paid By" : "Collected By"}
                  </label>
                  <select
                    value={collectedByKey}
                    onChange={(e) => {
                      setCollectedByKey(e.target.value);
                      setPayerAccountId("");
                    }}
                    className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    {collectorOptions.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Party</label>
                  <PartyAccountSelect
                    value={payerAccountId}
                    options={filteredPartyOptions}
                    placeholder="Search party..."
                    onChange={setPayerAccountId}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Amount</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={`Max ${formatCurrency(remainingDue)}`}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  />
                  {amountExceedsRemaining && (
                    <p className="mt-1 text-xs text-red-600">
                      ⚠ Exceeds remaining {dueLabel.toLowerCase()} ({formatCurrency(remainingDue)}).
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={submitAdd}
                  disabled={busy || !payerAccountId || !amount || amountExceedsRemaining}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? "Saving..." : "Add Payment"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  disabled={busy}
                  className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!canManage && remainingDue > 0.009 && (
        <p className="text-xs text-gray-500">Only a Super Admin can record or edit payments here.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// LIVE (settled) Collection/Carrier Rent section - fetches and
// mutates through the existing /settlement-payments endpoints.
// ------------------------------------------------------------

function LiveSettlementSection({
  challanId,
  component,
  biltyId,
  dueLabel,
  paidLabel,
  remainingLabel,
  collectorOptions,
  parties,
  canManage,
  historyColumnLabel,
  addButtonLabel,
}: {
  challanId: string;
  component: "COLLECTION" | "CARRIER_RENT";
  biltyId?: string;
  dueLabel: string;
  paidLabel: string;
  remainingLabel: string;
  collectorOptions: CollectorOption[];
  parties: PartyOption[];
  canManage: boolean;
  historyColumnLabel: string;
  addButtonLabel: string;
}) {
  const [state, setState] = useState<{ componentTotal: number; totalPaid: number; remainingDue: number; rows: LiveRow[] } | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const partyLookup = useMemo(() => {
    const map = new Map<string, PartyOption>();
    for (const p of parties) if (p.accountId) map.set(p.accountId, p);
    return map;
  }, [parties]);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ component });
      if (biltyId) query.set("biltyId", biltyId);
      const response = await fetch(`/api/challan/${challanId}/settlement-payments?${query.toString()}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to load payment state");
        return;
      }
      setState({
        componentTotal: data.componentTotal,
        totalPaid: data.totalPaid,
        remainingDue: data.remainingDue,
        rows: data.rows.map((r: any) => ({ id: r.id, payerAccountId: r.payerAccountId, amount: r.amount, isDraft: false })),
      });
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challanId, component, biltyId]);

  async function handleAdd(payerAccountId: string, amount: number): Promise<string | void> {
    const response = await fetch(`/api/challan/${challanId}/settlement-payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        component,
        biltyId: component === "COLLECTION" ? biltyId : undefined,
        payerAccountId,
        amount,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) return data.message || "Unable to record this payment";
    await load();
  }

  async function handleEdit(rowId: string, newAmount: number): Promise<string | void> {
    const response = await fetch(`/api/challan/${challanId}/settlement-payments/${rowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newAmount }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) return data.message || "Unable to update this payment";
    await load();
  }

  async function handleRemove(row: DisplayRow): Promise<string | void> {
    const response = await fetch(`/api/challan/${challanId}/settlement-payments/${row.id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok || !data.success) return data.message || "Unable to remove this payment";
    await load();
  }

  return (
    <PaymentRowsPanel
      dueLabel={dueLabel}
      paidLabel={paidLabel}
      remainingLabel={remainingLabel}
      componentTotal={state?.componentTotal || 0}
      totalPaid={state?.totalPaid || 0}
      remainingDue={state?.remainingDue || 0}
      rows={state?.rows || []}
      partyLookup={partyLookup}
      collectorOptions={collectorOptions}
      canManage={canManage}
      loading={loading}
      error={error}
      onAdd={handleAdd}
      onEdit={handleEdit}
      onRemove={handleRemove}
      addButtonLabel={addButtonLabel}
      historyColumnLabel={historyColumnLabel}
    />
  );
}

// ------------------------------------------------------------
// DRAFT (unsettled) Collection/Carrier Rent section - operates
// purely on the lifted `stagedAllocations` state; nothing is sent to
// the server until "Finalize Settlement" is clicked.
// ------------------------------------------------------------

export type StagedAllocation = {
  id: string;
  component: "COLLECTION" | "CARRIER_RENT";
  biltyId?: string;
  payerAccountId: string;
  amount: number;
};

function DraftSettlementSection({
  component,
  biltyId,
  componentTotal,
  dueLabel,
  paidLabel,
  remainingLabel,
  collectorOptions,
  parties,
  canManage,
  historyColumnLabel,
  addButtonLabel,
  stagedAllocations,
  onStagedAllocationsChange,
}: {
  component: "COLLECTION" | "CARRIER_RENT";
  biltyId?: string;
  componentTotal: number;
  dueLabel: string;
  paidLabel: string;
  remainingLabel: string;
  collectorOptions: CollectorOption[];
  parties: PartyOption[];
  canManage: boolean;
  historyColumnLabel: string;
  addButtonLabel: string;
  stagedAllocations: StagedAllocation[];
  onStagedAllocationsChange: (next: StagedAllocation[]) => void;
}) {
  const partyLookup = useMemo(() => {
    const map = new Map<string, PartyOption>();
    for (const p of parties) if (p.accountId) map.set(p.accountId, p);
    return map;
  }, [parties]);

  const ownRows = stagedAllocations.filter(
    (a) => a.component === component && (component === "CARRIER_RENT" || a.biltyId === biltyId)
  );
  const totalPaid = ownRows.reduce((s, r) => s + r.amount, 0);
  const remainingDue = Math.max(0, Math.round((componentTotal - totalPaid) * 100) / 100);

  const displayRows: DisplayRow[] = ownRows.map((r) => ({ id: r.id, payerAccountId: r.payerAccountId, amount: r.amount, isDraft: true }));

  async function handleAdd(payerAccountId: string, amount: number): Promise<string | void> {
    onStagedAllocationsChange([
      ...stagedAllocations,
      { id: crypto.randomUUID(), component, biltyId, payerAccountId, amount },
    ]);
  }

  async function handleRemove(row: DisplayRow): Promise<string | void> {
    onStagedAllocationsChange(stagedAllocations.filter((a) => a.id !== row.id));
  }

  return (
    <PaymentRowsPanel
      dueLabel={dueLabel}
      paidLabel={paidLabel}
      remainingLabel={remainingLabel}
      componentTotal={componentTotal}
      totalPaid={totalPaid}
      remainingDue={remainingDue}
      rows={displayRows}
      partyLookup={partyLookup}
      collectorOptions={collectorOptions}
      canManage={canManage}
      loading={false}
      error=""
      onAdd={handleAdd}
      onRemove={handleRemove}
      addButtonLabel={addButtonLabel}
      historyColumnLabel={historyColumnLabel}
    />
  );
}

// ------------------------------------------------------------
// Per-Bilty block: Paid Reference (read-only, works in both modes -
// it never depends on isSettled at all) + To-Pay Receiving.
// ------------------------------------------------------------

const COLLECTION_COLLECTOR_OPTIONS: CollectorOption[] = [
  { key: "DRIVER", label: "Driver", filter: (p) => p.partyTypes.includes("TRANSPORTER") },
  { key: "CLEARING_AGENT", label: "Clearing Agent", filter: (p) => p.partyTypes.includes("CLEARING_AGENT") },
  { key: "OTHER", label: "Other Party", filter: () => true },
];

const CARRIER_RENT_COLLECTOR_OPTIONS: CollectorOption[] = [
  { key: "CLEARING_AGENT", label: "Clearing Agent", filter: (p) => p.partyTypes.includes("CLEARING_AGENT") },
  { key: "THIRD_PARTY", label: "Third Party", filter: () => true },
];

function BiltySettlementBlock({
  challanId,
  isSettled,
  bilty,
  paidVerification,
  parties,
  canManage,
  stagedAllocations,
  onStagedAllocationsChange,
}: {
  challanId: string;
  isSettled: boolean;
  bilty: Bilty;
  paidVerification:
    | {
        biltyId: string;
        paidAmount: number;
        responsiblePartyAccountId: string | null;
        responsiblePartyName: string | null;
        verifiedReceivedAmount: number;
        unverifiedAmount: number;
        isInconsistent: boolean;
      }
    | undefined;
  parties: PartyOption[];
  canManage: boolean;
  stagedAllocations: StagedAllocation[];
  onStagedAllocationsChange: (next: StagedAllocation[]) => void;
}) {
  const paidAmount = paidVerification?.paidAmount ?? Number(bilty.advance || 0);
  const verified = paidVerification?.verifiedReceivedAmount ?? 0;
  const unverified = paidVerification?.unverifiedAmount ?? Math.max(0, paidAmount - verified);
  const isFullyVerified = paidAmount > 0 && unverified <= 0.009;

  const responsibleLabel = paidVerification?.responsiblePartyName || null;
  const responsiblePartyId = useMemo(() => {
    if (!paidVerification?.responsiblePartyAccountId) return null;
    return parties.find((p) => p.accountId === paidVerification.responsiblePartyAccountId)?.partyId || null;
  }, [parties, paidVerification?.responsiblePartyAccountId]);

  const toPay = Number(bilty.toPay || 0);

  return (
    <div className="rounded-xl border p-4 md:p-5 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-semibold">
          <Link href={`/bilty/${bilty.id}`} className="text-blue-600 hover:underline">
            {bilty.biltyNo}
          </Link>{" "}
          <span className="text-sm font-normal text-gray-500">
            {bilty.fromLocation.name} → {bilty.toLocation.name}
          </span>
        </h3>
        <div className="text-xs text-gray-500">
          Consignor: {bilty.consignorParty?.partyName || "—"} · Consignee: {bilty.consigneeParty?.partyName || bilty.consigneeName}
        </div>
      </div>

      {/* PAID REFERENCE - read-only, from the Bilty. No edit control
          exists here on purpose; change the Bilty itself to change
          Paid amount or Paid responsibility. Identical in both
          settled and unsettled modes - Paid never depends on
          settlement status. */}
      {paidAmount > 0 && (
        <div className="rounded-lg bg-gray-50 p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Paid</p>
            <span className="text-xs text-gray-400">🔒 From Bilty · Read-only</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-500">Paid</p>
              <p className="font-semibold">{formatCurrency(paidAmount)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Paid Account</p>
              <p className="font-semibold">
                {responsibleLabel ? (
                  responsiblePartyId ? (
                    <Link href={`/parties/${responsiblePartyId}/ledger`} className="text-blue-600 hover:underline">
                      {responsibleLabel}
                    </Link>
                  ) : (
                    responsibleLabel
                  )
                ) : (
                  <span className="text-gray-400 font-normal text-sm">⚠ Not resolved</span>
                )}
              </p>
            </div>
            <div>
              {isFullyVerified ? (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-700">
                  🟢 Paid Verified
                </span>
              ) : (
                <VerifiedBadge label="Verified" amount={verified} tone="green" />
              )}
            </div>
            <div>{!isFullyVerified && <VerifiedBadge label="Paid but Not Received" amount={unverified} tone="amber" />}</div>
          </div>
          {paidVerification?.isInconsistent && (
            <p className="mt-2 text-xs text-red-600">
              ⚠ Verified amount exceeds Paid amount for this Bilty - please review its Daily Posting entries.
            </p>
          )}
          <p className="mt-2 text-xs text-gray-500">Paid amount will be verified through Daily Posting.</p>
        </div>
      )}

      {/* TO-PAY RECEIVING */}
      {toPay > 0 && (
        <div>
          <p className="text-sm font-medium mb-2">To-Pay Receiving</p>
          {isSettled ? (
            <LiveSettlementSection
              challanId={challanId}
              component="COLLECTION"
              biltyId={bilty.id}
              dueLabel="To-Pay Due"
              paidLabel="Received"
              remainingLabel="Remaining"
              collectorOptions={COLLECTION_COLLECTOR_OPTIONS}
              parties={parties}
              canManage={canManage}
              historyColumnLabel="Collector"
              addButtonLabel="Add Collection"
            />
          ) : (
            <DraftSettlementSection
              component="COLLECTION"
              biltyId={bilty.id}
              componentTotal={toPay}
              dueLabel="To-Pay Due"
              paidLabel="Received"
              remainingLabel="Remaining"
              collectorOptions={COLLECTION_COLLECTOR_OPTIONS}
              parties={parties}
              canManage={canManage}
              historyColumnLabel="Collector"
              addButtonLabel="Add Collection"
              stagedAllocations={stagedAllocations}
              onStagedAllocationsChange={onStagedAllocationsChange}
            />
          )}
        </div>
      )}

      {paidAmount <= 0 && toPay <= 0 && <p className="text-sm text-gray-500">No Paid amount or To-Pay due on this Bilty.</p>}
    </div>
  );
}

// ------------------------------------------------------------
// Top-level panel - the ONE Final Settlement screen.
// ------------------------------------------------------------

export default function FinalSettlementOperations({
  challan,
  currentUserRole,
  onChanged,
}: {
  challan: Challan;
  currentUserRole: "SUPER_ADMIN" | "MANAGER" | "VIEWER" | null;
  onChanged: () => void | Promise<void>;
}) {
  const [parties, setParties] = useState<PartyOption[]>([]);
  const [loadingParties, setLoadingParties] = useState(true);
  const [stagedAllocations, setStagedAllocations] = useState<StagedAllocation[]>([]);
  const [settlementNotes, setSettlementNotes] = useState(challan.settlementNotes || "");
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesMessage, setNotesMessage] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");

  const isSettled = challan.isSettled;
  // Establishing settlement (with zero allocations) only needs
  // challan.edit (SUPER_ADMIN + MANAGER); recording actual payment
  // allocations is SUPER_ADMIN-only, enforced identically on the
  // backend - see finalize-settlement/route.ts and
  // settlement-payments/route.ts's own hardcoded role checks.
  const canFinalize = currentUserRole === "SUPER_ADMIN" || currentUserRole === "MANAGER";
  const canManage = currentUserRole === "SUPER_ADMIN";

  useEffect(() => {
    async function loadParties() {
      try {
        setLoadingParties(true);
        const response = await fetch("/api/parties");
        const data = await response.json();
        if (!response.ok || !data.success) return;
        setParties(
          (data.parties || []).map((p: any) => ({
            partyId: p.id,
            partyName: p.partyName,
            partyTypes: p.partyTypes || [],
            accountId: p.account?.id || null,
            accountActive: Boolean(p.account?.isActive && p.account?.category === "PARTY"),
          }))
        );
      } catch {
        // silent - forms simply show no party options until this succeeds
      } finally {
        setLoadingParties(false);
      }
    }
    loadParties();
  }, []);

  const bilties = challan.bilties.map((cb) => cb.bilty);
  const paidVerification = challan.paidVerification;
  const carrierRentAmount = Number(challan.carrierRent || 0);

  const totals = useMemo(() => {
    const rent = bilties.reduce((s, b) => s + Number(b.total || 0), 0);
    const toPay = bilties.reduce((s, b) => s + Number(b.toPay || 0), 0);
    return {
      rent,
      paid: paidVerification?.aggregate.paidAmount ?? bilties.reduce((s, b) => s + Number(b.advance || 0), 0),
      toPay,
      unverified: paidVerification?.aggregate.unverifiedAmount ?? 0,
    };
  }, [bilties, paidVerification]);

  async function submitFinalize() {
    setFinalizing(true);
    setFinalizeError("");
    try {
      const response = await fetch(`/api/challan/${challan.id}/finalize-settlement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settlementNotes: settlementNotes || undefined,
          allocations: stagedAllocations.map((a) => ({
            component: a.component,
            biltyId: a.component === "COLLECTION" ? a.biltyId : undefined,
            payerAccountId: a.payerAccountId,
            amount: a.amount,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setFinalizeError(data.message || "Unable to finalize settlement");
        return;
      }
      setStagedAllocations([]);
      await onChanged();
    } catch {
      setFinalizeError("Unable to connect to the server");
    } finally {
      setFinalizing(false);
    }
  }

  async function saveNotes() {
    setNotesSaving(true);
    setNotesMessage("");
    try {
      const response = await fetch(`/api/challan/${challan.id}/finalize-settlement`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settlementNotes }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setNotesMessage(data.message || "Unable to save notes");
        return;
      }
      setNotesMessage("Saved.");
      await onChanged();
    } catch {
      setNotesMessage("Unable to connect to the server");
    } finally {
      setNotesSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Final Settlement</h2>
          {!isSettled && <p className="text-xs text-gray-500 mt-0.5">Not yet finalized - Bilty Rent and To-Pay dues are shown below.</p>}
        </div>
        {paidVerification?.aggregate.hasInconsistency && (
          <span className="rounded-full px-3 py-1 text-xs font-semibold bg-red-100 text-red-700">
            ⚠ Verification inconsistency
          </span>
        )}
      </div>

      {/* Compact summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">Bilty Rent</p>
          <p className="font-semibold">{formatCurrency(totals.rent)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">Paid</p>
          <p className="font-semibold">{formatCurrency(totals.paid)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">To-Pay</p>
          <p className="font-semibold">{formatCurrency(totals.toPay)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">Carrier Rent</p>
          <p className="font-semibold">{formatCurrency(carrierRentAmount)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-xs text-gray-500">Unverified Paid</p>
          <p className={`font-semibold ${totals.unverified > 0 ? "text-amber-700" : "text-gray-900"}`}>
            {formatCurrency(totals.unverified)} {totals.unverified > 0 ? "🟡" : ""}
          </p>
        </div>
      </div>

      {loadingParties ? (
        <p className="text-sm text-gray-500">Loading settlement data...</p>
      ) : (
        <>
          {/* Per-Bilty: Paid Reference + To-Pay Receiving */}
          {bilties.map((bilty) => (
            <BiltySettlementBlock
              key={bilty.id}
              challanId={challan.id}
              isSettled={isSettled}
              bilty={bilty}
              paidVerification={paidVerification?.perBilty[bilty.id]}
              parties={parties}
              canManage={canManage}
              stagedAllocations={stagedAllocations}
              onStagedAllocationsChange={setStagedAllocations}
            />
          ))}

          {/* Carrier Rent - Challan-level, shown once */}
          {carrierRentAmount > 0 && (
            <div className="rounded-xl border p-4 md:p-5 mb-4">
              <p className="text-sm font-medium mb-2">Carrier Rent</p>
              {isSettled ? (
                <LiveSettlementSection
                  challanId={challan.id}
                  component="CARRIER_RENT"
                  dueLabel="Carrier Rent"
                  paidLabel="Paid"
                  remainingLabel="Remaining"
                  collectorOptions={CARRIER_RENT_COLLECTOR_OPTIONS}
                  parties={parties}
                  canManage={canManage}
                  historyColumnLabel="Paid By"
                  addButtonLabel="Add Carrier Rent Payment"
                />
              ) : (
                <DraftSettlementSection
                  component="CARRIER_RENT"
                  componentTotal={carrierRentAmount}
                  dueLabel="Carrier Rent"
                  paidLabel="Paid"
                  remainingLabel="Remaining"
                  collectorOptions={CARRIER_RENT_COLLECTOR_OPTIONS}
                  parties={parties}
                  canManage={canManage}
                  historyColumnLabel="Paid By"
                  addButtonLabel="Add Carrier Rent Payment"
                  stagedAllocations={stagedAllocations}
                  onStagedAllocationsChange={setStagedAllocations}
                />
              )}
            </div>
          )}

          {/* Settlement Notes - a simple optional field, not an
              accounting input. */}
          <div className="mb-4">
            <label className="block text-xs text-gray-500 mb-1">Settlement Notes</label>
            <textarea
              value={settlementNotes}
              onChange={(e) => setSettlementNotes(e.target.value)}
              rows={2}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="Optional settlement notes..."
              disabled={!canFinalize}
            />
            {isSettled && canFinalize && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveNotes}
                  disabled={notesSaving}
                  className="border rounded-lg px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50"
                >
                  {notesSaving ? "Saving..." : "Save Notes"}
                </button>
                {notesMessage && <span className="text-xs text-gray-500">{notesMessage}</span>}
              </div>
            )}
          </div>

          {/* Finalize - the ONE terminal action for an unsettled
              Challan. Establishes the settlement AND every drafted
              allocation atomically (see finalize-settlement/route.ts) -
              nothing above this point has touched the server yet. */}
          {!isSettled && canFinalize && (
            <div className="border-t pt-4">
              {finalizeError && (
                <p className="text-sm text-red-600 mb-3 bg-red-50 border border-red-200 rounded-lg p-3">⚠ {finalizeError}</p>
              )}
              <button
                type="button"
                onClick={submitFinalize}
                disabled={finalizing}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {finalizing ? "Finalizing..." : "Finalize Settlement"}
              </button>
              {stagedAllocations.length > 0 && (
                <span className="ml-3 text-xs text-gray-500">
                  {stagedAllocations.length} payment{stagedAllocations.length > 1 ? "s" : ""} will be recorded along with this settlement.
                </span>
              )}
            </div>
          )}

          {!isSettled && !canFinalize && (
            <p className="text-xs text-gray-500 border-t pt-4">You do not have permission to finalize this settlement.</p>
          )}
        </>
      )}
    </div>
  );
}
