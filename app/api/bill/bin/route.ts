import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// Mirrors app/api/private-phonch/bin/route.ts exactly.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.binView")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();

    const bills = await prisma.bill.findMany({
      where: {
        isDeleted: true,
        ...(search ? { billNo: { contains: search, mode: "insensitive" } } : {}),
      },
      include: {
        clientParty: { select: { id: true, partyName: true } },
        items: { select: { id: true } },
        deletedBy: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: [{ deletedAt: "desc" }],
    });

    return NextResponse.json({
      success: true,
      bills: bills.map((b) => ({ ...b, vehicleCount: b.items.length })),
      capabilities: {
        canRestore: hasPermission(currentUser, "bill.restore"),
        canPermanentlyDelete: hasPermission(currentUser, "bill.permanentlyDelete"),
      },
    });
  } catch (error) {
    console.error("List bill bin error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Bill Bin" }, { status: 500 });
  }
}
