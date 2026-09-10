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

// ============================================================
// MANUAL JOURNAL ENTRY - LIST + CREATE
//
// referenceType: "MANUAL_JOURNAL" - a new, distinct string value
// (JournalEntry.referenceType/JournalLine.sourceType are plain
// nullable String columns already, never a Prisma enum - confirmed
// during the Phase 1 diagnostic - so this needs no schema change and
// can never collide with any existing referenceType branch
// elsewhere in the codebase, e.g. Daily Posting's own
// `referenceType: "DAILY_POSTING"` filter).
//
// Manual Journal Number: a human-friendly, sequential, DISPLAY-ONLY
// identifier ("MJ-00001", ...), stored in the EXISTING
// JournalEntry.referenceId column - never a new column/migration.
// This reuses the same pattern every other referenceType already
// uses (each interprets referenceId differently: Settlement's is a
// Challan id, Daily Posting's is the main account id) - here it is
// simply the entry's own display number. It is computed inside the
// SAME Serializable transaction that creates the entry (count of
// ALL existing MANUAL_JOURNAL entries, including binned ones, so a
// number is never reused), exactly mirroring the concurrency-safety
// approach Daily Posting already uses for its own Paid-verification
// guard - a genuine race is caught by Postgres as a serialization
// failure (P2034) and surfaced as a retryable error, never silently
// produces a duplicate number. It never replaces JournalEntry.id.
// ============================================================

const lineSchema = z.object({
  accountId: z.string().min(1),
  description: z.string().min(1),
  debit: z.number().min(0),
  credit: z.number().min(0),
});

const createSchema = z.object({
  date: z.string().min(1),
  narration: z.string().min(1, "Narration is required"),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/, "Invalid idempotency key")
    .optional(),
  lines: z.array(lineSchema).min(2, "At least 2 lines are required"),
});

async function nextManualJournalNumber(tx: Prisma.TransactionClient): Promise<string> {
  const count = await tx.journalEntry.count({
    where: { referenceType: "MANUAL_JOURNAL" },
  });
  return `MJ-${String(count + 1).padStart(5, "0")}`;
}

// ============================================================
// GET - Manual Journal Entry register (newest -> oldest)
// ============================================================

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search")?.trim();

    const dateFilter: { gte?: Date; lt?: Date } = {};
    if (from) {
      const start = new Date(`${from}T00:00:00`);
      if (!Number.isNaN(start.getTime())) dateFilter.gte = start;
    }
    if (to) {
      const end = new Date(`${to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      if (!Number.isNaN(end.getTime())) dateFilter.lt = end;
    }

    const entries = await prisma.journalEntry.findMany({
      where: {
        referenceType: "MANUAL_JOURNAL",
        isDeleted: false,
        ...(Object.keys(dateFilter).length > 0 ? { entryDate: dateFilter } : {}),
        ...(search
          ? {
              OR: [
                { description: { contains: search, mode: "insensitive" } },
                { referenceId: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        lines: { select: { debit: true, credit: true } },
        createdBy: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    });

    // Same age-only Bin policy every other JournalEntry Bin action uses
    // (lib/cash-bank-bin-policy.ts) - never re-derived here. Manual
    // Journal lines are never document-linked (approved decision #12),
    // so the settled-document check is structurally never applicable;
    // only the age threshold and the accountingTransactions.bin
    // permission (SUPER_ADMIN unrestricted by age, like everywhere
    // else) govern whether a row can be binned.
    const hasBinPermission = hasPermission(currentUser, "accountingTransactions.bin");
    const isSuperAdmin = currentUser.role === "SUPER_ADMIN";

    const items = entries.map((entry) => {
      const totalDebit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);

      let canBin = false;
      let binProtectedReason: string | null = null;
      if (hasBinPermission) {
        if (isSuperAdmin) {
          canBin = true;
        } else if (isOlderThanBinThreshold(entry.entryDate)) {
          binProtectedReason = BIN_REASON_TOO_OLD;
        } else {
          canBin = true;
        }
      }

      return {
        id: entry.id,
        manualJournalNo: entry.referenceId,
        date: entry.entryDate.toISOString(),
        narration: entry.description,
        totalDebit,
        totalCredit,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
        createdBy: entry.createdBy,
        createdAt: entry.createdAt.toISOString(),
        canBin,
        binProtectedReason,
      };
    });

    return NextResponse.json({
      success: true,
      items,
      total: items.length,
      capabilities: {
        canCreate: hasPermission(currentUser, "accounts.create"),
        canEdit: hasPermission(currentUser, "accounts.edit"),
        canBin: hasBinPermission,
      },
    });
  } catch (error) {
    console.error("Get journal entries error:", error);
    return NextResponse.json({ success: false, message: "Unable to load journal entries" }, { status: 500 });
  }
}

// ============================================================
// POST - Create a new Manual Journal Entry
// ============================================================

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    if (!hasPermission(currentUser, "accounts.create")) {
      return NextResponse.json(
        { success: false, message: "You do not have permission to create journal entries" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const result = createSchema.safeParse(body);

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

    const entryId = data.idempotencyKey ? `manjournal_${data.idempotencyKey}` : undefined;

    let journalEntry;
    let idempotentReplay = false;

    try {
      journalEntry = await prisma.$transaction(
        async (tx) => {
          // Full validation happens INSIDE the transaction, against
          // live state, before any write - exactly mirroring Daily
          // Posting's own Paid-verification discipline.
          const { resolvedLines, totalDebit, totalCredit } = await resolveManualJournalEntry(tx, data.lines);

          const manualJournalNo = await nextManualJournalNumber(tx);

          const entry = await tx.journalEntry.create({
            data: {
              ...(entryId ? { id: entryId } : {}),
              entryDate: new Date(`${data.date}T00:00:00`),
              referenceType: "MANUAL_JOURNAL",
              referenceId: manualJournalNo,
              description: data.narration.trim(),
              createdById: currentUser.userId,
              lines: {
                create: resolvedLines.map((line) => ({
                  accountId: line.accountId,
                  description: line.description,
                  debit: line.debit,
                  credit: line.credit,
                  // v1: never document-linked (approved decision #12) -
                  // sourceType/sourceId/sourceNumber stay null, exactly
                  // like any other line with no document.
                })),
              },
            },
            include: {
              lines: { include: { account: { select: { accountName: true, category: true } } } },
            },
          });

          void totalDebit;
          void totalCredit;

          return entry;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (error instanceof ManualJournalValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another Journal Entry submission happened at the same time. Please retry." },
          { status: 409 }
        );
      }

      const isIdempotencyCollision =
        entryId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

      if (!isIdempotencyCollision) {
        throw error;
      }

      const existing = await prisma.journalEntry.findUnique({
        where: { id: entryId! },
        include: { lines: { include: { account: { select: { accountName: true, category: true } } } } },
      });

      if (!existing) {
        return NextResponse.json(
          { success: false, message: "This submission could not be completed. Please try again with a new entry." },
          { status: 409 }
        );
      }

      journalEntry = existing;
      idempotentReplay = true;
    }

    return NextResponse.json(
      {
        success: true,
        message: idempotentReplay ? "This journal entry was already processed." : "Journal entry saved successfully.",
        idempotentReplay: idempotentReplay || undefined,
        journalEntry,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Create journal entry error:", error);
    return NextResponse.json({ success: false, message: "Unable to save journal entry" }, { status: 500 });
  }
}
