import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

function startOfDay(value: string) {
  return new Date(`${value}T00:00:00`);
}

function endOfDay(value: string) {
  const end = startOfDay(value);
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

    if (!hasPermission(currentUser, "accountingTransactions.binView")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search")?.trim();

    const deletedAt: { gte?: Date; lt?: Date } = {};

    if (from) {
      const date = startOfDay(from);
      if (Number.isNaN(date.getTime())) {
        return NextResponse.json(
          { success: false, message: "Invalid from date" },
          { status: 400 }
        );
      }
      deletedAt.gte = date;
    }

    if (to) {
      const date = endOfDay(to);
      if (Number.isNaN(date.getTime())) {
        return NextResponse.json(
          { success: false, message: "Invalid to date" },
          { status: 400 }
        );
      }
      deletedAt.lt = date;
    }

    const entries = await prisma.journalEntry.findMany({
      where: {
        isDeleted: true,
        ...(Object.keys(deletedAt).length > 0 ? { deletedAt } : {}),
        ...(search
          ? {
              OR: [
                { description: { contains: search, mode: "insensitive" } },
                { referenceType: { contains: search, mode: "insensitive" } },
                { referenceId: { contains: search, mode: "insensitive" } },
                {
                  lines: {
                    some: {
                      OR: [
                        { sourceType: { contains: search, mode: "insensitive" } },
                        { sourceNumber: { contains: search, mode: "insensitive" } },
                        {
                          account: {
                            is: {
                              accountName: {
                                contains: search,
                                mode: "insensitive",
                              },
                            },
                          },
                        },
                        {
                          account: {
                            is: {
                              party: {
                                is: {
                                  partyName: {
                                    contains: search,
                                    mode: "insensitive",
                                  },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        deletedBy: {
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
                party: {
                  select: {
                    id: true,
                    partyName: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: [{ deletedAt: "desc" }, { entryDate: "desc" }],
    });

    const transactions = entries.map((entry) => {
      const totalDebit = entry.lines.reduce(
        (sum, line) => sum + Number(line.debit),
        0
      );
      const totalCredit = entry.lines.reduce(
        (sum, line) => sum + Number(line.credit),
        0
      );
      const accounts = Array.from(
        new Map(
          entry.lines.map((line) => [line.account.id, line.account])
        ).values()
      );
      const parties = accounts
        .flatMap((account) => (account.party ? [account.party] : []))
        .filter(
          (party, index, values) =>
            values.findIndex((value) => value.id === party.id) === index
        );

      return {
        ...entry,
        totalDebit,
        totalCredit,
        amount: totalDebit,
        accounts,
        parties,
        journalLineCount: entry.lines.length,
      };
    });

    return NextResponse.json({
      success: true,
      transactions,
      capabilities: {
        canRestore: hasPermission(currentUser, "accountingTransactions.restore"),
        canPermanentlyDelete: hasPermission(
          currentUser,
          "accountingTransactions.permanentlyDelete"
        ),
      },
    });
  } catch (error) {
    console.error("Get accounting transaction Bin error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load the Accounting Transaction Bin" },
      { status: 500 }
    );
  }
}
