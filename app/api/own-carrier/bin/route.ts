import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// Mirrors app/api/bill/bin/route.ts exactly.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.binView")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();

    const carriers = await prisma.ownCarrier.findMany({
      where: {
        isDeleted: true,
        ...(search ? { carrierNumber: { contains: search, mode: "insensitive" } } : {}),
      },
      include: {
        currentDriver: { select: { id: true, name: true } },
        deletedBy: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: [{ deletedAt: "desc" }],
    });

    return NextResponse.json({
      success: true,
      items: carriers,
      capabilities: {
        canRestore: hasPermission(currentUser, "ownCarrier.restore"),
        canPermanentlyDelete: hasPermission(currentUser, "ownCarrier.permanentlyDelete"),
      },
    });
  } catch (error) {
    console.error("List own carrier bin error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Own Carrier Bin" }, { status: 500 });
  }
}
