import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// ============================================================
// GET /api/audit-log
//
// READ-ONLY list surface for the immutable AuditLog table (see model
// AuditLog's own doc comment in prisma/schema.prisma, and
// lib/audit-log.ts - the ONE place rows are ever written). There is
// deliberately NO POST/PATCH/DELETE here or anywhere else for this
// model - audit records are append-only, and the only way a row is
// ever created is from inside the business action it describes.
//
// Gated by audit.view (SUPER_ADMIN only, per lib/permissions.ts) -
// this table can reveal IP addresses, every user's login history, and
// cross-module financial detail, so it is deliberately NOT extended
// to MANAGER/VIEWER by default (Section 12 of the audit log spec: "Do
// not automatically give it to every role").
// ============================================================

const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "audit.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    // See app/api/bilty/route.ts's identical guard (same unsafe pattern
    // found by a repo-wide search) - a syntactically valid but
    // astronomically large `page` must never reach Prisma's `skip`
    // calculation. A garbage/non-numeric value still falls back to page
    // 1 exactly as before.
    const rawPage = searchParams.get("page");
    const parsedPage = rawPage ? Number(rawPage) : 1;
    if (rawPage && !Number.isNaN(parsedPage) && !Number.isSafeInteger(parsedPage)) {
      return NextResponse.json(
        { success: false, message: "Invalid page number" },
        { status: 400 }
      );
    }
    const page = Math.max(1, parsedPage || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(searchParams.get("pageSize")) || 25));

    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");
    const userId = searchParams.get("userId");
    const action = searchParams.get("action");
    const module = searchParams.get("module");
    const entityType = searchParams.get("entityType");
    const search = searchParams.get("search")?.trim();

    const where: Prisma.AuditLogWhereInput = {
      ...(dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom ? { gte: new Date(`${dateFrom}T00:00:00`) } : {}),
              ...(dateTo ? { lte: new Date(`${dateTo}T23:59:59.999`) } : {}),
            },
          }
        : {}),
      ...(userId ? { userId } : {}),
      ...(action ? { action: action as Prisma.EnumAuditActionFilter["equals"] } : {}),
      ...(module ? { module } : {}),
      ...(entityType ? { entityType } : {}),
      ...(search
        ? {
            OR: [
              { description: { contains: search, mode: "insensitive" } },
              { documentNo: { contains: search, mode: "insensitive" } },
              { entityType: { contains: search, mode: "insensitive" } },
              { userNameSnapshot: { contains: search, mode: "insensitive" } },
              { module: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({
      success: true,
      items: rows,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    console.error("List audit log error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Audit Log" }, { status: 500 });
  }
}
