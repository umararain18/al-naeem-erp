import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { accumulateBalances, netExpense, netIncome } from "@/lib/pnl";

function startOfDay(date: string) {
  return new Date(`${date}T00:00:00`);
}

function endOfDay(date: string) {
  const end = startOfDay(date);
  end.setDate(end.getDate() + 1);
  return end;
}

function getCurrentMonthRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  return { start, end };
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

    const canViewFinancials = hasPermission(currentUser, "reports.view");
    const canViewBiltyStats = hasPermission(currentUser, "bilty.view");
    const canViewChallanStats = hasPermission(currentUser, "challan.view");
    const canViewAccountingActivity = hasPermission(currentUser, "accounts.view");

    const data: any = {
      success: true,
      capabilities: {
        canViewFinancials,
        canViewBiltyStats,
        canViewChallanStats,
        canViewAccountingActivity,
      },
    };

    if (canViewFinancials) {
      const receivable = await prisma.party.findMany({
        where: {
          isActive: true,
          account: { isNot: null },
        },
        include: { account: { select: { id: true } } },
      });

      const receivableTotals = await prisma.journalLine.findMany({
        where: {
          accountId: { in: receivable.map((p) => p.account!.id) },
          journalEntry: { is: { isDeleted: false } },
        },
        select: { accountId: true, debit: true, credit: true },
      });

      const accountBalances = new Map<string, { debit: number; credit: number }>();
      for (const line of receivableTotals) {
        const existing = accountBalances.get(line.accountId) || { debit: 0, credit: 0 };
        existing.debit += Number(line.debit);
        existing.credit += Number(line.credit);
        accountBalances.set(line.accountId, existing);
      }

      let totalReceivable = 0;
      for (const party of receivable) {
        if (!party.account) continue;
        const balance = accountBalances.get(party.account.id) || { debit: 0, credit: 0 };
        if (balance.debit - balance.credit > 0) {
          totalReceivable += balance.debit - balance.credit;
        }
      }

      const payable = await prisma.party.findMany({
        where: {
          isActive: true,
          account: { isNot: null },
        },
        include: { account: { select: { id: true } } },
      });

      const payableTotals = await prisma.journalLine.findMany({
        where: {
          accountId: { in: payable.map((p) => p.account!.id) },
          journalEntry: { is: { isDeleted: false } },
        },
        select: { accountId: true, debit: true, credit: true },
      });

      const payableBalances = new Map<string, { debit: number; credit: number }>();
      for (const line of payableTotals) {
        const existing = payableBalances.get(line.accountId) || { debit: 0, credit: 0 };
        existing.debit += Number(line.debit);
        existing.credit += Number(line.credit);
        payableBalances.set(line.accountId, existing);
      }

      let totalPayable = 0;
      for (const party of payable) {
        if (!party.account) continue;
        const balance = payableBalances.get(party.account.id) || { debit: 0, credit: 0 };
        if (balance.credit - balance.debit > 0) {
          totalPayable += balance.credit - balance.debit;
        }
      }

      const { start: monthStart, end: monthEnd } = getCurrentMonthRange();

      const incomeExpenseAccounts = await prisma.account.findMany({
        where: {
          isActive: true,
          accountType: { in: ["INCOME", "EXPENSE"] },
        },
        select: { id: true, accountType: true },
      });

      const incomeExpenseIds = incomeExpenseAccounts.map((a) => a.id);
      const incomeAccountIds = incomeExpenseAccounts
        .filter((a) => a.accountType === "INCOME")
        .map((a) => a.id);
      const expenseAccountIds = incomeExpenseAccounts
        .filter((a) => a.accountType === "EXPENSE")
        .map((a) => a.id);

      const monthlyLines = await prisma.journalLine.findMany({
        where: {
          accountId: { in: incomeExpenseIds },
          journalEntry: {
            is: {
              isDeleted: false,
              entryDate: { gte: monthStart, lt: monthEnd },
            },
          },
        },
        select: { accountId: true, debit: true, credit: true },
      });

      const monthlyAccountBalances = accumulateBalances(monthlyLines);

      let monthlyIncome = 0;
      let monthlyExpense = 0;

      for (const account of incomeExpenseAccounts) {
        const balance = monthlyAccountBalances.get(account.id);
        if (account.accountType === "INCOME") {
          monthlyIncome += netIncome(balance);
        } else if (account.accountType === "EXPENSE") {
          monthlyExpense += netExpense(balance);
        }
      }

      const monthlyProfit = monthlyIncome - monthlyExpense;

      const cashBankAccounts = await prisma.account.findMany({
        where: {
          isActive: true,
          OR: [{ category: "CASH" }, { category: "BANK" }],
        },
        select: { id: true, accountName: true, category: true },
      });

      const cashBankIds = cashBankAccounts.map((a) => a.id);
      const cashBankLines = await prisma.journalLine.findMany({
        where: {
          accountId: { in: cashBankIds },
          journalEntry: { is: { isDeleted: false } },
        },
        select: { accountId: true, debit: true, credit: true },
      });

      const cashBankBalances = new Map<string, { debit: number; credit: number }>();
      for (const line of cashBankLines) {
        const existing = cashBankBalances.get(line.accountId) || { debit: 0, credit: 0 };
        existing.debit += Number(line.debit);
        existing.credit += Number(line.credit);
        cashBankBalances.set(line.accountId, existing);
      }

      let cashBalance = 0;
      let bankBalance = 0;

      for (const account of cashBankAccounts) {
        const balance = cashBankBalances.get(account.id) || { debit: 0, credit: 0 };
        const net = balance.debit - balance.credit;
        if (account.category === "CASH") {
          cashBalance += net;
        } else if (account.category === "BANK") {
          bankBalance += net;
        }
      }

      data.financials = {
        receivable: Math.round(totalReceivable),
        payable: Math.round(totalPayable),
        cashBalance: Math.round(cashBalance),
        bankBalance: Math.round(bankBalance),
        monthlyIncome: Math.round(monthlyIncome),
        monthlyExpense: Math.round(monthlyExpense),
        monthlyProfit: Math.round(monthlyProfit),
      };

      // Purely informational - identifies which account(s) the
      // Cash/Bank totals above belong to, so the UI can drill down
      // to the exact Cash Book account when there is only one.
      data.cashAccounts = cashBankAccounts
        .filter((a) => a.category === "CASH")
        .map((a) => ({ id: a.id, accountName: a.accountName }));
      data.bankAccounts = cashBankAccounts
        .filter((a) => a.category === "BANK")
        .map((a) => ({ id: a.id, accountName: a.accountName }));

      const { start: monthStartForRange, end: monthEndForRange } = getCurrentMonthRange();
      data.monthlyRange = {
        from: monthStartForRange.toISOString().split("T")[0],
        // "to" is inclusive for the UI/report filter, so use the
        // last day actually in range, not the exclusive end bound.
        to: new Date(monthEndForRange.getTime() - 86400000).toISOString().split("T")[0],
      };
    }

    if (canViewBiltyStats) {
      const [
        totalBilties,
        pendingBilties,
        inTransitBilties,
        deliveredBilties,
        cancelledBilties,
      ] = await Promise.all([
        prisma.bilty.count({ where: { isDeleted: false } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "PENDING" } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "IN_TRANSIT" } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "DELIVERED" } }),
        prisma.bilty.count({ where: { isDeleted: false, status: "CANCELLED" } }),
      ]);

      data.biltyStats = {
        total: totalBilties,
        pending: pendingBilties,
        inTransit: inTransitBilties,
        delivered: deliveredBilties,
        cancelled: cancelledBilties,
      };
    }

    if (canViewChallanStats) {
      const [
        totalChallans,
        activeChallans,
        deliveredChallans,
        settledChallans,
      ] = await Promise.all([
        prisma.challan.count({ where: { isDeleted: false } }),
        prisma.challan.count({ where: { isDeleted: false, status: "IN_TRANSIT" } }),
        prisma.challan.count({ where: { isDeleted: false, status: "DELIVERED" } }),
        prisma.challan.count({ where: { isDeleted: false, isSettled: true } }),
      ]);

      data.challanStats = {
        total: totalChallans,
        active: activeChallans,
        delivered: deliveredChallans,
        settled: settledChallans,
      };
    }

    if (canViewBiltyStats) {
      const recentBilties = await prisma.bilty.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          biltyNo: true,
          date: true,
          status: true,
          toPay: true,
          fromLocation: { select: { name: true } },
          toLocation: { select: { name: true } },
        },
      });

      data.recentBilties = recentBilties;
    }

    if (canViewChallanStats) {
      const recentChallans = await prisma.challan.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          challanNo: true,
          loadingDate: true,
          status: true,
          isSettled: true,
          transporterParty: { select: { partyName: true } },
        },
      });

      data.recentChallans = recentChallans;
    }

    if (canViewAccountingActivity) {
      const recentEntries = await prisma.journalEntry.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          entryDate: true,
          referenceType: true,
          referenceId: true,
          description: true,
          lines: { select: { debit: true, credit: true } },
        },
      });

      const recentPostings = await prisma.journalEntry.findMany({
        where: { isDeleted: false, referenceType: "DAILY_POSTING" },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          entryDate: true,
          referenceType: true,
          referenceId: true,
          description: true,
          lines: { select: { debit: true, credit: true } },
        },
      });

      data.recentAccountingEntries = recentEntries.map((entry) => ({
        id: entry.id,
        entryDate: entry.entryDate,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        description: entry.description,
        totalDebit: entry.lines.reduce((sum, line) => sum + Number(line.debit), 0),
        totalCredit: entry.lines.reduce((sum, line) => sum + Number(line.credit), 0),
      }));

      data.recentDailyPostings = recentPostings.map((entry) => ({
        id: entry.id,
        entryDate: entry.entryDate,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        description: entry.description,
        totalDebit: entry.lines.reduce((sum, line) => sum + Number(line.debit), 0),
        totalCredit: entry.lines.reduce((sum, line) => sum + Number(line.credit), 0),
      }));
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Dashboard API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load dashboard" },
      { status: 500 }
    );
  }
}
