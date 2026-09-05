import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { PartyType, Prisma } from "@prisma/client";
import { applySettlementCorrection, MissingResponsiblePartyError } from "@/lib/settlement-correction";
import {
  assertComponentTotalNotBelowActiveRows,
  createSettlementPayment,
  deleteSettlementPayment,
  reassignPaidResponsibility,
  SettlementPaymentError,
  updateSettlementPaymentAmount,
} from "@/lib/settlement-payments";
import { BiltyPaidVerificationError, getBiltyPaidVerification } from "@/lib/bilty-paid-verification";

const updateBiltySchema = z.object({
  biltyNo: z.string().trim().min(1, "Bilty number is required").optional(),

  date: z.string().min(1, "Bilty date is required").optional(),

  fromLocationId: z.string().min(1, "From location is required").optional(),

  toLocationId: z.string().min(1, "To location is required").optional(),

  consignorPartyId: z.string().optional().or(z.literal("")),

  consignorName: z.string().trim().min(1, "Consignor name is required").optional(),

  consignorPhone: z.string().optional().or(z.literal("")),

  consigneePartyId: z.string().optional().or(z.literal("")),

  consigneeName: z.string().trim().min(1, "Consignee name is required").optional(),

  consigneePhone: z.string().optional().or(z.literal("")),

  vehicleType: z.string().optional().or(z.literal("")),

  vehicleModel: z.string().optional().or(z.literal("")),

  vehicleColor: z.string().optional().or(z.literal("")),

  engineNumber: z.string().optional().or(z.literal("")),

  chassisNumber: z.string().optional().or(z.literal("")),

  registrationNumber: z.string().optional().or(z.literal("")),

  // Clearing Agent / Delivery Point
  clearingAgentPartyId: z.string().optional().or(z.literal("")),

  // Freight
  rent: z.number().min(0, "Rent cannot be negative").optional(),

  insurance: z.number().min(0, "Insurance cannot be negative").optional(),

  expense: z.number().min(0, "Expense cannot be negative").optional(),

  advance: z.number().min(0, "Advance cannot be negative").optional(),

  // Who is responsible for the Paid ("advance") amount - see
  // app/api/bilty/route.ts's POST for the identical resolution rule.
  paidResponsibility: z.enum(["CONSIGNOR", "CONSIGNEE"]).optional(),

  // Agent Commission
  agentPartyId: z.string().optional().or(z.literal("")),

  agentCommission: z.number().min(0, "Agent commission cannot be negative").optional(),

  agentDescription: z.string().optional().or(z.literal("")),

  notes: z.string().optional().or(z.literal("")),

  // Only required when a Commission amount is being changed on a
  // Bilty whose Challan is already settled AND no responsible
  // party was established for Commission at settlement time (e.g.
  // Commission was 0 then). See lib/settlement-correction.ts.
  commissionResponsibility: z
    .object({
      responsibility: z.enum(["CLEARING_AGENT", "TRANSPORTER", "THIRD_PARTY"]),
      thirdPartyAccountId: z.string().optional(),
    })
    .optional(),
});

