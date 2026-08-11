import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { AccountCategory, AccountType } from "@prisma/client";

const createAccountSchema = z.object({
  accountName: z
    .string()
    .min(2, "Account name is required"),

  accountCode: z
    .string()
    .trim()
    .optional()
    .or(z.literal("")),

  accountType: z.enum([
    "ASSET",
    "LIABILITY",
    "EQUITY",
    "INCOME",
    "EXPENSE",
    "PARTY",
  ]),

  category: z.enum([
    "CASH",
    "BANK",
    "RECEIVABLE",
    "PAYABLE",
    "OTHER_ASSET",
    "TRANSPORTER_PAYABLE",
    "DELIVERY_POINT_PAYABLE",
    "VENDOR_PAYABLE",
    "OTHER_LIABILITY",
    "OWNER_CAPITAL",
    "OWNER_DRAWING",
    "OTHER_EQUITY",
    "BOOKING_INCOME",
    "DELIVERY_INCOME",
    "CARRIER_INCOME",
    "OTHER_INCOME",
    "FUEL",
    "OFFICE_RENT",
    "SALARY",
    "ELECTRICITY",
    "TEA_REFRESHMENT",
    "REPAIR_MAINTENANCE",
    "OTHER_EXPENSE",
    "PARTY",
  ]),

  description: z
    .string()
    .optional()
    .or(z.literal("")),

  parentId: z
    .string()
    .optional()
    .or(z.literal("")),

  partyId: z
    .string()
    .optional()
    .or(z.literal("")),
});

function isCategoryValidForType(
  type: AccountType,
  category: AccountCategory
) {
  const allowedCategories: Record<
    AccountType,
    AccountCategory[]
  > = {
    ASSET: [
      AccountCategory.CASH,
      AccountCategory.BANK,
      AccountCategory.RECEIVABLE,
      AccountCategory.OTHER_ASSET,
    ],

    LIABILITY: [
      AccountCategory.PAYABLE,
      AccountCategory.TRANSPORTER_PAYABLE,
      AccountCategory.DELIVERY_POINT_PAYABLE,
      AccountCategory.VENDOR_PAYABLE,
      AccountCategory.OTHER_LIABILITY,
    ],

    EQUITY: [
      AccountCategory.OWNER_CAPITAL,
      AccountCategory.OWNER_DRAWING,
      AccountCategory.OTHER_EQUITY,
    ],

    INCOME: [
      AccountCategory.BOOKING_INCOME,
      AccountCategory.DELIVERY_INCOME,
      AccountCategory.CARRIER_INCOME,
      AccountCategory.OTHER_INCOME,
    ],

    EXPENSE: [
      AccountCategory.FUEL,
      AccountCategory.OFFICE_RENT,
      AccountCategory.SALARY,
      AccountCategory.ELECTRICITY,
      AccountCategory.TEA_REFRESHMENT,
      AccountCategory.REPAIR_MAINTENANCE,
      AccountCategory.OTHER_EXPENSE,
    ],

    PARTY: [
      AccountCategory.PARTY,
    ],
  };

  return allowedCategories[type].includes(category);
}

// GET /api/accounts
export async function GET() {
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

    const accounts = await prisma.account.findMany({
      include: {
        parent: {
          select: {
            id: true,
            accountName: true,
            accountCode: true,
          },
        },

        party: {
          select: {
            id: true,
            partyName: true,
          },
        },
      },

      orderBy: [
        {
          accountType: "asc",
        },
        {
          accountName: "asc",
        },
      ],
    });

    return NextResponse.json({
      success: true,
      accounts,
    });
  } catch (error) {
    console.error("Get accounts error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}

// POST /api/accounts
export async function POST(
  request: NextRequest
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

    if (!hasPermission(currentUser, "accounts.create")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to create accounts",
        },
        { status: 403 }
      );
    }

    const body = await request.json();

    const result =
      createAccountSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid account data",
          errors:
            result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    const accountType =
      data.accountType as AccountType;

    const category =
      data.category as AccountCategory;

    if (
      !isCategoryValidForType(
        accountType,
        category
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Selected category does not belong to the selected account type",
        },
        { status: 400 }
      );
    }

    if (data.accountCode) {
      const existingCode =
        await prisma.account.findUnique({
          where: {
            accountCode: data.accountCode,
          },
        });

      if (existingCode) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Account code already exists",
          },
          { status: 409 }
        );
      }
    }

    if (data.parentId) {
      const parent =
        await prisma.account.findUnique({
          where: {
            id: data.parentId,
          },
        });

      if (!parent) {
        return NextResponse.json(
          {
            success: false,
            message: "Parent account not found",
          },
          { status: 404 }
        );
      }

      if (
        parent.accountType !== accountType
      ) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Parent account must have the same account type",
          },
          { status: 400 }
        );
      }
    }

    if (data.partyId) {
      const party =
        await prisma.party.findUnique({
          where: {
            id: data.partyId,
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

      const existingPartyAccount =
        await prisma.account.findUnique({
          where: {
            partyId: data.partyId,
          },
        });

      if (existingPartyAccount) {
        return NextResponse.json(
          {
            success: false,
            message:
              "This party already has an account",
          },
          { status: 409 }
        );
      }
    }

    const account =
      await prisma.account.create({
        data: {
          accountName: data.accountName,

          accountCode:
            data.accountCode || null,

          accountType,

          category,

          description:
            data.description || null,

          parentId:
            data.parentId || null,

          partyId:
            data.partyId || null,

          isSystem: false,

          isActive: true,
        },

        include: {
          parent: {
            select: {
              id: true,
              accountName: true,
              accountCode: true,
            },
          },

          party: {
            select: {
              id: true,
              partyName: true,
            },
          },
        },
      });

    return NextResponse.json(
      {
        success: true,
        message:
          "Account created successfully",
        account,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error(
      "Create account error:",
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