import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { BalanceType, PartyType } from "@prisma/client";

const createPartySchema = z.object({
  partyName: z
    .string()
    .min(2, "Party name is required"),

  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  cnicNtn: z.string().optional(),
  address: z.string().optional(),

  partyTypes: z
    .array(
      z.enum([
        "TRANSPORTER",
        "CLEARING_AGENT",
        "CUSTOMER",
        "VENDOR",
        "BOTH",
      ])
    )
    .min(
      1,
      "At least one party type is required"
    ),

  openingBalance: z
    .number()
    .min(
      0,
      "Opening balance cannot be negative"
    )
    .optional(),

  openingBalanceType: z
    .enum(["DEBIT", "CREDIT"])
    .optional(),

  notes: z.string().optional(),
});

// GET /api/parties
export async function GET() {
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

    const parties =
      await prisma.party.findMany({
        orderBy: {
          createdAt: "desc",
        },

        include: {
          account: {
            select: {
              id: true,
              accountName: true,
              accountCode: true,
              accountType: true,
              category: true,
              isActive: true,
            },
          },
        },
      });

    return NextResponse.json({
      success: true,
      parties,
    });
  } catch (error) {
    console.error(
      "Get parties error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}

// POST /api/parties
export async function POST(
  request: NextRequest
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
        "parties.create"
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to create parties",
        },
        { status: 403 }
      );
    }

    const body =
      await request.json();

    const result =
      createPartySchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Invalid party data",
          errors:
            result.error.flatten()
              .fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    // Opening balance requires a balance type
    if (
      (data.openingBalance ?? 0) > 0 &&
      !data.openingBalanceType
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Opening balance type is required when opening balance is greater than zero.",
        },
        { status: 400 }
      );
    }

    const transaction =
      await prisma.$transaction(
        async (tx) => {
          // ------------------------------------------------
          // 1. CREATE PARTY
          // ------------------------------------------------

          const party =
            await tx.party.create({
              data: {
                partyName:
                  data.partyName,

                contactPerson:
                  data.contactPerson ||
                  null,

                phone:
                  data.phone || null,

                whatsapp:
                  data.whatsapp || null,

                cnicNtn:
                  data.cnicNtn || null,

                address:
                  data.address || null,

                partyTypes:
                  data.partyTypes as PartyType[],

                openingBalance:
                  data.openingBalance ??
                  0,

                openingBalanceType:
                  data.openingBalanceType
                    ? (data.openingBalanceType as BalanceType)
                    : null,

                isActive: true,

                notes:
                  data.notes || null,
              },
            });

          // ------------------------------------------------
          // 2. CREATE ONE ACCOUNT FOR PARTY
          // ------------------------------------------------

          const account =
            await tx.account.create({
              data: {
                accountName:
                  party.partyName,

                accountCode: null,

                accountType: "PARTY",

                category: "PARTY",

                description:
                  `Automatic account for party: ${party.partyName}`,

                partyId: party.id,

                isSystem: false,

                isActive: true,
              },
            });

          // ------------------------------------------------
          // 3. CREATE OPENING BALANCE EQUITY ACCOUNT
          // ------------------------------------------------

          let openingEquity =
            await tx.account.findFirst({
              where: {
                accountCode:
                  "OPENING-BALANCE",
                isSystem: true,
              },
            });

          if (!openingEquity) {
            openingEquity =
              await tx.account.create({
                data: {
                  accountName:
                    "Opening Balance Equity",

                  accountCode:
                    "OPENING-BALANCE",

                  accountType:
                    "EQUITY",

                  category:
                    "OTHER_EQUITY",

                  description:
                    "System account used for opening balances",

                  isSystem: true,

                  isActive: true,
                },
              });
          }

          // ------------------------------------------------
          // 4. POST OPENING BALANCE
          // ------------------------------------------------

          const openingAmount =
            data.openingBalance ?? 0;

          if (
            openingAmount > 0 &&
            data.openingBalanceType
          ) {
            await tx.journalEntry.create({
              data: {
                entryDate: new Date(),

                referenceType:
                  "OPENING_BALANCE",

                referenceId:
                  party.id,

                description:
                  `Opening balance for ${party.partyName}`,

                

                lines: {
                  create: [
                    {
                      accountId:
                        account.id,

                      debit:
                        data.openingBalanceType ===
                        "DEBIT"
                          ? openingAmount
                          : 0,

                      credit:
                        data.openingBalanceType ===
                        "CREDIT"
                          ? openingAmount
                          : 0,

                      description:
                        `Opening balance - ${party.partyName}`,
                    },

                    {
                      accountId:
                        openingEquity.id,

                      debit:
                        data.openingBalanceType ===
                        "CREDIT"
                          ? openingAmount
                          : 0,

                      credit:
                        data.openingBalanceType ===
                        "DEBIT"
                          ? openingAmount
                          : 0,

                      description:
                        "Opening Balance Equity",
                    },
                  ],
                },
              },
            });
          }

          return {
            party,
            account,
          };
        }
      );

    return NextResponse.json(
      {
        success: true,

        message:
          "Party, account and opening balance created successfully",

        party:
          transaction.party,

        account:
          transaction.account,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error(
      "Create party error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Something went wrong",
      },
      { status: 500 }
    );
  }
}