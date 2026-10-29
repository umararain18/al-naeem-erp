import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { linkDocumentToTrip, CarrierTripError, type CarrierTripDocumentType } from "@/lib/carrier-trip";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";

const VALID_TYPES: CarrierTripDocumentType[] = ["CHALLAN", "PHONCH", "PRIVATE_PHONCH"];

// POST - link one or more documents (manual multi-select, Decision 3)
// to this Trip. Body: { documentType: "CHALLAN"|"PHONCH"|"PRIVATE_PHONCH", documentIds: string[] }.
// Each link is validated/created independently so a partial failure
// (e.g. one already linked elsewhere) never silently skips another.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId } = await params;
    const trip = await prisma.carrierTrip.findUnique({ where: { id: tripId }, select: { carrierId: true } });
    if (!trip || trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }

    const body = await request.json();
    const documentType = body.documentType as CarrierTripDocumentType;
    const documentIds: string[] = Array.isArray(body.documentIds)
      ? Array.from(new Set<string>(body.documentIds)).filter((v) => typeof v === "string")
      : [];

    if (!VALID_TYPES.includes(documentType)) {
      return NextResponse.json({ success: false, message: "Invalid document type" }, { status: 400 });
    }
    if (documentIds.length === 0) {
      return NextResponse.json({ success: false, message: "Select at least one document to link" }, { status: 400 });
    }

    const created: { documentId: string }[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        for (const documentId of documentIds) {
          const link = await linkDocumentToTrip(tx, { tripId, documentType, documentId, linkedById: currentUser.userId });
          created.push({ documentId });

          await auditCreate(tx, {
            actor: actorFromUser(currentUser),
            module: "CARRIER_TRIP",
            entityType: "CarrierTripDocument",
            entityId: link.id,
            description: `Linked ${documentType} ${documentId} to Trip`,
            ...requestContext(request),
          });
        }
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: `Linked ${created.length} document(s) to this Trip.` });
  } catch (error) {
    console.error("Link carrier trip document error:", error);
    return NextResponse.json({ success: false, message: "Unable to link document" }, { status: 500 });
  }
}
