import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getChallanBiltyCollectionBreakdown, CarrierTripError } from "@/lib/carrier-trip";

// READ-ONLY. Every Bilty on this Challan, with its own current
// Collection resolution (who it would be collected from right now,
// or null if genuinely ambiguous) and outstanding amount - see
// lib/carrier-trip.ts's own getBiltyCollectionState doc comment for
// the exact rule. Used by the Trip Wasooli "pick one Bilty or split
// across Bilties" picker (app/own-carrier/[id]/trip/[tripId]/page.tsx) -
// the SAME read postCollectionLine() itself uses for its write-time
// ceiling, never a second, independently-maintained figure.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "challan.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const bilties = await getChallanBiltyCollectionBreakdown(prisma, id);

    return NextResponse.json({ success: true, bilties }, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" } });
  } catch (error) {
    if (error instanceof CarrierTripError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: error.code === "DOCUMENT_NOT_FOUND" ? 404 : 400 });
    }
    console.error("Get challan bilty collection state error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Bilty Collection state" }, { status: 500 });
  }
}
