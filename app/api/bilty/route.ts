import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { PartyType, Prisma, BiltyStatus } from "@prisma/client";
import { getGrossBiltyReceivableAccountId } from "@/lib/gross-accounts";
import { resolveBiltyPaidResponsibleParty } from "@/lib/document-party-resolution";
import { createSettlementPayment, SettlementPaymentError } from "@/lib/settlement-payments";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";
import { biltyListSearchOr } from "@/lib/search-helpers";

// Comma-separated, fully business-readable description for the Bilty
// Commission/Referral expense JournalLine pair - stored verbatim at
// creation (mirrors Phonch/Bill's own "pre-composed once, displayed
// as-is" convention) and recognized as such by
// lib/ledger-description.ts's own display layer, which passes it
// through unchanged rather than recomputing a generic Bilty
// description over it. Never hard-coded - built fresh from this
// specific Bilty's own stored fields every time.
function buildBiltyCommissionDescription(
  bilty: { biltyNo: string; vehicleType: string | null; vehicleModel: string | null; chassisNumber: string | null },
  amount: number
): string {
  const parts: string[] = [`Bilty No ${bilty.biltyNo}`];
  const vehicle = bilty.vehicleModel || bilty.vehicleType;
  if (vehicle) parts.push(vehicle);
  if (bilty.chassisNumber) parts.push(`Chassis No ${bilty.chassisNumber}`);
  parts.push(`bilty expense. ${Math.round(amount).toLocaleString()}.`);
  return parts.join(", ");
}

const createBiltySchema = z.object({
  biltyNo: z
    .string()
    .trim()
    .min(1, "Bilty number is required"),

  date: z
    .string()
    .min(1, "Bilty date is required"),

  // Locations
  fromLocationId: z
    .string()
    .min(1, "From location is required"),

  toLocationId: z
    .string()
    .min(1, "To location is required"),

  // Consignor
  consignorPartyId: z
    .string()
    .optional()
    .or(z.literal("")),

  consignorName: z
    .string()
    .trim()
    .min(1, "Consignor name is required"),

  consignorPhone: z
    .string()
    .optional()
    .or(z.literal("")),

  // Consignee
  consigneePartyId: z
    .string()
    .optional()
    .or(z.literal("")),

  consigneeName: z
    .string()
    .trim()
    .min(1, "Consignee name is required"),

  consigneePhone: z
    .string()
    .optional()
    .or(z.literal("")),

  // Vehicle
  vehicleType: z
    .string()
    .optional()
    .or(z.literal("")),

  vehicleModel: z
    .string()
    .optional()
    .or(z.literal("")),

  vehicleColor: z
    .string()
    .optional()
    .or(z.literal("")),

  engineNumber: z
    .string()
    .optional()
    .or(z.literal("")),

  chassisNumber: z
    .string()
    .optional()
    .or(z.literal("")),

  registrationNumber: z
    .string()
    .optional()
    .or(z.literal("")),

  // Clearing Agent / Delivery Point
  clearingAgentPartyId: z
    .string()
    .optional()
    .or(z.literal("")),

  // Freight
  rent: z
    .number()
    .min(0, "Rent cannot be negative")
    .optional(),

  insurance: z
    .number()
    .min(0, "Insurance cannot be negative")
    .optional(),

  expense: z
    .number()
    .min(0, "Expense cannot be negative")
    .optional(),

  advance: z
    .number()
    .min(0, "Advance cannot be negative")
    .optional(),

  // Who is responsible for the Paid ("advance") amount - only
  // meaningful/required when BOTH consignorParty and consigneeParty
  // resolve to real, active Party accounts (never guessed in that
  // case). See lib/document-party-resolution.ts's
  // resolveBiltyPaidResponsibleParty().
  paidResponsibility: z
    .enum(["CONSIGNOR", "CONSIGNEE"])
    .optional(),

  // Agent Commission
  agentPartyId: z
    .string()
    .optional()
    .or(z.literal("")),

  agentCommission: z
    .number()
    .min(
      0,
      "Agent commission cannot be negative"
    )
    .optional(),

  agentDescription: z
    .string()
    .optional()
    .or(z.literal("")),

  notes: z
    .string()
    .optional()
    .or(z.literal("")),
});

