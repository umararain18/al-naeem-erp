import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  buildSettlementEntries,
  type BiltySettlementInput,
  type CarrierRentResponsibility,
  type CollectionResponsibility,
  type CommissionResponsibility,
} from "@/lib/settlement-accounting";
import {
  getGrossBiltyReceivableAccountId,
  getGrossCarrierRentPayableAccountId,
  getGrossCommissionPayableAccountId,
} from "@/lib/gross-accounts";
import { applySettlementReassignment } from "@/lib/settlement-correction";

const responsibilitySelectionSchema = z.object({
  responsibility: z.enum(["CLEARING_AGENT", "TRANSPORTER", "THIRD_PARTY"]),
  thirdPartyAccountId: z.string().optional(),
});

const carrierRentSelectionSchema = z.object({
  responsibility: z.enum(["CLEARING_AGENT", "ANC", "THIRD_PARTY"]),
  thirdPartyAccountId: z.string().optional(),
});

const settleSchema = z.object({
  settlementNotes: z.string().optional(),
  carrierRent: carrierRentSelectionSchema,
  bilties: z
    .array(
      z.object({
        biltyId: z.string().min(1),
        collection: responsibilitySelectionSchema,
        commission: responsibilitySelectionSchema.optional(),
      })
    )
    .min(1, "At least one bilty is required"),
});

