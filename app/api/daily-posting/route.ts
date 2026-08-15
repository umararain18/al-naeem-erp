import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

const lineSchema = z.object({
  counterAccountId: z
    .string()
    .min(1, "Counter account is required"),

  description: z
    .string()
    .min(1, "Description is required"),

  amount: z
    .number()
    .positive("Amount must be greater than zero"),

  // This describes what happened to the MAIN selected account.
  //
  // DEBIT:
  // Main Account receives money/value.
  //
  // CREDIT:
  // Main Account pays money/value.
  direction: z.enum(["DEBIT", "CREDIT"]),

  // Optional source document
  sourceType: z
    .enum([
      "CHALLAN",
      "PHONCH",
      "BILTY",
      "BILL",
      "PARTY",
      "ACCOUNT",
      "DIRECT",
    ])
    .optional(),

  sourceId: z.string().optional(),

  sourceNumber: z.string().optional(),
});

const dailyPostingSchema = z.object({
  postingDate: z
    .string()
    .min(1, "Posting date is required"),

  // Main selected account
  accountId: z
    .string()
    .min(1, "Account is required"),

  remarks: z.string().optional(),

  // If true, user selected "Post Anyway"
  // after duplicate-document warning.
  confirmDuplicate: z.boolean().optional(),

  lines: z
    .array(lineSchema)
    .min(1, "At least one entry is required"),
});


// ============================================================
// GET
// ============================================================

export async function GET(request: NextRequest) {
  try {
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

    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);

    const date = searchParams.get("date");
    const accountId = searchParams.get("accountId");

    const where: {
      referenceType: string;
      isDeleted: boolean;
      referenceId?: string;
      entryDate?: {
        gte: Date;
        lt: Date;
      };
    } = {
      referenceType: "DAILY_POSTING",
      isDeleted: false,
    };

    if (accountId) {
      where.referenceId = accountId;
    }

    if (date) {
      const start = new Date(`${date}T00:00:00`);

      if (Number.isNaN(start.getTime())) {
        return NextResponse.json(
          {
            success: false,
            message: "Invalid date",
          },
          { status: 400 }
        );
      }

      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      where.entryDate = {
        gte: start,
        lt: end,
      };
    }

    const entries = await prisma.journalEntry.findMany({
      where,

      include: {
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
        },
      },

      orderBy: {
        entryDate: "desc",
      },
    });

    return NextResponse.json({
      success: true,
      entries,
    });
  } catch (error) {
    console.error("Get daily postings error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Unable to load daily postings",
      },
      { status: 500 }
    );
  }
}


// ============================================================
// POST DAILY POSTING
// ============================================================

