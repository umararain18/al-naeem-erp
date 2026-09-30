import { jsPDF } from "jspdf";
import { readFile } from "fs/promises";
import path from "path";
import type { ResolvedPdfPresentation } from "@/lib/pdf-presentation";

// ============================================================
// SHARED jsPDF RENDERING HELPERS - Phase 2 of the Central Settings
// integration.
//
// The ONE place every jsPDF-based generator (Bill/Bilty/Challan/Party
// Ledger/Party Statement/Employee Ledger PDFs) draws its Settings-
// driven header/footer/watermark from - so a future Settings change
// only needs testing against these functions once, not against six
// separately hand-rolled header blocks. Deliberately NOT applied to
// app/bilty/[id]/print/page.tsx, which renders HTML/React and uses its
// own small settings-driven header/footer block instead (see that
// file) - forcing a completely different rendering technology through
// this same jsPDF-specific module would be exactly the "unnecessary
// renderer abstraction" the task asked to avoid.
//
// Every function here is presentation-only. None of them read or
// write JournalEntry/JournalLine/Bilty/Challan/Bill/accounting data -
// callers pass in already-computed document data; these functions
// only decide how the page LOOKS.
// ============================================================

const JSPDF_BUILTIN_FONTS = new Set(["helvetica", "times", "courier"]);
const AUTOTABLE_THEMES = new Set(["striped", "grid", "plain"]);

/** Falls back to "helvetica" (jsPDF's own default) for anything not one of jsPDF's 14 standard fonts - never a crash from an unsupported font name a user typed into Settings. */
export function resolveJsPdfFont(fontName: string | null): "helvetica" | "times" | "courier" {
  const normalized = (fontname => fontname?.toLowerCase().trim())(fontName);
  if (normalized && JSPDF_BUILTIN_FONTS.has(normalized)) return normalized as "helvetica" | "times" | "courier";
  return "helvetica";
}

/** Falls back to "grid" (the existing look every current PDF already uses) for anything not one of jspdf-autotable's three built-in themes. */
export function resolveAutoTableTheme(borderStyle: string | null): "striped" | "grid" | "plain" {
  const normalized = borderStyle?.toLowerCase().trim();
  if (normalized && AUTOTABLE_THEMES.has(normalized)) return normalized as "striped" | "grid" | "plain";
  return "grid";
}

/**
 * Constructs the jsPDF document itself, respecting Page Size (A4/A5)
 * and Orientation (Portrait/Landscape) - the two PDF settings jsPDF's
 * own constructor natively supports, so no renderer rewrite is needed
 * for these.
 */
export function createPdfDocument(presentation: ResolvedPdfPresentation): jsPDF {
  return new jsPDF({
    format: presentation.pdf.pageSize === "A5" ? "a5" : "a4",
    orientation: presentation.pdf.orientation === "LANDSCAPE" ? "landscape" : "portrait",
  });
}

const LOGO_FORMAT_BY_EXTENSION: Record<string, string> = {
  ".png": "PNG",
  ".jpg": "JPEG",
  ".jpeg": "JPEG",
  ".webp": "WEBP",
};

/**
 * Loads the main logo from disk (public/uploads/branding/...) as a
 * jsPDF-compatible image, or returns null if there is none, the file
 * is missing, or the format isn't one jsPDF's addImage can render
 * (SVG/ICO are NOT supported by jsPDF - raster formats only) - never
 * throws, per the "PDF must still generate even with incomplete/
 * invalid branding" requirement.
 */
async function loadLogoForPdf(mainLogoUrl: string | null): Promise<{ data: Buffer; format: string } | null> {
  if (!mainLogoUrl || !mainLogoUrl.startsWith("/uploads/branding/")) return null;
  const ext = path.extname(mainLogoUrl).toLowerCase();
  const format = LOGO_FORMAT_BY_EXTENSION[ext];
  if (!format) return null; // SVG/ICO/unknown - not a jsPDF-renderable raster format, silently skipped

  try {
    const filePath = path.join(process.cwd(), "public", mainLogoUrl);
    const data = await readFile(filePath);
    return { data, format };
  } catch {
    return null; // file missing/unreadable - never crash the document over a missing logo
  }
}

export type HeaderResult = { nextY: number };

/**
 * Draws the header block (logo/business name/subtitle/contact line/
 * address), respecting every Show* toggle and the Logo Position/
 * Header Alignment settings. Returns the Y position content should
 * continue from. A caller whose own DocumentTypeSettings.useHeader
 * resolved to OFF, or whose useLogo resolved to OFF, should pass
 * `presentation.header.show`/`presentation.useLogo` through
 * unchanged - this function itself does not re-check them, so the
 * effective flags always come from resolvePdfPresentation() alone,
 * never re-derived here.
 */
