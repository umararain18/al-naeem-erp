"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

// ============================================================
// Shared client-side Settings-driven Header/Footer for ERP document
// detail pages (Challan / Bilty / Private Phonch / Showroom Phonch) -
// the SAME centralized BusinessSettings/DocumentTypeSettings/
// presentation system already used by the Bill Detail page and the
// Bilty print page, fetched via the existing GET
// /api/settings/presentation read surface (never a second settings
// system, never a second query path). One shared component here -
// instead of four separately hand-rolled copies - is what keeps all
// four documents' header/footer visually identical to each other by
// construction, not by convention.
//
// Bill's own detail page keeps its bespoke two-column invoice-style
// header (approved separately, modeled on the approved invoice
// prototype - Bill is an invoice, these four are not). These four
// documents intentionally share this simpler, centered header/footer
// instead, matching the style already approved for the Bilty print
// page: same logo treatment, business name typography, contact line,
// spacing and footer/date treatment as Bill - only the arrangement
// and the document title differ, since these four must keep their
// existing (approved) layout untouched.
// ============================================================

export type DocumentTypeForPresentation = "BILTY" | "CHALLAN" | "PRIVATE_PHONCH" | "SHOWROOM_PHONCH";

export type DocumentPresentation = {
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

export const FALLBACK_DOCUMENT_PRESENTATION: DocumentPresentation = {
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

/**
 * Fetches this document type's effective presentation (INHERIT/ON/OFF
 * already resolved server-side by resolvePdfPresentation via
 * getDocumentTypeSettings). Best-effort: a Settings/network failure
 * just keeps the safe FALLBACK_DOCUMENT_PRESENTATION already in
 * state - viewing/printing a document must never break over a
 * Settings problem.
 */
export function useDocumentPresentation(documentType: DocumentTypeForPresentation): DocumentPresentation {
  const [presentation, setPresentation] = useState<DocumentPresentation>(FALLBACK_DOCUMENT_PRESENTATION);

  useEffect(() => {
    fetch(`/api/settings/presentation?documentType=${documentType}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && d.presentation) setPresentation(d.presentation);
      })
      .catch(() => {});
  }, [documentType]);

  return presentation;
}

export function DocumentHeader({ presentation, title }: { presentation: DocumentPresentation; title: string }) {
  if (!presentation.header.show) {
    return (
      <div className="mb-3 border-b-2 border-gray-900 pb-2 text-center print:mb-3">
        <p className="text-sm font-bold tracking-wide text-gray-900">{title}</p>
      </div>
    );
  }

  const align = presentation.header.alignment === "LEFT" ? "text-left" : presentation.header.alignment === "RIGHT" ? "text-right" : "text-center";
  const justify =
    presentation.header.alignment === "LEFT" ? "justify-start" : presentation.header.alignment === "RIGHT" ? "justify-end" : "justify-center";

  const addressLine = [presentation.business.address, presentation.business.city, presentation.business.province, presentation.business.country].filter(
    (v): v is string => !!v && v.trim().length > 0
  );
  const contactLine = [
    presentation.header.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
    presentation.header.showWhatsapp && presentation.business.whatsapp ? `WhatsApp: ${presentation.business.whatsapp}` : null,
    presentation.header.showEmail && presentation.business.email ? presentation.business.email : null,
    presentation.header.showWebsite && presentation.business.website ? presentation.business.website : null,
  ].filter((v): v is string => !!v);

  return (
    <div className={`mb-3 border-b-2 border-gray-900 pb-2 ${align}`}>
      <div className={`flex items-center gap-2 ${justify} ${presentation.header.logoPosition === "RIGHT" ? "flex-row-reverse" : ""}`}>
        {presentation.useLogo && presentation.header.showLogo && presentation.business.mainLogoUrl && (
          <Image
            src={presentation.business.mainLogoUrl}
            alt={presentation.business.businessName}
            width={36}
            height={36}
            className="h-9 w-9 object-contain"
            unoptimized
          />
        )}
        <div>
          {presentation.header.showBusinessName && presentation.business.businessName && (
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">{presentation.business.businessName}</h2>
          )}
          {presentation.header.subtitle && <p className="text-xs text-gray-500">{presentation.header.subtitle}</p>}
        </div>
      </div>
      {presentation.header.showAddress && addressLine.length > 0 && <p className="mt-0.5 text-xs text-gray-500">{addressLine.join(", ")}</p>}
      {contactLine.length > 0 && <p className="mt-0.5 text-xs text-gray-500">{contactLine.join("  |  ")}</p>}
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-gray-700">{title}</p>
    </div>
  );
}

export function DocumentFooter({ presentation }: { presentation: DocumentPresentation }) {
  if (!presentation.footer.show) return null;

  const parts = [
    presentation.footer.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
    presentation.footer.showAddress && presentation.business.address ? presentation.business.address : null,
    presentation.footer.showWebsite && presentation.business.website ? presentation.business.website : null,
  ].filter((v): v is string => !!v);

  return (
    <div className="mt-4 space-y-0.5 border-t border-gray-200 pt-2 text-center text-xs text-gray-500">
      {presentation.footer.text && <p>{presentation.footer.text}</p>}
      {parts.length > 0 && <p>{parts.join("  |  ")}</p>}
      {presentation.footer.showGeneratedDate && <p>Generated: {new Date().toLocaleString()}</p>}
    </div>
  );
}
