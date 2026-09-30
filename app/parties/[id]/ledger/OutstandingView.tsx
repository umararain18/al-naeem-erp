"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n/party-ledger";
import { presetRange } from "@/components/LedgerFilters";
import { filterOutstandingRows, documentDateKey } from "@/lib/outstanding-filters";

// ============================================================
// PARTY OUTSTANDING LEDGER (document-level) - powered by the NEW,
// dedicated GET /api/parties/[id]/outstanding (lib/party-outstanding.ts).
// Completely separate from the existing Documents tab (DocumentsView.tsx
// + GET /api/parties/[id]/documents), which is left unmodified.
//
// FILTERS (Search/Date/Type/Direction) are a pure, read-only
// POST-PROCESSING narrowing of the already-computed row list this API
// already returns - they never change Original/Settled/Remaining for
// any row, and never re-derive the Outstanding calculation itself.
// Summary totals are recomputed from the FILTERED rows using the
// exact same sum getPartyOutstandingSummary() itself uses (Receivable/
// Payable = sum of remainingAmount by direction), just run client-side
// over the narrowed set - no second calculation engine.
//
// DATE FILTER SEMANTICS (deliberate, see lib/party-outstanding.ts):
// the Outstanding engine has no historical/as-of-date reconstruction
// mechanism at all - Settled/Remaining are always "as of right now".
// This filter therefore narrows WHICH DOCUMENTS show, by each row's
// own documentDate (Bilty.date / Challan.loadingDate / etc.) - it is
// explicitly labelled "Document Date" and never claims to show what
// Outstanding looked like as of a past date.
// ============================================================

type DrillDownEntry = {
  journalLineId: string;
  journalEntryId: string;
  date: string;
  debit: number;
  credit: number;
  description: string;
  accountId: string;
  accountName: string;
};

type OutstandingRow = {
  component:
    | "COLLECTION"
    | "COMMISSION"
    | "CARRIER_RENT"
    | "BILL"
    | "SHOWROOM_PHONCH"
    | "PRIVATE_PHONCH_CARRIER_PAYABLE"
    | "PRIVATE_PHONCH_CA_PAYABLE"
    | "PRIVATE_PHONCH_TRANSPORTER_RECOVERY"
    | "PRIVATE_PHONCH_CA_RECOVERY";
  direction: "RECEIVABLE" | "PAYABLE";
  documentType: "BILTY" | "CHALLAN" | "BILL" | "PHONCH" | "PRIVATE_PHONCH";
  documentNo: string;
  documentDate: string;
  description: string;
  originalAmount: number;
  settledAmount: number;
  remainingAmount: number;
  settledDrillDown: DrillDownEntry[] | null;
  biltyId?: string | null;
  challanId?: string | null;
  billId?: string | null;
  phonchId?: string | null;
  privatePhonchId?: string | null;
};

type OutstandingResponse = {
  success: boolean;
  party: { id: string; partyName: string; phone: string | null };
  documents: OutstandingRow[];
  summary: { totalReceivable: number; totalPayable: number; netBalance: number };
  message?: string;
};

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Karachi" }).format(new Date(value));
}

const DOCUMENT_LABELS: Record<OutstandingRow["documentType"], string> = {
  BILTY: "Bilty",
  CHALLAN: "Challan",
  BILL: "Bill",
  PHONCH: "Showroom Phonch",
  PRIVATE_PHONCH: "Private Phonch",
};

// Same document-type set/labels Normal Ledger's own Type filter uses
// (lib/ledger-description.ts's LedgerEntryType) - "PHONCH" here maps
// to the identical "Showroom Phonch" label, never a second/different
// classification. "OTHER" has no Outstanding equivalent (every
// Outstanding row already has a real, known document type), so it is
// intentionally not offered here.
const TYPE_OPTIONS: { value: "ALL" | OutstandingRow["documentType"]; label: string }[] = [
  { value: "ALL", label: "All Types" },
  { value: "BILTY", label: "Bilty" },
  { value: "CHALLAN", label: "Challan" },
  { value: "PRIVATE_PHONCH", label: "Private Phonch" },
  { value: "PHONCH", label: "Showroom Phonch" },
  { value: "BILL", label: "Bill" },
];

const DIRECTION_OPTIONS: { value: "ALL" | OutstandingRow["direction"]; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "RECEIVABLE", label: "Receivable" },
  { value: "PAYABLE", label: "Payable" },
];

const DATE_PRESETS = ["TODAY", "YESTERDAY", "THIS_WEEK", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "ALL_TIME"] as const;

function documentLabel(row: OutstandingRow): string {
  return DOCUMENT_LABELS[row.documentType];
}

