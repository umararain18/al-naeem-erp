"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type CollectedBy = "DRIVER" | "OFFICE";
type Method = "CASH" | "BANK_ONLINE";
type PaymentType = "NAQAD" | "KHATA" | "OFFICE_PAID";
type SlipStatus = "IN_PROGRESS" | "TRIP_COMPLETED" | "RETURNED";

type CollectionRow = { date: string; amount: string; collectedBy: CollectedBy; method: Method; note: string };
type ExpenseRow = { date: string; accountId: string; description: string; amount: string; paymentType: PaymentType; vendorPartyId: string };

type AccountOption = { id: string; accountName: string; accountType: string };
type PartyOption = { id: string; partyName: string; partyTypes: string[] };

function money(n: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function toISODateInput(value: string | null | undefined) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

const emptyCollection = (): CollectionRow => ({ date: todayISO(), amount: "", collectedBy: "DRIVER", method: "CASH", note: "" });
const emptyExpense = (): ExpenseRow => ({ date: todayISO(), accountId: "", description: "", amount: "", paymentType: "NAQAD", vendorPartyId: "" });

export default function CarrierSlipPage({ carrierId, slipId }: { carrierId: string; slipId?: string }) {
  const router = useRouter();
  const isNew = !slipId;
  const [mode, setMode] = useState<"view" | "edit">(isNew ? "edit" : "view");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [carrierNumber, setCarrierNumber] = useState("");
  const [canEdit, setCanEdit] = useState(true);
  const [canBin, setCanBin] = useState(false);

  const [slipNo, setSlipNo] = useState("");
  const [departureDate, setDepartureDate] = useState(todayISO());
  const [returnDate, setReturnDate] = useState("");
  const [route, setRoute] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [status, setStatus] = useState<SlipStatus>("IN_PROGRESS");
  const [notes, setNotes] = useState("");

  const [linkType, setLinkType] = useState<"NONE" | "CHALLAN" | "BILTY">("NONE");
  const [challanNoInput, setChallanNoInput] = useState("");
  const [biltyNoInput, setBiltyNoInput] = useState("");
  const [linkedChallanId, setLinkedChallanId] = useState<string | null>(null);
  const [linkedBiltyId, setLinkedBiltyId] = useState<string | null>(null);
  const [fetchedTotalBiltyRent, setFetchedTotalBiltyRent] = useState<number | null>(null);
  const [fetchedCarrierRent, setFetchedCarrierRent] = useState<number | null>(null);
  const [manualTotalBiltyRent, setManualTotalBiltyRent] = useState("0");
  const [manualCarrierRent, setManualCarrierRent] = useState("0");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const [collections, setCollections] = useState<CollectionRow[]>([emptyCollection()]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([emptyExpense()]);

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [vendors, setVendors] = useState<PartyOption[]>([]);

  const [driverCash, setDriverCash] = useState<{ openingCash: number; driverCashReceived: number; driverPaidCashExpenses: number; closingCash: number } | null>(null);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((j) => j.success && setAccounts(j.accounts.filter((a: AccountOption) => a.accountType === "EXPENSE")));
    fetch("/api/parties")
      .then((r) => r.json())
      .then((j) => j.success && setVendors(j.parties.filter((p: PartyOption) => p.partyTypes?.includes("VENDOR"))));
  }, []);

  useEffect(() => {
    if (isNew) {
      fetch(`/api/carrier-slips/suggest-next-no?carrierId=${carrierId}`)
        .then((r) => r.json())
        .then((j) => j.success && setSlipNo(j.slipNo));
      fetch(`/api/own-carriers/${carrierId}`)
        .then((r) => r.json())
        .then((j) => {
          if (j.success) {
            setCarrierNumber(j.carrier.carrierNumber);
            setDriverName(j.carrier.driverName || "");
            setDriverPhone(j.carrier.driverPhone || "");
          }
        });
      return;
    }

    loadSlip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slipId, isNew, carrierId]);

  async function loadSlip() {
    if (!slipId) return;
    setLoading(true);
    const res = await fetch(`/api/carrier-slips/${slipId}`);
    const j = await res.json();
    if (!j.success) {
      setError(j.message || "Slip not found");
      setLoading(false);
      return;
    }
    const s = j.slip;
    setCarrierNumber(s.carrier.carrierNumber);
    setCanEdit(j.permissions.canEdit);
    setCanBin(j.permissions.canBin);
    setSlipNo(s.slipNo);
    setDepartureDate(toISODateInput(s.departureDate));
    setReturnDate(toISODateInput(s.returnDate));
    setRoute(s.route || "");
    setDriverName(s.driverName || "");
    setDriverPhone(s.driverPhone || "");
    setStatus(s.status);
    setNotes(s.notes || "");
    if (s.linkedChallan) {
      setLinkType("CHALLAN");
      setLinkedChallanId(s.linkedChallan.id);
      setChallanNoInput(s.linkedChallan.challanNo);
    } else if (s.linkedBilty) {
      setLinkType("BILTY");
      setLinkedBiltyId(s.linkedBilty.id);
      setBiltyNoInput(s.linkedBilty.biltyNo);
    } else {
      setLinkType("NONE");
      setManualTotalBiltyRent(String(s.manualTotalBiltyRent ?? 0));
      setManualCarrierRent(String(s.manualCarrierRent ?? 0));
    }
    setFetchedTotalBiltyRent(j.financials.totalBiltyRent);
    setFetchedCarrierRent(j.financials.carrierRent);
    setCollections(
      s.collections.length > 0
        ? s.collections.map((c: { date: string; amount: string; collectedBy: CollectedBy; method: Method; note: string | null }) => ({
            date: toISODateInput(c.date),
            amount: String(c.amount),
            collectedBy: c.collectedBy,
            method: c.method,
            note: c.note || "",
          }))
        : [emptyCollection()]
    );
    setExpenses(
      s.expenses.length > 0
        ? s.expenses.map((e: { date: string; accountId: string; description: string | null; amount: string; paymentType: PaymentType; vendorPartyId: string | null }) => ({
            date: toISODateInput(e.date),
            accountId: e.accountId,
            description: e.description || "",
            amount: String(e.amount),
            paymentType: e.paymentType,
            vendorPartyId: e.vendorPartyId || "",
          }))
        : [emptyExpense()]
    );
    setDriverCash(j.driverCash);
    setLoading(false);
  }

  async function fetchLinkedDocument() {
    setFetchError(null);
    setFetching(true);
    try {
      const params = new URLSearchParams();
      if (linkType === "CHALLAN" && challanNoInput.trim()) params.set("challanNo", challanNoInput.trim());
      if (linkType === "BILTY" && biltyNoInput.trim()) params.set("biltyNo", biltyNoInput.trim());
      if (slipId) params.set("excludeSlipId", slipId);
      if (params.toString() === "") {
        setFetching(false);
        return;
      }
      const res = await fetch(`/api/carrier-slips/fetch-document?${params.toString()}`);
      const json = await res.json();
      if (!json.success) {
        setFetchError(json.message);
        setLinkedChallanId(null);
        setLinkedBiltyId(null);
        setFetchedTotalBiltyRent(null);
        setFetchedCarrierRent(null);
      } else if (json.type === "CHALLAN") {
        setLinkedChallanId(json.challanId);
        setLinkedBiltyId(null);
        setFetchedTotalBiltyRent(json.totalBiltyRent);
        setFetchedCarrierRent(json.carrierRent);
      } else {
        setLinkedBiltyId(json.biltyId);
        setLinkedChallanId(null);
        setFetchedTotalBiltyRent(json.total);
        setFetchedCarrierRent(0);
      }
    } finally {
      setFetching(false);
    }
  }

  const totalBiltyRent = linkType === "NONE" ? Number(manualTotalBiltyRent || 0) : fetchedTotalBiltyRent ?? 0;
  const carrierRent = linkType === "NONE" ? Number(manualCarrierRent || 0) : fetchedCarrierRent ?? 0;
  const officeCommission = totalBiltyRent - carrierRent;
  const totalExpenses = useMemo(() => expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0), [expenses]);
  const carrierProfit = carrierRent - totalExpenses;

  function updateCollection(i: number, patch: Partial<CollectionRow>) {
    setCollections((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function updateExpense(i: number, patch: Partial<ExpenseRow>) {
    setExpenses((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    const payload = {
      carrierId,
      slipNo,
      departureDate,
      returnDate: returnDate || undefined,
      route: route || undefined,
      driverName: driverName || undefined,
      driverPhone: driverPhone || undefined,
      status,
      notes: notes || undefined,
      linkedChallanId: linkType === "CHALLAN" ? linkedChallanId || undefined : "",
      linkedBiltyId: linkType === "BILTY" ? linkedBiltyId || undefined : "",
      manualTotalBiltyRent: linkType === "NONE" ? Number(manualTotalBiltyRent || 0) : undefined,
      manualCarrierRent: linkType === "NONE" ? Number(manualCarrierRent || 0) : undefined,
      collections: collections
        .filter((c) => Number(c.amount) > 0)
        .map((c) => ({ date: c.date, amount: Number(c.amount), collectedBy: c.collectedBy, method: c.method, note: c.note || undefined })),
      expenses: expenses
        .filter((e) => Number(e.amount) > 0 && e.accountId)
        .map((e) => ({
          date: e.date,
          accountId: e.accountId,
          description: e.description || undefined,
          amount: Number(e.amount),
          paymentType: e.paymentType,
          vendorPartyId: e.paymentType === "KHATA" ? e.vendorPartyId || undefined : undefined,
        })),
    };

    const url = isNew ? "/api/carrier-slips" : `/api/carrier-slips/${slipId}`;
    const res = await fetch(url, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    setSaving(false);
    if (!json.success) {
      setError(json.message || "Failed to save slip");
      return;
    }
    if (isNew) {
      router.push(`/own-carrier/${carrierId}/slip/${json.slip.id}`);
    } else {
      setMode("view");
      // Re-fetch from the server rather than trusting the just-submitted
      // local state - Driver Cash/financials are SERVER-derived (see
      // lib/carrier-slip.ts) and must never go stale after a save that
      // changed collections/expenses or the linked document.
      await loadSlip();
    }
  }

  async function handleBin() {
    if (!slipId) return;
    if (!confirm(`Move Slip #${slipNo} to Bin?`)) return;
    const res = await fetch(`/api/carrier-slips/${slipId}`, { method: "DELETE" });
    const json = await res.json();
    if (json.success) router.push(`/own-carrier/${carrierId}`);
    else setError(json.message);
  }

  const readOnly = mode === "view";

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading...</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Trip Slip {isNew ? "" : `#${slipNo}`}
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{carrierNumber}</h1>
        </div>
        <div className="flex gap-2">
          {!isNew && mode === "view" && canEdit && (
            <button type="button" onClick={() => setMode("edit")} className="rounded-md border border-gray-300 px-4 py-2 text-sm">
              Edit
            </button>
          )}
          {!isNew && mode === "view" && canBin && (
            <button type="button" onClick={handleBin} className="rounded-md border border-red-300 text-red-600 px-4 py-2 text-sm">
              Delete
            </button>
          )}
          {mode === "edit" && (
            <button type="button" disabled={saving} onClick={handleSave} className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? "Saving..." : "Save Slip"}
            </button>
          )}
        </div>
      </div>

      {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm p-3">{error}</div>}

      {/* Trip details */}
      <Section title="Trip Details">
        <Grid>
          <Field label="Slip No.">
            <input value={slipNo} onChange={(e) => setSlipNo(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
          </Field>
          <Field label="Departure Date *">
            <input type="date" value={departureDate} onChange={(e) => setDepartureDate(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
          </Field>
          <Field label="Return Date">
            <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
          </Field>
          <Field label="Route">
            <input value={route} onChange={(e) => setRoute(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
          </Field>
          <Field label="Driver">
            <input value={driverName} onChange={(e) => setDriverName(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
          </Field>
          <Field label="Driver Phone">
            <input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
          </Field>
          <Field label="Trip Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as SlipStatus)} disabled={readOnly} className={inputClass(readOnly)}>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="TRIP_COMPLETED">Trip Completed</option>
              <option value="RETURNED">Returned</option>
            </select>
          </Field>
        </Grid>
      </Section>

      {/* Linked document */}
      <Section title="Linked Challan / Bilty">
        {!readOnly && (
          <div className="flex gap-4 mb-3 text-sm">
            {(["NONE", "CHALLAN", "BILTY"] as const).map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input type="radio" checked={linkType === t} onChange={() => setLinkType(t)} />
                {t === "NONE" ? "Standalone (no link)" : t === "CHALLAN" ? "Link Challan" : "Link Bilty"}
              </label>
            ))}
          </div>
        )}
        {linkType === "CHALLAN" && (
          <Grid>
            <Field label="Challan No.">
              <div className="flex gap-2">
                <input value={challanNoInput} onChange={(e) => setChallanNoInput(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} placeholder="e.g. 6423" />
                {!readOnly && (
                  <button type="button" onClick={fetchLinkedDocument} disabled={fetching} className="rounded-md border border-gray-300 px-3 py-2 text-xs whitespace-nowrap">
                    {fetching ? "..." : "Fetch"}
                  </button>
                )}
              </div>
            </Field>
            <Field label="Total Bilty Rent">
              <input readOnly value={fetchedTotalBiltyRent !== null ? money(fetchedTotalBiltyRent) : ""} className={inputClass(true)} />
            </Field>
            <Field label="Carrier Rent">
              <input readOnly value={fetchedCarrierRent !== null ? money(fetchedCarrierRent) : ""} className={inputClass(true)} />
            </Field>
          </Grid>
        )}
        {linkType === "BILTY" && (
          <Grid>
            <Field label="Bilty No.">
              <div className="flex gap-2">
                <input value={biltyNoInput} onChange={(e) => setBiltyNoInput(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} placeholder="e.g. 4084" />
                {!readOnly && (
                  <button type="button" onClick={fetchLinkedDocument} disabled={fetching} className="rounded-md border border-gray-300 px-3 py-2 text-xs whitespace-nowrap">
                    {fetching ? "..." : "Fetch"}
                  </button>
                )}
              </div>
            </Field>
            <Field label="Total Bilty Rent">
              <input readOnly value={fetchedTotalBiltyRent !== null ? money(fetchedTotalBiltyRent) : ""} className={inputClass(true)} />
            </Field>
          </Grid>
        )}
        {linkType === "NONE" && (
          <Grid>
            <Field label="Total Bilty Rent (manual)">
              <input type="number" value={manualTotalBiltyRent} onChange={(e) => setManualTotalBiltyRent(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
            </Field>
            <Field label="Carrier Rent (manual)">
              <input type="number" value={manualCarrierRent} onChange={(e) => setManualCarrierRent(e.target.value)} disabled={readOnly} className={inputClass(readOnly)} />
            </Field>
          </Grid>
        )}
        {fetchError && <div className="mt-2 text-xs text-red-600">{fetchError}</div>}
        <div className="mt-3 text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-md p-2">
          The linked Challan&apos;s Carrier Rent never becomes an external transporter payable. A Challan already assigned to an
          external Transporter cannot be linked here.
        </div>
      </Section>

      {/* Income / Wasooli */}
      <Section
        title="Income / Wasooli"
        action={
          !readOnly && (
            <button type="button" onClick={() => setCollections((r) => [...r, emptyCollection()])} className="text-xs font-semibold text-blue-600">
              + Add collection
            </button>
          )
        }
      >
        <LineTable
          headers={["Date", "Amount", "Collected By", "Method", "Note", ""]}
          rows={collections}
          readOnly={readOnly}
          onRemove={(i) => setCollections((r) => r.filter((_, idx) => idx !== i))}
          renderRow={(row, i) => (
            <>
              <td className="p-2"><input type="date" value={row.date} disabled={readOnly} onChange={(e) => updateCollection(i, { date: e.target.value })} className={cellInput(readOnly)} /></td>
              <td className="p-2"><input type="number" value={row.amount} disabled={readOnly} onChange={(e) => updateCollection(i, { amount: e.target.value })} className={cellInput(readOnly)} /></td>
              <td className="p-2">
                <select value={row.collectedBy} disabled={readOnly} onChange={(e) => updateCollection(i, { collectedBy: e.target.value as CollectedBy })} className={cellInput(readOnly)}>
                  <option value="DRIVER">Driver</option>
                  <option value="OFFICE">Office</option>
                </select>
              </td>
              <td className="p-2">
                <select value={row.method} disabled={readOnly} onChange={(e) => updateCollection(i, { method: e.target.value as Method })} className={cellInput(readOnly)}>
                  <option value="CASH">Cash</option>
                  <option value="BANK_ONLINE">Bank/Online</option>
                </select>
              </td>
              <td className="p-2"><input value={row.note} disabled={readOnly} onChange={(e) => updateCollection(i, { note: e.target.value })} className={cellInput(readOnly)} /></td>
            </>
          )}
        />
      </Section>

      {/* Expenses */}
      <Section
        title="Trip Expenses"
        action={
          !readOnly && (
            <button type="button" onClick={() => setExpenses((r) => [...r, emptyExpense()])} className="text-xs font-semibold text-blue-600">
              + Add expense
            </button>
          )
        }
      >
        <LineTable
          headers={["Date", "Expense Account", "Description", "Amount", "Payment", "Vendor", ""]}
          rows={expenses}
          readOnly={readOnly}
          onRemove={(i) => setExpenses((r) => r.filter((_, idx) => idx !== i))}
          renderRow={(row, i) => (
            <>
              <td className="p-2"><input type="date" value={row.date} disabled={readOnly} onChange={(e) => updateExpense(i, { date: e.target.value })} className={cellInput(readOnly)} /></td>
              <td className="p-2">
                <select value={row.accountId} disabled={readOnly} onChange={(e) => updateExpense(i, { accountId: e.target.value })} className={cellInput(readOnly)}>
                  <option value="">Select account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.accountName}
                    </option>
                  ))}
                </select>
              </td>
              <td className="p-2"><input value={row.description} disabled={readOnly} onChange={(e) => updateExpense(i, { description: e.target.value })} className={cellInput(readOnly)} /></td>
              <td className="p-2"><input type="number" value={row.amount} disabled={readOnly} onChange={(e) => updateExpense(i, { amount: e.target.value })} className={cellInput(readOnly)} /></td>
              <td className="p-2">
                <select value={row.paymentType} disabled={readOnly} onChange={(e) => updateExpense(i, { paymentType: e.target.value as PaymentType })} className={cellInput(readOnly)}>
                  <option value="NAQAD">Naqad (driver cash)</option>
                  <option value="KHATA">Khata (vendor payable)</option>
                  <option value="OFFICE_PAID">Office paid</option>
                </select>
              </td>
              <td className="p-2">
                {row.paymentType === "KHATA" ? (
                  <select value={row.vendorPartyId} disabled={readOnly} onChange={(e) => updateExpense(i, { vendorPartyId: e.target.value })} className={cellInput(readOnly)}>
                    <option value="">Select vendor</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.partyName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
              </td>
            </>
          )}
        />
        <div className="mt-2 text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-md p-2">
          Phase 1: these rows are an operational record only, not yet posted to the ledger (no real JournalEntry/driver-cash
          movement or vendor payable yet) - see the project report for when Phase 2/3 add real postings.
        </div>
      </Section>

      {/* Summary */}
      <Section title="Summary">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <SummaryCard label="ANC Office Commission" value={officeCommission} />
          <SummaryCard label="Total Carrier Expenses" value={totalExpenses} />
          <SummaryCard label="Carrier Rent" value={carrierRent} />
          <SummaryCard label="Carrier Trip Profit" value={carrierProfit} highlight />
        </div>
      </Section>

      {/* Driver cash */}
      <Section title="Driver Cashbook Summary">
        {driverCash ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <SummaryCard label="Opening / Sabqa Peshgi" value={driverCash.openingCash} />
            <SummaryCard label="Driver Cash Received" value={driverCash.driverCashReceived} />
            <SummaryCard label="Driver-Paid Cash Expenses" value={driverCash.driverPaidCashExpenses} />
            <SummaryCard label="Remaining / Closing Driver Cash" value={driverCash.closingCash} highlight />
          </div>
        ) : (
          <div className="text-xs text-gray-500">Driver cash carry-forward will be shown once this slip is saved.</div>
        )}
        <p className="text-xs text-gray-400 mt-2">
          Phase 1: computed from this carrier&apos;s own recorded collections/expenses, not yet from a real ledger balance. Only
          Driver + Cash collections increase this, and only Naqad expenses reduce it - Office/Bank collections and Office-paid/
          Khata expenses never affect it.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}
function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{children}</div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-gray-600">{label}</label>
      {children}
    </div>
  );
}
function inputClass(disabled: boolean) {
  return `rounded-md border border-gray-300 px-3 py-2 text-sm ${disabled ? "bg-gray-50 text-gray-600" : ""}`;
}
function cellInput(disabled: boolean) {
  return `w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs ${disabled ? "bg-gray-50 text-gray-600" : ""}`;
}
function SummaryCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold mt-1 ${highlight ? "text-green-700" : "text-gray-900"}`}>Rs. {money(value)}</div>
    </div>
  );
}
function LineTable<T>({
  headers,
  rows,
  readOnly,
  onRemove,
  renderRow,
}: {
  headers: string[];
  rows: T[];
  readOnly: boolean;
  onRemove: (i: number) => void;
  renderRow: (row: T, i: number) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs min-w-[700px]">
        <thead className="bg-gray-50 text-gray-500 uppercase">
          <tr>
            {headers.map((h) => (
              <th key={h} className="text-left p-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-gray-100">
              {renderRow(row, i)}
              <td className="p-2">
                {!readOnly && (
                  <button type="button" onClick={() => onRemove(i)} className="text-red-500 text-xs">
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
