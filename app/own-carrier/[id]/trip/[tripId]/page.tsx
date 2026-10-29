"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatBusinessDate } from "@/lib/date-range";
import { SearchableSelect } from "@/app/daily-posting/SearchableSelect";

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
}

function todayYMD(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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
};

type CashBook = { openingBalance: number; rows: CashBookRow[]; closingBalance: number };

// Keyed by the REAL posted CarrierTripLineType (used for the Cash
// Book's own reversal-confirm text) - "Expense"/"Diesel" are UI-only
// groupings over EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT, chosen by
// LineDrawer's own "Payment Source" selector (see that component).
const LINE_TYPE_LABELS: Record<string, string> = {
  COLLECTION: "Collection (against Challan/Phonch/Private Phonch)",
  CASH_FROM_OFFICE: "Office gives cash to Driver",
  EXPENSE_CASH: "Expense (Driver Cash)",
  EXPENSE_OFFICE: "Expense (Office Account)",
  EXPENSE_CREDIT: "Expense (Udhaar/credit to Vendor)",
  DRIVER_SALARY: "Driver Salary",
  DEPOSIT_TO_OFFICE: "Driver deposits cash to Office",
};

// The 6 action buttons shown on an OPEN Trip. "EXPENSE"/"DIESEL" are
// NOT real CarrierTripLineType values - LineDrawer resolves each to
// EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT itself, from its own
// Payment Source selector, exactly like Diesel's own spec ("Add line
// type EXPENSE_OFFICE ... usable for diesel and any expense").
const ACTION_BUTTONS: { kind: string; label: string }[] = [
  { kind: "COLLECTION", label: LINE_TYPE_LABELS.COLLECTION },
  { kind: "CASH_FROM_OFFICE", label: LINE_TYPE_LABELS.CASH_FROM_OFFICE },
  { kind: "EXPENSE", label: "Expense (Driver Cash / Office / Udhaar)" },
  { kind: "DIESEL", label: "Diesel" },
  { kind: "DRIVER_SALARY", label: LINE_TYPE_LABELS.DRIVER_SALARY },
  { kind: "DEPOSIT_TO_OFFICE", label: LINE_TYPE_LABELS.DEPOSIT_TO_OFFICE },
];

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
  const [lineDrawerType, setLineDrawerType] = useState<string | null>(null);
  const [linkDocsOpen, setLinkDocsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

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
                  <span className="font-medium text-gray-900">{d.label}</span>
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

        {/* ACTIONS */}
        {canAct && (
          <div className="mb-6 flex flex-wrap gap-2">
            {ACTION_BUTTONS.map(({ kind, label }) => (
              <button key={kind} type="button" onClick={() => setLineDrawerType(kind)} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
                + {label}
              </button>
            ))}
          </div>
        )}

        {/* CASH BOOK */}
        <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="border-b px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Cash Book</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3 text-right">In</th>
                  <th className="px-4 py-3 text-right">Out</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                  {canAct && <th className="px-4 py-3">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr className="bg-gray-50">
                  <td className="px-4 py-2 text-gray-500" colSpan={canAct ? 4 : 4}>
                    Opening Balance
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-gray-900">Rs. {formatMoney(cashBook?.openingBalance || 0)}</td>
                  {canAct && <td />}
                </tr>
                {(cashBook?.rows || []).map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600">{formatBusinessDate(row.date)}</td>
                    <td className="px-4 py-3 text-gray-900">{row.description}</td>
                    <td className="px-4 py-3 text-right text-green-700">{row.in > 0 ? `Rs. ${formatMoney(row.in)}` : "—"}</td>
                    <td className="px-4 py-3 text-right text-red-700">{row.out > 0 ? `Rs. ${formatMoney(row.out)}` : "—"}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">Rs. {formatMoney(row.balance)}</td>
                    {canAct && (
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => handleReverseLine(row)} className="rounded-md border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50">
                          Reverse
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {(!cashBook || cashBook.rows.length === 0) && (
                  <tr>
                    <td colSpan={canAct ? 6 : 5} className="px-4 py-8 text-center text-sm text-gray-500">
                      No transactions yet.
                    </td>
                  </tr>
                )}
                <tr className="bg-gray-50">
                  <td className="px-4 py-2 font-semibold text-gray-900" colSpan={canAct ? 4 : 4}>
                    Closing Balance
                  </td>
                  <td className="px-4 py-2 text-right font-bold text-gray-900">Rs. {formatMoney(cashBook?.closingBalance || 0)}</td>
                  {canAct && <td />}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {lineDrawerType && (
        <LineDrawer
          carrierId={carrierId}
          tripId={tripId}
          kind={lineDrawerType}
          documents={documents}
          onClose={() => setLineDrawerType(null)}
          onSaved={() => {
            setLineDrawerType(null);
            refresh();
          }}
        />
      )}

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

// ============================================================
// LINE DRAWER - one form per lineType, Decision table from the plan.
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

// "Payment Source" for an EXPENSE/DIESEL line - resolves to the real
// CarrierTripLineType posted (see this module's own ACTION_BUTTONS
// doc comment).
type PaymentSource = "DRIVER_CASH" | "OFFICE" | "UDHAAR";

function LineDrawer({
  carrierId,
  tripId,
  kind,
  documents,
  onClose,
  onSaved,
}: {
  carrierId: string;
  tripId: string;
  kind: string;
  documents: DocumentLink[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isExpenseKind = kind === "EXPENSE" || kind === "DIESEL";

  const [date, setDate] = useState(todayYMD());
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [documentLinkId, setDocumentLinkId] = useState("");
  const [officeAccountId, setOfficeAccountId] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [vendorPartyId, setVendorPartyId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [paymentSource, setPaymentSource] = useState<PaymentSource>("DRIVER_CASH");
  const [pump, setPump] = useState("");
  const [liters, setLiters] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [parties, setParties] = useState<{ id: string; partyName: string; account: { id: string } | null }[]>([]);
  const [employees, setEmployees] = useState<{ id: string; name: string; employeeCode: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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

  const officeAccountOptions = useMemo(
    () => accounts.filter((a) => a.accountType !== "EXPENSE" && a.accountType !== "PARTY").map((a) => ({ value: a.id, label: a.accountName, secondary: a.category })),
    [accounts]
  );
  const expenseAccountOptions = useMemo(
    () => accounts.filter((a) => a.accountType === "EXPENSE").map((a) => ({ value: a.id, label: a.accountName, secondary: a.category })),
    [accounts]
  );
  const vendorPartyOptions = useMemo(
    () => parties.filter((p) => p.account).map((p) => ({ value: p.id, label: p.partyName })),
    [parties]
  );
  const employeeOptions = useMemo(() => employees.map((e) => ({ value: e.id, label: e.name, secondary: e.employeeCode })), [employees]);

  // The REAL CarrierTripLineType this drawer will post.
  const resolvedLineType =
    kind === "COLLECTION" || kind === "CASH_FROM_OFFICE" || kind === "DEPOSIT_TO_OFFICE" || kind === "DRIVER_SALARY"
      ? kind
      : paymentSource === "DRIVER_CASH"
        ? "EXPENSE_CASH"
        : paymentSource === "OFFICE"
          ? "EXPENSE_OFFICE"
          : "EXPENSE_CREDIT";

  const title = kind === "EXPENSE" ? "Expense" : kind === "DIESEL" ? "Diesel" : LINE_TYPE_LABELS[kind] || kind;

  async function handleSave() {
    setError("");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Amount must be greater than zero.");
      return;
    }

    let description_ = description.trim();
    if (kind === "DIESEL" && !description_) {
      description_ = ["Diesel", pump.trim() || null, liters.trim() ? `${liters.trim()}L` : null].filter(Boolean).join(" - ");
    }

    const payload: Record<string, unknown> = { lineType: resolvedLineType, date, amount: amt, description: description_ || undefined };

    if (kind === "COLLECTION") {
      const link = documents.find((d) => d.id === documentLinkId);
      if (!link) {
        setError("Select a linked document.");
        return;
      }
      payload.documentType = link.documentType;
      payload.documentId = link.documentId;
    } else if (kind === "CASH_FROM_OFFICE" || kind === "DEPOSIT_TO_OFFICE") {
      if (!officeAccountId) {
        setError("Select an office account.");
        return;
      }
      payload.officeAccountId = officeAccountId;
    } else if (isExpenseKind) {
      if (!expenseAccountId) {
        setError("Select an expense account.");
        return;
      }
      payload.expenseAccountId = expenseAccountId;
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
    } else if (kind === "DRIVER_SALARY") {
      if (!employeeId) {
        setError("Select an employee.");
        return;
      }
      payload.employeeId = employeeId;
    }

    try {
      setSaving(true);
      const res = await fetch(`/api/own-carrier/${carrierId}/trips/${tripId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to post line.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to post line.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open onClose={onClose} title={title}>
      <div className="space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Amount *</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
        </div>

        {kind === "COLLECTION" && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Linked Document *</label>
            <select value={documentLinkId} onChange={(e) => setDocumentLinkId(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
              <option value="">Select document...</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {(kind === "CASH_FROM_OFFICE" || kind === "DEPOSIT_TO_OFFICE") && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Office Account *</label>
            <SearchableSelect value={officeAccountId} options={officeAccountOptions} placeholder="Select office account..." onChange={setOfficeAccountId} />
          </div>
        )}

        {isExpenseKind && (
          <>
            {kind === "DIESEL" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Pump / Vendor</label>
                  <input type="text" value={pump} onChange={(e) => setPump(e.target.value)} placeholder="e.g. Attock" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Liters</label>
                  <input type="number" value={liters} onChange={(e) => setLiters(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                </div>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Expense Account *</label>
              <SearchableSelect value={expenseAccountId} options={expenseAccountOptions} placeholder="Select expense account..." onChange={setExpenseAccountId} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Payment Source *</label>
              <select
                value={paymentSource}
                onChange={(e) => setPaymentSource(e.target.value as PaymentSource)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value="DRIVER_CASH">Driver Cash</option>
                <option value="OFFICE">Office Account (Cash/Bank)</option>
                <option value="UDHAAR">Udhaar (Vendor Payable)</option>
              </select>
            </div>
            {paymentSource === "OFFICE" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Office Account *</label>
                <SearchableSelect value={officeAccountId} options={officeAccountOptions} placeholder="Select office account..." onChange={setOfficeAccountId} />
              </div>
            )}
            {paymentSource === "UDHAAR" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Vendor Party *</label>
                <SearchableSelect value={vendorPartyId} options={vendorPartyOptions} placeholder="Select vendor party..." onChange={setVendorPartyId} />
              </div>
            )}
          </>
        )}

        {kind === "DRIVER_SALARY" && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Employee *</label>
            <SearchableSelect value={employeeId} options={employeeOptions} placeholder="Select employee..." onChange={setEmployeeId} />
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Description</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={handleSave} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Posting..." : "Post"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

// ============================================================
// LINK DOCUMENTS DRAWER - search Challan/Phonch/Private Phonch by
// number, multi-select, link in one call (Decision 3).
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
            <span>Rs. {formatMoney(report.previousBalance)}</span>
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
            <span className={report.ownCarrierProfit >= 0 ? "text-green-700" : "text-red-700"}>Rs. {formatMoney(report.ownCarrierProfit)}</span>
          </div>
        </div>
      )}
    </Drawer>
  );
}
