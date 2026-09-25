import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// Mirrors app/api/phonch/bin/route.ts exactly.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "privatePhonch.binView")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();

    const phonches = await prisma.privatePhonch.findMany({
      where: {
        isDeleted: true,
        ...(search ? { phonchNo: { contains: search, mode: "insensitive" } } : {}),
      },
      include: {
        transporterParty: { select: { id: true, partyName: true } },
        vehicles: { select: { id: true } },
        deletedBy: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: [{ deletedAt: "desc" }],
    });

    return NextResponse.json({
      success: true,
      phonches: phonches.map((p) => ({ ...p, vehicleCount: p.vehicles.length })),
      capabilities: {
        canRestore: hasPermission(currentUser, "privatePhonch.restore"),
        canPermanentlyDelete: hasPermission(currentUser, "privatePhonch.permanentlyDelete"),
      },
    });
  } catch (error) {
    console.error("List private phonch bin error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Private Phonch Bin" }, { status: 500 });
  }
}
