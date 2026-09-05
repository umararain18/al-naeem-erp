"use client";

import { useEffect, useState } from "react";
import { t, type Lang } from "@/lib/i18n/party-ledger";

type DocumentRow = {
  targetSourceType: "BILTY" | "CHALLAN";
  targetSourceId: string;
  documentNo: string;
  challanId: string | null;
  challanNo: string | null;
  biltyId: string | null;
  biltyNo: string | null;
  vehicleRegistrationNumber: string | null;
  chassisNumber: string | null;
  fromLocation: string | null;
  toLocation: string | null;
  biltyRent: number | null;
  carrierRent: number | null;
  commission: number | null;
  billNo: string | null;
  remainingAllocatable: number;
};

type LedgerSummary = {
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function describeBilty(row: DocumentRow): string {
  const parts: string[] = [];
  parts.push(`Bilty ${row.biltyNo}`);
  if (row.challanNo) parts.push(`Challan ${row.challanNo}`);
  if (row.vehicleRegistrationNumber) parts.push(row.vehicleRegistrationNumber);
  if (row.fromLocation && row.toLocation) parts.push(`${row.fromLocation} → ${row.toLocation}`);
  if (row.biltyRent) parts.push(`Bilty Rent ${formatCurrency(row.biltyRent)}`);
  if (row.commission) parts.push(`Commission ${formatCurrency(row.commission)}`);
  if (row.billNo) parts.push(`Bill No. ${row.billNo}`);
  return parts.join(" · ");
}

export default function StatementView({
  partyId,
  partyName,
  lang,
}: {
  partyId: string;
  partyName: string;
  lang: Lang;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [summary, setSummary] = useState<LedgerSummary | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError("");
        const query = new URLSearchParams();
        if (from) query.set("from", from);
        if (to) query.set("to", to);

        const [ledgerRes, docsRes] = await Promise.all([
          fetch(`/api/parties/${partyId}/ledger?${query.toString()}`),
          fetch(`/api/parties/${partyId}/documents`),
        ]);
        const ledgerJson = await ledgerRes.json();
        const docsJson = await docsRes.json();

        if (!ledgerRes.ok || !ledgerJson.success) {
          setError(ledgerJson.message || "Unable to load statement");
          return;
        }

        setSummary(ledgerJson.summary);
        if (docsRes.ok && docsJson.success) setDocuments(docsJson.documents);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [partyId, from, to]);

  const biltyRows = documents.filter((d) => d.targetSourceType === "BILTY");

  return (
    <div>
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" />
        <button
          type="button"
          onClick={() => {
            setFrom("");
            setTo("");
          }}
          className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-50"
        >
          {t("reset", lang)}
        </button>
        <div className="flex-1" />
        {lang === "ur" ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 max-w-[220px] text-right">
              اردو PDF کے لیے پرنٹ کریں اور "Save as PDF" منتخب کریں
            </span>
            <button type="button" onClick={() => window.print()} className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 bg-blue-600 text-white border-blue-600">
              {t("print", lang)}
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={() => window.print()} className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
              {t("print", lang)}
            </button>
            <a
              href={`/api/parties/${partyId}/statement/pdf?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`}
              target="_blank"
              rel="noreferrer"
              className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 bg-blue-600 text-white border-blue-600"
            >
              PDF
            </a>
          </>
        )}
      </div>

      {loading ? (
        <p className="text-gray-500 p-6 text-center bg-white rounded-xl shadow-sm">Loading...</p>
      ) : error ? (
        <p className="text-red-600 p-6 text-center bg-white rounded-xl shadow-sm">{error}</p>
      ) : (
        <div className="bg-white rounded-xl shadow-sm p-8">
          <div className="text-center mb-6 border-b pb-4">
            <h2 className="text-xl font-bold">AL NAEEM CAR CARRIERS SERVICE</h2>
            <p className="text-gray-600">{t("statementOfAccount", lang)}</p>
          </div>

          <div className="flex justify-between mb-6 text-sm">
            <div>
              <p className="text-gray-500">{t("party", lang)}</p>
              <p className="font-semibold">{partyName}</p>
            </div>
            <div className="text-right">
              <p className="text-gray-500">{t("period", lang)}</p>
              <p className="font-semibold">
                {from ? formatDate(from) : "—"} — {to ? formatDate(to) : "—"}
              </p>
            </div>
          </div>

          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8 text-sm">
              <div>
                <p className="text-gray-500">{t("openingBalance", lang)}</p>
                <p className="font-semibold">{formatCurrency(summary.openingBalance)}</p>
              </div>
              <div>
                <p className="text-gray-500">{t("debit", lang)}</p>
                <p className="font-semibold">{formatCurrency(summary.periodDebit)}</p>
              </div>
              <div>
                <p className="text-gray-500">{t("credit", lang)}</p>
                <p className="font-semibold">{formatCurrency(summary.periodCredit)}</p>
              </div>
              <div>
                <p className="text-gray-500">{t("closingBalance", lang)}</p>
                <p className="font-semibold">{formatCurrency(summary.closingBalance)}</p>
              </div>
            </div>
          )}

          <h3 className="font-semibold mb-3">Transaction Details</h3>
          {biltyRows.length === 0 ? (
            <p className="text-gray-500 text-sm">{t("noData", lang)}</p>
          ) : (
            <ol className="space-y-2 list-decimal list-inside text-sm">
              {biltyRows.map((row) => (
                <li key={row.targetSourceId}>{describeBilty(row)}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
