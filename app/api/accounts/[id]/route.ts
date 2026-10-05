import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { AccountCategory, AccountType, Prisma } from "@prisma/client";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";
import { getOpeningBalanceEquityAccountId } from "@/lib/gross-accounts";
import { parseISODateStart, toBusinessDateInputValue } from "@/lib/date-range";
import { ACCOUNT_TYPES_ELIGIBLE_FOR_OPENING_BALANCE } from "../route";

// A line's debit/credit resolves to a signed amount (+debit, -credit)
// and back - used both to derive the CURRENT opening balance from an
// existing JournalEntry's lines (no stored Account field exists - see
// the approved "Option A, no schema change" design) and to rebuild
// the two lines when the amount/side changes.
function signedAmount(debit: number, credit: number): number {
  return debit - credit;
}

export interface DerivedOpeningBalance {
  openingBalance: number;
  openingBalanceType: "DEBIT" | "CREDIT" | null;
  openingDate: string | null;
}

// Shared by this route's GET/PATCH and the list GET in ../route.ts -
// the single source of truth for turning an account's existing (if
// any) active OPENING_BALANCE JournalEntry back into display/pre-fill
// values, since none of this is stored on Account itself.
export function deriveOpeningBalance(
  entry: { entryDate: Date; lines: { accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[] } | null,
  accountId: string
): DerivedOpeningBalance {
  const line = entry?.lines.find((l) => l.accountId === accountId) || null;
  if (!entry || !line) {
    return { openingBalance: 0, openingBalanceType: null, openingDate: null };
  }
  const net = signedAmount(Number(line.debit), Number(line.credit));
  return {
    openingBalance: Math.abs(net),
    openingBalanceType: net >= 0 ? "DEBIT" : "CREDIT",
    openingDate: toBusinessDateInputValue(entry.entryDate),
  };
}

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
      "CARRIER_RENT",
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

  openingBalance: z
    .number()
    .min(0, "Opening balance cannot be negative")
    .optional(),

  openingBalanceType: z
    .enum(["DEBIT", "CREDIT"])
    .optional(),

  openingDate: z
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
    AccountCategory.CARRIER_RENT,
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

    // Opening Balance pre-fill - derived from the account's own
    // active OPENING_BALANCE JournalEntry (if any), never a stored
    // Account field. Looked up for every account (cheap, single-row
    // lookup) rather than gating on ACCOUNT_TYPES_ELIGIBLE_FOR_OPENING_BALANCE,
    // so an already-posted entry is never hidden merely because the
    // account's type was changed after it was posted.
    const openingEntryForGet = await prisma.journalEntry.findFirst({
      where: {
        referenceType: "OPENING_BALANCE",
        referenceId: id,
        isDeleted: false,
      },
      include: { lines: true },
    });

    const accountWithOpeningBalance = {
      ...account,
      ...deriveOpeningBalance(openingEntryForGet, id),
    };

    return NextResponse.json({
      success: true,
      account: accountWithOpeningBalance,
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

    // System accounts (isSystem: true) are the fixed accounting
    // structure every module's own posting logic resolves by
    // accountCode (see lib/gross-accounts.ts's getOrCreateSystemAccount())
    // - their accountCode/accountType/category/parentId/partyId/
    // isActive must never change underneath that resolution, and
    // isActive/delete already have their own separate system-account
    // guards elsewhere. Only the display accountName and the
    // documentation-only description may be changed here - the exact
    // same account id, still found by the exact same accountCode, by
    // every future posting. Any attempt to change a structural field
    // is rejected outright rather than silently ignored, so a caller
    // never mistakenly believes a structural change was applied.
    if (existingAccount.isSystem) {
      const attemptsStructuralChange =
        (data.accountCode !== undefined && (data.accountCode || null) !== existingAccount.accountCode) ||
        (data.accountType !== undefined && data.accountType !== existingAccount.accountType) ||
        (data.category !== undefined && data.category !== existingAccount.category) ||
        (data.parentId !== undefined && (data.parentId || null) !== existingAccount.parentId) ||
        (data.partyId !== undefined && (data.partyId || null) !== existingAccount.partyId) ||
        data.isActive !== undefined;

      if (attemptsStructuralChange) {
        return NextResponse.json(
          {
            success: false,
            message:
              "System accounts can only have their Name and Description changed - the account code, type, category, parent, and active state are fixed.",
          },
          { status: 400 }
        );
      }
    }

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

    // Opening Balance is only offered for Asset/Liability/Equity
    // accounts, and never for the Opening Balance Equity system
    // account itself (it would need its own counter-equity account,
    // which does not exist - the same scope rule the Create route
    // enforces, see ACCOUNT_TYPES_ELIGIBLE_FOR_OPENING_BALANCE).
    const openingBalanceRequested =
      data.openingBalance !== undefined ||
      data.openingBalanceType !== undefined ||
      !!data.openingDate;

    const isOpeningBalanceEquityAccount =
      existingAccount.isSystem &&
      existingAccount.accountCode === "OPENING-BALANCE";

    if (
      openingBalanceRequested &&
      (!ACCOUNT_TYPES_ELIGIBLE_FOR_OPENING_BALANCE.has(accountType) ||
        isOpeningBalanceEquityAccount)
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Opening balance is only available for Asset, Liability and Equity accounts.",
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

    // ------------------------------------------------------------
    // OPENING BALANCE - resolve current (derived from the existing
    // OPENING_BALANCE JournalEntry's own lines, since Account has no
    // stored field for this - "Option A, no schema change") and the
    // final values BEFORE the transaction, purely as reads, so the
    // "type required" validation below can return a clean 400
    // without needing to unwind a transaction.
    // ------------------------------------------------------------

    let existingOpeningEntry: Prisma.JournalEntryGetPayload<{ include: { lines: true } }> | null = null;
    let oldOpeningAmount = 0;
    let oldOpeningType: "DEBIT" | "CREDIT" | null = null;
    let oldOpeningDateStr: string | null = null;
    let finalOpeningAmount = 0;
    let finalOpeningType: "DEBIT" | "CREDIT" | null = null;
    let finalOpeningDateStr = "";

    if (openingBalanceRequested) {
      existingOpeningEntry = await prisma.journalEntry.findFirst({
        where: {
          referenceType: "OPENING_BALANCE",
          referenceId: id,
          isDeleted: false,
        },
        include: { lines: true },
      });

      const derived = deriveOpeningBalance(existingOpeningEntry, id);
      oldOpeningAmount = derived.openingBalance;
      oldOpeningType = derived.openingBalanceType;
      oldOpeningDateStr = derived.openingDate;

      finalOpeningAmount = data.openingBalance !== undefined ? data.openingBalance : oldOpeningAmount;
      finalOpeningType = data.openingBalanceType !== undefined ? data.openingBalanceType : oldOpeningType;
      finalOpeningDateStr = data.openingDate ? data.openingDate : oldOpeningDateStr || toBusinessDateInputValue(new Date());

      if (finalOpeningAmount > 0 && !finalOpeningType) {
        return NextResponse.json(
          {
            success: false,
            message: "Opening balance type is required when opening balance is greater than zero.",
          },
          { status: 400 }
        );
      }
    }

    const finalOpeningDate = openingBalanceRequested ? parseISODateStart(finalOpeningDateStr) : null;

    const { updatedAccount, openingBalanceDiff } = await prisma.$transaction(async (tx) => {
      const updated = await tx.account.update({
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

      const diff: Record<string, { old: unknown; new: unknown }> = {};

      if (openingBalanceRequested) {
        if (finalOpeningAmount <= 0) {
          // Amount set to 0 (or never had one and still doesn't) -
          // soft-delete the existing entry per the app's own bin
          // convention, never a hard delete. A no-op when nothing
          // existed to begin with.
          if (existingOpeningEntry) {
            await tx.journalEntry.update({
              where: { id: existingOpeningEntry.id },
              data: {
                isDeleted: true,
                deletedAt: new Date(),
                deletedById: currentUser.userId,
              },
            });

            diff.openingBalance = { old: oldOpeningAmount, new: 0 };
            diff.openingBalanceType = { old: oldOpeningType, new: null };
            diff.openingDate = { old: oldOpeningDateStr, new: null };
          }
        } else {
          const existingAccountLine = existingOpeningEntry?.lines.find((l) => l.accountId === id) || null;
          const existingEquityLine = existingOpeningEntry?.lines.find((l) => l.accountId !== id) || null;

          if (existingOpeningEntry && existingAccountLine) {
            // In-place update - the SAME entry/lines, never a
            // duplicate (replace-on-edit would hard-delete and
            // recreate, which the approved design explicitly rejects
            // here, unlike Party's own existing flow).
            await tx.journalEntry.update({
              where: { id: existingOpeningEntry.id },
              data: { entryDate: finalOpeningDate! },
            });

            await tx.journalLine.update({
              where: { id: existingAccountLine.id },
              data: {
                debit: finalOpeningType === "DEBIT" ? finalOpeningAmount : 0,
                credit: finalOpeningType === "CREDIT" ? finalOpeningAmount : 0,
              },
            });

            if (existingEquityLine) {
              await tx.journalLine.update({
                where: { id: existingEquityLine.id },
                data: {
                  debit: finalOpeningType === "CREDIT" ? finalOpeningAmount : 0,
                  credit: finalOpeningType === "DEBIT" ? finalOpeningAmount : 0,
                },
              });
            }
          } else {
            // No active entry yet (first time, or amount was
            // previously zeroed out) - create exactly one, exactly
            // like Create's own flow.
            const openingEquityId = await getOpeningBalanceEquityAccountId(tx);

            await tx.journalEntry.create({
              data: {
                entryDate: finalOpeningDate!,
                referenceType: "OPENING_BALANCE",
                referenceId: id,
                description: `Opening balance for ${updated.accountName}`,
                lines: {
                  create: [
                    {
                      accountId: id,
                      debit: finalOpeningType === "DEBIT" ? finalOpeningAmount : 0,
                      credit: finalOpeningType === "CREDIT" ? finalOpeningAmount : 0,
                      description: `Opening balance - ${updated.accountName}`,
                    },
                    {
                      accountId: openingEquityId,
                      debit: finalOpeningType === "CREDIT" ? finalOpeningAmount : 0,
                      credit: finalOpeningType === "DEBIT" ? finalOpeningAmount : 0,
                      description: "Opening Balance Equity",
                    },
                  ],
                },
              },
            });
          }

          if (finalOpeningAmount !== oldOpeningAmount) diff.openingBalance = { old: oldOpeningAmount, new: finalOpeningAmount };
          if (finalOpeningType !== oldOpeningType) diff.openingBalanceType = { old: oldOpeningType, new: finalOpeningType };
          if (finalOpeningDateStr !== oldOpeningDateStr) diff.openingDate = { old: oldOpeningDateStr, new: finalOpeningDateStr };
        }
      }

      return { updatedAccount: updated, openingBalanceDiff: diff };
    });

    const changedFields = diffFields(
      existingAccount as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
      Object.keys(data) as (keyof typeof existingAccount)[]
    );
    Object.assign(changedFields, openingBalanceDiff);

    if (Object.keys(changedFields).length > 0) {
      const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
      await auditUpdate(prisma, {
        actor: actorFromUser(currentUser),
        module: "ACCOUNT",
        entityType: "Account",
        entityId: id,
        documentNo: updatedAccount.accountName,
        description: `Updated Account ${updatedAccount.accountName}: ${summary}`,
        changedFields,
        ...requestContext(request),
      });
    }

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

    await auditDelete(prisma, {
      actor: actorFromUser(currentUser),
      module: "ACCOUNT",
      entityType: "Account",
      entityId: id,
      documentNo: account.accountName,
      description: `Deleted Account ${account.accountName}`,
      oldValues: { accountName: account.accountName, accountCode: account.accountCode, accountType: account.accountType, category: account.category },
      ...requestContext(request),
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