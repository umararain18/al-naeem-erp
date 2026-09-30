import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// ============================================================
// GET /api/bill/fetch-source-vehicles?sourceType=PRIVATE_PHONCH&ids=id1,id2
//
// "Fetch Details" step of the Bill form (Section 6/8/9 of the spec) -
// for the chosen source type and one or more source documents, returns
// every vehicle with ONLY the fields Bill Book actually supports
// (never the source document's full field set), pre-populated from
// the source where it exists, plus whether it is already billed
// (Section 5 - duplicate billing protection, checked here for display
// and re-checked authoritatively inside the create/edit transaction).
// ============================================================

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.create") && !hasPermission(currentUser, "bill.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const sourceType = searchParams.get("sourceType");
    const ids = (searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);

    if (sourceType !== "PRIVATE_PHONCH" && sourceType !== "SHOWROOM_PHONCH") {
      return NextResponse.json({ success: false, message: "Invalid source type" }, { status: 400 });
    }
    if (ids.length === 0) {
      return NextResponse.json({ success: true, vehicles: [] });
    }

    if (sourceType === "PRIVATE_PHONCH") {
      if (!hasPermission(currentUser, "privatePhonch.view")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      const vehicles = await prisma.privatePhonchVehicle.findMany({
        where: { phonchId: { in: ids }, phonch: { isDeleted: false } },
        orderBy: [{ phonchId: "asc" }, { lineNo: "asc" }],
        select: {
          id: true,
          phonchId: true,
          phonch: { select: { phonchNo: true } },
          vehicleName: true,
          chassisNumber: true,
          engineNumber: true,
          totalRent: true,
          deliveryCharges: true,
          clearingAgentParty: { select: { partyName: true } },
          billSourceLinks: {
            where: { bill: { isDeleted: false } },
            select: { bill: { select: { id: true, billNo: true } } },
            take: 1,
          },
        },
      });

      return NextResponse.json({
        success: true,
        vehicles: vehicles.map((v) => ({
          sourceType: "PRIVATE_PHONCH" as const,
          id: v.id,
          phonchId: v.phonchId,
          phonchNo: v.phonch.phonchNo,
          vehicleName: v.vehicleName,
          chassisNumber: v.chassisNumber,
          engineNumber: v.engineNumber,
          regdNumber: null,
          fromText: v.clearingAgentParty?.partyName || null,
          toText: null,
          rent: Number(v.totalRent),
          delivery: Number(v.deliveryCharges),
          otherExpense: 0,
          billed: v.billSourceLinks[0]
            ? { billId: v.billSourceLinks[0].bill.id, billNo: v.billSourceLinks[0].bill.billNo }
            : null,
        })),
      });
    }

    if (!hasPermission(currentUser, "phonch.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const vehicles = await prisma.phonchVehicle.findMany({
      where: { phonchId: { in: ids }, phonch: { isDeleted: false } },
      orderBy: [{ phonchId: "asc" }, { lineNo: "asc" }],
      select: {
        id: true,
        phonchId: true,
        phonch: { select: { phonchNo: true } },
        vehicleName: true,
        chassisNumber: true,
        engineNumber: true,
        deliveryCharges: true,
        otherExpenseAmount: true,
        party: { select: { partyName: true } },
        billSourceLinks: {
          where: { bill: { isDeleted: false } },
          select: { bill: { select: { id: true, billNo: true } } },
          take: 1,
        },
      },
    });

    return NextResponse.json({
      success: true,
      vehicles: vehicles.map((v) => ({
        sourceType: "SHOWROOM_PHONCH" as const,
        id: v.id,
        phonchId: v.phonchId,
        phonchNo: v.phonch.phonchNo,
        vehicleName: v.vehicleName,
        chassisNumber: v.chassisNumber,
        engineNumber: v.engineNumber,
        regdNumber: null,
        fromText: v.party?.partyName || null,
        toText: null,
        rent: 0,
        delivery: Number(v.deliveryCharges),
        otherExpense: Number(v.otherExpenseAmount),
        billed: v.billSourceLinks[0]
          ? { billId: v.billSourceLinks[0].bill.id, billNo: v.billSourceLinks[0].bill.billNo }
          : null,
      })),
    });
  } catch (error) {
    console.error("Fetch source vehicles error:", error);
    return NextResponse.json({ success: false, message: "Unable to fetch source vehicles" }, { status: 500 });
  }
}