function documentHref(row: OutstandingRow): string | null {
  if (row.documentType === "BILTY" && row.biltyId) return `/bilty/${row.biltyId}`;
  if (row.documentType === "CHALLAN" && row.challanId) return `/challan/${row.challanId}`;
  if (row.documentType === "BILL" && row.billId) return `/bill/${row.billId}`;
  if (row.documentType === "PHONCH" && row.phonchId) return `/phonch/${row.phonchId}`;
  if (row.documentType === "PRIVATE_PHONCH" && row.privatePhonchId) return `/private-phonch/${row.privatePhonchId}`;
  return null;
}

function rowKey(row: OutstandingRow): string {
  return `${row.component}:${row.documentType}:${row.documentNo}:${row.biltyId || row.challanId || row.billId || row.phonchId || row.privatePhonchId}`;
}

export default function OutstandingView({ partyId, lang }: { partyId: string; lang: Lang }) {
  const [data, setData] = useState<OutstandingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"ALL" | OutstandingRow["documentType"]>("ALL");
  const [directionFilter, setDirectionFilter] = useState<"ALL" | OutstandingRow["direction"]>("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError("");
        const response = await fetch(`/api/parties/${partyId}/outstanding`);
        const result = await response.json();
        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load outstanding ledger");
          return;
        }
        setData(result);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [partyId]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Shared predicate (lib/outstanding-filters.ts) - the EXACT same
  // function the PDF export route runs server-side, so screen and
  // export can never apply two different filtering rules.
  const filtered = useMemo(() => {
    if (!data) return [];
    return filterOutstandingRows(data.documents, {
      search,
      documentType: typeFilter === "ALL" ? null : typeFilter,
      direction: directionFilter === "ALL" ? null : directionFilter,
      from: from || null,
      to: to || null,
    });
  }, [data, search, typeFilter, directionFilter, from, to]);

  // Same summation getPartyOutstandingSummary() (lib/party-outstanding.ts)
  // already does - just run here over the FILTERED subset, so the
  // totals shown always match exactly what filtered rows the table
  // itself displays. Never a second/different calculation.
  const filteredSummary = useMemo(() => {
    const totalReceivable = filtered.filter((r) => r.direction === "RECEIVABLE").reduce((s, r) => s + r.remainingAmount, 0);
    const totalPayable = filtered.filter((r) => r.direction === "PAYABLE").reduce((s, r) => s + r.remainingAmount, 0);
    return { totalReceivable, totalPayable, netBalance: totalReceivable - totalPayable };
  }, [filtered]);

  const hasActiveFilters = !!search.trim() || typeFilter !== "ALL" || directionFilter !== "ALL" || !!from || !!to;

  // Export must reflect exactly the same active filters the screen
  // itself is showing - the PDF route applies the SAME
  // filterOutstandingRows() predicate server-side (see
  // lib/outstanding-filters.ts), so passing these params through is
  // what makes "screen dataset = export dataset" hold.
  const exportQuery = new URLSearchParams({
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(typeFilter !== "ALL" ? { type: typeFilter } : {}),
    ...(directionFilter !== "ALL" ? { direction: directionFilter } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }).toString();

  function clearFilters() {
    setSearch("");
    setTypeFilter("ALL");
    setDirectionFilter("ALL");
    setFrom("");
    setTo("");
  }

  if (loading) {
    return <div className="bg-white rounded-xl shadow-sm p-10 text-center text-gray-500">Loading outstanding ledger...</div>;
  }
  if (error || !data) {
    return <div className="bg-white rounded-xl shadow-sm p-10 text-center text-red-600">{error || "Unable to load outstanding ledger"}</div>;
  }

  return (
    <div>
      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <p className="text-sm text-gray-500">{t("receivable", lang)} Outstanding</p>
          <p className="text-xl font-bold mt-1 text-green-600">{formatCurrency(filteredSummary.totalReceivable)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <p className="text-sm text-gray-500">{t("payable", lang)} Outstanding</p>
          <p className="text-xl font-bold mt-1 text-red-600">{formatCurrency(filteredSummary.totalPayable)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <p className="text-sm text-gray-500">Net Balance</p>
          <p className={`text-xl font-bold mt-1 ${filteredSummary.netBalance >= 0 ? "text-green-600" : "text-red-600"}`}>
            {formatCurrency(Math.abs(filteredSummary.netBalance))} {filteredSummary.netBalance >= 0 ? `(${t("receivable", lang)})` : `(${t("payable", lang)})`}
          </p>
        </div>
      </div>
      {hasActiveFilters && (
        <p className="text-xs text-gray-500 mb-4 -mt-2">
          Totals above reflect the filtered rows only - not the party&apos;s full outstanding balance.
        </p>
      )}

      {/* Filters + Export */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search document no. or description..."
            className="border rounded-lg px-3 py-2 text-sm md:col-span-2"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            value={directionFilter}
            onChange={(e) => setDirectionFilter(e.target.value as typeof directionFilter)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            {DIRECTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" placeholder="Document date from" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" placeholder="Document date to" />
          <button type="button" onClick={clearFilters} className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
            Clear Filters
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          {DATE_PRESETS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                const range = presetRange(key);
                setFrom(range.from);
                setTo(range.to);
              }}
              className="text-xs border rounded-lg px-3 py-1.5 hover:bg-gray-50 text-gray-600"
            >
              {key
                .split("_")
                .map((w) => w[0] + w.slice(1).toLowerCase())
                .join(" ")}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Date filters by each document&apos;s own date - it does not reconstruct what Settled/Remaining looked like on a past date.
        </p>

        <div className="flex justify-between items-center mt-3">
          <p className="text-xs text-gray-500">
            {hasActiveFilters ? `${filtered.length} of ${data.documents.length} documents` : `${data.documents.length} documents`}
          </p>
          <a
            href={`/api/parties/${partyId}/outstanding/pdf${exportQuery ? `?${exportQuery}` : ""}`}
            target="_blank"
            rel="noreferrer"
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 bg-blue-600 text-white border-blue-600 text-center"
          >
            Export PDF
          </a>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-gray-500">
            {data.documents.length === 0 ? "No outstanding balance" : "No matching documents found."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">{t("date", lang)}</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Document No.</th>
                  <th className="px-4 py-3">{t("description", lang)}</th>
                  <th className="px-4 py-3 text-right">Original Amount</th>
                  <th className="px-4 py-3 text-right">Settled</th>
                  <th className="px-4 py-3 text-right">Remaining Due</th>
                  <th className="px-4 py-3">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((row) => {
                  const href = documentHref(row);
                  const key = rowKey(row);
                  const isDrillable = !!row.settledDrillDown && row.settledDrillDown.length > 0;
                  const isExpanded = expanded.has(key);
                  return (
                    <Fragment key={key}>
                      <tr className="hover:bg-gray-50">
                        <td className="px-4 py-3">{formatDate(row.documentDate)}</td>
                        <td className="px-4 py-3">{documentLabel(row)}</td>
                        <td className="px-4 py-3 font-medium">
                          {href ? (
                            <Link href={href} className="text-blue-600 hover:underline">
                              {row.documentNo}
                            </Link>
                          ) : (
                            row.documentNo
                          )}
                        </td>
                        <td className="px-4 py-3">{row.description}</td>
                        <td className="px-4 py-3 text-right">{formatCurrency(row.originalAmount)}</td>
                        <td className="px-4 py-3 text-right">
                          {isDrillable ? (
                            <button
                              type="button"
                              onClick={() => toggleExpanded(key)}
                              className="text-blue-600 hover:underline font-medium underline decoration-dotted"
                              title="View the actual Daily Posting entries behind this amount"
                            >
                              {formatCurrency(row.settledAmount)} {isExpanded ? "▲" : "▼"}
                            </button>
                          ) : (
                            formatCurrency(row.settledAmount)
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">{formatCurrency(row.remainingAmount)}</td>
                        <td className="px-4 py-3">
                          <span className={row.direction === "RECEIVABLE" ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                            {row.direction === "RECEIVABLE" ? t("receivable", lang) : t("payable", lang)}
                          </span>
                        </td>
                      </tr>
                      {isExpanded && isDrillable && (
                        <tr className="bg-blue-50/40">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="text-xs text-gray-500 mb-2">
                              {row.settledDrillDown!.length === 1
                                ? "1 actual Daily Posting entry behind this Settled amount:"
                                : `${row.settledDrillDown!.length} actual Daily Posting entries behind this Settled amount (total ${formatCurrency(row.settledAmount)}):`}
                            </div>
                            <table className="w-full text-xs border rounded-lg overflow-hidden">
                              <thead className="bg-white text-gray-500">
                                <tr>
                                  <th className="px-3 py-2 text-left">{t("date", lang)}</th>
                                  <th className="px-3 py-2 text-left">Account</th>
                                  <th className="px-3 py-2 text-left">{t("description", lang)}</th>
                                  <th className="px-3 py-2 text-right">{t("debit", lang)}</th>
                                  <th className="px-3 py-2 text-right">{t("credit", lang)}</th>
                                  <th className="px-3 py-2"></th>
                                </tr>
                              </thead>
                              <tbody className="divide-y bg-white">
                                {row.settledDrillDown!.map((d) => (
                                  <tr key={d.journalLineId}>
                                    <td className="px-3 py-2">{formatDate(d.date)}</td>
                                    <td className="px-3 py-2">{d.accountName}</td>
                                    <td className="px-3 py-2">{d.description}</td>
                                    <td className="px-3 py-2 text-right">{d.debit > 0 ? formatCurrency(d.debit) : "—"}</td>
                                    <td className="px-3 py-2 text-right">{d.credit > 0 ? formatCurrency(d.credit) : "—"}</td>
                                    <td className="px-3 py-2 text-right">
                                      <Link
                                        href={`/daily-posting/register?date=${documentDateKey(d.date)}&highlight=${d.journalEntryId}`}
                                        target="_blank"
                                        className="text-blue-600 hover:underline"
                                      >
                                        View in Register →
                                      </Link>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
