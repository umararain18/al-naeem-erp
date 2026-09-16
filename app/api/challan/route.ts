import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { computeChallanFinancialsBatch } from "@/lib/challan-financials";
import { getGrossCarrierRentPayableAccountId } from "@/lib/gross-accounts";
import { getChallanResponsiblePartiesBatch } from "@/lib/document-party-resolution";
import { computeChallanSettlementSummaryBatch } from "@/lib/challan-settlement-summary";
import { SettlementPaymentError } from "@/lib/settlement-payments";

// Re-check status codes for the in-transaction Bilty-availability
// re-validation below (POST) - kept separate from the pre-transaction
// check's own inline NextResponse statuses since these fire from
// inside the Serializable transaction and must be mapped after it
// resolves. See the comment at that re-check for why it exists.
function biltyRecheckStatus(code: string): number {
  switch (code) {
    case "BILTIES_NOT_FOUND":
      return 404;
    case "BILTY_ALREADY_ASSIGNED":
      return 409;
    default:
      return 400;
  }
}

const createChallanSchema = z.object({
  challanNo: z
    .string()
    .trim()
    .min(1, "Challan number is required"),

  loadingDate: z
    .string()
    .min(1, "Loading date is required"),

  transporterPartyId: z
    .string()
    .optional()
    .or(z.literal("")),

  driverName: z
    .string()
    .optional()
    .or(z.literal("")),

  driverPhone: z
    .string()
    .optional()
    .or(z.literal("")),

  carrierNumber: z
    .string()
    .optional()
    .or(z.literal("")),

  carrierRent: z
    .number()
    .min(0, "Carrier rent cannot be negative")
    .optional(),

  remarks: z
    .string()
    .optional()
    .or(z.literal("")),

  biltyIds: z
    .array(z.string())
    .min(1, "At least one bilty is required"),
});

