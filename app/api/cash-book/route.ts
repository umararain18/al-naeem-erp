import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  BIN_REASON_TOO_OLD,
  BIN_REASON_SETTLED_DOCUMENT,
  BIN_REASON_OPENING_BALANCE,
  isOlderThanBinThreshold,
  findSettledChallanIds,
  findSettledBiltyIds,
} from "@/lib/cash-bank-bin-policy";
import { isOpeningBalanceReferenceType } from "@/lib/account-opening-balance";

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

    // Transaction search (distinct from accountSearch above, which
    // filters the Cash/Bank ACCOUNT picker) - narrows which lines are
    // DISPLAYED only, never the opening/closing balance. See its use
    // below, after the opening balance is computed from the FULL
    // pre-`from` history.
    const transactionSearch =
      (searchParams.get("q") || searchParams.get("transactionSearch"))?.trim().toLowerCase() || "";

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
        capabilities: {
          canEdit: hasPermission(currentUser, "accounts.edit"),
          canMoveToBin: hasPermission(
            currentUser,
            "accountingTransactions.bin"
          ),
        },
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

  journalEntry: {
    is: {
      isDeleted: false,

      // Opening Balance (referenceType "OPENING_BALANCE") never
      // appears as a daily transaction row here, regardless of
      // `from`/`to` - its own, unconditional contribution is fetched
      // separately below and surfaced as a dedicated summary field
      // instead. See lib/account-opening-balance.ts.
      referenceType: { not: "OPENING_BALANCE" },

      ...(Object.keys(dateFilter).length > 0
        ? {
            entryDate: dateFilter,
          }
        : {}),
    },
  },
},

        include: {
          journalEntry: {
            select: {
              id: true,
              entryDate: true,
              description: true,
              referenceType: true,
              referenceId: true,
              _count: {
                select: {
                  lines: true,
                },
              },
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
    // BIN ELIGIBILITY (operational safety only - see
    // lib/cash-bank-bin-policy.ts). SUPER_ADMIN is unrestricted;
    // for everyone else, batch-resolve which Challan/Bilty sources
    // referenced by this page's lines are already settled, once,
    // instead of a query per line.
    // ============================================================

    const isSuperAdmin = currentUser.role === "SUPER_ADMIN";
    const hasBinPermission = hasPermission(currentUser, "accountingTransactions.bin");

    let settledChallanIds = new Set<string>();
    let settledBiltyIds = new Set<string>();

    if (hasBinPermission && !isSuperAdmin) {
      const challanIds = new Set<string>();
      const biltyIds = new Set<string>();
      for (const line of journalLines) {
        if (line.sourceType === "CHALLAN" && line.sourceId) challanIds.add(line.sourceId);
        if (line.sourceType === "BILTY" && line.sourceId) biltyIds.add(line.sourceId);
      }
      [settledChallanIds, settledBiltyIds] = await Promise.all([
        findSettledChallanIds(prisma, [...challanIds]),
        findSettledBiltyIds(prisma, [...biltyIds]),
      ]);
    }

    function binEligibility(line: (typeof journalLines)[number]): {
      canMoveToBin: boolean;
      binProtectedReason: string | null;
    } {
      // Opening Balance is never movable to Bin here, for anyone -
      // checked before the Super Admin bypass below, unlike the
      // age/settled-document policy, which Super Admin can override.
      if (isOpeningBalanceReferenceType(line.journalEntry.referenceType)) {
        return { canMoveToBin: false, binProtectedReason: BIN_REASON_OPENING_BALANCE };
      }

      if (!hasBinPermission) return { canMoveToBin: false, binProtectedReason: null };
      if (isSuperAdmin) return { canMoveToBin: true, binProtectedReason: null };

      if (isOlderThanBinThreshold(line.journalEntry.entryDate)) {
        return { canMoveToBin: false, binProtectedReason: BIN_REASON_TOO_OLD };
      }

      const linkedToSettled =
        (line.sourceType === "CHALLAN" && !!line.sourceId && settledChallanIds.has(line.sourceId)) ||
        (line.sourceType === "BILTY" && !!line.sourceId && settledBiltyIds.has(line.sourceId));

      if (linkedToSettled) {
        return { canMoveToBin: false, binProtectedReason: BIN_REASON_SETTLED_DOCUMENT };
      }

      return { canMoveToBin: true, binProtectedReason: null };
    }

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

        canEdit:
          hasPermission(currentUser, "accounts.edit") &&
          line.journalEntry._count.lines === 2 &&
          !isOpeningBalanceReferenceType(line.journalEntry.referenceType),

        isEditableStructure:
          line.journalEntry._count.lines === 2,

        ...binEligibility(line),
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
    // OPENING BALANCE - all qualifying activity BEFORE `from`, the
    // same aggregate pattern General/Party/Employee Ledger already
    // use (never calculated from only the displayed/matching rows).
    // No `from` selected (or "All Time") -> 0, same as before.
    // ============================================================

    // Opening Balance's own, always-unconditional contribution -
    // counts here regardless of whether `from` is set at all, never
    // mixed into the "qualifying activity before `from`" sum below
    // (which now also excludes it, to avoid double-counting once
    // `from` is set after the account's own OPENING_BALANCE entry).
    const openingBalanceLines = await prisma.journalLine.findMany({
      where: {
        accountId: selectedAccount.id,
        journalEntry: { is: { isDeleted: false, referenceType: "OPENING_BALANCE" } },
      },
      select: { debit: true, credit: true },
    });
    const openingBalanceFromEntry = openingBalanceLines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0);
    const hasOpeningBalanceEntry = openingBalanceLines.length > 0;

    let openingBalance = openingBalanceFromEntry;

    if (from) {
      const openingLines = await prisma.journalLine.findMany({
        where: {
          accountId: selectedAccount.id,
          journalEntry: { is: { isDeleted: false, referenceType: { not: "OPENING_BALANCE" }, entryDate: { lt: startOfDay(from) } } },
        },
        select: { debit: true, credit: true },
      });
      openingBalance += openingLines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0);
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
    // ============================================================

    let runningBalance = openingBalance;

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

// Calculate summary BEFORE reversing/filtering
// the array for UI display - never affected by
// transaction search, matching every other ledger.

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

const closingBalance =
  chronologicalDaysResult.length > 0
    ? chronologicalDaysResult[
        chronologicalDaysResult.length - 1
      ].closingBalance
    : openingBalance;

// ============================================================
// TRANSACTION SEARCH - narrows which entries are DISPLAYED
// within each day only; each entry's own `balance` (computed
// above from the complete, unfiltered period) is never
// recomputed. Matches Bilty No/Challan No (documentNo, already
// the canonical number - see app/api/daily-posting/route.ts),
// description, and account name. A day with no matching entries
// is dropped entirely; a day with at least one match keeps only
// its matching entries, still under that same day.
// ============================================================

function matchesSearch(entry: (typeof chronologicalDaysResult)[number]["entries"][number]): boolean {
  if (!transactionSearch) return true;
  return (
    entry.documentNo.toLowerCase().includes(transactionSearch) ||
    entry.description.toLowerCase().includes(transactionSearch) ||
    entry.account.toLowerCase().includes(transactionSearch) ||
    entry.document.toLowerCase().includes(transactionSearch)
  );
}

// Newest date group first, and newest transaction first WITHIN
// each day (the per-day `entries` above are chronological asc,
// needed for the balance calculation - reversed here, display
// only, same "calculate forward, reverse for display" rule as
// every other ledger).
const days = [...chronologicalDaysResult]
  .reverse()
  .map((day) => ({ ...day, entries: [...day.entries].reverse().filter(matchesSearch) }))
  .filter((day) => day.entries.length > 0 || !transactionSearch);

const resultCount = transactionSearch
  ? days.reduce((sum, day) => sum + day.entries.length, 0)
  : null;
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
      resultCount,
      // Opening Balance - rendered as a dedicated line above the day
      // list, never as a day/transaction row, and never affected by
      // `from`/`to` or search. null when this account has never had
      // one set (the overwhelming majority of accounts).
      openingBalanceEntry: hasOpeningBalanceEntry
        ? { amount: Math.abs(openingBalanceFromEntry), direction: openingBalanceFromEntry >= 0 ? "DEBIT" : "CREDIT" }
        : null,
      filters: { from: from || null, to: to || null, search: transactionSearch || null },
      capabilities: {
        canEdit: hasPermission(currentUser, "accounts.edit"),
        canMoveToBin: hasPermission(
          currentUser,
          "accountingTransactions.bin"
        ),
      },
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
