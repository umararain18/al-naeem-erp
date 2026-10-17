import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  CarrierSlipError,
  validateChallanLinkEligible,
  validateBiltyLinkEligible,
  computeSlipFinancials,
} from "@/lib/carrier-slip";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";

const collectionSchema = z.object({
  date: z.string().min(1),
  amount: z.number().positive(),
  collectedBy: z.enum(["DRIVER", "OFFICE"]),
  method: z.enum(["CASH", "BANK_ONLINE"]),
  note: z.string().optional().or(z.literal("")),
});

const expenseSchema = z
  .object({
    date: z.string().min(1),
    accountId: z.string().min(1),
    description: z.string().optional().or(z.literal("")),
    amount: z.number().positive(),
    paymentType: z.enum(["NAQAD", "KHATA", "OFFICE_PAID"]),
    vendorPartyId: z.string().optional().or(z.literal("")),
  })
  .refine((e) => e.paymentType !== "KHATA" || !!e.vendorPartyId, {
    message: "A Khata expense requires a vendor party.",
    path: ["vendorPartyId"],
  });

const createSchema = z
  .object({
    carrierId: z.string().min(1),
    slipNo: z.string().trim().min(1, "Slip number is required"),
    departureDate: z.string().min(1),
    returnDate: z.string().optional().or(z.literal("")),
    route: z.string().optional().or(z.literal("")),
    driverName: z.string().optional().or(z.literal("")),
    driverPhone: z.string().optional().or(z.literal("")),
    status: z.enum(["IN_PROGRESS", "TRIP_COMPLETED", "RETURNED"]).optional(),
    linkedChallanId: z.string().optional().or(z.literal("")),
    linkedBiltyId: z.string().optional().or(z.literal("")),
    manualTotalBiltyRent: z.number().min(0).optional(),
    manualCarrierRent: z.number().min(0).optional(),
    notes: z.string().optional().or(z.literal("")),
    collections: z.array(collectionSchema).optional(),
    expenses: z.array(expenseSchema).optional(),
  })
  .refine((d) => !(d.linkedChallanId && d.linkedBiltyId), {
    message: "Link either a Challan or a Bilty, not both.",
    path: ["linkedBiltyId"],
  });

function errorStatus(code: string): number {
  switch (code) {
    case "CHALLAN_NOT_FOUND":
    case "BILTY_NOT_FOUND":
      return 404;
    case "CHALLAN_ALREADY_LINKED":
    case "BILTY_ALREADY_LINKED":
      return 409;
    default:
      return 400;
  }
}

// GET /api/carrier-slips?carrierId=...&search=...
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const carrierId = searchParams.get("carrierId");
    if (!carrierId) {
      return NextResponse.json({ success: false, message: "carrierId is required" }, { status: 400 });
    }

    const slips = await prisma.carrierSlip.findMany({
      where: { carrierId, isDeleted: false },
      include: { linkedChallan: { select: { id: true, challanNo: true } }, linkedBilty: { select: { id: true, biltyNo: true } } },
      orderBy: [{ departureDate: "desc" }, { createdAt: "desc" }],
    });

    const withFinancials = await Promise.all(
      slips.map(async (slip) => ({ ...slip, financials: await computeSlipFinancials(prisma, slip) }))
    );

    return NextResponse.json({ success: true, slips: withFinancials });
  } catch (error) {
    console.error("List carrier slips error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}

// POST /api/carrier-slips
export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = createSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid slip data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    const carrier = await prisma.ownCarrier.findUnique({ where: { id: data.carrierId } });
    if (!carrier || carrier.isDeleted) {
      return NextResponse.json({ success: false, message: "Carrier not found" }, { status: 404 });
    }

    const departureDate = new Date(data.departureDate);
    if (Number.isNaN(departureDate.getTime())) {
      return NextResponse.json({ success: false, message: "Invalid departure date" }, { status: 400 });
    }
    const returnDate = data.returnDate ? new Date(data.returnDate) : null;
    if (returnDate && Number.isNaN(returnDate.getTime())) {
      return NextResponse.json({ success: false, message: "Invalid return date" }, { status: 400 });
    }

    let slip;
    try {
      slip = await prisma.$transaction(async (tx) => {
        if (data.linkedChallanId) {
          await validateChallanLinkEligible(tx, data.linkedChallanId);
        }
        if (data.linkedBiltyId) {
          await validateBiltyLinkEligible(tx, data.linkedBiltyId);
        }

        const created = await tx.carrierSlip.create({
          data: {
            carrierId: data.carrierId,
            slipNo: data.slipNo,
            departureDate,
            returnDate,
            route: data.route || null,
            driverName: data.driverName || carrier.driverName || null,
            driverPhone: data.driverPhone || carrier.driverPhone || null,
            status: data.status || "IN_PROGRESS",
            linkedChallanId: data.linkedChallanId || null,
            linkedBiltyId: data.linkedBiltyId || null,
            manualTotalBiltyRent: !data.linkedChallanId && !data.linkedBiltyId ? data.manualTotalBiltyRent ?? 0 : null,
            manualCarrierRent: !data.linkedChallanId && !data.linkedBiltyId ? data.manualCarrierRent ?? 0 : null,
            notes: data.notes || null,
            createdById: currentUser.userId,
            collections: data.collections
              ? { create: data.collections.map((c) => ({ date: new Date(c.date), amount: c.amount, collectedBy: c.collectedBy, method: c.method, note: c.note || null })) }
              : undefined,
            expenses: data.expenses
              ? {
                  create: data.expenses.map((e) => ({
                    date: new Date(e.date),
                    accountId: e.accountId,
                    description: e.description || null,
                    amount: e.amount,
                    paymentType: e.paymentType,
                    vendorPartyId: e.paymentType === "KHATA" ? e.vendorPartyId || null : null,
                  })),
                }
              : undefined,
          },
        });

        await auditCreate(tx, {
          actor: actorFromUser(currentUser),
          module: "OWN_CARRIER",
          entityType: "CarrierSlip",
          entityId: created.id,
          documentNo: `${carrier.carrierNumber} / Slip ${created.slipNo}`,
          description: `Created Carrier Slip ${created.slipNo} for ${carrier.carrierNumber}`,
          newValues: { carrierId: data.carrierId, slipNo: data.slipNo, departureDate: data.departureDate },
          ...requestContext(request),
        });

        return created;
      });
    } catch (txError) {
      if (txError instanceof CarrierSlipError) {
        return NextResponse.json({ success: false, code: txError.code, message: txError.message }, { status: errorStatus(txError.code) });
      }
      if (txError instanceof Prisma.PrismaClientKnownRequestError && txError.code === "P2002") {
        return NextResponse.json({ success: false, message: "This slip number already exists for this carrier" }, { status: 409 });
      }
      throw txError;
    }

    return NextResponse.json({ success: true, message: "Slip created successfully", slip }, { status: 201 });
  } catch (error) {
    console.error("Create carrier slip error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
