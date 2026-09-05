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

    const parties = await prisma.party.findMany({
      where: {
        isActive: true,
        account: {
          isNot: null,
        },
      },
      include: {
        account: {
          select: {
            id: true,
            accountName: true,
            accountCode: true,
          },
        },
      },
      orderBy: {
        partyName: "asc",
      },
    });

    const payable: {
      partyId: string;
      partyName: string;
      accountId: string;
      accountName: string;
      accountCode: string | null;
      totalDebit: number;
      totalCredit: number;
      balance: number;
    }[] = [];

    for (const party of parties) {
      if (!party.account) continue;

      const lines = await prisma.journalLine.findMany({
        where: {
          accountId: party.account.id,
          journalEntry: {
            is: {
              isDeleted: false,
            },
          },
        },
        select: {
          debit: true,
          credit: true,
        },
      });

      const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
      const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit), 0);
      const balance = totalDebit - totalCredit;

      if (balance < 0) {
        payable.push({
          partyId: party.id,
          partyName: party.partyName,
          accountId: party.account.id,
          accountName: party.account.accountName,
          accountCode: party.account.accountCode,
          totalDebit,
          totalCredit,
          balance: Math.abs(balance),
        });
      }
    }

    payable.sort((a, b) => b.balance - a.balance);

    const totalPayable = payable.reduce((sum, entry) => sum + entry.balance, 0);

    return NextResponse.json({
      success: true,
      payable,
      summary: {
        totalPayable,
        partyCount: payable.length,
      },
    });
  } catch (error) {
    console.error("Payable report API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load payable report" },
      { status: 500 }
    );
  }
}
