import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { parseISODateStart } from "@/lib/date-range";

// ============================================================
// NOTEBOOK - shared daily whiteboard (see prisma/schema.prisma's own
// module doc comment). One row per calendar date, lazily created on
// first GET of that date - never pre-seeded. NOT an accounting
// document: no JournalEntry, no Party/Account, no Bin lifecycle, no
// Serializable transaction - every logged-in user with notebook.edit
// shares and overwrites the SAME row for a given date (last write
// wins), exactly like a real shared whiteboard.
// ============================================================

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const vehicleSchema = z.object({
  vehicleNumber: z.string().trim().min(1, "Vehicle number is required"),
  status: z.enum(["AVAILABLE", "LOADING", "DISPATCHED"]),
  note: z.string().trim().optional(),
});

const updateSchema = z.object({
  notes: z.string().optional(),
  vehicles: z.array(vehicleSchema).max(200, "Too many vehicle rows"),
});

function parseDateParam(date: string): Date | null {
  if (!DATE_PATTERN.test(date)) return null;
  const parsed = parseISODateStart(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "notebook.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { date: dateParam } = await params;
    const date = parseDateParam(dateParam);
    if (!date) {
      return NextResponse.json({ success: false, message: "Invalid date" }, { status: 400 });
    }

    const notebook = await prisma.notebook.findUnique({
      where: { date },
      include: {
        vehicles: { orderBy: { lineNo: "asc" } },
        updatedBy: { select: { id: true, fullName: true, username: true } },
      },
    });

    if (notebook) {
      return NextResponse.json({
        success: true,
        notebook,
        capabilities: { canEdit: hasPermission(currentUser, "notebook.edit") },
      });
    }

    // No entry yet for this date - returned as an empty shape without
    // writing anything (a row is only ever created on the first
    // PATCH, never just by viewing an empty day).
    return NextResponse.json({
      success: true,
      notebook: { id: null, date, notes: "", vehicles: [], updatedBy: null, updatedAt: null },
      capabilities: { canEdit: hasPermission(currentUser, "notebook.edit") },
    });
  } catch (error) {
    console.error("Get notebook error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Notebook" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "notebook.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { date: dateParam } = await params;
    const date = parseDateParam(dateParam);
    if (!date) {
      return NextResponse.json({ success: false, message: "Invalid date" }, { status: 400 });
    }

    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid Notebook data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    const notebook = await prisma.$transaction(async (tx) => {
      const upserted = await tx.notebook.upsert({
        where: { date },
        create: { date, notes: data.notes || null, updatedById: currentUser.userId },
        update: { notes: data.notes || null, updatedById: currentUser.userId },
      });

      // Replace-on-edit, same pattern every other module's own
      // vehicle-row list edit uses - this is a casual whiteboard, not
      // a financial record, so there is no cross-document link to
      // protect (no BillSourceLink-style onDelete: Restrict here).
      await tx.notebookVehicle.deleteMany({ where: { notebookId: upserted.id } });
      if (data.vehicles.length > 0) {
        await tx.notebookVehicle.createMany({
          data: data.vehicles.map((v, index) => ({
            notebookId: upserted.id,
            lineNo: index + 1,
            vehicleNumber: v.vehicleNumber,
            status: v.status,
            note: v.note || null,
          })),
        });
      }

      return tx.notebook.findUniqueOrThrow({
        where: { id: upserted.id },
        include: {
          vehicles: { orderBy: { lineNo: "asc" } },
          updatedBy: { select: { id: true, fullName: true, username: true } },
        },
      });
    });

    return NextResponse.json({ success: true, message: "Notebook saved.", notebook });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json({ success: false, message: "This Notebook was modified concurrently. Please retry." }, { status: 409 });
    }
    console.error("Update notebook error:", error);
    return NextResponse.json({ success: false, message: "Unable to save Notebook" }, { status: 500 });
  }
}
