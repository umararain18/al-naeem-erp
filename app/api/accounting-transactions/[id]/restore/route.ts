import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { assertRestoreDoesNotExceedCeilings } from "@/lib/daily-posting-edit";
import { DailyPostingValidationError } from "@/lib/daily-posting-validation";
import { BiltyPaidVerificationError } from "@/lib/bilty-paid-verification";
import { PhonchAccountingError } from "@/lib/phonch-accounting";
import { PrivatePhonchAccountingError } from "@/lib/private-phonch-accounting";
import { BillAccountingError } from "@/lib/bill-accounting";
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

    if (!hasPermission(currentUser, "accountingTransactions.restore")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const ctx = requestContext(request);

    try {
      const entry = await prisma.$transaction(async (tx) => {
        const currentEntry = await tx.journalEntry.findUnique({
          where: { id },
          select: { id: true, isDeleted: true, referenceType: true },
        });

        if (!currentEntry) {
          return null;
        }

        if (!currentEntry.isDeleted) {
          throw new Error("NOT_BINNED");
        }

        // Own Carrier Trip CLOSE's own Entry A/Entry B - soft-deleted
        // directly by Reopen (lib/carrier-trip.ts's
        // softDeleteLiveCloseEntry), never restorable through this
        // generic route: restoring one independently would desync
        // CarrierTrip.status (still OPEN while a close entry is live
        // again). The only sanctioned way back is Re-close, which
        // posts an entirely fresh entry - never a restore of the old
        // one.
        if (currentEntry.referenceType === "CARRIER_TRIP_CLOSE" || currentEntry.referenceType === "CARRIER_TRIP_CLOSE_EXPENSE") {
          throw new Error("TRIP_CLOSE_ENTRY");
        }

        // A Bin'd entry's document-linked lines (BILTY/PHONCH/
        // PRIVATE_PHONCH/BILL) are already excluded from that
        // document's own received/paid total everywhere that total is
        // computed. Restoring un-excludes them - if something else was
        // posted against the SAME document while this entry sat in
        // Bin, bringing it back could silently push that document past
        // its ceiling. Re-check before un-deleting, exactly like
        // create/edit already do.
        await assertRestoreDoesNotExceedCeilings(tx, id);

        const restored = await tx.journalEntry.update({
          where: { id },
          data: {
            isDeleted: false,
            deletedAt: null,
            deletedById: null,
          },
        });

        await auditRestore(tx, {
          actor: actorFromUser(currentUser),
          module: "CASH_BOOK",
          entityType: "JournalEntry",
          entityId: restored.id,
          description: `Restored transaction ${restored.id} from Bin`,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        });

        return restored;
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
      if (error instanceof Error && error.message === "TRIP_CLOSE_ENTRY") {
        return NextResponse.json(
          { success: false, message: "This is a Trip Close entry - restore it by re-closing the Trip instead." },
          { status: 400 }
        );
      }
      if (error instanceof DailyPostingValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof BiltyPaidVerificationError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      if (error instanceof PhonchAccountingError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      if (error instanceof PrivatePhonchAccountingError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      if (error instanceof BillAccountingError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }
  } catch (error) {
    console.error("Restore accounting transaction error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to restore transaction" },
      { status: 500 }
    );
  }
}
