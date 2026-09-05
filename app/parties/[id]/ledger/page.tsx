"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { t, loadStoredLang, storeLang, type Lang } from "@/lib/i18n/party-ledger";
import { notoNastaliqUrdu } from "@/lib/fonts";
import DocumentsView from "./DocumentsView";
import PaymentsView from "./PaymentsView";
import SummaryView from "./SummaryView";
import ReconciliationView from "./ReconciliationView";
import StatementView from "./StatementView";

type PartyType = "TRANSPORTER" | "CLEARING_AGENT" | "CUSTOMER" | "VENDOR";

type LedgerEntry = {
  id: string;
  date: string;
  journalEntryId: string;
  referenceType: string | null;
  referenceId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  balanceType: "RECEIVABLE" | "PAYABLE" | "SETTLED";
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

// ============================================================
// LEDGER ROW -> SOURCE DESTINATION (unchanged from the existing,
// already-tested drill-down logic - see Test 1 regression)
// ============================================================

const REFERENCE_LABELS: Record<string, string> = {
  BILTY_BOOKING: "Bilty Booking",
  BILTY_BOOKING_CORRECTION: "Bilty Correction",
  CHALLAN_DISPATCH: "Challan Dispatch",
  CHALLAN_DISPATCH_CORRECTION: "Challan Correction",
  SETTLEMENT: "Settlement",
  SETTLEMENT_CORRECTION: "Settlement Correction",
  DAILY_POSTING: "Daily Posting",
  OPENING_BALANCE: "Opening Balance",
};

function friendlyReferenceLabel(referenceType: string | null) {
  if (!referenceType) return "Direct Entry";
  return REFERENCE_LABELS[referenceType] || referenceType;
}

function resolveLedgerDestination(entry: LedgerEntry): { href: string; label: string } {
  const refLabel = friendlyReferenceLabel(entry.referenceType);

  if (entry.sourceType === "CHALLAN" && entry.sourceId) {
    return { href: `/challan/${entry.sourceId}`, label: `${refLabel} - Challan ${entry.sourceNumber || entry.sourceId}` };
  }
  if (entry.sourceType === "BILTY" && entry.sourceId) {
    return { href: `/bilty/${entry.sourceId}`, label: `${refLabel} - Bilty ${entry.sourceNumber || entry.sourceId}` };
  }

  if (
    (entry.referenceType === "BILTY_BOOKING" || entry.referenceType === "BILTY_BOOKING_CORRECTION") &&
    entry.referenceId
  ) {
    return { href: `/bilty/${entry.referenceId}`, label: refLabel };
  }
  if (
    (entry.referenceType === "CHALLAN_DISPATCH" ||
      entry.referenceType === "CHALLAN_DISPATCH_CORRECTION" ||
      entry.referenceType === "SETTLEMENT" ||
      entry.referenceType === "SETTLEMENT_CORRECTION") &&
    entry.referenceId
  ) {
    return { href: `/challan/${entry.referenceId}`, label: refLabel };
  }

  return { href: `/accounting-transactions/${entry.journalEntryId}`, label: refLabel };
}

type ViewKey = "ledger" | "summary" | "documents" | "outstanding" | "payments" | "reconciliation" | "statement";

const VIEW_KEYS: ViewKey[] = ["ledger", "summary", "documents", "outstanding", "payments", "reconciliation", "statement"];

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
          <>
            {/* Filters */}
            <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
                <div className="md:col-span-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setFrom("");
                      setTo("");
                    }}
                    className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
                  >
                    {t("reset", lang)}
                  </button>
                </div>
              </div>
            </div>

            {/* Ledger Table */}
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              {ledger.length === 0 ? (
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
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {ledger.map((entry) => {
                        const destination = resolveLedgerDestination(entry);

                        return (
                          <tr key={entry.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3">{formatDate(entry.date)}</td>
                            <td className="px-4 py-3">
                              <Link
                                href={destination.href}
                                className="text-blue-600 hover:underline"
                                title="View source document"
                              >
                                {destination.label}
                              </Link>
                            </td>
                            <td className="px-4 py-3">{entry.description || "—"}</td>
                            <td className="px-4 py-3 text-right">
                              {entry.debit > 0 ? formatCurrency(entry.debit) : "—"}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {entry.credit > 0 ? formatCurrency(entry.credit) : "—"}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className={entry.balanceType === "RECEIVABLE" ? "text-green-600" : entry.balanceType === "PAYABLE" ? "text-red-600" : ""}>
                                {formatCurrency(entry.balance)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
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