export async function POST(
  _request: NextRequest,
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

    if (!hasPermission(currentUser, "challan.edit")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;

    const challan = await prisma.challan.findUnique({
      where: { id },
      include: {
        transporterParty: {
          select: { id: true, account: { select: { id: true } } },
        },
        bilties: {
          include: {
            bilty: {
              include: {
                clearingAgentParty: { select: { id: true, account: { select: { id: true } } } },
                agentParty: { select: { id: true, account: { select: { id: true } } } },
              },
            },
          },
        },
      },
    });

    if (!challan || challan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    if (challan.status !== "DELIVERED") {
      return NextResponse.json(
        { success: false, message: "Only delivered challans can be settled" },
        { status: 400 }
      );
    }

    if (challan.isSettled) {
      return NextResponse.json(
        { success: false, message: "Challan is already settled" },
        { status: 400 }
      );
    }

    const existingJournalEntry = await prisma.journalEntry.findFirst({
      where: {
        referenceType: "SETTLEMENT",
        referenceId: challan.id,
        isDeleted: false,
      },
    });

    if (existingJournalEntry) {
      return NextResponse.json(
        { success: false, message: "This Challan has already been settled." },
        { status: 409 }
      );
    }

    const body = await _request.json();
    const result = settleSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid settlement data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    // The submitted bilty selections must cover exactly the challan's
    // own bilties - no more, no less.
    const challanBiltyIds = new Set(challan.bilties.map((cb) => cb.biltyId));
    const submittedBiltyIds = new Set(data.bilties.map((b) => b.biltyId));

    if (
      challanBiltyIds.size !== submittedBiltyIds.size ||
      [...challanBiltyIds].some((bid) => !submittedBiltyIds.has(bid))
    ) {
      return NextResponse.json(
        {
          success: false,
          message: "Settlement selections must cover exactly this Challan's bilties.",
        },
        { status: 400 }
      );
    }

    // Gross/suspense clearing accounts (see lib/gross-accounts.ts).
    // Booking Income, Carrier Rent expense, and Commission expense
    // were already recognized once - at Bilty creation and Challan
    // dispatch respectively. Settlement only reclassifies these
    // gross balances into the real responsible party; it never
    // touches an Income/Expense account.
    const [grossBiltyReceivableId, grossCarrierRentPayableId, grossCommissionPayableId] =
      await Promise.all([
        getGrossBiltyReceivableAccountId(prisma),
        getGrossCarrierRentPayableAccountId(prisma),
        getGrossCommissionPayableAccountId(prisma),
      ]);

    // ========================================================
    // RESOLVE THIRD-PARTY ACCOUNTS
    //
    // Every "Third Party / Other" selection must resolve to a
    // real, active PARTY account - never an income/expense/system
    // account. Batch-fetch and validate all referenced third-party
    // account ids up front.
    // ========================================================

    const thirdPartyAccountIds = new Set<string>();
    if (data.carrierRent.responsibility === "THIRD_PARTY" && data.carrierRent.thirdPartyAccountId) {
      thirdPartyAccountIds.add(data.carrierRent.thirdPartyAccountId);
    }
    for (const b of data.bilties) {
      if (b.collection.responsibility === "THIRD_PARTY" && b.collection.thirdPartyAccountId) {
        thirdPartyAccountIds.add(b.collection.thirdPartyAccountId);
      }
      if (
        b.commission &&
        b.commission.responsibility === "THIRD_PARTY" &&
        b.commission.thirdPartyAccountId
      ) {
        thirdPartyAccountIds.add(b.commission.thirdPartyAccountId);
      }
    }

    const thirdPartyAccounts = thirdPartyAccountIds.size > 0
      ? await prisma.account.findMany({
          where: { id: { in: [...thirdPartyAccountIds] } },
          select: { id: true, category: true, isActive: true },
        })
      : [];

    const thirdPartyAccountById = new Map(thirdPartyAccounts.map((a) => [a.id, a]));

    function resolveThirdParty(accountId: string | undefined, field: string): string | { error: string } {
      if (!accountId) {
        return { error: `A party/account must be selected for ${field}.` };
      }
      const account = thirdPartyAccountById.get(accountId);
      if (!account) {
        return { error: `Selected account for ${field} was not found.` };
      }
      if (account.category !== "PARTY") {
        return { error: `Selected account for ${field} must be a Party account.` };
      }
      if (!account.isActive) {
        return { error: `Selected account for ${field} is inactive.` };
      }
      return accountId;
    }

    const challanBilties = challan.bilties;
    const biltyById = new Map(challanBilties.map((cb) => [cb.biltyId, cb.bilty]));
    const transporterAccountId = challan.transporterParty?.account?.id || null;

    const resolutionErrors: string[] = [];

    function resolveCollectionParty(
      biltyNo: string,
      responsibility: CollectionResponsibility,
      thirdPartyAccountId: string | undefined,
      clearingAgentAccountId: string | null
    ): string | null {
      if (responsibility === "CLEARING_AGENT") {
        if (!clearingAgentAccountId) {
          resolutionErrors.push(`Bilty ${biltyNo} has no Clearing Agent assigned; choose a different collection responsibility.`);
          return null;
        }
        return clearingAgentAccountId;
      }
      if (responsibility === "TRANSPORTER") {
        if (!transporterAccountId) {
          resolutionErrors.push(`Challan has no Transporter assigned; choose a different collection responsibility for Bilty ${biltyNo}.`);
          return null;
        }
        return transporterAccountId;
      }
      const resolved = resolveThirdParty(thirdPartyAccountId, `Bilty ${biltyNo}'s collection`);
      if (typeof resolved !== "string") {
        resolutionErrors.push(resolved.error);
        return null;
      }
      return resolved;
    }

    function resolveCommissionParty(
      biltyNo: string,
      responsibility: CommissionResponsibility,
      thirdPartyAccountId: string | undefined,
      clearingAgentAccountId: string | null
    ): string | null {
      if (responsibility === "CLEARING_AGENT") {
        if (!clearingAgentAccountId) {
          resolutionErrors.push(`Bilty ${biltyNo} has no Clearing Agent assigned; choose a different commission responsibility.`);
          return null;
        }
        return clearingAgentAccountId;
      }
      if (responsibility === "TRANSPORTER") {
        if (!transporterAccountId) {
          resolutionErrors.push(`Challan has no Transporter assigned; choose a different commission responsibility for Bilty ${biltyNo}.`);
          return null;
        }
        return transporterAccountId;
      }
      const resolved = resolveThirdParty(thirdPartyAccountId, `Bilty ${biltyNo}'s commission`);
      if (typeof resolved !== "string") {
        resolutionErrors.push(resolved.error);
        return null;
      }
      return resolved;
    }

    function resolveCarrierRentParty(
      responsibility: CarrierRentResponsibility,
      thirdPartyAccountId: string | undefined
    ): string | null {
      if (responsibility === "CLEARING_AGENT") {
        const clearingAgentAccountId =
          challanBilties.find((cb) => cb.bilty.clearingAgentParty?.account?.id)
            ?.bilty.clearingAgentParty?.account?.id || null;
        if (!clearingAgentAccountId) {
          resolutionErrors.push("No Bilty on this Challan has a Clearing Agent assigned; choose a different Carrier Rent responsibility.");
          return null;
        }
        return clearingAgentAccountId;
      }
      if (responsibility === "ANC") {
        if (!transporterAccountId) {
          resolutionErrors.push("Challan has no Transporter assigned; choose a different Carrier Rent responsibility.");
          return null;
        }
        return transporterAccountId;
      }
      const resolved = resolveThirdParty(thirdPartyAccountId, "Carrier Rent");
      if (typeof resolved !== "string") {
        resolutionErrors.push(resolved.error);
        return null;
      }
      return resolved;
    }

    const carrierRentAmount = Number(challan.carrierRent);
    const carrierRentPartyAccountId =
      carrierRentAmount > 0
        ? resolveCarrierRentParty(data.carrierRent.responsibility, data.carrierRent.thirdPartyAccountId)
        : null;

    const biltiesInput: BiltySettlementInput[] = data.bilties.map((b) => {
      const bilty = biltyById.get(b.biltyId)!;
      const clearingAgentAccountId = bilty.clearingAgentParty?.account?.id || null;
      const amount = Number(bilty.total);
      const commissionAmount = Number(bilty.agentCommission);

      const collectionPartyAccountId =
        amount > 0
          ? resolveCollectionParty(
              bilty.biltyNo,
              b.collection.responsibility,
              b.collection.thirdPartyAccountId,
              clearingAgentAccountId
            )
          : null;

      let commissionPartyAccountId: string | null = null;
      if (commissionAmount > 0) {
        if (!b.commission) {
          resolutionErrors.push(`A commission responsibility is required for Bilty ${bilty.biltyNo}.`);
        } else {
          commissionPartyAccountId = resolveCommissionParty(
            bilty.biltyNo,
            b.commission.responsibility,
            b.commission.thirdPartyAccountId,
            clearingAgentAccountId
          );
        }
      }

      return {
        biltyId: bilty.id,
        biltyNo: bilty.biltyNo,
        amount: bilty.total,
        collectionResponsibility: b.collection.responsibility,
        collectionPartyAccountId,
        agentCommission: bilty.agentCommission,
        commissionResponsibility: b.commission?.responsibility ?? null,
        commissionPartyAccountId,
      };
    });

    if (resolutionErrors.length > 0) {
      return NextResponse.json(
        { success: false, message: resolutionErrors.join(" ") },
        { status: 400 }
      );
    }

    // ========================================================
    // VERIFIED ADVANCES
    //
    // For every distinct party account touched by this settlement,
    // reuse the exact same Daily-Posting-only verified-advance
    // lookup the previous CASE A/B model used - never trust
    // Bilty.advance as actual cash movement.
    // ========================================================

    const involvedAccountIds = new Set<string>();
    if (carrierRentPartyAccountId) involvedAccountIds.add(carrierRentPartyAccountId);
    for (const b of biltiesInput) {
      if (b.collectionPartyAccountId) involvedAccountIds.add(b.collectionPartyAccountId);
      if (b.commissionPartyAccountId) involvedAccountIds.add(b.commissionPartyAccountId);
    }

    const verifiedAdvanceByAccountId: Record<string, number> = {};
    for (const accountId of involvedAccountIds) {
      verifiedAdvanceByAccountId[accountId] = await getVerifiedAdvance(accountId);
    }

    const settlementInput = {
      challanId: challan.id,
      challanNo: challan.challanNo,
      carrierRent: challan.carrierRent,
      carrierRentResponsibility: data.carrierRent.responsibility,
      carrierRentPartyAccountId,
      bilties: biltiesInput,
      accounts: {
        grossBiltyReceivableId,
        grossCarrierRentPayableId,
        grossCommissionPayableId,
      },
      verifiedAdvanceByAccountId,
    };

    const settlementResult = buildSettlementEntries(settlementInput);

    if (!settlementResult.isValid) {
      return NextResponse.json(
        {
          success: false,
          message: settlementResult.errors.map((e) => e.message).join(", "),
        },
        { status: 400 }
      );
    }

    const updatedChallan = await prisma.$transaction(async (tx) => {
      const journalEntries = await Promise.all(
        settlementResult.entries.map((entrySpec) =>
          tx.journalEntry.create({
            data: {
              entryDate: entrySpec.entryDate,
              referenceType: entrySpec.referenceType,
              referenceId: entrySpec.referenceId,
              description: entrySpec.description,
              createdById: currentUser.userId,
              lines: {
                create: entrySpec.lines.map((line) => ({
                  accountId: line.accountId,
                  debit: line.debit,
                  credit: line.credit,
                  description: line.description,
                  sourceType: line.sourceType,
                  sourceId: line.sourceId,
                  sourceNumber: line.sourceNumber,
                })),
              },
            },
            include: {
              lines: true,
            },
          })
        )
      );

      const primaryJournalEntryId = journalEntries[0]?.id || null;

      return tx.challan.update({
        where: { id },
        data: {
          isSettled: true,
          settledAt: new Date(),
          settledById: currentUser.userId,
          settlementNotes: data.settlementNotes || undefined,
          settlementJournalEntryId: primaryJournalEntryId,
          // Settlement = accrual/dues. Financial clearance is NOT implied.
          // isFinanciallyCleared is intentionally left unchanged.
          outstandingReceivable: settlementResult.outstandingReceivable,
          outstandingPayable: settlementResult.outstandingPayable,
          updatedById: currentUser.userId,
        },
        include: {
          transporterParty: {
            select: { id: true, partyName: true },
          },
          bilties: {
            include: {
              bilty: {
                include: {
                  fromLocation: { select: { id: true, name: true } },
                  toLocation: { select: { id: true, name: true } },
                  consignorParty: { select: { id: true, partyName: true } },
                  consigneeParty: { select: { id: true, partyName: true } },
                  clearingAgentParty: { select: { id: true, partyName: true } },
                  agentParty: { select: { id: true, partyName: true } },
                },
              },
            },
            orderBy: { addedAt: "asc" },
          },
        },
      });
    });

    return NextResponse.json({
      success: true,
      message: "Challan settled successfully",
      challan: updatedChallan,
      accounting: {
        entriesCreated: settlementResult.entries.length,
        totalDebit: settlementResult.totals.totalDebit,
        totalCredit: settlementResult.totals.totalCredit,
        outstandingReceivable: settlementResult.outstandingReceivable,
        outstandingPayable: settlementResult.outstandingPayable,
      },
    });
  } catch (error) {
    console.error("Settle challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to settle challan" },
      { status: 500 }
    );
  }
}

