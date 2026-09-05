import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;

    const entry = await prisma.journalEntry.findFirst({
      where: {
        id,
        referenceType: "DAILY_POSTING",
        isDeleted: false,
      },
      include: {
        createdBy: {
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
                accountType: true,
                category: true,
                party: {
                  select: {
                    id: true,
                    partyName: true,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!entry) {
      return NextResponse.json(
        { success: false, message: "Daily posting not found" },
        { status: 404 }
      );
    }

    const totalDebit = entry.lines.reduce(
      (sum, line) => sum + Number(line.debit),
      0
    );

    const totalCredit = entry.lines.reduce(
      (sum, line) => sum + Number(line.credit),
      0
    );

    return NextResponse.json({
      success: true,
      entry: {
        ...entry,
        totalDebit,
        totalCredit,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
      },
    });
  } catch (error) {
    console.error("Get daily posting error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load daily posting" },
      { status: 500 }
    );
  }
}