// GET /api/bilty
const BILTY_STATUS_VALUES: BiltyStatus[] = [
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "CANCELLED",
];

export async function GET(request: NextRequest) {
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
        "bilty.view"
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

    // ========================================================
    // SEARCH / FILTER / PAGINATION (P2-3)
    //
    // Same fields the list page's own client-side filter already
    // searched (Bilty No., consignor/consignee, route, vehicle
    // type, registration number, clearing agent) - moved server-
    // side so the whole table no longer has to be loaded to filter
    // it. Same status values the page already supports.
    // ========================================================

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim() || "";
    const statusParam = searchParams.get("status");
    const status =
      statusParam && BILTY_STATUS_VALUES.includes(statusParam as BiltyStatus)
        ? (statusParam as BiltyStatus)
        : null;

    // A syntactically valid but astronomically large `page` (e.g. from a
    // hand-edited URL) must never reach Prisma's `skip` calculation - it
    // overflows there and throws, which the generic catch below would
    // otherwise turn into an unexplained 500. Number.isSafeInteger() is
    // the exact boundary: a garbage/non-numeric value (parses to NaN)
    // still falls back to page 1 exactly as before - only a real,
    // enormous number is rejected.
    const rawPage = searchParams.get("page");
    const parsedPage = rawPage ? parseInt(rawPage, 10) : 1;
    if (rawPage && !Number.isNaN(parsedPage) && !Number.isSafeInteger(parsedPage)) {
      return NextResponse.json(
        { success: false, message: "Invalid page number" },
        { status: 400 }
      );
    }
    const page = Math.max(1, parsedPage || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "25", 10) || 25)
    );

    const where: Prisma.BiltyWhereInput = {
      isDeleted: false,
      ...(status ? { status } : {}),
      ...(search ? { OR: biltyListSearchOr(search) } : {}),
    };

    const [bilties, total] =
      await Promise.all([
        prisma.bilty.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,

        include: {
          fromLocation: {
            select: {
              id: true,
              name: true,
            },
          },

          toLocation: {
            select: {
              id: true,
              name: true,
            },
          },

          consignorParty: {
            select: {
              id: true,
              partyName: true,
            },
          },

          consigneeParty: {
            select: {
              id: true,
              partyName: true,
            },
          },

          clearingAgentParty: {
            select: {
              id: true,
              partyName: true,
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
        },

        agentParty: {
          select: {
            id: true,
            partyName: true,
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
        },

        createdBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },

        // Reverse reference to this Bilty's own Challan (Goal #10 of
        // the navigation audit - only Challan pages linked DOWN to
        // their Bilties before; this is the missing link back UP).
        // Only the current, non-deleted Challan.
        challanBilties: {
          where: { challan: { isDeleted: false } },
          take: 1,
          select: { challan: { select: { id: true, challanNo: true } } },
        },
      },

        orderBy: [
          { date: "desc" },
          { createdAt: "desc" },
        ],
        }),
        prisma.bilty.count({ where }),
      ]);

    return NextResponse.json({
      success: true,
      bilties,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (error) {
    console.error(
      "Get bilties error:",
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

// POST /api/bilty
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
        "bilty.create"
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to create bilties",
        },
        { status: 403 }
      );
    }

    const body =
      await request.json();

    const result =
      createBiltySchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid bilty data",
          errors:
            result.error.flatten()
              .fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    // ------------------------------------------------
    // 1. CHECK BILTY NUMBER
    // ------------------------------------------------

    const existingBilty =
      await prisma.bilty.findUnique({
        where: {
          biltyNo: data.biltyNo,
        },
      });

    if (existingBilty) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Bilty number already exists",
        },
        { status: 409 }
      );
    }

    // ------------------------------------------------
    // 2. VALIDATE DATE
    // ------------------------------------------------

    const biltyDate =
      new Date(data.date);

    if (
      Number.isNaN(
        biltyDate.getTime()
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid bilty date",
        },
        { status: 400 }
      );
    }

    // ------------------------------------------------
    // 3. VALIDATE LOCATIONS
    // ------------------------------------------------

    const fromLocation =
      await prisma.location.findUnique({
        where: {
          id: data.fromLocationId,
        },
      });

    if (!fromLocation) {
      return NextResponse.json(
        {
          success: false,
          message:
            "From location not found",
        },
        { status: 404 }
      );
    }

    if (!fromLocation.isActive) {
      return NextResponse.json(
        {
          success: false,
          message:
            "From location is inactive",
        },
        { status: 400 }
      );
    }

    const toLocation =
      await prisma.location.findUnique({
        where: {
          id: data.toLocationId,
        },
      });

    if (!toLocation) {
      return NextResponse.json(
        {
          success: false,
          message:
            "To location not found",
        },
        { status: 404 }
      );
    }

    if (!toLocation.isActive) {
      return NextResponse.json(
        {
          success: false,
          message:
            "To location is inactive",
        },
        { status: 400 }
      );
    }

    // ------------------------------------------------
    // 4. VALIDATE CONSIGNOR PARTY
    // ------------------------------------------------

    let consignorPartyId:
      string | null = null;

    if (data.consignorPartyId) {
      const consignorParty =
        await prisma.party.findUnique({
          where: {
            id: data.consignorPartyId,
          },
        });

      if (!consignorParty) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Consignor party not found",
          },
          { status: 404 }
        );
      }

      if (!consignorParty.isActive) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Consignor party is inactive",
          },
          { status: 400 }
        );
      }

      consignorPartyId =
        consignorParty.id;
    }

    // ------------------------------------------------
    // 5. VALIDATE CONSIGNEE PARTY
    // ------------------------------------------------

    let consigneePartyId:
      string | null = null;

    if (data.consigneePartyId) {
      const consigneeParty =
        await prisma.party.findUnique({
          where: {
            id: data.consigneePartyId,
          },
        });

      if (!consigneeParty) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Consignee party not found",
          },
          { status: 404 }
        );
      }

      if (!consigneeParty.isActive) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Consignee party is inactive",
          },
          { status: 400 }
        );
      }

      consigneePartyId =
        consigneeParty.id;
    }

    // ------------------------------------------------
    // 6. VALIDATE CLEARING AGENT PARTY
    // ------------------------------------------------

    let clearingAgentPartyId:
      string | null = null;
    let clearingAgentName:
      string | null = null;

    if (data.clearingAgentPartyId !== undefined) {
      if (data.clearingAgentPartyId === "") {
        clearingAgentPartyId = null;
        clearingAgentName = null;
      } else {
        const clearingAgentParty =
          await prisma.party.findUnique({
            where: {
              id: data.clearingAgentPartyId,
            },
          });

        if (!clearingAgentParty) {
          return NextResponse.json(
            {
              success: false,
              message:
                "Clearing agent party not found",
            },
            { status: 404 }
          );
        }

        if (!clearingAgentParty.isActive) {
          return NextResponse.json(
            {
              success: false,
              message:
                "Clearing agent party is inactive",
            },
            { status: 400 }
          );
        }

        if (!clearingAgentParty.partyTypes.includes(PartyType.CLEARING_AGENT)) {
          return NextResponse.json(
            {
              success: false,
              message:
                "Selected party is not a clearing agent",
            },
            { status: 400 }
          );
        }

        clearingAgentPartyId =
          clearingAgentParty.id;
        clearingAgentName =
          clearingAgentParty.partyName;
      }
    }

    // ------------------------------------------------
    // 7. VALIDATE AGENT PARTY
    // ------------------------------------------------

    let agentPartyId: string | null = null;
    let agentAccountId: string | null = null;

    if (data.agentPartyId) {
      const agentParty = await prisma.party.findUnique({
        where: {
          id: data.agentPartyId,
        },
        include: {
          account: true,
        },
      });

      if (!agentParty) {
        return NextResponse.json(
          {
            success: false,
            message: "Agent party not found",
          },
          { status: 404 }
        );
      }

      if (!agentParty.isActive) {
        return NextResponse.json(
          {
            success: false,
            message: "Agent party is inactive",
          },
          { status: 400 }
        );
      }

      if (!agentParty.account) {
        return NextResponse.json(
          {
            success: false,
            message: "Agent party does not have an account",
          },
          { status: 400 }
        );
      }

      agentPartyId = agentParty.id;
      agentAccountId = agentParty.account.id;
    }

    // ------------------------------------------------
    // 8. CALCULATE FREIGHT
    // ------------------------------------------------

    const rent =
      data.rent ?? 0;

    const insurance =
      data.insurance ?? 0;

    const expense =
      data.expense ?? 0;

    const advance =
      data.advance ?? 0;

    const agentCommission =
      data.agentCommission ?? 0;

    const total =
      rent +
      insurance +
      expense;

    const toPay =
      total - advance;

    // ------------------------------------------------
    // 9. ADVANCE CANNOT EXCEED TOTAL
    // ------------------------------------------------

    if (advance > total) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Advance cannot be greater than total",
        },
        { status: 400 }
      );
    }

    // ------------------------------------------------
    // 9B. RESOLVE PAID (ADVANCE) RESPONSIBILITY
    //
    // Only meaningful when advance > 0. Never guessed when BOTH
    // Consignor and Consignee resolve to real, active Party accounts -
    // an explicit paidResponsibility is required in that case. When
    // only one (or neither) has a valid account, the field is left
    // null here and resolveBiltyPaidResponsibleParty() auto-derives
    // it on read - no need to persist a value that's already
    // unambiguous from the Bilty's own consignor/consignee accounts.
    // ------------------------------------------------

    let paidResponsiblePartyId: string | null = null;

    if (advance > 0) {
      const [consignorAccount, consigneeAccount] = await Promise.all([
        consignorPartyId
          ? prisma.account.findFirst({ where: { partyId: consignorPartyId, isActive: true }, select: { id: true } })
          : null,
        consigneePartyId
          ? prisma.account.findFirst({ where: { partyId: consigneePartyId, isActive: true }, select: { id: true } })
          : null,
      ]);

      if (consignorAccount && consigneeAccount) {
        if (!data.paidResponsibility) {
          return NextResponse.json(
            {
              success: false,
              message:
                "Both Consignor and Consignee have Party accounts - select who is responsible for the Paid amount (paidResponsibility: CONSIGNOR or CONSIGNEE).",
            },
            { status: 400 }
          );
        }
        paidResponsiblePartyId = data.paidResponsibility === "CONSIGNOR" ? consignorPartyId : consigneePartyId;
      } else if (data.paidResponsibility) {
        const chosenAccount = data.paidResponsibility === "CONSIGNOR" ? consignorAccount : consigneeAccount;
        if (!chosenAccount) {
          return NextResponse.json(
            {
              success: false,
              message: `Selected Paid responsibility (${data.paidResponsibility}) does not have a valid Party account.`,
            },
            { status: 400 }
          );
        }
        paidResponsiblePartyId = data.paidResponsibility === "CONSIGNOR" ? consignorPartyId : consigneePartyId;
      }
    }

    // ------------------------------------------------
    // 10. AGENT COMMISSION VALIDATION
    // ------------------------------------------------

    if (
      agentCommission > 0 &&
      !agentPartyId
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Agent party is required when agent commission is greater than zero",
        },
        { status: 400 }
      );
    }

    // ------------------------------------------------
    // 11. RESOLVE ACCOUNTING (Booking Income / Commission)
    //
    // Full Booking Income (and, if present, the full Booking
    // Agent Commission expense) is recognized NOW, at booking
    // time - not later at Settlement. The responsible PARTY for
    // each is not yet known, so the offsetting side is a gross
    // clearing account that Settlement will later reclassify into
    // the real party. See lib/gross-accounts.ts.
    // ------------------------------------------------

    let bookingIncomeAccountId: string | null = null;

    if (total > 0) {
      const bookingIncomeAccount = await prisma.account.findFirst({
        where: { category: "BOOKING_INCOME", isActive: true },
        select: { id: true },
      });

      if (!bookingIncomeAccount) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Required account is not configured. Please configure a BOOKING_INCOME account.",
          },
          { status: 400 }
        );
      }

      bookingIncomeAccountId = bookingIncomeAccount.id;
    }

    let commissionExpenseAccountId: string | null = null;

    if (agentCommission > 0) {
      const otherExpenseAccount = await prisma.account.findFirst({
        where: { category: "OTHER_EXPENSE", isActive: true },
        select: { id: true },
      });

      if (!otherExpenseAccount) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Required account is not configured. Please configure an OTHER_EXPENSE account.",
          },
          { status: 400 }
        );
      }

      commissionExpenseAccountId = otherExpenseAccount.id;
    }

    // ------------------------------------------------
    // 12. CREATE BILTY (+ booking accounting, atomically)
    // ------------------------------------------------

    let bilty;
    try {
    bilty = await prisma.$transaction(async (tx) => {
      const createdBilty = await tx.bilty.create({
        data: {
          biltyNo:
            data.biltyNo,

          date:
            biltyDate,

          fromLocationId:
            data.fromLocationId,

          toLocationId:
            data.toLocationId,

          consignorPartyId:
            consignorPartyId,

          consignorName:
            data.consignorName,

          consignorPhone:
            data.consignorPhone ||
            null,

          consigneePartyId:
            consigneePartyId,

          consigneeName:
            data.consigneeName,

          consigneePhone:
            data.consigneePhone ||
            null,

          vehicleType:
            data.vehicleType ||
            null,

          vehicleModel:
            data.vehicleModel ||
            null,

          vehicleColor:
            data.vehicleColor ||
            null,

          engineNumber:
            data.engineNumber ||
            null,

          chassisNumber:
            data.chassisNumber ||
            null,

          registrationNumber:
            data.registrationNumber ||
            null,

          clearingAgentPartyId:
            clearingAgentPartyId,

          clearingAgentName:
            clearingAgentName,

          rent,

          insurance,

          expense,

          total,

          advance,

          toPay,

          paidResponsiblePartyId,

          agentPartyId:
            agentPartyId,

          agentCommission,

          agentDescription:
            data.agentDescription ||
            null,

          notes:
            data.notes || null,

          status: "PENDING",

          isDeleted: false,

          createdById:
            currentUser.userId,
        },

        include: {
          fromLocation: {
            select: {
              id: true,
              name: true,
            },
          },

          toLocation: {
            select: {
              id: true,
              name: true,
            },
          },

          consignorParty: {
            select: {
              id: true,
              partyName: true,
            },
          },

          consigneeParty: {
            select: {
              id: true,
              partyName: true,
            },
          },

          clearingAgentParty: {
            select: {
              id: true,
              partyName: true,
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
        },
        agentParty: {
          select: {
            id: true,
            partyName: true,
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
        },
        createdBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
      },
    });

      // --------------------------------------------------
      // BOOKING ACCOUNTING - recognized once, now.
      //
      // Dr Gross Bilty Receivable / Cr Booking Income
      // Dr Booking Agent Commission (expense) / Cr Gross Commission Payable
      //
      // Settlement will later reclassify these gross balances
      // into whichever real party is responsible - it must never
      // touch Booking Income or Commission expense again.
      // --------------------------------------------------

      const journalLines: {
        accountId: string;
        debit: number;
        credit: number;
        description: string;
        sourceType: string;
        sourceId: string;
        sourceNumber: string;
      }[] = [];

      if (total > 0 && bookingIncomeAccountId) {
        const grossBiltyReceivableId = await getGrossBiltyReceivableAccountId(tx);

        journalLines.push(
          {
            accountId: grossBiltyReceivableId,
            debit: total,
            credit: 0,
            description: `Booking - ${createdBilty.biltyNo} - Bilty Rent`,
            sourceType: "BILTY",
            sourceId: createdBilty.id,
            sourceNumber: createdBilty.biltyNo,
          },
          {
            accountId: bookingIncomeAccountId,
            debit: 0,
            credit: total,
            description: `Booking - ${createdBilty.biltyNo} - Bilty Rent`,
            sourceType: "BILTY",
            sourceId: createdBilty.id,
            sourceNumber: createdBilty.biltyNo,
          }
        );
      }

      // Commission/Referral is credited DIRECTLY to the selected
      // agentParty's own account, immediately, in this same Bilty-
      // creation transaction - never a gross/suspense clearing account.
      // Unlike Bilty Rent (Collection) or Challan's own Carrier Rent,
      // the responsible party for Commission is already fully known at
      // booking time (agentPartyId, selected right here) - there is no
      // "responsibility not yet determined until Settlement" ambiguity
      // to defer, so the gross-account-then-reclassify pattern (see
      // lib/gross-accounts.ts) does not apply to this component.
      // Settlement's own commission reclassification
      // (lib/settlement-accounting.ts) is made a data-driven no-op for
      // any Bilty whose commission was posted this way (see that
      // file's own updated comment) - it still correctly reclassifies
      // a genuinely pre-existing, not-yet-settled Bilty created before
      // this change, whose commission is still sitting in the gross
      // account.
      if (agentCommission > 0 && commissionExpenseAccountId && agentAccountId) {
        const commissionDescription = buildBiltyCommissionDescription(createdBilty, agentCommission);

        journalLines.push(
          {
            accountId: commissionExpenseAccountId,
            debit: agentCommission,
            credit: 0,
            description: commissionDescription,
            sourceType: "BILTY",
            sourceId: createdBilty.id,
            sourceNumber: createdBilty.biltyNo,
          },
          {
            accountId: agentAccountId,
            debit: 0,
            credit: agentCommission,
            description: commissionDescription,
            sourceType: "BILTY",
            sourceId: createdBilty.id,
            sourceNumber: createdBilty.biltyNo,
          }
        );
      }

      if (journalLines.length > 0) {
        await tx.journalEntry.create({
          data: {
            entryDate: biltyDate,
            referenceType: "BILTY_BOOKING",
            referenceId: createdBilty.id,
            description: `Bilty Booking - ${createdBilty.biltyNo}`,
            createdById: currentUser.userId,
            lines: { create: journalLines },
          },
        });
      }

      // ------------------------------------------------
      // ESTABLISH PAID RECEIVABLE (lib/settlement-payments.ts, "PAID"
      // component) - a Dr Party / Cr Gross Bilty Receivable
      // reclassification, atomic with the Bilty's own creation (if
      // this fails, the whole Bilty creation rolls back too). Never
      // touches Booking Income. Only fires when a responsible party
      // was actually resolved above (explicit choice, or the single-
      // valid-account auto-resolve case) - never fabricated.
      // ------------------------------------------------

      if (advance > 0) {
        const paidResponsible = await resolveBiltyPaidResponsibleParty(createdBilty.id, tx);
        if (paidResponsible) {
          await createSettlementPayment(
            {
              component: "PAID",
              biltyId: createdBilty.id,
              payerAccountId: paidResponsible.accountId,
              amount: advance,
              createdById: currentUser.userId,
            },
            tx
          );
        }
      }

      await auditCreate(tx, {
        actor: actorFromUser(currentUser),
        module: "BILTY",
        entityType: "Bilty",
        entityId: createdBilty.id,
        documentNo: createdBilty.biltyNo,
        description: `Created Bilty ${createdBilty.biltyNo} (${data.consigneeName}, Rent Rs. ${rent.toLocaleString()}, To Pay Rs. ${toPay.toLocaleString()})`,
        newValues: {
          biltyNo: createdBilty.biltyNo,
          fromLocationId: data.fromLocationId,
          toLocationId: data.toLocationId,
          consignorName: data.consignorName,
          consigneeName: data.consigneeName,
          rent,
          insurance,
          expense,
          total,
          advance,
          toPay,
        },
        ...requestContext(request),
      });

      return createdBilty;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (paidError) {
      if (paidError instanceof SettlementPaymentError) {
        return NextResponse.json(
          { success: false, code: paidError.code, message: paidError.message },
          { status: 400 }
        );
      }
      if (paidError instanceof Prisma.PrismaClientKnownRequestError && paidError.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Bilty could not be created due to a concurrent change. Please retry." },
          { status: 409 }
        );
      }
      throw paidError;
    }

    return NextResponse.json(
      {
        success: true,
        message:
          "Bilty created successfully",
        bilty,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error(
      "Create bilty error:",
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