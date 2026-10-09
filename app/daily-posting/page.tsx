"use client";

import { useEffect, useMemo, useState } from "react";
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

// ONE counter (Party/other) JournalLine of a Daily Posting
// JournalEntry - a genuinely multi-line entry has N of these sharing
// one Main (Cash/Bank) leg. Debit/credit are kept as the line's own
// stored values (never translated into the "direction relative to
// Main Account" convention here) so read-only display always matches
// the ledger exactly; that translation only happens once, in
// startEdit(), when building an editable draft line.
type ExistingCounterLine = {
  id: string; // the real JournalLine id - the PATCH target / PaymentAllocation anchor
  counterAccountId: string;
  counterLabel: string;
  description: string;
  debit: number;
  credit: number;
  sourceType: string;
  sourceId: string | null;
  sourceNumber: string;
};

// ONE row = ONE Daily Posting JournalEntry (one logical transaction),
// built from its Main (Cash/Bank) leg(s) + its own N counter lines -
// never one row per JournalLine.
type ExistingRow = {
  journalEntryId: string;
  sortKey: number; // entryDate ms, for oldest->newest ordering
  mainAccountId: string | null; // null only for a structurally unsupported entry (see below)
  mainAccountName: string;
  mainLineId: string | null; // one of the entry's own Main Cash/Bank JournalLine ids - the Bin-eligibility lookup key
  anyLineId: string; // ANY line id belonging to this entry - the DELETE (Bin) target, works regardless of structure
  counterLines: ExistingCounterLine[];
  mainDebit: number; // the Main account leg(s)' combined debit
  mainCredit: number; // the Main account leg(s)' combined credit
  balance: number; // per (main) account running balance for THIS day only
  canEdit: boolean;
  canMoveToBin: boolean;
  binProtectedReason: string | null;
  editBlockedReason: string | null;
};

// Combines ONE Daily Posting JournalEntry's lines into ONE row,
// carrying its complete set of counter lines. A Daily Posting entry
// always shares exactly ONE Main (Cash/Bank) account across every one
// of its own "main leg" lines (see buildLinePair() in
// app/api/daily-posting/route.ts); a structurally different entry -
// zero or more-than-one distinct Cash/Bank accounts, or no counter
// lines at all - is something Daily Posting's own create flow never
// actually produces. Such an entry still yields exactly ONE row, with
// Edit/Bin both disabled (there is no safe, authoritative way to
// resolve Bin eligibility for a line outside any Cash/Bank account).
function buildExistingRow(entry: ExistingJournalEntry): ExistingRow {
  const cbLines = entry.lines.filter((l) => isCashOrBank(l.account));
  const counterRaw = entry.lines.filter((l) => !isCashOrBank(l.account));
  const sortKey = new Date(entry.entryDate).getTime();
  const distinctMainIds = [...new Set(cbLines.map((l) => l.account.id))];
  const anyLineId = entry.lines[0]?.id || entry.id;

  if (distinctMainIds.length !== 1 || counterRaw.length === 0) {
    const accountNames = [...new Set(entry.lines.map((l) => l.account.accountName))];
    const debit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
    const reason =
      distinctMainIds.length === 0
        ? "No Cash/Bank leg on this entry."
        : distinctMainIds.length > 1
        ? "Multiple Cash/Bank legs on this entry."
        : "This entry has no counter lines.";

    return {
      journalEntryId: entry.id,
      sortKey,
      mainAccountId: null,
      mainAccountName: accountNames.join(", ") || "—",
      mainLineId: null,
      anyLineId,
      counterLines: [],
      mainDebit: debit,
      mainCredit: credit,
      balance: 0,
      canEdit: false,
      canMoveToBin: false,
      binProtectedReason: reason,
      editBlockedReason: reason,
    };
  }

  const mainAccount = cbLines[0].account;
  const mainDebit = cbLines.reduce((s, l) => s + Number(l.debit), 0);
  const mainCredit = cbLines.reduce((s, l) => s + Number(l.credit), 0);

  const counterLines: ExistingCounterLine[] = counterRaw.map((l) => ({
    id: l.id,
    counterAccountId: l.account.id,
    counterLabel: partyLabel(l.account),
    description: l.description || entry.description || "",
    debit: Number(l.debit),
    credit: Number(l.credit),
    sourceType: l.sourceType || "DIRECT",
    sourceId: l.sourceId,
    sourceNumber: l.sourceNumber || "",
  }));

  return {
    journalEntryId: entry.id,
    sortKey,
    mainAccountId: mainAccount.id,
    mainAccountName: mainAccount.accountName,
    mainLineId: cbLines[0].id,
    anyLineId: cbLines[0].id,
    counterLines,
    mainDebit,
    mainCredit,
    balance: 0,
    canEdit: false, // set by caller once capabilities are known
    canMoveToBin: false,
    binProtectedReason: null,
    editBlockedReason: null,
  };
}

