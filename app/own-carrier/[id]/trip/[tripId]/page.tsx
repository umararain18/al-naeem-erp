"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatBusinessDate } from "@/lib/date-range";

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
  carrier: { id: string; carrierNumber: string; driverName: string | null };
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
  expenseAccountId: string | null;
  officeAccountId: string | null;
  vendorPartyId: string | null;
  employeeId: string | null;
};

type CashBook = { openingBalance: number; rows: CashBookRow[]; closingBalance: number };

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

function isDieselRow(description: string): boolean {
  return description.trim().toLowerCase().startsWith("diesel");
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
  // identified by description ("Diesel - ...", the same prefix the
  // quick-entry row always writes for a Diesel line - see
  // buildDieselDescription below) rather than by lineType, since
  // Diesel can be posted as EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT
  // depending on payment source. "Total OUT (driver cash)" and
  // "Diesel total" are deliberately two independent, non-summing
  // subtotals (a driver-cash-paid Diesel line counts in Diesel total,
  // NOT in Total OUT (driver cash) - it is still correctly reflected
  // in Remaining With Driver via the authoritative closingBalance).
  // ------------------------------------------------------------
  const rows = cashBook?.rows || [];
  const inRows = useMemo(() => rows.filter((r) => r.in > 0), [rows]);
  const dieselRows = useMemo(() => rows.filter((r) => r.out > 0 && isDieselRow(r.description)), [rows]);
  const outRows = useMemo(() => rows.filter((r) => r.out > 0 && !isDieselRow(r.description)), [rows]);
  const totalIn = useMemo(() => round2(inRows.reduce((s, r) => s + r.in, 0)), [inRows]);
  const totalOutDriverCash = useMemo(
    () => round2(outRows.filter((r) => r.lineType === "EXPENSE_CASH" || r.lineType === "DRIVER_SALARY" || r.lineType === "DEPOSIT_TO_OFFICE").reduce((s, r) => s + r.out, 0)),
    [outRows]
  );
  const dieselTotal = useMemo(() => round2(dieselRows.reduce((s, r) => s + r.out, 0)), [dieselRows]);

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
          />
        )}

        {/* SUMMARY BAR */}
        <div className="mb-6 grid grid-cols-2 gap-3 rounded-xl border bg-white p-4 shadow-sm sm:grid-cols-5">
          <SummaryStat label="Previous Balance" value={formatSignedMoney(cashBook?.openingBalance || 0)} negative={(cashBook?.openingBalance || 0) < 0} />
          <SummaryStat label="Total IN" value={`Rs. ${formatMoney(totalIn)}`} className="text-green-700" />
          <SummaryStat label="Total OUT (Driver Cash)" value={`Rs. ${formatMoney(totalOutDriverCash)}`} className="text-red-700" />
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
                    const parsed = parseDieselDescription(row.description);
                    return (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-600">{formatBusinessDate(row.date)}</td>
                        <td className="px-4 py-2 text-gray-900">{parsed.pump || "—"}</td>
                        <td className="px-4 py-2 text-right text-gray-600">{parsed.liters || "—"}</td>
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

/** Reads back the "Diesel - {pump} - {liters}L[ - note]" shape the
 * quick-entry row always writes (see buildDieselDescription) - best-
 * effort only, falls back to blanks for a line whose description was
 * hand-edited away from that shape. */
function parseDieselDescription(description: string): { pump: string; liters: string } {
  const match = description.match(/^Diesel(?:\s*-\s*([^-]+?))?(?:\s*-\s*([\d.]+)\s*L)?(?:\s*-.*)?$/i);
  return { pump: match?.[1]?.trim() || "", liters: match?.[2]?.trim() || "" };
}

function SummaryStat({ label, value, className, negative, bold }: { label: string; value: string; className?: string; negative?: boolean; bold?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`${bold ? "text-lg" : "text-base"} font-semibold ${negative ? "text-red-700" : className || "text-gray-900"}`}>{value}</p>
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
  const [value, setValue] = useState(String(link.carrierRentAmount));
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    return <span className="text-xs text-gray-500">Carrier Rent: Rs. {formatMoney(link.carrierRentAmount)}</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-500">Carrier Rent Rs.</span>
      <input
        type="number"
        min="0"
        step="0.01"
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

const QUICK_TYPES: { key: QuickTypeKey; label: string; kind: QuickKind; defaultCategory?: string; defaultNameMatch?: string }[] = [
  { key: "WASOOLI", label: "Wasooli", kind: "COLLECTION" },
  { key: "DIESEL", label: "Diesel", kind: "EXPENSE", defaultCategory: "FUEL" },
  { key: "TOLL", label: "Toll", kind: "EXPENSE", defaultNameMatch: "toll" },
  { key: "KHANA", label: "Khana", kind: "EXPENSE", defaultCategory: "TEA_REFRESHMENT" },
  { key: "MARAMMAT", label: "Marammat", kind: "EXPENSE", defaultCategory: "REPAIR_MAINTENANCE" },
  { key: "OTHER_EXPENSE", label: "Other expense", kind: "EXPENSE", defaultCategory: "OTHER_EXPENSE" },
  { key: "SALARY", label: "Salary", kind: "DRIVER_SALARY" },
  { key: "OFFICE_CASH", label: "Office se cash", kind: "CASH_FROM_OFFICE" },
  { key: "OFFICE_DEPOSIT", label: "Office mein jama", kind: "DEPOSIT_TO_OFFICE" },
];

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
}) {
  const [quickTypeKey, setQuickTypeKey] = useState<QuickTypeKey>("WASOOLI");
  const [date, setDate] = useState(lastDate || toYMD(tripDateFrom));
  const [itemValue, setItemValue] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("DRIVER_CASH");
  const [officeAccountId, setOfficeAccountId] = useState("");
  const [vendorPartyId, setVendorPartyId] = useState("");
  const [pump, setPump] = useState("");
  const [liters, setLiters] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [parties, setParties] = useState<{ id: string; partyName: string; account: { id: string } | null }[]>([]);
  const [employees, setEmployees] = useState<{ id: string; name: string; employeeCode: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const itemRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    (async () => {
      const [accRes, partyRes, empRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/parties"),
        fetch("/api/employees?status=ACTIVE"),
      ]);
      const accJson = await accRes.json();
      if (accRes.ok && accJson.success !== false) setAccounts(accJson.accounts || []);
      const partyJson = await partyRes.json();
      if (partyRes.ok && partyJson.success) setParties(partyJson.parties || []);
      const empJson = await empRes.json();
      if (empRes.ok && empJson.success) setEmployees(empJson.items || []);
    })();
  }, []);

  const expenseAccounts = useMemo(() => accounts.filter((a) => a.accountType === "EXPENSE"), [accounts]);
  const officeAccounts = useMemo(() => accounts.filter((a) => a.accountType !== "EXPENSE" && a.accountType !== "PARTY"), [accounts]);
  const vendorParties = useMemo(() => parties.filter((p) => p.account), [parties]);

  const quickType = QUICK_TYPES.find((t) => t.key === quickTypeKey)!;

  // Pre-fill the top row from an existing line when "Edit" is clicked
  // on a Cash Book / Diesel row - best-effort reconstruction of which
  // quick-type button produced it (see this module's own
  // parseDieselDescription for the Diesel case); every OTHER field
  // (account/vendor/employee/document id) is read directly off the
  // line's own saved columns, never guessed.
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
      setQuickTypeKey("SALARY");
      setItemValue(editingLine.employeeId || "");
      setNote("");
    } else {
      // EXPENSE_CASH / EXPENSE_OFFICE / EXPENSE_CREDIT
      setPaymentSource(lt === "EXPENSE_OFFICE" ? "OFFICE" : lt === "EXPENSE_CREDIT" ? "UDHAAR" : "DRIVER_CASH");
      setOfficeAccountId(editingLine.officeAccountId || "");
      setVendorPartyId(editingLine.vendorPartyId || "");
      setItemValue(editingLine.expenseAccountId || "");
      if (isDieselRow(editingLine.description)) {
        const parsed = parseDieselDescription(editingLine.description);
        setQuickTypeKey("DIESEL");
        setPump(parsed.pump);
        setLiters(parsed.liters);
        setNote("");
      } else {
        setQuickTypeKey("OTHER_EXPENSE");
        setNote(editingLine.description || "");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLine?.id]);

  function resetForFreshRow(keepType: boolean) {
    setAmount("");
    setNote("");
    setPump("");
    setLiters("");
    if (!keepType) {
      setItemValue("");
      setPaymentSource("DRIVER_CASH");
      setOfficeAccountId("");
      setVendorPartyId("");
    } else {
      // Collection/office/salary Item is document/account-specific per
      // entry - always cleared; expense account + payment source are
      // kept (the common case is several of the same expense in a
      // row), vendor/office sub-pickers cleared with it.
      if (quickType.kind === "COLLECTION" || quickType.kind === "CASH_FROM_OFFICE" || quickType.kind === "DEPOSIT_TO_OFFICE" || quickType.kind === "DRIVER_SALARY") {
        setItemValue("");
      }
    }
    window.setTimeout(() => itemRef.current?.focus(), 0);
  }

  function applyQuickType(key: QuickTypeKey) {
    const type = QUICK_TYPES.find((t) => t.key === key)!;
    setQuickTypeKey(key);
    setAmount("");
    setNote("");
    setPump("");
    setLiters("");
    setVendorPartyId("");
    setOfficeAccountId("");
    setPaymentSource("DRIVER_CASH");
    if (type.kind === "EXPENSE") {
      const match = type.defaultCategory
        ? expenseAccounts.find((a) => a.category === type.defaultCategory)
        : type.defaultNameMatch
          ? expenseAccounts.find((a) => a.accountName.toLowerCase().includes(type.defaultNameMatch!))
          : undefined;
      setItemValue(match?.id || "");
    } else {
      setItemValue("");
    }
    window.setTimeout(() => itemRef.current?.focus(), 0);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Amount must be greater than zero.");
      return;
    }

    const description = quickTypeKey === "DIESEL" ? buildDieselDescription(pump, liters, note) : note.trim() || undefined;
    const payload: Record<string, unknown> = { lineType: resolvedLineType, date, amount: amt, description };

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
      if (!itemValue) {
        setError("Select an employee.");
        return;
      }
      payload.employeeId = itemValue;
    } else {
      // EXPENSE
      if (!itemValue) {
        setError("Select an expense account.");
        return;
      }
      payload.expenseAccountId = itemValue;
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
            <div className="min-w-[220px] flex-1">
              <label className="mb-1 block text-xs font-medium text-gray-600">Document</label>
              <select
                ref={itemRef}
                value={itemValue}
                onChange={(e) => {
                  setItemValue(e.target.value);
                  const link = documents.find((d) => d.id === e.target.value);
                  if (link?.outstanding != null && !amount) setAmount(String(link.outstanding));
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value="">Select document...</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                    {d.outstanding != null ? ` (outstanding Rs. ${formatMoney(d.outstanding)})` : ""}
                  </option>
                ))}
              </select>
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
              <label className="mb-1 block text-xs font-medium text-gray-600">Employee</label>
              <select ref={itemRef} value={itemValue} onChange={(e) => setItemValue(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                <option value="">Select employee...</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.employeeCode})
                  </option>
                ))}
              </select>
            </div>
          )}

          {quickType.kind === "EXPENSE" && (
            <>
              <div className="min-w-[180px] flex-1">
                <label className="mb-1 block text-xs font-medium text-gray-600">Expense Account</label>
                <select ref={itemRef} value={itemValue} onChange={(e) => setItemValue(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                  <option value="">Select account...</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.accountName}
                    </option>
                  ))}
                </select>
              </div>
              {quickTypeKey === "DIESEL" && (
                <>
                  <div className="w-36">
                    <label className="mb-1 block text-xs font-medium text-gray-600">Pump / Vendor</label>
                    <input type="text" value={pump} onChange={(e) => setPump(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                  </div>
                  <div className="w-24">
                    <label className="mb-1 block text-xs font-medium text-gray-600">Liters</label>
                    <input type="number" value={liters} onChange={(e) => setLiters(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                  </div>
                </>
              )}
            </>
          )}

          <div className="w-32">
            <label className="mb-1 block text-xs font-medium text-gray-600">Amount</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>

          {quickType.kind === "EXPENSE" && (
            <>
              <div className="w-44">
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Paid From
                  {editingLine && <span className="font-normal text-gray-400"> (locked while editing)</span>}
                </label>
                <select
                  value={paymentSource}
                  disabled={Boolean(editingLine)}
                  onChange={(e) => setPaymentSource(e.target.value as PaymentSource)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  <option value="DRIVER_CASH">Driver Cash</option>
                  <option value="OFFICE">Office Account</option>
                  <option value="UDHAAR">Udhaar</option>
                </select>
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
      </form>
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
  expenses: { lineId: string; lineType: string; description: string; amount: number }[];
  totalCarrierExpense: number;
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
                    <span className="text-gray-600">{e.description}</span>
                    <span className="font-medium">Rs. {formatMoney(e.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex justify-between border-t pt-2 font-semibold">
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
