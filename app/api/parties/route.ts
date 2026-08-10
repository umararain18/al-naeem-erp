import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { BalanceType, PartyType } from "@prisma/client";

const createPartySchema = z.object({
  partyName: z.string().min(2, "Party name is required"),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  cnicNtn: z.string().optional(),
  address: z.string().optional(),

  partyTypes: z
    .array(z.enum(["TRANSPORTER", "CLEARING_AGENT", "CUSTOMER", "VENDOR"]))
    .min(1, "At least one party type is required"),

  openingBalance: z
    .number()
    .min(0, "Opening balance cannot be negative")
    .optional(),

  openingBalanceType: z
    .enum(["DEBIT", "CREDIT"])
    .optional(),

  notes: z.string().optional(),
});

// GET /api/parties
export async function GET() {
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

    const parties = await prisma.party.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      success: true,
      parties,
    });
  } catch (error) {
    console.error("Get parties error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}

// POST /api/parties
export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "parties.create")) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to create parties",
        },
        { status: 403 }
      );
    }

    const body = await request.json();

    const result = createPartySchema.safeParse(body);

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

    const party = await prisma.party.create({
      data: {
        partyName: data.partyName,
        contactPerson: data.contactPerson || null,
        phone: data.phone || null,
        whatsapp: data.whatsapp || null,
        cnicNtn: data.cnicNtn || null,
        address: data.address || null,

        partyTypes: data.partyTypes as PartyType[],

        openingBalance: data.openingBalance ?? 0,

        openingBalanceType: data.openingBalanceType
          ? (data.openingBalanceType as BalanceType)
          : null,

        isActive: true,
        notes: data.notes || null,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: "Party created successfully",
        party,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Create party error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}