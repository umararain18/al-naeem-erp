import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { resolveDocumentPartyAccount } from "@/lib/document-party-resolution";

// ============================================================
// GET /api/daily-posting/search-documents?q=4001
//
// Per-entry document search for Daily Posting.
//
// A single query searches BOTH Challans and Bilties by
// (partial) document number and returns clearly labelled,
// distinguishable results so a Daily Posting entry row can be
// linked to the correct document without a global selector.
// ============================================================

type DocumentSearchResult = {
  type: "CHALLAN" | "BILTY" | "PHONCH";
  id: string;
  number: string;
  subtitle: string;
  detail: string;
  resolvedParty: { accountId: string; partyName: string } | null;
};

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "accounts.create")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") || "").trim();

    if (!q) {
      return NextResponse.json({ success: true, results: [] });
    }

    const canViewChallans = hasPermission(currentUser, "challan.view");
    const canViewBilties = hasPermission(currentUser, "bilty.view");
    const canViewPhonch = hasPermission(currentUser, "phonch.view");

    const results: DocumentSearchResult[] = [];

    if (canViewChallans) {
      const challans = await prisma.challan.findMany({
        where: {
          isDeleted: false,
          challanNo: { contains: q, mode: "insensitive" },
        },
        select: {
          id: true,
          challanNo: true,
          transporterParty: { select: { partyName: true } },
          bilties: {
            take: 1,
            orderBy: { addedAt: "asc" },
            select: {
              bilty: {
                select: {
                  fromLocation: { select: { name: true } },
                  toLocation: { select: { name: true } },
                },
              },
            },
          },
          _count: { select: { bilties: true } },
        },
        orderBy: { loadingDate: "desc" },
        take: 8,
      });

      for (const challan of challans) {
        const firstBilty = challan.bilties[0]?.bilty;
        const route = firstBilty
          ? `${firstBilty.fromLocation.name} → ${firstBilty.toLocation.name}`
          : "No bilties linked";

        const transporter = challan.transporterParty?.partyName || "—";
        const resolvedParty = await resolveDocumentPartyAccount("CHALLAN", challan.id);

        results.push({
          type: "CHALLAN",
          id: challan.id,
          number: challan.challanNo,
          subtitle: route,
          detail: `Transporter: ${transporter} • ${challan._count.bilties} Bilty(ies)`,
          resolvedParty,
        });
      }
    }

    if (canViewBilties) {
      const bilties = await prisma.bilty.findMany({
        where: {
          isDeleted: false,
          biltyNo: { contains: q, mode: "insensitive" },
        },
        select: {
          id: true,
          biltyNo: true,
          consigneeName: true,
          consigneeParty: { select: { partyName: true } },
          fromLocation: { select: { name: true } },
          toLocation: { select: { name: true } },
          challanBilties: {
            take: 1,
            orderBy: { addedAt: "desc" },
            select: {
              challan: { select: { challanNo: true, isDeleted: true } },
            },
          },
        },
        orderBy: { date: "desc" },
        take: 8,
      });

      for (const bilty of bilties) {
        const route = `${bilty.fromLocation.name} → ${bilty.toLocation.name}`;
        const customer = bilty.consigneeParty?.partyName || bilty.consigneeName;
        const parentChallan = bilty.challanBilties.find(
          (cb) => cb.challan && !cb.challan.isDeleted
        )?.challan;
        const resolvedParty = await resolveDocumentPartyAccount("BILTY", bilty.id);

        results.push({
          type: "BILTY",
          id: bilty.id,
          number: bilty.biltyNo,
          subtitle: route,
          detail: parentChallan
            ? `Customer: ${customer} • Challan: ${parentChallan.challanNo}`
            : `Customer: ${customer}`,
          resolvedParty,
        });
      }
    }

    if (canViewPhonch) {
      const phonches = await prisma.phonch.findMany({
        where: {
          isDeleted: false,
          phonchNo: { contains: q, mode: "insensitive" },
        },
        select: {
          id: true,
          phonchNo: true,
          carrierNumber: true,
          transporterParty: { select: { partyName: true } },
          _count: { select: { vehicles: true } },
        },
        orderBy: { date: "desc" },
        take: 8,
      });

      for (const phonch of phonches) {
        const resolvedParty = await resolveDocumentPartyAccount("PHONCH", phonch.id);

        results.push({
          type: "PHONCH",
          id: phonch.id,
          number: phonch.phonchNo,
          subtitle: `Transporter: ${phonch.transporterParty.partyName}`,
          detail: `${phonch._count.vehicles} Vehicle(s)${phonch.carrierNumber ? ` • Carrier: ${phonch.carrierNumber}` : ""}`,
          resolvedParty,
        });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error("Search documents error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to search documents" },
      { status: 500 }
    );
  }
}
