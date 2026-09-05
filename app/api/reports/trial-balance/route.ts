import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

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
    const asOfDate = searchParams.get("asOfDate");

    const dateFilter: { gte?: Date; lt?: Date } = {};

    if (asOfDate) {
      const end = new Date(`${asOfDate}T00:00:00`);
      end.setDate(end.getDate() + 1);

      if (!Number.isNaN(end.getTime())) {
        dateFilter.lt = end;
      }
    }

    const accounts = await prisma.account.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        accountName: true,
        accountCode: true,
        accountType: true,
        category: true,
      },
      orderBy: {
        accountCode: "asc",
      },
    });

    const lines = await prisma.journalLine.findMany({
      where: {
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

    const accountBalances = new Map<string, { debit: number; credit: number }>();

    for (const line of lines) {
      const existing = accountBalances.get(line.accountId) || { debit: 0, credit: 0 };
      existing.debit += Number(line.debit);
      existing.credit += Number(line.credit);
      accountBalances.set(line.accountId, existing);
    }

    const trialBalance = accounts
      .map((account) => {
        const balance = accountBalances.get(account.id) || { debit: 0, credit: 0 };
        const net = balance.debit - balance.credit;

        return {
          id: account.id,
          accountName: account.accountName,
          accountCode: account.accountCode,
          accountType: account.accountType,
          category: account.category,
          debit: net > 0 ? net : 0,
          credit: net < 0 ? Math.abs(net) : 0,
        };
      })
      .filter((entry) => entry.debit > 0 || entry.credit > 0);

    const totalDebit = trialBalance.reduce((sum, entry) => sum + entry.debit, 0);
    const totalCredit = trialBalance.reduce((sum, entry) => sum + entry.credit, 0);

    const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

    return NextResponse.json({
      success: true,
      trialBalance,
      summary: {
        totalDebit,
        totalCredit,
        isBalanced,
      },
      filters: {
        asOfDate: asOfDate || null,
      },
    });
  } catch (error) {
    console.error("Trial Balance API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load trial balance" },
      { status: 500 }
    );
  }
}
