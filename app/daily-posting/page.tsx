"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { DocumentSearchSelect } from "./DocumentSearchSelect";
import { SearchableSelect, sourceOptions } from "./SearchableSelect";
import { toBusinessDateInputValue } from "@/lib/date-range";

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  party?: {
    id: string;
    partyName: string;
  } | null;
};

// Traced to app/api/daily-posting/route.ts's `duplicateWarnings` array
// (the 409 response's `duplicates` field) - narrowed to only the
// fields this page actually displays.
type DuplicateWarning = {
  sourceType: string;
  sourceId: string;
  sourceNumber: string | null;
  amount: string;
};

// A CHALLAN's party with an outstanding Receivable (RECEIPT) or
// Payable (PAYMENT) position for the line's current direction - see
// app/api/daily-posting/search-documents/route.ts. Populated only
// when there is more than one, so the user can explicitly choose
// instead of the system guessing.
type EligibleParty = { accountId: string; partyName: string; amount: number };

type PostingLine = {
  id: string;
  counterAccountId: string;
  description: string;
  amount: string;
  direction: "DEBIT" | "CREDIT";
  sourceType: string;
  sourceId: string;
  sourceNumber: string;
  // Client-side only - not sent to the server. Tracks the party
  // auto-resolved from the selected document ("" = none), purely
  // so the UI can show "Resolved Party: X" / explain why Counter
  // Account is empty. The server independently re-resolves at
  // submit time regardless of this value.
  resolvedPartyLabel: string;
  // Client-side only - not sent to the server. The CHALLAN's
  // Receivable/Payable parties for the line's current direction,
  // whatever the count - used only to offer an explicit selector
  // when there is more than one (see setLineEligibleParties()).
  eligibleParties: EligibleParty[];
};

// The 5 true document types - a line tagged with one of these can
// auto-resolve its Counter Account from the document and always
// requires a real Document No. for that lookup. Every other
// sourceType (PARTY/ACCOUNT) never looks up a document at all, so a
// Document No. there only ever serves as an optional reference. See
// the matching DOCUMENT_LINKED_SOURCE_TYPES set in
// app/api/daily-posting/route.ts - kept in sync by hand since one is
// client TS and the other server TS.
const DOCUMENT_LINKED_SOURCE_TYPES = new Set([
  "CHALLAN",
  "BILTY",
  "PHONCH",
  "PRIVATE_PHONCH",
  "BILL",
]);

// Document No. is optional whenever the selected Counter Account is
// Booking Income, Delivery Income (covers Showroom Delivery Income/
// Private Phonch Delivery Income/Bill Income - all stored under this
// same category, see lib/gross-accounts.ts) or any Party account -
// confirmed by the account's own stable category/accountType field,
// never by its name. Never applied to a true document-linked
// sourceType above, whose Document No. requirement is completely
// unchanged.
function isDocumentNumberExemptAccount(
  accounts: Account[],
  counterAccountId: string
): boolean {
  if (!counterAccountId) return false;
  const account = accounts.find((a) => a.id === counterAccountId);
  if (!account) return false;
  return (
    account.category === "BOOKING_INCOME" ||
    account.category === "DELIVERY_INCOME" ||
    account.accountType === "PARTY"
  );
}

function createLine(): PostingLine {
  return {
    id: crypto.randomUUID(),
    counterAccountId: "",
    description: "",
    amount: "",
    direction: "DEBIT",
    sourceType: "DIRECT",
    sourceId: "",
    sourceNumber: "",
    resolvedPartyLabel: "",
    eligibleParties: [],
  };
}

// Per-line validation, shared by the New Transactions submit flow AND
// the Existing Transactions inline Save flow - the exact same checks
// either way, never a second/looser rule for editing. Returns a
// human-readable error, or null when the line is valid.
function validatePostingLine(line: PostingLine, accounts: Account[]): string | null {
  if (
    line.sourceType !== "CHALLAN" &&
    line.sourceType !== "BILTY" &&
    line.sourceType !== "PHONCH" &&
    line.sourceType !== "PRIVATE_PHONCH" &&
    line.sourceType !== "BILL" &&
    !line.counterAccountId
  ) {
    return "Please select counter account.";
  }

  if (!line.description.trim()) {
    return "Please enter description.";
  }

  if (!line.amount || Number(line.amount) <= 0) {
    return "Please enter a valid amount.";
  }

  if (
    line.sourceType !== "DIRECT" &&
    !line.sourceNumber.trim() &&
    !(
      !DOCUMENT_LINKED_SOURCE_TYPES.has(line.sourceType) &&
      isDocumentNumberExemptAccount(accounts, line.counterAccountId)
    )
  ) {
    return "Please enter document number.";
  }

  return null;
}

