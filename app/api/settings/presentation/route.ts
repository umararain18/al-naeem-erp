import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { resolvePdfPresentation } from "@/lib/pdf-presentation";
import type { SettingsDocumentTypeValue } from "@/lib/business-settings";

// ============================================================
// GET /api/settings/presentation?documentType=BILTY
//
// A DELIBERATELY SEPARATE, lighter-gated read surface from
// /api/settings/business - that route is settings.view-only (the
// Settings admin screen itself), but a document's own header/footer
// branding must be visible to ANYONE who can view the document, not
// only to SUPER_ADMIN/MANAGER. Per the original Settings task's own
// Section 9 ("Other users may receive read-only configuration where
// needed for document rendering"). Server-side jsPDF generators don't
// need this endpoint at all - they call resolvePdfPresentation()
// directly - this exists only for CLIENT components (currently just
// app/bilty/[id]/print/page.tsx) that can't reach the database
// directly. Still requires a signed-in session; never anonymous.
//
// Returns ONLY presentational fields (business identity/branding/
// header/footer/pdf display config) - nothing accounting-related,
// and nothing more sensitive than what already appears on a printed
// document any authenticated user of this ERP can already view.
// ============================================================

const VALID_TYPES: SettingsDocumentTypeValue[] = [
  "BILTY",
  "CHALLAN",
  "BILL",
  "PRIVATE_PHONCH",
  "SHOWROOM_PHONCH",
  "RECEIPT",
  "PARTY_STATEMENT",
  "REPORTS",
];

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const documentType = searchParams.get("documentType");
    if (!documentType || !VALID_TYPES.includes(documentType as SettingsDocumentTypeValue)) {
      return NextResponse.json({ success: false, message: "Invalid documentType" }, { status: 400 });
    }

    const presentation = await resolvePdfPresentation(prisma, documentType as SettingsDocumentTypeValue);

    return NextResponse.json({ success: true, presentation });
  } catch (error) {
    console.error("Get presentation settings error:", error);
    return NextResponse.json({ success: false, message: "Unable to load presentation settings" }, { status: 500 });
  }
}
