import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

function startOfDay(date: string) {
  return new Date(`${date}T00:00:00`);
}

function endOfDay(date: string) {
  const end = new Date(`${date}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return end;
}

export async function GET(request: NextRequest) {
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

    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    // ============================================================
    // QUERY PARAMETERS
    // ============================================================

    const { searchParams } = new URL(request.url);

    const accountId =
      searchParams.get("accountId");

    const from =
      searchParams.get("from");

    const to =
      searchParams.get("to");

    const accountSearch =
      searchParams.get("accountSearch");

    // ============================================================
    // LOAD CASH + BANK ACCOUNTS
    //
    // Dynamic:
    // Any future CASH/BANK account automatically appears.
    // ============================================================

    const accounts =
      await prisma.account.findMany({
        where: {
          isActive: true,

          OR: [
            {
              category: "CASH",
            },
            {
              category: "BANK",
            },
          ],

          ...(accountSearch
            ? {
                accountName: {
                  contains: accountSearch,
                  mode: "insensitive",
                },
              }
            : {}),
        },

        select: {
          id: true,
          accountName: true,
          accountCode: true,
          accountType: true,
          category: true,
          isActive: true,
        },

        orderBy: {
          accountName: "asc",
        },
      });

    // ============================================================
    // IF NO ACCOUNT SELECTED
    //
    // Return accounts so frontend can populate selector.
    // ============================================================

    if (!accountId) {
      return NextResponse.json({
        success: true,
        accounts,
        selectedAccount: null,
        days: [],
      });
    }

    // ============================================================
    // VERIFY SELECTED ACCOUNT
    // ============================================================

    const selectedAccount =
      await prisma.account.findFirst({
        where: {
          id: accountId,
          isActive: true,

          OR: [
            {
              category: "CASH",
            },
            {
              category: "BANK",
            },
          ],
        },

        select: {
          id: true,
          accountName: true,
          accountCode: true,
          accountType: true,
          category: true,
          isActive: true,
        },
      });

    if (!selectedAccount) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Selected Cash/Bank account not found",
        },
        { status: 404 }
      );
    }

    // ============================================================
    // DATE FILTER
    // ============================================================

    const dateFilter: {
      gte?: Date;
      lt?: Date;
    } = {};

    if (from) {
      const start = startOfDay(from);

      if (Number.isNaN(start.getTime())) {
        return NextResponse.json(
          {
            success: false,
            message: "Invalid from date",
          },
          { status: 400 }
        );
      }

      dateFilter.gte = start;
    }

    if (to) {
      const end = endOfDay(to);

      if (Number.isNaN(end.getTime())) {
        return NextResponse.json(
          {
            success: false,
            message: "Invalid to date",
          },
          { status: 400 }
        );
      }

      dateFilter.lt = end;
    }

    // ============================================================
    // LOAD JOURNAL LINES
    //
    // JournalLine is the source of truth.
    // ============================================================

    const journalLines =
      await prisma.journalLine.findMany({
        where: {
          accountId: selectedAccount.id,

          ...(Object.keys(dateFilter).length > 0
            ? {
                journalEntry: {
                  entryDate: dateFilter,
                },
              }
            : {}),
        },

        include: {
          journalEntry: {
            select: {
              id: true,
              entryDate: true,
              description: true,
              referenceType: true,
              referenceId: true,
            },
          },

          account: {
            select: {
              id: true,
              accountName: true,
              accountCode: true,
              accountType: true,
              category: true,
            },
          },
        },

        orderBy: [
          {
            journalEntry: {
              entryDate: "asc",
            },
          },
          {
            createdAt: "asc",
          },
        ],
      });

    // ============================================================
    // CONVERT DECIMAL VALUES
    // ============================================================

    const normalizedLines = journalLines.map(
      (line) => ({
        id: line.id,

        date: new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(line.journalEntry.entryDate),

        document:
          line.sourceType || "DIRECT",

        documentNo:
          line.sourceNumber || "",

        account: line.account.accountName,

        description:
          line.description ||
          line.journalEntry.description ||
          "",

        debit: Number(line.debit),

        credit: Number(line.credit),

        journalEntryId:
          line.journalEntryId,

        referenceType:
          line.journalEntry.referenceType,

        referenceId:
          line.journalEntry.referenceId,
      })
    );

    // ============================================================
    // GROUP BY DATE
    // ============================================================

    const grouped = new Map<
      string,
      typeof normalizedLines
    >();

    for (const line of normalizedLines) {
      const existing =
        grouped.get(line.date) || [];

      grouped.set(line.date, [
        ...existing,
        line,
      ]);
    }

    // ============================================================
    // CALCULATE RUNNING BALANCE
    //
    // For CASH/BANK:
    //
    // Debit  = money coming in
    // Credit = money going out
    //
    // Balance = Opening + Debit - Credit
    //
    // Current opening balance is 0 here.
    // We will connect real account opening balance
    // once that field is finalized in Account.
    // ============================================================

    let runningBalance = 0;

    const chronologicalDays = Array.from(
      grouped.entries()
    ).map(([date, lines]) => {
      let dayDebit = 0;
      let dayCredit = 0;

      const entries = lines.map((line) => {
        dayDebit += line.debit;
        dayCredit += line.credit;

        runningBalance =
          runningBalance +
          line.debit -
          line.credit;

        return {
          ...line,
          balance: runningBalance,
        };
      });

      return {
        date,

        entries,

        openingBalance:
          runningBalance -
          dayDebit +
          dayCredit,

        totalDebit: dayDebit,

        totalCredit: dayCredit,

        closingBalance:
          runningBalance,
      };
    });

    // ============================================================
    // LATEST DATE FIRST FOR UI
    // ============================================================

    // Keep chronological order for calculations.
const chronologicalDaysResult =
  chronologicalDays;

// Calculate summary BEFORE reversing
// the array for UI display.

const totalDebit =
  chronologicalDaysResult.reduce(
    (sum, day) =>
      sum + day.totalDebit,
    0
  );

const totalCredit =
  chronologicalDaysResult.reduce(
    (sum, day) =>
      sum + day.totalCredit,
    0
  );

const openingBalance =
  chronologicalDaysResult.length > 0
    ? chronologicalDaysResult[0].openingBalance
    : 0;

const closingBalance =
  chronologicalDaysResult.length > 0
    ? chronologicalDaysResult[
        chronologicalDaysResult.length - 1
      ].closingBalance
    : openingBalance;

// Only reverse for display.
// Calculations remain chronological.
const days =
  [...chronologicalDaysResult].reverse();
    return NextResponse.json({
      success: true,

      accounts,

      selectedAccount,

      summary: {
        openingBalance,
        totalDebit,
        totalCredit,
        closingBalance,
      },

      days,
    });
  } catch (error) {
    console.error(
      "Cash Book API error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to load Cash Book",
      },
      { status: 500 }
    );
  }
}