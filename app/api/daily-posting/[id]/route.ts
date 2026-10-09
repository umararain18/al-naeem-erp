import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  DAILY_POSTING_SOURCE_TYPES,
  DailyPostingValidationError,
  resolveDailyPostingLine,
  type DailyPostingSourceType,
} from "@/lib/daily-posting-validation";
import {
  assertPaidVerificationNotExceeded,
  BiltyPaidVerificationError,
} from "@/lib/bilty-paid-verification";
import {
  assertPhonchReceiptNotExceeded,
  PhonchAccountingError,
} from "@/lib/phonch-accounting";
import {
  assertPrivatePhonchPaymentNotExceeded,
  PrivatePhonchAccountingError,
} from "@/lib/private-phonch-accounting";
import { getAllocatedAmountForPayment } from "@/lib/payment-allocation";
import { auditUpdate, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

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
// A Daily Posting JournalEntry is always: one Main (Cash/Bank)
// account, sharing the SAME accountId across every one of its own
// "main leg" JournalLines (see app/api/daily-posting/route.ts's
// buildLinePair() - one submission with N counter lines produces N
// main legs + N counter legs, 2N lines total, grouped into one entry
// whenever they share the same document key), plus N counter
// (Party/other) JournalLines, each independently meaningful.
//
// PaymentAllocation.journalLineId (the ONLY foreign key anywhere in
// the schema that points at a JournalLine, onDelete: Cascade) can
// ONLY ever reference a counter line - never a main Cash/Bank leg
// (see lib/payment-allocation.ts's own getPaymentLine()). This is
// why the two sides are treated completely differently here:
//
//   - Counter lines are NEVER blindly deleted-and-recreated. An
//     existing counter line (has its own id) is updated IN PLACE,
//     preserving that id and therefore any PaymentAllocation rows
//     against it. A line the user removes is deleted only after
//     confirming it carries zero PaymentAllocation; otherwise the
//     whole update is rejected with a clear message - identical in
//     spirit to the existing "Gap A" ceiling check PATCH
//     /api/cash-book/[id] already enforces for the simple 2-line case.
//   - Counter Account is NOT locked on an existing line. The user may
//     reassign it (or leave it blank to auto-resolve from the
//     document) and it is re-validated through the exact same
//     resolveDailyPostingLine() pipeline a brand-new line goes
//     through - Bilty/Challan/Private Phonch legitimacy against the
//     document's own eligible parties, active-account check, PARTY
//     <-> CASH/BANK restriction - never silently coerced back to its
//     old value. The ONE exception: a line that already carries a
//     PaymentAllocation can never have its Counter Account changed
//     (only its amount may still move, down to the allocated floor),
//     since the allocation represents a specific Party having been
//     connected to a specific Bilty/Challan - changing the account
//     out from under it would silently misrepresent that relationship.
//   - The Main Account side is safely collapsed to exactly ONE net
//     line (sum of all counter credits -> main debit; sum of all
//     counter debits -> main credit) on every save, since nothing
//     ever references a main leg's id directly. This is also the
//     mathematically guaranteed-balanced representation, and matches
//     how a multi-line transaction naturally reads: one Main Account,
//     several counter lines.
//
// Every per-line accounting guard the simple-edit PATCH already
// enforces (paid-verification ceiling, Phonch ceiling, Private Phonch
// ceiling, the same resolveDailyPostingLine() counter-account
// resolution/legitimacy pipeline) is reused here unmodified, just
// looped over N lines instead of 1. The whole operation is one
// Serializable transaction - if any line fails validation, nothing is
// written.
// ============================================================

const lineSchema = z.object({
  // Present only for an EXISTING counter line being kept/edited -
  // absent for a brand-new line the user added in edit mode. Never
  // trusted blindly: re-verified below that it actually belongs to
  // THIS entry before anything is touched.
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

function isValidDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
}

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

    if (!isValidDate(data.date)) {
      return NextResponse.json({ success: false, message: "Invalid date" }, { status: 400 });
    }

    const entry = await prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: { include: { account: true } } },
    });

    if (!entry) {
      return NextResponse.json({ success: false, message: "Transaction not found" }, { status: 404 });
    }
    if (entry.referenceType !== "DAILY_POSTING") {
      return NextResponse.json(
        { success: false, message: "This is not a Daily Posting transaction and cannot be edited here." },
        { status: 400 }
      );
    }
    if (entry.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Binned transactions cannot be edited. Restore the transaction first." },
        { status: 400 }
      );
    }

    // Identify the Main (Cash/Bank) account - every "main leg" of a
    // Daily Posting entry shares the exact same accountId (see
    // buildLinePair()). If this entry's Cash/Bank lines don't all
    // share one account, its structure is genuinely outside what
    // Daily Posting's own create flow ever produces - reject rather
    // than guess.
    const cashBankLines = entry.lines.filter((l) => l.account.category === "CASH" || l.account.category === "BANK");
    const distinctMainAccountIds = new Set(cashBankLines.map((l) => l.accountId));
    if (distinctMainAccountIds.size !== 1) {
      return NextResponse.json(
        {
          success: false,
          message:
            distinctMainAccountIds.size === 0
              ? "This transaction has no Cash/Bank leg and cannot be edited here."
              : "This transaction spans more than one Cash/Bank account and cannot be edited here.",
        },
        { status: 400 }
      );
    }
    const mainAccountId = [...distinctMainAccountIds][0];
    const mainAccount = cashBankLines[0].account;

    const existingCounterLines = entry.lines.filter((l) => l.accountId !== mainAccountId);
    const existingCounterLineById = new Map(existingCounterLines.map((l) => [l.id, l]));

    // Every submitted line carrying an `id` must actually belong to
    // this entry's own counter lines - never trust a client-supplied
    // id blindly (would otherwise let one transaction's edit silently
    // touch another's JournalLine).
    for (const line of data.lines) {
      if (line.id && !existingCounterLineById.has(line.id)) {
        return NextResponse.json(
          { success: false, message: "One or more lines do not belong to this transaction." },
          { status: 400 }
        );
      }
    }

    const submittedIds = new Set(data.lines.filter((l) => l.id).map((l) => l.id as string));
    const removedLines = existingCounterLines.filter((l) => !submittedIds.has(l.id));

    try {
      const updated = await prisma.$transaction(
        async (tx) => {
          // ----------------------------------------------------------
          // REMOVED LINES - blocked when any PaymentAllocation exists,
          // exactly mirroring PATCH /api/cash-book/[id]'s own "Gap A"
          // guard (never silently orphan an allocation that references
          // this line).
          // ----------------------------------------------------------
          for (const removed of removedLines) {
            const allocated = await getAllocatedAmountForPayment(tx, removed.id);
            if (allocated > 0.009) {
              throw new DailyPostingValidationError(
                `Cannot remove the line for "${removed.description || removed.account.accountName}" - Rs. ${allocated} has already been allocated from it to a Bilty/Challan. Remove or reduce the relevant allocation(s) first.`
              );
            }
          }

          // ----------------------------------------------------------
          // RESOLVE EVERY SUBMITTED LINE - ONE uniform pipeline for
          // both a brand-new line and an existing one. Counter Account
          // is NOT locked on an existing line: resolveDailyPostingLine()
          // treats whatever the user submits as a manually-supplied
          // Counter Account and re-validates it exactly as Create
          // does (existence/active, Bilty/Challan/Private Phonch
          // legitimacy against the document's own eligible parties,
          // PARTY<->CASH/BANK restriction) - a change that would
          // violate any of those rules is rejected with the same clear
          // message Create itself gives, never silently coerced. The
          // PaymentAllocation-safety guard for an account change on an
          // already-allocated line lives below, in CEILING CHECKS,
          // once every line's final Counter Account is known.
          // ----------------------------------------------------------
          const resolvedLines: {
            id: string | null;
            counterAccountId: string;
            description: string;
            amount: number;
            direction: "DEBIT" | "CREDIT";
            sourceType: DailyPostingSourceType;
            sourceId: string | null;
            sourceNumber: string | null;
          }[] = [];

          for (const line of data.lines) {
            const requestedSourceType = line.sourceType.trim();
            if (!DAILY_POSTING_SOURCE_TYPES.includes(requestedSourceType as DailyPostingSourceType)) {
              throw new DailyPostingValidationError(`Invalid document type for line "${line.description}"`);
            }
            if (requestedSourceType === "CHALLAN" && !hasPermission(currentUser, "challan.view")) {
              throw new DailyPostingValidationError("Forbidden", 403);
            }
            if (requestedSourceType === "BILTY" && !hasPermission(currentUser, "bilty.view")) {
              throw new DailyPostingValidationError("Forbidden", 403);
            }

            const existing = line.id ? existingCounterLineById.get(line.id) : undefined;
            const finalSourceType = requestedSourceType as DailyPostingSourceType;

            const resolved = await resolveDailyPostingLine({
              tx,
              mainAccountId,
              mainCategory: mainAccount.category,
              sourceType: finalSourceType,
              sourceId: line.sourceId,
              sourceNumber: line.sourceNumber,
              counterAccountId: line.counterAccountId,
              direction: line.direction,
            });

            resolvedLines.push({
              id: existing?.id || null,
              counterAccountId: resolved.counterAccountId,
              description: line.description.trim(),
              amount: line.amount,
              direction: line.direction,
              sourceType: resolved.sourceType,
              sourceId: resolved.sourceId,
              sourceNumber: resolved.sourceNumber,
            });
          }

          // ----------------------------------------------------------
          // CEILING CHECKS - same guards the simple-edit PATCH already
          // runs per line, this entry's own prior contribution always
          // excluded via excludeJournalEntryId so editing in place
          // never double-counts against itself.
          // ----------------------------------------------------------
          for (const line of resolvedLines) {
            if (line.sourceType === "BILTY" && line.sourceId) {
              await assertPaidVerificationNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction, entry.id);
            }
            if (line.sourceType === "PHONCH" && line.sourceId) {
              await assertPhonchReceiptNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction, entry.id);
            }
            if (line.sourceType === "PRIVATE_PHONCH" && line.sourceId) {
              await assertPrivatePhonchPaymentNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction, entry.id);
            }
            // PAYMENT ALLOCATION SAFETY - an existing line that
            // already has a PaymentAllocation against it can neither
            // be reduced below the allocated amount nor have its
            // Counter Account changed, in either case because doing
            // so would silently misrepresent which Party the
            // allocation was actually made against - exactly mirroring
            // the simple-edit PATCH's own "Gap A" guard, now extended
            // to cover an account-change the simple-edit PATCH never
            // allowed in the first place.
            if (line.id) {
              const existingLine = existingCounterLineById.get(line.id)!;
              if (existingLine.account.category === "PARTY") {
                const allocated = await getAllocatedAmountForPayment(tx, line.id);
                if (allocated > 0.009 && line.counterAccountId !== existingLine.accountId) {
                  throw new DailyPostingValidationError(
                    `Cannot change the Counter Account for "${line.description}" - Rs. ${allocated} has already been allocated from it to a Bilty/Challan. Remove or reduce the relevant allocation(s) first.`
                  );
                }
                if (allocated > line.amount + 0.009) {
                  throw new DailyPostingValidationError(
                    `Cannot reduce "${line.description}" to ${line.amount} - ${allocated} has already been allocated from it to a Bilty/Challan. Remove or reduce the relevant allocation(s) first.`
                  );
                }
              }
            }
          }

          // ----------------------------------------------------------
          // WRITE - counter lines are updated/created/deleted
          // individually (never deleted-and-recreated wholesale); the
          // Main Account side is safely collapsed to one net line.
          // ----------------------------------------------------------
          for (const removed of removedLines) {
            await tx.journalLine.delete({ where: { id: removed.id } });
          }

          for (const line of resolvedLines) {
            const counterDebit = line.direction === "CREDIT" ? line.amount : 0;
            const counterCredit = line.direction === "DEBIT" ? line.amount : 0;
            if (line.id) {
              await tx.journalLine.update({
                where: { id: line.id },
                data: {
                  accountId: line.counterAccountId,
                  description: line.description,
                  debit: counterDebit,
                  credit: counterCredit,
                  sourceType: line.sourceType,
                  sourceId: line.sourceId,
                  sourceNumber: line.sourceNumber,
                },
              });
            } else {
              await tx.journalLine.create({
                data: {
                  journalEntryId: entry.id,
                  accountId: line.counterAccountId,
                  description: line.description,
                  debit: counterDebit,
                  credit: counterCredit,
                  sourceType: line.sourceType,
                  sourceId: line.sourceId,
                  sourceNumber: line.sourceNumber,
                },
              });
            }
          }

          // Main Account side: derived, never referenced by
          // PaymentAllocation or anything else by line id - safe to
          // collapse to exactly one net line every save.
          const netMainDebit = resolvedLines.reduce((s, l) => s + (l.direction === "DEBIT" ? l.amount : 0), 0);
          const netMainCredit = resolvedLines.reduce((s, l) => s + (l.direction === "CREDIT" ? l.amount : 0), 0);

          // A single shared document across every final line is still
          // reflected on the collapsed Main line (preserves its own
          // document-linkage display); a genuinely mixed-document
          // multi-line entry collapses the Main leg to plain DIRECT,
          // never misattributed to any one of its several documents.
          const distinctDocKeys = new Set(resolvedLines.map((l) => `${l.sourceType}:${l.sourceId || ""}:${l.sourceNumber || ""}`));
          const sharedDoc = distinctDocKeys.size === 1 ? resolvedLines[0] : null;

          await tx.journalLine.deleteMany({ where: { journalEntryId: entry.id, accountId: mainAccountId } });
          await tx.journalLine.create({
            data: {
              journalEntryId: entry.id,
              accountId: mainAccountId,
              description: resolvedLines.length === 1 ? resolvedLines[0].description : entry.description,
              debit: netMainDebit,
              credit: netMainCredit,
              sourceType: sharedDoc ? sharedDoc.sourceType : "DIRECT",
              sourceId: sharedDoc ? sharedDoc.sourceId : null,
              sourceNumber: sharedDoc ? sharedDoc.sourceNumber : null,
            },
          });

          const updatedEntry = await tx.journalEntry.update({
            where: { id: entry.id },
            data: {
              entryDate: new Date(`${data.date}T00:00:00`),
            },
            include: { lines: { include: { account: true } } },
          });

          const changedFields = diffFields(
            { date: entry.entryDate, lineCount: entry.lines.length },
            { date: updatedEntry.entryDate, lineCount: resolvedLines.length + 1 },
            ["date", "lineCount"]
          );
          await auditUpdate(tx, {
            actor: actorFromUser(currentUser),
            module: "CASH_BOOK",
            entityType: "JournalEntry",
            entityId: entry.id,
            documentNo: mainAccount.accountName,
            description: `Edited Daily Posting transaction on ${mainAccount.accountName} (${resolvedLines.length} counter line${resolvedLines.length === 1 ? "" : "s"}, ${removedLines.length} removed)`,
            changedFields,
            ...requestContext(request),
          });

          return updatedEntry;
        },
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
