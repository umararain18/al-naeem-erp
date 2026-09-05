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
        { success: false, message: "Challan is already cancelled" },
        { status: 400 }
      );
    }

    if (challan.status === "DELIVERED") {
      return NextResponse.json(
        { success: false, message: "Delivered challan cannot be cancelled" },
        { status: 400 }
      );
    }

    const updatedChallan = await prisma.$transaction(async (tx) => {
      const cancelled = await tx.challan.update({
        where: { id },
        data: {
          status: "CANCELLED",
          updatedById: currentUser.userId,
        },
        include: {
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

      for (const cb of cancelled.bilties) {
        const bilty = await tx.bilty.findUnique({
          where: { id: cb.biltyId },
        });

        if (bilty && bilty.status === "IN_TRANSIT") {
          const otherActiveChallan = await tx.challanBilty.findFirst({
            where: {
              biltyId: cb.biltyId,
              challan: {
                isDeleted: false,
                status: { not: "CANCELLED" },
              },
            },
            include: {
              challan: true,
            },
          });

          if (!otherActiveChallan) {
            await tx.bilty.update({
              where: { id: cb.biltyId },
              data: {
                status: "PENDING",
              },
            });
          }
        }
      }

      return cancelled;
    });

    return NextResponse.json({
      success: true,
      message: "Challan cancelled successfully",
      challan: updatedChallan,
    });
  } catch (error) {
    console.error("Cancel challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to cancel challan" },
      { status: 500 }
    );
  }
}