// ============================================================
// EXISTING TRANSACTIONS (ported from the former app/daily-posting/
// register/page.tsx - see that route's thin redirect). Shows every
// actual Daily Posting TRANSACTION (one JournalEntry with
// referenceType === "DAILY_POSTING" = ONE row, never one row per
// JournalLine) for the selected date, across every Cash/Bank account.
// Reuses, unmodified:
//   - GET /api/daily-posting?date=  for data
//   - GET /api/cash-book?accountId=&from=&to= for the authoritative
//     per-row Edit/Bin eligibility (age + settled-document policy)
//   - PATCH /api/cash-book/{lineId} for Edit (now inline instead of a
//     modal - same endpoint, same payload shape)
//   - DELETE /api/cash-book/{lineId} for Delete (Bin)
// No new accounting mechanism, no new guard, no schema change.
// ============================================================

type ExistingAccount = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  party?: { id: string; partyName: string } | null;
};

type ExistingJournalLine = {
  id: string;
  account: ExistingAccount;
  debit: number;
  credit: number;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
};

type ExistingJournalEntry = {
  id: string;
  entryDate: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
  lines: ExistingJournalLine[];
};

type Eligibility = { canMoveToBin: boolean; binProtectedReason: string | null };

// Business-readable Document label - reuses the SAME canonical
// sourceType terminology the create-entry form's own Document Type
// dropdown already shows (SearchableSelect.tsx's sourceOptions, e.g.
// "CN - Challan"), just without its short code prefix.
const DOCUMENT_LABELS: Record<string, string> = {
  BILTY: "Bilty",
  CHALLAN: "Challan",
  PHONCH: "Showroom Phonch",
  PRIVATE_PHONCH: "Private Phonch",
  BILL: "Bill",
};

function formatDocument(sourceType: string | null): string {
  if (!sourceType || sourceType === "DIRECT") return "Direct Account";
  return DOCUMENT_LABELS[sourceType] || sourceType;
}

function isCashOrBank(account: ExistingAccount): boolean {
  return account.category === "CASH" || account.category === "BANK";
}

function partyLabel(account: ExistingAccount): string {
  return account.party?.partyName || account.accountName;
}

// ONE row = ONE Daily Posting JournalEntry (one logical transaction),
// built from its Main (Cash/Bank) leg + Counter (Party) leg - never
// one row per JournalLine.
type ExistingRow = {
  journalEntryId: string;
  sortKey: number; // entryDate ms, for oldest->newest ordering
  document: string; // business-readable, for DISPLAY ONLY
  documentRaw: string; // authoritative JournalLine.sourceType - the ONLY value ever sent to PATCH
  documentNo: string;
  sourceId: string | null; // authoritative JournalLine.sourceId
  mainAccountId: string; // Main Cash/Bank account id - fixed, never reassigned (see Area 8)
  mainAccountName: string;
  counterAccountId: string | null; // Counter account id - display only (see Area 8)
  counterLabel: string; // Counter account/party display name
  description: string;
  mainDebit: number; // the MAIN account leg's own debit
  mainCredit: number; // the MAIN account leg's own credit
  balance: number; // per (main) account running balance for THIS day only
  cashBankLineId: string | null; // the entry's own Cash/Bank leg id - the PATCH/DELETE target
  isComplex: boolean; // true when the entry isn't a clean 1 Cash/Bank + 1 counter pair
  canEdit: boolean;
  canMoveToBin: boolean;
  binProtectedReason: string | null;
  editBlockedReason: string | null;
};

