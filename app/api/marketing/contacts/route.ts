import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getMarketingSettings } from "@/lib/marketing/settings";
import { classifyActivitySegments, computeVipContactIds, isExcludedByDefault, type ContactForSegments } from "@/lib/marketing/segments";

// GET /api/marketing/contacts?segment=ACTIVE|SLEEPING|LOST|ONE_TIME|VIP|BROKER|PARTY|ALL&search=
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const segment = searchParams.get("segment") || "ALL";
    const search = searchParams.get("search")?.trim();

    const rows = await prisma.marketingContact.findMany({
      where: {
        mergedIntoId: null,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { phone: { contains: search } },
                { aliases: { has: search } },
              ],
            }
          : {}),
      },
      include: { linkedParty: { select: { id: true, partyName: true } } },
      orderBy: { lastDate: "desc" },
    });

    const settings = await getMarketingSettings(prisma);
    const asSegmentContacts: (ContactForSegments & { revenue: number })[] = rows.map((c) => ({
      id: c.id,
      roles: c.roles,
      lastDate: c.lastDate,
      firstDate: c.firstDate,
      biltyCount: c.biltyCount,
      revenue: Number(c.revenue),
      isBroker: c.isBroker,
      optedOut: c.optedOut,
      sourceless: c.sourceless,
    }));

    const defaultEligible = asSegmentContacts.filter((c) => !isExcludedByDefault(c));
    const vipIds = computeVipContactIds(defaultEligible, settings.vipPercentile);
    const now = new Date();

    let filteredIds: Set<string> | null = null;
    if (segment === "BROKER") {
      filteredIds = new Set(asSegmentContacts.filter((c) => !c.optedOut && !c.sourceless && c.isBroker).map((c) => c.id));
    } else if (segment === "PARTY") {
      filteredIds = new Set(rows.filter((c) => !c.optedOut && !c.sourceless && c.roles.includes("PARTY")).map((c) => c.id));
    } else if (segment === "INVALID") {
      filteredIds = new Set();
    } else if (segment !== "ALL") {
      if (segment === "VIP") {
        filteredIds = vipIds;
      } else {
        filteredIds = new Set(
          defaultEligible.filter((c) => classifyActivitySegments(c, settings, now).includes(segment as "ACTIVE" | "SLEEPING" | "LOST" | "ONE_TIME")).map((c) => c.id)
        );
      }
    } else {
      filteredIds = new Set(defaultEligible.map((c) => c.id));
    }

    const contacts = rows
      .filter((c) => filteredIds === null || filteredIds.has(c.id))
      .map((c) => ({
        id: c.id,
        phone: c.phone,
        name: c.name,
        roles: c.roles,
        aliases: c.aliases,
        city: c.city,
        route: c.route,
        firstDate: c.firstDate,
        lastDate: c.lastDate,
        biltyCount: c.biltyCount,
        revenue: Number(c.revenue),
        lastVehicle: c.lastVehicle,
        linkedParty: c.linkedParty,
        isBroker: c.isBroker,
        brokerReason: c.brokerReason,
        optedOut: c.optedOut,
        optOutReason: c.optOutReason,
        sourceless: c.sourceless,
        isVip: vipIds.has(c.id),
      }));

    return NextResponse.json({ success: true, contacts });
  } catch (error) {
    console.error("List marketing contacts error:", error);
    return NextResponse.json({ success: false, message: "Unable to load contacts" }, { status: 500 });
  }
}
