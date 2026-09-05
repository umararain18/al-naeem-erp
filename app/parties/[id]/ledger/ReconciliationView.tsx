"use client";

import { useEffect, useState } from "react";
import { t, type Lang } from "@/lib/i18n/party-ledger";

type DocumentRow = {
  totalDue: number;
  receivedOrPaid: number;
  remainingAllocatable: number;
  status: "UNPAID" | "PARTIALLY_PAID" | "FULLY_PAID";
};

type PaymentRow = {
  amount: number;
  allocated: number;
  unallocated: number;
  eligibleForAllocation: boolean;
  allocationStatus: "UNALLOCATED" | "PARTIALLY_ALLOCATED" | "FULLY_ALLOCATED" | null;
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

// Pure tally over numbers ALREADY computed by the /documents and
// /payments endpoints (themselves built on lib/payment-allocation.ts
// and the protected settlement/challan-financials architecture) - no
// new financial calculation is introduced here, only addition.
export default function ReconciliationView({ partyId, lang }: { partyId: string; lang: Lang }) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError("");
        const [docsRes, paysRes] = await Promise.all([
          fetch(`/api/parties/${partyId}/documents`),
          fetch(`/api/parties/${partyId}/payments`),
        ]);
        const docsJson = await docsRes.json();
        const paysJson = await paysRes.json();

        if (!docsRes.ok || !docsJson.success) {
          setError(docsJson.message || "Unable to load reconciliation data");
          return;
        }
        if (!paysRes.ok || !paysJson.success) {
          setError(paysJson.message || "Unable to load reconciliation data");
          return;
        }

        setDocuments(docsJson.documents);
        setPayments(paysJson.payments);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [partyId]);

  if (loading) return <p className="text-gray-500 p-6 text-center bg-white rounded-xl shadow-sm">Loading...</p>;
  if (error) return <p className="text-red-600 p-6 text-center bg-white rounded-xl shadow-sm">{error}</p>;

  const totalOutstanding = documents.reduce((s, d) => s + d.remainingAllocatable, 0);
  const totalPayments = payments.reduce((s, p) => s + p.amount, 0);
  const totalAllocated = payments.reduce((s, p) => s + p.allocated, 0);
  const totalUnallocated = payments.reduce((s, p) => (p.eligibleForAllocation ? s + p.unallocated : s), 0);
  const difference = totalOutstanding - totalAllocated;

  const fullyPaid = documents.filter((d) => d.status === "FULLY_PAID").length;
  const partiallyPaid = documents.filter((d) => d.status === "PARTIALLY_PAID").length;
  const unpaid = documents.filter((d) => d.status === "UNPAID").length;
  const unallocatedPayments = payments.filter((p) => p.eligibleForAllocation && p.allocationStatus === "UNALLOCATED").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <p className="text-sm text-gray-500">{t("totalOutstanding", lang)}</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalOutstanding)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <p className="text-sm text-gray-500">{t("totalPayments", lang)}</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalPayments)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <p className="text-sm text-gray-500">{t("allocated", lang)}</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalAllocated)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <p className="text-sm text-gray-500">{t("unallocated", lang)}</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalUnallocated)}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl p-5 shadow-sm">
        <p className="text-sm text-gray-500">{t("remainingDifference", lang)}</p>
        <p className={`text-2xl font-bold mt-1 ${Math.abs(difference) < 0.01 ? "text-green-600" : "text-amber-600"}`}>
          {formatCurrency(difference)}
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Total Outstanding − Total Allocated (a positive difference means more is still owed than has been allocated
          so far; documents may also have money received directly against them without going through allocation).
        </p>
      </div>

      <div className="bg-white rounded-xl p-5 shadow-sm">
        <h3 className="font-semibold mb-3">Document Status</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-gray-500">{t("fullyPaid", lang)}</p>
            <p className="font-semibold text-green-600">{fullyPaid}</p>
          </div>
          <div>
            <p className="text-gray-500">{t("partiallyPaid", lang)}</p>
            <p className="font-semibold text-amber-600">{partiallyPaid}</p>
          </div>
          <div>
            <p className="text-gray-500">{t("unpaid", lang)}</p>
            <p className="font-semibold text-red-600">{unpaid}</p>
          </div>
          <div>
            <p className="text-gray-500">{t("unallocated", lang)} Payments</p>
            <p className="font-semibold text-red-600">{unallocatedPayments}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
