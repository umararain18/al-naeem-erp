import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { CarrierSlipError, validateChallanLinkEligible, validateBiltyLinkEligible } from "@/lib/carrier-slip";

function errorStatus(code: string): number {
  switch (code) {
    case "CHALLAN_NOT_FOUND":
    case "BILTY_NOT_FOUND":
      return 404;
    case "CHALLAN_ALREADY_LINKED":
    case "BILTY_ALREADY_LINKED":
      return 409;
    default:
      return 400;
  }
}

// GET /api/carrier-slips/fetch-document?challanId=...  (or ?biltyId=...&excludeSlipId=...)
//
// PREVIEW ONLY - lets the Slip form show Total Bilty Rent/Carrier Rent
// and reject an ineligible Challan (external Transporter already
// set, or already linked elsewhere) BEFORE the user saves. The real,
// authoritative check runs again inside the create/update route's own
// transaction - this is never trusted as the actual guard.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    let challanId = request.nextUrl.searchParams.get("challanId");
    let biltyId = request.nextUrl.searchParams.get("biltyId");
    const challanNo = request.nextUrl.searchParams.get("challanNo")?.trim();
    const biltyNo = request.nextUrl.searchParams.get("biltyNo")?.trim();
    const excludeSlipId = request.nextUrl.searchParams.get("excludeSlipId") || undefined;

    // Friendly number-based lookup (no dedicated search-select
    // component for this Phase 1 form) - resolves the user-typed
    // Challan/Bilty NUMBER to its real id first; everything after
    // this still goes through the exact same id-based guard.
    if (challanNo && !challanId) {
      const challan = await prisma.challan.findUnique({ where: { challanNo }, select: { id: true, isDeleted: true } });
      if (!challan || challan.isDeleted) {
        return NextResponse.json({ success: false, code: "CHALLAN_NOT_FOUND", message: `Challan ${challanNo} not found.` }, { status: 404 });
      }
      challanId = challan.id;
    }
    if (biltyNo && !biltyId) {
      const bilty = await prisma.bilty.findUnique({ where: { biltyNo }, select: { id: true, isDeleted: true } });
      if (!bilty || bilty.isDeleted) {
        return NextResponse.json({ success: false, code: "BILTY_NOT_FOUND", message: `Bilty ${biltyNo} not found.` }, { status: 404 });
      }
      biltyId = bilty.id;
    }

    if (challanId) {
      const data = await validateChallanLinkEligible(prisma, challanId, excludeSlipId);
      return NextResponse.json({ success: true, type: "CHALLAN", challanId, ...data });
    }
    if (biltyId) {
      const data = await validateBiltyLinkEligible(prisma, biltyId, excludeSlipId);
      return NextResponse.json({ success: true, type: "BILTY", biltyId, ...data });
    }
    return NextResponse.json({ success: false, message: "challanId/challanNo or biltyId/biltyNo is required" }, { status: 400 });
  } catch (error) {
    if (error instanceof CarrierSlipError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Fetch linked document error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
