import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { accumulateBalances, netExpense, netIncome } from "@/lib/pnl";

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "reports.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const dateFilter: { gte?: Date; lt?: Date } = {};

    if (from) {
      const start = new Date(`${from}T00:00:00`);
      if (!Number.isNaN(start.getTime())) {
        dateFilter.gte = start;
      }
    }

    if (to) {
      const end = new Date(`${to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      if (!Number.isNaN(end.getTime())) {
        dateFilter.lt = end;
      }
    }

    const accounts = await prisma.account.findMany({
      where: {
        isActive: true,
        accountType: {
          in: ["INCOME", "EXPENSE"],
        },
      },
      select: {
        id: true,
        accountName: true,
        accountCode: true,
        accountType: true,
        category: true,
      },
      orderBy: {
        accountType: "asc",
      },
    });

    const lines = await prisma.journalLine.findMany({
      where: {
        accountId: {
          in: accounts.map((a) => a.id),
        },
        journalEntry: {
          is: {
            isDeleted: false,
            ...(Object.keys(dateFilter).length > 0 ? { entryDate: dateFilter } : {}),
          },
        },
      },
      select: {
        accountId: true,
        debit: true,
        credit: true,
      },
    });

    const accountBalances = accumulateBalances(lines);

    const incomeAccounts = accounts
      .filter((a) => a.accountType === "INCOME")
      .map((account) => ({
        id: account.id,
        accountName: account.accountName,
        accountCode: account.accountCode,
        category: account.category,
        amount: netIncome(accountBalances.get(account.id)),
      }));

    const expenseAccounts = accounts
      .filter((a) => a.accountType === "EXPENSE")
      .map((account) => ({
        id: account.id,
        accountName: account.accountName,
        accountCode: account.accountCode,
        category: account.category,
        amount: netExpense(accountBalances.get(account.id)),
      }));

    const totalIncome = incomeAccounts.reduce((sum, entry) => sum + entry.amount, 0);
    const totalExpenses = expenseAccounts.reduce((sum, entry) => sum + entry.amount, 0);
    const netProfit = totalIncome - totalExpenses;

    return NextResponse.json({
      success: true,
      income: incomeAccounts,
      expenses: expenseAccounts,
      summary: {
        totalIncome,
        totalExpenses,
        netProfit,
      },
      filters: {
        from: from || null,
        to: to || null,
      },
    });
  } catch (error) {
    console.error("Profit & Loss API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load profit and loss" },
      { status: 500 }
    );
  }
}
