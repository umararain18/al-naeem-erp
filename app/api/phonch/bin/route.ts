import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "phonch.binView")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();

    const phonches = await prisma.phonch.findMany({
      where: {
        isDeleted: true,
        ...(search
          ? {
              OR: [
                { phonchNo: { contains: search, mode: "insensitive" } },
                { carrierNumber: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
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
        canRestore: hasPermission(currentUser, "phonch.restore"),
        canPermanentlyDelete: hasPermission(currentUser, "phonch.permanentlyDelete"),
      },
    });
  } catch (error) {
    console.error("Get phonch Bin error:", error);
    return NextResponse.json({ success: false, message: "Unable to load the Phonch Bin" }, { status: 500 });
  }
}
