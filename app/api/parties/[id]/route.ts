import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { BalanceType, PartyType } from "@prisma/client";

const updatePartySchema = z.object({
  partyName: z.string().min(2).optional(),
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
    .min(1)
    .optional(),

  openingBalance: z
    .number()
    .min(0)
    .optional(),

  openingBalanceType: z
    .enum(["DEBIT", "CREDIT"])
    .nullable()
    .optional(),

  isActive: z.boolean().optional(),

  notes: z.string().optional(),
});

// GET PARTY
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    if (!hasPermission(currentUser, "parties.view")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const party = await prisma.party.findUnique({
      where: { id },
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

    if (!party) {
      return NextResponse.json(
        {
          success: false,
          message: "Party not found",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      party,
    });
  } catch (error) {
    console.error("Get party error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}

// UPDATE PARTY
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    if (!hasPermission(currentUser, "parties.edit")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to edit parties",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const existingParty = await prisma.party.findUnique({
      where: { id },
      include: {
        account: true,
      },
    });

    if (!existingParty) {
      return NextResponse.json(
        {
          success: false,
          message: "Party not found",
        },
        { status: 404 }
      );
    }

    const body = await request.json();

    const result = updatePartySchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid party data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    const updatedParty = await prisma.$transaction(
      async (tx) => {
        // Update Party
        const party = await tx.party.update({
          where: { id },

          data: {
            ...(data.partyName !== undefined && {
              partyName: data.partyName,
            }),

            ...(data.contactPerson !== undefined && {
              contactPerson: data.contactPerson || null,
            }),

            ...(data.phone !== undefined && {
              phone: data.phone || null,
            }),

            ...(data.whatsapp !== undefined && {
              whatsapp: data.whatsapp || null,
            }),

            ...(data.cnicNtn !== undefined && {
              cnicNtn: data.cnicNtn || null,
            }),

            ...(data.address !== undefined && {
              address: data.address || null,
            }),

            ...(data.partyTypes !== undefined && {
              partyTypes: data.partyTypes as PartyType[],
            }),

            ...(data.openingBalance !== undefined && {
              openingBalance: data.openingBalance,
            }),

            ...(data.openingBalanceType !== undefined && {
              openingBalanceType: data.openingBalanceType
                ? (data.openingBalanceType as BalanceType)
                : null,
            }),

            ...(data.isActive !== undefined && {
              isActive: data.isActive,
            }),

            ...(data.notes !== undefined && {
              notes: data.notes || null,
            }),
          },
        });

        // Make sure Party always has exactly ONE Account
        let account = existingParty.account;

        if (!account) {
          account = await tx.account.create({
            data: {
              accountName: party.partyName,
              accountType: "PARTY",
              category: "PARTY",
              description:
                `Automatic account for party: ${party.partyName}`,
              partyId: party.id,
              isSystem: false,
              isActive: party.isActive,
            },
          });
        } else {
          account = await tx.account.update({
            where: {
              id: account.id,
            },

            data: {
              // Keep account name synchronized
              ...(data.partyName !== undefined && {
                accountName: party.partyName,
              }),

              // Party active/inactive sync
              ...(data.isActive !== undefined && {
                isActive: party.isActive,
              }),
            },
          });
        }

        /*
         * Opening Balance
         *
         * Existing opening-balance journal for this party
         * is replaced so editing the opening balance does
         * not create duplicate opening entries.
         */

        if (
          data.openingBalance !== undefined ||
          data.openingBalanceType !== undefined
        ) {
          const openingEntry =
            await tx.journalEntry.findFirst({
              where: {
                referenceType: "OPENING_BALANCE",
                referenceId: party.id,
              },
              orderBy: {
                createdAt: "desc",
              },
            });

          if (openingEntry) {
            await tx.journalEntry.delete({
              where: {
                id: openingEntry.id,
              },
            });
          }

          const amount =
            data.openingBalance !== undefined
              ? data.openingBalance
              : Number(existingParty.openingBalance);

          const balanceType =
            data.openingBalanceType !== undefined
              ? data.openingBalanceType
              : existingParty.openingBalanceType;

          if (amount > 0 && balanceType) {
            let openingEquity =
              await tx.account.findFirst({
                where: {
                  accountCode: "OPENING-BALANCE",
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
                    accountType: "EQUITY",
                    category: "OTHER_EQUITY",
                    description:
                      "System account used for opening balances",
                    isSystem: true,
                    isActive: true,
                  },
                });
            }

            const journalEntry =
              await tx.journalEntry.create({
                data: {
                  entryDate: new Date(),
                  referenceType:
                    "OPENING_BALANCE",
                  referenceId: party.id,
                  description:
                    `Opening balance for ${party.partyName}`,
                  

                  lines: {
                    create: [
                      {
                        accountId: account.id,

                        debit:
                          balanceType === "DEBIT"
                            ? amount
                            : 0,

                        credit:
                          balanceType === "CREDIT"
                            ? amount
                            : 0,

                        description:
                          `Opening balance - ${party.partyName}`,
                      },

                      {
                        accountId:
                          openingEquity.id,

                        debit:
                          balanceType === "CREDIT"
                            ? amount
                            : 0,

                        credit:
                          balanceType === "DEBIT"
                            ? amount
                            : 0,

                        description:
                          "Opening Balance Equity",
                      },
                    ],
                  },
                },
              });

            console.log(
              "Opening balance journal created:",
              journalEntry.id
            );
          }
        }

        return party;
      }
    );

    return NextResponse.json({
      success: true,
      message:
        "Party, account and opening balance updated successfully",
      party: updatedParty,
    });
  } catch (error) {
    console.error(
      "Update party error:",
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

// DELETE PARTY
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    if (!hasPermission(currentUser, "parties.delete")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to delete parties",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const existingParty =
      await prisma.party.findUnique({
        where: { id },
        include: {
          account: {
            include: {
              ledgerEntries: true,
            },
          },
        },
      });

    if (!existingParty) {
      return NextResponse.json(
        {
          success: false,
          message: "Party not found",
        },
        { status: 404 }
      );
    }

    /*
     * Do NOT delete a party if its account
     * already has accounting transactions.
     */

    if (
      existingParty.account &&
      existingParty.account.ledgerEntries.length > 0
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This party has accounting transactions and cannot be deleted. Deactivate it instead.",
        },
        { status: 400 }
      );
    }

    await prisma.$transaction(
      async (tx) => {
        // Delete account first if it exists
        if (existingParty.account) {
          await tx.account.delete({
            where: {
              id: existingParty.account.id,
            },
          });
        }

        await tx.party.delete({
          where: {
            id,
          },
        });
      }
    );

    return NextResponse.json({
      success: true,
      message:
        "Party and its account deleted successfully",
    });
  } catch (error) {
    console.error(
      "Delete party error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to delete party. It may have related records.",
      },
      { status: 500 }
    );
  }
}