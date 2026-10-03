"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import BillForm from "../BillForm";
import { formatBusinessDate } from "@/lib/date-range";

function formatCurrency(value: number, currency: string) {
  return `${currency} ${Math.round(value).toLocaleString()}`;
}

// Same shape lib/pdf-presentation.ts's ResolvedPdfPresentation returns,
// fetched via the /api/settings/presentation read surface (not
// /api/settings/business, which is settings.view-gated) - the Bill
// Detail page's own branding must be visible to anyone who can view
// the Bill itself, matching the same pattern already used by
// app/bilty/[id]/print/page.tsx. A safe, mostly-off default is used if
// the fetch fails - viewing a Bill must never break over a Settings
// problem.
type Presentation = {
  business: {
    businessName: string;
    address: string | null;
    city: string | null;
    province: string | null;
    country: string | null;
    phone1: string | null;
    whatsapp: string | null;
    email: string | null;
    website: string | null;
    mainLogoUrl: string | null;
  };
  header: {
    show: boolean;
    showLogo: boolean;
    showBusinessName: boolean;
    showAddress: boolean;
    showPhone: boolean;
    showWhatsapp: boolean;
    showEmail: boolean;
    showWebsite: boolean;
    alignment: "LEFT" | "CENTER" | "RIGHT";
    subtitle: string | null;
  };
  footer: {
    show: boolean;
    text: string | null;
    showPhone: boolean;
    showAddress: boolean;
    showWebsite: boolean;
    showGeneratedDate: boolean;
    termsAndConditions: string | null;
  };
  invoice: {
    invoiceTitle: string;
    currencyLabel: string;
    paymentInstructions: string | null;
    defaultTermsAndConditions: string | null;
    authorizedByLabel: string;
    signatureLabel: string;
  };
  useLogo: boolean;
};

const FALLBACK_PRESENTATION: Presentation = {
  business: {
    businessName: "Al Naeem Car Carriers Service",
    address: null,
    city: null,
    province: null,
    country: null,
    phone1: null,
    whatsapp: null,
    email: null,
    website: null,
    mainLogoUrl: null,
  },
  header: {
    show: true,
    showLogo: false,
    showBusinessName: true,
    showAddress: false,
    showPhone: false,
    showWhatsapp: false,
    showEmail: false,
    showWebsite: false,
    alignment: "LEFT",
    subtitle: null,
  },
  footer: { show: false, text: null, showPhone: false, showAddress: false, showWebsite: false, showGeneratedDate: false, termsAndConditions: null },
  invoice: {
    invoiceTitle: "BILL",
    currencyLabel: "Rs.",
    paymentInstructions: null,
    defaultTermsAndConditions: null,
    authorizedByLabel: "Authorized Signature",
    signatureLabel: "Signature",
  },
  useLogo: false,
};

type BillItem = {
  id: string;
  lineNo: number;
  vehicleName: string | null;
  fromText: string | null;
  toText: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  regdNumber: string | null;
  rent: string;
  delivery: string;
  otherExpense: string;
  sourceLink: {
    sourceType: "PRIVATE_PHONCH" | "SHOWROOM_PHONCH";
    privatePhonchVehicleId: string | null;
    phonchVehicleId: string | null;
    privatePhonchVehicle: { phonch: { id: string; phonchNo: string } } | null;
    phonchVehicle: { phonch: { id: string; phonchNo: string } } | null;
  } | null;
};

function sourcePhonchRef(item: BillItem): { id: string; phonchNo: string } | null {
  const phonch = item.sourceLink?.privatePhonchVehicle?.phonch || item.sourceLink?.phonchVehicle?.phonch;
  return phonch || null;
}

type BillDetail = {
  id: string;
  billNo: string;
  date: string;
  clientName: string;
  clientPhone: string | null;
  clientPartyId: string | null;
  sourceType: "PRIVATE_PHONCH" | "SHOWROOM_PHONCH" | null;
  isDeleted: boolean;
  items: BillItem[];
  totals: { totalAmount: number };
  totalAmount: number;
  receivedAmount: number;
  remainingDue: number;
  isInconsistent: boolean;
  status: "UNPAID" | "PARTIALLY_PAID" | "PAID";
};

