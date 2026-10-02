import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

export async function POST(
  request: NextRequest,
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
        select: { id: true, isDeleted: true, biltyNo: true },
      });

      if (!currentBilty) {
        return null;
      }

      if (!currentBilty.isDeleted) {
        throw new Error("NOT_BINNED");
      }

      // Restore the SAME document-owned accounting Binned alongside
      // this Bilty (see the DELETE handler's own comment in
      // app/api/bilty/[id]/route.ts) - BILTY_BOOKING and
      // BILTY_BOOKING_CORRECTION are never soft-deleted by anything
      // other than this Bilty being Bin'd, so every currently-deleted
      // row under these two referenceTypes for this Bilty is safe to
      // restore unconditionally.
      await tx.journalEntry.updateMany({
        where: {
          referenceType: { in: ["BILTY_BOOKING", "BILTY_BOOKING_CORRECTION"] },
          referenceId: id,
          isDeleted: true,
        },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
        },
      });

      const restored = await tx.bilty.update({
        where: { id },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
        },
      });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "BILTY",
        entityType: "Bilty",
        entityId: id,
        documentNo: currentBilty.biltyNo,
        description: `Restored Bilty ${currentBilty.biltyNo} from Bin`,
        ...requestContext(request),
      });

      return restored;
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
