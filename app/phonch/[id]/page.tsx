"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import PhonchForm from "../PhonchForm";

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

type PhonchVehicle = {
  id: string;
  lineNo: number;
  biltyNo: string | null;
  challanNo: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  vehicleName: string | null;
  party: { id: string; partyName: string } | null;
  deliveryCharges: string;
  note: string | null;
  otherExpenseAmount: string;
  otherExpenseReason: string | null;
  claimAmount: string;
  claimReason: string | null;
};

type PhonchDetail = {
  id: string;
  phonchNo: string;
  date: string;
  carrierNumber: string | null;
  description: string | null;
  isDeleted: boolean;
  transporterParty: { id: string; partyName: string };
  vehicles: PhonchVehicle[];
  createdBy: { fullName: string; username: string } | null;
  totals: { totalDeliveryCharges: number; totalOtherExpense: number; totalClaim: number; totalAmount: number };
  receivedAmount: number;
  remainingDue: number;
  isInconsistent: boolean;
  status: "RECEIVABLE" | "CLEARED";
};

export default function PhonchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phonch, setPhonch] = useState<PhonchDetail | null>(null);
  const [capabilities, setCapabilities] = useState({ canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [binning, setBinning] = useState(false);
  const [editing, setEditing] = useState(false);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch(`/api/phonch/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load Phonch");
      setPhonch(data.phonch);
      setCapabilities(data.capabilities);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Phonch");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Read directly from the URL (not next/navigation's useSearchParams)
  // for a one-time-on-mount deep-link check, matching the same
  // pattern already used by app/daily-posting/page.tsx and
  // app/bilty/page.tsx, to avoid that hook's Suspense-boundary
  // requirement.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("edit") === "1") setEditing(true);
  }, []);

  async function handleBin() {
    if (!window.confirm("Move this Phonch to Bin?")) return;
    try {
      setBinning(true);
      setError("");
      const res = await fetch(`/api/phonch/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to move to Bin");
      setMessage(data.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move to Bin");
    } finally {
      setBinning(false);
    }
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">Loading...</main>;
  }

  if (error && !phonch) {
    return (
      <main className="min-h-screen bg-gray-50 p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      </main>
    );
  }

  if (!phonch) return null;

  // Edit is no longer blocked merely because a receipt exists - the
  // backend now allows non-financial edits and financial edits that
  // don't drop below what's already been received via Daily Posting,
  // rejecting anything unsafe with its own business-readable error
  // (see lib/phonch-accounting.ts's assertPhonchEditNotBelowSettled()).
  // phonch.receivedAmount is still used below for the Bin gate/warning
  // banner, which are unchanged and still block entirely once any
  // receipt exists.
  const canEditNow = capabilities.canEdit && !phonch.isDeleted;

  if (editing) {
    return (
      <main className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-7xl">
          <div className="mb-6">
            <Link href={`/phonch/${id}`} className="text-xs text-gray-500 hover:underline">
              ← Back to Phonch
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Edit Phonch No. {phonch.phonchNo}</h1>
          </div>
          <PhonchForm
            mode="edit"
            phonchId={id}
            initialData={{
              phonchNo: phonch.phonchNo,
              date: phonch.date,
              transporterParty: phonch.transporterParty,
              carrierNumber: phonch.carrierNumber,
              description: phonch.description,
              vehicles: phonch.vehicles,
            }}
            onSaved={() => {
              setEditing(false);
              void load();
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      </main>
    );
  }

  const hasOtherExpense = phonch.totals.totalOtherExpense > 0;
  const hasClaim = phonch.totals.totalClaim > 0;

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link href="/phonch" className="text-xs text-gray-500 hover:underline">
              ← Back to Phonch
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Phonch No. {phonch.phonchNo}</h1>
          </div>
          <div className="flex gap-2 print:hidden">
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
            >
              Print
            </button>
            {canEditNow && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
              >
                Edit
              </button>
            )}
            {capabilities.canBin && phonch.receivedAmount <= 0.009 && (
              <button
                type="button"
                disabled={binning}
                onClick={() => void handleBin()}
                className="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-700 disabled:opacity-50"
              >
                Move to Bin
              </button>
            )}
          </div>
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

        {phonch.receivedAmount > 0.009 && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This Phonch has recorded Daily Posting receipt(s) and can no longer be edited or moved to Bin.
          </div>
        )}

        {phonch.isInconsistent && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Data inconsistency: recorded receipts exceed the Total Amount. Please review Daily Posting entries for this Phonch.
          </div>
        )}

        <div className="grid gap-4 rounded-xl border bg-white p-5 shadow-sm md:grid-cols-4">
          <div>
            <div className="text-xs uppercase text-gray-500">Date</div>
            <div className="mt-1 text-sm font-medium">{formatDate(phonch.date)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-gray-500">Transporter</div>
            <div className="mt-1 text-sm font-medium">{phonch.transporterParty.partyName}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-gray-500">Carrier No.</div>
            <div className="mt-1 text-sm font-medium">{phonch.carrierNumber || "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-gray-500">Status</div>
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                phonch.status === "CLEARED" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
              }`}
            >
              {phonch.status === "CLEARED" ? "Cleared / Received" : "Receivable"}
            </span>
          </div>
          {phonch.description && (
            <div className="md:col-span-4">
              <div className="text-xs uppercase text-gray-500">Description</div>
              <div className="mt-1 text-sm">{phonch.description}</div>
            </div>
          )}
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">No.</th>
                <th className="px-3 py-3">Bilty No</th>
                <th className="px-3 py-3">Challan No</th>
                <th className="px-3 py-3">Chassis No</th>
                <th className="px-3 py-3">Engine No</th>
                <th className="px-3 py-3">Vehicle Name</th>
                <th className="px-3 py-3">Party</th>
                <th className="px-3 py-3">Delivery Charges</th>
                {hasOtherExpense && <th className="px-3 py-3">Other Expense</th>}
                {hasClaim && <th className="px-3 py-3">Claim</th>}
                <th className="px-3 py-3">Note / Condition</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {phonch.vehicles.map((v) => (
                <tr key={v.id}>
                  <td className="px-3 py-2 text-gray-500">{v.lineNo}</td>
                  <td className="px-3 py-2">{v.biltyNo || "—"}</td>
                  <td className="px-3 py-2">{v.challanNo || "—"}</td>
                  <td className="px-3 py-2">{v.chassisNumber || "—"}</td>
                  <td className="px-3 py-2">{v.engineNumber || "—"}</td>
                  <td className="px-3 py-2">{v.vehicleName || "—"}</td>
                  <td className="px-3 py-2">{v.party?.partyName || "—"}</td>
                  <td className="px-3 py-2">{formatCurrency(Number(v.deliveryCharges))}</td>
                  {hasOtherExpense && (
                    <td className="px-3 py-2">
                      {Number(v.otherExpenseAmount) > 0 ? (
                        <>
                          {formatCurrency(Number(v.otherExpenseAmount))}
                          <div className="text-xs text-gray-500">{v.otherExpenseReason}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                  {hasClaim && (
                    <td className="px-3 py-2">
                      {Number(v.claimAmount) > 0 ? (
                        <>
                          {formatCurrency(Number(v.claimAmount))}
                          <div className="text-xs text-gray-500">{v.claimReason}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2">{v.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex justify-end">
          <div className="w-72 rounded-xl border bg-white p-5 shadow-sm text-sm">
            <div className="flex justify-between py-1">
              <span className="text-gray-600">Total Delivery Charges</span>
              <span className="font-medium">{formatCurrency(phonch.totals.totalDeliveryCharges)}</span>
            </div>
            {hasOtherExpense && (
              <div className="flex justify-between py-1">
                <span className="text-gray-600">Total Other Expense</span>
                <span className="font-medium">{formatCurrency(phonch.totals.totalOtherExpense)}</span>
              </div>
            )}
            {hasClaim && (
              <div className="flex justify-between py-1">
                <span className="text-gray-600">Total Claim</span>
                <span className="font-medium">{formatCurrency(phonch.totals.totalClaim)}</span>
              </div>
            )}
            <div className="flex justify-between border-t py-1 font-semibold">
              <span>Total Amount</span>
              <span>{formatCurrency(phonch.totals.totalAmount)}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-gray-600">Received</span>
              <span className="font-medium text-green-700">{formatCurrency(phonch.receivedAmount)}</span>
            </div>
            <div className="flex justify-between border-t py-1 font-semibold">
              <span>Remaining Due</span>
              <span className={phonch.remainingDue > 0 ? "text-amber-700" : "text-green-700"}>
                {formatCurrency(phonch.remainingDue)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
