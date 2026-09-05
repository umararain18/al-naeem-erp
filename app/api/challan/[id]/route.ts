import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { ChallanStatus, Prisma } from "@prisma/client";
import { computeChallanFinancialsBatch } from "@/lib/challan-financials";
import {
  applySettlementCorrection,
  getSettledPartyAccountIdsBatch,
  MissingResponsiblePartyError,
  type SettledPartyLookupRequest,
} from "@/lib/settlement-correction";
import { getChallanResponsibleParties } from "@/lib/document-party-resolution";
import { assertComponentTotalNotBelowActiveRows, SettlementPaymentError } from "@/lib/settlement-payments";
import { getBiltyPaidVerification } from "@/lib/bilty-paid-verification";
import { computeChallanSettlementSummary } from "@/lib/challan-settlement-summary";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

type ResponsibilityChoice = {
  responsibility: "CLEARING_AGENT" | "TRANSPORTER" | "ANC" | "THIRD_PARTY";
  thirdPartyAccountId: string | null;
};

// Read-only reverse mapping of an already-established party account
// back into the same CLEARING_AGENT/TRANSPORTER(or ANC)/THIRD_PARTY
// choice the Settlement screen itself uses - purely so an edit form
// can pre-select the current responsibility. Never used to compute
// or alter an amount.
function toResponsibilityChoice(
  partyAccountId: string | null,
  clearingAgentAccountId: string | null,
  transporterOrAncAccountId: string | null,
  transporterOrAncLabel: "TRANSPORTER" | "ANC"
): ResponsibilityChoice | null {
  if (!partyAccountId) return null;
  if (clearingAgentAccountId && partyAccountId === clearingAgentAccountId) {
    return { responsibility: "CLEARING_AGENT", thirdPartyAccountId: null };
  }
  if (transporterOrAncAccountId && partyAccountId === transporterOrAncAccountId) {
    return { responsibility: transporterOrAncLabel, thirdPartyAccountId: null };
  }
  return { responsibility: "THIRD_PARTY", thirdPartyAccountId: partyAccountId };
}

