import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

function startOfDay(value: string) {
  return new Date(`${value}T00:00:00`);
}

function endOfDay(value: string) {
  const end = startOfDay(value);
  end.setDate(end.getDate() + 1);
  return end;
}

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "bilty.binView")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search")?.trim();

    const deletedAt: { gte?: Date; lt?: Date } = {};

    if (from) {
      const date = startOfDay(from);
      if (Number.isNaN(date.getTime())) {
        return NextResponse.json(
          { success: false, message: "Invalid from date" },
          { status: 400 }
        );
      }
      deletedAt.gte = date;
    }

    if (to) {
      const date = endOfDay(to);
      if (Number.isNaN(date.getTime())) {
        return NextResponse.json(
          { success: false, message: "Invalid to date" },
          { status: 400 }
        );
      }
      deletedAt.lt = date;
    }

    const bilties = await prisma.bilty.findMany({
      where: {
        isDeleted: true,
        ...(Object.keys(deletedAt).length > 0 ? { deletedAt } : {}),
        ...(search
          ? {
              OR: [
                { biltyNo: { contains: search, mode: "insensitive" } },
                { consignorName: { contains: search, mode: "insensitive" } },
                { consigneeName: { contains: search, mode: "insensitive" } },
                { notes: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
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
          },
        },
        agentParty: {
          select: {
            id: true,
            partyName: true,
          },
        },
        deletedBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
      },
      orderBy: [{ deletedAt: "desc" }, { date: "desc" }],
    });

    return NextResponse.json({
      success: true,
      bilties,
      capabilities: {
        canRestore: hasPermission(currentUser, "bilty.restore"),
        canPermanentlyDelete: hasPermission(
          currentUser,
          "bilty.permanentlyDelete"
        ),
      },
    });
  } catch (error) {
    console.error("Get bilty Bin error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load the Bilty Bin" },
      { status: 500 }
    );
  }
}
