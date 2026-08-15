import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

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
    // NEW VALUES
    // ============================================================

    const newDebit = debitAmount;
    const newCredit = creditAmount;

    // Counter account must always be opposite.
    const counterDebit =
      newCredit;

    const counterCredit =
      newDebit;

    // ============================================================
    // UPDATE BOTH SIDES ATOMICALLY
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
