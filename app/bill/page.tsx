"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import BillForm from "./BillForm";
import { formatBusinessDate } from "@/lib/date-range";

// ============================================================
// BILL BOOK - list + create
//
// Mirrors app/private-phonch/page.tsx's own structure exactly.
// ============================================================

type BillListItem = {
  id: string;
  billNo: string;
  date: string;
  clientName: string;
  clientPhone: string | null;
  vehicleCount: number;
  vehicleNames: string[];
  sourceType: "PRIVATE_PHONCH" | "SHOWROOM_PHONCH" | null;
  phonchLinks: { id: string; phonchNo: string }[];
  rentTotal: number;
  totalAmount: number;
  receivedAmount: number;
  remainingDue: number;
  status: "UNPAID" | "PARTIALLY_PAID" | "PAID";
};

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export default function BillPage() {
  const [items, setItems] = useState<BillListItem[]>([]);
  const [capabilities, setCapabilities] = useState({ canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  async function loadList() {
    try {
      setLoading(true);
      const res = await fetch(`/api/bill?search=${encodeURIComponent(search)}`, { cache: "no-store" });
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
    if (!window.confirm("Move this Bill to Bin?")) return;
    try {
      setActionId(id);
      setError("");
      const res = await fetch(`/api/bill/${id}`, { method: "DELETE" });
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

  const statusLabel = (s: BillListItem["status"]) => (s === "PAID" ? "Paid" : s === "PARTIALLY_PAID" ? "Partially Paid" : "Unpaid");
  const statusClass = (s: BillListItem["status"]) =>
    s === "PAID" ? "bg-green-50 text-green-700" : s === "PARTIALLY_PAID" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700";

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Bill Book</h1>
          <p className="mt-1 text-sm text-gray-500">Client billing/receivable for Private Phonch and Showroom Phonch vehicles.</p>
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

        <BillForm
          mode="create"
          onSaved={(bill) => {
            setMessage(`Bill ${bill.billNo} created successfully.`);
            void loadList();
          }}
        />

        <div className="mt-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b p-4">
            <h2 className="text-sm font-semibold text-gray-700">Bill Records</h2>
            <div className="flex items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Bill No, Client, Phone, Vehicle..."
                className="w-72 rounded-lg border px-3 py-1.5 text-sm"
              />
              <Link href="/bill/bin" className="text-xs text-gray-500 hover:underline">
                Bin
              </Link>
            </div>
          </div>
          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-10 text-center text-sm text-gray-500">Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-10 text-center text-sm text-gray-500">No Bill records found.</div>
            ) : (
              <table className="w-full min-w-[1250px] text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Bill No</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Client</th>
                    <th className="px-4 py-3">Vehicles</th>
                    <th className="px-4 py-3">Phonch No</th>
                    <th className="px-4 py-3">Rent</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Received</th>
                    <th className="px-4 py-3">Remaining</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((b) => {
                    const isUnpaid = b.receivedAmount <= 0.009;
                    return (
                      <tr key={b.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Link href={`/bill/${b.id}`} className="font-medium text-blue-600 hover:underline">
                            {b.billNo}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{formatBusinessDate(b.date)}</td>
                        <td className="px-4 py-3">
                          {b.clientName}
                          {b.clientPhone && <div className="text-xs text-gray-500">{b.clientPhone}</div>}
                        </td>
                        <td className="px-4 py-3">{b.vehicleNames.length > 0 ? b.vehicleNames.join(", ") : b.vehicleCount}</td>
                        <td className="px-4 py-3">
                          {b.phonchLinks.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {b.phonchLinks.map((p) => (
                                <Link
                                  key={p.id}
                                  href={b.sourceType === "PRIVATE_PHONCH" ? `/private-phonch/${p.id}` : `/phonch/${p.id}`}
                                  className="text-blue-600 hover:underline"
                                >
                                  {p.phonchNo}
                                </Link>
                              ))}
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3">{formatCurrency(b.rentTotal)}</td>
                        <td className="px-4 py-3">{formatCurrency(b.totalAmount)}</td>
                        <td className="px-4 py-3">{formatCurrency(b.receivedAmount)}</td>
                        <td className="px-4 py-3">{formatCurrency(b.remainingDue)}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(b.status)}`}>
                            {statusLabel(b.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <Link href={`/bill/${b.id}`} className="rounded border px-2 py-1 text-xs hover:bg-gray-50">
                              View
                            </Link>
                            {capabilities.canEdit && (
                              <Link href={`/bill/${b.id}?edit=1`} className="rounded border px-2 py-1 text-xs hover:bg-gray-50">
                                Edit
                              </Link>
                            )}
                            {capabilities.canBin && isUnpaid && (
                              <button
                                type="button"
                                disabled={actionId === b.id}
                                onClick={() => void handleBin(b.id)}
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
