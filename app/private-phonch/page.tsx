"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PrivatePhonchForm from "./PrivatePhonchForm";

// ============================================================
// PRIVATE PHONCH - list + create
//
// Mirrors app/phonch/page.tsx's own structure exactly. The create/
// edit FORM itself lives in ./PrivatePhonchForm.tsx, reused unchanged
// by app/private-phonch/[id]/page.tsx's "Edit" action. "Paid"/
// "Remaining" are never form inputs here - both come back pre-
// computed from the API (lib/private-phonch-accounting.ts's
// getPrivatePhonchPaymentState()), derived from actual Daily Posting
// payments/deposits.
// ============================================================

type PrivatePhonchListItem = {
  id: string;
  phonchNo: string;
  date: string;
  billNo: string | null;
  transporterParty: { id: string; partyName: string };
  vehicleCount: number;
  vehicleNames: string[];
  vehicleBillLabels: string[];
  billSummary: { billId: string; billNo: string; amount: number; status: "UNPAID" | "PARTIALLY_PAID" | "PAID" } | null;
  totalCarrierPayable: number;
  totalCaPayable: number;
  totalDeliveryRecovery: number;
  transporterPaid: number;
  transporterRemaining: number;
  transporterRecovered: number;
  transporterRecoveryRemaining: number;
  caPaidTotal: number;
  caRemaining: number;
  caRecovered: number;
  caRecoveryRemaining: number;
  status: "PAYABLE" | "RECEIVABLE" | "MIXED" | "CLEARED";
};

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export default function PrivatePhonchPage() {
  const [items, setItems] = useState<PrivatePhonchListItem[]>([]);
  const [capabilities, setCapabilities] = useState({ canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  async function loadList() {
    try {
      setLoading(true);
      const res = await fetch(`/api/private-phonch?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        setItems(data.items);
        setCapabilities(data.capabilities || { canEdit: false, canBin: false });
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadList();
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function handleBin(id: string) {
    if (!window.confirm("Move this Private Phonch to Bin?")) return;
    try {
      setActionId(id);
      setError("");
      const res = await fetch(`/api/private-phonch/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to move to Bin");
      setMessage(data.message);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move to Bin");
    } finally {
      setActionId(null);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Private Phonch</h1>
          <p className="mt-1 text-sm text-gray-500">
            Vehicle/rent settlement - Carrier Rent Payable to the Transporter and Amanat Payable to each vehicle&apos;s
            Clearing Agent.
          </p>
        </div>

        {(error || message) && (
          <div
            className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
              error ? "border-red-200 bg-red-50 text-red-700" : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {error || message}
          </div>
        )}

        <PrivatePhonchForm
          mode="create"
          onSaved={(phonch) => {
            setMessage(`Private Phonch ${phonch.phonchNo} created successfully.`);
            void loadList();
          }}
        />

        <div className="mt-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b p-4">
            <h2 className="text-sm font-semibold text-gray-700">Private Phonch Records</h2>
            <div className="flex items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Private Phonch No, Transporter..."
                className="w-72 rounded-lg border px-3 py-1.5 text-sm"
              />
              <Link href="/private-phonch/bin" className="text-xs text-gray-500 hover:underline">
                Bin
              </Link>
            </div>
          </div>
          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-10 text-center text-sm text-gray-500">Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-10 text-center text-sm text-gray-500">No Private Phonch records found.</div>
            ) : (
              <table className="w-full min-w-[1100px] text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Private Phonch No</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Transporter</th>
                    <th className="px-4 py-3">Vehicles</th>
                    <th className="px-4 py-3">Transporter Remaining</th>
                    <th className="px-4 py-3">CA Remaining</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((p) => {
                    const isUnpaid =
                      p.transporterPaid <= 0.009 &&
                      p.transporterRecovered <= 0.009 &&
                      p.caPaidTotal <= 0.009 &&
                      p.caRecovered <= 0.009;
                    const statusLabel =
                      p.status === "CLEARED" ? "Cleared" : p.status === "RECEIVABLE" ? "Receivable" : p.status === "MIXED" ? "Mixed" : "Payable";
                    const statusClass =
                      p.status === "CLEARED"
                        ? "bg-green-50 text-green-700"
                        : p.status === "RECEIVABLE"
                        ? "bg-blue-50 text-blue-700"
                        : p.status === "MIXED"
                        ? "bg-purple-50 text-purple-700"
                        : "bg-amber-50 text-amber-700";
                    return (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Link href={`/private-phonch/${p.id}`} className="font-medium text-blue-600 hover:underline">
                            {p.phonchNo}
                          </Link>
                          {p.billSummary && (
                            <div className="mt-0.5 text-xs text-gray-500">
                              Bill:{" "}
                              <Link href={`/bill/${p.billSummary.billId}`} className="text-blue-600 hover:underline">
                                {p.billSummary.billNo}
                              </Link>
                              {" · "}
                              {formatCurrency(p.billSummary.amount)}
                              {" · "}
                              {p.billSummary.status === "PAID"
                                ? "Paid"
                                : p.billSummary.status === "PARTIALLY_PAID"
                                ? "Partially Paid"
                                : "Unpaid"}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">{new Date(p.date).toLocaleDateString("en-GB")}</td>
                        <td className="px-4 py-3">{p.transporterParty.partyName}</td>
                        <td className="px-4 py-3">
                          {p.vehicleBillLabels.length > 0 ? p.vehicleBillLabels.join(", ") : p.vehicleNames.length > 0 ? p.vehicleNames.join(", ") : p.vehicleCount}
                        </td>
                        <td className="px-4 py-3">
                          {p.transporterRemaining <= 0.009 && p.transporterRecoveryRemaining <= 0.009 ? (
                            formatCurrency(0)
                          ) : (
                            <div className="space-y-0.5">
                              {p.transporterRemaining > 0.009 && (
                                <div className="text-amber-700">{formatCurrency(p.transporterRemaining)} Payable</div>
                              )}
                              {p.transporterRecoveryRemaining > 0.009 && (
                                <div className="text-blue-700">{formatCurrency(p.transporterRecoveryRemaining)} Receivable</div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {p.caRemaining <= 0.009 && p.caRecoveryRemaining <= 0.009 ? (
                            formatCurrency(0)
                          ) : (
                            <div className="space-y-0.5">
                              {p.caRemaining > 0.009 && <div className="text-amber-700">{formatCurrency(p.caRemaining)} Payable</div>}
                              {p.caRecoveryRemaining > 0.009 && (
                                <div className="text-blue-700">{formatCurrency(p.caRecoveryRemaining)} Receivable</div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}>{statusLabel}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <Link href={`/private-phonch/${p.id}`} className="rounded border px-2 py-1 text-xs hover:bg-gray-50">
                              View
                            </Link>
                            {capabilities.canEdit && (
                              <Link
                                href={`/private-phonch/${p.id}?edit=1`}
                                className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                              >
                                Edit
                              </Link>
                            )}
                            {capabilities.canBin && isUnpaid && (
                              <button
                                type="button"
                                disabled={actionId === p.id}
                                onClick={() => void handleBin(p.id)}
                                className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                              >
                                Bin
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
