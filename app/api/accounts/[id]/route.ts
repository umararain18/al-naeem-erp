import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { AccountCategory, AccountType } from "@prisma/client";

const updateAccountSchema = z.object({
  accountName: z
    .string()
    .min(2, "Account name is required")
    .optional(),

  accountCode: z
    .string()
    .trim()
    .optional()
    .or(z.literal("")),

  accountType: z
    .enum([
      "ASSET",
      "LIABILITY",
      "EQUITY",
      "INCOME",
      "EXPENSE",
    ])
    .optional(),

  category: z
    .enum([
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
    ])
    .optional(),

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

  isActive: z
    .boolean()
    .optional(),
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

  return allowedCategories[type].includes(
    category
  );
}

// GET SINGLE ACCOUNT
export async function GET(
  _request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  }
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

    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const account =
      await prisma.account.findUnique({
        where: {
          id,
        },

        include: {
          parent: true,
          children: true,
          party: true,
        },
      });

    if (!account) {
      return NextResponse.json(
        {
          success: false,
          message: "Account not found",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      account,
    });
  } catch (error) {
    console.error(
      "Get account error:",
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

// UPDATE ACCOUNT
export async function PATCH(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  }
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

    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to edit accounts",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const existingAccount =
      await prisma.account.findUnique({
        where: {
          id,
        },
      });

    if (!existingAccount) {
      return NextResponse.json(
        {
          success: false,
          message: "Account not found",
        },
        { status: 404 }
      );
    }

    if (existingAccount.isSystem) {
      return NextResponse.json(
        {
          success: false,
          message:
            "System accounts cannot be modified",
        },
        { status: 400 }
      );
    }

    const body = await request.json();

    const result =
      updateAccountSchema.safeParse(body);

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
      (data.accountType ||
        existingAccount.accountType) as AccountType;

    const category =
      (data.category ||
        existingAccount.category) as AccountCategory;

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

    if (
      data.accountCode &&
      data.accountCode !==
        existingAccount.accountCode
    ) {
      const duplicate =
        await prisma.account.findUnique({
          where: {
            accountCode: data.accountCode,
          },
        });

      if (
        duplicate &&
        duplicate.id !== id
      ) {
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
      if (data.parentId === id) {
        return NextResponse.json(
          {
            success: false,
            message:
              "An account cannot be its own parent",
          },
          { status: 400 }
        );
      }

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
            message:
              "Parent account not found",
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
    }

    const updatedAccount =
      await prisma.account.update({
        where: {
          id,
        },

        data: {
          ...(data.accountName !==
            undefined && {
            accountName:
              data.accountName,
          }),

          ...(data.accountCode !==
            undefined && {
            accountCode:
              data.accountCode || null,
          }),

          ...(data.accountType !==
            undefined && {
            accountType,
          }),

          ...(data.category !==
            undefined && {
            category,
          }),

          ...(data.description !==
            undefined && {
            description:
              data.description || null,
          }),

          ...(data.parentId !==
            undefined && {
            parentId:
              data.parentId || null,
          }),

          ...(data.partyId !==
            undefined && {
            partyId:
              data.partyId || null,
          }),

          ...(data.isActive !==
            undefined && {
            isActive:
              data.isActive,
          }),
        },

        include: {
          parent: true,
          party: true,
        },
      });

    return NextResponse.json({
      success: true,
      message:
        "Account updated successfully",
      account: updatedAccount,
    });
  } catch (error) {
    console.error(
      "Update account error:",
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

// DELETE ACCOUNT
export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  }
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

    if (
      !hasPermission(
        currentUser,
        "accounts.delete"
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to delete accounts",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const account =
      await prisma.account.findUnique({
        where: {
          id,
        },

        include: {
          children: true,
        },
      });

    if (!account) {
      return NextResponse.json(
        {
          success: false,
          message: "Account not found",
        },
        { status: 404 }
      );
    }

    if (account.isSystem) {
      return NextResponse.json(
        {
          success: false,
          message:
            "System accounts cannot be deleted",
        },
        { status: 400 }
      );
    }

    if (account.children.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This account has child accounts. Remove or move them first.",
        },
        { status: 400 }
      );
    }

    if (account.partyId) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Party-linked accounts should be deactivated instead of deleted.",
        },
        { status: 400 }
      );
    }

    await prisma.account.delete({
      where: {
        id,
      },
    });

    return NextResponse.json({
      success: true,
      message:
        "Account deleted successfully",
    });
  } catch (error) {
    console.error(
      "Delete account error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to delete account",
      },
      { status: 500 }
    );
  }
}