export default function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [capabilities, setCapabilities] = useState({ canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [binning, setBinning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [presentation, setPresentation] = useState<Presentation>(FALLBACK_PRESENTATION);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const res = await fetch(`/api/bill/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load Bill");
      setBill(data.bill);
      setCapabilities(data.capabilities);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Bill");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("edit") === "1") setEditing(true);
  }, []);

  useEffect(() => {
    // Best-effort - a Settings/network problem here must never block
    // viewing the Bill itself, so failures just keep the safe
    // FALLBACK_PRESENTATION already in state. Same source of truth the
    // Bill PDF uses (lib/pdf-presentation.ts's resolvePdfPresentation),
    // reached through the read-only /api/settings/presentation surface
    // since this is a client component.
    fetch("/api/settings/presentation?documentType=BILL")
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && d.presentation) setPresentation(d.presentation);
      })
      .catch(() => {});
  }, []);

  async function handleBin() {
    if (!window.confirm("Move this Bill to Bin?")) return;
    try {
      setBinning(true);
      setError("");
      const res = await fetch(`/api/bill/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to move to Bin");
      setMessage(data.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move to Bin");
    } finally {
      setBinning(false);
    }
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">Loading...</main>;
  }

  if (error && !bill) {
    return (
      <main className="min-h-screen bg-gray-50 p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      </main>
    );
  }

  if (!bill) return null;

  // Edit remains available after a receipt - the backend now validates
  // financial edits per-amount rather than blocking outright (same
  // rule already approved for Private/Showroom Phonch).
  const canEditNow = capabilities.canEdit && !bill.isDeleted;

  if (editing) {
    return (
      <main className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-7xl">
          <div className="mb-6">
            <Link href={`/bill/${id}`} className="text-xs text-gray-500 hover:underline">
              ← Back to Bill
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Edit Bill No. {bill.billNo}</h1>
          </div>
          <BillForm
            mode="edit"
            billId={id}
            initialData={{
              billNo: bill.billNo,
              date: bill.date,
              clientPartyId: bill.clientPartyId,
              clientName: bill.clientName,
              clientPhone: bill.clientPhone,
              sourceType: bill.sourceType,
              items: bill.items.map((i) => ({
                vehicleName: i.vehicleName,
                fromText: i.fromText,
                toText: i.toText,
                engineNumber: i.engineNumber,
                chassisNumber: i.chassisNumber,
                regdNumber: i.regdNumber,
                rent: i.rent,
                delivery: i.delivery,
                otherExpense: i.otherExpense,
                sourceLink: i.sourceLink
                  ? {
                      sourceType: i.sourceLink.sourceType,
                      privatePhonchVehicleId: i.sourceLink.privatePhonchVehicleId,
                      phonchVehicleId: i.sourceLink.phonchVehicleId,
                    }
                  : null,
              })),
            }}
            onSaved={() => {
              setEditing(false);
              void load();
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      </main>
    );
  }

  const statusLabel = bill.status === "PAID" ? "Paid" : bill.status === "PARTIALLY_PAID" ? "Partially Paid" : "Unpaid";
  const statusClass =
    bill.status === "PAID" ? "bg-green-50 text-green-700" : bill.status === "PARTIALLY_PAID" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700";
  const statusNote =
    bill.status === "PAID" ? "Payment received in full" : bill.status === "PARTIALLY_PAID" ? "Payment partially received" : "No payment received yet";
  const currency = presentation.invoice.currencyLabel || "Rs.";
  const addressLine = [presentation.business.address, presentation.business.city, presentation.business.province, presentation.business.country].filter(
    (v): v is string => !!v && v.trim().length > 0
  );
  const contactLine = [
    presentation.header.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
    presentation.header.showWhatsapp && presentation.business.whatsapp ? `WhatsApp: ${presentation.business.whatsapp}` : null,
    presentation.header.showEmail && presentation.business.email ? presentation.business.email : null,
    presentation.header.showWebsite && presentation.business.website ? presentation.business.website : null,
  ].filter((v): v is string => !!v);
  const terms = presentation.invoice.defaultTermsAndConditions || presentation.footer.termsAndConditions;

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link href="/bill" className="text-xs text-gray-500 hover:underline">
              ← Back to Bill Book
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Bill No. {bill.billNo}</h1>
          </div>
          <div className="flex gap-2 print:hidden">
            <a
              href={`/api/bill/${id}/pdf`}
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
            >
              Print / PDF
            </a>
            {canEditNow && (
              <button type="button" onClick={() => setEditing(true)} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
                Edit
              </button>
            )}
            {capabilities.canBin && bill.receivedAmount <= 0.009 && (
              <button
                type="button"
                disabled={binning}
                onClick={() => void handleBin()}
                className="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-700 disabled:opacity-50"
              >
                Move to Bin
              </button>
            )}
          </div>
        </div>

        {(error || message) && (
          <div
            className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
              error ? "border-red-200 bg-red-50 text-red-700" : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {error || message}
          </div>
        )}

        {bill.receivedAmount > 0.009 && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This Bill has recorded Daily Posting receipt(s) and can no longer be moved to Bin.
          </div>
        )}

        {bill.isInconsistent && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Data inconsistency: recorded receipts exceed the Bill Total. Please review Daily Posting entries for this Bill.
          </div>
        )}

        {bill.items.some((i) => i.sourceLink) && (
          <div className="mb-4 rounded-xl border bg-white p-4 shadow-sm text-sm print:hidden">
            <span className="text-xs uppercase text-gray-500">Source</span>
            <div className="mt-1">
              {[
                ...new Map(
                  bill.items.map((i) => sourcePhonchRef(i)).filter((ref): ref is { id: string; phonchNo: string } => !!ref).map((ref) => [ref.id, ref])
                ).values(),
              ].map((ref) => (
                <Link
                  key={ref.id}
                  href={bill.sourceType === "PRIVATE_PHONCH" ? `/private-phonch/${ref.id}` : `/phonch/${ref.id}`}
                  className="mr-2 inline-block rounded border px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 hover:underline"
                >
                  {bill.sourceType === "PRIVATE_PHONCH" ? "Private Phonch" : "Showroom Phonch"} {ref.phonchNo}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* INVOICE DOCUMENT - mirrors the approved invoice prototype's
            visual hierarchy (Header / Client / Items / Financial Summary /
            Payment & Terms / Authorization / Footer), so the ERP view, the
            printed page, and the PDF all read as the same document. Every
            figure below comes directly from the existing GET /api/bill/{id}
            response (bill.totals.totalAmount, bill.receivedAmount,
            bill.remainingDue, bill.status) or the read-only Settings
            presentation endpoint - nothing here is recalculated. */}
        <div className="rounded-xl border bg-white p-6 shadow-sm sm:p-8">
          {presentation.header.show ? (
            <div className="flex flex-col gap-4 border-b-2 border-gray-900 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-center gap-3">
                {presentation.useLogo && presentation.header.showLogo && presentation.business.mainLogoUrl && (
                  <Image
                    src={presentation.business.mainLogoUrl}
                    alt={presentation.business.businessName}
                    width={56}
                    height={56}
                    className="h-14 w-14 object-contain"
                    unoptimized
                  />
                )}
                <div>
                  {presentation.header.showBusinessName && presentation.business.businessName && (
                    <h2 className="text-lg font-bold text-gray-900">{presentation.business.businessName}</h2>
                  )}
                  {presentation.header.subtitle && <p className="mt-0.5 text-xs text-gray-500">{presentation.header.subtitle}</p>}
                  {presentation.header.showAddress && addressLine.length > 0 && (
                    <p className="mt-0.5 text-xs text-gray-500">{addressLine.join(", ")}</p>
                  )}
                  {contactLine.length > 0 && <p className="mt-0.5 text-xs text-gray-500">{contactLine.join("  ·  ")}</p>}
                </div>
              </div>
              <div className="sm:text-right">
                <div className="text-2xl font-extrabold tracking-wide text-gray-900">{presentation.invoice.invoiceTitle || "BILL"}</div>
                <div className="mt-1 text-sm">
                  <span className="font-semibold">Bill No:</span> {bill.billNo}
                </div>
                <div className="mt-0.5 text-xs text-gray-500">{formatBusinessDate(bill.date)}</div>
              </div>
            </div>
          ) : (
            <div className="border-b-2 border-gray-900 pb-4 text-center">
              <div className="text-2xl font-extrabold tracking-wide text-gray-900">{presentation.invoice.invoiceTitle || "BILL"}</div>
              <div className="mt-1 text-sm">
                <span className="font-semibold">Bill No:</span> {bill.billNo} · {formatBusinessDate(bill.date)}
              </div>
            </div>
          )}

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-gray-200 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Bill To</div>
              <div className="mt-1.5 text-base font-semibold text-gray-900">{bill.clientName}</div>
              <div className="mt-1 text-sm text-gray-500">{bill.clientPhone || "—"}</div>
            </div>
            <div className="rounded-lg border border-gray-200 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Payment Status</div>
              <span className={`mt-1.5 inline-block rounded-full px-3 py-1 text-xs font-bold ${statusClass}`}>{statusLabel.toUpperCase()}</span>
              <div className="mt-1.5 text-sm text-gray-500">{statusNote}</div>
            </div>
          </div>

          <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2.5">#</th>
                  <th className="px-3 py-2.5">Vehicle</th>
                  <th className="px-3 py-2.5">From</th>
                  <th className="px-3 py-2.5">To</th>
                  <th className="px-3 py-2.5">Engine</th>
                  <th className="px-3 py-2.5">Chassis</th>
                  <th className="px-3 py-2.5">Regd.</th>
                  <th className="px-3 py-2.5 text-right">Rent</th>
                  <th className="px-3 py-2.5 text-right">Delivery</th>
                  <th className="px-3 py-2.5 text-right">Other</th>
                  <th className="px-3 py-2.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bill.items.map((item) => {
                  const rent = Number(item.rent);
                  const delivery = Number(item.delivery);
                  const otherExpense = Number(item.otherExpense);
                  const total = rent + delivery + otherExpense;
                  return (
                    <tr key={item.id}>
                      <td className="px-3 py-2.5 text-gray-500">{String(item.lineNo).padStart(2, "0")}</td>
                      <td className="px-3 py-2.5 font-medium text-gray-900">{item.vehicleName || "—"}</td>
                      <td className="px-3 py-2.5">{item.fromText || "—"}</td>
                      <td className="px-3 py-2.5">{item.toText || "—"}</td>
                      <td className="px-3 py-2.5">{item.engineNumber || "—"}</td>
                      <td className="px-3 py-2.5">{item.chassisNumber || "—"}</td>
                      <td className="px-3 py-2.5">{item.regdNumber || "—"}</td>
                      <td className="px-3 py-2.5 text-right">{formatCurrency(rent, currency)}</td>
                      <td className="px-3 py-2.5 text-right">{formatCurrency(delivery, currency)}</td>
                      <td className="px-3 py-2.5 text-right">{formatCurrency(otherExpense, currency)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold text-gray-900">{formatCurrency(total, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-6 sm:grid-cols-[1fr_280px]">
            <div className="text-sm">
              {presentation.invoice.paymentInstructions && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Payment Instructions</h3>
                  <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-gray-600">{presentation.invoice.paymentInstructions}</p>
                </div>
              )}
              {terms && (
                <div className={presentation.invoice.paymentInstructions ? "mt-5" : ""}>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Terms &amp; Conditions</h3>
                  <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-gray-600">{terms}</p>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-gray-200 p-4 text-sm">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Invoice Summary</h3>
              <div className="mt-2 flex justify-between py-1">
                <span className="text-gray-600">Bill Total</span>
                <span className="font-medium text-gray-900">{formatCurrency(bill.totals.totalAmount, currency)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-gray-600">Received</span>
                <span className="font-medium text-green-700">{formatCurrency(bill.receivedAmount, currency)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-gray-200 py-1.5">
                <span className={bill.remainingDue > 0 ? "font-semibold text-amber-700" : "font-semibold text-green-700"}>Remaining</span>
                <span className={bill.remainingDue > 0 ? "font-semibold text-amber-700" : "font-semibold text-green-700"}>
                  {formatCurrency(bill.remainingDue, currency)}
                </span>
              </div>
              <div className="mt-1 flex justify-between border-t border-gray-300 pt-2 text-base font-bold text-gray-900">
                <span>Total</span>
                <span>{formatCurrency(bill.totals.totalAmount, currency)}</span>
              </div>
            </div>
          </div>

          <div className="mt-10 grid gap-6 sm:grid-cols-[1fr_220px]">
            <div className="text-xs text-gray-500">
              <div className="font-semibold text-gray-700">{presentation.invoice.authorizedByLabel || "Authorized Signature"}</div>
              {presentation.business.businessName && <div className="mt-0.5">{presentation.business.businessName}</div>}
            </div>
            <div className="text-center text-xs text-gray-500">
              <div className="mb-1.5 border-t border-gray-400" />
              {presentation.invoice.signatureLabel || "Signature"}
            </div>
          </div>

          {presentation.footer.show && (
            <div className="mt-8 space-y-0.5 border-t border-gray-200 pt-3 text-center text-xs text-gray-500">
              {presentation.footer.text && <p>{presentation.footer.text}</p>}
              {(() => {
                const parts = [
                  presentation.footer.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
                  presentation.footer.showAddress && presentation.business.address ? presentation.business.address : null,
                  presentation.footer.showWebsite && presentation.business.website ? presentation.business.website : null,
                ].filter((v): v is string => !!v);
                return parts.length > 0 ? <p>{parts.join("  |  ")}</p> : null;
              })()}
              {presentation.footer.showGeneratedDate && <p>Generated: {new Date().toLocaleString()}</p>}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
