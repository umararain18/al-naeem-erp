import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

function startOfDay(value: string) {
  return new Date(`${value}T00:00:00`);
}

function endOfDay(value: string) {
  const end = new Date(`${value}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return end;
}

export async function GET(request: NextRequest) {
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

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get("accountId");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search")?.trim();

    const dateFilter: { gte?: Date; lt?: Date } = {};

    if (from) {
      const start = startOfDay(from);
      if (!Number.isNaN(start.getTime())) {
        dateFilter.gte = start;
      }
    }

    if (to) {
      const end = endOfDay(to);
      if (!Number.isNaN(end.getTime())) {
        dateFilter.lt = end;
      }
    }

    const accounts = await prisma.account.findMany({
      where: {
        isActive: true,
        ...(search
          ? {
              OR: [
                { accountName: { contains: search, mode: "insensitive" } },
                { accountCode: { contains: search, mode: "insensitive" } },
              ],
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
        partyId: true,
        party: {
          select: {
            id: true,
            partyName: true,
          },
        },
      },
      orderBy: {
        accountCode: "asc",
      },
    });

    if (!accountId) {
      return NextResponse.json({
        success: true,
        accounts,
        selectedAccount: null,
        entries: [],
        summary: null,
      });
    }

    const selectedAccount = accounts.find((a) => a.id === accountId);

    if (!selectedAccount) {
      return NextResponse.json(
        { success: false, message: "Account not found" },
        { status: 404 }
      );
    }

    const entries = await prisma.journalLine.findMany({
      where: {
        accountId,
        journalEntry: {
          is: {
            isDeleted: false,
            ...(Object.keys(dateFilter).length > 0 ? { entryDate: dateFilter } : {}),
          },
        },
      },
      include: {
        journalEntry: {
          select: {
            id: true,
            entryDate: true,
            referenceType: true,
            referenceId: true,
            description: true,
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

    let runningBalance = 0;

    const normalizedEntries = entries.map((entry) => {
      const debit = Number(entry.debit);
      const credit = Number(entry.credit);
      runningBalance += debit - credit;

      return {
        id: entry.id,
        journalEntryId: entry.journalEntryId,
        date: new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Karachi",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(entry.journalEntry.entryDate),
        referenceType: entry.journalEntry.referenceType,
        referenceId: entry.journalEntry.referenceId,
        // Per-line source (JournalLine.sourceType/sourceId/
        // sourceNumber) - already part of the existing accounting
        // architecture, just exposed here for navigation.
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        sourceNumber: entry.sourceNumber,
        description: entry.description || entry.journalEntry.description || "",
        debit,
        credit,
        balance: runningBalance,
      };
    });

    const totalDebit = normalizedEntries.reduce((sum, entry) => sum + entry.debit, 0);
    const totalCredit = normalizedEntries.reduce((sum, entry) => sum + entry.credit, 0);

    // Normal ERP screen: newest -> oldest. The running balance above
    // is calculated chronologically (oldest -> newest) since each
    // row's balance depends on every prior one - only the FINISHED
    // array is reversed for display; each entry's own `balance`
    // value is unaffected by this reversal.
    const displayEntries = [...normalizedEntries].reverse();

    let openingBalance = 0;

    if (Object.keys(dateFilter).length > 0 && from) {
      const openingEntries = await prisma.journalLine.findMany({
        where: {
          accountId,
          journalEntry: {
            is: {
              isDeleted: false,
              entryDate: {
                lt: startOfDay(from),
              },
            },
          },
        },
        select: {
          debit: true,
          credit: true,
        },
      });

      openingBalance = openingEntries.reduce((sum, entry) => sum + Number(entry.debit) - Number(entry.credit), 0);
    }

    const closingBalance = openingBalance + totalDebit - totalCredit;

    return NextResponse.json({
      success: true,
      accounts,
      selectedAccount: {
        id: selectedAccount.id,
        accountName: selectedAccount.accountName,
        accountCode: selectedAccount.accountCode,
        accountType: selectedAccount.accountType,
        category: selectedAccount.category,
        party: selectedAccount.party,
      },
      entries: displayEntries,
      summary: {
        openingBalance,
        totalDebit,
        totalCredit,
        closingBalance,
      },
      filters: {
        from: from || null,
        to: to || null,
      },
    });
  } catch (error) {
    console.error("General Ledger API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load ledger" },
      { status: 500 }
    );
  }
}
