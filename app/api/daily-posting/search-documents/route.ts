import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  getChallanEligibleParties,
  getPrivatePhonchEligibleParties,
  resolveDocumentPartyAccount,
} from "@/lib/document-party-resolution";

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
  type: "CHALLAN" | "BILTY" | "PHONCH" | "PRIVATE_PHONCH";
  id: string;
  number: string;
  subtitle: string;
  detail: string;
  resolvedParty: { accountId: string; partyName: string } | null;
  // CHALLAN and PRIVATE_PHONCH only, and only once `direction` is
  // known: every party with an outstanding eligible position for
  // that direction, per the LOCKED rule - so the UI can offer an
  // explicit selector when there is more than one (resolvedParty
  // above is already the auto-selected single case). Undefined for
  // BILTY/PHONCH and when direction is unknown.
  eligibleParties?: { accountId: string; partyName: string; amount: number }[];
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
    // The line's DEBIT/CREDIT direction, forwarded so a CHALLAN
    // result's resolvedParty reflects the LOCKED Receivable/Payable
    // rule (see resolveChallanParty() in lib/document-party-resolution.ts).
    // Absent/invalid = undefined, exactly as if not yet chosen.
    const directionParam = searchParams.get("direction");
    const direction: "DEBIT" | "CREDIT" | undefined =
      directionParam === "DEBIT" || directionParam === "CREDIT" ? directionParam : undefined;

    if (!q) {
      return NextResponse.json({ success: true, results: [] });
    }

    const canViewChallans = hasPermission(currentUser, "challan.view");
    const canViewBilties = hasPermission(currentUser, "bilty.view");
    const canViewPhonch = hasPermission(currentUser, "phonch.view");
    const canViewPrivatePhonch = hasPermission(currentUser, "privatePhonch.view");

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
        const resolvedParty = await resolveDocumentPartyAccount("CHALLAN", challan.id, direction);

        // Informational only (never itself the resolution decision -
        // that stays resolveDocumentPartyAccount()'s alone, above) so
        // the UI can offer an explicit selector when more than one
        // party is eligible for the current direction. Reads the SAME
        // source resolveDocumentPartyAccount() itself consults, so
        // this list can never disagree with the actual resolution.
        let eligibleParties: DocumentSearchResult["eligibleParties"];
        if (direction) {
          eligibleParties = await getChallanEligibleParties(challan.id, direction);
        }

        results.push({
          type: "CHALLAN",
          id: challan.id,
          number: challan.challanNo,
          subtitle: route,
          detail: `Transporter: ${transporter} • ${challan._count.bilties} Bilty(ies)`,
          resolvedParty,
          eligibleParties,
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
        const resolvedParty = await resolveDocumentPartyAccount("BILTY", bilty.id, direction);

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

    if (canViewPrivatePhonch) {
      const privatePhonches = await prisma.privatePhonch.findMany({
        where: {
          isDeleted: false,
          phonchNo: { contains: q, mode: "insensitive" },
        },
        select: {
          id: true,
          phonchNo: true,
          transporterParty: { select: { partyName: true } },
          _count: { select: { vehicles: true } },
        },
        orderBy: { date: "desc" },
        take: 8,
      });

      for (const privatePhonch of privatePhonches) {
        const resolvedParty = await resolveDocumentPartyAccount("PRIVATE_PHONCH", privatePhonch.id, direction);

        // Same informational-only role as CHALLAN's own eligibleParties
        // above - lets the UI offer an explicit selector when more
        // than one payable/deposit party is eligible for the current
        // direction (see getPrivatePhonchEligibleParties()'s own doc
        // comment in lib/document-party-resolution.ts).
        let eligibleParties: DocumentSearchResult["eligibleParties"];
        if (direction) {
          eligibleParties = await getPrivatePhonchEligibleParties(privatePhonch.id, direction);
        }

        results.push({
          type: "PRIVATE_PHONCH",
          id: privatePhonch.id,
          number: privatePhonch.phonchNo,
          subtitle: `Transporter: ${privatePhonch.transporterParty.partyName}`,
          detail: `${privatePhonch._count.vehicles} Vehicle(s)`,
          resolvedParty,
          eligibleParties,
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
