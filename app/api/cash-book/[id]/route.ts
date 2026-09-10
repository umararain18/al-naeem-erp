import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  BIN_REASON_TOO_OLD,
  BIN_REASON_SETTLED_DOCUMENT,
  isOlderThanBinThreshold,
  isLinkedToSettledDocument,
} from "@/lib/cash-bank-bin-policy";
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

function isValidDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
}

export async function PATCH(
  request: NextRequest,
  context: {
    params: Promise<{ id: string }>;
  }
) {
  try {
    // ============================================================
    // AUTHENTICATION
    // ============================================================

    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    // ============================================================
    // PERMISSION
    // ============================================================

    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    // ============================================================
    // JOURNAL LINE ID
    // ============================================================

    const { id } = await context.params;

    if (!id) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction ID is required",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // REQUEST BODY
    // ============================================================

    const body = await request.json();

    const {
      date,
      document,
      documentNo,
      // Only meaningful for a BILTY/CHALLAN Daily Posting line - the real
      // database id of the document the user selected via
      // DocumentSearchSelect (never trusted blindly; re-verified below by
      // resolveDailyPostingLine -> verifyDailyPostingDocument, exactly
      // like a brand-new Daily Posting submission). Absent/ignored for
      // every other row.
      sourceId: requestedSourceId,
      description,
      debit,
      credit,
    } = body;

    // ============================================================
    // BASIC VALIDATION
    // ============================================================

    if (!date || typeof date !== "string") {
      return NextResponse.json(
        {
          success: false,
          message: "Date is required",
        },
        { status: 400 }
      );
    }

    if (!isValidDate(date)) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid date",
        },
        { status: 400 }
      );
    }

    const debitAmount = Number(debit) || 0;
    const creditAmount = Number(credit) || 0;

    if (debitAmount < 0 || creditAmount < 0) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Debit and credit cannot be negative",
        },
        { status: 400 }
      );
    }

    if (
      (debitAmount > 0 && creditAmount > 0) ||
      (debitAmount === 0 && creditAmount === 0)
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Transaction must contain either debit or credit",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // FIND CURRENT JOURNAL LINE
    // ============================================================

    const currentLine =
      await prisma.journalLine.findUnique({
        where: {
          id,
        },

        include: {
          journalEntry: {
            include: {
              lines: true,
            },
          },

          account: true,
        },
      });

    if (!currentLine) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction not found",
        },
        { status: 404 }
      );
    }

    if (currentLine.journalEntry.isDeleted) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Binned transactions cannot be edited. Restore the transaction first.",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // SAFETY CHECK
    //
    // This API is specifically for Cash Book transactions.
    // ============================================================

    if (
      currentLine.account.category !== "CASH" &&
      currentLine.account.category !== "BANK"
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction does not belong to a Cash/Bank account",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // FIND COUNTER LINE
    //
    // Daily Posting creates a pair:
    //
    // Cash/Bank line
    // +
    // Counter account line
    //
    // We identify the matching line from the same JournalEntry.
    // ============================================================

    const counterLines =
      currentLine.journalEntry.lines.filter(
        (line) => line.id !== currentLine.id
      );

    if (counterLines.length !== 1) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction has an unsupported journal structure. Edit was not applied.",
        },
        { status: 400 }
      );
    }

    const counterLine = counterLines[0];

    // ============================================================
    // DAILY POSTING: FULL BUSINESS VALIDATION, SAME AS CREATE
    //
    // A Daily Posting transaction's Document/Document No. identify a
    // real Bilty/Challan (or DIRECT, meaning no document). Editing it
    // is treated as EXACTLY the same business operation as posting a
    // brand-new Daily Posting line (see lib/daily-posting-validation.ts,
    // extracted from POST /api/daily-posting's own per-line logic) -
    // the only difference is that this ONE existing JournalEntry is
    // replaced in place rather than a new one being created, and its
    // OWN prior contribution is excluded before re-checking guards like
    // the Paid-verification ceiling (lib/bilty-paid-verification.ts).
    // Every other Cash Book row (referenceType e.g. SETTLEMENT, or
    // none) is completely unaffected - its existing free-text
    // document/documentNo behavior below is unchanged.
    // ============================================================

    const isDailyPosting = currentLine.journalEntry.referenceType === "DAILY_POSTING";

    // ============================================================
    // NEW VALUES
    // ============================================================

    const newDebit = debitAmount;
    const newCredit = creditAmount;

    // Counter account must always be opposite.
    const counterDebit =
      newCredit;

    const counterCredit =
      newDebit;

    if (isDailyPosting) {
      const requestedSourceType =
        typeof document === "string" && document.trim()
          ? document.trim()
          : currentLine.sourceType || "DIRECT";

      if (!DAILY_POSTING_SOURCE_TYPES.includes(requestedSourceType as DailyPostingSourceType)) {
        return NextResponse.json(
          { success: false, message: "Invalid document type" },
          { status: 400 }
        );
      }

      if (requestedSourceType === "CHALLAN" && !hasPermission(currentUser, "challan.view")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }
      if (requestedSourceType === "BILTY" && !hasPermission(currentUser, "bilty.view")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      try {
        const updatedEntry = await prisma.$transaction(
          async (tx) => {
            const finalSourceType: DailyPostingSourceType = requestedSourceType as DailyPostingSourceType;
            let finalSourceId: string | null = currentLine.sourceId;
            let finalSourceNumber: string | null = currentLine.sourceNumber;
            let finalCounterAccountId = counterLine.accountId;

            if (finalSourceType === "DIRECT") {
              finalSourceId = null;
              finalSourceNumber = null;
              // Counter account reassignment is not supported here -
              // same restriction already applied to the Main account.
            } else if (finalSourceType === "CHALLAN" || finalSourceType === "BILTY") {
              const requestedId =
                typeof requestedSourceId === "string" && requestedSourceId.trim()
                  ? requestedSourceId.trim()
                  : undefined;

              const effectiveSourceId =
                requestedId ||
                (finalSourceType === currentLine.sourceType ? currentLine.sourceId || undefined : undefined);

              if (!effectiveSourceId) {
                throw new DailyPostingValidationError("Source ID is required for document-linked entries");
              }

              // Same document (same type + same id) as before this edit?
              // Only then is the EXISTING Counter Account re-validated as
              // a manually-supplied one (never silently re-resolved away
              // from a party that was already fine). A genuinely changed
              // document has no existing Counter Account to fall back to
              // and must auto-resolve, exactly like a brand-new posting
              // with none supplied.
              const documentUnchanged =
                finalSourceType === currentLine.sourceType && effectiveSourceId === currentLine.sourceId;

              const resolved = await resolveDailyPostingLine({
                tx,
                mainAccountId: currentLine.accountId,
                mainCategory: currentLine.account.category,
                sourceType: finalSourceType,
                sourceId: effectiveSourceId,
                sourceNumber: typeof documentNo === "string" ? documentNo.trim() : undefined,
                counterAccountId: documentUnchanged ? counterLine.accountId : undefined,
              });

              finalSourceId = resolved.sourceId;
              finalSourceNumber = resolved.sourceNumber;
              finalCounterAccountId = resolved.counterAccountId;
            } else {
              // PARTY / PHONCH / BILL / ACCOUNT - free text, exactly like
              // Create's own lack of search-based validation for these
              // types. Counter account is not reassigned.
              finalSourceId = null;
              finalSourceNumber =
                typeof documentNo === "string" ? documentNo.trim() || null : currentLine.sourceNumber;
            }

            // PAID VERIFICATION CEILING - the entry's OWN prior
            // contribution is excluded (see
            // lib/bilty-paid-verification.ts's excludeJournalEntryId),
            // so only the NEW amount is checked against the Bilty's
            // truly remaining unverified Paid amount - never additive
            // against the old value being replaced.
            if (finalSourceType === "BILTY" && finalSourceId) {
              const mainDirection: "DEBIT" | "CREDIT" = newDebit > 0 ? "DEBIT" : "CREDIT";
              const mainAmount = newDebit > 0 ? newDebit : newCredit;
              await assertPaidVerificationNotExceeded(
                tx,
                finalSourceId,
                finalCounterAccountId,
                mainAmount,
                mainDirection,
                currentLine.journalEntryId
              );
            }

            const updatedJournalEntry = await tx.journalEntry.update({
              where: { id: currentLine.journalEntryId },
              data: {
                entryDate: new Date(`${date}T00:00:00`),
                description: description?.trim() || currentLine.journalEntry.description,
              },
            });

            await tx.journalLine.update({
              where: { id: currentLine.id },
              data: {
                description: description?.trim() || null,
                debit: newDebit,
                credit: newCredit,
                sourceType: finalSourceType,
                sourceId: finalSourceId,
                sourceNumber: finalSourceNumber,
              },
            });

            await tx.journalLine.update({
              where: { id: counterLine.id },
              data: {
                accountId: finalCounterAccountId,
                description: description?.trim() || null,
                debit: counterDebit,
                credit: counterCredit,
                sourceType: finalSourceType,
                sourceId: finalSourceId,
                sourceNumber: finalSourceNumber,
              },
            });

            return updatedJournalEntry;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );

        return NextResponse.json({
          success: true,
          message: "Transaction updated successfully",
          journalEntryId: updatedEntry.id,
        });
      } catch (error) {
        if (error instanceof DailyPostingValidationError) {
          return NextResponse.json(
            { success: false, message: error.message },
            { status: error.status }
          );
        }
        if (error instanceof BiltyPaidVerificationError) {
          return NextResponse.json(
            { success: false, code: error.code, message: error.message },
            { status: 400 }
          );
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          return NextResponse.json(
            {
              success: false,
              message: "Another Daily Posting change for the same Bilty/Challan happened at the same time. Please retry.",
            },
            { status: 409 }
          );
        }
        throw error;
      }
    }

    // ============================================================
    // UPDATE BOTH SIDES ATOMICALLY (non-Daily-Posting rows only -
    // unchanged free-text Document/Document No. behavior)
    // ============================================================

    const updatedEntry =
      await prisma.$transaction(
        async (tx) => {
          const updatedJournalEntry =
            await tx.journalEntry.update({
              where: {
                id:
                  currentLine.journalEntryId,
              },

              data: {
                entryDate:
                  new Date(`${date}T00:00:00`),

                description:
                  description?.trim() ||
                  currentLine.journalEntry.description,
              },
            });

          await tx.journalLine.update({
            where: {
              id: currentLine.id,
            },

            data: {
              description:
                description?.trim() ||
                null,

              debit: newDebit,

              credit: newCredit,

              sourceType:
                typeof document === "string" &&
                document.trim()
                  ? document.trim()
                  : currentLine.sourceType,

              sourceNumber:
                typeof documentNo === "string"
                  ? documentNo.trim() || null
                  : currentLine.sourceNumber,
            },
          });

          await tx.journalLine.update({
            where: {
              id: counterLine.id,
            },

            data: {
              description:
                description?.trim() ||
                null,

              debit: counterDebit,

              credit: counterCredit,

              sourceType:
                typeof document === "string" &&
                document.trim()
                  ? document.trim()
                  : counterLine.sourceType,

              sourceNumber:
                typeof documentNo === "string"
                  ? documentNo.trim() || null
                  : counterLine.sourceNumber,
            },
          });

          return updatedJournalEntry;
        }
      );

    // ============================================================
    // SUCCESS
    // ============================================================

    return NextResponse.json({
      success: true,
      message:
        "Transaction updated successfully",
      journalEntryId: updatedEntry.id,
    });
  } catch (error) {
    console.error(
      "Cash Book edit error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to update transaction",
      },
      { status: 500 }
    );
  }
}
export async function DELETE(
  request: NextRequest,
  context: {
    params: Promise<{ id: string }>;
  }
) {
  try {
    // ============================================================
    // AUTHENTICATION
    // ============================================================

    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    // ============================================================
    // PERMISSION
    // ============================================================

    if (!hasPermission(currentUser, "accountingTransactions.bin")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to move transactions to Bin.",
        },
        { status: 403 }
      );
    }

    // ============================================================
    // GET JOURNAL LINE ID
    // ============================================================

    const { id } = await context.params;

    if (!id) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction ID is required",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // FIND TRANSACTION
    // ============================================================

    const currentLine =
      await prisma.journalLine.findUnique({
        where: {
          id,
        },

        include: {
          journalEntry: {
            include: {
              lines: true,
            },
          },

          account: true,
        },
      });

    if (!currentLine) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction not found",
        },
        { status: 404 }
      );
    }

    // ============================================================
    // SAFETY CHECK
    // ============================================================

    if (
      currentLine.account.category !== "CASH" &&
      currentLine.account.category !== "BANK"
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction does not belong to a Cash/Bank account.",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // ALREADY IN BIN
    // ============================================================

    if (currentLine.journalEntry.isDeleted) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction is already in Bin.",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // AGE / SETTLED-DOCUMENT POLICY (operational safety only)
    //
    // SUPER_ADMIN is unrestricted here - unchanged. A MANAGER may
    // only bin a RECENT transaction that is not tied to an
    // already-settled Challan/Bilty. This is enforced here
    // regardless of what the frontend shows or hides, so a direct
    // API call cannot bypass it.
    // ============================================================

    if (currentUser.role !== "SUPER_ADMIN") {
      if (isOlderThanBinThreshold(currentLine.journalEntry.entryDate)) {
        return NextResponse.json(
          { success: false, message: BIN_REASON_TOO_OLD },
          { status: 403 }
        );
      }

      const linkedToSettled = await isLinkedToSettledDocument(
        prisma,
        currentLine.journalEntry.lines
      );

      if (linkedToSettled) {
        return NextResponse.json(
          { success: false, message: BIN_REASON_SETTLED_DOCUMENT },
          { status: 403 }
        );
      }
    }

    // ============================================================
    // SOFT DELETE
    //
    // DO NOT DELETE JOURNAL ENTRY.
    // DO NOT DELETE JOURNAL LINES.
    //
    // Only mark the JournalEntry as deleted.
    // ============================================================

    const deletedEntry =
      await prisma.journalEntry.update({
        where: {
          id: currentLine.journalEntryId,
        },

        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: currentUser.userId,
        },
      });

    // ============================================================
    // SUCCESS
    // ============================================================

    return NextResponse.json({
      success: true,
      message:
        "Transaction moved to Bin successfully.",
      journalEntryId: deletedEntry.id,
    });
  } catch (error) {
    console.error(
      "Cash Book soft delete error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to move transaction to Bin.",
      },
      { status: 500 }
    );
  }
}
