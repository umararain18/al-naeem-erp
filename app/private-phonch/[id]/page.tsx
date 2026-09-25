"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import PrivatePhonchForm from "../PrivatePhonchForm";

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

type PrivatePhonchVehicle = {
  id: string;
  lineNo: number;
  biltyNo: string | null;
  challanNo: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  vehicleName: string | null;
  clearingAgentParty: { id: string; partyName: string } | null;
  totalRent: string;
  deliveryCharges: string;
  carrierPayable: string;
  deliveryRecoveryParty: string | null;
  note: string | null;
};

type PaymentState = {
  totalPayable: number;
  paidAmount: number;
  remainingDue: number;
  isInconsistent: boolean;
  status: "PAYABLE" | "CLEARED";
};

type ClearingAgentState = PaymentState & { partyId: string; partyName: string; accountId: string | null };

type RecoveryState = {
  totalRecovery: number;
  recoveredAmount: number;
  remainingDue: number;
  isInconsistent: boolean;
  status: "RECEIVABLE" | "CLEARED";
};

type ClearingAgentRecoveryState = RecoveryState & { partyId: string; partyName: string; accountId: string | null };

type PrivatePhonchDetail = {
  id: string;
  phonchNo: string;
  date: string;
  billNo: string | null;
  isDeleted: boolean;
  transporterParty: { id: string; partyName: string };
  vehicles: PrivatePhonchVehicle[];
  totals: { totalRent: number; totalDeliveryCharges: number; totalCarrierPayable: number; totalCaPayable: number };
  transporterState: PaymentState;
  // Independent receivable (opposite polarity from transporterState's
  // own Carrier Rent Payable) - already computed server-side, never
  // recalculated here. See lib/private-phonch-accounting.ts's
  // getPrivatePhonchDeliveryRecoveryState().
  transporterDeliveryRecoveryState: RecoveryState;
  clearingAgentStates: ClearingAgentState[];
  // Each Clearing Agent's OWN Delivery Recovery (opposite polarity
  // from their own Amanat Payable in clearingAgentStates above, never
  // both nonzero for the same Clearing Agent on the same Private
  // Phonch - see resolvePrivatePhonchInput()'s own mutual-exclusivity
  // guard). Only ever non-empty for a zero-rent vehicle whose Delivery
  // Recovery was attributed to a Clearing Agent instead of the
  // Transporter.
  clearingAgentRecoveryStates: ClearingAgentRecoveryState[];
  // Single authoritative current-outstanding-position rule - see
  // lib/private-phonch-accounting.ts's derivePrivatePhonchOverallStatus().
  overallStatus: "PAYABLE" | "RECEIVABLE" | "MIXED" | "CLEARED";
};

