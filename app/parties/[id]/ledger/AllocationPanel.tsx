"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n/party-ledger";

type AllocationRow = {
  id: string;
  targetSourceType: "BILTY" | "CHALLAN";
  targetSourceId: string;
  allocatedAmount: number;
  createdAt: string;
};

type PaymentState = {
  payment: { journalLineId: string; amount: number; direction: "DEBIT" | "CREDIT"; entryDate: string; eligibleForAllocation: boolean };
  allocated: number;
  unallocated: number;
  status: "UNALLOCATED" | "PARTIALLY_ALLOCATED" | "FULLY_ALLOCATED";
  allocations: AllocationRow[];
};

type OutstandingDocument = {
  targetSourceType: "BILTY" | "CHALLAN";
  targetSourceId: string;
  documentNo: string;
  documentDate: string;
  remainingAllocatable: number;
  vehicleRegistrationNumber: string | null;
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

export default function AllocationPanel({
  partyId,
  journalLineId,
  lang,
  onClose,
  onChanged,
}: {
  partyId: string;
  journalLineId: string;
  lang: Lang;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<PaymentState | null>(null);
  const [outstanding, setOutstanding] = useState<OutstandingDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const [role, setRole] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    async function loadRole() {
      try {
        const response = await fetch("/api/auth/me");
        const data = await response.json();
        if (response.ok && data.success) setRole(data.user.role);
      } catch {
        // Role unknown - Edit/Remove stay hidden; the backend enforces
        // the real permission check regardless of this UI hint.
      }
    }
    loadRole();
  }, []);

  const canEditAllocations = role === "SUPER_ADMIN" || role === "MANAGER";

  async function load() {
    try {
      setLoading(true);
      setError("");
      const [stateRes, docsRes] = await Promise.all([
        fetch(`/api/parties/${partyId}/allocations?journalLineId=${journalLineId}`),
        fetch(`/api/parties/${partyId}/documents?status=OUTSTANDING`),
      ]);
      const stateJson = await stateRes.json();
      const docsJson = await docsRes.json();

      if (!stateRes.ok || !stateJson.success) {
        setError(stateJson.message || "Unable to load payment allocation state");
        return;
      }
      setState(stateJson);
      if (docsRes.ok && docsJson.success) {
        setOutstanding(docsJson.documents);
      }
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, journalLineId]);

  async function submitAuto() {
    if (!window.confirm("Auto-allocate this payment against the oldest outstanding documents first?")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/parties/${partyId}/allocations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "AUTO", journalLineId, idempotencyKey: crypto.randomUUID() }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        setError(result.message || "Unable to auto-allocate");
        return;
      }
      await load();
      onChanged();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(row: AllocationRow) {
    setError("");
    setEditingId(row.id);
    setEditValue(String(row.allocatedAmount));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  async function submitEdit(allocationId: string) {
    const newAmount = Number(editValue);
    if (!(newAmount > 0)) {
      setError("Amount must be greater than zero.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/parties/${partyId}/allocations/${allocationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAmount }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        setError(result.message || "Unable to update allocation");
        return;
      }
      setEditingId(null);
      setEditValue("");
      await load();
      onChanged();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setBusy(false);
    }
  }

  async function removeAllocation(row: AllocationRow) {
    if (!window.confirm(`Remove this allocation of ${formatCurrency(row.allocatedAmount)}? The amount will return to unallocated.`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/parties/${partyId}/allocations/${row.id}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok || !result.success) {
        setError(result.message || "Unable to remove allocation");
        return;
      }
      await load();
      onChanged();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setBusy(false);
    }
  }

  const manualTotal = Object.values(manualAmounts).reduce((s, v) => s + (Number(v) || 0), 0);

  async function submitManual() {
    const allocations = Object.entries(manualAmounts)
      .filter(([, v]) => Number(v) > 0)
      .map(([key, v]) => {
        const [targetSourceType, targetSourceId] = key.split(":");
        return { targetSourceType, targetSourceId, amount: Number(v) };
      });

    if (allocations.length === 0) {
      setError("Enter at least one allocation amount.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/parties/${partyId}/allocations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "MANUAL", journalLineId, allocations, idempotencyKey: crypto.randomUUID() }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        setError(result.message || "Unable to allocate");
        return;
      }
      setManualAmounts({});
      await load();
      onChanged();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setBusy(false);
    }
  }

  function targetHref(row: { targetSourceType: string; targetSourceId: string }) {
    return row.targetSourceType === "BILTY" ? `/bilty/${row.targetSourceId}` : `/challan/${row.targetSourceId}`;
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t("allocate", lang)}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : !state ? (
          <p className="text-red-600">{error || "Unable to load payment."}</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">{t("payment", lang)}</p>
                <p className="font-semibold">{formatCurrency(state.payment.amount)}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">{t("allocated", lang)}</p>
                <p className="font-semibold">{formatCurrency(state.allocated)}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">{t("remainingToAllocate", lang)}</p>
                <p className="font-semibold">{formatCurrency(state.unallocated)}</p>
              </div>
            </div>

            {!state.payment.eligibleForAllocation && (
              <p className="text-sm text-amber-600 mb-4">
                This payment is already posted against a specific Challan/Bilty and is already fully attributed - it
                cannot be allocated again.
              </p>
            )}

            {state.allocations.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium mb-2">{t("allocatedTo", lang)}</h3>
                <div className="space-y-1">
                  {state.allocations.map((row) => (
                    <div key={row.id} className="flex items-center justify-between text-sm border-b py-1.5 gap-3">
                      <Link href={targetHref(row)} className="text-blue-600 hover:underline">
                        {row.targetSourceType} {row.targetSourceId}
                      </Link>

                      {editingId === row.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0.01}
                            step="0.01"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="border rounded-lg px-2 py-1 text-sm w-28 text-right"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => submitEdit(row.id)}
                            disabled={busy}
                            className="text-xs bg-green-600 text-white rounded-lg px-2 py-1 hover:bg-green-700 disabled:opacity-50"
                          >
                            {t("save", lang)}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            disabled={busy}
                            className="text-xs border rounded-lg px-2 py-1 hover:bg-gray-50"
                          >
                            {t("cancel", lang)}
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <span className="font-medium">{formatCurrency(row.allocatedAmount)}</span>
                          {canEditAllocations && (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => startEdit(row)}
                                disabled={busy}
                                className="text-xs border rounded-lg px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                              >
                                {t("edit", lang)}
                              </button>
                              <button
                                type="button"
                                onClick={() => removeAllocation(row)}
                                disabled={busy}
                                className="text-xs border border-red-200 text-red-600 rounded-lg px-2 py-1 hover:bg-red-50 disabled:opacity-50"
                              >
                                {t("remove", lang)}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-red-600 mb-4 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>}

            {state.payment.eligibleForAllocation && state.unallocated > 0.009 && (
              <>
                <div className="mb-6">
                  <button
                    type="button"
                    onClick={submitAuto}
                    disabled={busy}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    {busy ? "..." : t("autoAllocate", lang) + " — Oldest First"}
                  </button>
                </div>

                <div>
                  <h3 className="text-sm font-medium mb-2">{t("manualAllocation", lang)}</h3>
                  {outstanding.length === 0 ? (
                    <p className="text-sm text-gray-500">No eligible outstanding documents found for this party.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                          <tr>
                            <th className="px-3 py-2">Document</th>
                            <th className="px-3 py-2">Vehicle</th>
                            <th className="px-3 py-2">Date</th>
                            <th className="px-3 py-2 text-right">Outstanding</th>
                            <th className="px-3 py-2 text-right">{t("allocate", lang)}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {outstanding.map((doc) => {
                            const key = `${doc.targetSourceType}:${doc.targetSourceId}`;
                            return (
                              <tr key={key}>
                                <td className="px-3 py-2">{doc.documentNo}</td>
                                <td className="px-3 py-2">{doc.vehicleRegistrationNumber || "—"}</td>
                                <td className="px-3 py-2">{formatDate(doc.documentDate)}</td>
                                <td className="px-3 py-2 text-right">{formatCurrency(doc.remainingAllocatable)}</td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    type="number"
                                    min={0}
                                    max={doc.remainingAllocatable}
                                    value={manualAmounts[key] || ""}
                                    onChange={(e) =>
                                      setManualAmounts((prev) => ({ ...prev, [key]: e.target.value }))
                                    }
                                    className="border rounded-lg px-2 py-1 text-sm w-28 text-right"
                                    placeholder="0"
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>

                      <div className="flex items-center justify-between mt-4 pt-4 border-t">
                        <div className="text-sm">
                          {t("allocated", lang)}: <span className="font-semibold">{formatCurrency(manualTotal)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={submitManual}
                          disabled={busy || manualTotal <= 0}
                          className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
                        >
                          {busy ? "..." : "Confirm Allocation"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
