import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// Read-only history list - every past date that has an actual
// Notebook row (created the first time it was saved - see
// app/api/notebook/[date]/route.ts's PATCH handler), most recent
// first, so the Notebook page can offer a quick "previous entries"
// picker instead of guessing which dates have anything written.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "notebook.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const limit = Math.min(200, Math.max(1, Number(request.nextUrl.searchParams.get("limit")) || 60));

    const notebooks = await prisma.notebook.findMany({
      orderBy: { date: "desc" },
      take: limit,
      select: {
        date: true,
        notes: true,
        _count: { select: { vehicles: true } },
      },
    });

    return NextResponse.json({
      success: true,
      entries: notebooks.map((n) => ({
        date: n.date,
        hasNotes: !!n.notes && n.notes.trim().length > 0,
        vehicleCount: n._count.vehicles,
      })),
    });
  } catch (error) {
    console.error("List notebook history error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Notebook history" }, { status: 500 });
  }
}
