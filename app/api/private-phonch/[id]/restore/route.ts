import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// Mirrors app/api/phonch/[id]/restore/route.ts exactly.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "privatePhonch.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const phonch = await prisma.$transaction(async (tx) => {
      const current = await tx.privatePhonch.findUnique({ where: { id }, select: { id: true, isDeleted: true } });
      if (!current) return null;
      if (!current.isDeleted) {
        throw new Error("NOT_BINNED");
      }
      return tx.privatePhonch.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null, deletedById: null },
      });
    });

    if (!phonch) {
      return NextResponse.json({ success: false, message: "Private Phonch not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Private Phonch restored successfully.", phonchId: phonch.id });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json({ success: false, message: "Only binned Private Phonch records can be restored" }, { status: 400 });
    }
    console.error("Restore private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore Private Phonch" }, { status: 500 });
  }
}
