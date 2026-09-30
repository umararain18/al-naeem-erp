"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PhonchForm from "./PhonchForm";

// ============================================================
// SHOWROOM PHONCH / DELIVERY - list + create
//
// The create/edit FORM itself lives in ./PhonchForm.tsx, reused
// unchanged by app/phonch/[id]/page.tsx's "Edit" action. "Received"/
// "Remaining Due" are never form inputs here - both come back
// pre-computed from the API (lib/phonch-accounting.ts's
// getPhonchPaymentState()), derived from actual Daily Posting
// receipts.
// ============================================================

type PhonchListItem = {
  id: string;
  phonchNo: string;
  date: string;
  carrierNumber: string | null;
  transporterParty: { id: string; partyName: string };
  vehicleCount: number;
  vehicleNames: string[];
  vehicleBillLabels: string[];
  totalAmount: number;
  receivedAmount: number;
  remainingDue: number;
  status: "RECEIVABLE" | "CLEARED";
};

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export default function PhonchPage() {
  const [items, setItems] = useState<PhonchListItem[]>([]);
  const [capabilities, setCapabilities] = useState({ canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  async function loadList() {
    try {
      setLoading(true);
      const res = await fetch(`/api/phonch?search=${encodeURIComponent(search)}`, { cache: "no-store" });
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
    if (!window.confirm("Move this Phonch to Bin?")) return;
    try {
      setActionId(id);
      setError("");
      const res = await fetch(`/api/phonch/${id}`, { method: "DELETE" });
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
          <h1 className="text-2xl font-bold text-gray-900">Showroom Phonch / Delivery</h1>
          <p className="mt-1 text-sm text-gray-500">
            Record delivered vehicles and the charges billed to the Transporter.
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

        <PhonchForm
          mode="create"
          onSaved={(phonch) => {
            setMessage(`Phonch ${phonch.phonchNo} created successfully.`);
            void loadList();
          }}
        />

        <div className="mt-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b p-4">
            <h2 className="text-sm font-semibold text-gray-700">Phonch Records</h2>
            <div className="flex items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Phonch No, Carrier No, Transporter..."
                className="w-72 rounded-lg border px-3 py-1.5 text-sm"
              />
              <Link href="/phonch/bin" className="text-xs text-gray-500 hover:underline">
                Bin
              </Link>
            </div>
          </div>
          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-10 text-center text-sm text-gray-500">Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-10 text-center text-sm text-gray-500">No Phonch records found.</div>
            ) : (
              <table className="w-full min-w-[1000px] text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Phonch No</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Transporter</th>
                    <th className="px-4 py-3">Vehicles</th>
                    <th className="px-4 py-3">Total Amount</th>
                    <th className="px-4 py-3">Received</th>
                    <th className="px-4 py-3">Remaining Due</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((p) => {
                    // Bin remains blocked once any receipt exists
                    // (unchanged - only Edit's own gate changed, since
                    // the backend now validates financial edits per-
                    // amount rather than blocking outright).
                    const isUnpaid = p.receivedAmount <= 0.009;
                    return (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Link href={`/phonch/${p.id}`} className="font-medium text-blue-600 hover:underline">
                            {p.phonchNo}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{new Date(p.date).toLocaleDateString("en-GB")}</td>
                        <td className="px-4 py-3">{p.transporterParty.partyName}</td>
                        <td className="px-4 py-3">
                          {p.vehicleBillLabels.length > 0 ? p.vehicleBillLabels.join(", ") : p.vehicleNames.length > 0 ? p.vehicleNames.join(", ") : p.vehicleCount}
                        </td>
                        <td className="px-4 py-3">{formatCurrency(p.totalAmount)}</td>
                        <td className="px-4 py-3">{formatCurrency(p.receivedAmount)}</td>
                        <td className="px-4 py-3">{formatCurrency(p.remainingDue)}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              p.status === "CLEARED" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {p.status === "CLEARED" ? "Cleared / Received" : "Receivable"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <Link href={`/phonch/${p.id}`} className="rounded border px-2 py-1 text-xs hover:bg-gray-50">
                              View
                            </Link>
                            {capabilities.canEdit && (
                              <Link
                                href={`/phonch/${p.id}?edit=1`}
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
