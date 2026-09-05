import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "bilty.restore")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const bilty = await prisma.$transaction(async (tx) => {
      const currentBilty = await tx.bilty.findUnique({
        where: { id },
        select: { id: true, isDeleted: true },
      });

      if (!currentBilty) {
        return null;
      }

      if (!currentBilty.isDeleted) {
        throw new Error("NOT_BINNED");
      }

      return tx.bilty.update({
        where: { id },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
        },
      });
    });

    if (!bilty) {
      return NextResponse.json(
        { success: false, message: "Bilty not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Bilty restored successfully.",
      biltyId: bilty.id,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json(
        { success: false, message: "Only binned bilties can be restored" },
        { status: 400 }
      );
    }

    console.error("Restore bilty error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to restore bilty" },
      { status: 500 }
    );
  }
}
