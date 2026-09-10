"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import TransactionEditModal from "../../cash-book/TransactionEditModal";

// ============================================================
// DAILY POSTING — DEDICATED DATE VIEW (Step 12, refined)
//
// Read-side/navigation feature only. Shows every actual Daily
// Posting TRANSACTION (one JournalEntry with referenceType ===
// "DAILY_POSTING" = ONE register row, never one row per JournalLine)
// for one date, across every Cash/Bank account. Reuses:
//   - GET /api/daily-posting?date=  (existing, unmodified) for data
//   - GET /api/cash-book?accountId=&from=&to= (existing, unmodified)
//     for the authoritative per-row Edit/Bin eligibility (age +
//     settled-document policy) - never re-derived here
//   - TransactionEditModal + PATCH /api/cash-book/{lineId} (existing,
//     unmodified) for Edit
//   - DELETE /api/cash-book/{lineId} (existing, unmodified) for
//     Move to Bin
// No new accounting mechanism, no new guard, no schema change. The
// underlying JournalEntry always keeps BOTH its JournalLines exactly
// as posted - grouping is a display transformation only.
// ============================================================

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  party?: { id: string; partyName: string } | null;
};

type JournalLine = {
  id: string;
  account: Account;
  debit: number;
  credit: number;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
};

type JournalEntryRaw = {
  id: string;
  entryDate: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
  lines: JournalLine[];
};

type Eligibility = { canMoveToBin: boolean; binProtectedReason: string | null };

// ONE row = ONE Daily Posting JournalEntry (one logical transaction),
// built from its Main (Cash/Bank) leg + Counter (Party) leg - never
// one row per JournalLine. See buildRegisterRow() below for exactly
// how the two accounting lines are combined.
type RegisterRow = {
  journalEntryId: string;
  time: string; // HH:MM, Asia/Karachi
  sortKey: number; // entryDate ms, for oldest->newest ordering
  document: string; // business-readable, for DISPLAY ONLY: "BILTY", "CHALLAN", "Direct Account", ...
  documentRaw: string; // authoritative JournalLine.sourceType ("DIRECT", "BILTY", "CHALLAN", ...) - the SAME
  // convention /api/cash-book's own `document` field already uses (line.sourceType || "DIRECT") and the
  // ONLY value that may ever be sent to the edit modal / PATCH /api/cash-book/{id}, so an unmodified Save
  // round-trips exactly - never the human-readable label above, which PATCH would otherwise persist
  // literally as sourceType (e.g. corrupting "DIRECT" into "Direct Account").
  documentNo: string;
  sourceId: string | null; // authoritative JournalLine.sourceId - the real Bilty/Challan id behind
  // document/documentNo when documentRaw is BILTY/CHALLAN, used only to render the linked document as
  // a recognized, read-only selection in Edit (see DocumentSearchSelect readOnly usage). Never guessed.
  account: string; // Main Cash/Bank account name
  accountId: string; // Main Cash/Bank account id - balance is keyed on this
  party: string; // Counter account/party display name
  description: string;
  debit: number; // the MAIN account leg's own debit - never summed with the counter leg
  credit: number; // the MAIN account leg's own credit - never summed with the counter leg
  balance: number; // per (main) account running balance for THIS day only
  cashBankLineId: string | null; // the entry's own Cash/Bank leg id, for Edit/Delete
  cashBankAccountName: string;
  cashBankDebit: number;
  cashBankCredit: number;
  isComplex: boolean; // true when the entry isn't a clean 1 Cash/Bank + 1 counter pair
  canEdit: boolean;
  canMoveToBin: boolean;
  binProtectedReason: string | null;
  editBlockedReason: string | null;
};

function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

// Asia/Karachi YYYY-MM-DD - the SAME convention Cash Book already
// uses for its own `date` field, so a date string handed over from
// Cash Book always means the identical calendar day here too.
function todayYMD(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Pure UTC calendar-date arithmetic on the "YYYY-MM-DD" string
// itself - never constructs a Date from local/browser time, so it
// can never drift a day regardless of the viewer's own timezone.
function addDaysYMD(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + delta);
  return utc.toISOString().slice(0, 10);
}

function formatDisplayDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(utc);
}

function formatTime(entryDateIso: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Karachi" }).format(new Date(entryDateIso));
}

// Business-readable Document label - the existing, authoritative
// JournalLine.sourceType string, only reformatted for readability
// (never invented, never re-derived).
function formatDocument(sourceType: string | null): string {
  if (!sourceType || sourceType === "DIRECT") return "Direct Account";
  return sourceType;
}

function isCashOrBank(account: Account): boolean {
  return account.category === "CASH" || account.category === "BANK";
}

function partyLabel(account: Account): string {
  return account.party?.partyName || account.accountName;
}

// Combines ONE Daily Posting JournalEntry's lines into ONE register
// row - the core fix for the "two rows per transaction" problem.
// The common, expected shape is exactly 2 lines: one Cash/Bank leg
// (-> Account/Debit/Credit) and one counter leg (-> Party). Never
// summed, never duplicated. A structurally different entry (0 or 2+
// Cash/Bank legs, or more than 2 lines total - both rare/theoretical
// given how Daily Posting always pairs one Main Account with counter
// lines) still yields exactly ONE row, just with reduced/aggregated
// detail and Edit/Bin disabled - grouping is only ever attempted
// on this ONE JournalEntry's own lines, never across entries or by
// matching document numbers.
function buildRegisterRow(entry: JournalEntryRaw, eligibilityByLineId: Map<string, Eligibility>): RegisterRow {
  const cbLines = entry.lines.filter((l) => isCashOrBank(l.account));
  const counterLines = entry.lines.filter((l) => !isCashOrBank(l.account));
  const time = formatTime(entry.entryDate);
  const sortKey = new Date(entry.entryDate).getTime();
  const clean = entry.lines.length === 2 && cbLines.length === 1 && counterLines.length === 1;

  if (clean) {
    const main = cbLines[0];
    const counter = counterLines[0];
    const eligibility = eligibilityByLineId.get(main.id);
    return {
      journalEntryId: entry.id,
      time,
      sortKey,
      document: formatDocument(main.sourceType),
      documentRaw: main.sourceType || "DIRECT",
      documentNo: main.sourceNumber || "",
      sourceId: main.sourceId,
      account: main.account.accountName,
      accountId: main.account.id,
      party: partyLabel(counter.account),
      description: main.description || entry.description || "",
      debit: Number(main.debit),
      credit: Number(main.credit),
      balance: 0, // filled in after chronological sort, per account
      cashBankLineId: main.id,
      cashBankAccountName: main.account.accountName,
      cashBankDebit: Number(main.debit),
      cashBankCredit: Number(main.credit),
      isComplex: false,
      canEdit: false, // set by caller once capabilities are known
      canMoveToBin: false,
      binProtectedReason: eligibility?.binProtectedReason ?? null,
      editBlockedReason: null,
    };
  }

  // Complex/unusual shape - still exactly ONE row, degraded detail,
  // never guessed, never actionable.
  const mainLines = cbLines.length > 0 ? cbLines : entry.lines;
  const accountNames = [...new Set(mainLines.map((l) => l.account.accountName))];
  const partyNames = [...new Set((counterLines.length > 0 ? counterLines : entry.lines.filter((l) => !mainLines.includes(l))).map((l) => partyLabel(l.account)))];
  const debit = mainLines.reduce((s, l) => s + Number(l.debit), 0);
  const credit = mainLines.reduce((s, l) => s + Number(l.credit), 0);
  const reason = cbLines.length === 0 ? "No Cash/Bank leg on this entry." : cbLines.length > 1 ? "Multiple Cash/Bank legs on this entry." : "Multi-line entry.";

  return {
    journalEntryId: entry.id,
    time,
    sortKey,
    document: formatDocument(mainLines[0]?.sourceType ?? null),
    documentRaw: mainLines[0]?.sourceType || "DIRECT",
    documentNo: mainLines[0]?.sourceNumber || "",
    sourceId: mainLines[0]?.sourceId || null,
    account: accountNames.join(", ") || "—",
    accountId: mainLines[0]?.account.id || entry.id,
    party: partyNames.join(", ") || "—",
    description: entry.description || mainLines[0]?.description || "",
    debit,
    credit,
    balance: 0,
    cashBankLineId: null,
    cashBankAccountName: accountNames[0] || "",
    cashBankDebit: debit,
    cashBankCredit: credit,
    isComplex: true,
    canEdit: false,
    canMoveToBin: false,
    binProtectedReason: reason,
    editBlockedReason: reason,
  };
}

