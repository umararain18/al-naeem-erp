import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  ManualJournalValidationError,
  isValidEntryDate,
  resolveManualJournalEntry,
} from "@/lib/manual-journal-validation";
import {
  BIN_REASON_TOO_OLD,
  isOlderThanBinThreshold,
} from "@/lib/cash-bank-bin-policy";

// GET reuses the existing, unmodified GET /api/accounting-transactions/[id]
// for both View and Edit's initial data load - no duplicate endpoint here.

const lineSchema = z.object({
  accountId: z.string().min(1),
  description: z.string().min(1),
  debit: z.number().min(0),
  credit: z.number().min(0),
});

const updateSchema = z.object({
  date: z.string().min(1),
  narration: z.string().min(1, "Narration is required"),
  lines: z.array(lineSchema).min(2, "At least 2 lines are required"),
});

// ============================================================
// PATCH - Edit an existing Manual Journal Entry
//
// Updates the SAME JournalEntry/JournalLines atomically - never a
// reversal, never a replacement entry (approved decision #13). The
// existing lines are deleted and recreated INSIDE one transaction as
// children of the SAME JournalEntry.id, so the entry itself, its
// audit fields (createdById/createdAt), and its Manual Journal
// Number (referenceId) are all preserved untouched - only the lines
// and entryDate/description change.
// ============================================================

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const result = updateSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid journal entry data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const data = result.data;

    if (!isValidEntryDate(data.date)) {
      return NextResponse.json({ success: false, message: "Invalid date" }, { status: 400 });
    }

    const current = await prisma.journalEntry.findUnique({ where: { id } });

    if (!current) {
      return NextResponse.json({ success: false, message: "Journal entry not found" }, { status: 404 });
    }

    if (current.referenceType !== "MANUAL_JOURNAL") {
      return NextResponse.json(
        { success: false, message: "This is not a Manual Journal Entry and cannot be edited here." },
        { status: 400 }
      );
    }

    if (current.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Binned journal entries cannot be edited. Restore it first." },
        { status: 400 }
      );
    }

    try {
      const updated = await prisma.$transaction(
        async (tx) => {
          const { resolvedLines } = await resolveManualJournalEntry(tx, data.lines);

          await tx.journalLine.deleteMany({ where: { journalEntryId: id } });

          const entry = await tx.journalEntry.update({
            where: { id },
            data: {
              entryDate: new Date(`${data.date}T00:00:00`),
              description: data.narration.trim(),
              // referenceType/referenceId (Manual Journal No.) and every
              // audit field are intentionally untouched here.
              lines: {
                create: resolvedLines.map((line) => ({
                  accountId: line.accountId,
                  description: line.description,
                  debit: line.debit,
                  credit: line.credit,
                })),
              },
            },
            include: {
              lines: { include: { account: { select: { accountName: true, category: true } } } },
            },
          });

          return entry;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json({
        success: true,
        message: "Journal entry updated successfully.",
        journalEntry: updated,
      });
    } catch (error) {
      if (error instanceof ManualJournalValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another change to this journal entry happened at the same time. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Update journal entry error:", error);
    return NextResponse.json({ success: false, message: "Unable to update journal entry" }, { status: 500 });
  }
}

// ============================================================
// DELETE - Move to Bin (existing, unmodified soft-delete mechanism)
//
// Reuses the SAME JournalEntry.isDeleted/deletedAt/deletedById
// pattern and the SAME accountingTransactions.bin permission /
// age-threshold policy already governing every other JournalEntry
// Bin action in the app (Cash Book, Daily Posting). No new deletion
// mechanism. Restore continues to work through the existing,
// unmodified POST /api/accounting-transactions/[id]/restore.
// ============================================================

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    if (!hasPermission(currentUser, "accountingTransactions.bin")) {
      return NextResponse.json(
        { success: false, message: "You do not have permission to move journal entries to Bin." },
        { status: 403 }
      );
    }

    const { id } = await context.params;
    const current = await prisma.journalEntry.findUnique({ where: { id } });

    if (!current) {
      return NextResponse.json({ success: false, message: "Journal entry not found" }, { status: 404 });
    }

    if (current.referenceType !== "MANUAL_JOURNAL") {
      return NextResponse.json(
        { success: false, message: "This is not a Manual Journal Entry." },
        { status: 400 }
      );
    }

    if (current.isDeleted) {
      return NextResponse.json({ success: false, message: "This journal entry is already in Bin." }, { status: 400 });
    }

    if (currentUser.role !== "SUPER_ADMIN" && isOlderThanBinThreshold(current.entryDate)) {
      return NextResponse.json({ success: false, message: BIN_REASON_TOO_OLD }, { status: 403 });
    }

    const deleted = await prisma.journalEntry.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
    });

    return NextResponse.json({
      success: true,
      message: "Journal entry moved to Bin successfully.",
      journalEntryId: deleted.id,
    });
  } catch (error) {
    console.error("Bin journal entry error:", error);
    return NextResponse.json({ success: false, message: "Unable to move journal entry to Bin" }, { status: 500 });
  }
}
