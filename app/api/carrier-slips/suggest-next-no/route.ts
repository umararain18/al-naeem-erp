import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { suggestNextSlipNo } from "@/lib/own-carrier";

// GET /api/carrier-slips/suggest-next-no?carrierId=...
// A CONVENIENCE DEFAULT ONLY, never the real uniqueness guarantee -
// see suggestNextSlipNo()'s own doc comment. The user can edit it
// before saving; the @@unique([carrierId, slipNo]) constraint is what
// actually prevents a duplicate under concurrent creation.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const carrierId = request.nextUrl.searchParams.get("carrierId");
    if (!carrierId) {
      return NextResponse.json({ success: false, message: "carrierId is required" }, { status: 400 });
    }

    const slipNo = await suggestNextSlipNo(prisma, carrierId);
    return NextResponse.json({ success: true, slipNo });
  } catch (error) {
    console.error("Suggest next slip no error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
