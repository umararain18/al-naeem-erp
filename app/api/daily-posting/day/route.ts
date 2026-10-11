import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { DailyPostingValidationError } from "@/lib/daily-posting-validation";
import { BiltyPaidVerificationError } from "@/lib/bilty-paid-verification";
import { PhonchAccountingError } from "@/lib/phonch-accounting";
import { PrivatePhonchAccountingError } from "@/lib/private-phonch-accounting";
import { requestContext } from "@/lib/audit-log";
import { updateDailyPostingEntry } from "@/lib/daily-posting-edit";

// ============================================================
// PATCH /api/daily-posting/day
//
// "Save Day" - commits edits to SEVERAL different Daily Posting
// JournalEntries (posted at different times, on the same date) in ONE
// atomic database transaction. Each entry is updated through the
// EXACT SAME updateDailyPostingEntry() core (lib/daily-posting-edit.ts)
// the single-entry PATCH /api/daily-posting/[id] already uses - this
// route never reimplements or relaxes any of its validation/
// resolution/write rules, it only loops it over N entries inside one
// transaction instead of one entry per HTTP request.
//
// If ANY entry in the batch fails (a locked line, a ceiling exceeded,
// a stale reference, anything updateDailyPostingEntry() itself would
// reject), the WHOLE transaction rolls back - no partial save. The
// failing entry's own id is tagged onto the thrown error before it
// aborts the transaction, so the response can point the UI at the
// right card.
// ============================================================

const lineSchema = z.object({
  id: z.string().optional(),
  counterAccountId: z.string().optional(),
  description: z.string().min(1, "Description is required"),
  amount: z.number().positive("Amount must be greater than zero"),
  direction: z.enum(["DEBIT", "CREDIT"]),
  sourceType: z.string().min(1),
  sourceId: z.string().optional(),
  sourceNumber: z.string().optional(),
});

const entrySchema = z.object({
  id: z.string().min(1),
  date: z.string().min(1),
  lines: z.array(lineSchema).min(1, "At least one line is required"),
});

const batchSchema = z.object({
  entries: z.array(entrySchema).min(1, "At least one transaction is required"),
});

type TaggedError = Error & { entryId?: string };

export async function PATCH(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    // Same permission floor as the single-entry PATCH - "Save Day" is
    // the exact same class of operation, just batched.
    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = batchSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid Save Day data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    // No duplicate entry ids within one batch - each entry is applied
    // exactly once; a duplicate would silently apply the LAST one's
    // lines twice and discard the first, which the user never asked
    // for.
    const seenIds = new Set<string>();
    for (const e of data.entries) {
      if (seenIds.has(e.id)) {
        return NextResponse.json(
          { success: false, message: "The same transaction was submitted more than once in this save." },
          { status: 400 }
        );
      }
      seenIds.add(e.id);
    }

    const ctx = requestContext(request);

    try {
      const updated = await prisma.$transaction(
        async (tx) => {
          const results = [];
          for (const entryInput of data.entries) {
            try {
              const updatedEntry = await updateDailyPostingEntry({
                tx,
                id: entryInput.id,
                date: entryInput.date,
                lines: entryInput.lines,
                currentUser,
                hasPermission: (permission) => hasPermission(currentUser, permission),
                requestCtx: ctx,
              });
              results.push(updatedEntry);
            } catch (innerError) {
              // Tag which entry failed before letting it abort the
              // whole transaction - same error/message, now carrying
              // entryId so the response can point the UI at the right
              // card. Every entry already saved earlier in this loop
              // still rolls back along with it (one Serializable
              // transaction, no partial save).
              if (innerError instanceof Error) {
                (innerError as TaggedError).entryId = entryInput.id;
              }
              throw innerError;
            }
          }
          return results;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 }
      );

      return NextResponse.json({
        success: true,
        message: `${updated.length} transaction${updated.length === 1 ? "" : "s"} updated successfully`,
        journalEntryIds: updated.map((e) => e.id),
      });
    } catch (error) {
      const entryId = error instanceof Error ? (error as TaggedError).entryId : undefined;
      if (error instanceof DailyPostingValidationError) {
        return NextResponse.json({ success: false, message: error.message, entryId }, { status: error.status });
      }
      if (error instanceof BiltyPaidVerificationError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message, entryId }, { status: 400 });
      }
      if (error instanceof PhonchAccountingError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message, entryId }, { status: 400 });
      }
      if (error instanceof PrivatePhonchAccountingError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message, entryId }, { status: 400 });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another change to one of these transactions happened at the same time. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Save Day error:", error);
    return NextResponse.json({ success: false, message: "Unable to save the day's changes" }, { status: 500 });
  }
}
