"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";

type BiltyStatus = "PENDING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";

type Location = {
  id: string;
  name: string;
};

type Party = {
  id: string;
  partyName: string;
};

type AgentParty = {
  id: string;
  partyName: string;
  account: {
    id: string;
    accountName: string;
    accountCode: string | null;
    accountType: string;
    category: string;
    isActive: boolean;
  } | null;
};

type Creator = {
  id: string;
  fullName: string;
  username: string;
};

type Bilty = {
  id: string;
  biltyNo: string;
  date: string;
  status: BiltyStatus;
  fromLocation: Location;
  toLocation: Location;
  consignorParty: Party | null;
  consignorName: string;
  consignorPhone: string | null;
  consigneeParty: Party | null;
  consigneeName: string;
  consigneePhone: string | null;
  clearingAgentParty: Party | null;
  clearingAgentName: string | null;
  vehicleType: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  registrationNumber: string | null;
  rent: number | null;
  insurance: number | null;
  expense: number | null;
  total: number | null;
  advance: number | null;
  toPay: number | null;
  agentParty: AgentParty | null;
  agentCommission: number | null;
  agentDescription: string | null;
  notes: string | null;
  createdBy: Creator | null;
  createdAt: string;
};

const statusLabels: Record<BiltyStatus, string> = {
  PENDING: "Pending",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

// Same shape lib/pdf-presentation.ts's ResolvedPdfPresentation returns
// - this page uses the /api/settings/presentation read surface (not
// /api/settings/business, which is settings.view-gated) since a
// printed Bilty's own branding must be visible to anyone who can view
// the Bilty itself. See that route's own doc comment. A completely
// safe, all-off default is used if the fetch fails for any reason -
// printing must never break over a Settings problem (Step 9).
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
    logoPosition: "LEFT" | "CENTER" | "RIGHT";
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
    logoPosition: "LEFT",
    alignment: "CENTER",
    subtitle: null,
  },
  footer: { show: false, text: null, showPhone: false, showAddress: false, showWebsite: false, showGeneratedDate: false, termsAndConditions: null },
  useLogo: false,
};

