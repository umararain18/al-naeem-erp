import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// ============================================================
// GET /api/challan/next-number
//
// Suggests the next sequential Challan number as a plain
// increasing integer (4001, 4002, 4003, ...), based on the
// highest PURELY NUMERIC challanNo across ALL Challans -
// including soft-deleted ones, so a deleted number is never
// reused. Non-numeric challan numbers (e.g. legacy/test data)
// are ignored for this purpose; they don't participate in the
// sequence either way.
//
// This is a suggestion only - the Challan No. field remains a
// free-text, user-editable input.
// ============================================================

export async function GET() {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "challan.create")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    // Deliberately includes soft-deleted Challans - a deleted
    // number must not be reused.
    const challans = await prisma.challan.findMany({
      select: { challanNo: true },
    });

    let maxNumber = 0;
    for (const { challanNo } of challans) {
      if (/^\d+$/.test(challanNo.trim())) {
        const value = parseInt(challanNo.trim(), 10);
        if (value > maxNumber) maxNumber = value;
      }
    }

    const nextChallanNo = maxNumber > 0 ? String(maxNumber + 1) : null;

    return NextResponse.json({ success: true, nextChallanNo });
  } catch (error) {
    console.error("Next challan number error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to compute next challan number" },
      { status: 500 }
    );
  }
}