// GET /api/challan/[id]
export async function GET(
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

    if (!hasPermission(currentUser, "challan.view")) {
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
          select: {
            id: true,
            partyName: true,
            account: { select: { id: true, accountName: true } },
          },
        },
        bilties: {
          include: {
            bilty: {
              include: {
                fromLocation: { select: { id: true, name: true } },
                toLocation: { select: { id: true, name: true } },
                consignorParty: { select: { id: true, partyName: true } },
                consigneeParty: { select: { id: true, partyName: true } },
                clearingAgentParty: {
                  select: {
                    id: true,
                    partyName: true,
                    account: { select: { id: true, accountName: true } },
                  },
                },
                agentParty: {
                  select: {
                    id: true,
                    partyName: true,
                    account: { select: { id: true, accountName: true } },
                  },
                },
              },
            },
          },
          orderBy: { addedAt: "asc" },
        },
        settlementJournalEntry: {
          select: {
            id: true,
            lines: {
              select: {
                debit: true,
                credit: true,
                description: true,
                sourceNumber: true,
                account: {
                  select: {
                    id: true,
                    accountName: true,
                    category: true,
                    party: { select: { id: true, partyName: true } },
                  },
                },
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

    const financials = (
      await computeChallanFinancialsBatch([
        {
          id: challan.id,
          outstandingReceivable: challan.outstandingReceivable,
          outstandingPayable: challan.outstandingPayable,
          biltyIds: challan.bilties.map((cb) => cb.biltyId),
        },
      ])
    )[challan.id];

    // Purely informational "who" behind the receivable/payable
    // totals above - does not affect the amounts themselves.
    const responsibleParties = challan.isSettled
      ? await getChallanResponsibleParties(challan.id)
      : { receivable: [], payable: [] };

    // Per-component current responsibility (Collection/Commission
    // per Bilty, Carrier Rent for the Challan) - read-only, used
    // only to pre-fill the Super Admin "Edit Settlement" form with
    // what is already established in the ledger. Never used to
    // compute an amount.
    let settlementBreakdown: {
      carrierRent: ResponsibilityChoice | null;
      bilties: Record<string, { collection: ResponsibilityChoice | null; commission: ResponsibilityChoice | null }>;
    } | null = null;

    if (challan.isSettled && challan.settlementJournalEntryId) {
      const transporterAccountId = challan.transporterParty?.account?.id || null;

      const [bookingIncomeAccount, commissionExpenseAccount, carrierRentExpenseAccount] = await Promise.all([
        prisma.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } }),
        prisma.account.findFirst({ where: { category: "OTHER_EXPENSE", isActive: true }, select: { id: true } }),
        prisma.account.findFirst({ where: { category: "CARRIER_RENT", isActive: true }, select: { id: true } }),
      ]);

      const firstClearingAgentAccountId =
        challan.bilties.find((cb) => cb.bilty.clearingAgentParty?.account?.id)
          ?.bilty.clearingAgentParty?.account?.id || null;

      // Every component lookup for this Challan reads the exact same
      // underlying ledger lines (see lib/settlement-correction.ts) -
      // batched into a single query instead of one query per
      // Bilty/component, which previously repeated for every Bilty.
      // Resolution rules and results are byte-identical to before;
      // only the number of round trips changes.
      const requests: SettledPartyLookupRequest[] = [];

      if (Number(challan.carrierRent) > 0 && carrierRentExpenseAccount) {
        requests.push({ component: "CARRIER_RENT", incomeOrExpenseAccountId: carrierRentExpenseAccount.id, biltyId: null });
      }
      for (const cb of challan.bilties) {
        const bilty = cb.bilty;
        if (Number(bilty.total) > 0 && bookingIncomeAccount) {
          requests.push({ component: "COLLECTION", incomeOrExpenseAccountId: bookingIncomeAccount.id, biltyId: bilty.id });
        }
        if (Number(bilty.agentCommission) > 0 && commissionExpenseAccount) {
          requests.push({ component: "COMMISSION", incomeOrExpenseAccountId: commissionExpenseAccount.id, biltyId: bilty.id });
        }
      }

      const results = await getSettledPartyAccountIdsBatch(
        prisma,
        challan.id,
        challan.settlementJournalEntryId,
        requests
      );

      // Pull each request's result back out by re-walking the exact
      // same construction order used to build `requests` above.
      let cursor = 0;
      const carrierRentPartyAccountId =
        Number(challan.carrierRent) > 0 && carrierRentExpenseAccount ? results[cursor++] : null;

      const bilties: Record<string, { collection: ResponsibilityChoice | null; commission: ResponsibilityChoice | null }> = {};

      for (const cb of challan.bilties) {
        const bilty = cb.bilty;
        const clearingAgentAccountId = bilty.clearingAgentParty?.account?.id || null;

        const collectionPartyAccountId =
          Number(bilty.total) > 0 && bookingIncomeAccount ? results[cursor++] : null;

        const commissionPartyAccountId =
          Number(bilty.agentCommission) > 0 && commissionExpenseAccount ? results[cursor++] : null;

        bilties[bilty.id] = {
          collection: toResponsibilityChoice(collectionPartyAccountId, clearingAgentAccountId, transporterAccountId, "TRANSPORTER"),
          commission: toResponsibilityChoice(commissionPartyAccountId, clearingAgentAccountId, transporterAccountId, "TRANSPORTER"),
        };
      }

      settlementBreakdown = {
        carrierRent: toResponsibilityChoice(carrierRentPartyAccountId, firstClearingAgentAccountId, transporterAccountId, "ANC"),
        bilties,
      };
    }

    // Derived Unverified ANC receipt state, per Bilty and aggregated
    // for the Challan - never a stored field, never a duplicate
    // calculation (see lib/bilty-paid-verification.ts). Bilty-level
    // identity is preserved in `perBilty`; `aggregate` is a pure sum,
    // computed here rather than in the future UI so the single
    // source of truth stays server-side.
    const paidVerificationByBilty = await Promise.all(
      challan.bilties.map((cb) => getBiltyPaidVerification(prisma, cb.biltyId))
    );
    const paidVerification = {
      perBilty: Object.fromEntries(paidVerificationByBilty.map((v) => [v.biltyId, v])),
      aggregate: {
        paidAmount: round2(paidVerificationByBilty.reduce((s, v) => s + v.paidAmount, 0)),
        verifiedReceivedAmount: round2(paidVerificationByBilty.reduce((s, v) => s + v.verifiedReceivedAmount, 0)),
        unverifiedAmount: round2(paidVerificationByBilty.reduce((s, v) => s + v.unverifiedAmount, 0)),
        hasInconsistency: paidVerificationByBilty.some((v) => v.isInconsistent),
      },
    };

    // Dimensionally-separated settlement summary (Bilty Rent / Paid /
    // To-Pay / Carrier Rent, never blended) - the authoritative source
    // for the Financial Summary card, replacing the old blended
    // financials/responsibleParties pair for DISPLAY purposes. Those
    // two fields are left in the response unchanged (still written by
    // the settlement engine, still potentially depended on elsewhere)
    // - only what the UI reads for Financial Summary changes.
    const settlementSummary = await computeChallanSettlementSummary(challan.id);

    return NextResponse.json({
      success: true,
      challan,
      financials,
      responsibleParties,
      settlementBreakdown,
      paidVerification,
      settlementSummary,
    });
  } catch (error) {
    console.error("Get challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load challan" },
      { status: 500 }
    );
  }
}

