import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

const createLocationSchema = z.object({
  name: z.string().trim().min(2, "Location name must be at least 2 characters"),
});

export async function GET() {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "bilty.view")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    const locations = await prisma.location.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      locations,
    });
  } catch (error) {
    console.error("Get locations error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "bilty.create")) {
      return NextResponse.json(
        {
          success: false,
          message: "You do not have permission to create locations",
        },
        { status: 403 }
      );
    }

    const body = await request.json();

    const result = createLocationSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid location data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    const existingLocation = await prisma.location.findUnique({
      where: {
        name: data.name,
      },
    });

    if (existingLocation) {
      return NextResponse.json(
        {
          success: false,
          message: "Location with this name already exists",
        },
        { status: 409 }
      );
    }

    const location = await prisma.location.create({
      data: {
        name: data.name,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: "Location created successfully",
        location,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Create location error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Something went wrong",
      },
      { status: 500 }
    );
  }
}