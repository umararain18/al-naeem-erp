import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

const updateLocationSchema = z.object({
  name: z.string().trim().min(2, "Location name must be at least 2 characters").optional(),
  isActive: z.boolean().optional(),
});

// UPDATE LOCATION
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

    // Locations piggyback on the Bilty permission namespace - same as
    // this route's own GET/POST siblings in app/api/locations/route.ts.
    if (!hasPermission(currentUser, "bilty.edit")) {
      return NextResponse.json(
        { success: false, message: "You do not have permission to edit locations" },
        { status: 403 }
      );
    }

    const { id } = await params;

    // See the identical guard in app/api/parties/[id]/route.ts.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Location not found" },
        { status: 404 }
      );
    }

    const existingLocation = await prisma.location.findUnique({
      where: { id },
    });

    if (!existingLocation) {
      return NextResponse.json(
        { success: false, message: "Location not found" },
        { status: 404 }
      );
    }

    const body = await request.json();

    const result = updateLocationSchema.safeParse(body);

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

    if (data.name !== undefined && data.name !== existingLocation.name) {
      const duplicate = await prisma.location.findUnique({
        where: { name: data.name },
      });

      if (duplicate) {
        return NextResponse.json(
          { success: false, message: "Location with this name already exists" },
          { status: 409 }
        );
      }
    }

    const location = await prisma.$transaction(async (tx) => {
      const updated = await tx.location.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
        select: {
          id: true,
          name: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const changedFields = diffFields(
        existingLocation as unknown as Record<string, unknown>,
        data as Record<string, unknown>,
        Object.keys(data) as (keyof typeof existingLocation)[]
      );

      if (Object.keys(changedFields).length > 0) {
        const summary = Object.entries(changedFields)
          .map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`)
          .join("; ");

        await auditUpdate(tx, {
          actor: actorFromUser(currentUser),
          module: "LOCATION",
          entityType: "Location",
          entityId: id,
          documentNo: updated.name,
          description: `Updated Location ${updated.name}: ${summary}`,
          changedFields,
          ...requestContext(request),
        });
      }

      return updated;
    });

    return NextResponse.json({
      success: true,
      message: "Location updated successfully",
      location,
    });
  } catch (error) {
    console.error("Update location error:", error);

    return NextResponse.json(
      { success: false, message: "Something went wrong" },
      { status: 500 }
    );
  }
}

// DELETE LOCATION
export async function DELETE(
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

    if (!hasPermission(currentUser, "bilty.delete")) {
      return NextResponse.json(
        { success: false, message: "You do not have permission to delete locations" },
        { status: 403 }
      );
    }

    const { id } = await params;

    // See the identical guard in app/api/parties/[id]/route.ts.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Location not found" },
        { status: 404 }
      );
    }

    const existingLocation = await prisma.location.findUnique({
      where: { id },
    });

    if (!existingLocation) {
      return NextResponse.json(
        { success: false, message: "Location not found" },
        { status: 404 }
      );
    }

    // A Location is only ever referenced by Bilty.fromLocationId /
    // Bilty.toLocationId (both required fields, onDelete: Restrict in
    // schema.prisma) - no other model references Location. Checking
    // this ourselves, instead of letting the FK constraint throw, lets
    // us return the same "deactivate instead" guidance Party's own
    // DELETE route gives for a referenced record, rather than an
    // unexplained 500.
    const referencingBiltyCount = await prisma.bilty.count({
      where: {
        OR: [{ fromLocationId: id }, { toLocationId: id }],
      },
    });

    if (referencingBiltyCount > 0) {
      return NextResponse.json(
        {
          success: false,
          message: "This location is used by existing Bilty records and cannot be deleted. Deactivate it instead.",
        },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.location.delete({
        where: { id },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "LOCATION",
        entityType: "Location",
        entityId: id,
        documentNo: existingLocation.name,
        description: `Deleted Location ${existingLocation.name}`,
        oldValues: {
          name: existingLocation.name,
          isActive: existingLocation.isActive,
        },
        ...requestContext(request),
      });
    });

    return NextResponse.json({
      success: true,
      message: "Location deleted successfully",
    });
  } catch (error) {
    console.error("Delete location error:", error);

    return NextResponse.json(
      { success: false, message: "Unable to delete location. It may have related records." },
      { status: 500 }
    );
  }
}