// ============================================================
// PATCH /api/challan/[id]/settle - EDIT an existing Final
// Settlement's responsibility assignments (SUPER_ADMIN only).
//
// This does NOT re-run buildSettlementEntries() or create a second
// settlement entry - that would double-recognize the reclassification
// and could double-count against Income/Expense if amounts had
// changed. Instead, for each component whose requested responsible
// party differs from the one already established in the ledger, it
// posts a single balanced party-to-party reassignment via
// lib/settlement-correction.ts's applySettlementReassignment() -
// the same reclassify-only architecture the rest of Settlement
// correction already relies on. Amounts themselves are never
// touched here (they are edited, with their own delta-correction
// flow, via the Bilty/Challan PATCH endpoints).
// ============================================================
export async function PATCH(
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

    // Security requirement: editing a finalized settlement is
    // restricted to SUPER_ADMIN, enforced here at the API level -
    // never trust a hidden/disabled frontend button alone.
    if (currentUser.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { success: false, message: "Only a Super Admin can edit a finalized settlement." },
        { status: 403 }
      );
    }

    const { id } = await params;

    const challan = await prisma.challan.findUnique({
      where: { id },
      include: {
        transporterParty: {
          select: { id: true, account: { select: { id: true } } },
        },
        bilties: {
          include: {
            bilty: {
              include: {
                clearingAgentParty: { select: { id: true, account: { select: { id: true } } } },
                agentParty: { select: { id: true, account: { select: { id: true } } } },
              },
            },
          },
        },
      },
    });

    if (!challan || challan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    if (!challan.isSettled || !challan.settlementJournalEntryId) {
      return NextResponse.json(
        { success: false, message: "This Challan has not been settled yet - use Final Settlement instead." },
        { status: 400 }
      );
    }

    const body = await request.json();
    const result = settleSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid settlement data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    const challanBiltyIds = new Set(challan.bilties.map((cb) => cb.biltyId));
    const submittedBiltyIds = new Set(data.bilties.map((b) => b.biltyId));

    if (
      challanBiltyIds.size !== submittedBiltyIds.size ||
      [...challanBiltyIds].some((bid) => !submittedBiltyIds.has(bid))
    ) {
      return NextResponse.json(
        {
          success: false,
          message: "Settlement selections must cover exactly this Challan's bilties.",
        },
        { status: 400 }
      );
    }

    // ========================================================
    // RESOLVE THIRD-PARTY ACCOUNTS (identical validation to POST)
    // ========================================================

    const thirdPartyAccountIds = new Set<string>();
    if (data.carrierRent.responsibility === "THIRD_PARTY" && data.carrierRent.thirdPartyAccountId) {
      thirdPartyAccountIds.add(data.carrierRent.thirdPartyAccountId);
    }
    for (const b of data.bilties) {
      if (b.collection.responsibility === "THIRD_PARTY" && b.collection.thirdPartyAccountId) {
        thirdPartyAccountIds.add(b.collection.thirdPartyAccountId);
      }
      if (
        b.commission &&
        b.commission.responsibility === "THIRD_PARTY" &&
        b.commission.thirdPartyAccountId
      ) {
        thirdPartyAccountIds.add(b.commission.thirdPartyAccountId);
      }
    }

    const thirdPartyAccounts = thirdPartyAccountIds.size > 0
      ? await prisma.account.findMany({
          where: { id: { in: [...thirdPartyAccountIds] } },
          select: { id: true, category: true, isActive: true },
        })
      : [];

    const thirdPartyAccountById = new Map(thirdPartyAccounts.map((a) => [a.id, a]));

    function resolveThirdParty(accountId: string | undefined, field: string): string | { error: string } {
      if (!accountId) {
        return { error: `A party/account must be selected for ${field}.` };
      }
      const account = thirdPartyAccountById.get(accountId);
      if (!account) {
        return { error: `Selected account for ${field} was not found.` };
      }
      if (account.category !== "PARTY") {
        return { error: `Selected account for ${field} must be a Party account.` };
      }
      if (!account.isActive) {
        return { error: `Selected account for ${field} is inactive.` };
      }
      return accountId;
    }

    const challanBilties = challan.bilties;
    const biltyById = new Map(challanBilties.map((cb) => [cb.biltyId, cb.bilty]));
    const transporterAccountId = challan.transporterParty?.account?.id || null;

    const resolutionErrors: string[] = [];

    function resolveCollectionParty(
      biltyNo: string,
      responsibility: CollectionResponsibility,
      thirdPartyAccountId: string | undefined,
      clearingAgentAccountId: string | null
    ): string | null {
      if (responsibility === "CLEARING_AGENT") {
        if (!clearingAgentAccountId) {
          resolutionErrors.push(`Bilty ${biltyNo} has no Clearing Agent assigned; choose a different collection responsibility.`);
          return null;
        }
        return clearingAgentAccountId;
      }
      if (responsibility === "TRANSPORTER") {
        if (!transporterAccountId) {
          resolutionErrors.push(`Challan has no Transporter assigned; choose a different collection responsibility for Bilty ${biltyNo}.`);
          return null;
        }
        return transporterAccountId;
      }
      const resolved = resolveThirdParty(thirdPartyAccountId, `Bilty ${biltyNo}'s collection`);
      if (typeof resolved !== "string") {
        resolutionErrors.push(resolved.error);
        return null;
      }
      return resolved;
    }

    function resolveCommissionParty(
      biltyNo: string,
      responsibility: CommissionResponsibility,
      thirdPartyAccountId: string | undefined,
      clearingAgentAccountId: string | null
    ): string | null {
      if (responsibility === "CLEARING_AGENT") {
        if (!clearingAgentAccountId) {
          resolutionErrors.push(`Bilty ${biltyNo} has no Clearing Agent assigned; choose a different commission responsibility.`);
          return null;
        }
        return clearingAgentAccountId;
      }
      if (responsibility === "TRANSPORTER") {
        if (!transporterAccountId) {
          resolutionErrors.push(`Challan has no Transporter assigned; choose a different commission responsibility for Bilty ${biltyNo}.`);
          return null;
        }
        return transporterAccountId;
      }
      const resolved = resolveThirdParty(thirdPartyAccountId, `Bilty ${biltyNo}'s commission`);
      if (typeof resolved !== "string") {
        resolutionErrors.push(resolved.error);
        return null;
      }
      return resolved;
    }

    function resolveCarrierRentParty(
      responsibility: CarrierRentResponsibility,
      thirdPartyAccountId: string | undefined
    ): string | null {
      if (responsibility === "CLEARING_AGENT") {
        const clearingAgentAccountId =
          challanBilties.find((cb) => cb.bilty.clearingAgentParty?.account?.id)
            ?.bilty.clearingAgentParty?.account?.id || null;
        if (!clearingAgentAccountId) {
          resolutionErrors.push("No Bilty on this Challan has a Clearing Agent assigned; choose a different Carrier Rent responsibility.");
          return null;
        }
        return clearingAgentAccountId;
      }
      if (responsibility === "ANC") {
        if (!transporterAccountId) {
          resolutionErrors.push("Challan has no Transporter assigned; choose a different Carrier Rent responsibility.");
          return null;
        }
        return transporterAccountId;
      }
      const resolved = resolveThirdParty(thirdPartyAccountId, "Carrier Rent");
      if (typeof resolved !== "string") {
        resolutionErrors.push(resolved.error);
        return null;
      }
      return resolved;
    }

    const carrierRentAmount = Number(challan.carrierRent);
    const carrierRentPartyAccountId =
      carrierRentAmount > 0
        ? resolveCarrierRentParty(data.carrierRent.responsibility, data.carrierRent.thirdPartyAccountId)
        : null;

    const biltyResolutions = data.bilties.map((b) => {
      const bilty = biltyById.get(b.biltyId)!;
      const clearingAgentAccountId = bilty.clearingAgentParty?.account?.id || null;
      const amount = Number(bilty.total);
      const commissionAmount = Number(bilty.agentCommission);

      const collectionPartyAccountId =
        amount > 0
          ? resolveCollectionParty(
              bilty.biltyNo,
              b.collection.responsibility,
              b.collection.thirdPartyAccountId,
              clearingAgentAccountId
            )
          : null;

      let commissionPartyAccountId: string | null = null;
      if (commissionAmount > 0 && b.commission) {
        commissionPartyAccountId = resolveCommissionParty(
          bilty.biltyNo,
          b.commission.responsibility,
          b.commission.thirdPartyAccountId,
          clearingAgentAccountId
        );
      }

      return {
        biltyId: bilty.id,
        biltyNo: bilty.biltyNo,
        collectionPartyAccountId,
        commissionPartyAccountId,
      };
    });

    if (resolutionErrors.length > 0) {
      return NextResponse.json(
        { success: false, message: resolutionErrors.join(" ") },
        { status: 400 }
      );
    }

    // ========================================================
    // APPLY REASSIGNMENTS (only for components whose requested
    // party actually differs from the one already established)
    // ========================================================

    const needsBookingIncome = biltyResolutions.some((b) => b.collectionPartyAccountId);
    const needsCommissionExpense = biltyResolutions.some((b) => b.commissionPartyAccountId);
    const needsCarrierRentExpense = !!carrierRentPartyAccountId;

    const [bookingIncomeAccount, commissionExpenseAccount, carrierRentExpenseAccount] = await Promise.all([
      needsBookingIncome
        ? prisma.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } })
        : null,
      needsCommissionExpense
        ? prisma.account.findFirst({ where: { category: "OTHER_EXPENSE", isActive: true }, select: { id: true } })
        : null,
      needsCarrierRentExpense
        ? prisma.account.findFirst({ where: { category: "CARRIER_RENT", isActive: true }, select: { id: true } })
        : null,
    ]);

    const reassignments: { component: string; bilty: string | null; amount: number }[] = [];

    await prisma.$transaction(async (tx) => {
      if (carrierRentPartyAccountId && carrierRentExpenseAccount) {
        const outcome = await applySettlementReassignment({
          tx,
          component: "CARRIER_RENT",
          challanId: challan.id,
          challanNo: challan.challanNo,
          biltyId: null,
          biltyNo: null,
          incomeOrExpenseAccountId: carrierRentExpenseAccount.id,
          settlementJournalEntryId: challan.settlementJournalEntryId!,
          newPartyAccountId: carrierRentPartyAccountId,
          createdById: currentUser.userId,
          description: `Settlement Edit - ${challan.challanNo} - Carrier Rent responsibility reassigned`,
        });
        if (outcome.reassigned) {
          reassignments.push({ component: "CARRIER_RENT", bilty: null, amount: outcome.amount });
        }
      }

      for (const b of biltyResolutions) {
        if (b.collectionPartyAccountId && bookingIncomeAccount) {
          const outcome = await applySettlementReassignment({
            tx,
            component: "COLLECTION",
            challanId: challan.id,
            challanNo: challan.challanNo,
            biltyId: b.biltyId,
            biltyNo: b.biltyNo,
            incomeOrExpenseAccountId: bookingIncomeAccount.id,
            settlementJournalEntryId: challan.settlementJournalEntryId!,
            newPartyAccountId: b.collectionPartyAccountId,
            createdById: currentUser.userId,
            description: `Settlement Edit - ${challan.challanNo} - Bilty ${b.biltyNo} - Collection responsibility reassigned`,
          });
          if (outcome.reassigned) {
            reassignments.push({ component: "COLLECTION", bilty: b.biltyNo, amount: outcome.amount });
          }
        }

        if (b.commissionPartyAccountId && commissionExpenseAccount) {
          const outcome = await applySettlementReassignment({
            tx,
            component: "COMMISSION",
            challanId: challan.id,
            challanNo: challan.challanNo,
            biltyId: b.biltyId,
            biltyNo: b.biltyNo,
            incomeOrExpenseAccountId: commissionExpenseAccount.id,
            settlementJournalEntryId: challan.settlementJournalEntryId!,
            newPartyAccountId: b.commissionPartyAccountId,
            createdById: currentUser.userId,
            description: `Settlement Edit - ${challan.challanNo} - Bilty ${b.biltyNo} - Commission responsibility reassigned`,
          });
          if (outcome.reassigned) {
            reassignments.push({ component: "COMMISSION", bilty: b.biltyNo, amount: outcome.amount });
          }
        }
      }

      if (data.settlementNotes !== undefined) {
        await tx.challan.update({
          where: { id: challan.id },
          data: { settlementNotes: data.settlementNotes || undefined, updatedById: currentUser.userId },
        });
      }
    });

    return NextResponse.json({
      success: true,
      message:
        reassignments.length > 0
          ? "Settlement updated successfully."
          : "No responsibility changes were made - the submitted assignments already matched the existing settlement.",
      reassignments,
    });
  } catch (error) {
    console.error("Edit settlement error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to edit settlement" },
      { status: 500 }
    );
  }
}

async function getVerifiedAdvance(accountId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId,
      journalEntry: {
        referenceType: "DAILY_POSTING",
        isDeleted: false,
      },
    },
    select: {
      debit: true,
      credit: true,
    },
  });

  const net = lines.reduce(
    (sum, l) => sum + Number(l.debit) - Number(l.credit),
    0
  );

  return net > 0 ? net : 0;
}