// An editable counter line - EXACTLY a PostingLine (so the SAME
// <LineFieldsCells> renders it) plus `journalLineId`: the real,
// existing JournalLine id when this line already existed on the
// entry, or null for a line the user just added in edit mode (sent to
// PATCH /api/daily-posting/[id] as a brand-new counter line).
type EditableLine = PostingLine & { journalLineId: string | null };

// A transaction currently in inline-edit mode carries its own draft:
// its own Date (New Transactions share one page-level date, but an
// existing posted entry edits independently, exactly like the former
// edit modal already allowed) plus the COMPLETE set of its counter
// lines, each editable, addable, and removable independently.
type ExistingDraft = {
  date: string;
  lines: EditableLine[];
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
// posted line being edited (Existing Transactions). Counter Account is
// never locked here for either case - the server independently
// re-validates whatever is submitted (document legitimacy, active
// account, PARTY<->CASH/BANK restriction, PaymentAllocation safety)
// and rejects an illegitimate change with a clear message rather than
// the UI trying to predict every rule client-side.
// ============================================================
function LineFieldsCells({
  line,
  accounts,
  mainAccountId,
  onUpdate,
  onEligibleParties,
}: {
  line: PostingLine;
  accounts: Account[];
  mainAccountId: string;
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
        if (!row.mainLineId) continue;
        const eligibility = eligibilityByLineId.get(row.mainLineId);
        row.canEdit = capabilities.canEdit;
        row.canMoveToBin = capabilities.canMoveToBin && !!eligibility?.canMoveToBin;
        row.binProtectedReason = eligibility?.binProtectedReason ?? null;
      }

      // Oldest -> newest for the running-balance computation.
      built.sort((a, b) => a.sortKey - b.sortKey || a.journalEntryId.localeCompare(b.journalEntryId));
      const runningByAccount = new Map<string, number>();
      for (const row of built) {
        if (!row.mainAccountId) continue;
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
    if (!row.mainAccountId || !row.canEdit || row.counterLines.length === 0) return;
    setEditingIds((prev) => new Set(prev).add(row.journalEntryId));
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(row.journalEntryId, {
        date: postingDate,
        lines: row.counterLines.map((cl) => ({
          id: crypto.randomUUID(),
          journalLineId: cl.id,
          counterAccountId: cl.counterAccountId,
          description: cl.description,
          // A counter line's OWN debit/credit are the opposite sense
          // of "direction relative to the Main account" (see
          // buildLinePair() in app/api/daily-posting/route.ts:
          // counterDebit = direction==='CREDIT'?amount:0) - so a
          // counter line with debit>0 means direction===CREDIT.
          amount: String(cl.debit > 0 ? cl.debit : cl.credit),
          direction: cl.debit > 0 ? "CREDIT" : "DEBIT",
          sourceType: cl.sourceType,
          sourceId: cl.sourceId || "",
          sourceNumber: cl.sourceNumber,
          resolvedPartyLabel: cl.counterLabel,
          eligibleParties: [],
        })),
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

  function updateDraftLine(journalEntryId: string, lineIndex: number, field: keyof PostingLine, value: string) {
    setDrafts((prev) => {
      const current = prev.get(journalEntryId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(journalEntryId, {
        ...current,
        lines: current.lines.map((line, idx) => (idx === lineIndex ? { ...line, [field]: value } : line)),
      });
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

  function setDraftEligibleParties(journalEntryId: string, lineIndex: number, parties: EligibleParty[]) {
    setDrafts((prev) => {
      const current = prev.get(journalEntryId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(journalEntryId, {
        ...current,
        lines: current.lines.map((line, idx) => (idx === lineIndex ? { ...line, eligibleParties: parties } : line)),
      });
      return next;
    });
  }

  // Scoped entirely to ONE transaction's own draft - mirrors the New
  // Transactions form's own addLine()/removeLine(), just keyed by
  // journalEntryId instead of being page-global.
  function addDraftLine(journalEntryId: string) {
    setDrafts((prev) => {
      const current = prev.get(journalEntryId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(journalEntryId, {
        ...current,
        lines: [...current.lines, { ...createLine(), journalLineId: null }],
      });
      return next;
    });
  }

  function removeDraftLine(journalEntryId: string, lineIndex: number) {
    setDrafts((prev) => {
      const current = prev.get(journalEntryId);
      if (!current || current.lines.length === 1) return prev;
      const next = new Map(prev);
      next.set(journalEntryId, {
        ...current,
        lines: current.lines.filter((_, idx) => idx !== lineIndex),
      });
      return next;
    });
  }

  async function saveEdit(row: ExistingRow) {
    const draft = drafts.get(row.journalEntryId);
    if (!draft) return;

    for (const [index, line] of draft.lines.entries()) {
      const lineError = validatePostingLine(line, accounts);
      if (lineError) {
        setDrafts((prev) => {
          const next = new Map(prev);
          next.set(row.journalEntryId, { ...draft, error: `${lineError} (line ${index + 1})` });
          return next;
        });
        return;
      }
    }

    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(row.journalEntryId, { ...draft, saving: true, error: "" });
      return next;
    });

    try {
      // PATCH /api/daily-posting/[id] - the dedicated multi-line edit
      // endpoint. Unlike the simple 2-line PATCH /api/cash-book/[id]
      // (still used by Cash Book's own editing, untouched), this
      // accepts the COMPLETE set of counter lines and edits the entry
      // atomically: an existing line (journalLineId present) is
      // updated in place, preserving its id and any PaymentAllocation
      // against it; a line added here (journalLineId null) is created
      // fresh; a line removed from this draft is deleted server-side
      // only after confirming it carries no PaymentAllocation.
      const response = await fetch(`/api/daily-posting/${row.journalEntryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: draft.date,
          lines: draft.lines.map((line) => ({
            id: line.journalLineId || undefined,
            counterAccountId: line.counterAccountId || undefined,
            description: line.description.trim(),
            amount: Number(line.amount),
            direction: line.direction,
            sourceType: line.sourceType,
            sourceId: line.sourceId.trim() || undefined,
            sourceNumber: line.sourceNumber.trim() || undefined,
          })),
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
    const confirmed = window.confirm(
      "Move this complete Journal Entry to Bin?\n\nAll of its journal lines will be excluded from normal accounting. This is not permanent deletion."
    );
    if (!confirmed) return;
    try {
      setExistingError("");
      // DELETE /api/cash-book/[id] resolves the WHOLE JournalEntry
      // from whichever line id it's given (via that line's own
      // journalEntryId) and bins every one of its lines regardless of
      // how many there are - any line id on this entry is a valid
      // target, not specifically a Cash/Bank one.
      const response = await fetch(`/api/cash-book/${row.anyLineId}`, { method: "DELETE" });
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
            <div className="divide-y">
              {[...existingRows].reverse().map((row, index) => {
                const isEditing = editingIds.has(row.journalEntryId);
                const draft = drafts.get(row.journalEntryId);
                const isHighlighted = !!highlightId && row.journalEntryId === highlightId;
                const transactionNo = existingRows.length - index;

                return (
                  <div key={row.journalEntryId} className={`px-6 py-5 ${isHighlighted ? "bg-yellow-50" : ""}`}>
                    {/* TRANSACTION HEADER */}
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase text-gray-500">
                          Transaction #{transactionNo}
                          {row.counterLines.length > 1 && (
                            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-blue-700">
                              {row.counterLines.length} lines
                            </span>
                          )}
                        </p>
                        <p className="text-base font-semibold text-gray-900">{row.mainAccountName}</p>

                        {isEditing && draft ? (
                          <div className="mt-2 flex items-center gap-2">
                            <label className="text-xs font-medium text-gray-600">Date</label>
                            <input
                              type="date"
                              value={draft.date}
                              onChange={(e) => updateDraftDate(row.journalEntryId, e.target.value)}
                              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                            />
                            <span className="text-xs text-gray-500">Main Account cannot be reassigned.</span>
                          </div>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right text-sm">
                          <p className="text-gray-500">
                            Debit <span className="font-semibold text-gray-900">{row.mainDebit > 0 ? `Rs. ${formatMoney(row.mainDebit)}` : "—"}</span>
                          </p>
                          <p className="text-gray-500">
                            Credit <span className="font-semibold text-gray-900">{row.mainCredit > 0 ? `Rs. ${formatMoney(row.mainCredit)}` : "—"}</span>
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {isEditing && draft ? (
                            <>
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
                            </>
                          ) : (
                            <>
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
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {isEditing && draft?.error && (
                      <p className="mt-2 text-xs text-red-600">{draft.error}</p>
                    )}

                    {/* COUNTER LINES */}
                    <div className="mt-4 overflow-x-auto rounded-lg border">
                      <table className="min-w-[1100px] w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                          <tr>
                            <th className="px-4 py-2">Counter Account</th>
                            <th className="px-4 py-2">Document</th>
                            <th className="px-4 py-2">Document No.</th>
                            <th className="px-4 py-2">Description</th>
                            <th className="px-4 py-2 text-right">Debit</th>
                            <th className="px-4 py-2 text-right">Credit</th>
                            {isEditing && <th className="px-4 py-2">Action</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {isEditing && draft ? (
                            draft.lines.map((line, lineIndex) => (
                              <tr key={line.id}>
                                <LineFieldsCells
                                  line={line}
                                  accounts={accounts}
                                  mainAccountId={row.mainAccountId || ""}
                                  onUpdate={(field, value) => updateDraftLine(row.journalEntryId, lineIndex, field, value)}
                                  onEligibleParties={(parties) => setDraftEligibleParties(row.journalEntryId, lineIndex, parties)}
                                />
                                <td className="px-4 py-4">
                                  <button
                                    type="button"
                                    onClick={() => removeDraftLine(row.journalEntryId, lineIndex)}
                                    disabled={draft.lines.length === 1}
                                    className="rounded-lg border border-red-200 px-3 py-2 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            ))
                          ) : (
                            row.counterLines.map((cl) => (
                              <tr key={cl.id}>
                                <td className="px-4 py-3 text-gray-900">{cl.counterLabel}</td>
                                <td className="px-4 py-3 text-gray-900">{formatDocument(cl.sourceType)}</td>
                                <td className="px-4 py-3 text-gray-600">{cl.sourceNumber || "—"}</td>
                                <td className="px-4 py-3 text-gray-600">{cl.description || "—"}</td>
                                <td className="px-4 py-3 text-right text-gray-900">{cl.debit > 0 ? `Rs. ${formatMoney(cl.debit)}` : "—"}</td>
                                <td className="px-4 py-3 text-right text-gray-900">{cl.credit > 0 ? `Rs. ${formatMoney(cl.credit)}` : "—"}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>

                      {isEditing && (
                        <div className="border-t bg-gray-50 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => addDraftLine(row.journalEntryId)}
                            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                          >
                            + Add Line
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
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
