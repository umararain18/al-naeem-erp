import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

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
        bilties: {
          include: {
            bilty: true,
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

    if (challan.status === "CANCELLED") {
      return NextResponse.json(
        { success: false, message: "Cancelled challan cannot be delivered" },
        { status: 400 }
      );
    }

    if (challan.status === "DELIVERED") {
      return NextResponse.json(
        { success: false, message: "Challan is already delivered" },
        { status: 400 }
      );
    }

    const updatedChallan = await prisma.$transaction(async (tx) => {
      const delivered = await tx.challan.update({
        where: { id },
        data: {
          status: "DELIVERED",
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

      for (const cb of delivered.bilties) {
        await tx.bilty.update({
          where: { id: cb.biltyId },
          data: {
            status: "DELIVERED",
          },
        });
      }

      return delivered;
    });

    return NextResponse.json({
      success: true,
      message: "Challan delivered successfully",
      challan: updatedChallan,
    });
  } catch (error) {
    console.error("Deliver challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to deliver challan" },
      { status: 500 }
    );
  }
}
