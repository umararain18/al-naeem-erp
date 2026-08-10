import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { BalanceType, PartyType } from "@prisma/client";

const updatePartySchema = z.object({
  partyName: z.string().min(2, "Party name is required").optional(),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  cnicNtn: z.string().optional(),
  address: z.string().optional(),

  partyTypes: z
    .array(
      z.enum([
        "TRANSPORTER",
        "CLEARING_AGENT",
        "CUSTOMER",
        "VENDOR",
      ])
    )
    .min(1, "At least one party type is required")
    .optional(),

  openingBalance: z
    .number()
    .min(0, "Opening balance cannot be negative")
    .optional(),

  openingBalanceType: z
    .enum(["DEBIT", "CREDIT"])
    .nullable()
    .optional(),

  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

// GET /api/parties/[id]
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

    if (!hasPermission(currentUser, "parties.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;

    const party = await prisma.party.findUnique({
      where: { id },
    });

    if (!party) {
      return NextResponse.json(
        { success: false, message: "Party not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      party,
    });
  } catch (error) {
    console.error("Get party error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}

// PATCH /api/parties/[id]
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

    if (!hasPermission(currentUser, "parties.edit")) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to edit parties",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const existingParty = await prisma.party.findUnique({
      where: { id },
    });

    if (!existingParty) {
      return NextResponse.json(
        { success: false, message: "Party not found" },
        { status: 404 }
      );
    }

    const body = await request.json();

    const result = updatePartySchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid party data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    const updatedParty = await prisma.party.update({
      where: { id },
      data: {
        ...(data.partyName !== undefined && {
          partyName: data.partyName,
        }),

        ...(data.contactPerson !== undefined && {
          contactPerson: data.contactPerson || null,
        }),

        ...(data.phone !== undefined && {
          phone: data.phone || null,
        }),

        ...(data.whatsapp !== undefined && {
          whatsapp: data.whatsapp || null,
        }),

        ...(data.cnicNtn !== undefined && {
          cnicNtn: data.cnicNtn || null,
        }),

        ...(data.address !== undefined && {
          address: data.address || null,
        }),

        ...(data.partyTypes !== undefined && {
          partyTypes: data.partyTypes as PartyType[],
        }),

        ...(data.openingBalance !== undefined && {
          openingBalance: data.openingBalance,
        }),

        ...(data.openingBalanceType !== undefined && {
          openingBalanceType: data.openingBalanceType
            ? (data.openingBalanceType as BalanceType)
            : null,
        }),

        ...(data.isActive !== undefined && {
          isActive: data.isActive,
        }),

        ...(data.notes !== undefined && {
          notes: data.notes || null,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      message: "Party updated successfully",
      party: updatedParty,
    });
  } catch (error) {
    console.error("Update party error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}

// DELETE /api/parties/[id]
export async function DELETE(
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

    if (!hasPermission(currentUser, "parties.delete")) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to delete parties",
        },
        { status: 403 }
      );
    }

    const { id } = await params;

    const existingParty = await prisma.party.findUnique({
      where: { id },
    });

    if (!existingParty) {
      return NextResponse.json(
        { success: false, message: "Party not found" },
        { status: 404 }
      );
    }

    await prisma.party.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      message: "Party deleted successfully",
    });
  } catch (error) {
    console.error("Delete party error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}