export default function PrivatePhonchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [phonch, setPhonch] = useState<PrivatePhonchDetail | null>(null);
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
      const res = await fetch(`/api/private-phonch/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load Private Phonch");
      setPhonch(data.phonch);
      setCapabilities(data.capabilities);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Private Phonch");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Same one-time-on-mount deep-link pattern as Showroom Phonch's own
  // detail page (and app/daily-posting/page.tsx, app/bilty/page.tsx).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("edit") === "1") setEditing(true);
  }, []);

  async function handleBin() {
    if (!window.confirm("Move this Private Phonch to Bin?")) return;
    try {
      setBinning(true);
      setError("");
      const res = await fetch(`/api/private-phonch/${id}`, { method: "DELETE" });
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

  const anyPaymentRecorded =
    phonch.transporterState.paidAmount > 0.009 ||
    phonch.transporterDeliveryRecoveryState.recoveredAmount > 0.009 ||
    phonch.clearingAgentStates.some((s) => s.paidAmount > 0.009) ||
    phonch.clearingAgentRecoveryStates.some((s) => s.recoveredAmount > 0.009);
  // Edit is no longer blocked merely because a payment/receipt exists -
  // the backend now allows non-financial edits and financial edits
  // that don't drop below what's already been settled via Daily
  // Posting, rejecting anything unsafe with its own business-readable
  // error (see lib/private-phonch-accounting.ts's
  // assertPrivatePhonchEditNotBelowSettled()). anyPaymentRecorded is
  // still used below for the Bin gate/warning banner, which are
  // unchanged and still block entirely once any payment exists.
  const canEditNow = capabilities.canEdit && !phonch.isDeleted;
  const anyInconsistent =
    phonch.transporterState.isInconsistent ||
    phonch.transporterDeliveryRecoveryState.isInconsistent ||
    phonch.clearingAgentStates.some((s) => s.isInconsistent) ||
    phonch.clearingAgentRecoveryStates.some((s) => s.isInconsistent);

  if (editing) {
    return (
      <main className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-7xl">
          <div className="mb-6">
            <Link href={`/private-phonch/${id}`} className="text-xs text-gray-500 hover:underline">
              ← Back to Private Phonch
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Edit Private Phonch No. {phonch.phonchNo}</h1>
          </div>
          <PrivatePhonchForm
            mode="edit"
            phonchId={id}
            initialData={{
              phonchNo: phonch.phonchNo,
              date: phonch.date,
              transporterParty: phonch.transporterParty,
              billNo: phonch.billNo,
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

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link href="/private-phonch" className="text-xs text-gray-500 hover:underline">
              ← Back to Private Phonch
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Private Phonch No. {phonch.phonchNo}</h1>
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
            {capabilities.canBin && !anyPaymentRecorded && (
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

        {anyPaymentRecorded && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This Private Phonch has recorded Daily Posting payment(s)/deposit(s) and can no longer be edited or moved to
            Bin.
          </div>
        )}

        {anyInconsistent && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Data inconsistency: recorded payments exceed a payable. Please review Daily Posting entries for this Private
            Phonch.
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
            <div className="text-xs uppercase text-gray-500">Bill No.</div>
            <div className="mt-1 text-sm font-medium">{phonch.billNo || "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-gray-500">Status</div>
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                phonch.overallStatus === "CLEARED"
                  ? "bg-green-50 text-green-700"
                  : phonch.overallStatus === "RECEIVABLE"
                  ? "bg-blue-50 text-blue-700"
                  : phonch.overallStatus === "MIXED"
                  ? "bg-purple-50 text-purple-700"
                  : "bg-amber-50 text-amber-700"
              }`}
            >
              {phonch.overallStatus === "CLEARED"
                ? "Cleared"
                : phonch.overallStatus === "RECEIVABLE"
                ? "Receivable"
                : phonch.overallStatus === "MIXED"
                ? "Mixed"
                : "Payable"}
            </span>
          </div>
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">Sr</th>
                <th className="px-3 py-3">Bilty No.</th>
                <th className="px-3 py-3">Challan No.</th>
                <th className="px-3 py-3">Chassis</th>
                <th className="px-3 py-3">Engine</th>
                <th className="px-3 py-3">Vehicle</th>
                <th className="px-3 py-3">Clearing Agent</th>
                <th className="px-3 py-3">Total Rent</th>
                <th className="px-3 py-3">Delivery Charges</th>
                <th className="px-3 py-3">Net Rent</th>
                <th className="px-3 py-3">Carrier Payable</th>
                <th className="px-3 py-3">CA Payable</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {phonch.vehicles.map((v) => {
                const totalRent = Number(v.totalRent);
                const deliveryCharges = Number(v.deliveryCharges);
                const carrierPayable = Number(v.carrierPayable);
                const netRent = Math.round((totalRent - deliveryCharges) * 100) / 100;
                const caPayable = Math.round((netRent - carrierPayable) * 100) / 100;
                return (
                  <tr key={v.id}>
                    <td className="px-3 py-2 text-gray-500">{v.lineNo}</td>
                    <td className="px-3 py-2">{v.biltyNo || "—"}</td>
                    <td className="px-3 py-2">{v.challanNo || "—"}</td>
                    <td className="px-3 py-2">{v.chassisNumber || "—"}</td>
                    <td className="px-3 py-2">{v.engineNumber || "—"}</td>
                    <td className="px-3 py-2">{v.vehicleName || "—"}</td>
                    <td className="px-3 py-2">{v.clearingAgentParty?.partyName || "—"}</td>
                    <td className="px-3 py-2">{formatCurrency(totalRent)}</td>
                    <td className="px-3 py-2">{formatCurrency(deliveryCharges)}</td>
                    <td className="px-3 py-2">{formatCurrency(netRent)}</td>
                    <td className="px-3 py-2">{formatCurrency(carrierPayable)}</td>
                    <td className="px-3 py-2">{formatCurrency(caPayable)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* STATUS - compact, per Step 16/27 of the spec: only
            Transporter Carrier Rent Payable and Clearing Agent Amanat
            Payable, no dashboard. */}
        <div className="mt-6 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Status</h2>
          <div className="space-y-2 text-sm">
            <div className="border-b pb-2">
              <div className="mb-1 text-gray-600">Transporter — {phonch.transporterParty.partyName}</div>
              {/* Two INDEPENDENT balances, never merged - Carrier Rent
                  Payable (a payable) and Delivery Recovery (the
                  opposite-direction receivable, only ever non-zero for
                  a Total Rent = 0 vehicle - see
                  lib/private-phonch-accounting.ts). Both always shown,
                  even at Rs. 0, so the two never look like one figure. */}
              <div className="flex items-center justify-between pl-3">
                <span className="text-xs text-gray-500">Carrier Rent Payable</span>
                <span className={phonch.transporterState.remainingDue > 0.009 ? "font-semibold text-amber-700" : "font-semibold text-green-700"}>
                  {formatCurrency(phonch.transporterState.remainingDue)} Remaining
                  {phonch.transporterState.paidAmount > 0.009 && (
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      ({formatCurrency(phonch.transporterState.paidAmount)} paid of {formatCurrency(phonch.transporterState.totalPayable)})
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between pl-3">
                <span className="text-xs text-gray-500">Delivery Recovery</span>
                <span className={phonch.transporterDeliveryRecoveryState.remainingDue > 0.009 ? "font-semibold text-amber-700" : "font-semibold text-green-700"}>
                  {formatCurrency(phonch.transporterDeliveryRecoveryState.remainingDue)} Remaining
                  {phonch.transporterDeliveryRecoveryState.recoveredAmount > 0.009 && (
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      ({formatCurrency(phonch.transporterDeliveryRecoveryState.recoveredAmount)} received of{" "}
                      {formatCurrency(phonch.transporterDeliveryRecoveryState.totalRecovery)})
                    </span>
                  )}
                </span>
              </div>
            </div>
            {phonch.clearingAgentStates.length === 0 && phonch.clearingAgentRecoveryStates.length === 0 ? (
              <div className="text-gray-500">No Clearing Agent Amanat Payable on this Private Phonch.</div>
            ) : (
              <>
                {phonch.clearingAgentStates.map((s) => (
                  <div key={s.partyId} className="flex items-center justify-between border-b pb-2 last:border-b-0">
                    <span className="text-gray-600">Clearing Agent — {s.partyName} (Amanat Payable)</span>
                    <span className={s.remainingDue > 0.009 ? "font-semibold text-amber-700" : "font-semibold text-green-700"}>
                      {formatCurrency(s.remainingDue)} Remaining
                      {s.paidAmount > 0.009 && (
                        <span className="ml-2 text-xs font-normal text-gray-500">
                          ({formatCurrency(s.paidAmount)} paid of {formatCurrency(s.totalPayable)})
                        </span>
                      )}
                    </span>
                  </div>
                ))}
                {/* Opposite-polarity receivable - never the same
                    Clearing Agent as an Amanat Payable row above (see
                    resolvePrivatePhonchInput()'s own mutual-exclusivity
                    guard), so this never looks like one merged figure. */}
                {phonch.clearingAgentRecoveryStates.map((s) => (
                  <div key={s.partyId} className="flex items-center justify-between border-b pb-2 last:border-b-0">
                    <span className="text-gray-600">Clearing Agent — {s.partyName} (Delivery Recovery)</span>
                    <span className={s.remainingDue > 0.009 ? "font-semibold text-amber-700" : "font-semibold text-green-700"}>
                      {formatCurrency(s.remainingDue)} Remaining
                      {s.recoveredAmount > 0.009 && (
                        <span className="ml-2 text-xs font-normal text-gray-500">
                          ({formatCurrency(s.recoveredAmount)} received of {formatCurrency(s.totalRecovery)})
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <div className="w-72 rounded-xl border bg-white p-5 shadow-sm text-sm">
            <div className="flex justify-between py-1">
              <span className="text-gray-600">Total Rent</span>
              <span className="font-medium">{formatCurrency(phonch.totals.totalRent)}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-gray-600">Total Delivery Charges</span>
              <span className="font-medium">{formatCurrency(phonch.totals.totalDeliveryCharges)}</span>
            </div>
            <div className="flex justify-between border-t py-1 font-semibold">
              <span>Total Carrier Payable</span>
              <span>{formatCurrency(phonch.totals.totalCarrierPayable)}</span>
            </div>
            <div className="flex justify-between py-1 font-semibold">
              <span>Total CA Payable</span>
              <span>{formatCurrency(phonch.totals.totalCaPayable)}</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
