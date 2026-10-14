import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { createOwnCarrierWithAccount } from "@/lib/own-carrier";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";

const createSchema = z.object({
  carrierNumber: z.string().trim().min(1, "Carrier/vehicle number is required"),
  driverName: z.string().optional().or(z.literal("")),
  driverPhone: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

// GET /api/own-carriers?search=...&status=ACTIVE|INACTIVE|BINNED
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
    const search = searchParams.get("search")?.trim();
    const status = searchParams.get("status");

    const where: Prisma.OwnCarrierWhereInput = {
      isDeleted: status === "BINNED",
      ...(status === "ACTIVE" ? { isActive: true } : {}),
      ...(status === "INACTIVE" ? { isActive: false } : {}),
      ...(search
        ? {
            OR: [
              { carrierNumber: { contains: search, mode: "insensitive" } },
              { driverName: { contains: search, mode: "insensitive" } },
              { driverPhone: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const carriers = await prisma.ownCarrier.findMany({
      where,
      include: {
        driverCashAccount: { select: { id: true } },
        _count: { select: { slips: { where: { isDeleted: false } } } },
      },
      orderBy: [{ isActive: "desc" }, { carrierNumber: "asc" }],
    });

    return NextResponse.json({ success: true, carriers });
  } catch (error) {
    console.error("List own carriers error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}

// POST /api/own-carriers
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
        { success: false, message: "Invalid carrier data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    const existing = await prisma.ownCarrier.findUnique({ where: { carrierNumber: data.carrierNumber } });
    if (existing) {
      return NextResponse.json({ success: false, message: "This carrier/vehicle number already exists" }, { status: 409 });
    }

    const { carrier } = await prisma.$transaction(async (tx) => {
      const { carrier, account } = await createOwnCarrierWithAccount(tx, {
        carrierNumber: data.carrierNumber,
        driverName: data.driverName,
        driverPhone: data.driverPhone,
        notes: data.notes,
        createdById: currentUser.userId,
      });

      await auditCreate(tx, {
        actor: actorFromUser(currentUser),
        module: "OWN_CARRIER",
        entityType: "OwnCarrier",
        entityId: carrier.id,
        documentNo: carrier.carrierNumber,
        description: `Created Own Carrier ${carrier.carrierNumber}${data.driverName ? ` (Driver: ${data.driverName})` : ""}`,
        newValues: { carrierNumber: carrier.carrierNumber, driverName: data.driverName || null, driverPhone: data.driverPhone || null },
        ...requestContext(request),
      });

      return { carrier, account };
    });

    return NextResponse.json({ success: true, message: "Carrier created successfully", carrier }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ success: false, message: "This carrier/vehicle number already exists" }, { status: 409 });
    }
    console.error("Create own carrier error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
