import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { createOwnCarrierWithAccount, getDriverCashBalance } from "@/lib/own-carrier";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";

/**
 * Turns an unexpected (not already-specifically-handled) error into a
 * short, real diagnostic for the response message - never the opaque
 * "Unable to..." fallback alone. The full error is still always
 * console.error'd separately for the server log; this is only about
 * what the UI shows, so a genuine failure (bad data, a stale/broken
 * Prisma Client, a missing required account, etc.) is visible
 * immediately instead of needing a server-log lookup every time.
 */
function describeError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientValidationError) {
    // Prisma's own message is a multi-line dump of the generated query
    // object - the actual reason ("Unknown argument `x`.", "Argument
    // `y` is missing.", etc.) is always the last non-empty line.
    const lines = error.message.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || "A database validation error occurred.";
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.message.split("\n")[0].trim()} (code ${error.code})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unknown error occurred.";
}

// ============================================================
// OWN CARRIER - LIST + CREATE
//
// Creation atomically creates exactly one linked Driver Cash Account
// in the SAME transaction (lib/own-carrier.ts's own
// createOwnCarrierWithAccount) - mirrors app/api/parties/route.ts and
// app/api/employees/route.ts's own Party+Account / Employee+Account
// pattern exactly.
// ============================================================

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

    const carriers = await prisma.ownCarrier.findMany({
      where: {
        isDeleted: false,
        ...(search
          ? {
              OR: [
                { carrierNumber: { contains: search, mode: "insensitive" } },
                { driverName: { contains: search, mode: "insensitive" } },
                { driverPhone: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        driverCashAccount: { select: { id: true } },
        currentDriver: { select: { id: true, name: true } },
        trips: { where: { isDeleted: false }, select: { id: true } },
      },
      orderBy: [{ isActive: "desc" }, { carrierNumber: "asc" }],
    });

    const items = await Promise.all(
      carriers.map(async (carrier) => ({
        id: carrier.id,
        carrierNumber: carrier.carrierNumber,
        driverName: carrier.driverName,
        driverPhone: carrier.driverPhone,
        notes: carrier.notes,
        isActive: carrier.isActive,
        currentDriver: carrier.currentDriver,
        tripCount: carrier.trips.length,
        driverCashAccountId: carrier.driverCashAccount?.id ?? null,
        driverCashBalance: carrier.driverCashAccount
          ? await getDriverCashBalance(prisma, carrier.driverCashAccount.id)
          : 0,
      }))
    );

    return NextResponse.json({
      success: true,
      items,
      total: items.length,
      capabilities: {
        canCreate: hasPermission(currentUser, "ownCarrier.create"),
        canEdit: hasPermission(currentUser, "ownCarrier.edit"),
        canBin: hasPermission(currentUser, "ownCarrier.bin"),
      },
    });
  } catch (error) {
    console.error("Get own carriers error:", error);
    return NextResponse.json({ success: false, message: `Unable to load Own Carriers: ${describeError(error)}` }, { status: 500 });
  }
}

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
    const carrierNumber = typeof body.carrierNumber === "string" ? body.carrierNumber.trim() : "";
    if (!carrierNumber) {
      return NextResponse.json({ success: false, message: "Carrier number is required" }, { status: 400 });
    }

    const existing = await prisma.ownCarrier.findFirst({
      where: { carrierNumber, isDeleted: false },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ success: false, message: "This carrier number already exists" }, { status: 409 });
    }

    if (body.currentDriverId) {
      const employee = await prisma.employee.findUnique({
        where: { id: body.currentDriverId },
        select: { isDeleted: true },
      });
      if (!employee || employee.isDeleted) {
        return NextResponse.json({ success: false, message: "Selected driver was not found" }, { status: 400 });
      }
    }

    try {
      const { carrier } = await prisma.$transaction(
        async (tx) => {
          const dupInTx = await tx.ownCarrier.findFirst({
            where: { carrierNumber, isDeleted: false },
            select: { id: true },
          });
          if (dupInTx) {
            throw new Prisma.PrismaClientKnownRequestError("Duplicate carrier number", {
              code: "P2002",
              clientVersion: Prisma.prismaVersion.client,
            });
          }

          const result = await createOwnCarrierWithAccount(tx, {
            carrierNumber,
            driverName: body.driverName,
            driverPhone: body.driverPhone,
            notes: body.notes,
            currentDriverId: body.currentDriverId,
            createdById: currentUser.userId,
          });

          await auditCreate(tx, {
            actor: actorFromUser(currentUser),
            module: "OWN_CARRIER",
            entityType: "OwnCarrier",
            entityId: result.carrier.id,
            documentNo: result.carrier.carrierNumber,
            description: `Created Own Carrier ${result.carrier.carrierNumber}`,
            newValues: { carrierNumber: result.carrier.carrierNumber, driverName: result.carrier.driverName },
            ...requestContext(request),
          });

          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json(
        { success: true, message: "Own Carrier created successfully.", carrier: { id: carrier.id, carrierNumber: carrier.carrierNumber } },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ success: false, message: "This carrier number already exists" }, { status: 409 });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another carrier was being created at the same time. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Create own carrier error:", error);
    return NextResponse.json({ success: false, message: `Unable to create Own Carrier: ${describeError(error)}` }, { status: 500 });
  }
}
