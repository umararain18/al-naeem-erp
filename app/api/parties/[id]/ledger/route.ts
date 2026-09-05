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

    const { searchParams } = new URL(_request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    // ---------------------------------------------
    // DATE FILTER
    // ---------------------------------------------

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
          journalEntry: {
            is: {
              isDeleted: false,
              ...(Object.keys(dateFilter).length > 0
                ? { entryDate: dateFilter }
                : {}),
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

          journalEntryId:
            entry.journalEntryId,

          referenceType:
            entry.journalEntry
              .referenceType,

          referenceId:
            entry.journalEntry
              .referenceId,

          // Per-line source (JournalLine.sourceType/sourceId/
          // sourceNumber) - already part of the existing accounting
          // architecture, just not previously exposed here. This is
          // the MOST specific source available: e.g. a SETTLEMENT
          // JournalEntry is Challan-level (referenceId = challanId)
          // but each of its lines is additionally tagged to the
          // exact Bilty it belongs to.
          sourceType:
            entry.sourceType,

          sourceId:
            entry.sourceId,

          sourceNumber:
            entry.sourceNumber,

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

    const periodDebit =
      entries.reduce(
        (sum, entry) =>
          sum +
          Number(entry.debit),
        0
      );

    const periodCredit =
      entries.reduce(
        (sum, entry) =>
          sum +
          Number(entry.credit),
        0
      );

    const netBalance =
      periodDebit -
      periodCredit;

    // ---------------------------------------------
    // OPENING BALANCE
    // ---------------------------------------------

    let openingBalance = 0;

    if (Object.keys(dateFilter).length > 0 && from) {
      const openingEntries =
        await prisma.journalLine.findMany({
          where: {
            accountId:
              party.account.id,
            journalEntry: {
              is: {
                isDeleted: false,
                entryDate: {
                  lt: new Date(
                    `${from}T00:00:00`
                  ),
                },
              },
            },
          },

          select: {
            debit: true,
            credit: true,
          },
        });

      openingBalance =
        openingEntries.reduce(
          (sum, entry) =>
            sum +
            Number(entry.debit) -
            Number(entry.credit),
          0
        );
    }

    const closingBalance =
      openingBalance + netBalance;

    let balanceType:
      | "RECEIVABLE"
      | "PAYABLE"
      | "SETTLED";

    if (closingBalance > 0) {
      balanceType =
        "RECEIVABLE";
    } else if (
      closingBalance < 0
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

      filters: {
        from: from || null,
        to: to || null,
      },

      summary: {
        openingBalance,
        periodDebit,
        periodCredit,
        closingBalance,
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
