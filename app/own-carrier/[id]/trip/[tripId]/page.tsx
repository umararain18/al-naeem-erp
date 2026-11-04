"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatBusinessDate } from "@/lib/date-range";
import { computeTripSummaryBar } from "@/lib/carrier-trip-summary";

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
}

// formatMoney() always shows a plain magnitude (same convention as
// every other formatMoney in this codebase) - fine for an In/Out
// amount or a Bilty/Carrier Rent figure, which are never negative in
// this domain, but a running Cash Book balance and Own Carrier Profit
// genuinely CAN go negative, and silently dropping the sign there
// made a deeply negative Driver Cash balance look like it was
// growing positively. Used ONLY for those two signed figures.
function formatSignedMoney(value: number) {
  return `${value < 0 ? "-" : ""}Rs. ${formatMoney(value)}`;
}

function todayYMD(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function toYMD(iso: string): string {
  return iso.slice(0, 10);
}

type Trip = {
  id: string;
  tripNo: string;
  route: string | null;
  dateFrom: string;
  dateTo: string | null;
  notes: string | null;
  status: "OPEN" | "CLOSED";
  carrier: {
    id: string;
    carrierNumber: string;
    driverName: string | null;
    defaultPumpPartyId: string | null;
    defaultPaidFrom: string | null;
    defaultPumpParty: { id: string; partyName: string } | null;
    currentDriverId: string | null;
    currentDriver: { id: string; name: string } | null;
  };
};

type DocumentLink = {
  id: string;
  documentType: string;
  documentId: string;
  label: string;
  linkedAt: string;
  carrierRentAmount: number;
  isOwnCarrierChallan: boolean;
  outstanding: number | null;
};

// GET /api/challan/[id]/bilty-collection-state - one row per Bilty on
// a linked Challan, for the Collection (Wasooli) "pick one Bilty or
// split across Bilties" picker. `accountId: null` means genuinely
// ambiguous - the row needs a manually-picked party before it can be
// submitted (see QuickEntryForm's own biltyPartyChoice state).
type BiltyCollectionRow = {
  biltyId: string;
  biltyNo: string;
  toPay: number;
  accountId: string | null;
  partyName: string | null;
  outstanding: number;
  received: number;
};

type CashBookRow = {
  id: string;
  date: string;
  lineType: string;
  description: string;
  in: number;
  out: number;
  balance: number;
  documentType: string | null;
  documentId: string | null;
  category: string | null;
  officeAccountId: string | null;
  vendorPartyId: string | null;
  employeeId: string | null;
  isDiesel: boolean;
  liters: number | null;
  ratePerLiter: number | null;
  pumpPartyId: string | null;
  pumpPartyName: string | null;
};

type CashBook = { openingBalance: number; rows: CashBookRow[]; closingBalance: number };

// Category labels - mirrors lib/carrier-trip.ts's own categoryLabel()
// exactly (DIESEL/TOLL/KHANA/MARAMMAT/SALARY/OTHER) - every
// expense/salary line debits the SAME Carrier Profit account now, so
// this is the one thing that still varies per-line, and the only
// thing drafts/lists ever show for it (never an account name).
function categoryLabel(category: string | null | undefined): string {
  switch (category) {
    case "DIESEL": return "Diesel";
    case "TOLL": return "Toll";
    case "KHANA": return "Khana";
    case "MARAMMAT": return "Marammat";
    case "SALARY": return "Salary";
    case "OTHER": return "Other";
    default: return "Expense";
  }
}

// Keyed by the REAL posted CarrierTripLineType - used for the Reverse
// confirm text. The quick-entry row's own Type buttons (QUICK_TYPES
// below) are a separate, UI-only taxonomy layered on top of these.
const LINE_TYPE_LABELS: Record<string, string> = {
  COLLECTION: "Collection (Wasooli)",
  CASH_FROM_OFFICE: "Office se cash",
  EXPENSE_CASH: "Expense (Driver Cash)",
  EXPENSE_OFFICE: "Expense (Office Account)",
  EXPENSE_CREDIT: "Expense (Udhaar)",
  DRIVER_SALARY: "Salary",
  DEPOSIT_TO_OFFICE: "Office mein jama",
};

/**
 * Fast keyboard entry: "20k" -> 20000, "1.5L" -> 150000 (Lakh, the
 * common Pakistani/Indian shorthand - NOT liters, which is its own,
 * separate field), and "+"-joined terms sum ("500+700+300" -> 1500),
 * each term allowed its own k/L suffix. Returns null (never NaN/0)
 * for anything that doesn't parse, so the caller can tell "empty" and
 * "typo" apart from a genuine zero.
 */
function parseAmountExpression(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const terms = trimmed.split("+");
  let total = 0;
  for (const term of terms) {
    const match = term.trim().match(/^(\d+(?:\.\d+)?)\s*([kKlL]?)$/);
    if (!match) return null;
    const value = Number(match[1]);
    const suffix = match[2].toLowerCase();
    total += suffix === "k" ? value * 1000 : suffix === "l" ? value * 100000 : value;
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

type DraftRow = {
  id: string;
  lineType: "EXPENSE_CASH" | "EXPENSE_OFFICE" | "EXPENSE_CREDIT" | "DRIVER_SALARY";
  category: string | null;
  vendorPartyId: string | null;
  vendorPartyName: string | null;
  officeAccountId: string | null;
  officeAccountName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  isDiesel: boolean;
  pumpPartyId: string | null;
  pumpPartyName: string | null;
  liters: string;
  ratePerLiter: string;
  amount: string;
  note: string;
};

function draftsStorageKey(tripId: string): string {
  return `oc-drafts-${tripId}`;
}

function loadDraftsFromStorage(tripId: string): DraftRow[] {
  try {
    const raw = window.localStorage.getItem(draftsStorageKey(tripId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDraftsToStorage(tripId: string, drafts: DraftRow[]) {
  try {
    window.localStorage.setItem(draftsStorageKey(tripId), JSON.stringify(drafts));
  } catch {
    // per-viewer convenience only - never required to persist
  }
}

function templateToDraft(t: {
  lineType: DraftRow["lineType"];
  category: string | null;
  vendorPartyId: string | null;
  vendorPartyName: string | null;
  officeAccountId: string | null;
  officeAccountName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  description: string | null;
  isDiesel: boolean;
  pumpPartyId: string | null;
  pumpPartyName: string | null;
}): DraftRow {
  return {
    id: `draft-${Math.random().toString(36).slice(2)}`,
    lineType: t.lineType,
    category: t.category,
    vendorPartyId: t.vendorPartyId,
    vendorPartyName: t.vendorPartyName,
    officeAccountId: t.officeAccountId,
    officeAccountName: t.officeAccountName,
    employeeId: t.employeeId,
    employeeName: t.employeeName,
    isDiesel: t.isDiesel,
    pumpPartyId: t.pumpPartyId,
    pumpPartyName: t.pumpPartyName,
    liters: "",
    ratePerLiter: "",
    amount: "",
    note: t.isDiesel ? "" : t.description || "",
  };
}

function paidFromStorageKey(tripId: string, quickTypeKey: string): string {
  return `oc-paidfrom-${tripId}-${quickTypeKey}`;
}

// "Rate remembered per pump" - deliberately carrier-wide (not scoped
// to one Trip), since a pump's diesel price is a real-world fact that
// outlives any one Trip.
function dieselRateStorageKey(pumpPartyId: string): string {
  return `oc-dieselrate-${pumpPartyId}`;
}

function loadRememberedRate(pumpPartyId: string): string {
  try {
    return window.localStorage.getItem(dieselRateStorageKey(pumpPartyId)) || "";
  } catch {
    return "";
  }
}

function saveRememberedRate(pumpPartyId: string, rate: string) {
  try {
    if (rate) window.localStorage.setItem(dieselRateStorageKey(pumpPartyId), rate);
  } catch {
    // per-viewer convenience only
  }
}

export default function CarrierTripDetailPage() {
  const params = useParams();
  const carrierId = params.id as string;
  const tripId = params.tripId as string;

  const [trip, setTrip] = useState<Trip | null>(null);
  const [documents, setDocuments] = useState<DocumentLink[]>([]);
  const [cashBook, setCashBook] = useState<CashBook | null>(null);
  const [capabilities, setCapabilities] = useState({ canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [linkDocsOpen, setLinkDocsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<CashBookRow | null>(null);
  const [lastDate, setLastDate] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [draftsSeeded, setDraftsSeeded] = useState(false);
  const [draftDate, setDraftDate] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);

  async function copyFromPreviousTrip(options: { replace: boolean; silent: boolean }) {
    const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/previous-expenses`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (!options.silent) alert(data.message || "Unable to load previous Trip's expenses.");
      return;
    }
    if (!data.previousTripNo) {
      if (!options.silent) alert("This carrier has no previous Trip to copy from.");
      return;
    }
    const copied: DraftRow[] = data.templates.map(templateToDraft);
    setDrafts((prev) => {
      const next = options.replace ? copied : [...prev, ...copied];
      saveDraftsToStorage(tripId, next);
      return next;
    });
  }

  function removeDraft(draftId: string) {
    setDrafts((prev) => {
      const next = prev.filter((d) => d.id !== draftId);
      saveDraftsToStorage(tripId, next);
      return next;
    });
  }

  async function saveDraft(draft: DraftRow, date: string): Promise<string | null> {
    const amount = parseAmountExpression(draft.amount);
    if (!amount || amount <= 0) return "Enter a valid amount.";

    const description = draft.isDiesel ? buildDieselDescription(draft.pumpPartyName || "", draft.liters, draft.note) : draft.note.trim() || undefined;
    const payload: Record<string, unknown> = { lineType: draft.lineType, date, amount, description };
    if (draft.lineType === "EXPENSE_OFFICE") payload.officeAccountId = draft.officeAccountId;
    if (draft.lineType === "EXPENSE_CREDIT") payload.vendorPartyId = draft.vendorPartyId;
    if (draft.lineType === "EXPENSE_CASH" || draft.lineType === "EXPENSE_OFFICE" || draft.lineType === "EXPENSE_CREDIT") {
      payload.category = draft.category;
    }
    if (draft.lineType === "DRIVER_SALARY") {
      // Driver = carrier's CURRENT driver, resolved fresh at save time
      // - never the old template's employeeId (the driver may have
      // changed since the previous Trip) - see item 9's own "prefilled,
      // only amount needed" design.
      if (!trip?.carrier.currentDriverId) return "Set this carrier's current driver first (Carrier Settings).";
      payload.employeeId = trip.carrier.currentDriverId;
    }
    if (draft.isDiesel) {
      payload.isDiesel = true;
      payload.liters = draft.liters.trim() ? Number(draft.liters) : undefined;
      payload.ratePerLiter = draft.ratePerLiter.trim() ? Number(draft.ratePerLiter) : undefined;
      payload.pumpPartyId = draft.pumpPartyId || undefined;
    }

    const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.success) return data.message || "Unable to save draft.";

    removeDraft(draft.id);
    refresh();
    return null;
  }

  function updateDraft(draftId: string, patch: Partial<DraftRow>) {
    setDrafts((prev) => {
      const next = prev.map((d) => (d.id === draftId ? { ...d, ...patch } : d));
      saveDraftsToStorage(tripId, next);
      return next;
    });
  }

  // "When a new Trip is created ... copy the previous trip's expense
  // lines ... as DRAFT rows" - fires once, only for a genuinely fresh
  // Trip (zero posted lines yet) that has no drafts already saved
  // locally (a reload of an in-progress Trip must never re-seed on
  // top of what the user already has). The explicit "Copy from
  // previous trip" button (copyFromPreviousTrip(true)) works anytime,
  // independent of this auto-seed.
  useEffect(() => {
    if (!cashBook || draftsSeeded) return;
    setDraftsSeeded(true);
    const stored = loadDraftsFromStorage(tripId);
    if (stored.length > 0) {
      setDrafts(stored);
      return;
    }
    if (cashBook.rows.length === 0) {
      copyFromPreviousTrip({ replace: true, silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashBook, draftsSeeded]);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load Trip");
      setTrip(data.trip);
      setDocuments(data.documents || []);
      setCashBook(data.cashBook);
      setCapabilities(data.capabilities || { canEdit: false, canBin: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Trip");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carrierId, tripId, refreshToken]);

  function refresh() {
    setRefreshToken((k) => k + 1);
  }

  async function handleSaveCarrierRent(link: DocumentLink, value: string) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      alert("Carrier Rent must be a non-negative number.");
      return;
    }
    const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/documents/${link.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ carrierRentAmount: amount }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || "Unable to update Carrier Rent.");
      return;
    }
    refresh();
  }

  async function handleUnlink(link: DocumentLink) {
    if (!window.confirm(`Unlink ${link.label} from this Trip?`)) return;
    const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/documents/${link.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || "Unable to unlink document.");
      return;
    }
    refresh();
  }

  async function handleReverseLine(row: CashBookRow) {
    const reason = window.prompt(`Reverse this ${LINE_TYPE_LABELS[row.lineType] || row.lineType} line (Rs. ${formatMoney(row.in || row.out)})?\n\nOptional reason:`);
    if (reason === null) return;
    const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/lines/${row.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || undefined }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || "Unable to reverse line.");
      return;
    }
    if (editingLine?.id === row.id) setEditingLine(null);
    refresh();
  }

  async function toggleStatus() {
    if (!trip) return;
    const nextStatus = trip.status === "OPEN" ? "CLOSED" : "OPEN";
    const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || "Unable to update Trip status.");
      return;
    }
    refresh();
  }

  // ------------------------------------------------------------
  // Summary bar + IN/OUT/Diesel split - pure, read-only derivations
  // over the authoritative cashBook.rows / openingBalance /
  // closingBalance already computed server-side (lib/carrier-trip.ts's
  // getTripCashBook) - nothing here recomputes a balance. Diesel is
  // identified by the real isDiesel column (CarrierTripLine.isDiesel's
  // own schema doc comment) rather than by description text, since
  // Diesel can be posted as EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT
  // depending on payment source.
  //
  // INVARIANT (also covered by lib/carrier-trip-summary.test.ts):
  // Previous Balance + Total IN - Total OUT (Driver Cash) must
  // always equal Remaining With Driver - the same
  // identity cashDelta()/getTripOpeningBalance() already enforce
  // server-side. That means Total OUT (Driver Cash) MUST include a
  // Diesel line that was actually paid from Driver Cash (EXPENSE_CASH
  // + isDiesel) - excluding it (as a previous version of this file
  // did) silently broke the displayed arithmetic even though the real
  // closingBalance was always correct. "of which Diesel" is shown as
  // a breakdown UNDER the Total OUT stat so the Diesel-specific total
  // (all payment sources - driver cash, office, Udhaar) can still be
  // seen on its own via the separate "Diesel Total" stat, without
  // double-subtracting it.
  // ------------------------------------------------------------
  const rows = cashBook?.rows || [];
  const inRows = useMemo(() => rows.filter((r) => r.in > 0), [rows]);
  const dieselRows = useMemo(() => rows.filter((r) => r.out > 0 && r.isDiesel), [rows]);
  const outRows = useMemo(() => rows.filter((r) => r.out > 0 && !r.isDiesel), [rows]);
  const summaryBar = useMemo(() => computeTripSummaryBar(rows), [rows]);
  const { totalIn, totalOutDriverCash, dieselByDriverCash, dieselTotal } = summaryBar;

  if (loading) {
    return <div className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">Loading...</div>;
  }
  if (error || !trip) {
    return <div className="min-h-screen bg-gray-50 p-6 text-sm text-red-700">{error || "Trip not found"}</div>;
  }

  const canAct = capabilities.canEdit && trip.status === "OPEN";

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <Link href={`/own-carrier/${carrierId}`} className="text-xs text-gray-500 hover:underline">
          ← Back to {trip.carrier.carrierNumber}
        </Link>

        <div className="mt-2 mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Trip {trip.tripNo}</h1>
            <p className="mt-1 text-sm text-gray-500">
              {trip.route || "No route specified"} • {formatBusinessDate(trip.dateFrom)}
              {trip.dateTo ? ` - ${formatBusinessDate(trip.dateTo)}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${trip.status === "OPEN" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{trip.status}</span>
            {capabilities.canEdit && (
              <button type="button" onClick={toggleStatus} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
                {trip.status === "OPEN" ? "Close Trip" : "Reopen Trip"}
              </button>
            )}
            <button type="button" onClick={() => setReportOpen(true)} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
              Profit Report
            </button>
          </div>
        </div>

        {/* DOCUMENTS */}
        <div className="mb-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Linked Documents (Challan / Phonch / Private Phonch)</h2>
            {canAct && (
              <button type="button" onClick={() => setLinkDocsOpen(true)} className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50">
                + Link Document
              </button>
            )}
          </div>
          {documents.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-gray-500">No documents linked to this Trip.</div>
          ) : (
            <div className="divide-y">
              {documents.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <div>
                    <span className="font-medium text-gray-900">{d.label}</span>
                    {d.outstanding != null && <span className="ml-2 text-xs text-gray-500">Outstanding: Rs. {formatMoney(d.outstanding)}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    {d.isOwnCarrierChallan && (
                      <CarrierRentEditor link={d} canEdit={canAct} onSave={handleSaveCarrierRent} />
                    )}
                    {canAct && (
                      <button type="button" onClick={() => handleUnlink(d)} className="rounded-md border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50">
                        Unlink
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* QUICK ENTRY */}
        {canAct && (
          <QuickEntryRow
            carrierId={carrierId}
            tripId={tripId}
            documents={documents}
            tripDateFrom={trip.dateFrom}
            tripDateTo={trip.dateTo}
            lastDate={lastDate}
            onDateUsed={setLastDate}
            editingLine={editingLine}
            onCancelEdit={() => setEditingLine(null)}
            onSaved={() => {
              setEditingLine(null);
              refresh();
            }}
            carrierDefaults={{
              defaultPumpPartyId: trip.carrier.defaultPumpPartyId,
              defaultPaidFrom: trip.carrier.defaultPaidFrom,
              currentDriverId: trip.carrier.currentDriverId,
              currentDriverName: trip.carrier.currentDriver?.name || null,
            }}
          />
        )}

        {/* DRAFTS - "previous slip" expense templates, empty amount until filled+saved */}
        {canAct && (
          <DraftsPanel
            drafts={drafts}
            draftDate={draftDate || lastDate || toYMD(trip.dateFrom)}
            onDateChange={setDraftDate}
            onCopyFromPrevious={() => copyFromPreviousTrip({ replace: false, silent: false })}
            onRemove={removeDraft}
            onUpdate={updateDraft}
            onSave={saveDraft}
          />
        )}

        {/* PASTE LIST - bulk entry, nothing posts before "Save all" */}
        {canAct && (
          <div className="mb-6 rounded-xl border bg-white shadow-sm">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-sm font-semibold text-gray-900">Paste List</h2>
              <button type="button" onClick={() => setPasteOpen((v) => !v)} className="text-xs text-blue-600 hover:underline">
                {pasteOpen ? "Hide" : "Paste multiple lines"}
              </button>
            </div>
            {pasteOpen && (
              <PasteListBox
                carrierId={carrierId}
                tripId={tripId}
                documents={documents}
                defaultDate={draftDate || lastDate || toYMD(trip.dateFrom)}
                currentDriverId={trip.carrier.currentDriverId}
                onSaved={() => {
                  setPasteOpen(false);
                  refresh();
                }}
              />
            )}
          </div>
        )}

        {/* SUMMARY BAR */}
        <div className="mb-6 grid grid-cols-2 gap-3 rounded-xl border bg-white p-4 shadow-sm sm:grid-cols-5">
          <SummaryStat label="Previous Balance" value={formatSignedMoney(cashBook?.openingBalance || 0)} negative={(cashBook?.openingBalance || 0) < 0} />
          <SummaryStat label="Total IN" value={`Rs. ${formatMoney(totalIn)}`} className="text-green-700" />
          <SummaryStat
            label="Total OUT (Driver Cash)"
            value={`Rs. ${formatMoney(totalOutDriverCash)}`}
            className="text-red-700"
            subLabel={dieselByDriverCash > 0 ? `incl. Diesel ${formatMoney(dieselByDriverCash)}` : undefined}
          />
          <SummaryStat label="Diesel Total" value={`Rs. ${formatMoney(dieselTotal)}`} className="text-orange-700" />
          <SummaryStat label="Remaining With Driver" value={formatSignedMoney(cashBook?.closingBalance || 0)} negative={(cashBook?.closingBalance || 0) < 0} bold />
        </div>

        {/* IN / OUT two-column layout (stacks on mobile) */}
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <CashList
            title="IN"
            rows={inRows}
            amountKey="in"
            amountClassName="text-green-700"
            canAct={canAct}
            onEdit={setEditingLine}
            onReverse={handleReverseLine}
          />
          <CashList
            title="OUT"
            rows={outRows}
            amountKey="out"
            amountClassName="text-red-700"
            canAct={canAct}
            onEdit={setEditingLine}
            onReverse={handleReverseLine}
          />
        </div>

        {/* DIESEL BOX */}
        <div className="mb-6 overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="border-b px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Diesel</h2>
          </div>
          {dieselRows.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-gray-500">No diesel entries yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[700px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2">Pump / Vendor</th>
                    <th className="px-4 py-2 text-right">Liters</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="px-4 py-2">Paid From</th>
                    {canAct && <th className="px-4 py-2">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {dieselRows.map((row) => {
                    return (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-600">{formatBusinessDate(row.date)}</td>
                        <td className="px-4 py-2 text-gray-900">{row.pumpPartyName || "—"}</td>
                        <td className="px-4 py-2 text-right text-gray-600">{row.liters ?? "—"}</td>
                        <td className="px-4 py-2 text-right font-medium text-orange-700">Rs. {formatMoney(row.out)}</td>
                        <td className="px-4 py-2 text-gray-600">{paidFromLabel(row.lineType)}</td>
                        {canAct && (
                          <td className="px-4 py-2">
                            <div className="flex gap-1.5">
                              <button type="button" onClick={() => setEditingLine(row)} className="rounded-md border px-2 py-1 text-xs hover:bg-gray-50">
                                Edit
                              </button>
                              <button type="button" onClick={() => handleReverseLine(row)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                                Reverse
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {linkDocsOpen && (
        <LinkDocumentsDrawer
          carrierId={carrierId}
          tripId={tripId}
          onClose={() => setLinkDocsOpen(false)}
          onLinked={() => {
            setLinkDocsOpen(false);
            refresh();
          }}
        />
      )}

      {reportOpen && <ProfitReportDrawer carrierId={carrierId} tripId={tripId} onClose={() => setReportOpen(false)} />}
    </div>
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function paidFromLabel(lineType: string): string {
  if (lineType === "EXPENSE_OFFICE") return "Office";
  if (lineType === "EXPENSE_CREDIT") return "Udhaar";
  return "Driver Cash";
}


function SummaryStat({
  label,
  value,
  className,
  negative,
  bold,
  subLabel,
}: {
  label: string;
  value: string;
  className?: string;
  negative?: boolean;
  bold?: boolean;
  subLabel?: string;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`${bold ? "text-lg" : "text-base"} font-semibold ${negative ? "text-red-700" : className || "text-gray-900"}`}>{value}</p>
      {subLabel && <p className="text-[11px] text-gray-500">{subLabel}</p>}
    </div>
  );
}

function CashList({
  title,
  rows,
  amountKey,
  amountClassName,
  canAct,
  onEdit,
  onReverse,
}: {
  title: string;
  rows: CashBookRow[];
  amountKey: "in" | "out";
  amountClassName: string;
  canAct: boolean;
  onEdit: (row: CashBookRow) => void;
  onReverse: (row: CashBookRow) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="border-b px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-sm text-gray-500">No {title.toLowerCase()} entries yet.</div>
      ) : (
        <div className="divide-y">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate text-gray-900">{row.description}</p>
                <p className="text-xs text-gray-500">{formatBusinessDate(row.date)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`font-medium ${amountClassName}`}>Rs. {formatMoney(row[amountKey])}</span>
                {canAct && (
                  <div className="flex gap-1">
                    <button type="button" onClick={() => onEdit(row)} className="rounded-md border px-2 py-1 text-xs hover:bg-gray-50">
                      Edit
                    </button>
                    <button type="button" onClick={() => onReverse(row)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                      Reverse
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// DRAWER (still used by Link Document + Profit Report)
// ============================================================
function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-xl text-gray-500 hover:bg-gray-100">
            ×
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

type AccountOption = { id: string; accountName: string; accountType: string; category: string };

function CarrierRentEditor({ link, canEdit, onSave }: { link: DocumentLink; canEdit: boolean; onSave: (link: DocumentLink, value: string) => Promise<void> }) {
  // 0 reads as "never entered yet" here (per spec: Carrier Rent stays
  // EMPTY for the user to enter, never prefilled) - shown as a blank
  // input, not a literal "0", same convention as every other
  // never-yet-set amount field in this module.
  const [value, setValue] = useState(link.carrierRentAmount ? String(link.carrierRentAmount) : "");
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    return <span className="text-xs text-gray-500">Carrier Rent: {link.carrierRentAmount ? `Rs. ${formatMoney(link.carrierRentAmount)}` : "not entered"}</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-500">Carrier Rent Rs.</span>
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder="not entered"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-28 rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-blue-500"
      />
      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          await onSave(link, value);
          setSaving(false);
        }}
        className="rounded-md border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
      >
        {saving ? "..." : "Save"}
      </button>
    </div>
  );
}

// ============================================================
// QUICK ENTRY ROW - replaces the old 6-drawer flow. One row posts (or,
// in edit mode, replaces-via-reverse-and-repost) a single
// CarrierTripLine. Wrapped in a real <form> so Enter submits and Tab
// moves between fields using nothing but the browser's own native
// behavior - no custom keyboard-handling code needed for either.
// ============================================================

type QuickTypeKey = "WASOOLI" | "DIESEL" | "TOLL" | "KHANA" | "MARAMMAT" | "OTHER_EXPENSE" | "SALARY" | "OFFICE_CASH" | "OFFICE_DEPOSIT";
type QuickKind = "COLLECTION" | "EXPENSE" | "DRIVER_SALARY" | "CASH_FROM_OFFICE" | "DEPOSIT_TO_OFFICE";
type PaymentSource = "DRIVER_CASH" | "OFFICE" | "UDHAAR";

// Category chip + Amount + Note - no account picker any more (every
// expense/salary line debits the SAME Carrier Profit account, see
// lib/carrier-trip.ts's own module comment); `category` is the one
// real column that distinguishes these, set 1:1 from the chip itself.
const QUICK_TYPES: { key: QuickTypeKey; label: string; kind: QuickKind; category?: string }[] = [
  { key: "WASOOLI", label: "Wasooli", kind: "COLLECTION" },
  { key: "DIESEL", label: "Diesel", kind: "EXPENSE", category: "DIESEL" },
  { key: "TOLL", label: "Toll", kind: "EXPENSE", category: "TOLL" },
  { key: "KHANA", label: "Khana", kind: "EXPENSE", category: "KHANA" },
  { key: "MARAMMAT", label: "Marammat", kind: "EXPENSE", category: "MARAMMAT" },
  { key: "OTHER_EXPENSE", label: "Other", kind: "EXPENSE", category: "OTHER" },
  { key: "SALARY", label: "Salary", kind: "DRIVER_SALARY" },
  { key: "OFFICE_CASH", label: "Office se cash", kind: "CASH_FROM_OFFICE" },
  { key: "OFFICE_DEPOSIT", label: "Office mein jama", kind: "DEPOSIT_TO_OFFICE" },
];

// category -> QuickTypeKey, for re-deriving the chip when prefilling
// Edit mode from an existing (non-Diesel) expense line's own saved
// category column.
const CATEGORY_TO_QUICK_KEY: Record<string, QuickTypeKey> = {
  TOLL: "TOLL",
  KHANA: "KHANA",
  MARAMMAT: "MARAMMAT",
  OTHER: "OTHER_EXPENSE",
};

function buildDieselDescription(pump: string, liters: string, note: string): string {
  return ["Diesel", pump.trim() || null, liters.trim() ? `${liters.trim()}L` : null, note.trim() || null].filter(Boolean).join(" - ");
}

function QuickEntryRow({
  carrierId,
  tripId,
  documents,
  tripDateFrom,
  tripDateTo,
  lastDate,
  onDateUsed,
  editingLine,
  onCancelEdit,
  onSaved,
  carrierDefaults,
}: {
  carrierId: string;
  tripId: string;
  documents: DocumentLink[];
  tripDateFrom: string;
  tripDateTo: string | null;
  lastDate: string | null;
  onDateUsed: (date: string) => void;
  editingLine: CashBookRow | null;
  onCancelEdit: () => void;
  onSaved: () => void;
  carrierDefaults: { defaultPumpPartyId: string | null; defaultPaidFrom: string | null; currentDriverId: string | null; currentDriverName: string | null };
}) {
  const [quickTypeKey, setQuickTypeKey] = useState<QuickTypeKey>("WASOOLI");
  const [date, setDate] = useState(lastDate || toYMD(tripDateFrom));
  const [itemValue, setItemValue] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("DRIVER_CASH");
  const [officeAccountId, setOfficeAccountId] = useState("");
  const [vendorPartyId, setVendorPartyId] = useState("");
  const [pumpPartyId, setPumpPartyId] = useState("");
  const [liters, setLiters] = useState("");
  const [ratePerLiter, setRatePerLiter] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [parties, setParties] = useState<{ id: string; partyName: string; account: { id: string } | null }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const itemRef = useRef<HTMLSelectElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // Per-Bilty Collection breakdown (Trip Wasooli against a linked
  // CHALLAN) - see app/api/challan/[id]/bilty-collection-state/route.ts.
  // null = not a Challan selection (or not yet loaded) - the plain
  // single Amount field above is used in that case, unchanged.
  const [biltyBreakdown, setBiltyBreakdown] = useState<BiltyCollectionRow[] | null>(null);
  const [loadingBiltyBreakdown, setLoadingBiltyBreakdown] = useState(false);
  const [biltyAmounts, setBiltyAmounts] = useState<Record<string, string>>({});
  // Only populated for a Bilty row whose own resolution is genuinely
  // ambiguous (accountId: null) - the user must pick a party there
  // before that row can be submitted, exactly like the existing
  // whole-document flow's own manual Counter Account fallback.
  const [biltyPartyChoice, setBiltyPartyChoice] = useState<Record<string, string>>({});

  async function loadBiltyBreakdown(challanId: string) {
    setLoadingBiltyBreakdown(true);
    setBiltyBreakdown(null);
    setBiltyAmounts({});
    setBiltyPartyChoice({});
    try {
      const res = await fetch(`/api/challan/${challanId}/bilty-collection-state`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && data.success && Array.isArray(data.bilties) && data.bilties.length > 0) {
        setBiltyBreakdown(data.bilties);
        const prefill: Record<string, string> = {};
        for (const b of data.bilties as BiltyCollectionRow[]) {
          if (b.outstanding > 0) prefill[b.biltyId] = String(b.outstanding);
        }
        setBiltyAmounts(prefill);
      }
    } catch {
      // Falls back to the plain whole-document Amount field - never
      // blocks the quick-entry row over a failed preview fetch.
    } finally {
      setLoadingBiltyBreakdown(false);
    }
  }

  useEffect(() => {
    (async () => {
      const [accRes, partyRes] = await Promise.all([fetch("/api/accounts"), fetch("/api/parties")]);
      const accJson = await accRes.json();
      if (accRes.ok && accJson.success !== false) setAccounts(accJson.accounts || []);
      const partyJson = await partyRes.json();
      if (partyRes.ok && partyJson.success) setParties(partyJson.parties || []);
    })();
  }, []);

  // Keys 1-9 pick a quick type - but only when focus isn't already in
  // an editable field (typing "20000" into Amount must never get read
  // as "press 2"), and never while editing an existing line (its type
  // is locked, same as Paid From).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (editingLine) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < QUICK_TYPES.length) {
        e.preventDefault();
        applyQuickType(QUICK_TYPES[index].key);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLine]);

  // Wasooli's own document list: outstanding-bearing documents first
  // (still-to-collect ones are what the driver is actually chasing),
  // fully-collected ones after - never a second, separate list.
  const sortedDocuments = useMemo(
    () => [...documents].sort((a, b) => (b.outstanding || 0) - (a.outstanding || 0)),
    [documents]
  );
  const officeAccounts = useMemo(() => accounts.filter((a) => a.accountType !== "EXPENSE" && a.accountType !== "PARTY"), [accounts]);
  const vendorParties = useMemo(() => parties.filter((p) => p.account), [parties]);
  // Pump/vendor is purely informational (CarrierTripLine.pumpPartyId's
  // own schema doc comment) - unlike the Udhaar vendor above, it never
  // needs a real ledger account, so every Party is offered.
  const pumpParties = parties;

  const quickType = QUICK_TYPES.find((t) => t.key === quickTypeKey)!;

  // Pre-fill the top row from an existing line when "Edit" is clicked
  // on a Cash Book / Diesel row - every field (account/vendor/
  // employee/document id/isDiesel/liters/ratePerLiter/pumpPartyId) is
  // read directly off the line's own saved columns, never guessed.
  useEffect(() => {
    if (!editingLine) {
      // Returning from Edit (Cancel, or after a successful save) -
      // never leave the row showing a stale edited line's fields.
      resetForFreshRow(false);
      return;
    }
    setDate(toYMD(editingLine.date));
    setAmount(String(editingLine.in || editingLine.out));
    const lt = editingLine.lineType;
    if (lt === "COLLECTION") {
      setQuickTypeKey("WASOOLI");
      const link = documents.find((d) => d.documentType === editingLine.documentType && d.documentId === editingLine.documentId);
      setItemValue(link?.id || "");
      setNote("");
    } else if (lt === "CASH_FROM_OFFICE") {
      setQuickTypeKey("OFFICE_CASH");
      setItemValue(editingLine.officeAccountId || "");
      setNote("");
    } else if (lt === "DEPOSIT_TO_OFFICE") {
      setQuickTypeKey("OFFICE_DEPOSIT");
      setItemValue(editingLine.officeAccountId || "");
      setNote("");
    } else if (lt === "DRIVER_SALARY") {
      // Driver is never picked any more (item 9: carrier's current
      // driver, prefilled) - editingLine.employeeId is kept only for
      // display elsewhere, never re-shown as a picker here.
      setQuickTypeKey("SALARY");
      setItemValue("");
      setNote(editingLine.description || "");
    } else {
      // EXPENSE_CASH / EXPENSE_OFFICE / EXPENSE_CREDIT
      setPaymentSource(lt === "EXPENSE_OFFICE" ? "OFFICE" : lt === "EXPENSE_CREDIT" ? "UDHAAR" : "DRIVER_CASH");
      setOfficeAccountId(editingLine.officeAccountId || "");
      setVendorPartyId(editingLine.vendorPartyId || "");
      setItemValue("");
      if (editingLine.isDiesel) {
        setQuickTypeKey("DIESEL");
        setPumpPartyId(editingLine.pumpPartyId || "");
        setLiters(editingLine.liters != null ? String(editingLine.liters) : "");
        setRatePerLiter(editingLine.ratePerLiter != null ? String(editingLine.ratePerLiter) : "");
        setNote("");
      } else {
        setQuickTypeKey(CATEGORY_TO_QUICK_KEY[editingLine.category || "OTHER"] || "OTHER_EXPENSE");
        setNote(editingLine.description || "");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLine?.id]);

  function focusFirstField() {
    window.setTimeout(() => {
      if (itemRef.current) itemRef.current.focus();
      else amountRef.current?.focus();
    }, 0);
  }

  function resetForFreshRow(keepType: boolean) {
    setAmount("");
    setNote("");
    setLiters("");
    setBiltyBreakdown(null);
    setBiltyAmounts({});
    setBiltyPartyChoice({});
    if (!keepType) {
      setItemValue("");
      setPaymentSource("DRIVER_CASH");
      setOfficeAccountId("");
      setVendorPartyId("");
      setPumpPartyId("");
      setRatePerLiter("");
    } else {
      // Collection/office Item is document/account-specific per entry
      // - always cleared; payment source (and, for Diesel, the pump/
      // vendor/rate) are kept, since the common case is several of
      // the same category in a row.
      if (quickType.kind === "COLLECTION" || quickType.kind === "CASH_FROM_OFFICE" || quickType.kind === "DEPOSIT_TO_OFFICE") {
        setItemValue("");
      }
    }
    focusFirstField();
  }

  function applyQuickType(key: QuickTypeKey) {
    setQuickTypeKey(key);
    setAmount("");
    setNote("");
    setLiters("");
    setItemValue("");
    setBiltyBreakdown(null);
    setBiltyAmounts({});
    setBiltyPartyChoice({});
    setOfficeAccountId("");

    // Paid From default per category (item 8): Diesel -> Udhaar (the
    // carrier's own default pump party); everything else -> Driver
    // Cash. "Remembered last Paid From per type in the Trip"
    // (localStorage) overrides this once the user has switched it
    // once for this quick-type - Salary has no Paid From at all
    // (always Driver Cash, see postDriverSalaryLine).
    let remembered: PaymentSource | null = null;
    try {
      const stored = window.localStorage.getItem(paidFromStorageKey(tripId, key));
      if (stored === "DRIVER_CASH" || stored === "OFFICE" || stored === "UDHAAR") remembered = stored;
    } catch {
      // per-viewer convenience only
    }
    const defaultSource: PaymentSource = key === "DIESEL" ? "UDHAAR" : "DRIVER_CASH";
    setPaymentSource(remembered || defaultSource);

    if (key === "DIESEL") {
      const pump = carrierDefaults.defaultPumpPartyId || "";
      setPumpPartyId(pump);
      setVendorPartyId(pump);
      setRatePerLiter(pump ? loadRememberedRate(pump) : "");
    } else {
      setPumpPartyId("");
      setVendorPartyId("");
      setRatePerLiter("");
    }

    focusFirstField();
  }

  const resolvedLineType =
    quickType.kind === "COLLECTION" || quickType.kind === "CASH_FROM_OFFICE" || quickType.kind === "DEPOSIT_TO_OFFICE" || quickType.kind === "DRIVER_SALARY"
      ? quickType.kind
      : paymentSource === "DRIVER_CASH"
        ? "EXPENSE_CASH"
        : paymentSource === "OFFICE"
          ? "EXPENSE_OFFICE"
          : "EXPENSE_CREDIT";

  const dateOutOfRange = date && (date < toYMD(tripDateFrom) || (tripDateTo ? date > toYMD(tripDateTo) : false));
  const showBiltyBreakdown = quickType.kind === "COLLECTION" && Boolean(biltyBreakdown && biltyBreakdown.length > 0);
  const biltyBreakdownTotal = round2(
    Object.entries(biltyAmounts).reduce((s, [, v]) => s + (Number(v) || 0), 0)
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Per-Bilty Collection split - one POST per Bilty with a nonzero
    // amount (see PostCollectionInput.biltyId's own doc comment for
    // why this is never a single combined request), never mixed with
    // the plain whole-document path below.
    if (showBiltyBreakdown && biltyBreakdown) {
      const link = documents.find((d) => d.id === itemValue);
      if (!link) {
        setError("Select a document.");
        return;
      }
      const rows = biltyBreakdown
        .map((b) => ({ b, amt: Number(biltyAmounts[b.biltyId]) || 0 }))
        .filter((r) => r.amt > 0);
      if (rows.length === 0) {
        setError("Enter an amount for at least one Bilty.");
        return;
      }
      for (const { b, amt } of rows) {
        if (amt > b.outstanding + 0.009) {
          setError(`Bilty ${b.biltyNo}: amount (Rs. ${formatMoney(amt)}) exceeds its outstanding (Rs. ${formatMoney(b.outstanding)}).`);
          return;
        }
        if (!b.accountId && !biltyPartyChoice[b.biltyId]) {
          setError(`Bilty ${b.biltyNo}: select who this collection belongs to.`);
          return;
        }
      }

      try {
        setSaving(true);
        for (const { b, amt } of rows) {
          const payload: Record<string, unknown> = {
            lineType: "COLLECTION",
            date,
            amount: amt,
            description: note.trim() || undefined,
            documentType: link.documentType,
            documentId: link.documentId,
            biltyId: b.biltyId,
            counterAccountId: b.accountId || biltyPartyChoice[b.biltyId] || undefined,
          };
          const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/lines`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.message || `Unable to save Bilty ${b.biltyNo}'s collection.`);
        }
        onDateUsed(date);
        resetForFreshRow(true);
        onSaved();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to save one or more Bilty collections.");
      } finally {
        setSaving(false);
      }
      return;
    }

    const amt = parseAmountExpression(amount);
    if (!amt || amt <= 0) {
      setError('Amount must be greater than zero (e.g. 20000, "20k", "1.5L", or "500+700+300").');
      return;
    }

    const pumpPartyName = parties.find((p) => p.id === pumpPartyId)?.partyName || "";
    const description = quickTypeKey === "DIESEL" ? buildDieselDescription(pumpPartyName, liters, note) : note.trim() || undefined;
    const payload: Record<string, unknown> = { lineType: resolvedLineType, date, amount: amt, description };
    if (quickTypeKey === "DIESEL") {
      payload.isDiesel = true;
      payload.liters = liters.trim() ? Number(liters) : undefined;
      payload.ratePerLiter = ratePerLiter.trim() ? Number(ratePerLiter) : undefined;
      payload.pumpPartyId = pumpPartyId || undefined;
    }

    if (quickType.kind === "COLLECTION") {
      const link = documents.find((d) => d.id === itemValue);
      if (!link) {
        setError("Select a document.");
        return;
      }
      payload.documentType = link.documentType;
      payload.documentId = link.documentId;
    } else if (quickType.kind === "CASH_FROM_OFFICE" || quickType.kind === "DEPOSIT_TO_OFFICE") {
      if (!itemValue) {
        setError("Select an office account.");
        return;
      }
      payload.officeAccountId = itemValue;
    } else if (quickType.kind === "DRIVER_SALARY") {
      // Driver = carrier's current driver, always (item 9) - no
      // picker shown; a carrier with no current driver set simply
      // can't post Salary until Carrier Settings sets one.
      if (!carrierDefaults.currentDriverId) {
        setError("Set this carrier's current driver first (Carrier Settings).");
        return;
      }
      payload.employeeId = carrierDefaults.currentDriverId;
    } else {
      // EXPENSE - category is the chip itself, never a picker.
      payload.category = quickType.category;
      if (paymentSource === "OFFICE") {
        if (!officeAccountId) {
          setError("Select an office account.");
          return;
        }
        payload.officeAccountId = officeAccountId;
      } else if (paymentSource === "UDHAAR") {
        if (!vendorPartyId) {
          setError("Select a vendor party.");
          return;
        }
        payload.vendorPartyId = vendorPartyId;
      }
    }

    try {
      setSaving(true);
      const url = editingLine
        ? `/api/own-carrier/${carrierId}/trips/${tripId}/lines/${editingLine.id}`
        : `/api/own-carrier/${carrierId}/trips/${tripId}/lines`;
      const res = await fetch(url, {
        method: editingLine ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to save line.");
      onDateUsed(date);
      if (quickType.kind === "EXPENSE" && !editingLine) {
        try {
          window.localStorage.setItem(paidFromStorageKey(tripId, quickTypeKey), paymentSource);
        } catch {
          // per-viewer convenience only
        }
        if (quickTypeKey === "DIESEL" && pumpPartyId) saveRememberedRate(pumpPartyId, ratePerLiter);
      }
      resetForFreshRow(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save line.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-6 rounded-xl border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{editingLine ? `Editing ${LINE_TYPE_LABELS[editingLine.lineType] || editingLine.lineType} line` : "Quick Entry"}</h2>
        {editingLine && (
          <button type="button" onClick={onCancelEdit} className="text-xs text-gray-500 hover:underline">
            Cancel edit
          </button>
        )}
      </div>
      <div className="px-5 pt-3">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => applyQuickType(t.key)}
              disabled={Boolean(editingLine)}
              className={`rounded-full border px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                quickTypeKey === t.key ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="p-5">
        {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-36">
            <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            {dateOutOfRange && <p className="mt-1 text-xs text-amber-600">Outside Trip&apos;s date range</p>}
          </div>

          {quickType.kind === "COLLECTION" && (
            <div className="min-w-[260px] flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">Document</label>
              {sortedDocuments.length === 0 ? (
                <p className="text-xs text-gray-400">No linked documents on this Trip yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {sortedDocuments.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => {
                        setItemValue(d.id);
                        if (d.outstanding != null) setAmount(String(d.outstanding));
                        if (d.documentType === "CHALLAN") {
                          void loadBiltyBreakdown(d.documentId);
                        } else {
                          setBiltyBreakdown(null);
                        }
                        focusFirstField();
                      }}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                        itemValue === d.id ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {d.label}
                      {d.outstanding != null ? ` · ${formatMoney(d.outstanding)}` : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {(quickType.kind === "CASH_FROM_OFFICE" || quickType.kind === "DEPOSIT_TO_OFFICE") && (
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">Office Account</label>
              <select ref={itemRef} value={itemValue} onChange={(e) => setItemValue(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                <option value="">Select account...</option>
                {officeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.accountName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {quickType.kind === "DRIVER_SALARY" && (
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">Driver</label>
              {carrierDefaults.currentDriverName ? (
                <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">{carrierDefaults.currentDriverName}</p>
              ) : (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">No current driver set - set one in Carrier Settings.</p>
              )}
            </div>
          )}

          {quickType.kind === "EXPENSE" && quickTypeKey === "DIESEL" && (
            <>
              <div className="w-40">
                <label className="mb-1 block text-xs font-medium text-gray-600">Pump / Vendor</label>
                <select
                  ref={itemRef}
                  value={pumpPartyId}
                  disabled={Boolean(editingLine)}
                  onChange={(e) => {
                    const newPump = e.target.value;
                    setPumpPartyId(newPump);
                    if (paymentSource === "UDHAAR") setVendorPartyId(newPump);
                    if (newPump) {
                      const rememberedRate = loadRememberedRate(newPump);
                      if (rememberedRate) setRatePerLiter(rememberedRate);
                    }
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
                >
                  <option value="">Select pump/vendor...</option>
                  {pumpParties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.partyName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-20">
                <label className="mb-1 block text-xs font-medium text-gray-600">Liters</label>
                <input
                  type="number"
                  value={liters}
                  onChange={(e) => {
                    const newLiters = e.target.value;
                    setLiters(newLiters);
                    const rate = Number(ratePerLiter);
                    const litersNum = Number(newLiters);
                    if (rate > 0 && litersNum > 0) setAmount(String(round2(rate * litersNum)));
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </div>
              <div className="w-24">
                <label className="mb-1 block text-xs font-medium text-gray-600">Rate/Liter</label>
                <input
                  type="number"
                  value={ratePerLiter}
                  onChange={(e) => {
                    const newRate = e.target.value;
                    setRatePerLiter(newRate);
                    const rate = Number(newRate);
                    const litersNum = Number(liters);
                    if (rate > 0 && litersNum > 0) setAmount(String(round2(rate * litersNum)));
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              </div>
            </>
          )}

          {!showBiltyBreakdown && (
            <div className="w-32">
              <label className="mb-1 block text-xs font-medium text-gray-600">Amount</label>
              <input
                ref={amountRef}
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </div>
          )}

          {quickType.kind === "EXPENSE" && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Paid From
                  {editingLine && <span className="font-normal text-gray-400"> (locked while editing)</span>}
                </label>
                <div className="flex gap-1">
                  {(["DRIVER_CASH", "OFFICE", "UDHAAR"] as PaymentSource[]).map((src) => (
                    <button
                      key={src}
                      type="button"
                      disabled={Boolean(editingLine)}
                      onClick={() => setPaymentSource(src)}
                      className={`rounded-md border px-2.5 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                        paymentSource === src ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {src === "DRIVER_CASH" ? "Driver Cash" : src === "OFFICE" ? "Office" : "Udhaar"}
                    </button>
                  ))}
                </div>
              </div>
              {paymentSource === "OFFICE" && (
                <div className="min-w-[180px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">Office Account</label>
                  <select value={officeAccountId} onChange={(e) => setOfficeAccountId(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                    <option value="">Select account...</option>
                    {officeAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.accountName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {paymentSource === "UDHAAR" && (
                <div className="min-w-[180px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-gray-600">Vendor Party</label>
                  <select value={vendorPartyId} onChange={(e) => setVendorPartyId(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                    <option value="">Select vendor...</option>
                    {vendorParties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partyName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          <div className="min-w-[160px] flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-600">Note</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>

          <button type="submit" disabled={saving} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving..." : editingLine ? "Save Edit" : "Save (Enter)"}
          </button>
        </div>

        {quickType.kind === "COLLECTION" && loadingBiltyBreakdown && (
          <p className="mt-3 text-xs text-gray-400">Loading Bilties...</p>
        )}

        {showBiltyBreakdown && biltyBreakdown && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="mb-2 text-xs font-medium text-gray-600">
              Pick one Bilty or split across Bilties - amount defaults to each Bilty&apos;s own outstanding, editable.
            </p>
            <div className="space-y-1.5">
              {biltyBreakdown.map((b) => (
                <div key={b.biltyId} className="flex flex-wrap items-center gap-2 rounded-md bg-white px-2 py-1.5 text-xs">
                  <span className="w-24 font-medium text-gray-700">Bilty {b.biltyNo}</span>
                  {b.accountId ? (
                    <span className="min-w-[120px] flex-1 text-gray-500">{b.partyName}</span>
                  ) : (
                    <select
                      value={biltyPartyChoice[b.biltyId] || ""}
                      onChange={(e) => setBiltyPartyChoice((prev) => ({ ...prev, [b.biltyId]: e.target.value }))}
                      className="min-w-[140px] flex-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs"
                    >
                      <option value="">Select party...</option>
                      {parties
                        .filter((p) => p.account)
                        .map((p) => (
                          <option key={p.id} value={p.account!.id}>
                            {p.partyName}
                          </option>
                        ))}
                    </select>
                  )}
                  <span className="text-gray-400">outstanding Rs. {formatMoney(b.outstanding)}</span>
                  {b.received > 0 && <span className="text-gray-400">(received Rs. {formatMoney(b.received)})</span>}
                  <input
                    type="number"
                    value={biltyAmounts[b.biltyId] || ""}
                    onChange={(e) => setBiltyAmounts((prev) => ({ ...prev, [b.biltyId]: e.target.value }))}
                    placeholder="0"
                    className="w-28 rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs font-medium text-gray-600">Total: Rs. {formatMoney(biltyBreakdownTotal)}</p>
          </div>
        )}
      </form>
    </div>
  );
}

// ============================================================
// DRAFTS PANEL - "previous slip" expenses copied in as blank-amount
// templates (see getPreviousTripExpenseTemplates in lib/carrier-trip.ts
// and templateToDraft above). Pure client-side state (localStorage)
// until a draft is actually saved - never a JournalEntry, never even
// a server round-trip, until that happens.
// ============================================================
function DraftsPanel({
  drafts,
  draftDate,
  onDateChange,
  onCopyFromPrevious,
  onRemove,
  onUpdate,
  onSave,
}: {
  drafts: DraftRow[];
  draftDate: string;
  onDateChange: (date: string) => void;
  onCopyFromPrevious: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<DraftRow>) => void;
  onSave: (draft: DraftRow, date: string) => Promise<string | null>;
}) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSave(draft: DraftRow, focusNextAmountId?: string) {
    setSavingId(draft.id);
    setErrorId(null);
    const err = await onSave(draft, draftDate);
    setSavingId(null);
    if (err) {
      setErrorId(draft.id);
      setErrorMsg(err);
      return;
    }
    if (focusNextAmountId) {
      window.setTimeout(() => document.getElementById(`draft-amount-${focusNextAmountId}`)?.focus(), 0);
    }
  }

  function itemLabel(d: DraftRow): string {
    // category + description/note only - never an account name (item 11).
    if (d.lineType === "DRIVER_SALARY") return "Salary";
    if (d.lineType === "EXPENSE_CREDIT") return `${categoryLabel(d.category)} (Udhaar - ${d.vendorPartyName || "Vendor"})`;
    if (d.lineType === "EXPENSE_OFFICE") return `${categoryLabel(d.category)} (Office)`;
    return categoryLabel(d.category);
  }

  return (
    <div className="mb-6 rounded-xl border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Drafts (previous Trip&apos;s expenses)</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            Date for saved drafts
            <input type="date" value={draftDate} onChange={(e) => onDateChange(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-blue-500" />
          </label>
          <button type="button" onClick={onCopyFromPrevious} className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50">
            Copy from previous Trip
          </button>
        </div>
      </div>
      {drafts.length === 0 ? (
        <div className="px-5 py-5 text-center text-sm text-gray-500">No drafts. Use &quot;Copy from previous Trip&quot; to bring in last Trip&apos;s recurring expenses.</div>
      ) : (
        <div className="divide-y">
          {drafts.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm">
              <span className="min-w-[160px] flex-1 font-medium text-gray-900">
                {itemLabel(d)}
                {d.isDiesel && d.pumpPartyName && <span className="ml-1 text-xs text-gray-500">({d.pumpPartyName})</span>}
              </span>
              {d.isDiesel && (
                <>
                  <input
                    value={d.liters}
                    onChange={(e) => onUpdate(d.id, { liters: e.target.value })}
                    placeholder="Liters"
                    className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  />
                  <input
                    value={d.ratePerLiter}
                    onChange={(e) => {
                      const rate = Number(e.target.value);
                      const litersNum = Number(d.liters);
                      onUpdate(d.id, { ratePerLiter: e.target.value, ...(rate > 0 && litersNum > 0 ? { amount: String(round2(rate * litersNum)) } : {}) });
                    }}
                    placeholder="Rate/Liter"
                    className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  />
                </>
              )}
              <input
                id={`draft-amount-${d.id}`}
                value={d.amount}
                onChange={(e) => onUpdate(d.id, { amount: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const nextId = drafts[drafts.indexOf(d) + 1]?.id;
                    handleSave(d, nextId);
                  }
                }}
                placeholder="Amount (Enter to save)"
                className="w-40 rounded-md border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-blue-500"
              />
              <button type="button" disabled={savingId === d.id} onClick={() => handleSave(d)} className="rounded-md border border-green-200 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50">
                {savingId === d.id ? "..." : "Save"}
              </button>
              <button type="button" onClick={() => onRemove(d.id)} className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50">
                Remove
              </button>
              {errorId === d.id && <span className="w-full text-xs text-red-600">{errorMsg}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PASTE LIST BOX - bulk entry. "Toll 500", "Khana 1200",
// "Diesel 205L 50000 Attock", "Wasooli 4025 25000" -> an editable
// preview, invalid rows highlighted; nothing posts until Save All.
// ============================================================

type PasteRowKind = "COLLECTION" | "DIESEL" | "EXPENSE" | "SALARY" | "OFFICE_CASH" | "OFFICE_DEPOSIT";

type PasteRow = {
  id: string;
  raw: string;
  kind: PasteRowKind | null;
  documentLabel?: string;
  documentLinkId?: string;
  pump?: string;
  liters?: string;
  amount: string;
  note?: string;
  category?: string;
  error: string | null;
};

// kind=EXPENSE/DIESEL map straight to a category now - no account to
// resolve or guess any more (every expense line debits the SAME
// Carrier Profit account, see lib/carrier-trip.ts's own module
// comment), so unlike before this can never fail to find a match.
const PASTE_KEYWORDS: { re: RegExp; kind: PasteRowKind; category?: string }[] = [
  { re: /^wasooli$/i, kind: "COLLECTION" },
  { re: /^diesel$/i, kind: "DIESEL", category: "DIESEL" },
  { re: /^toll$/i, kind: "EXPENSE", category: "TOLL" },
  { re: /^khana$/i, kind: "EXPENSE", category: "KHANA" },
  { re: /^marammat$/i, kind: "EXPENSE", category: "MARAMMAT" },
  { re: /^(expense|other)$/i, kind: "EXPENSE", category: "OTHER" },
  { re: /^salary$/i, kind: "SALARY" },
  { re: /^officecash$/i, kind: "OFFICE_CASH" },
  { re: /^officejama$/i, kind: "OFFICE_DEPOSIT" },
];

function parsePasteLine(raw: string, documents: DocumentLink[]): PasteRow {
  const base: PasteRow = { id: `paste-${Math.random().toString(36).slice(2)}`, raw, kind: null, amount: "", error: null };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ...base, error: "Empty line" };

  const keyword = PASTE_KEYWORDS.find((k) => k.re.test(tokens[0]));
  if (!keyword) return { ...base, error: `Unrecognized type "${tokens[0]}"` };
  const rest = tokens.slice(1);

  if (keyword.kind === "COLLECTION") {
    // Wasooli <fragment> <amount>
    if (rest.length < 2) return { ...base, kind: "COLLECTION", error: "Expected: Wasooli <document> <amount>" };
    const amountToken = rest[rest.length - 1];
    const amount = parseAmountExpression(amountToken);
    const fragment = rest.slice(0, -1).join(" ");
    const match = documents.find((d) => d.label.toLowerCase().includes(fragment.toLowerCase()));
    if (!match) return { ...base, kind: "COLLECTION", amount: amountToken, error: `No linked document matches "${fragment}"` };
    if (amount == null || amount <= 0) return { ...base, kind: "COLLECTION", documentLabel: match.label, documentLinkId: match.id, error: "Invalid amount" };
    return { ...base, kind: "COLLECTION", documentLabel: match.label, documentLinkId: match.id, amount: amountToken };
  }

  if (keyword.kind === "DIESEL") {
    // Diesel <liters>L <amount> [pump...]
    if (rest.length < 2) return { ...base, kind: "DIESEL", category: keyword.category, error: "Expected: Diesel <liters>L <amount> [pump]" };
    const litersMatch = rest[0].match(/^(\d+(?:\.\d+)?)\s*[lL]?$/);
    if (!litersMatch) return { ...base, kind: "DIESEL", category: keyword.category, error: `Could not read liters from "${rest[0]}"` };
    const amount = parseAmountExpression(rest[1]);
    if (amount == null || amount <= 0) return { ...base, kind: "DIESEL", liters: litersMatch[1], category: keyword.category, error: `Could not read amount from "${rest[1]}"` };
    const pump = rest.slice(2).join(" ");
    return { ...base, kind: "DIESEL", liters: litersMatch[1], amount: rest[1], pump, category: keyword.category, error: null };
  }

  if (keyword.kind === "EXPENSE") {
    // <Keyword> <amount> [note...] - the keyword itself becomes the note/search hint.
    if (rest.length < 1) return { ...base, kind: "EXPENSE", category: keyword.category, error: "Expected an amount" };
    const amount = parseAmountExpression(rest[0]);
    if (amount == null || amount <= 0) return { ...base, kind: "EXPENSE", category: keyword.category, error: `Could not read amount from "${rest[0]}"` };
    const note = [tokens[0], ...rest.slice(1)].join(" ");
    return { ...base, kind: "EXPENSE", amount: rest[0], note, category: keyword.category, error: null };
  }

  if (keyword.kind === "SALARY") {
    // Driver = carrier's current driver (item 9) - only the amount is
    // needed; posting fails cleanly at Save All if no current driver
    // is set, same as Quick Entry's own Salary chip.
    if (rest.length < 1) return { ...base, kind: "SALARY", error: "Expected an amount" };
    const amount = parseAmountExpression(rest[0]);
    const note = rest.slice(1).join(" ");
    return { ...base, kind: "SALARY", amount: rest[0], note, error: amount != null && amount > 0 ? null : `Could not read amount from "${rest[0]}"` };
  }

  if (keyword.kind === "OFFICE_CASH" || keyword.kind === "OFFICE_DEPOSIT") {
    // Needs a specific office account the paste grammar can't safely
    // guess - parsed far enough to show the amount, but always
    // flagged for the user to finish in Quick Entry instead.
    if (rest.length < 1) return { ...base, kind: keyword.kind, error: "Expected an amount" };
    const amount = parseAmountExpression(rest[0]);
    const note = [tokens[0], ...rest.slice(1)].join(" ");
    return { ...base, kind: keyword.kind, amount: rest[0], note, error: amount != null && amount > 0 ? "Use Quick Entry for this type - needs a specific office account" : `Could not read amount from "${rest[0]}"` };
  }

  return { ...base, error: "Unrecognized line" };
}

function PasteListBox({
  carrierId,
  tripId,
  documents,
  defaultDate,
  currentDriverId,
  onSaved,
}: {
  carrierId: string;
  tripId: string;
  documents: DocumentLink[];
  defaultDate: string;
  currentDriverId: string | null;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PasteRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [resultMsg, setResultMsg] = useState("");

  function handlePreview() {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    setPreview(lines.map((l) => parsePasteLine(l, documents)));
    setResultMsg("");
  }

  function updateRow(id: string, patch: Partial<PasteRow>) {
    setPreview((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, ...patch } : r)) : prev));
  }

  function removeRow(id: string) {
    setPreview((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
  }

  async function handleSaveAll() {
    if (!preview) return;
    setSaving(true);
    let saved = 0;
    let failed = 0;
    for (const row of preview) {
      if (row.error || !row.kind || row.kind === "OFFICE_CASH" || row.kind === "OFFICE_DEPOSIT") {
        failed++;
        continue;
      }
      const amount = parseAmountExpression(row.amount);
      if (!amount || amount <= 0) {
        failed++;
        continue;
      }
      const payload: Record<string, unknown> = { date: defaultDate, amount };
      if (row.kind === "COLLECTION") {
        const link = documents.find((d) => d.id === row.documentLinkId);
        if (!link) {
          failed++;
          continue;
        }
        payload.lineType = "COLLECTION";
        payload.documentType = link.documentType;
        payload.documentId = link.documentId;
      } else if (row.kind === "DIESEL") {
        payload.lineType = "EXPENSE_CASH";
        payload.category = row.category;
        payload.description = buildDieselDescription(row.pump || "", row.liters || "", "");
        payload.isDiesel = true;
        if (row.liters) payload.liters = Number(row.liters);
        // Paste-list Diesel never resolves a pumpPartyId (the grammar
        // only captures a free-text pump name, no Party matching) -
        // isDiesel alone is enough for the Diesel box/total to pick it
        // up; pumpPartyId stays null, same as any other informational-
        // only Diesel line with no linked pump Party. Defaults to
        // Driver Cash - edit the row afterward (inline Edit on the
        // Diesel box) if it was actually paid via Office/Udhaar.
      } else if (row.kind === "SALARY") {
        if (!currentDriverId) {
          failed++;
          continue;
        }
        payload.lineType = "DRIVER_SALARY";
        payload.employeeId = currentDriverId;
        payload.description = row.note || undefined;
      } else {
        payload.lineType = "EXPENSE_CASH";
        payload.category = row.category;
        payload.description = row.note || undefined;
      }

      const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.success) saved++;
      else failed++;
    }
    setSaving(false);
    setResultMsg(`Saved ${saved}, skipped ${failed}.`);
    if (saved > 0) onSaved();
  }

  return (
    <div className="p-5">
      <p className="mb-2 text-xs text-gray-500">
        One line each, e.g. <code className="rounded bg-gray-100 px-1">Toll 500</code>, <code className="rounded bg-gray-100 px-1">Khana 1200</code>,{" "}
        <code className="rounded bg-gray-100 px-1">Diesel 205L 50000 Attock</code>, <code className="rounded bg-gray-100 px-1">Wasooli 4025 25000</code>,{" "}
        <code className="rounded bg-gray-100 px-1">Salary 30000</code> (driver = carrier&apos;s current driver). Nothing posts until Save All. Office se cash/jama need Quick Entry (a specific
        office account).
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={"Toll 500\nKhana 1200\nDiesel 205L 50000 Attock\nWasooli 4025 25000"}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
      />
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={handlePreview} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
          Preview
        </button>
      </div>

      {preview && (
        <div className="mt-4 space-y-2">
          {preview.map((row) => (
            <div key={row.id} className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${row.error ? "border-red-300 bg-red-50" : "border-gray-200"}`}>
              <span className="w-24 shrink-0 font-medium text-gray-700">
                {row.kind === "SALARY"
                  ? "Salary"
                  : row.kind === "COLLECTION"
                    ? "Wasooli"
                    : row.kind === "OFFICE_CASH"
                      ? "Office Cash"
                      : row.kind === "OFFICE_DEPOSIT"
                        ? "Office Jama"
                        : row.kind
                          ? categoryLabel(row.category)
                          : "?"}
              </span>
              <span className="min-w-[100px] flex-1 truncate text-gray-600">{row.documentLabel || row.note || row.raw}</span>
              <input
                value={row.amount}
                onChange={(e) => updateRow(row.id, { amount: e.target.value })}
                className="w-28 rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-blue-500"
              />
              {row.error && <span className="w-full text-xs font-medium text-red-600">{row.error}</span>}
              <button type="button" onClick={() => removeRow(row.id)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                Remove
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2">
            {resultMsg && <span className="text-xs text-gray-600">{resultMsg}</span>}
            <button type="button" disabled={saving || preview.length === 0} onClick={handleSaveAll} className="ml-auto rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving..." : "Save All"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// LINK DOCUMENTS DRAWER - search Challan/Phonch/Private Phonch by
// number, multi-select, link in one call.
// ============================================================
function LinkDocumentsDrawer({ carrierId, tripId, onClose, onLinked }: { carrierId: string; tripId: string; onClose: () => void; onLinked: () => void }) {
  const [documentType, setDocumentType] = useState<"CHALLAN" | "PHONCH" | "PRIVATE_PHONCH">("CHALLAN");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<{ id: string; label: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function search_() {
    try {
      setLoading(true);
      setError("");
      const endpoint = documentType === "CHALLAN" ? "/api/challan" : documentType === "PHONCH" ? "/api/phonch" : "/api/private-phonch";
      const res = await fetch(`${endpoint}?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Search failed");
      const numberField = documentType === "CHALLAN" ? "challanNo" : "phonchNo";
      setResults((data.items || []).map((item: Record<string, unknown>) => ({ id: item.id as string, label: `${item[numberField]}` })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleLink() {
    if (selected.size === 0) {
      setError("Select at least one document.");
      return;
    }
    try {
      setSaving(true);
      setError("");
      const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentType, documentIds: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to link document(s).");
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to link document(s).");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open onClose={onClose} title="Link Document">
      <div className="space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Document Type</label>
          <select
            value={documentType}
            onChange={(e) => {
              setDocumentType(e.target.value as typeof documentType);
              setResults([]);
              setSelected(new Set());
            }}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          >
            <option value="CHALLAN">Challan</option>
            <option value="PHONCH">Phonch</option>
            <option value="PRIVATE_PHONCH">Private Phonch</option>
          </select>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search_()}
            placeholder="Search by number..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <button type="button" onClick={search_} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            {loading ? "..." : "Search"}
          </button>
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-500">Search to see results.</div>
          ) : (
            results.map((r) => (
              <label key={r.id} className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-gray-50">
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                {r.label}
              </label>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2 border-t pt-4">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={handleLink} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Linking..." : `Link ${selected.size || ""}`.trim()}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

// ============================================================
// PROFIT REPORT DRAWER
// ============================================================
type ProfitReport = {
  previousBalance: number;
  challanIncome: { documentId: string; label: string; biltyRent: number; carrierRent: number; bookingIncome: number }[];
  otherIncome: { documentType: string; documentId: string; label: string; amount: number }[];
  totalBiltyRent: number;
  totalCarrierRent: number;
  totalBookingIncome: number;
  expenses: { lineId: string; lineType: string; category: string | null; description: string; amount: number; isDiesel: boolean }[];
  totalCarrierExpense: number;
  totalDiesel: number;
  categoryBreakdown: { category: string; amount: number }[];
  ownCarrierProfit: number;
};

function ProfitReportDrawer({ carrierId, tripId, onClose }: { carrierId: string; tripId: string; onClose: () => void }) {
  const [report, setReport] = useState<ProfitReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/report`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || "Unable to load report");
        setReport(data.report);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load report");
      } finally {
        setLoading(false);
      }
    })();
  }, [carrierId, tripId]);

  return (
    <Drawer open onClose={onClose} title="Trip Profit Report (estimate)">
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : error || !report ? (
        <p className="text-sm text-red-700">{error || "Unable to load report"}</p>
      ) : (
        <div className="space-y-5 text-sm">
          <div className="flex justify-between rounded-lg bg-gray-50 px-4 py-3 font-semibold">
            <span>Previous Balance (carried from last closed Trip)</span>
            <span className={report.previousBalance < 0 ? "text-red-700" : undefined}>{formatSignedMoney(report.previousBalance)}</span>
          </div>

          <div>
            <h4 className="mb-2 font-semibold text-gray-700">Challan Income (Own Carrier)</h4>
            {report.challanIncome.length === 0 ? (
              <p className="text-gray-500">No own-carrier Challan linked.</p>
            ) : (
              <div className="space-y-2">
                {report.challanIncome.map((c) => (
                  <div key={c.documentId} className="rounded-md border px-3 py-2">
                    <p className="font-medium text-gray-900">{c.label}</p>
                    <div className="mt-1 grid grid-cols-3 gap-1 text-xs text-gray-600">
                      <span>Bilty Rent: Rs. {formatMoney(c.biltyRent)}</span>
                      <span>Carrier Rent: Rs. {formatMoney(c.carrierRent)}</span>
                      <span>Booking Income: Rs. {formatMoney(c.bookingIncome)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 grid grid-cols-3 gap-1 border-t pt-2 text-xs font-semibold">
              <span>Total Bilty Rent: Rs. {formatMoney(report.totalBiltyRent)}</span>
              <span>Total Carrier Rent: Rs. {formatMoney(report.totalCarrierRent)}</span>
              <span>Total Booking Income: Rs. {formatMoney(report.totalBookingIncome)}</span>
            </div>
          </div>

          {report.otherIncome.length > 0 && (
            <div>
              <h4 className="mb-2 font-semibold text-gray-700">Other Income (Phonch / Private Phonch)</h4>
              <div className="space-y-1">
                {report.otherIncome.map((i) => (
                  <div key={`${i.documentType}-${i.documentId}`} className="flex justify-between">
                    <span className="text-gray-600">{i.label}</span>
                    <span className="font-medium">Rs. {formatMoney(i.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 className="mb-2 font-semibold text-gray-700">Carrier Expense (diesel + expenses + driver salary)</h4>
            {report.expenses.length === 0 ? (
              <p className="text-gray-500">No expenses recorded.</p>
            ) : (
              <div className="space-y-1">
                {report.expenses.map((e) => (
                  <div key={e.lineId} className="flex justify-between">
                    <span className="text-gray-600">
                      <span className="mr-1.5 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">{categoryLabel(e.category)}</span>
                      {e.description}
                    </span>
                    <span className="font-medium">Rs. {formatMoney(e.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            {report.categoryBreakdown.length > 0 && (
              <div className="mt-2 space-y-0.5 border-t pt-2 text-xs text-gray-600">
                {report.categoryBreakdown.map((c) => (
                  <div key={c.category} className="flex justify-between">
                    <span>{categoryLabel(c.category)}</span>
                    <span>Rs. {formatMoney(c.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1 flex justify-between border-t pt-2 font-semibold">
              <span>Total Carrier Expense</span>
              <span>Rs. {formatMoney(report.totalCarrierExpense)}</span>
            </div>
          </div>

          <div className="flex justify-between rounded-lg bg-gray-50 px-4 py-3 text-base font-bold">
            <span>Own Carrier Profit (Carrier Rent - Carrier Expense)</span>
            <span className={report.ownCarrierProfit >= 0 ? "text-green-700" : "text-red-700"}>{formatSignedMoney(report.ownCarrierProfit)}</span>
          </div>
        </div>
      )}
    </Drawer>
  );
}
