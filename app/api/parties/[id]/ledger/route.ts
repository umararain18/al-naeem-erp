import {
  NextRequest,
  NextResponse,
} from "next/server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function GET(
  _request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  }
) {
  try {
    const currentUser =
      await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    if (
      !hasPermission(
        currentUser,
        "parties.view"
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    // ---------------------------------------------
    // FIND PARTY + ITS ONE ACCOUNT
    // ---------------------------------------------

    const party =
      await prisma.party.findUnique({
        where: {
          id,
        },

        include: {
          account: true,
        },
      });

    if (!party) {
      return NextResponse.json(
        {
          success: false,
          message: "Party not found",
        },
        { status: 404 }
      );
    }

    if (!party.account) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This party does not have an account yet.",
        },
        { status: 404 }
      );
    }

    // ---------------------------------------------
    // GET ALL LEDGER ENTRIES
    // ---------------------------------------------

    const entries =
      await prisma.journalLine.findMany({
        where: {
          accountId:
            party.account.id,
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

        orderBy: {
          journalEntry: {
            entryDate: "asc",
          },
        },
      });

    // ---------------------------------------------
    // CALCULATE RUNNING BALANCE
    // ---------------------------------------------

    let runningBalance = 0;

    const ledger = entries.map(
      (entry) => {
        const debit = Number(
          entry.debit
        );

        const credit = Number(
          entry.credit
        );

        runningBalance +=
          debit - credit;

        let balanceType:
          | "RECEIVABLE"
          | "PAYABLE"
          | "SETTLED";

        if (runningBalance > 0) {
          balanceType =
            "RECEIVABLE";
        } else if (
          runningBalance < 0
        ) {
          balanceType =
            "PAYABLE";
        } else {
          balanceType = "SETTLED";
        }

        return {
          id: entry.id,

          date:
            entry.journalEntry
              .entryDate,

          referenceType:
            entry.journalEntry
              .referenceType,

          referenceId:
            entry.journalEntry
              .referenceId,

          description:
            entry.description ||
            entry.journalEntry
              .description,

          debit,

          credit,

          balance:
            Math.abs(
              runningBalance
            ),

          balanceType,
        };
      }
    );

    // ---------------------------------------------
    // TOTALS
    // ---------------------------------------------

    const totalDebit =
      entries.reduce(
        (sum, entry) =>
          sum +
          Number(entry.debit),
        0
      );

    const totalCredit =
      entries.reduce(
        (sum, entry) =>
          sum +
          Number(entry.credit),
        0
      );

    const netBalance =
      totalDebit -
      totalCredit;

    let balanceType:
      | "RECEIVABLE"
      | "PAYABLE"
      | "SETTLED";

    if (netBalance > 0) {
      balanceType =
        "RECEIVABLE";
    } else if (
      netBalance < 0
    ) {
      balanceType =
        "PAYABLE";
    } else {
      balanceType = "SETTLED";
    }

    return NextResponse.json({
      success: true,

      party: {
        id: party.id,
        partyName:
          party.partyName,
        partyTypes:
          party.partyTypes,
      },

      account: {
        id: party.account.id,
        accountName:
          party.account.accountName,
      },

      summary: {
        totalDebit,
        totalCredit,

        netBalance:
          Math.abs(netBalance),

        balanceType,
      },

      ledger,
    });
  } catch (error) {
    console.error(
      "Party ledger error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to load party ledger",
      },
      { status: 500 }
    );
  }
}