// Combines ONE Daily Posting JournalEntry's lines into ONE row. The
// common, expected shape is exactly 2 lines: one Cash/Bank leg and one
// counter leg. A structurally different entry still yields exactly
// ONE row, with reduced detail and Edit/Bin disabled.
function buildExistingRow(entry: ExistingJournalEntry): ExistingRow {
  const cbLines = entry.lines.filter((l) => isCashOrBank(l.account));
  const counterLines = entry.lines.filter((l) => !isCashOrBank(l.account));
  const sortKey = new Date(entry.entryDate).getTime();
  const clean = entry.lines.length === 2 && cbLines.length === 1 && counterLines.length === 1;

  if (clean) {
    const main = cbLines[0];
    const counter = counterLines[0];
    return {
      journalEntryId: entry.id,
      sortKey,
      document: formatDocument(main.sourceType),
      documentRaw: main.sourceType || "DIRECT",
      documentNo: main.sourceNumber || "",
      sourceId: main.sourceId,
      mainAccountId: main.account.id,
      mainAccountName: main.account.accountName,
      counterAccountId: counter.account.id,
      counterLabel: partyLabel(counter.account),
      description: main.description || entry.description || "",
      mainDebit: Number(main.debit),
      mainCredit: Number(main.credit),
      balance: 0,
      cashBankLineId: main.id,
      isComplex: false,
      canEdit: false, // set by caller once capabilities are known
      canMoveToBin: false,
      binProtectedReason: null,
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
    sortKey,
    document: formatDocument(mainLines[0]?.sourceType ?? null),
    documentRaw: mainLines[0]?.sourceType || "DIRECT",
    documentNo: mainLines[0]?.sourceNumber || "",
    sourceId: mainLines[0]?.sourceId || null,
    mainAccountId: mainLines[0]?.account.id || entry.id,
    mainAccountName: accountNames.join(", ") || "—",
    counterAccountId: null,
    counterLabel: partyNames.join(", ") || "—",
    description: entry.description || mainLines[0]?.description || "",
    mainDebit: debit,
    mainCredit: credit,
    balance: 0,
    cashBankLineId: null,
    isComplex: true,
    canEdit: false,
    canMoveToBin: false,
    binProtectedReason: reason,
    editBlockedReason: reason,
  };
}

// A row currently in inline-edit mode carries its own draft, shaped
// EXACTLY like a New Transaction's PostingLine (plus its own Date,
// which New Transactions share as one page-level field but an
// existing posted row edits independently, exactly like the former
// edit modal already allowed) - so the SAME field components/update
// functions render both, via <LineFieldsCells> below.
type ExistingDraft = {
  date: string;
  line: PostingLine;
  saving: boolean;
  error: string;
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ============================================================
// SHARED ROW FIELDS - Counter Account / Document Type / Document No. /
// Description / Direction / Amount - the EXACT SAME cells, rendered
// identically for a brand-new line (New Transactions) and an existing
// posted line being edited (Existing Transactions). `locked` is the
// ONLY behavioral difference: an existing row's Counter Account
// cannot be freely reassigned except through changing its linked
// document (see Area 8) - a brand-new line has no such restriction.
// ============================================================
function LineFieldsCells({
  line,
  accounts,
  mainAccountId,
  locked = false,
  onUpdate,
  onEligibleParties,
}: {
  line: PostingLine;
  accounts: Account[];
  mainAccountId: string;
  locked?: boolean;
  onUpdate: (field: keyof PostingLine, value: string) => void;
  onEligibleParties: (parties: EligibleParty[]) => void;
}) {
  const counterAccountOptions = useMemo(
    () =>
      accounts
        .filter((a) => a.id !== mainAccountId)
        .map((account) => ({
          value: account.id,
          label: account.party
            ? `${account.party.partyName} — ${account.accountName}`
            : account.accountName,
          secondary: account.accountCode
            ? `${account.accountCode} • ${account.accountType}`
            : account.accountType,
        })),
    [accounts, mainAccountId]
  );

  const isDocumentType =
    line.sourceType === "CHALLAN" ||
    line.sourceType === "BILTY" ||
    line.sourceType === "PHONCH" ||
    line.sourceType === "PRIVATE_PHONCH" ||
    line.sourceType === "BILL";

  // A Challan or Private Phonch with MORE than one eligible
  // Receivable/Payable (Challan) or payable/deposit (Private Phonch)
  // party must never be auto-selected - per the LOCKED rule in
  // lib/document-party-resolution.ts.
  const isAmbiguousChallan =
    (line.sourceType === "CHALLAN" || line.sourceType === "PRIVATE_PHONCH") &&
    line.eligibleParties.length > 1 &&
    !line.counterAccountId;

  const eligibleLabel =
    line.sourceType === "PRIVATE_PHONCH"
      ? line.direction === "DEBIT"
        ? "Deposit"
        : "Payable"
      : line.direction === "DEBIT"
      ? "Receivable"
      : "Payable";

  const options = isAmbiguousChallan
    ? line.eligibleParties.map((party) => ({
        value: party.accountId,
        label: party.partyName,
        secondary: `${eligibleLabel} Rs. ${party.amount.toLocaleString()}`,
      }))
    : counterAccountOptions;

  const placeholder = isAmbiguousChallan
    ? `Select ${eligibleLabel} Party`
    : isDocumentType
    ? "Optional - auto-resolved from document"
    : "Search account...";

  return (
    <>
      <td className="px-4 py-4">
        {locked && !isDocumentType ? (
          <div>
            <p className="rounded-lg border bg-gray-50 px-3 py-2 text-sm text-gray-700">
              {line.resolvedPartyLabel || "—"}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Counter Account reassignment is not supported when editing a posted transaction.
            </p>
          </div>
        ) : (
          <>
            <SearchableSelect
              value={line.counterAccountId}
              options={options}
              placeholder={placeholder}
              onChange={(value) => {
                onUpdate("counterAccountId", value);
                const eligibleMatch = line.eligibleParties.find(
                  (party) => party.accountId === value
                );
                onUpdate("resolvedPartyLabel", eligibleMatch ? eligibleMatch.partyName : "");
              }}
              className="w-72"
            />
            {isDocumentType && line.sourceId && line.resolvedPartyLabel && (
              <p className="mt-1 text-xs text-green-600">
                Resolved Party: {line.resolvedPartyLabel}
              </p>
            )}
            {isAmbiguousChallan && (
              <p className="mt-1 text-xs text-blue-600">
                Multiple eligible {eligibleLabel} parties found - select the correct one above.
              </p>
            )}
            {isDocumentType &&
              line.sourceId &&
              !line.resolvedPartyLabel &&
              !line.counterAccountId &&
              !isAmbiguousChallan && (
                <p className="mt-1 text-xs text-amber-600">
                  No party could be auto-resolved - please select a Counter Account.
                </p>
              )}
          </>
        )}
      </td>

      <td className="px-4 py-4">
        <SearchableSelect
          value={line.sourceType}
          options={sourceOptions}
          placeholder="Search document..."
          onChange={(value) => {
            onUpdate("sourceType", value);
            onUpdate("sourceId", "");
            onUpdate("sourceNumber", "");
            onEligibleParties([]);
          }}
          className="w-48"
        />
      </td>

      <td className="px-4 py-4">
        {isDocumentType ? (
          <DocumentSearchSelect
            sourceType={line.sourceType}
            sourceId={line.sourceId}
            sourceNumber={line.sourceNumber}
            direction={line.direction}
            onSelect={(result) => {
              onUpdate("sourceType", result.type);
              onUpdate("sourceId", result.id);
              onUpdate("sourceNumber", result.number);
              onUpdate("counterAccountId", result.resolvedParty?.accountId || "");
              onUpdate("resolvedPartyLabel", result.resolvedParty?.partyName || "");
              onEligibleParties(result.eligibleParties || []);
            }}
            onClear={() => {
              onUpdate("sourceId", "");
              onUpdate("sourceNumber", "");
              onUpdate("resolvedPartyLabel", "");
              onEligibleParties([]);
            }}
          />
        ) : (
          <input
            type="text"
            value={line.sourceNumber}
            onChange={(e) => onUpdate("sourceNumber", e.target.value)}
            placeholder={line.sourceType === "DIRECT" ? "Not required" : "e.g. 4252"}
            disabled={line.sourceType === "DIRECT"}
            className="w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none disabled:bg-gray-100 focus:border-blue-500"
          />
        )}
      </td>

      <td className="px-4 py-4">
        <input
          type="text"
          value={line.description}
          onChange={(e) => onUpdate("description", e.target.value)}
          placeholder="Fuel, rent, receipt..."
          className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
      </td>

      <td className="px-4 py-4">
        <select
          value={line.direction}
          onChange={(e) => onUpdate("direction", e.target.value)}
          className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        >
          <option value="DEBIT">Debit</option>
          <option value="CREDIT">Credit</option>
        </select>
      </td>

      <td className="px-4 py-4">
        <input
          type="number"
          min="0"
          step="0.01"
          value={line.amount}
          onChange={(e) => onUpdate("amount", e.target.value)}
          placeholder="0.00"
          className="w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
      </td>
    </>
  );
}

export default function DailyPostingPage() {
  const today = toBusinessDateInputValue(new Date());

  const [postingDate, setPostingDate] = useState(today);
  const [accountId, setAccountId] = useState("");
  const [remarks, setRemarks] = useState("");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lines, setLines] = useState<PostingLine[]>([createLine()]);

  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [posting, setPosting] = useState(false);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [duplicateData, setDuplicateData] = useState<DuplicateWarning[]>([]);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);

  // One token per distinct posting attempt - reused across a retry
  // of the SAME attempt (e.g. confirming the duplicate-document
  // warning), regenerated only once that attempt actually succeeds,
  // so an accidental resubmission (double-click, network retry,
  // duplicate tab) of an already-posted entry safely no-ops on the
  // server instead of posting twice. See app/api/daily-posting/route.ts.
  const [submissionKey, setSubmissionKey] = useState(() =>
    crypto.randomUUID()
  );

  // ---- Existing Transactions (for the selected date) ----
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [existingRows, setExistingRows] = useState<ExistingRow[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [existingError, setExistingError] = useState("");
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Map<string, ExistingDraft>>(new Map());

  async function loadAccounts() {
    try {
      setLoadingAccounts(true);
      setError("");

      const response = await fetch("/api/accounts");

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to load accounts");
      }

      setAccounts(data.accounts || []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load accounts"
      );
    } finally {
      setLoadingAccounts(false);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  // Arriving from elsewhere in the ERP (Cash Book, Party Ledger
  // Outstanding, or this page's own "View Daily Register" link of old)
  // with ?date=YYYY-MM-DD&highlight=<journalEntryId> starts the form
  // on that date and highlights the selected transaction below - a
  // pure convenience default, never required. Read directly from the
  // URL (not next/navigation's useSearchParams), matching the same
  // one-time-on-mount pattern already used elsewhere, to avoid that
  // hook's Suspense-boundary requirement.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlDate = params.get("date");
    if (urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) {
      setPostingDate(urlDate);
    }
    setHighlightId(params.get("highlight"));
  }, []);

  async function loadExisting(forDate: string) {
    if (!forDate) return;
    try {
      setLoadingExisting(true);
      setExistingError("");

      const dpRes = await fetch(`/api/daily-posting?date=${forDate}`, { cache: "no-store" });
      const dpData = await dpRes.json();
      if (!dpRes.ok || !dpData.success) {
        throw new Error(dpData.message || "Unable to load Daily Posting entries");
      }
      const entries: ExistingJournalEntry[] = dpData.entries || [];

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
        [...distinctAccountIds].map(async (accId) => {
          const r = await fetch(`/api/cash-book?accountId=${accId}&from=${forDate}&to=${forDate}`, { cache: "no-store" });
          const d = await r.json();
          if (!r.ok || !d.success) return;
          for (const day of d.days || []) {
            for (const line of day.entries || []) {
              eligibilityByLineId.set(line.id, { canMoveToBin: !!line.canMoveToBin, binProtectedReason: line.binProtectedReason ?? null });
            }
          }
        })
      );

      const built = entries.map(buildExistingRow);
      for (const row of built) {
        if (row.isComplex || !row.cashBankLineId) continue;
        const eligibility = eligibilityByLineId.get(row.cashBankLineId);
        row.canEdit = capabilities.canEdit;
        row.canMoveToBin = capabilities.canMoveToBin && !!eligibility?.canMoveToBin;
        row.binProtectedReason = eligibility?.binProtectedReason ?? null;
      }

      // Oldest -> newest for the running-balance computation.
      built.sort((a, b) => a.sortKey - b.sortKey || a.journalEntryId.localeCompare(b.journalEntryId));
      const runningByAccount = new Map<string, number>();
      for (const row of built) {
        const prev = runningByAccount.get(row.mainAccountId) || 0;
        const next = prev + row.mainDebit - row.mainCredit;
        runningByAccount.set(row.mainAccountId, next);
        row.balance = next;
      }

      setExistingRows(built);
      // Any row no longer present (e.g. after a Save moved it off this
      // date) can't still be mid-edit - drop stale edit state for it.
      const stillPresent = new Set(built.map((r) => r.journalEntryId));
      setEditingIds((prev) => new Set([...prev].filter((id) => stillPresent.has(id))));
      setDrafts((prev) => new Map([...prev].filter(([id]) => stillPresent.has(id))));
    } catch (err) {
      console.error(err);
      setExistingError(err instanceof Error ? err.message : "Unable to load Daily Posting register");
      setExistingRows([]);
    } finally {
      setLoadingExisting(false);
    }
  }

  useEffect(() => {
    if (postingDate) void loadExisting(postingDate);
  }, [postingDate]);

  function updateLine(
    id: string,
    field: keyof PostingLine,
    value: string
  ) {
    setLines((current) =>
      current.map((line) =>
        line.id === id
          ? {
              ...line,
              [field]: value,
            }
          : line
      )
    );
  }

  // Separate from updateLine() above purely because eligibleParties
  // is an array, not the string type that setter is declared for -
  // same setLines()/map() shape, narrowly typed for this one field.
  function setLineEligibleParties(id: string, eligibleParties: EligibleParty[]) {
    setLines((current) =>
      current.map((line) =>
        line.id === id ? { ...line, eligibleParties } : line
      )
    );
  }

  function addLine() {
    setLines((current) => [...current, createLine()]);
  }

  function removeLine(id: string) {
    if (lines.length === 1) {
      return;
    }

    setLines((current) =>
      current.filter((line) => line.id !== id)
    );
  }

  const selectedMainAccount = useMemo(
    () =>
      accounts.find(
        (account) => account.id === accountId
      ),
    [accounts, accountId]
  );

  const mainAccountOptions = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: account.accountName,
        secondary: account.accountCode
          ? `${account.accountCode} • ${account.accountType}`
          : account.accountType,
      })),
    [accounts]
  );

  const totalDebit = useMemo(
    () =>
      lines.reduce((total, line) => {
        if (line.direction !== "DEBIT") return total;

        return total + (Number(line.amount) || 0);
      }, 0),
    [lines]
  );

  const totalCredit = useMemo(
    () =>
      lines.reduce((total, line) => {
        if (line.direction !== "CREDIT") return total;

        return total + (Number(line.amount) || 0);
      }, 0),
    [lines]
  );

  async function postDailyPosting(
    confirmDuplicate = false
  ) {
    setError("");
    setMessage("");

    if (!postingDate) {
      setError("Posting date is required.");
      return;
    }

    if (!accountId) {
      setError("Please select the main account.");
      return;
    }

    for (const [index, line] of lines.entries()) {
      const lineError = validatePostingLine(line, accounts);
      if (lineError) {
        setError(`${lineError} (entry ${index + 1})`);
        return;
      }
    }

    try {
      setPosting(true);

      const payload = {
        postingDate,
        accountId,
        remarks: remarks.trim() || undefined,
        confirmDuplicate,
        idempotencyKey: submissionKey,
        lines: lines.map((line) => ({
          counterAccountId: line.counterAccountId || undefined,
          description: line.description.trim(),
          amount: Number(line.amount),
          direction: line.direction,
          sourceType: line.sourceType,
          sourceId:
            line.sourceId.trim() || undefined,
          sourceNumber:
            line.sourceNumber.trim() || undefined,
        })),
      };

      const response = await fetch(
        "/api/daily-posting",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await response.json();

      if (response.status === 409 && data.warning) {
        setDuplicateData(data.duplicates || []);
        setShowDuplicateWarning(true);
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.message ||
            "Unable to post daily transaction."
        );
      }

      setMessage(
        data.message ||
          "Daily posting posted successfully."
      );

      setShowDuplicateWarning(false);
      setDuplicateData([]);

      setLines([createLine()]);
      setRemarks("");
      // This attempt is done - the next Post is a new, separate
      // posting and must get its own idempotency key.
      setSubmissionKey(crypto.randomUUID());

      // The new transaction belongs to `postingDate` - if that's the
      // date currently shown below, refresh it immediately so the
      // Existing Transactions list reflects the new posting right
      // away, with no manual reload.
      void loadExisting(postingDate);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while posting."
      );
    } finally {
      setPosting(false);
    }
  }

  // ---- Existing Transactions: inline edit/delete ----

  function startEdit(row: ExistingRow) {
    if (!row.cashBankLineId || !row.canEdit) return;
    setEditingIds((prev) => new Set(prev).add(row.journalEntryId));
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(row.journalEntryId, {
        date: postingDate,
        line: {
          id: row.journalEntryId,
          counterAccountId: row.counterAccountId || "",
          description: row.description,
          amount: String(row.mainDebit > 0 ? row.mainDebit : row.mainCredit),
          direction: row.mainDebit > 0 ? "DEBIT" : "CREDIT",
          sourceType: row.documentRaw,
          sourceId: row.sourceId || "",
          sourceNumber: row.documentNo,
          resolvedPartyLabel: row.counterLabel,
          eligibleParties: [],
        },
        saving: false,
        error: "",
      });
      return next;
    });
  }

  function cancelEdit(journalEntryId: string) {
    setEditingIds((prev) => {
      const next = new Set(prev);
      next.delete(journalEntryId);
      return next;
    });
    setDrafts((prev) => {
      const next = new Map(prev);
      next.delete(journalEntryId);
      return next;
    });
  }

  function updateDraftLine(journalEntryId: string, field: keyof PostingLine, value: string) {
    setDrafts((prev) => {
      const current = prev.get(journalEntryId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(journalEntryId, { ...current, line: { ...current.line, [field]: value } });
      return next;
    });
  }

  function updateDraftDate(journalEntryId: string, value: string) {
    setDrafts((prev) => {
      const current = prev.get(journalEntryId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(journalEntryId, { ...current, date: value });
      return next;
    });
  }

  function setDraftEligibleParties(journalEntryId: string, parties: EligibleParty[]) {
    setDrafts((prev) => {
      const current = prev.get(journalEntryId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(journalEntryId, { ...current, line: { ...current.line, eligibleParties: parties } });
      return next;
    });
  }

  async function saveEdit(row: ExistingRow) {
    const draft = drafts.get(row.journalEntryId);
    if (!draft || !row.cashBankLineId) return;

    const lineError = validatePostingLine(draft.line, accounts);
    if (lineError) {
      setDrafts((prev) => {
        const next = new Map(prev);
        next.set(row.journalEntryId, { ...draft, error: lineError });
        return next;
      });
      return;
    }

    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(row.journalEntryId, { ...draft, saving: true, error: "" });
      return next;
    });

    try {
      const amount = Number(draft.line.amount);
      const response = await fetch(`/api/cash-book/${row.cashBankLineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: draft.date,
          document: draft.line.sourceType,
          documentNo: draft.line.sourceNumber,
          sourceId: draft.line.sourceId,
          description: draft.line.description,
          debit: draft.line.direction === "DEBIT" ? amount : 0,
          credit: draft.line.direction === "CREDIT" ? amount : 0,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to update transaction");
      }

      cancelEdit(row.journalEntryId);
      await loadExisting(postingDate);
    } catch (err) {
      setDrafts((prev) => {
        const next = new Map(prev);
        const current = next.get(row.journalEntryId);
        if (current) {
          next.set(row.journalEntryId, {
            ...current,
            saving: false,
            error: err instanceof Error ? err.message : "Unable to update transaction",
          });
        }
        return next;
      });
    }
  }

  async function handleDeleteExisting(row: ExistingRow) {
    if (!row.cashBankLineId) return;
    const confirmed = window.confirm(
      "Move this complete Journal Entry to Bin?\n\nAll of its journal lines will be excluded from normal accounting. This is not permanent deletion."
    );
    if (!confirmed) return;
    try {
      setExistingError("");
      const response = await fetch(`/api/cash-book/${row.cashBankLineId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to move transaction to Bin.");
      }
      await loadExisting(postingDate);
    } catch (err) {
      setExistingError(err instanceof Error ? err.message : "Unable to move transaction to Bin.");
    }
  }

  const existingTotals = useMemo(
    () => existingRows.reduce((acc, r) => ({ debit: acc.debit + r.mainDebit, credit: acc.credit + r.mainCredit }), { debit: 0, credit: 0 }),
    [existingRows]
  );

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        {/* HEADER */}
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Daily Posting
            </h1>

            <p className="mt-1 text-sm text-gray-500">
              Post daily income, expenses, receipts and
              payments from one screen.
            </p>
          </div>
        </div>

        {/* SUCCESS */}
        {message && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {message}
          </div>
        )}

        {/* ERROR */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* MAIN ACCOUNT */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Posting Date
              </label>

              <input
                type="date"
                value={postingDate}
                onChange={(e) =>
                  setPostingDate(e.target.value)
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Main Account
              </label>

              <SearchableSelect
                value={accountId}
                options={mainAccountOptions}
                placeholder={
                  loadingAccounts
                    ? "Loading accounts..."
                    : "Search main account..."
                }
                disabled={loadingAccounts}
                onChange={setAccountId}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Remarks
              </label>

              <input
                type="text"
                value={remarks}
                onChange={(e) =>
                  setRemarks(e.target.value)
                }
                placeholder="Optional daily remarks"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {selectedMainAccount && (
            <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <strong>
                Main Account:
              </strong>{" "}
              {selectedMainAccount.accountName}
            </div>
          )}
        </div>

        {/* NEW TRANSACTIONS */}
        <div className="mt-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <h2 className="font-semibold text-gray-900">
                New Transactions
              </h2>

              <p className="text-xs text-gray-500">
                Multiple transactions can be posted under
                the same main account.
              </p>
            </div>

            <button
              type="button"
              onClick={addLine}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              + Add Entry
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1250px] w-full">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold uppercase text-gray-500">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Counter Account</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Document No.</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>

              <tbody className="divide-y">
                {lines.map((line, index) => (
                  <tr key={line.id}>
                    <td className="px-4 py-4 text-sm text-gray-500">
                      {index + 1}
                    </td>

                    <LineFieldsCells
                      line={line}
                      accounts={accounts}
                      mainAccountId={accountId}
                      onUpdate={(field, value) => updateLine(line.id, field, value)}
                      onEligibleParties={(parties) => setLineEligibleParties(line.id, parties)}
                    />

                    <td className="px-4 py-4">
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length === 1}
                        className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* TOTALS */}
          <div className="border-t bg-gray-50 px-6 py-5">
            <div className="ml-auto grid max-w-md grid-cols-2 gap-3 text-sm">
              <div className="font-medium text-gray-600">
                Total Debit
              </div>

              <div className="text-right font-semibold text-gray-900">
                Rs. {formatMoney(totalDebit)}
              </div>

              <div className="font-medium text-gray-600">
                Total Credit
              </div>

              <div className="text-right font-semibold text-gray-900">
                Rs. {formatMoney(totalCredit)}
              </div>
            </div>
          </div>

          {/* POST BUTTON */}
          <div className="flex justify-end border-t px-6 py-5">
            <button
              type="button"
              disabled={
                posting ||
                !accountId ||
                lines.length === 0
              }
              onClick={() =>
                postDailyPosting(false)
              }
              className="rounded-lg bg-green-600 px-8 py-3 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {posting
                ? "Posting..."
                : "POST DAILY ENTRIES"}
            </button>
          </div>
        </div>

        {/* EXISTING TRANSACTIONS */}
        <div className="mt-6 rounded-xl border bg-white shadow-sm">
          <div className="border-b px-6 py-4">
            <h2 className="font-semibold text-gray-900">
              Existing Transactions for {postingDate || "—"}
            </h2>
            <p className="text-xs text-gray-500">
              Every Daily Posting transaction already posted on this date. Click Edit to change one in place, or Delete to move it to Bin.
            </p>
          </div>

          {existingError && (
            <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{existingError}</div>
          )}

          {loadingExisting ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">Loading existing transactions...</div>
          ) : existingRows.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">No Daily Posting transactions for this date.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[1250px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Main Account</th>
                    <th className="px-4 py-3">Counter Account</th>
                    <th className="px-4 py-3">Document</th>
                    <th className="px-4 py-3">Document No.</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...existingRows].reverse().map((row, index) => {
                    const isEditing = editingIds.has(row.journalEntryId);
                    const draft = drafts.get(row.journalEntryId);
                    const isHighlighted = !!highlightId && row.journalEntryId === highlightId;

                    if (isEditing && draft) {
                      return (
                        <Fragment key={row.journalEntryId}>
                          <tr className="bg-blue-50/40">
                            <td className="px-4 py-4 text-sm text-gray-500">{index + 1}</td>
                            <td className="px-4 py-4">
                              <p className="rounded-lg border bg-gray-50 px-3 py-2 text-sm text-gray-700">{row.mainAccountName}</p>
                              <p className="mt-1 text-xs text-gray-500">Main Account cannot be reassigned.</p>
                              <div className="mt-2">
                                <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
                                <input
                                  type="date"
                                  value={draft.date}
                                  onChange={(e) => updateDraftDate(row.journalEntryId, e.target.value)}
                                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                                />
                              </div>
                            </td>

                            <LineFieldsCells
                              line={draft.line}
                              accounts={accounts}
                              mainAccountId={row.mainAccountId}
                              locked
                              onUpdate={(field, value) => updateDraftLine(row.journalEntryId, field, value)}
                              onEligibleParties={(parties) => setDraftEligibleParties(row.journalEntryId, parties)}
                            />

                            <td className="px-4 py-4">
                              <div className="flex flex-col gap-2">
                                {draft.error && <p className="text-xs text-red-600">{draft.error}</p>}
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => saveEdit(row)}
                                    disabled={draft.saving}
                                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {draft.saving ? "Saving..." : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => cancelEdit(row.journalEntryId)}
                                    disabled={draft.saving}
                                    className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        </Fragment>
                      );
                    }

                    return (
                      <tr key={row.journalEntryId} className={isHighlighted ? "bg-yellow-50" : "hover:bg-gray-50"}>
                        <td className="px-4 py-4 text-gray-500">{index + 1}</td>
                        <td className="px-4 py-4 font-medium text-gray-900">{row.mainAccountName}</td>
                        <td className="px-4 py-4 text-gray-900">{row.counterLabel}</td>
                        <td className="px-4 py-4 text-gray-900">{row.document}</td>
                        <td className="px-4 py-4 text-gray-600">{row.documentNo || "—"}</td>
                        <td className="px-4 py-4 text-gray-600">{row.description || "—"}</td>
                        <td className="px-4 py-4 text-right">{row.mainDebit > 0 ? `Rs. ${formatMoney(row.mainDebit)}` : "—"}</td>
                        <td className="px-4 py-4 text-right">{row.mainCredit > 0 ? `Rs. ${formatMoney(row.mainCredit)}` : "—"}</td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-2">
                            {row.canEdit ? (
                              <button
                                type="button"
                                onClick={() => startEdit(row)}
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
                                onClick={() => handleDeleteExisting(row)}
                                className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                              >
                                Delete
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

          {existingRows.length > 0 && (
            <div className="border-t bg-gray-50 px-6 py-5">
              <div className="ml-auto grid max-w-md grid-cols-2 gap-3 text-sm">
                <div className="font-medium text-gray-600">Total Debit</div>
                <div className="text-right font-semibold text-gray-900">Rs. {formatMoney(existingTotals.debit)}</div>
                <div className="font-medium text-gray-600">Total Credit</div>
                <div className="text-right font-semibold text-gray-900">Rs. {formatMoney(existingTotals.credit)}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* DUPLICATE WARNING MODAL */}
      {showDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
            <div className="border-b px-6 py-5">
              <h2 className="text-lg font-bold text-gray-900">
                Document Already Posted
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                One or more selected documents have
                already been posted.
              </p>
            </div>

            <div className="max-h-72 overflow-y-auto px-6 py-4">
              {duplicateData.map(
                (duplicate, index) => (
                  <div
                    key={`${duplicate.sourceId}-${index}`}
                    className="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 p-4"
                  >
                    <div className="text-sm font-semibold text-gray-900">
                      {duplicate.sourceType}{" "}
                      {duplicate.sourceNumber ||
                        duplicate.sourceId}
                    </div>

                    <div className="mt-1 text-xs text-gray-600">
                      Existing amount: Rs.{" "}
                      {duplicate.amount}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="flex justify-end gap-3 border-t px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  setShowDuplicateWarning(false);
                  setDuplicateData([]);
                }}
                disabled={posting}
                className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() =>
                  postDailyPosting(true)
                }
                disabled={posting}
                className="rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {posting
                  ? "Posting..."
                  : "Post Anyway"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
