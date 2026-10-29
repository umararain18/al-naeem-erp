import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { Prisma } from "@prisma/client";
import { computeChallanFinancialsBatch } from "@/lib/challan-financials";
import { computeChallanPosition, resolvePaidUnverifiedEntries } from "@/lib/challan-position";
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
import { recognizeBiltyBookingIncome, reverseBiltyBookingIncome, BiltyRevenueRecognitionError } from "@/lib/bilty-revenue-recognition";
import { auditUpdate, auditDelete, auditRestore, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";
import { assertSuperAdmin, biltyHasPhonchOrBillReference, ChallanLifecycleError } from "@/lib/challan-lifecycle";
import { isCarrierTripChallanIncomeRecognized } from "@/lib/carrier-trip";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Thrown only from inside the PATCH transaction's own in-tx duplicate
// re-check (see "CHALLAN NO." below) - caught in that same handler's
// outer catch to return a clean 409 instead of an unhandled 500.
class ChallanNoConflictError extends Error {
  constructor() {
    super("Ye Challan No. pehle se maujood hai.");
    this.name = "ChallanNoConflictError";
  }
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

    // A raw null byte in the id (e.g. from a hand-crafted/malformed
    // request) is rejected by PostgreSQL's text encoding before Prisma
    // even gets to compare it against a real row, throwing an
    // exception the generic catch below turns into an unexplained 500.
    // A real Challan id can never contain one, so this is exactly
    // equivalent to "not found" - never a redesign of ID validation.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

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
        ownCarrier: {
          select: {
            id: true,
            carrierNumber: true,
          },
        },
        bilties: {
          include: {
            bilty: {
              include: {
                fromLocation: { select: { id: true, name: true } },
                toLocation: { select: { id: true, name: true } },
                consignorParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
                consigneeParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
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

    if (!challan) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    // A Bin'd Challan is still returned (never 404) so the detail
    // page can show a clear "this Challan is in the Bin" message with
    // a Restore link, instead of an indistinguishable "not found" -
    // every write/edit path on this Challan remains blocked by its
    // own existing isDeleted checks regardless. None of the financial/
    // settlement computation below is meaningful for a binned
    // Challan, so it is skipped entirely here.
    if (challan.isDeleted) {
      return NextResponse.json({
        success: true,
        challan,
        incomePending: null,
        financials: null,
        responsibleParties: null,
        settlementBreakdown: null,
        paidVerification: null,
        settlementSummary: null,
        position: null,
        capabilities: { canRestore: currentUser.role === "SUPER_ADMIN", canBin: false },
      });
    }

    // "Income pending (Trip slip not closed)" - see Challan.
    // ownCarrierId's own schema doc comment. Always false for a
    // regular (non-own-carrier) Challan.
    const incomePending = challan.ownCarrierId ? !(await isCarrierTripChallanIncomeRecognized(prisma, challan.id)) : false;

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
    // totals above - does not affect the amounts themselves. Kept
    // for whatever else still reads this field; no longer used for
    // `position` below (see lib/challan-position.ts's own doc
    // comment on why - this function is blind to an Unsettle
    // reversal, which a Challan's own partyNet already accounts for).
    const responsibleParties = challan.isSettled
      ? await getChallanResponsibleParties(challan.id)
      : { receivable: [], payable: [] };

    // Dimensionally-separated settlement summary (Bilty Rent / Paid /
    // To-Pay / Carrier Rent, never blended) - moved ahead of
    // `position` below so its own partyNet and live "Collected by"/
    // "Paid by" payers can feed the position's party resolution
    // (tiers 1 and 2 - see lib/challan-position.ts's own doc comment)
    // instead of a third, independent calculation.
    const settlementSummary = await computeChallanSettlementSummary(challan.id);

    // ONE financial position for this Challan (lib/challan-
    // position.ts) - the exact same shared calculation the Challan
    // list's table, filter, and summary cards read, built from
    // `financials` (amounts) and settlementSummary's own partyNet/
    // live payers (party names, tiers 1-2) plus document role fields
    // (tier 3) - never a fourth, independent calculation.
    const position = await computeChallanPosition({
      id: challan.id,
      isSettled: challan.isSettled,
      outstandingReceivable: challan.outstandingReceivable,
      outstandingPayable: challan.outstandingPayable,
      biltyIds: challan.bilties.map((cb) => cb.biltyId),
      partyNet: settlementSummary?.partyNet || [],
      collectedByParties: settlementSummary?.bilties.flatMap((b) => b.toPay.payers) || [],
      paidByParties: settlementSummary?.carrierRent.payers || [],
      transporterParty: challan.transporterParty
        ? { partyId: challan.transporterParty.id, partyName: challan.transporterParty.partyName }
        : null,
      biltyParties: challan.bilties.map((cb) => ({
        consignor: cb.bilty.consignorParty
          ? { partyId: cb.bilty.consignorParty.id, partyName: cb.bilty.consignorParty.partyName }
          : null,
        consignee: cb.bilty.consigneeParty
          ? { partyId: cb.bilty.consigneeParty.id, partyName: cb.bilty.consigneeParty.partyName }
          : null,
      })),
      paidUnverified: resolvePaidUnverifiedEntries(challan.bilties, settlementSummary),
    });

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

    return NextResponse.json({
      success: true,
      challan,
      incomePending,
      financials,
      responsibleParties,
      settlementBreakdown,
      paidVerification,
      settlementSummary,
      position,
      // canBin mirrors GET /api/challan's own identical capability
      // exactly (SUPER_ADMIN only) - Challan Bin also resets every
      // linked Bilty's status and reverses Booking Income (see the
      // DELETE handler below), so it is gated the same way there too.
      capabilities: { canRestore: false, canBin: currentUser.role === "SUPER_ADMIN" },
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

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

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

    // Adding a Bilty to a DELIVERED-but-not-settled Challan is a
    // SUPER_ADMIN-only capability (point 4 of the Challan lifecycle
    // spec) - removing a Bilty, and adding to anything other than
    // IN_TRANSIT/DELIVERED(unsettled), is unchanged/unaffected.
    const addingToDeliveredChallan = addBiltyIds.length > 0 && existingChallan.status === "DELIVERED";

    if (addBiltyIds.length > 0 || removeBiltyIds.length > 0) {
      if (removeBiltyIds.length > 0 && existingChallan.status !== "IN_TRANSIT") {
        return NextResponse.json(
          {
            success: false,
            message: "Bilty composition can only be changed while the Challan is In Transit.",
          },
          { status: 400 }
        );
      }

      if (addBiltyIds.length > 0 && existingChallan.status === "CANCELLED") {
        return NextResponse.json(
          { success: false, message: "Cannot add Bilties to a Cancelled Challan." },
          { status: 400 }
        );
      }

      if (addingToDeliveredChallan) {
        if (existingChallan.isSettled) {
          return NextResponse.json(
            { success: false, message: "Settled Challan me Bilty add nahi ho sakti - pehle Unsettle karein." },
            { status: 400 }
          );
        }
        try {
          assertSuperAdmin(currentUser);
        } catch (permError) {
          if (permError instanceof ChallanLifecycleError) {
            return NextResponse.json({ success: false, message: permError.message }, { status: 403 });
          }
          throw permError;
        }
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

    // Unchecked (not the plain ChallanUpdateInput) - this object is
    // built up with raw foreign-key scalars (transporterPartyId
    // below), not nested relation `connect` syntax.
    const updateData: Prisma.ChallanUncheckedUpdateInput = {};

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

    // ========================================================
    // OWN CARRIER <-> TRANSPORTER (mutually exclusive - see Challan.
    // ownCarrierId's own schema doc comment). A single combined
    // picker in the UI sends EITHER transporterPartyId OR
    // ownCarrierId when the user picks one option, so whichever one
    // was actually sent this request wins and clears the other -
    // never both at once, regardless of what the other field's
    // CURRENT value already is.
    // ========================================================
    let finalOwnCarrierId = existingChallan.ownCarrierId;

    if (body.ownCarrierId !== undefined && body.ownCarrierId) {
      finalOwnCarrierId = body.ownCarrierId;
      updateData.transporterPartyId = null;
    } else if (body.transporterPartyId) {
      finalOwnCarrierId = null;
    } else if (body.ownCarrierId !== undefined && !body.ownCarrierId) {
      finalOwnCarrierId = null;
    }

    const becomingOwnCarrier = finalOwnCarrierId !== existingChallan.ownCarrierId && Boolean(finalOwnCarrierId);
    const leavingOwnCarrier = Boolean(existingChallan.ownCarrierId) && finalOwnCarrierId !== existingChallan.ownCarrierId;

    if (becomingOwnCarrier) {
      const ownCarrier = await prisma.ownCarrier.findUnique({ where: { id: finalOwnCarrierId! }, select: { isDeleted: true } });
      if (!ownCarrier || ownCarrier.isDeleted) {
        return NextResponse.json(
          { success: false, message: "Selected Own Carrier was not found" },
          { status: 400 }
        );
      }
    }

    if (leavingOwnCarrier && (await isCarrierTripChallanIncomeRecognized(prisma, id))) {
      return NextResponse.json(
        {
          success: false,
          message: "This Challan's income was already recognized via a closed Trip - reopen that Trip before changing it off Own Carrier.",
        },
        { status: 400 }
      );
    }

    if (finalOwnCarrierId !== existingChallan.ownCarrierId) {
      updateData.ownCarrierId = finalOwnCarrierId;
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
    // CHALLAN NO. (now editable) - same format rule as creation
    // (app/api/challan/route.ts's own createChallanSchema: trimmed,
    // non-empty), unique among ACTIVE Challans only (a binned
    // Challan's old number may be reused, mirroring the create
    // route's own `existingChallan && !existingChallan.isDeleted`
    // check). A no-op when the trimmed value is unchanged - never
    // touches updateData/history for a same-value submit.
    // ========================================================
    let newChallanNoTrimmed: string | undefined;
    if (body.challanNo !== undefined) {
      const trimmed = typeof body.challanNo === "string" ? body.challanNo.trim() : "";
      if (!trimmed) {
        return NextResponse.json(
          { success: false, message: "Challan number is required" },
          { status: 400 }
        );
      }
      if (trimmed !== existingChallan.challanNo) {
        const duplicate = await prisma.challan.findFirst({
          where: { challanNo: trimmed, isDeleted: false, id: { not: id } },
        });
        if (duplicate) {
          return NextResponse.json(
            { success: false, message: "Ye Challan No. pehle se maujood hai." },
            { status: 409 }
          );
        }
        newChallanNoTrimmed = trimmed;
        updateData.challanNo = trimmed;
      }
    }

    // ========================================================
    // CARRIER RENT CORRECTION (accounting-safe edit)
    //
    // Carrier Rent expense was already recognized in full at
    // Challan creation (or by a prior correction). Changing the
    // amount must post a balanced correction for the delta only -
    // never overwrite history. See lib/settlement-correction.ts.
    // ========================================================

    // An Own Carrier Challan (final state, after this edit) never
    // carries a carrierRent of its own - that figure instead lives on
    // CarrierTripDocument.carrierRentAmount per linked Trip (see
    // Challan.ownCarrierId's own schema doc comment). Forced to 0
    // here regardless of what was submitted - this also correctly
    // posts the balanced correction that zeroes out any amount a
    // regular Transporter Challan already had, the moment it becomes
    // an Own Carrier one.
    const oldCarrierRent = Number(existingChallan.carrierRent);
    const newCarrierRent = finalOwnCarrierId ? 0 : body.carrierRent !== undefined ? Number(body.carrierRent) : oldCarrierRent;
    const carrierRentDelta = Number((newCarrierRent - oldCarrierRent).toFixed(2));

    // Settlement posting date = Challan date - if THIS SAME request
    // also edits loadingDate, the correction below (posted in the
    // same transaction) uses the NEW date; existing, already-posted
    // entries are never re-dated (see updateData.loadingDate above,
    // which only ever affects future writes, never past ones).
    const effectiveLoadingDate = (updateData.loadingDate as Date | undefined) ?? existingChallan.loadingDate;

    if (carrierRentDelta !== 0 || body.carrierRent !== undefined) {
      updateData.carrierRent = newCarrierRent;
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
          challanLoadingDate: effectiveLoadingDate,
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
            const revertedBilty = await tx.bilty.update({
              where: { id: biltyId },
              data: { status: "PENDING" },
            });

            // REVERSAL - this Bilty is genuinely un-dispatched now (no
            // other active Challan references it), so any Booking
            // Income already recognized for it (app/api/challan/
            // route.ts or the addBiltyIds branch above, at an earlier
            // dispatch) must move back into Unearned Revenue - it was
            // never actually carried. No-op if nothing was recognized
            // in the first place (e.g. a legacy Bilty - see
            // lib/bilty-revenue-recognition.ts's isUnreclassifiedLegacyBilty()).
            await reverseBiltyBookingIncome(tx, revertedBilty, {
              entryDate: new Date(),
              reason: `removed from Challan ${existingChallan.challanNo}`,
              createdById: currentUser.userId,
            });
          }
        }
      }

      if (addBiltyIds.length > 0) {
        for (const biltyId of addBiltyIds) {
          await tx.challanBilty.create({ data: { challanId: id, biltyId } });
        }

        // A Bilty added to an already-DELIVERED (not settled) Challan
        // becomes DELIVERED immediately too - it never passes through
        // an intermediate IN_TRANSIT state it would otherwise have
        // skipped.
        await tx.bilty.updateMany({
          where: { id: { in: addBiltyIds } },
          data: { status: addingToDeliveredChallan ? "DELIVERED" : "IN_TRANSIT" },
        });

        // REVENUE RECOGNITION - a Bilty added to an ALREADY-EXISTING
        // Challan is just as genuinely dispatched as one included at
        // Challan creation time (app/api/challan/route.ts's own
        // identical loop) - its rent moves from Unearned Revenue into
        // real Booking Income here too, exactly once. Re-fetched
        // inside this transaction (never the pre-transaction
        // `biltiesToAdd` above) so the amount recognized is always the
        // one actually being committed.
        // SKIPPED for an Own Carrier Challan (final state) - a newly
        // added Bilty's rent stays in Unearned Revenue exactly like
        // every other Bilty on this Challan, pending the linking Trip
        // CLOSE (see Challan.ownCarrierId's own schema doc comment).
        if (!finalOwnCarrierId) {
          const addedBilties = await tx.bilty.findMany({
            where: { id: { in: addBiltyIds } },
          });
          for (const bilty of addedBilties) {
            await recognizeBiltyBookingIncome(tx, bilty, {
              entryDate: new Date(),
              challanNo: existingChallan.challanNo,
              createdById: currentUser.userId,
            });
          }
        }
      }

      // ========================================================
      // OWN CARRIER TRANSITION - reconcile already-existing Bilty
      // income recognition against the NEW final state. Scoped to
      // every Bilty CURRENTLY on this Challan (addBiltyIds already
      // handled its own Bilties just above; removeBiltyIds's own
      // Bilties were already reversed above too, so excluded here to
      // avoid a redundant second call).
      // ========================================================
      if (becomingOwnCarrier || leavingOwnCarrier) {
        const removedSet = new Set(removeBiltyIds);
        const stillLinkedBiltyIds = existingChallan.bilties.map((b) => b.biltyId).filter((bid) => !removedSet.has(bid));
        const stillLinkedBilties = await tx.bilty.findMany({ where: { id: { in: stillLinkedBiltyIds } } });

        if (becomingOwnCarrier) {
          // Already-dispatched Bilties on a Challan that is NOW an
          // Own Carrier dispatch must move their income back into
          // Unearned Revenue - it is no longer recognized until the
          // linking Trip closes. Safe no-op for any Bilty never
          // actually recognized in the first place.
          for (const bilty of stillLinkedBilties) {
            await reverseBiltyBookingIncome(tx, bilty, {
              entryDate: new Date(),
              reason: `Challan ${existingChallan.challanNo} switched to Own Carrier`,
              createdById: currentUser.userId,
            });
          }
        } else {
          // Switching OFF Own Carrier (leavingOwnCarrier) - this
          // Challan is now dispatched under a regular Transporter, so
          // its Bilties are recognized immediately, exactly like a
          // normal dispatch. Blocked earlier (before this transaction)
          // if a Trip CLOSE had already recognized this Challan's
          // income, so this path only ever runs for a Challan whose
          // Bilties are still genuinely sitting in Unearned Revenue.
          for (const bilty of stillLinkedBilties) {
            await recognizeBiltyBookingIncome(tx, bilty, {
              entryDate: effectiveLoadingDate,
              challanNo: existingChallan.challanNo,
              createdById: currentUser.userId,
            });
          }
        }
      }

      if (newChallanNoTrimmed) {
        // Re-checked inside the SAME Serializable transaction, on the
        // same connection/snapshot the write below will use - the
        // pre-transaction check above only protects against a
        // conflict that already existed at request time; this catches
        // a genuinely concurrent rename/creation racing this one. The
        // table's own @unique(challanNo) constraint is the final
        // backstop (caught as P2002 below) if this still somehow slips
        // through.
        const duplicateInTx = await tx.challan.findFirst({
          where: { challanNo: newChallanNoTrimmed, isDeleted: false, id: { not: id } },
        });
        if (duplicateInTx) {
          throw new ChallanNoConflictError();
        }
      }

      const updatedChallanRow = await tx.challan.update({
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

      if (newChallanNoTrimmed) {
        // JournalLine.sourceNumber is a denormalized DISPLAY copy only
        // (sourceId is the real reference every lookup actually uses -
        // see JournalLine's own schema comment) - every line this
        // Challan's own number was ever stamped onto (dispatch,
        // Settlement, SettlementPayment, every *_CORRECTION/
        // *_MULTI_PAYER_TRANSITION entry - anything tagged sourceType
        // "CHALLAN", sourceId = this Challan) must now show the
        // renamed number too, or Daily Posting/Cash Book/Ledger would
        // keep displaying the stale one forever. JournalEntry.description
        // (a historical narrative snapshot, e.g. "Settlement - 6423 -
        // ...") is deliberately NOT rewritten - same append-only
        // principle this codebase applies to every other historical
        // entry; only this structured, display-only field is kept live.
        await tx.journalLine.updateMany({
          where: { sourceType: "CHALLAN", sourceId: id },
          data: { sourceNumber: newChallanNoTrimmed },
        });
      }

      const changedFields = diffFields(existingChallan, updateData as Record<string, unknown>, Object.keys(updateData) as (keyof typeof existingChallan)[]);
      if (Object.keys(changedFields).length > 0 || removeBiltyIds.length > 0 || addBiltyIds.length > 0) {
        const fieldSummary = Object.entries(changedFields)
          .map(([field, { old, new: nv }]) => `${field} ${old ?? "—"} → ${nv ?? "—"}`)
          .join("; ");
        const biltySummary = [
          addBiltyIds.length > 0 ? `added ${addBiltyIds.length} Bilty(s)` : null,
          removeBiltyIds.length > 0 ? `removed ${removeBiltyIds.length} Bilty(s)` : null,
        ].filter(Boolean).join(", ");
        await auditUpdate(tx, {
          actor: actorFromUser(currentUser),
          module: "CHALLAN",
          entityType: "Challan",
          entityId: id,
          documentNo: updatedChallanRow.challanNo,
          description: `Updated Challan ${updatedChallanRow.challanNo}${fieldSummary ? `: ${fieldSummary}` : ""}${biltySummary ? ` (${biltySummary})` : ""}`,
          changedFields,
          ...requestContext(request),
        });
      }

      return updatedChallanRow;
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
      if (correctionError instanceof BiltyRevenueRecognitionError) {
        return NextResponse.json(
          { success: false, message: correctionError.message },
          { status: 400 }
        );
      }
      if (correctionError instanceof ChallanNoConflictError) {
        return NextResponse.json(
          { success: false, message: correctionError.message },
          { status: 409 }
        );
      }
      if (correctionError instanceof Prisma.PrismaClientKnownRequestError && correctionError.code === "P2002") {
        // Final backstop - the table's own @unique(challanNo) constraint,
        // for the one case the application-level checks above cannot
        // see: the new number collides with a BINNED Challan's number
        // (deliberately still allowed to exist, mirroring the create
        // route's own `existingChallan && !existingChallan.isDeleted`
        // policy) rather than an active one.
        return NextResponse.json(
          { success: false, message: "Ye Challan No. pehle se maujood hai." },
          { status: 409 }
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

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    const existingChallan = await prisma.challan.findUnique({
      where: { id },
      select: { id: true, isDeleted: true, isSettled: true, challanNo: true },
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

      await auditDelete(prisma, {
        actor: actorFromUser(currentUser),
        module: "CHALLAN",
        entityType: "Challan",
        entityId: id,
        documentNo: existingChallan.challanNo,
        description: `Permanently deleted Challan ${existingChallan.challanNo}`,
        ...requestContext(request),
      });

      return NextResponse.json({
        success: true,
        message: "Challan permanently deleted.",
        challanId: id,
      });
    }

    try {
      assertSuperAdmin(currentUser);
    } catch (permError) {
      if (permError instanceof ChallanLifecycleError) {
        return NextResponse.json({ success: false, message: permError.message }, { status: 403 });
      }
      throw permError;
    }

    if (existingChallan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan is already in Bin" },
        { status: 400 }
      );
    }

    if (existingChallan.isSettled) {
      return NextResponse.json(
        { success: false, message: "Settled Challan delete nahi ho sakta - pehle Unsettle karein." },
        { status: 400 }
      );
    }

    // Every Bilty currently linked to this Challan (ChallanBilty rows
    // are never deleted here - only Challan.isDeleted flips - so the
    // existing `challan: { isDeleted: false, status: { not: "CANCELLED" } }`
    // convention used elsewhere in this file/app automatically treats
    // these links as inactive the moment this Challan is Bin'd,
    // letting each Bilty be picked up by a brand new Challan).
    const linkedBilties = await prisma.challanBilty.findMany({
      where: { challanId: id },
      include: { bilty: { select: { id: true, biltyNo: true, status: true, total: true, isDeleted: true } } },
    });

    for (const link of linkedBilties) {
      if (link.bilty.status === "DELIVERED" && (await biltyHasPhonchOrBillReference(prisma, link.bilty.biltyNo))) {
        return NextResponse.json(
          {
            success: false,
            message: `Cannot delete Challan ${existingChallan.challanNo} - Bilty ${link.bilty.biltyNo} already has a Phonch/Bill recorded against it.`,
          },
          { status: 400 }
        );
      }
    }

    const biltyStatusChanges: { biltyNo: string; oldStatus: string }[] = [];

    await prisma.$transaction(async (tx) => {
      // Document-owned accounting (CHALLAN_DISPATCH at creation, plus
      // a CHALLAN_DISPATCH_CORRECTION per pre-settlement Carrier Rent
      // edit - see lib/settlement-correction.ts; additive, never
      // replace-on-edit) moves to Bin together with the Challan, in
      // the SAME transaction - never SETTLEMENT/SETTLEMENT_PAYMENT/
      // CARRIER_RENT_MULTI_PAYER_TRANSITION/DAILY_POSTING, which can
      // only exist on a settled Challan - already excluded above (a
      // settled Challan cannot be Bin'd).
      await tx.journalEntry.updateMany({
        where: {
          referenceType: { in: ["CHALLAN_DISPATCH", "CHALLAN_DISPATCH_CORRECTION"] },
          referenceId: id,
          isDeleted: false,
        },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: currentUser.userId,
        },
      });

      // Every linked Bilty (whether IN_TRANSIT or DELIVERED) goes back
      // to PENDING and has its Booking Income recognition reversed
      // (Dr Booking Income / Cr Unearned Revenue) - it is no longer
      // actually dispatched once this Challan is Bin'd, and must
      // become available for a brand new Challan.
      for (const link of linkedBilties) {
        if (link.bilty.isDeleted) continue;

        await reverseBiltyBookingIncome(tx, link.bilty, {
          entryDate: new Date(),
          reason: `Challan ${existingChallan.challanNo} moved to Bin`,
          createdById: currentUser.userId,
        });

        if (link.bilty.status !== "PENDING") {
          biltyStatusChanges.push({ biltyNo: link.bilty.biltyNo, oldStatus: link.bilty.status });
          await tx.bilty.update({
            where: { id: link.bilty.id },
            data: { status: "PENDING" },
          });
        }
      }

      await tx.challan.update({
        where: { id },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: currentUser.userId,
        },
      });

      const biltySummary = biltyStatusChanges.map((c) => `Bilty ${c.biltyNo}: ${c.oldStatus} -> PENDING`).join("; ");

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "CHALLAN",
        entityType: "Challan",
        entityId: id,
        documentNo: existingChallan.challanNo,
        description: `Moved Challan ${existingChallan.challanNo} to Bin${biltySummary ? ` (${biltySummary})` : ""}`,
        changedFields: biltyStatusChanges.length > 0 ? { bilties: { old: biltyStatusChanges.map((c) => ({ biltyNo: c.biltyNo, status: c.oldStatus })), new: biltyStatusChanges.map((c) => ({ biltyNo: c.biltyNo, status: "PENDING" })) } } : null,
        ...requestContext(request),
      });
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