// PATCH /api/challan/[id]
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

    if (!hasPermission(currentUser, "challan.edit")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;
    const body = await request.json();

    const existingChallan = await prisma.challan.findUnique({
      where: { id },
      include: {
        bilties: { select: { biltyId: true } },
      },
    });

    if (!existingChallan || existingChallan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    // NOTE: Settled Challans remain editable (Part 6). Editing an
    // accounting-relevant field (carrierRent) on a settled Challan
    // posts a balanced correction instead of silently overwriting
    // history - see the CARRIER RENT CORRECTION block below.

    // ========================================================
    // BILTY RELINKING (add / remove)
    //
    // Bilty composition may only change while the Challan is
    // still IN_TRANSIT - once DELIVERED, the operational state of
    // every linked Bilty (also DELIVERED) is locked together with
    // it, and once settled the Challan is fully locked already
    // (checked above). This keeps the Bilty <-> Challan status
    // machine consistent without introducing new states.
    // ========================================================

    const addBiltyIds: string[] = Array.isArray(body.addBiltyIds)
      ? Array.from(new Set<string>(body.addBiltyIds)).filter((v) => typeof v === "string")
      : [];
    const removeBiltyIds: string[] = Array.isArray(body.removeBiltyIds)
      ? Array.from(new Set<string>(body.removeBiltyIds)).filter((v) => typeof v === "string")
      : [];

    if (addBiltyIds.length > 0 || removeBiltyIds.length > 0) {
      if (existingChallan.status !== "IN_TRANSIT") {
        return NextResponse.json(
          {
            success: false,
            message: "Bilty composition can only be changed while the Challan is In Transit.",
          },
          { status: 400 }
        );
      }

      const currentBiltyIds = new Set(existingChallan.bilties.map((cb) => cb.biltyId));

      for (const biltyId of removeBiltyIds) {
        if (!currentBiltyIds.has(biltyId)) {
          return NextResponse.json(
            { success: false, message: "One or more Bilties to remove are not linked to this Challan" },
            { status: 400 }
          );
        }
      }

      const resultingCount =
        currentBiltyIds.size -
        removeBiltyIds.filter((bid) => currentBiltyIds.has(bid)).length +
        addBiltyIds.filter((bid) => !currentBiltyIds.has(bid)).length;

      if (resultingCount < 1) {
        return NextResponse.json(
          { success: false, message: "A Challan must have at least one Bilty" },
          { status: 400 }
        );
      }

      if (removeBiltyIds.length > 0) {
        const postedLines = await prisma.journalLine.findFirst({
          where: {
            sourceType: "BILTY",
            sourceId: { in: removeBiltyIds },
            journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
          },
          select: { sourceNumber: true },
        });

        if (postedLines) {
          return NextResponse.json(
            {
              success: false,
              message: `Cannot remove Bilty ${postedLines.sourceNumber || ""} - Daily Posting activity already exists against it.`,
            },
            { status: 400 }
          );
        }
      }

      if (addBiltyIds.length > 0) {
        const biltiesToAdd = await prisma.bilty.findMany({
          where: { id: { in: addBiltyIds } },
          include: {
            challanBilties: { include: { challan: true } },
          },
        });

        if (biltiesToAdd.length !== addBiltyIds.length) {
          return NextResponse.json(
            { success: false, message: "One or more Bilties to add were not found" },
            { status: 404 }
          );
        }

        for (const bilty of biltiesToAdd) {
          if (bilty.isDeleted) {
            return NextResponse.json(
              { success: false, message: `Bilty ${bilty.biltyNo} is deleted` },
              { status: 400 }
            );
          }
          if (bilty.status !== "PENDING") {
            return NextResponse.json(
              { success: false, message: `Bilty ${bilty.biltyNo} is not pending` },
              { status: 400 }
            );
          }
          const activeChallan = bilty.challanBilties.find(
            (cb) => cb.challan && !cb.challan.isDeleted
          );
          if (activeChallan) {
            return NextResponse.json(
              {
                success: false,
                message: `Bilty ${bilty.biltyNo} is already assigned to challan ${activeChallan.challan.challanNo}`,
              },
              { status: 409 }
            );
          }
        }
      }
    }

    const updateData: any = {};

    if (body.loadingDate) {
      const loadingDate = new Date(`${body.loadingDate}T00:00:00`);
      if (Number.isNaN(loadingDate.getTime())) {
        return NextResponse.json(
          { success: false, message: "Invalid loading date" },
          { status: 400 }
        );
      }
      updateData.loadingDate = loadingDate;
    }

    if (body.transporterPartyId !== undefined) {
      updateData.transporterPartyId = body.transporterPartyId || undefined;
    }

    if (body.driverName !== undefined) {
      updateData.driverName = body.driverName || undefined;
    }

    if (body.driverPhone !== undefined) {
      updateData.driverPhone = body.driverPhone || undefined;
    }

    if (body.carrierNumber !== undefined) {
      updateData.carrierNumber = body.carrierNumber || undefined;
    }

    // ========================================================
    // CARRIER RENT CORRECTION (accounting-safe edit)
    //
    // Carrier Rent expense was already recognized in full at
    // Challan creation (or by a prior correction). Changing the
    // amount must post a balanced correction for the delta only -
    // never overwrite history. See lib/settlement-correction.ts.
    // ========================================================

    const oldCarrierRent = Number(existingChallan.carrierRent);
    const newCarrierRent = body.carrierRent !== undefined ? Number(body.carrierRent) : oldCarrierRent;
    const carrierRentDelta = Number((newCarrierRent - oldCarrierRent).toFixed(2));

    if (body.carrierRent !== undefined) {
      updateData.carrierRent = body.carrierRent;
    }

    let carrierRentExpenseAccountId: string | undefined;

    if (carrierRentDelta !== 0) {
      const carrierRentExpenseAccount = await prisma.account.findFirst({
        where: { category: "CARRIER_RENT", isActive: true },
        select: { id: true },
      });

      if (!carrierRentExpenseAccount) {
        return NextResponse.json(
          {
            success: false,
            message: "Required account is not configured. Please configure a CARRIER_RENT account.",
          },
          { status: 400 }
        );
      }

      carrierRentExpenseAccountId = carrierRentExpenseAccount.id;
    }

    if (body.remarks !== undefined) {
      updateData.remarks = body.remarks || undefined;
    }

    // ========================================================
    // RESOLVE CARRIER RENT RESPONSIBILITY (if the client provided one)
    //
    // Only meaningful when the Challan is already settled - a
    // not-yet-settled correction always targets the gross clearing
    // account, and Settlement (whenever it later runs) will ask
    // for responsibility itself.
    // ========================================================

    let explicitCarrierRentPartyAccountId: string | undefined;

    if (carrierRentDelta !== 0 && existingChallan.isSettled && body.carrierRentResponsibility) {
      const { responsibility, thirdPartyAccountId } = body.carrierRentResponsibility;

      if (responsibility === "CLEARING_AGENT") {
        const bilties = await prisma.challanBilty.findMany({
          where: { challanId: id },
          select: {
            bilty: { select: { clearingAgentParty: { select: { account: { select: { id: true } } } } } },
          },
        });
        const clearingAgentAccountId = bilties.find(
          (cb) => cb.bilty.clearingAgentParty?.account?.id
        )?.bilty.clearingAgentParty?.account?.id;

        if (!clearingAgentAccountId) {
          return NextResponse.json(
            { success: false, message: "No Bilty on this Challan has a Clearing Agent assigned; choose a different Carrier Rent responsibility." },
            { status: 400 }
          );
        }

        explicitCarrierRentPartyAccountId = clearingAgentAccountId;
      } else if (responsibility === "ANC") {
        const transporter = await prisma.challan.findUnique({
          where: { id },
          select: { transporterParty: { select: { account: { select: { id: true } } } } },
        });

        if (!transporter?.transporterParty?.account?.id) {
          return NextResponse.json(
            { success: false, message: "Challan has no Transporter assigned; choose a different Carrier Rent responsibility." },
            { status: 400 }
          );
        }

        explicitCarrierRentPartyAccountId = transporter.transporterParty.account.id;
      } else {
        if (!thirdPartyAccountId) {
          return NextResponse.json(
            { success: false, message: "A party/account must be selected for the Carrier Rent responsibility." },
            { status: 400 }
          );
        }

        const account = await prisma.account.findUnique({
          where: { id: thirdPartyAccountId },
          select: { category: true, isActive: true },
        });

        if (!account || account.category !== "PARTY" || !account.isActive) {
          return NextResponse.json(
            { success: false, message: "Selected Carrier Rent responsibility account must be an active Party account." },
            { status: 400 }
          );
        }

        explicitCarrierRentPartyAccountId = thirdPartyAccountId;
      }
    }

    let updatedChallan;
    try {
    updatedChallan = await prisma.$transaction(async (tx) => {
      // GUARD (lib/settlement-payments.ts): a Carrier Rent decrease
      // must never leave the new multi-payer engine's active Carrier
      // Rent rows over-committed. Trivially passes for any Challan
      // the new engine has never touched (zero rows). Runs inside
      // this SAME `tx`, which is why this whole transaction is now
      // SERIALIZABLE - required for this check to be race-safe
      // against a concurrent settlement-payment row creation.
      await assertComponentTotalNotBelowActiveRows(tx, "CARRIER_RENT", { challanId: id }, newCarrierRent);

      if (carrierRentDelta !== 0) {
        await applySettlementCorrection({
          tx,
          component: "CARRIER_RENT",
          delta: carrierRentDelta,
          challanId: id,
          challanNo: existingChallan.challanNo,
          biltyId: "",
          biltyNo: "",
          incomeOrExpenseAccountId: carrierRentExpenseAccountId!,
          isSettled: existingChallan.isSettled,
          settlementJournalEntryId: existingChallan.settlementJournalEntryId,
          createdById: currentUser.userId,
          description: `Correction - ${existingChallan.challanNo} - Carrier Rent ${oldCarrierRent} -> ${newCarrierRent}`,
          explicitPartyAccountId: explicitCarrierRentPartyAccountId,
        });
      }

      if (removeBiltyIds.length > 0) {
        await tx.challanBilty.deleteMany({
          where: { challanId: id, biltyId: { in: removeBiltyIds } },
        });

        for (const biltyId of removeBiltyIds) {
          const otherActiveChallan = await tx.challanBilty.findFirst({
            where: {
              biltyId,
              challan: { isDeleted: false, status: { not: "CANCELLED" } },
            },
          });

          if (!otherActiveChallan) {
            await tx.bilty.update({
              where: { id: biltyId },
              data: { status: "PENDING" },
            });
          }
        }
      }

      if (addBiltyIds.length > 0) {
        for (const biltyId of addBiltyIds) {
          await tx.challanBilty.create({ data: { challanId: id, biltyId } });
        }

        await tx.bilty.updateMany({
          where: { id: { in: addBiltyIds } },
          data: { status: "IN_TRANSIT" },
        });
      }

      return tx.challan.update({
        where: { id },
        data: {
          ...updateData,
          updatedById: currentUser.userId,
        },
        include: {
          transporterParty: {
            select: {
              id: true,
              partyName: true,
            },
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (correctionError) {
      if (correctionError instanceof MissingResponsiblePartyError) {
        return NextResponse.json(
          {
            success: false,
            message: correctionError.message,
            requiresCarrierRentResponsibility: correctionError.component === "CARRIER_RENT" ? true : undefined,
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
      if (correctionError instanceof Prisma.PrismaClientKnownRequestError && correctionError.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Challan was modified concurrently. Please retry." },
          { status: 409 }
        );
      }
      throw correctionError;
    }

    return NextResponse.json({
      success: true,
      message: "Challan updated successfully",
      challan: updatedChallan,
    });
  } catch (error) {
    console.error("Update challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update challan" },
      { status: 500 }
    );
  }
}

// DELETE /api/challan/[id]
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
    const existingChallan = await prisma.challan.findUnique({
      where: { id },
      select: { id: true, isDeleted: true, isSettled: true },
    });

    if (!existingChallan) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "challan.permanentlyDelete")) {
        return NextResponse.json(
          { success: false, message: "Forbidden" },
          { status: 403 }
        );
      }

      if (!existingChallan.isDeleted) {
        return NextResponse.json(
          { success: false, message: "Only binned challans can be permanently deleted" },
          { status: 400 }
        );
      }

      await prisma.challan.delete({ where: { id } });

      return NextResponse.json({
        success: true,
        message: "Challan permanently deleted.",
        challanId: id,
      });
    }

    if (!hasPermission(currentUser, "challan.bin")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    if (existingChallan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan is already in Bin" },
        { status: 400 }
      );
    }

    if (existingChallan.isSettled) {
      return NextResponse.json(
        { success: false, message: "Settled challans cannot be deleted" },
        { status: 400 }
      );
    }

    await prisma.challan.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: currentUser.userId,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Challan moved to Bin successfully.",
      challanId: id,
    });
  } catch (error) {
    console.error("Delete challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete challan" },
      { status: 500 }
    );
  }
}
