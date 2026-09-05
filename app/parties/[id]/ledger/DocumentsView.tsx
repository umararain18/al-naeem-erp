"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n/party-ledger";

type DocumentRow = {
  targetSourceType: "BILTY" | "CHALLAN";
  targetSourceId: string;
  documentNo: string;
  documentDate: string;
  totalDue: number;
  receivedOrPaid: number;
  allocatedViaTable: number;
  remainingAllocatable: number;
  status: "UNPAID" | "PARTIALLY_PAID" | "FULLY_PAID";
  challanId: string | null;
  challanNo: string | null;
  biltyId: string | null;
  biltyNo: string | null;
  vehicleRegistrationNumber: string | null;
  chassisNumber: string | null;
  vehicleType: string | null;
  fromLocation: string | null;
  toLocation: string | null;
  biltyRent: number | null;
  carrierRent: number | null;
  commission: number | null;
  billNo: null;
  sequenceIndex: number;
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

const ALL_COLUMNS = [
  "date",
  "documentNo",
  "challanNo",
  "registration",
  "chassis",
  "route",
  "amount",
  "receivedPaid",
  "remaining",
  "status",
] as const;

type ColumnKey = (typeof ALL_COLUMNS)[number];

const COLUMN_LABELS: Record<ColumnKey, string> = {
  date: "Date",
  documentNo: "Bilty/Challan No.",
  challanNo: "Challan No.",
  registration: "Vehicle Reg. No.",
  chassis: "Chassis No.",
  route: "Route",
  amount: "Amount",
  receivedPaid: "Received/Paid",
  remaining: "Remaining",
  status: "Status",
};

const COLUMNS_STORAGE_KEY = "anc-party-ledger-documents-columns";

function statusLabel(status: DocumentRow["status"], lang: Lang) {
  if (status === "FULLY_PAID") return t("fullyPaid", lang);
  if (status === "PARTIALLY_PAID") return t("partiallyPaid", lang);
  return t("unpaid", lang);
}

function statusColor(status: DocumentRow["status"]) {
  if (status === "FULLY_PAID") return "text-green-600";
  if (status === "PARTIALLY_PAID") return "text-amber-600";
  return "text-red-600";
}

export default function DocumentsView({
  partyId,
  lang,
  onlyOutstanding,
}: {
  partyId: string;
  lang: Lang;
  onlyOutstanding: boolean;
}) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [biltyNo, setBiltyNo] = useState("");
  const [challanNo, setChallanNo] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [chassisNumber, setChassisNumber] = useState("");

  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(new Set(ALL_COLUMNS));
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
      if (stored) setVisibleColumns(new Set(JSON.parse(stored)));
    } catch {
      // ignore
    }
  }, []);

  function toggleColumn(col: ColumnKey) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      try {
        window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  }

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError("");
        const query = new URLSearchParams();
        if (onlyOutstanding) query.set("status", "OUTSTANDING");
        if (biltyNo) query.set("biltyNo", biltyNo);
        if (challanNo) query.set("challanNo", challanNo);
        if (registrationNumber) query.set("registrationNumber", registrationNumber);
        if (chassisNumber) query.set("chassisNumber", chassisNumber);

        const response = await fetch(`/api/parties/${partyId}/documents?${query.toString()}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load documents");
          return;
        }

        setDocuments(result.documents);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [partyId, onlyOutstanding, biltyNo, challanNo, registrationNumber, chassisNumber]);

  function documentHref(row: DocumentRow) {
    if (row.targetSourceType === "BILTY" && row.biltyId) return `/bilty/${row.biltyId}`;
    if (row.challanId) return `/challan/${row.challanId}`;
    return null;
  }

  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-4">
        <input
          type="text"
          value={biltyNo}
          onChange={(e) => setBiltyNo(e.target.value)}
          placeholder={t("bilty", lang) + " No."}
          className="border rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={challanNo}
          onChange={(e) => setChallanNo(e.target.value)}
          placeholder={t("challan", lang) + " No."}
          className="border rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={registrationNumber}
          onChange={(e) => setRegistrationNumber(e.target.value)}
          placeholder={t("registrationNo", lang)}
          className="border rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={chassisNumber}
          onChange={(e) => setChassisNumber(e.target.value)}
          placeholder={t("chassisNo", lang)}
          className="border rounded-lg px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setBiltyNo("");
              setChallanNo("");
              setRegistrationNumber("");
              setChassisNumber("");
            }}
            className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-50 flex-1"
          >
            {t("reset", lang)}
          </button>
          <button
            type="button"
            onClick={() => setShowColumnPicker((v) => !v)}
            className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-50"
          >
            {t("columns", lang)}
          </button>
        </div>
      </div>

      {showColumnPicker && (
        <div className="mb-4 p-3 border rounded-lg bg-gray-50 flex flex-wrap gap-3">
          {ALL_COLUMNS.map((col) => (
            <label key={col} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={visibleColumns.has(col)} onChange={() => toggleColumn(col)} />
              {COLUMN_LABELS[col]}
            </label>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 p-6 text-center">Loading...</p>
      ) : error ? (
        <p className="text-red-600 p-6 text-center">{error}</p>
      ) : documents.length === 0 ? (
        <p className="text-gray-500 p-10 text-center">{t("noData", lang)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                {visibleColumns.has("date") && <th className="px-3 py-2">{t("date", lang)}</th>}
                {visibleColumns.has("documentNo") && <th className="px-3 py-2">{COLUMN_LABELS.documentNo}</th>}
                {visibleColumns.has("challanNo") && <th className="px-3 py-2">{t("challan", lang)} No.</th>}
                {visibleColumns.has("registration") && <th className="px-3 py-2">{t("registrationNo", lang)}</th>}
                {visibleColumns.has("chassis") && <th className="px-3 py-2">{t("chassisNo", lang)}</th>}
                {visibleColumns.has("route") && <th className="px-3 py-2">{t("route", lang)}</th>}
                {visibleColumns.has("amount") && <th className="px-3 py-2 text-right">{t("amount", lang)}</th>}
                {visibleColumns.has("receivedPaid") && <th className="px-3 py-2 text-right">{COLUMN_LABELS.receivedPaid}</th>}
                {visibleColumns.has("remaining") && <th className="px-3 py-2 text-right">{t("remaining", lang)}</th>}
                {visibleColumns.has("status") && <th className="px-3 py-2">{t("status", lang)}</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {documents.map((row) => {
                const href = documentHref(row);
                return (
                  <tr key={`${row.targetSourceType}:${row.targetSourceId}`} className="hover:bg-gray-50">
                    {visibleColumns.has("date") && <td className="px-3 py-2">{formatDate(row.documentDate)}</td>}
                    {visibleColumns.has("documentNo") && (
                      <td className="px-3 py-2 font-medium">
                        {href ? (
                          <Link href={href} className="text-blue-600 hover:underline">
                            {row.documentNo}
                          </Link>
                        ) : (
                          row.documentNo
                        )}
                        <span className="ml-1 text-xs text-gray-400">
                          ({row.targetSourceType === "BILTY" ? t("bilty", lang) : t("carrierRent", lang)})
                        </span>
                      </td>
                    )}
                    {visibleColumns.has("challanNo") && (
                      <td className="px-3 py-2">
                        {row.challanId && row.challanNo ? (
                          <Link href={`/challan/${row.challanId}`} className="text-blue-600 hover:underline">
                            {row.challanNo}
                          </Link>
                        ) : (
                          row.challanNo || "—"
                        )}
                      </td>
                    )}
                    {visibleColumns.has("registration") && <td className="px-3 py-2">{row.vehicleRegistrationNumber || "—"}</td>}
                    {visibleColumns.has("chassis") && <td className="px-3 py-2">{row.chassisNumber || "—"}</td>}
                    {visibleColumns.has("route") && (
                      <td className="px-3 py-2">
                        {row.fromLocation && row.toLocation ? `${row.fromLocation} → ${row.toLocation}` : "—"}
                      </td>
                    )}
                    {visibleColumns.has("amount") && <td className="px-3 py-2 text-right">{formatCurrency(row.totalDue)}</td>}
                    {visibleColumns.has("receivedPaid") && <td className="px-3 py-2 text-right">{formatCurrency(row.receivedOrPaid)}</td>}
                    {visibleColumns.has("remaining") && (
                      <td className="px-3 py-2 text-right font-medium">{formatCurrency(row.remainingAllocatable)}</td>
                    )}
                    {visibleColumns.has("status") && (
                      <td className={`px-3 py-2 font-medium ${statusColor(row.status)}`}>{statusLabel(row.status, lang)}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
