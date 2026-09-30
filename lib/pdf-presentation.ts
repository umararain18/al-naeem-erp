import type { Prisma, PrismaClient } from "@prisma/client";
import { getBusinessSettings, getDocumentTypeSettings, type SettingsDocumentTypeValue } from "@/lib/business-settings";

// ============================================================
// PDF/PRINT SETTINGS RESOLUTION - Phase 2 of the Central Settings
// integration.
//
// The ONE place every PDF/print generator resolves "what should this
// document's header/footer/branding/page setup look like" from -
// reuses lib/business-settings.ts's own getBusinessSettings()/
// getDocumentTypeSettings() exactly (never a second settings system,
// never a second query for the same data). Every field here is
// STRICTLY presentational - nothing here is read by, or written back
// to, any accounting/JournalEntry/JournalLine code path.
//
// Document type mapping (locked to the existing SettingsDocumentType
// enum - no new value invented):
//   Bill PDF            -> BILL
//   Bilty PDF + print    -> BILTY
//   Challan PDF          -> CHALLAN
//   Party Ledger PDF     -> PARTY_STATEMENT
//   Party Statement PDF  -> PARTY_STATEMENT (same type as Party Ledger
//                           PDF - the enum has one party-facing
//                           document type, not two; both share its
//                           Header/Footer/Logo override)
//   Employee Ledger PDF  -> REPORTS (no dedicated "employee ledger"
//                           enum value exists; REPORTS is the closest
//                           existing generic bucket, documented as a
//                           known limitation rather than inventing a
//                           new enum value)
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type ResolvedPdfPresentation = {
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
    signatureUrl: string | null;
    stampUrl: string | null;
  };
  header: {
    /** Effective, after DocumentTypeSettings.useHeader (INHERIT/ON/OFF) is resolved against the global default. */
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
    showPageNumber: boolean;
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
  pdf: {
    pageSize: "A4" | "A5";
    orientation: "PORTRAIT" | "LANDSCAPE";
    defaultFont: string | null;
    defaultFontSize: number;
    tableBorderStyle: string | null;
    showWatermark: boolean;
    watermarkText: string | null;
    showPageNumber: boolean;
    showGeneratedDate: boolean;
  };
  /** Whether this specific document type's own Logo override (INHERIT/ON/OFF) resolved to shown - separate from header.showLogo, since Logo=OFF must suppress the logo even if the header itself is otherwise shown. */
  useLogo: boolean;
};

export async function resolvePdfPresentation(tx: Tx, documentType: SettingsDocumentTypeValue): Promise<ResolvedPdfPresentation> {
  const settings = await getBusinessSettings(tx);
  const docSettings = await getDocumentTypeSettings(tx, documentType);

  return {
    business: {
      businessName: settings.businessName || "",
      address: settings.address,
      city: settings.city,
      province: settings.province,
      country: settings.country,
      phone1: settings.phone1,
      whatsapp: settings.whatsapp,
      email: settings.email,
      website: settings.website,
      mainLogoUrl: settings.mainLogoUrl,
      signatureUrl: settings.signatureUrl,
      stampUrl: settings.stampUrl,
    },
    header: {
      show: docSettings.useHeader,
      showLogo: settings.headerShowLogo,
      showBusinessName: settings.headerShowBusinessName,
      showAddress: settings.headerShowAddress,
      showPhone: settings.headerShowPhone,
      showWhatsapp: settings.headerShowWhatsapp,
      showEmail: settings.headerShowEmail,
      showWebsite: settings.headerShowWebsite,
      logoPosition: settings.headerLogoPosition,
      alignment: settings.headerAlignment,
      subtitle: settings.headerSubtitle,
    },
    footer: {
      show: docSettings.useFooter,
      text: settings.footerText,
      showPhone: settings.footerShowPhone,
      showAddress: settings.footerShowAddress,
      showWebsite: settings.footerShowWebsite,
      showPageNumber: settings.footerShowPageNumber,
      showGeneratedDate: settings.footerShowGeneratedDate,
      termsAndConditions: settings.termsAndConditions,
    },
    invoice: {
      invoiceTitle: settings.invoiceTitle,
      currencyLabel: settings.currencyLabel,
      paymentInstructions: settings.paymentInstructions,
      defaultTermsAndConditions: settings.defaultTermsAndConditions,
      authorizedByLabel: settings.authorizedByLabel,
      signatureLabel: settings.signatureLabel,
    },
    pdf: {
      pageSize: settings.pdfPageSize,
      orientation: settings.pdfOrientation,
      defaultFont: settings.pdfDefaultFont,
      defaultFontSize: settings.pdfDefaultFontSize,
      tableBorderStyle: settings.pdfTableBorderStyle,
      showWatermark: settings.pdfShowWatermark,
      watermarkText: settings.pdfWatermarkText,
      showPageNumber: settings.pdfShowPageNumber,
      showGeneratedDate: settings.pdfShowGeneratedDate,
    },
    useLogo: docSettings.useLogo,
  };
}
