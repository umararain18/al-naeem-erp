"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { t, loadStoredLang, storeLang, type Lang } from "@/lib/i18n/party-ledger";
import { notoNastaliqUrdu } from "@/lib/fonts";
import DocumentsView from "./DocumentsView";
import PaymentsView from "./PaymentsView";
import SummaryView from "./SummaryView";
import ReconciliationView from "./ReconciliationView";
import StatementView from "./StatementView";

type PartyType = "TRANSPORTER" | "CLEARING_AGENT" | "CUSTOMER" | "VENDOR";

type LedgerHistoryItem = {
  date: string;
  referenceType: string | null;
  description: string;
  debit: number;
  credit: number;
};

type LedgerEntry = {
  id: string;
  date: string;
  reference: string;
  referenceHref: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  balanceType: "RECEIVABLE" | "PAYABLE" | "SETTLED";
  isGrouped: boolean;
  isRemoved: boolean;
  history: LedgerHistoryItem[];
};

type Party = {
  id: string;
  partyName: string;
  partyTypes: PartyType[];
};

type Account = {
  id: string;
  accountName: string;
};

type Summary = {
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  closingBalance: number;
  balanceType: "RECEIVABLE" | "PAYABLE" | "SETTLED";
};

type Filters = {
  from: string | null;
  to: string | null;
};