export async function drawPdfHeader(
  doc: jsPDF,
  presentation: ResolvedPdfPresentation,
  documentTitle: string,
  startY = 10
): Promise<HeaderResult> {
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = startY;

  if (!presentation.header.show) {
    // Header fully OFF for this document type - only the document
    // title itself still renders (a document with literally no
    // heading at all would be unusable), nothing else.
    doc.setFontSize(14);
    doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "bold");
    doc.text(documentTitle, pageWidth / 2, y, { align: "center" });
    return { nextY: y + 8 };
  }

  const align = presentation.header.alignment === "LEFT" ? "left" : presentation.header.alignment === "RIGHT" ? "right" : "center";
  const textX = align === "left" ? 14 : align === "right" ? pageWidth - 14 : pageWidth / 2;

  const logo = presentation.useLogo && presentation.header.showLogo ? await loadLogoForPdf(presentation.business.mainLogoUrl) : null;
  const logoSize = 16;
  if (logo) {
    const logoX =
      presentation.header.logoPosition === "LEFT" ? 14 : presentation.header.logoPosition === "RIGHT" ? pageWidth - 14 - logoSize : pageWidth / 2 - logoSize / 2;
    try {
      doc.addImage(logo.data, logo.format, logoX, y, logoSize, logoSize);
    } catch {
      // Corrupt/unreadable image data despite passing the extension
      // check - never let a bad logo file break the whole document.
    }
  }

  if (presentation.header.showBusinessName && presentation.business.businessName) {
    doc.setFontSize(14);
    doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "bold");
    doc.text(presentation.business.businessName.toUpperCase(), textX, y + (logo ? 6 : 0), { align });
  }
  let contentY = y + (logo ? 6 : 0) + 6;

  if (presentation.header.subtitle) {
    doc.setFontSize(9);
    doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "normal");
    doc.text(presentation.header.subtitle, textX, contentY, { align });
    contentY += 5;
  }

  doc.setFontSize(9);
  doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "normal");

  if (presentation.header.showAddress) {
    const addressParts = [presentation.business.address, presentation.business.city, presentation.business.province, presentation.business.country].filter(
      (v): v is string => !!v && v.trim().length > 0
    );
    if (addressParts.length > 0) {
      doc.text(addressParts.join(", "), textX, contentY, { align });
      contentY += 5;
    }
  }

  const contactParts = [
    presentation.header.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
    presentation.header.showWhatsapp && presentation.business.whatsapp ? `WhatsApp: ${presentation.business.whatsapp}` : null,
    presentation.header.showEmail && presentation.business.email ? presentation.business.email : null,
    presentation.header.showWebsite && presentation.business.website ? presentation.business.website : null,
  ].filter((v): v is string => !!v);
  if (contactParts.length > 0) {
    doc.text(contactParts.join("  |  "), textX, contentY, { align });
    contentY += 5;
  }

  // Ensure the logo's own height is never overlapped by short/empty
  // contact info blocks.
  contentY = Math.max(contentY, y + (logo ? logoSize + 2 : 0));

  contentY += 3;
  doc.setFontSize(16);
  doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "bold");
  doc.text(documentTitle, pageWidth / 2, contentY, { align: "center" });
  contentY += 8;

  return { nextY: contentY };
}

/**
 * Draws the footer block on the CURRENT (last-written) page only for
 * Footer Text/Terms/contact-line content (a formal document typically
 * only needs its closing note once), but Page Number/Generated Date
 * are stamped on EVERY page via doc.setPage()/getNumberOfPages(), so a
 * multi-page document numbers correctly throughout. A caller whose own
 * DocumentTypeSettings.useFooter resolved to OFF should skip calling
 * this entirely.
 */
export function drawPdfFooter(doc: jsPDF, presentation: ResolvedPdfPresentation): void {
  if (!presentation.footer.show) return;

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const bottomY = pageHeight - 12;

  doc.setFontSize(8);
  doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "normal");
  doc.setTextColor(90);

  let y = bottomY;
  const lines: string[] = [];
  if (presentation.footer.text) lines.push(presentation.footer.text);

  const contactParts = [
    presentation.footer.showPhone && presentation.business.phone1 ? `Phone: ${presentation.business.phone1}` : null,
    presentation.footer.showAddress && presentation.business.address ? presentation.business.address : null,
    presentation.footer.showWebsite && presentation.business.website ? presentation.business.website : null,
  ].filter((v): v is string => !!v);
  if (contactParts.length > 0) lines.push(contactParts.join("  |  "));

  // Drawn bottom-up so the LAST line added sits closest to the page edge.
  for (let i = lines.length - 1; i >= 0; i--) {
    doc.text(lines[i], pageWidth / 2, y, { align: "center" });
    y -= 4;
  }

  if (presentation.footer.termsAndConditions) {
    const wrapped = doc.splitTextToSize(presentation.footer.termsAndConditions, pageWidth - 28);
    y -= wrapped.length * 3.5;
    doc.text(wrapped, pageWidth / 2, y, { align: "center" });
  }

  doc.setTextColor(0);

  if (presentation.footer.showPageNumber || presentation.footer.showGeneratedDate) {
    const totalPages = doc.getNumberOfPages();
    const generatedText = presentation.footer.showGeneratedDate ? `Generated: ${new Date().toLocaleString()}` : null;
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "normal");
      doc.setTextColor(100);
      if (presentation.footer.showPageNumber) {
        doc.text(`Page ${p} of ${totalPages}`, 14, bottomY);
      }
      if (generatedText) {
        doc.text(generatedText, pageWidth - 14, bottomY, { align: "right" });
      }
      doc.setTextColor(0);
    }
    doc.setPage(totalPages);
  }
}

/**
 * Draws a large, light, rotated watermark behind the page content on
 * EVERY page. Must be called AFTER all other content is drawn (jsPDF
 * has no z-order/layers - "behind" here means visually faint enough
 * not to obscure real content, not actual stacking order), matching
 * how every other PDF watermark implementation in a flat-drawing
 * library like jsPDF necessarily works.
 */
export function applyWatermark(doc: jsPDF, presentation: ResolvedPdfPresentation): void {
  if (!presentation.pdf.showWatermark || !presentation.pdf.watermarkText) return;

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const totalPages = doc.getNumberOfPages();

  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.12 }));
    doc.setFontSize(48);
    doc.setFont(resolveJsPdfFont(presentation.pdf.defaultFont), "bold");
    doc.setTextColor(120);
    doc.text(presentation.pdf.watermarkText, pageWidth / 2, pageHeight / 2, {
      align: "center",
      angle: 45,
    });
    doc.restoreGraphicsState();
    doc.setTextColor(0);
  }
}