export default function DailyPostingRegisterPage() {
  const [date, setDate] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editEntry, setEditEntry] = useState<{
    id: string; date: string; document: string; documentNo: string; account: string;
    description: string; debit: number; credit: number; balance: number;
    journalEntryId: string; referenceType: string | null; referenceId: string | null;
    sourceId: string | null;
  } | null>(null);

  // Read the initial date/highlight directly from the URL, exactly
  // like app/cash-book/page.tsx already does for its own deep-link
  // params - avoids the Suspense-boundary requirement of
  // next/navigation's useSearchParams for a one-time read on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlDate = params.get("date");
    setDate(urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate) ? urlDate : todayYMD());
    setHighlightId(params.get("highlight"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(forDate: string) {
    if (!forDate) return;
    try {
      setLoading(true);
      setError("");

      const dpRes = await fetch(`/api/daily-posting?date=${forDate}`, { cache: "no-store" });
      const dpData = await dpRes.json();
      if (!dpRes.ok || !dpData.success) {
        throw new Error(dpData.message || "Unable to load Daily Posting entries");
      }
      const entries: JournalEntryRaw[] = dpData.entries || [];

      // General permission gate (mirrors Cash Book's own `capabilities`).
      const capRes = await fetch("/api/cash-book", { cache: "no-store" });
      const capData = await capRes.json();
      const capabilities = capData?.capabilities || { canEdit: false, canMoveToBin: false };

      // Fetch the AUTHORITATIVE, existing Bin-eligibility computation
      // (age + settled-document policy) for every distinct Cash/Bank
      // account touched this day - via the existing, unmodified
      // /api/cash-book endpoint, never re-derived here.
      const distinctAccountIds = new Set<string>();
      for (const entry of entries) {
        for (const l of entry.lines) {
          if (isCashOrBank(l.account)) distinctAccountIds.add(l.account.id);
        }
      }
      const eligibilityByLineId = new Map<string, Eligibility>();
      await Promise.all(
        [...distinctAccountIds].map(async (accountId) => {
          const r = await fetch(`/api/cash-book?accountId=${accountId}&from=${forDate}&to=${forDate}`, { cache: "no-store" });
          const d = await r.json();
          if (!r.ok || !d.success) return;
          for (const day of d.days || []) {
            for (const line of day.entries || []) {
              eligibilityByLineId.set(line.id, { canMoveToBin: !!line.canMoveToBin, binProtectedReason: line.binProtectedReason ?? null });
            }
          }
        })
      );

      // ONE row per JournalEntry - the core fix. Grouping is decided
      // ENTIRELY from that single entry's own lines (never across
      // entries, never by matching document numbers).
      const built = entries.map((entry) => buildRegisterRow(entry, eligibilityByLineId));
      for (const row of built) {
        if (row.isComplex || !row.cashBankLineId) continue;
        const eligibility = eligibilityByLineId.get(row.cashBankLineId);
        row.canEdit = capabilities.canEdit;
        row.canMoveToBin = capabilities.canMoveToBin && !!eligibility?.canMoveToBin;
      }

      // Oldest -> newest (display ordering only - never touches
      // accounting chronology). Deterministic tiebreak: journalEntryId.
      built.sort((a, b) => a.sortKey - b.sortKey || a.journalEntryId.localeCompare(b.journalEntryId));

      // Per-(main)-account running balance, advancing ONCE per Daily
      // Posting transaction (one row = one movement), in the same
      // chronological order just established. Starts at 0 for this
      // day's register only - never the true ledger opening balance
      // (approved product decision).
      const runningByAccount = new Map<string, number>();
      for (const row of built) {
        const prev = runningByAccount.get(row.accountId) || 0;
        const next = prev + row.debit - row.credit;
        runningByAccount.set(row.accountId, next);
        row.balance = next;
      }

      setRows(built);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Unable to load Daily Posting register");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (date) void load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  function goToDate(newDate: string, keepHighlight: boolean) {
    setDate(newDate);
    setHighlightId(keepHighlight ? highlightId : null);
    const url = new URL(window.location.href);
    url.searchParams.set("date", newDate);
    if (!keepHighlight) url.searchParams.delete("highlight");
    window.history.replaceState({}, "", url.toString());
  }

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }),
      { debit: 0, credit: 0 }
    );
  }, [rows]);

  // Closing Balance follows the SAME per-account convention as the
  // Balance column - a single blended figure across unrelated
  // Cash/Bank accounts would be meaningless (explicitly not wanted).
  // Each distinct account's own final running balance for the day is
  // shown; when the day only touched one account, this collapses to
  // exactly the single figure the simple case expects.
  const closingBalancesByAccount = useMemo(() => {
    const lastByAccount = new Map<string, { accountName: string; balance: number }>();
    for (const row of rows) {
      lastByAccount.set(row.accountId, { accountName: row.account, balance: row.balance });
    }
    return [...lastByAccount.values()];
  }, [rows]);

  async function handleMoveToBin(row: RegisterRow) {
    if (!row.cashBankLineId) return;
    const confirmed = window.confirm(
      "Move this complete Journal Entry to Bin?\n\nAll of its journal lines will be excluded from normal accounting. This is not permanent deletion."
    );
    if (!confirmed) return;
    try {
      setError("");
      const response = await fetch(`/api/cash-book/${row.cashBankLineId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to move transaction to Bin.");
      }
      await load(date);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move transaction to Bin.");
    }
  }

  function handleEdit(row: RegisterRow) {
    if (!row.cashBankLineId) return;
    // Edit always operates on the entry's OWN Cash/Bank leg - a
    // simple 2-line entry's two sides are symmetric, so the existing
    // PATCH endpoint correctly updates the whole transaction from
    // this one call, exactly as it already did before this refinement.
    setEditEntry({
      id: row.cashBankLineId,
      date,
      document: row.documentRaw,
      documentNo: row.documentNo,
      account: row.cashBankAccountName,
      description: row.description,
      debit: row.cashBankDebit,
      credit: row.cashBankCredit,
      balance: row.balance,
      journalEntryId: row.journalEntryId,
      referenceType: "DAILY_POSTING",
      referenceId: null,
      sourceId: row.sourceId,
    });
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        {/* HEADER */}
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Daily Posting</h1>
            <p className="mt-1 text-sm text-gray-500">All Daily Posting transactions for the selected date.</p>
          </div>
          <div className="flex gap-2">
            <Link
              href={`/daily-posting?date=${date || todayYMD()}`}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              + Add Entry
            </Link>
            <Link href="/cash-book" className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
              Back to Cash Book
            </Link>
          </div>
        </div>

        {/* ERROR */}
        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* DATE NAVIGATION */}
        <div className="mb-6 flex items-center justify-center gap-4 rounded-xl border bg-white p-4 shadow-sm">
          <button
            type="button"
            onClick={() => date && goToDate(addDaysYMD(date, -1), false)}
            disabled={!date}
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            ← Previous Date
          </button>
          <div className="min-w-[160px] text-center text-lg font-semibold text-gray-900">
            {date ? formatDisplayDate(date) : "—"}
          </div>
          <button
            type="button"
            onClick={() => date && goToDate(addDaysYMD(date, 1), false)}
            disabled={!date}
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            Next Date →
          </button>
        </div>

        {/* REGISTER */}
        <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="border-b px-6 py-4">
            <h2 className="font-semibold text-gray-900">Daily Register</h2>
            <p className="mt-1 text-xs text-gray-500">
              One row per Daily Posting transaction. Balance is this day&apos;s movement per Cash/Bank account, starting from 0 - not the account&apos;s true ledger balance.
            </p>
          </div>

          {loading ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">Loading Daily Posting register...</div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">No Daily Posting transactions for this date.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[1300px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">No</th>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Party</th>
                    <th className="px-4 py-3">Document</th>
                    <th className="px-4 py-3">Doc No.</th>
                    <th className="px-4 py-3">Account</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row, index) => {
                    const isHighlighted = !!highlightId && row.journalEntryId === highlightId;
                    return (
                      <tr key={row.journalEntryId} className={isHighlighted ? "bg-yellow-50" : "hover:bg-gray-50"}>
                        <td className="px-4 py-3 text-gray-500">{index + 1}</td>
                        <td className="px-4 py-3 text-gray-600">{row.time}</td>
                        <td className="px-4 py-3 font-medium text-gray-900">{row.party}</td>
                        <td className="px-4 py-3 text-gray-900">{row.document}</td>
                        <td className="px-4 py-3 text-gray-600">{row.documentNo || "—"}</td>
                        <td className="px-4 py-3 text-gray-600">{row.account}</td>
                        <td className="px-4 py-3 text-gray-600">{row.description || "—"}</td>
                        <td className="px-4 py-3 text-right">{row.debit > 0 ? `Rs. ${formatMoney(row.debit)}` : "—"}</td>
                        <td className="px-4 py-3 text-right">{row.credit > 0 ? `Rs. ${formatMoney(row.credit)}` : "—"}</td>
                        <td className="px-4 py-3 text-right font-semibold">Rs. {formatMoney(row.balance)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={`/daily-posting/${row.journalEntryId}`}
                              className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
                            >
                              View
                            </Link>
                            {row.canEdit ? (
                              <button
                                type="button"
                                onClick={() => handleEdit(row)}
                                className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                              >
                                Edit
                              </button>
                            ) : row.editBlockedReason ? (
                              <span className="px-1 py-1.5 text-xs text-gray-500" title={row.editBlockedReason}>
                                {row.editBlockedReason}
                              </span>
                            ) : null}
                            {row.canMoveToBin ? (
                              <button
                                type="button"
                                onClick={() => handleMoveToBin(row)}
                                className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                              >
                                Move to Bin
                              </button>
                            ) : row.binProtectedReason ? (
                              <span className="px-1 py-1.5 text-xs text-gray-500" title={row.binProtectedReason}>
                                {row.binProtectedReason}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 0 && (
            <div className="border-t bg-gray-50 px-6 py-5">
              <div className="flex justify-end">
                <div className="w-full max-w-sm space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium text-gray-600">Debit</span>
                    <span className="font-semibold text-gray-900">Rs. {formatMoney(totals.debit)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-medium text-gray-600">Credit</span>
                    <span className="font-semibold text-gray-900">Rs. {formatMoney(totals.credit)}</span>
                  </div>
                  <div className="border-t pt-2">
                    <div className="mb-1 flex justify-between">
                      <span className="font-semibold text-gray-700">
                        Closing Balance{closingBalancesByAccount.length > 1 ? " (per account)" : ""}
                      </span>
                    </div>
                    {closingBalancesByAccount.map((cb) => (
                      <div key={cb.accountName} className="flex justify-between">
                        <span className="text-gray-600">{closingBalancesByAccount.length > 1 ? cb.accountName : ""}</span>
                        <span className="font-bold text-gray-900">Rs. {formatMoney(cb.balance)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <TransactionEditModal
        entry={editEntry}
        onClose={() => setEditEntry(null)}
        onSaved={() => {
          setEditEntry(null);
          void load(date);
        }}
      />
    </div>
  );
}