type LedgerResponse = {
  success: boolean;
  party: Party;
  account: Account;
  summary: Summary;
  ledger: LedgerEntry[];
  filters: Filters;
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

type ViewKey = "ledger" | "summary" | "documents" | "outstanding" | "payments" | "reconciliation" | "statement";

const VIEW_KEYS: ViewKey[] = ["ledger", "summary", "documents", "outstanding", "payments", "reconciliation", "statement"];

type TxType = "ALL" | "BILTY" | "CHALLAN" | "OTHER";

function txType(entry: LedgerEntry): Exclude<TxType, "ALL"> {
  if (entry.reference.startsWith("Bilty")) return "BILTY";
  if (entry.reference.startsWith("Challan")) return "CHALLAN";
  return "OTHER";
}

function LedgerTable({
  partyId,
  ledger,
  lang,
  from,
  to,
  setFrom,
  setTo,
}: {
  partyId: string;
  ledger: LedgerEntry[];
  lang: Lang;
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TxType>("ALL");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ledger.filter((entry) => {
      if (typeFilter !== "ALL" && txType(entry) !== typeFilter) return false;
      if (!q) return true;
      return entry.reference.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
    });
  }, [ledger, search, typeFilter]);

  const exportQuery = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();

  return (
    <>
      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reference or description..."
            className="border rounded-lg px-3 py-2 text-sm md:col-span-2"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TxType)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="ALL">All Types</option>
            <option value="BILTY">Bilty</option>
            <option value="CHALLAN">Challan</option>
            <option value="OTHER">Other</option>
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            placeholder="From"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            placeholder="To"
          />
        </div>
        <div className="flex justify-end mt-3 gap-2">
          <a
            href={`/api/parties/${partyId}/ledger/pdf?${exportQuery}`}
            target="_blank"
            rel="noreferrer"
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 bg-blue-600 text-white border-blue-600"
          >
            Export PDF
          </a>
          <a
            href={`/api/parties/${partyId}/ledger/excel?${exportQuery}`}
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
          >
            Export Excel
          </a>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setTypeFilter("ALL");
              setFrom("");
              setTo("");
            }}
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
          >
            {t("reset", lang)}
          </button>
        </div>
      </div>

      {/* Ledger Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-gray-500">{t("noData", lang)}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">{t("date", lang)}</th>
                  <th className="px-4 py-3">{t("source", lang)}</th>
                  <th className="px-4 py-3">{t("description", lang)}</th>
                  <th className="px-4 py-3 text-right">{t("debit", lang)}</th>
                  <th className="px-4 py-3 text-right">{t("credit", lang)}</th>
                  <th className="px-4 py-3 text-right">{t("balance", lang)}</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((entry) => {
                  const isExpanded = expanded.has(entry.id);
                  const hasHistory = entry.history.length > 1 || entry.isRemoved;

                  return (
                    <Fragment key={entry.id}>
                      <tr className="hover:bg-gray-50">
                        <td className="px-4 py-3">{formatDate(entry.date)}</td>
                        <td className="px-4 py-3">
                          {entry.referenceHref ? (
                            <Link href={entry.referenceHref} className="text-blue-600 hover:underline" title="View source document">
                              {entry.reference}
                            </Link>
                          ) : (
                            entry.reference
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {entry.description || "—"}
                          {entry.isRemoved && (
                            <span className="ml-2 text-xs text-gray-400 italic">(removed)</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">{entry.debit > 0 ? formatCurrency(entry.debit) : "—"}</td>
                        <td className="px-4 py-3 text-right">{entry.credit > 0 ? formatCurrency(entry.credit) : "—"}</td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={
                              entry.balanceType === "RECEIVABLE"
                                ? "text-green-600"
                                : entry.balanceType === "PAYABLE"
                                  ? "text-red-600"
                                  : ""
                            }
                          >
                            {formatCurrency(entry.balance)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {hasHistory && (
                            <button
                              type="button"
                              onClick={() => toggleExpanded(entry.id)}
                              className="text-xs border rounded-lg px-2 py-1 hover:bg-gray-50 text-gray-600"
                            >
                              {isExpanded ? "Hide history" : "View history"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasHistory && (
                        <tr className="bg-gray-50">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="text-xs text-gray-500 mb-2">
                              Revision history ({entry.history.length} {entry.history.length === 1 ? "entry" : "entries"}):
                            </div>
                            <table className="w-full text-xs border rounded-lg overflow-hidden">
                              <thead className="bg-white text-gray-500">
                                <tr>
                                  <th className="px-3 py-2 text-left">{t("date", lang)}</th>
                                  <th className="px-3 py-2 text-left">Type</th>
                                  <th className="px-3 py-2 text-left">{t("description", lang)}</th>
                                  <th className="px-3 py-2 text-right">{t("debit", lang)}</th>
                                  <th className="px-3 py-2 text-right">{t("credit", lang)}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y bg-white">
                                {entry.history.map((h, i) => (
                                  <tr key={i}>
                                    <td className="px-3 py-2">{formatDate(h.date)}</td>
                                    <td className="px-3 py-2 text-gray-500">{h.referenceType || "Direct Entry"}</td>
                                    <td className="px-3 py-2">{h.description}</td>
                                    <td className="px-3 py-2 text-right">{h.debit > 0 ? formatCurrency(h.debit) : "—"}</td>
                                    <td className="px-3 py-2 text-right">{h.credit > 0 ? formatCurrency(h.credit) : "—"}</td>
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
    </>
  );
}

export default function PartyLedgerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [partyId, setPartyId] = useState<string | null>(null);

  useEffect(() => {
    params.then((p) => setPartyId(p.id));
  }, [params]);

  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    setLang(loadStoredLang());
  }, []);

  function changeLang(next: Lang) {
    setLang(next);
    storeLang(next);
  }

  const [view, setView] = useState<ViewKey>(() => {
    if (typeof window === "undefined") return "ledger";
    const urlView = new URLSearchParams(window.location.search).get("view") as ViewKey | null;
    return urlView && VIEW_KEYS.includes(urlView) ? urlView : "ledger";
  });

  function changeView(next: ViewKey) {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState({}, "", url.toString());
  }

  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    if (!partyId) return;
    async function load() {
      try {
        setError("");
        const query = new URLSearchParams();
        if (from) query.set("from", from);
        if (to) query.set("to", to);

        const response = await fetch(`/api/parties/${partyId}/ledger?${query.toString()}`);
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load ledger");
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
  }, [partyId, from, to]);

  const balanceTypeColor = useMemo(() => {
    if (!data) return "text-gray-600";
    switch (data.summary.balanceType) {
      case "RECEIVABLE":
        return "text-green-600";
      case "PAYABLE":
        return "text-red-600";
      default:
        return "text-gray-600";
    }
  }, [data]);

  if (loading || !partyId) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-gray-500">Loading ledger...</p>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-red-600">{error || "Ledger not found"}</p>
          <Link href="/parties" className="mt-4 inline-block border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
            Back to Parties
          </Link>
        </div>
      </main>
    );
  }

  const { party, account, summary, ledger, filters } = data;
  const dir: "ltr" | "rtl" = lang === "ur" ? "rtl" : "ltr";

  const tabs: { key: ViewKey; label: string }[] = [
    { key: "ledger", label: t("ledger", lang) },
    { key: "summary", label: t("summary", lang) },
    { key: "documents", label: t("documents", lang) },
    { key: "outstanding", label: t("outstanding", lang) },
    { key: "payments", label: t("payments", lang) },
    { key: "reconciliation", label: t("reconciliation", lang) },
    { key: "statement", label: t("statement", lang) },
  ];

  return (
    <main
      className={`min-h-screen bg-gray-50 ${dir === "rtl" ? `${notoNastaliqUrdu.className} text-lg leading-loose` : ""}`}
      dir={dir}
    >
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6">
          <div className="text-xs text-gray-500 mb-1">Al Naeem Car Carriers Service</div>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">Party Ledger</h1>
              <p className="text-gray-600">{party.partyName}</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex border rounded-lg overflow-hidden text-sm">
                <button
                  type="button"
                  onClick={() => changeLang("en")}
                  className={`px-3 py-1.5 ${lang === "en" ? "bg-blue-600 text-white" : "bg-white hover:bg-gray-50"}`}
                >
                  English
                </button>
                <button
                  type="button"
                  onClick={() => changeLang("ur")}
                  className={`px-3 py-1.5 ${lang === "ur" ? "bg-blue-600 text-white" : "bg-white hover:bg-gray-50"}`}
                >
                  اردو
                </button>
              </div>
              <Link href="/parties" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
                Back to Parties
              </Link>
            </div>
          </div>
        </div>

        {/* Party & Account Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="bg-white rounded-xl shadow-sm p-5">
            <h2 className="text-lg font-semibold mb-3">Party Details</h2>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-gray-500">Name:</span>{" "}
                <span className="font-medium">{party.partyName}</span>
              </div>
              <div>
                <span className="text-gray-500">Types:</span>{" "}
                <span className="font-medium">{party.partyTypes.join(", ")}</span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-5">
            <h2 className="text-lg font-semibold mb-3">Account Details</h2>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-gray-500">Account:</span>{" "}
                <span className="font-medium">{account.accountName}</span>
              </div>
              <div>
                <span className="text-gray-500">Balance Type:</span>{" "}
                <span className={`font-medium ${balanceTypeColor}`}>{summary.balanceType}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">{t("openingBalance", lang)}</p>
            <p className="text-xl font-bold mt-1">{formatCurrency(summary.openingBalance)}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">{t("debit", lang)}</p>
            <p className="text-xl font-bold mt-1">{formatCurrency(summary.periodDebit)}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">{t("credit", lang)}</p>
            <p className="text-xl font-bold mt-1">{formatCurrency(summary.periodCredit)}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">{t("closingBalance", lang)}</p>
            <p className={`text-xl font-bold mt-1 ${balanceTypeColor}`}>
              {formatCurrency(summary.closingBalance)}
            </p>
          </div>
        </div>

        {/* View Tabs */}
        <div className="flex flex-wrap gap-1 mb-4 bg-white rounded-xl shadow-sm p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => changeView(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                view === tab.key ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {view === "ledger" && (
          <LedgerTable partyId={partyId} ledger={ledger} lang={lang} from={from} to={to} setFrom={setFrom} setTo={setTo} />
        )}

        {view === "summary" && <SummaryView partyId={partyId} lang={lang} />}
        {view === "documents" && <DocumentsView partyId={partyId} lang={lang} onlyOutstanding={false} />}
        {view === "outstanding" && <DocumentsView partyId={partyId} lang={lang} onlyOutstanding={true} />}
        {view === "payments" && <PaymentsView partyId={partyId} lang={lang} />}
        {view === "reconciliation" && <ReconciliationView partyId={partyId} lang={lang} />}
        {view === "statement" && <StatementView partyId={partyId} partyName={party.partyName} lang={lang} />}
      </div>
    </main>
  );
}