export async function GET() {
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

    const challans = await prisma.challan.findMany({
      where: { isDeleted: false },
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
      orderBy: [
        { loadingDate: "desc" },
        { createdAt: "desc" },
      ],
    });

    const financialsMap = await computeChallanFinancialsBatch(
      challans.map((c) => ({
        id: c.id,
        outstandingReceivable: c.outstandingReceivable,
        outstandingPayable: c.outstandingPayable,
        biltyIds: c.bilties.map((cb) => cb.biltyId),
      }))
    );

    // Purely informational "who" behind the receivable/payable
    // totals above - does not affect the amounts themselves.
    const responsiblePartiesMap = await getChallanResponsiblePartiesBatch(
      challans.filter((c) => c.isSettled).map((c) => c.id)
    );

    // Dimensionally-separated settlement summary (same authoritative
    // source Final Settlement and the Challan Detail page use) -
    // batched across every Challan in ONE pass (see
    // lib/challan-settlement-summary.ts). `financials`/
    // `responsibleParties` above are left unchanged for now; only
    // what the list UI displays for Financial Summary changes.
    const settlementSummaryMap = await computeChallanSettlementSummaryBatch(challans.map((c) => c.id));

    const items = challans.map((c) => ({
      ...c,
      financials: financialsMap[c.id],
      responsibleParties: responsiblePartiesMap[c.id],
      settlementSummary: settlementSummaryMap[c.id],
    }));

    return NextResponse.json({
      success: true,
      items,
      // Matches the exact permission DELETE /api/challan/[id] (the
      // Bin action) already enforces - lets the list page hide the
      // Delete button for a role the backend would reject anyway,
      // the same capabilities-flag pattern app/api/employees/route.ts
      // already uses.
      capabilities: {
        canBin: hasPermission(currentUser, "challan.bin"),
      },
    });
  } catch (error) {
    console.error("List challans error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load challans" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "challan.create")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const result = createChallanSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid challan data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    const loadingDate = new Date(`${data.loadingDate}T00:00:00`);
    if (Number.isNaN(loadingDate.getTime())) {
      return NextResponse.json(
        { success: false, message: "Invalid loading date" },
        { status: 400 }
      );
    }

    const existingChallan = await prisma.challan.findUnique({
      where: { challanNo: data.challanNo },
    });

    if (existingChallan && !existingChallan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan number already exists" },
        { status: 409 }
      );
    }

    const bilties = await prisma.bilty.findMany({
      where: {
        id: { in: data.biltyIds },
      },
      include: {
        challanBilties: {
          include: {
            challan: true,
          },
        },
      },
    });

    if (bilties.length !== data.biltyIds.length) {
      return NextResponse.json(
        { success: false, message: "One or more bilties not found" },
        { status: 404 }
      );
    }

    for (const bilty of bilties) {
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

    // ------------------------------------------------
    // CARRIER RENT ACCOUNTING
    //
    // Full Carrier Rent expense is recognized NOW, at dispatch
    // time - not later at Settlement. The responsible PARTY is
    // not yet known, so the offsetting side is a gross clearing
    // account that Settlement will later reclassify into the
    // real party. See lib/gross-accounts.ts.
    // ------------------------------------------------

    const carrierRentAmount = data.carrierRent ?? 0;
    let carrierRentExpenseAccountId: string | null = null;

    if (carrierRentAmount > 0) {
      const carrierRentAccount = await prisma.account.findFirst({
        where: { category: "CARRIER_RENT", isActive: true },
        select: { id: true },
      });

      if (!carrierRentAccount) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Required account is not configured. Please configure a CARRIER_RENT account.",
          },
          { status: 400 }
        );
      }

      carrierRentExpenseAccountId = carrierRentAccount.id;
    }

    let challan;
    try {
      challan = await prisma.$transaction(async (tx) => {
      // Re-check every Bilty's availability INSIDE this SERIALIZABLE
      // transaction, on the same snapshot the writes below will use.
      // The pre-check above (lines ~201-249) only protects against a
      // Bilty that was already unavailable at the time of THAT read -
      // it cannot protect against a second, truly concurrent
      // POST /api/challan request racing this one for the SAME Bilty.
      // Under SERIALIZABLE, if both transactions read here before
      // either commits, Postgres aborts one with a serialization
      // failure (caught below as P2034 -> 409); if one has already
      // committed by the time this one reads, this explicit re-check
      // catches it directly instead of silently double-dispatching
      // the same Bilty onto two active Challans.
      const freshBilties = await tx.bilty.findMany({
        where: { id: { in: data.biltyIds } },
        include: {
          challanBilties: {
            include: {
              challan: true,
            },
          },
        },
      });

      if (freshBilties.length !== data.biltyIds.length) {
        throw new SettlementPaymentError("BILTIES_NOT_FOUND", "One or more bilties not found");
      }

      for (const bilty of freshBilties) {
        if (bilty.isDeleted) {
          throw new SettlementPaymentError("BILTY_DELETED", `Bilty ${bilty.biltyNo} is deleted`);
        }

        if (bilty.status !== "PENDING") {
          throw new SettlementPaymentError("BILTY_NOT_PENDING", `Bilty ${bilty.biltyNo} is not pending`);
        }

        const activeChallan = bilty.challanBilties.find(
          (cb) => cb.challan && !cb.challan.isDeleted
        );

        if (activeChallan) {
          throw new SettlementPaymentError(
            "BILTY_ALREADY_ASSIGNED",
            `Bilty ${bilty.biltyNo} is already assigned to challan ${activeChallan.challan.challanNo}`
          );
        }
      }

      const createdChallan = await tx.challan.create({
        data: {
          challanNo: data.challanNo,
          loadingDate,
          transporterPartyId: data.transporterPartyId || undefined,
          driverName: data.driverName || undefined,
          driverPhone: data.driverPhone || undefined,
          carrierNumber: data.carrierNumber || undefined,
          carrierRent: carrierRentAmount,
          remarks: data.remarks || undefined,
          createdById: currentUser.userId,
        },
        include: {
          transporterParty: {
            select: {
              id: true,
              partyName: true,
            },
          },
        },
      });

      for (const biltyId of data.biltyIds) {
        await tx.challanBilty.create({
          data: {
            challanId: createdChallan.id,
            biltyId,
          },
        });
      }

      await tx.bilty.updateMany({
        where: {
          id: { in: data.biltyIds },
        },
        data: {
          status: "IN_TRANSIT",
        },
      });

      if (carrierRentAmount > 0 && carrierRentExpenseAccountId) {
        const grossCarrierRentPayableId = await getGrossCarrierRentPayableAccountId(tx);

        await tx.journalEntry.create({
          data: {
            entryDate: loadingDate,
            referenceType: "CHALLAN_DISPATCH",
            referenceId: createdChallan.id,
            description: `Challan Dispatch - ${createdChallan.challanNo} - Carrier Rent`,
            createdById: currentUser.userId,
            lines: {
              create: [
                {
                  accountId: carrierRentExpenseAccountId,
                  debit: carrierRentAmount,
                  credit: 0,
                  description: `Dispatch - ${createdChallan.challanNo} - Carrier Rent`,
                  sourceType: "CHALLAN",
                  sourceId: createdChallan.id,
                  sourceNumber: createdChallan.challanNo,
                },
                {
                  accountId: grossCarrierRentPayableId,
                  debit: 0,
                  credit: carrierRentAmount,
                  description: `Dispatch - ${createdChallan.challanNo} - Carrier Rent`,
                  sourceType: "CHALLAN",
                  sourceId: createdChallan.id,
                  sourceNumber: createdChallan.challanNo,
                },
              ],
            },
          },
        });
      }

      return createdChallan;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (txError) {
      if (txError instanceof SettlementPaymentError) {
        return NextResponse.json(
          { success: false, message: txError.message },
          { status: biltyRecheckStatus(txError.code) }
        );
      }
      if (txError instanceof Prisma.PrismaClientKnownRequestError && txError.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Challan could not be created due to a concurrent change. Please retry." },
          { status: 409 }
        );
      }
      throw txError;
    }

    return NextResponse.json({
      success: true,
      message: "Challan created successfully",
      challan,
    });
  } catch (error) {
    console.error("Create challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create challan" },
      { status: 500 }
    );
  }
}
