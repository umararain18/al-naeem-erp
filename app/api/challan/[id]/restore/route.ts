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

    if (!hasPermission(currentUser, "challan.restore")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const challan = await prisma.$transaction(async (tx) => {
      const currentChallan = await tx.challan.findUnique({
        where: { id },
        select: { id: true, isDeleted: true },
      });

      if (!currentChallan) {
        return null;
      }

      if (!currentChallan.isDeleted) {
        throw new Error("NOT_BINNED");
      }

      return tx.challan.update({
        where: { id },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
        },
      });
    });

    if (!challan) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Challan restored successfully.",
      challanId: challan.id,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json(
        { success: false, message: "Only binned challans can be restored" },
        { status: 400 }
      );
    }

    console.error("Restore challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to restore challan" },
      { status: 500 }
    );
  }
}