export default function BiltyPrintPage() {
  const params = useParams<{ id: string }>();
  const [bilty, setBilty] = useState<Bilty | null>(null);
  const [presentation, setPresentation] = useState<Presentation>(FALLBACK_PRESENTATION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");

        const response = await fetch(`/api/bilty/${params.id}`);

        const data = await response.json();

        if (!response.ok) {
          setError(data.message || "Unable to load bilty");
          return;
        }

        setBilty(data.bilty);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [params.id]);

  useEffect(() => {
    // Best-effort - a Settings/network problem here must never block
    // printing the Bilty itself, so failures just keep the safe
    // all-off FALLBACK_PRESENTATION already in state.
    fetch("/api/settings/presentation?documentType=BILTY")
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && d.presentation) setPresentation(d.presentation);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!loading && !error && bilty) {
      const timeout = setTimeout(() => {
        window.print();
      }, 300);

      return () => clearTimeout(timeout);
    }
  }, [loading, error, bilty]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-gray-500">Loading bilty...</p>
      </div>
    );
  }

  if (error || !bilty) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error || "Bilty not found"}</p>
          <Link
            href={`/bilty/${params.id}`}
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
          >
            Back to Bilty
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-[210mm] mx-auto p-8">
        {/* Header - Settings-driven (Phase 2 Central Settings
            integration). If the document-type Header override
            resolved OFF, only the title itself still renders - never
            nothing at all. */}
        {presentation.header.show ? (
          <div
            className={`border-b-2 border-black pb-4 mb-6 ${
              presentation.header.alignment === "LEFT" ? "text-left" : presentation.header.alignment === "RIGHT" ? "text-right" : "text-center"
            }`}
          >
            <div
              className={`flex items-center gap-3 ${
                presentation.header.alignment === "LEFT"
                  ? "justify-start"
                  : presentation.header.alignment === "RIGHT"
                  ? "justify-end"
                  : "justify-center"
              } ${presentation.header.logoPosition === "RIGHT" ? "flex-row-reverse" : ""}`}
            >
              {presentation.useLogo && presentation.header.showLogo && presentation.business.mainLogoUrl && (
                <Image
                  src={presentation.business.mainLogoUrl}
                  alt={presentation.business.businessName}
                  width={48}
                  height={48}
                  className="h-12 w-12 object-contain"
                  unoptimized
                />
              )}
              <div>
                {presentation.header.showBusinessName && presentation.business.businessName && (
                  <h1 className="text-2xl font-bold uppercase tracking-wide">{presentation.business.businessName}</h1>
                )}
                {presentation.header.subtitle && <p className="text-sm text-gray-600">{presentation.header.subtitle}</p>}
              </div>
            </div>
            {presentation.header.showAddress &&
              [presentation.business.address, presentation.business.city, presentation.business.province, presentation.business.country]
                .filter((v): v is string => !!v && v.trim().length > 0).length > 0 && (
                <p className="text-xs text-gray-600 mt-1">
                  {[presentation.business.address, presentation.business.city, presentation.business.province, presentation.business.country]
                    .filter((v): v is string => !!v && v.trim().length > 0)
                    .join(", ")}
                </p>
              )}
            {(() => {
              const contact = [
                presentation.header.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
                presentation.header.showWhatsapp && presentation.business.whatsapp ? `WhatsApp: ${presentation.business.whatsapp}` : null,
                presentation.header.showEmail && presentation.business.email ? presentation.business.email : null,
                presentation.header.showWebsite && presentation.business.website ? presentation.business.website : null,
              ].filter((v): v is string => !!v);
              return contact.length > 0 ? <p className="text-xs text-gray-600 mt-0.5">{contact.join("  |  ")}</p> : null;
            })()}
            <p className="text-lg font-semibold mt-1">BILTY</p>
          </div>
        ) : (
          <div className="text-center pb-4 mb-6">
            <p className="text-lg font-semibold">BILTY</p>
          </div>
        )}

        <div className="flex justify-between items-start mb-6">
          <div>
            <p className="text-sm font-semibold">Bilty No:</p>
            <p className="text-base font-bold">{bilty.biltyNo}</p>
          </div>

          <div className="text-right">
            <p className="text-sm font-semibold">Date:</p>
            <p className="text-base">{new Date(bilty.date).toLocaleDateString()}</p>
          </div>

          <div className="text-right">
            <p className="text-sm font-semibold">Status:</p>
            <p className="text-base font-semibold">{statusLabels[bilty.status]}</p>
          </div>
        </div>

        {/* Route */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold text-center mb-2">Route</p>
          <p className="text-xl font-bold text-center">
            {bilty.fromLocation.name} <span className="mx-3">→</span> {bilty.toLocation.name}
          </p>
        </div>

        {/* Consignor / Consignee */}

        <div className="grid grid-cols-2 gap-6 mb-6">
          <div className="border border-black rounded-lg p-4">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Consignor</p>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-xs text-gray-600">Party:</p>
                <p className="font-medium">{bilty.consignorParty?.partyName || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Name:</p>
                <p className="font-medium">{bilty.consignorName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Phone:</p>
                <p className="font-medium">{bilty.consignorPhone || "-"}</p>
              </div>
            </div>
          </div>

          <div className="border border-black rounded-lg p-4">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Consignee</p>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-xs text-gray-600">Party:</p>
                <p className="font-medium">{bilty.consigneeParty?.partyName || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Name:</p>
                <p className="font-medium">{bilty.consigneeName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Phone:</p>
                <p className="font-medium">{bilty.consigneePhone || "-"}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Clearing Agent */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Clearing Agent / Delivery Point</p>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-600">Name:</p>
              <p className="font-medium">{bilty.clearingAgentName || "-"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Party:</p>
              <p className="font-medium">{bilty.clearingAgentParty?.partyName || "-"}</p>
            </div>
          </div>
        </div>

        {/* Vehicle Details */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Vehicle Details</p>
          <div className="grid grid-cols-2 gap-4 text-sm">
            {bilty.vehicleType && (
              <div>
                <p className="text-xs text-gray-600">Type:</p>
                <p className="font-medium">{bilty.vehicleType}</p>
              </div>
            )}
            {bilty.vehicleModel && (
              <div>
                <p className="text-xs text-gray-600">Model:</p>
                <p className="font-medium">{bilty.vehicleModel}</p>
              </div>
            )}
            {bilty.vehicleColor && (
              <div>
                <p className="text-xs text-gray-600">Color:</p>
                <p className="font-medium">{bilty.vehicleColor}</p>
              </div>
            )}
            {bilty.registrationNumber && (
              <div>
                <p className="text-xs text-gray-600">Registration Number:</p>
                <p className="font-medium">{bilty.registrationNumber}</p>
              </div>
            )}
            {bilty.engineNumber && (
              <div>
                <p className="text-xs text-gray-600">Engine Number:</p>
                <p className="font-medium">{bilty.engineNumber}</p>
              </div>
            )}
            {bilty.chassisNumber && (
              <div>
                <p className="text-xs text-gray-600">Chassis Number:</p>
                <p className="font-medium">{bilty.chassisNumber}</p>
              </div>
            )}
            {!bilty.vehicleType &&
              !bilty.vehicleModel &&
              !bilty.vehicleColor &&
              !bilty.registrationNumber &&
              !bilty.engineNumber &&
              !bilty.chassisNumber && (
                <p className="text-sm text-gray-500 col-span-2">No vehicle details provided.</p>
              )}
          </div>
        </div>

        {/* Financial Summary */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Financial Summary</p>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Rent</span>
              <span>Rs. {Number(bilty.rent || 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Insurance</span>
              <span>Rs. {Number(bilty.insurance || 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Expense</span>
              <span>Rs. {Number(bilty.expense || 0).toLocaleString()}</span>
            </div>
            <div className="border-t border-black pt-1 flex justify-between font-semibold">
              <span>Total</span>
              <span>Rs. {Number(bilty.total || 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Advance</span>
              <span>Rs. {Number(bilty.advance || 0).toLocaleString()}</span>
            </div>
            <div className="border-t-2 border-black pt-1 flex justify-between font-bold text-lg">
              <span>To Pay</span>
              <span>Rs. {Number(bilty.toPay || 0).toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Commission / Referral */}

        {(bilty.agentParty || (bilty.agentCommission ?? 0) > 0 || bilty.agentDescription) && (
          <div className="border border-black rounded-lg p-4 mb-6">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Commission / Referral</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Agent / Referral Party</span>
                <span>{bilty.agentParty?.partyName || "-"}</span>
              </div>
              {bilty.agentParty?.account && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Account</span>
                  <span>{bilty.agentParty.account.accountName} ({bilty.agentParty.account.accountCode || "N/A"})</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">Commission</span>
                <span>Rs. {Number(bilty.agentCommission || 0).toLocaleString()}</span>
              </div>
              {bilty.agentDescription && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Description</span>
                  <span>{bilty.agentDescription}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Notes */}

        {bilty.notes && (
          <div className="border border-black rounded-lg p-4 mb-6">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-2">Notes</p>
            <p className="text-sm whitespace-pre-line">{bilty.notes}</p>
          </div>
        )}

        {/* Signatures */}

        <div className="grid grid-cols-3 gap-6 mt-12 mb-8">
          <div className="border-t border-black pt-2 text-center">
            <p className="text-sm font-medium">Received By</p>
          </div>
          <div className="border-t border-black pt-2 text-center">
            <p className="text-sm font-medium">Driver Signature</p>
          </div>
          <div className="border-t border-black pt-2 text-center">
            <p className="text-sm font-medium">Authorized Signature</p>
          </div>
        </div>

        {/* Footer - Settings-driven, only when this document type's
            own Footer override resolved ON. */}
        {presentation.footer.show && (
          <div className="border-t border-gray-300 pt-3 mb-6 text-center text-xs text-gray-600 space-y-0.5">
            {presentation.footer.text && <p>{presentation.footer.text}</p>}
            {(() => {
              const parts = [
                presentation.footer.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
                presentation.footer.showAddress && presentation.business.address ? presentation.business.address : null,
                presentation.footer.showWebsite && presentation.business.website ? presentation.business.website : null,
              ].filter((v): v is string => !!v);
              return parts.length > 0 ? <p>{parts.join("  |  ")}</p> : null;
            })()}
            {presentation.footer.termsAndConditions && <p className="whitespace-pre-line">{presentation.footer.termsAndConditions}</p>}
            {presentation.footer.showGeneratedDate && <p>Generated: {new Date().toLocaleString()}</p>}
          </div>
        )}

        {/* Actions */}

        <div className="flex justify-between items-center pt-6 border-t border-gray-200">
          <Link
            href={`/bilty/${params.id}`}
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
          >
            Back to Bilty
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="bg-black text-white rounded-lg px-4 py-2 text-sm hover:bg-gray-800"
          >
            Print Again
          </button>
        </div>
      </div>
    </div>
  );
}