export async function GET(
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

    if (!hasPermission(currentUser, "bilty.view")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const bilty = await prisma.bilty.findUnique({
      where: { id },
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
        consigneeParty: {
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
        updatedBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
      },
    });

    if (!bilty || bilty.isDeleted) {
      return NextResponse.json(
        {
          success: false,
          message: "Bilty not found",
        },
        { status: 404 }
      );
    }

    // Derived Unverified ANC receipt state - never a stored field,
    // see lib/bilty-paid-verification.ts. Additive only: existing
    // consumers of this response are unaffected by the new key.
    const paidVerification = await getBiltyPaidVerification(prisma, id);

    return NextResponse.json({
      success: true,
      bilty,
      paidVerification,
    });
  } catch (error) {
    console.error("Get bilty error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}

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

    if (!hasPermission(currentUser, "bilty.edit")) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to edit bilties",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const existingBilty = await prisma.bilty.findUnique({
      where: { id },
    });

    if (!existingBilty) {
      return NextResponse.json(
        {
          success: false,
          message: "Bilty not found",
        },
        { status: 404 }
      );
    }

    if (existingBilty.isDeleted) {
      return NextResponse.json(
        {
          success: false,
          message: "Bilty is deleted and cannot be edited",
        },
        { status: 400 }
      );
    }

    const body = await request.json();

    const result = updateBiltySchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid bilty data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    // Helper to normalize optional nullable string fields:
    // - undefined (omitted) → preserve existing
    // - "" (empty string) → null
    // - non-empty string → value
    const normalizeOptionalString = (
      incoming: string | undefined,
      existing: string | null
    ): string | null => {
      if (incoming === undefined) {
        return existing;
      }
      if (incoming === "") {
        return null;
      }
      return incoming;
    };

    // Check Bilty Number uniqueness if being changed
    if (data.biltyNo && data.biltyNo !== existingBilty.biltyNo) {
      const duplicateBilty = await prisma.bilty.findUnique({
        where: { biltyNo: data.biltyNo },
      });

      if (duplicateBilty) {
        return NextResponse.json(
          {
            success: false,
            message: "Bilty number already exists",
          },
          { status: 409 }
        );
      }
    }

    // Validate date if provided
    let biltyDate = existingBilty.date;
    if (data.date) {
      const parsedDate = new Date(data.date);
      if (Number.isNaN(parsedDate.getTime())) {
        return NextResponse.json(
          {
            success: false,
            message: "Invalid bilty date",
          },
          { status: 400 }
        );
      }
      biltyDate = parsedDate;
    }

    // Validate From Location if provided
    let fromLocationId = existingBilty.fromLocationId;
    if (data.fromLocationId) {
      const fromLocation = await prisma.location.findUnique({
        where: { id: data.fromLocationId },
      });

      if (!fromLocation) {
        return NextResponse.json(
          {
            success: false,
            message: "From location not found",
          },
          { status: 404 }
        );
      }

      if (!fromLocation.isActive) {
        return NextResponse.json(
          {
            success: false,
            message: "From location is inactive",
          },
          { status: 400 }
        );
      }

      fromLocationId = fromLocation.id;
    }

    // Validate To Location if provided
    let toLocationId = existingBilty.toLocationId;
    if (data.toLocationId) {
      const toLocation = await prisma.location.findUnique({
        where: { id: data.toLocationId },
      });

      if (!toLocation) {
        return NextResponse.json(
          {
            success: false,
            message: "To location not found",
          },
          { status: 404 }
        );
      }

      if (!toLocation.isActive) {
        return NextResponse.json(
          {
            success: false,
            message: "To location is inactive",
          },
          { status: 400 }
        );
      }

      toLocationId = toLocation.id;
    }

    // Validate Consignor Party
    let consignorPartyId: string | null = existingBilty.consignorPartyId;
    if (data.consignorPartyId !== undefined) {
      if (data.consignorPartyId === "") {
        consignorPartyId = null;
      } else {
        const consignorParty = await prisma.party.findUnique({
          where: { id: data.consignorPartyId },
        });

        if (!consignorParty) {
          return NextResponse.json(
            {
              success: false,
              message: "Consignor party not found",
            },
            { status: 404 }
          );
        }

        if (!consignorParty.isActive) {
          return NextResponse.json(
            {
              success: false,
              message: "Consignor party is inactive",
            },
            { status: 400 }
          );
        }

        consignorPartyId = consignorParty.id;
      }
    }

    // Validate Consignee Party
    let consigneePartyId: string | null = existingBilty.consigneePartyId;
    if (data.consigneePartyId !== undefined) {
      if (data.consigneePartyId === "") {
        consigneePartyId = null;
      } else {
        const consigneeParty = await prisma.party.findUnique({
          where: { id: data.consigneePartyId },
        });

        if (!consigneeParty) {
          return NextResponse.json(
            {
              success: false,
              message: "Consignee party not found",
            },
            { status: 404 }
          );
        }

        if (!consigneeParty.isActive) {
          return NextResponse.json(
            {
              success: false,
              message: "Consignee party is inactive",
            },
            { status: 400 }
          );
        }

        consigneePartyId = consigneeParty.id;
      }
    }

    // Validate Clearing Agent Party
    let clearingAgentPartyId: string | null = existingBilty.clearingAgentPartyId;
    let clearingAgentName: string | null = existingBilty.clearingAgentName;
    if (data.clearingAgentPartyId !== undefined) {
      if (data.clearingAgentPartyId === "") {
        clearingAgentPartyId = null;
        clearingAgentName = null;
      } else {
        const clearingAgentParty = await prisma.party.findUnique({
          where: { id: data.clearingAgentPartyId },
        });

        if (!clearingAgentParty) {
          return NextResponse.json(
            {
              success: false,
              message: "Clearing agent party not found",
            },
            { status: 404 }
          );
        }

        if (!clearingAgentParty.isActive) {
          return NextResponse.json(
            {
              success: false,
              message: "Clearing agent party is inactive",
            },
            { status: 400 }
          );
        }

        if (!clearingAgentParty.partyTypes.includes(PartyType.CLEARING_AGENT)) {
          return NextResponse.json(
            {
              success: false,
              message: "Selected party is not a clearing agent",
            },
            { status: 400 }
          );
        }

        clearingAgentPartyId = clearingAgentParty.id;
        clearingAgentName = clearingAgentParty.partyName;
      }
    }

    // Validate Agent Party
    let agentPartyId: string | null = existingBilty.agentPartyId;
    if (data.agentPartyId !== undefined) {
      if (data.agentPartyId === "") {
        agentPartyId = null;
      } else {
        const agentParty = await prisma.party.findUnique({
          where: { id: data.agentPartyId },
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
      }
    }

    // Calculate freight values using merged data
    const rent = Number(data.rent ?? existingBilty.rent);
    const insurance = Number(data.insurance ?? existingBilty.insurance);
    const expense = Number(data.expense ?? existingBilty.expense);
    const advance = Number(data.advance ?? existingBilty.advance);
    const agentCommission = Number(data.agentCommission ?? existingBilty.agentCommission);

    const total = rent + insurance + expense;
    const toPay = total - advance;

    // Advance cannot exceed total
    if (advance > total) {
      return NextResponse.json(
        {
          success: false,
          message: "Advance cannot be greater than total",
        },
        { status: 400 }
      );
    }

    // ------------------------------------------------
    // RESOLVE PAID (ADVANCE) RESPONSIBILITY
    //
    // Mirrors app/api/bilty/route.ts's POST logic. An existing
    // explicit choice is preserved across unrelated edits as long as
    // it still matches one of the current consignor/consignee ids;
    // a fresh explicit choice is required only when both currently
    // have valid accounts and neither has already been chosen.
    // ------------------------------------------------

    let paidResponsiblePartyId: string | null = existingBilty.paidResponsiblePartyId;
    // The EFFECTIVE responsible Party's account id, computed here
    // from local resolution rather than re-reading the Bilty row
    // later (which would still show its PRE-edit values inside this
    // same transaction) - used to establish/reassign/sync the "PAID"
    // SettlementPayment row below.
    let paidResponsibleAccountId: string | null = null;

    if (advance > 0) {
      const [consignorAccountForPaid, consigneeAccountForPaid] = await Promise.all([
        consignorPartyId
          ? prisma.account.findFirst({ where: { partyId: consignorPartyId, isActive: true }, select: { id: true } })
          : null,
        consigneePartyId
          ? prisma.account.findFirst({ where: { partyId: consigneePartyId, isActive: true }, select: { id: true } })
          : null,
      ]);

      if (data.paidResponsibility) {
        const chosenAccount = data.paidResponsibility === "CONSIGNOR" ? consignorAccountForPaid : consigneeAccountForPaid;
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
        paidResponsibleAccountId = chosenAccount.id;
      } else if (consignorAccountForPaid && consigneeAccountForPaid) {
        if (paidResponsiblePartyId !== consignorPartyId && paidResponsiblePartyId !== consigneePartyId) {
          return NextResponse.json(
            {
              success: false,
              message:
                "Both Consignor and Consignee have Party accounts - select who is responsible for the Paid amount (paidResponsibility: CONSIGNOR or CONSIGNEE).",
            },
            { status: 400 }
          );
        }
        paidResponsibleAccountId =
          paidResponsiblePartyId === consignorPartyId ? consignorAccountForPaid.id : consigneeAccountForPaid.id;
      } else {
        // No longer ambiguous (0 or 1 valid account) - clear any
        // stale explicit choice and let it auto-resolve; the single
        // valid account (if any) is the effective responsible one.
        paidResponsiblePartyId = null;
        paidResponsibleAccountId = consignorAccountForPaid?.id || consigneeAccountForPaid?.id || null;
      }
    } else {
      paidResponsiblePartyId = null;
    }

    // Agent commission requires agent party
    if (agentCommission > 0 && !agentPartyId) {
      return NextResponse.json(
        {
          success: false,
          message: "Agent party is required when agent commission is greater than zero",
        },
        { status: 400 }
      );
    }

    // Ensure required names are present
    const consignorName = data.consignorName ?? existingBilty.consignorName;
    const consigneeName = data.consigneeName ?? existingBilty.consigneeName;

    if (!consignorName.trim()) {
      return NextResponse.json(
        {
          success: false,
          message: "Consignor name is required",
        },
        { status: 400 }
      );
    }

    if (!consigneeName.trim()) {
      return NextResponse.json(
        {
          success: false,
          message: "Consignee name is required",
        },
        { status: 400 }
      );
    }

    // ========================================================
    // ACCOUNTING-SAFE CORRECTION
    //
    // Booking Income (and Commission expense, if any) was already
    // recognized in full when the Bilty was created (or by a prior
    // correction). Changing rent/insurance/expense (=> total) or
    // agentCommission must post a balanced correction for the
    // delta only - never overwrite history. See
    // lib/settlement-correction.ts.
    // ========================================================

    const oldTotal = Number(existingBilty.total);
    const oldCommission = Number(existingBilty.agentCommission);
    const totalDelta = Number((total - oldTotal).toFixed(2));
    const commissionDelta = Number((agentCommission - oldCommission).toFixed(2));

    let bookingIncomeAccountId: string | undefined;
    let commissionExpenseAccountId: string | undefined;

    if (totalDelta !== 0) {
      const bookingIncomeAccount = await prisma.account.findFirst({
        where: { category: "BOOKING_INCOME", isActive: true },
        select: { id: true },
      });
      if (!bookingIncomeAccount) {
        return NextResponse.json(
          {
            success: false,
            message: "Required account is not configured. Please configure a BOOKING_INCOME account.",
          },
          { status: 400 }
        );
      }
      bookingIncomeAccountId = bookingIncomeAccount.id;
    }

    if (commissionDelta !== 0) {
      const otherExpenseAccount = await prisma.account.findFirst({
        where: { category: "OTHER_EXPENSE", isActive: true },
        select: { id: true },
      });
      if (!otherExpenseAccount) {
        return NextResponse.json(
          {
            success: false,
            message: "Required account is not configured. Please configure an OTHER_EXPENSE account.",
          },
          { status: 400 }
        );
      }
      commissionExpenseAccountId = otherExpenseAccount.id;
    }

    let activeChallanContext: {
      challanId: string;
      challanNo: string;
      isSettled: boolean;
      settlementJournalEntryId: string | null;
    } | null = null;

    if (totalDelta !== 0 || commissionDelta !== 0) {
      const activeLink = await prisma.challanBilty.findFirst({
        where: {
          biltyId: id,
          challan: { isDeleted: false, status: { not: "CANCELLED" } },
        },
        include: {
          challan: {
            select: {
              id: true,
              challanNo: true,
              isSettled: true,
              settlementJournalEntryId: true,
            },
          },
        },
      });

      if (activeLink) {
        activeChallanContext = {
          challanId: activeLink.challan.id,
          challanNo: activeLink.challan.challanNo,
          isSettled: activeLink.challan.isSettled,
          settlementJournalEntryId: activeLink.challan.settlementJournalEntryId,
        };
      }
    }

    // ========================================================
    // RESOLVE COMMISSION RESPONSIBILITY (if the client provided one)
    //
    // Only meaningful when the Challan is already settled - a
    // not-yet-settled Bilty's commission correction always targets
    // the gross clearing account, and Settlement (whenever it
    // later runs) will ask for responsibility itself.
    // ========================================================

    let explicitCommissionPartyAccountId: string | undefined;

    if (commissionDelta !== 0 && activeChallanContext?.isSettled && data.commissionResponsibility) {
      const { responsibility, thirdPartyAccountId } = data.commissionResponsibility;

      if (responsibility === "CLEARING_AGENT") {
        const clearingAgentPartyId = data.clearingAgentPartyId !== undefined
          ? (data.clearingAgentPartyId || null)
          : existingBilty.clearingAgentPartyId;

        if (!clearingAgentPartyId) {
          return NextResponse.json(
            { success: false, message: "This Bilty has no Clearing Agent assigned; choose a different commission responsibility." },
            { status: 400 }
          );
        }

        const clearingAgentAccount = await prisma.account.findFirst({
          where: { partyId: clearingAgentPartyId },
          select: { id: true },
        });

        if (!clearingAgentAccount) {
          return NextResponse.json(
            { success: false, message: "Clearing Agent does not have an account." },
            { status: 400 }
          );
        }

        explicitCommissionPartyAccountId = clearingAgentAccount.id;
      } else if (responsibility === "TRANSPORTER") {
        if (!activeChallanContext) {
          return NextResponse.json(
            { success: false, message: "This Bilty is not linked to an active Challan with a Transporter." },
            { status: 400 }
          );
        }

        const challanWithTransporter = await prisma.challan.findUnique({
          where: { id: activeChallanContext.challanId },
          select: { transporterParty: { select: { account: { select: { id: true } } } } },
        });

        if (!challanWithTransporter?.transporterParty?.account?.id) {
          return NextResponse.json(
            { success: false, message: "Challan has no Transporter assigned; choose a different commission responsibility." },
            { status: 400 }
          );
        }

        explicitCommissionPartyAccountId = challanWithTransporter.transporterParty.account.id;
      } else {
        if (!thirdPartyAccountId) {
          return NextResponse.json(
            { success: false, message: "A party/account must be selected for the commission responsibility." },
            { status: 400 }
          );
        }

        const account = await prisma.account.findUnique({
          where: { id: thirdPartyAccountId },
          select: { category: true, isActive: true },
        });

        if (!account || account.category !== "PARTY" || !account.isActive) {
          return NextResponse.json(
            { success: false, message: "Selected commission responsibility account must be an active Party account." },
            { status: 400 }
          );
        }

        explicitCommissionPartyAccountId = thirdPartyAccountId;
      }
    }

    // Update Bilty (+ correction, atomically)
    let updatedBilty;
    try {
      updatedBilty = await prisma.$transaction(async (tx) => {
      // GUARD (lib/settlement-payments.ts): a Bilty.toPay decrease
      // (from a rent/insurance/expense change, an advance increase,
      // or both - toPay = total - advance, either can reduce it) must
      // never leave the new multi-collector engine's active Collection
      // rows over-committed. Runs unconditionally (not gated on
      // totalDelta) since advance-only changes never set totalDelta
      // but do change toPay. Trivially passes for any Bilty the new
      // engine has never touched (zero rows). Reads the SAME `tx` as
      // the rest of this transaction, which is why this whole
      // transaction is now SERIALIZABLE - required for this check to
      // be race-safe against a concurrent settlement-payment row
      // creation, exactly like every other multi-payer safety check.
      const activeLinkForGuard = await tx.challanBilty.findFirst({
        where: { biltyId: id, challan: { isDeleted: false, status: { not: "CANCELLED" } } },
        select: { challanId: true },
      });
      if (activeLinkForGuard) {
        await assertComponentTotalNotBelowActiveRows(
          tx,
          "COLLECTION",
          { challanId: activeLinkForGuard.challanId, biltyId: id },
          toPay
        );
      }

      // GUARD (lib/bilty-paid-verification.ts): a Paid (advance)
      // decrease must never leave an already-verified ANC receipt
      // amount over-committed - never silently delete/clamp a real
      // Daily-Posting-verified receipt.
      const verificationBeforeUpdate = await getBiltyPaidVerification(tx, id);
      if (verificationBeforeUpdate.verifiedReceivedAmount > advance + 0.009) {
        throw new BiltyPaidVerificationError(
          "PAID_BELOW_VERIFIED",
          `Cannot reduce Paid to ${advance} - ${verificationBeforeUpdate.verifiedReceivedAmount} is already verified as received through Daily Posting. Reduce/reverse the relevant Daily Posting first.`
        );
      }

      if (totalDelta !== 0) {
        await applySettlementCorrection({
          tx,
          component: "COLLECTION",
          delta: totalDelta,
          challanId: activeChallanContext?.challanId || "",
          challanNo: activeChallanContext?.challanNo || "",
          biltyId: id,
          biltyNo: data.biltyNo ?? existingBilty.biltyNo,
          incomeOrExpenseAccountId: bookingIncomeAccountId!,
          isSettled: activeChallanContext?.isSettled ?? false,
          settlementJournalEntryId: activeChallanContext?.settlementJournalEntryId ?? null,
          createdById: currentUser.userId,
          description: `Correction - Bilty ${data.biltyNo ?? existingBilty.biltyNo} - Rent ${oldTotal} -> ${total}`,
        });
      }

      if (commissionDelta !== 0) {
        await applySettlementCorrection({
          tx,
          component: "COMMISSION",
          delta: commissionDelta,
          challanId: activeChallanContext?.challanId || "",
          challanNo: activeChallanContext?.challanNo || "",
          biltyId: id,
          biltyNo: data.biltyNo ?? existingBilty.biltyNo,
          incomeOrExpenseAccountId: commissionExpenseAccountId!,
          isSettled: activeChallanContext?.isSettled ?? false,
          settlementJournalEntryId: activeChallanContext?.settlementJournalEntryId ?? null,
          createdById: currentUser.userId,
          description: `Correction - Bilty ${data.biltyNo ?? existingBilty.biltyNo} - Commission ${oldCommission} -> ${agentCommission}`,
          explicitPartyAccountId: explicitCommissionPartyAccountId,
        });
      }

      // PAID RESPONSIBILITY REASSIGNMENT - must run BEFORE the Bilty
      // row's own paidResponsiblePartyId is updated below, since
      // reassignPaidResponsibility() needs to resolve the OLD
      // responsible party from the ledger/Bilty as it stands right
      // now (see lib/settlement-payments.ts for why this ordering
      // matters: it moves only the currently-unverified remainder,
      // never re-requesting an already-verified receipt).
      const existingPaidRowForReassignment = await tx.settlementPayment.findFirst({
        where: { component: "PAID", biltyId: id },
      });
      if (
        existingPaidRowForReassignment &&
        paidResponsibleAccountId &&
        existingPaidRowForReassignment.payerAccountId !== paidResponsibleAccountId
      ) {
        await reassignPaidResponsibility(tx, id, paidResponsibleAccountId, currentUser.userId);
      }

      const updatedBiltyRow = await tx.bilty.update({
      where: { id },
      data: {
        biltyNo: data.biltyNo ?? existingBilty.biltyNo,
        date: biltyDate,
        fromLocationId,
        toLocationId,
        consignorPartyId,
        consignorName,
        consignorPhone: normalizeOptionalString(
          data.consignorPhone,
          existingBilty.consignorPhone
        ),
        consigneePartyId,
        consigneeName,
        consigneePhone: normalizeOptionalString(
          data.consigneePhone,
          existingBilty.consigneePhone
        ),
        vehicleType: normalizeOptionalString(
          data.vehicleType,
          existingBilty.vehicleType
        ),
        vehicleModel: normalizeOptionalString(
          data.vehicleModel,
          existingBilty.vehicleModel
        ),
        vehicleColor: normalizeOptionalString(
          data.vehicleColor,
          existingBilty.vehicleColor
        ),
        engineNumber: normalizeOptionalString(
          data.engineNumber,
          existingBilty.engineNumber
        ),
        chassisNumber: normalizeOptionalString(
          data.chassisNumber,
          existingBilty.chassisNumber
        ),
        registrationNumber: normalizeOptionalString(
          data.registrationNumber,
          existingBilty.registrationNumber
        ),
        clearingAgentPartyId,
        clearingAgentName,
        rent,
        insurance,
        expense,
        total,
        advance,
        toPay,
        paidResponsiblePartyId,
        agentPartyId,
        agentCommission,
        agentDescription: normalizeOptionalString(
          data.agentDescription,
          existingBilty.agentDescription
        ),
        notes: normalizeOptionalString(data.notes, existingBilty.notes),
        updatedById: currentUser.userId,
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
        updatedBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
      },
      });

      // ESTABLISH / SYNC / RELEASE the PAID row, now that the Bilty's
      // own advance/paidResponsiblePartyId reflect the NEW state -
      // resolveComponentContext() reads Bilty.advance fresh, so this
      // must run AFTER the update above (a reassignment, if any, has
      // already happened, above, against the OLD state).
      const paidRowAfterUpdate = await tx.settlementPayment.findFirst({
        where: { component: "PAID", biltyId: id },
      });

      if (advance <= 0 || !paidResponsibleAccountId) {
        if (paidRowAfterUpdate) {
          await deleteSettlementPayment(paidRowAfterUpdate.id, tx);
        }
      } else if (!paidRowAfterUpdate) {
        await createSettlementPayment(
          {
            component: "PAID",
            biltyId: id,
            payerAccountId: paidResponsibleAccountId,
            amount: advance,
            createdById: currentUser.userId,
          },
          tx
        );
      } else if (Math.abs(Number(paidRowAfterUpdate.amount) - advance) > 0.009) {
        await updateSettlementPaymentAmount({ paymentId: paidRowAfterUpdate.id, newAmount: advance }, tx);
      }

      return updatedBiltyRow;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (correctionError) {
      if (correctionError instanceof MissingResponsiblePartyError) {
        return NextResponse.json(
          {
            success: false,
            message: correctionError.message,
            requiresCommissionResponsibility: correctionError.component === "COMMISSION" ? true : undefined,
          },
          { status: 400 }
        );
      }
      if (correctionError instanceof SettlementPaymentError) {
        return NextResponse.json(
          { success: false, code: correctionError.code, message: correctionError.message },
          { status: 400 }
        );
      }
      if (correctionError instanceof BiltyPaidVerificationError) {
        return NextResponse.json(
          { success: false, code: correctionError.code, message: correctionError.message },
          { status: 400 }
        );
      }
      if (correctionError instanceof Prisma.PrismaClientKnownRequestError && correctionError.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Bilty was modified concurrently. Please retry." },
          { status: 409 }
        );
      }
      throw correctionError;
    }

    return NextResponse.json({
      success: true,
      message: "Bilty updated successfully",
      bilty: updatedBilty,
    });
  } catch (error) {
    console.error("Update bilty error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
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

    const { id } = await params;
    const existingBilty = await prisma.bilty.findUnique({
      where: { id },
      select: { id: true, isDeleted: true },
    });

    if (!existingBilty) {
      return NextResponse.json(
        { success: false, message: "Bilty not found" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "bilty.permanentlyDelete")) {
        return NextResponse.json(
          { success: false, message: "Forbidden" },
          { status: 403 }
        );
      }

      if (!existingBilty.isDeleted) {
        return NextResponse.json(
          { success: false, message: "Only binned bilties can be permanently deleted" },
          { status: 400 }
        );
      }

      await prisma.bilty.delete({ where: { id } });

      return NextResponse.json({
        success: true,
        message: "Bilty permanently deleted.",
        biltyId: id,
      });
    }

    if (!hasPermission(currentUser, "bilty.bin")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    if (existingBilty.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Bilty is already in Bin" },
        { status: 400 }
      );
    }

    // ========================================================
    // ACCOUNTING-SAFETY GUARD (operational only - does not touch
    // JournalEntries, P&L, Trial Balance, Settlement, or
    // Receivable/Payable)
    //
    // Binning must not hide a Bilty whose accounting is still
    // active. Uses the same "active Challan" definition already
    // relied on elsewhere in this file (not deleted, not
    // CANCELLED) - no new status is introduced.
    // ========================================================

    const activeChallanLink = await prisma.challanBilty.findFirst({
      where: {
        biltyId: id,
        challan: { isDeleted: false, status: { not: "CANCELLED" } },
      },
      select: {
        challan: { select: { challanNo: true, isSettled: true } },
      },
    });

    if (activeChallanLink?.challan.isSettled) {
      return NextResponse.json(
        {
          success: false,
          message: `Settled Challan Bilty cannot be moved to Bin. This Bilty is part of settled Challan ${activeChallanLink.challan.challanNo}.`,
        },
        { status: 400 }
      );
    }

    if (activeChallanLink) {
      return NextResponse.json(
        {
          success: false,
          message: `This Bilty is assigned to active Challan ${activeChallanLink.challan.challanNo} and cannot be moved to Bin. Remove it from the Challan first.`,
        },
        { status: 400 }
      );
    }

    await prisma.bilty.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: currentUser.userId,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Bilty moved to Bin successfully.",
      biltyId: id,
    });
  } catch (error) {
    console.error("Delete bilty error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Unable to delete bilty",
      },
      { status: 500 }
    );
  }
}