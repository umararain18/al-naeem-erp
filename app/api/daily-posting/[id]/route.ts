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
import { BillAccountingError } from "@/lib/bill-accounting";
import { requestContext } from "@/lib/audit-log";
import { updateDailyPostingEntry } from "@/lib/daily-posting-edit";

// ============================================================
// GET /api/daily-posting/[id]
//
// Pre-existing read-only single-transaction detail fetch, used by
// app/daily-posting/[id]/page.tsx's own detail view - completely
// unrelated to, and unchanged by, the PATCH handler below.
// ============================================================
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await context.params;

    const entry = await prisma.journalEntry.findFirst({
      where: {
        id,
        referenceType: "DAILY_POSTING",
        isDeleted: false,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
        lines: {
          include: {
            account: {
              select: {
                id: true,
                accountName: true,
                accountCode: true,
                accountType: true,
                category: true,
                party: {
                  select: {
                    id: true,
                    partyName: true,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!entry) {
      return NextResponse.json(
        { success: false, message: "Daily posting not found" },
        { status: 404 }
      );
    }

    const totalDebit = entry.lines.reduce(
      (sum, line) => sum + Number(line.debit),
      0
    );

    const totalCredit = entry.lines.reduce(
      (sum, line) => sum + Number(line.credit),
      0
    );

    return NextResponse.json({
      success: true,
      entry: {
        ...entry,
        totalDebit,
        totalCredit,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
      },
    });
  } catch (error) {
    console.error("Get daily posting error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load daily posting" },
      { status: 500 }
    );
  }
}

// ============================================================
// PATCH /api/daily-posting/[id]
//
// Edits a COMPLETE Daily Posting JournalEntry in place - the general
// case PATCH /api/cash-book/[id] was never built for (that endpoint
// requires exactly 2 lines; this one supports any number of counter
// lines). Dedicated, additive endpoint: PATCH /api/cash-book/[id] is
// NEVER touched by this file and keeps its exact existing behavior
// for Cash Book's own editing of any row (Daily Posting or not).
//
// This route is now a thin wrapper: request parsing, auth/permission,
// and error-to-HTTP-status mapping only. The actual validation/
// resolution/write logic lives in lib/daily-posting-edit.ts's
// updateDailyPostingEntry() - shared verbatim with the day-wise batch
// "Save Day" route (app/api/daily-posting/day/route.ts), so both ever
// run through exactly ONE implementation of these accounting rules.
// See that file's own module doc comment for the full design
// rationale (PaymentAllocation safety, Counter Account reassignment,
// the collapsed Main leg).
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

const updateSchema = z.object({
  date: z.string().min(1),
  lines: z.array(lineSchema).min(1, "At least one line is required"),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    // Same permission floor as PATCH /api/cash-book/[id] - this is
    // the exact same class of operation (editing a posted Cash/Bank
    // transaction), just for the multi-line case.
    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid Daily Posting data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;
    const ctx = requestContext(request);

    try {
      const updated = await prisma.$transaction(
        (tx) =>
          updateDailyPostingEntry({
            tx,
            id,
            date: data.date,
            lines: data.lines,
            currentUser,
            hasPermission: (permission) => hasPermission(currentUser, permission),
            requestCtx: ctx,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json({
        success: true,
        message: "Transaction updated successfully",
        journalEntryId: updated.id,
      });
    } catch (error) {
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
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another change to this transaction happened at the same time. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Daily Posting edit error:", error);
    return NextResponse.json({ success: false, message: "Unable to update transaction" }, { status: 500 });
  }
}
