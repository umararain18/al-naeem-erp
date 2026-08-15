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

    if (!hasPermission(currentUser, "accountingTransactions.restore")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const entry = await prisma.$transaction(async (tx) => {
      const currentEntry = await tx.journalEntry.findUnique({
        where: { id },
        select: { id: true, isDeleted: true },
      });

      if (!currentEntry) {
        return null;
      }

      if (!currentEntry.isDeleted) {
        throw new Error("NOT_BINNED");
      }

      return tx.journalEntry.update({
        where: { id },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
        },
      });
    });

    if (!entry) {
      return NextResponse.json(
        { success: false, message: "Transaction not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Transaction restored successfully.",
      journalEntryId: entry.id,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json(
        { success: false, message: "Only binned transactions can be restored" },
        { status: 400 }
      );
    }

    console.error("Restore accounting transaction error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to restore transaction" },
      { status: 500 }
    );
  }
}