export async function POST(request: NextRequest) {
  try {
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

    if (!hasPermission(currentUser, "accounts.create")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to post accounting entries",
        },
        { status: 403 }
      );
    }

    const body = await request.json();

    const result = dailyPostingSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid daily posting data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    // ========================================================
    // DATE
    // ========================================================

    const postingDate = new Date(
      `${data.postingDate}T00:00:00`
    );

    if (Number.isNaN(postingDate.getTime())) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid posting date",
        },
        { status: 400 }
      );
    }

    // ========================================================
    // MAIN ACCOUNT
    // ========================================================

    const mainAccount = await prisma.account.findUnique({
      where: {
        id: data.accountId,
      },

      include: {
        party: true,
      },
    });

    if (!mainAccount) {
      return NextResponse.json(
        {
          success: false,
          message: "Selected account not found",
        },
        { status: 404 }
      );
    }

    if (!mainAccount.isActive) {
      return NextResponse.json(
        {
          success: false,
          message: "Selected account is inactive",
        },
        { status: 400 }
      );
    }

    // ========================================================
    // VALIDATE LINES
    // ========================================================

    for (const line of data.lines) {
      if (line.counterAccountId === data.accountId) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Main account cannot be its own counter account",
          },
          { status: 400 }
        );
      }

      // Document-linked entry requires source ID.
      if (
        line.sourceType &&
        line.sourceType !== "DIRECT" &&
        !line.sourceId
      ) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Source ID is required for document-linked entries",
          },
          { status: 400 }
        );
      }

      // If source type exists, source number should normally exist
      // for document searching.
      if (
        line.sourceType &&
        line.sourceType !== "DIRECT" &&
        !line.sourceNumber
      ) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Document number is required for document-linked entries",
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // COUNTER ACCOUNTS
    // ========================================================

    const counterAccountIds = Array.from(
      new Set(
        data.lines.map(
          (line) => line.counterAccountId
        )
      )
    );

    const counterAccounts =
      await prisma.account.findMany({
        where: {
          id: {
            in: counterAccountIds,
          },
        },

        select: {
          id: true,
          accountName: true,
          accountCode: true,
          accountType: true,
          category: true,
          isActive: true,
          party: {
            select: {
              id: true,
              partyName: true,
            },
          },
        },
      });

    if (
      counterAccounts.length !==
      counterAccountIds.length
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "One or more counter accounts were not found",
        },
        { status: 404 }
      );
    }

    const inactiveCounterAccount =
      counterAccounts.find(
        (account) => !account.isActive
      );

    if (inactiveCounterAccount) {
      return NextResponse.json(
        {
          success: false,
          message: `Account "${inactiveCounterAccount.accountName}" is inactive`,
        },
        { status: 400 }
      );
    }

    // ========================================================
    // DUPLICATE DOCUMENT WARNING
    //
    // IMPORTANT:
    // Same account + same date is ALWAYS allowed.
    //
    // Only already-used document references generate warning.
    // ========================================================

    const documentLines = data.lines.filter(
      (line) =>
        line.sourceType &&
        line.sourceType !== "DIRECT" &&
        line.sourceId
    );

    const duplicateWarnings: Array<{
      sourceType: string;
      sourceId: string;
      sourceNumber: string | null;
      existingJournalEntryId: string;
      existingDate: Date;
      amount: string;
    }> = [];

    for (const line of documentLines) {
      const existingLine =
        await prisma.journalLine.findFirst({
          where: {
            sourceType: line.sourceType,
            sourceId: line.sourceId,
            journalEntry: {
              is: {
                isDeleted: false,
              },
            },
          },

          include: {
            journalEntry: {
              select: {
                id: true,
                entryDate: true,
              },
            },
          },

          orderBy: {
            createdAt: "desc",
          },
        });

      if (existingLine) {
        duplicateWarnings.push({
          sourceType: line.sourceType!,
          sourceId: line.sourceId!,
          sourceNumber:
            line.sourceNumber || null,
          existingJournalEntryId:
            existingLine.journalEntryId,
          existingDate:
            existingLine.journalEntry.entryDate,
          amount:
            existingLine.debit.toString() !== "0"
              ? existingLine.debit.toString()
              : existingLine.credit.toString(),
        });
      }
    }

    // --------------------------------------------------------
    // WARNING ONLY
    //
    // Do NOT block.
    //
    // Frontend receives warning and can send:
    // confirmDuplicate: true
    //
    // to continue posting.
    // --------------------------------------------------------

    if (
      duplicateWarnings.length > 0 &&
      !data.confirmDuplicate
    ) {
      return NextResponse.json(
        {
          success: false,

          warning: true,

          message:
            "One or more selected documents have already been posted.",

          duplicates: duplicateWarnings,

          requiresConfirmation: true,
        },
        { status: 409 }
      );
    }

    // ========================================================
    // BUILD JOURNAL LINES
    //
    // Every Daily Posting line creates TWO journal lines:
    //
    // Example:
    //
    // Main Account = Umar Bank
    // Direction    = DEBIT
    // Amount       = 100,000
    // Counter      = Customer ABC
    //
    // Result:
    //
    // Umar Bank       Dr 100,000
    // Customer ABC    Cr 100,000
    // ========================================================

    const journalLines = data.lines.flatMap(
      (line) => {
        const mainDebit =
          line.direction === "DEBIT"
            ? line.amount
            : 0;

        const mainCredit =
          line.direction === "CREDIT"
            ? line.amount
            : 0;

        const counterDebit =
          line.direction === "CREDIT"
            ? line.amount
            : 0;

        const counterCredit =
          line.direction === "DEBIT"
            ? line.amount
            : 0;

        return [
          {
            accountId: data.accountId,

            description: line.description,

            debit: mainDebit,

            credit: mainCredit,

            sourceType:
              line.sourceType || "DIRECT",

            sourceId:
              line.sourceId || null,

            sourceNumber:
              line.sourceNumber || null,
          },

          {
            accountId:
              line.counterAccountId,

            description: line.description,

            debit: counterDebit,

            credit: counterCredit,

            sourceType:
              line.sourceType || "DIRECT",

            sourceId:
              line.sourceId || null,

            sourceNumber:
              line.sourceNumber || null,
          },
        ];
      }
    );

    // ========================================================
    // CREATE JOURNAL ENTRY
    //
    // One POST = one JournalEntry
    //
    // Multiple lines = multiple JournalLines
    //
    // Same account + same date can be posted again.
    // ========================================================

    const journalEntry =
      await prisma.$transaction(
        async (tx) => {
          const entry =
            await tx.journalEntry.create({
              data: {
                entryDate: postingDate,

                referenceType:
                  "DAILY_POSTING",

                referenceId:
                  data.accountId,

                description:
                  data.remarks ||
                  `Daily Posting - ${mainAccount.accountName}`,

                createdById: currentUser.userId,

                lines: {
                  create: journalLines,
                },
              },

              include: {
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
                },
              },
            });

          return entry;
        }
      );

    // ========================================================
    // SUCCESS
    // ========================================================

    return NextResponse.json(
      {
        success: true,

        message:
          "Daily posting posted successfully",

        journalEntry,

        duplicateWarnings:
          duplicateWarnings.length > 0
            ? duplicateWarnings
            : undefined,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error(
      "Daily posting error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Something went wrong while posting the daily accounts",
      },
      { status: 500 }
    );
  }
}
