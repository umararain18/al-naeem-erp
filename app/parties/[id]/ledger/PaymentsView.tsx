"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n/party-ledger";
import AllocationPanel from "./AllocationPanel";

type PaymentRow = {
  journalLineId: string;
  journalEntryId: string;
  date: string;
  direction: "DEBIT" | "CREDIT";
  amount: number;
  cashBankAccountName: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
  description: string;
  isQualifyingPayment: boolean;
  eligibleForAllocation: boolean;
  allocated: number;
  unallocated: number;
  allocationStatus: "UNALLOCATED" | "PARTIALLY_ALLOCATED" | "FULLY_ALLOCATED" | null;
  allocations: { targetSourceType: string; targetSourceId: string; allocatedAmount: number }[];
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function statusLabel(status: PaymentRow["allocationStatus"], lang: Lang) {
  if (status === "FULLY_ALLOCATED") return t("fullyAllocated", lang);
  if (status === "PARTIALLY_ALLOCATED") return t("partiallyAllocated", lang);
  if (status === "UNALLOCATED") return t("unallocated", lang);
  return "—";
}

function statusColor(status: PaymentRow["allocationStatus"]) {
  if (status === "FULLY_ALLOCATED") return "text-green-600";
  if (status === "PARTIALLY_ALLOCATED") return "text-amber-600";
  if (status === "UNALLOCATED") return "text-red-600";
  return "text-gray-400";
}

function sourceDestination(row: PaymentRow): { href: string; label: string } {
  if (row.sourceType === "CHALLAN" && row.sourceId) {
    return { href: `/challan/${row.sourceId}`, label: `Challan ${row.sourceNumber || row.sourceId}` };
  }
  if (row.sourceType === "BILTY" && row.sourceId) {
    return { href: `/bilty/${row.sourceId}`, label: `Bilty ${row.sourceNumber || row.sourceId}` };
  }
  return { href: `/accounting-transactions/${row.journalEntryId}`, label: "Daily Posting" };
}

export default function PaymentsView({ partyId, lang }: { partyId: string; lang: Lang }) {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "UNALLOCATED" | "PARTIALLY_ALLOCATED" | "FULLY_ALLOCATED">("ALL");
  const [activePaymentId, setActivePaymentId] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const query = new URLSearchParams();
      if (statusFilter !== "ALL") query.set("allocationStatus", statusFilter);
      const response = await fetch(`/api/parties/${partyId}/payments?${query.toString()}`);
      const result = await response.json();
      if (!response.ok || !result.success) {
        setError(result.message || "Unable to load payments");
        return;
      }
      setPayments(result.payments);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, statusFilter]);

  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold">{t("payments", lang)}</h2>
        <div className="flex gap-2 text-sm">
          {(["ALL", "UNALLOCATED", "PARTIALLY_ALLOCATED", "FULLY_ALLOCATED"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg border ${statusFilter === s ? "bg-blue-600 text-white border-blue-600" : "hover:bg-gray-50"}`}
            >
              {s === "ALL" ? "All" : statusLabel(s, lang)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500 p-6 text-center">Loading...</p>
      ) : error ? (
        <p className="text-red-600 p-6 text-center">{error}</p>
      ) : payments.length === 0 ? (
        <p className="text-gray-500 p-10 text-center">{t("noData", lang)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">{t("date", lang)}</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2 text-right">{t("amount", lang)}</th>
                <th className="px-3 py-2">Cash/Bank</th>
                <th className="px-3 py-2">{t("source", lang)}</th>
                <th className="px-3 py-2 text-right">{t("allocated", lang)}</th>
                <th className="px-3 py-2 text-right">{t("unallocated", lang)}</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {payments.map((row) => {
                const dest = sourceDestination(row);
                return (
                  <tr key={row.journalLineId} className="hover:bg-gray-50">
                    <td className="px-3 py-2">{formatDate(row.date)}</td>
                    <td className="px-3 py-2">{row.direction === "DEBIT" ? t("receipt", lang) : t("payment", lang)}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(row.amount)}</td>
                    <td className="px-3 py-2">{row.cashBankAccountName || "—"}</td>
                    <td className="px-3 py-2">
                      <Link href={dest.href} className="text-blue-600 hover:underline">
                        {dest.label}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right">{row.eligibleForAllocation ? formatCurrency(row.allocated) : "—"}</td>
                    <td className="px-3 py-2 text-right">{row.eligibleForAllocation ? formatCurrency(row.unallocated) : "—"}</td>
                    <td className={`px-3 py-2 font-medium ${statusColor(row.allocationStatus)}`}>
                      {row.eligibleForAllocation ? statusLabel(row.allocationStatus, lang) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.eligibleForAllocation ? (
                        <button
                          type="button"
                          onClick={() => setActivePaymentId(row.journalLineId)}
                          className="text-xs border rounded-lg px-3 py-1.5 hover:bg-gray-50"
                        >
                          {t("allocate", lang)}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">
                          {row.isQualifyingPayment ? "Already linked" : "Not allocatable"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activePaymentId && (
        <AllocationPanel
          partyId={partyId}
          journalLineId={activePaymentId}
          lang={lang}
          onClose={() => setActivePaymentId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
