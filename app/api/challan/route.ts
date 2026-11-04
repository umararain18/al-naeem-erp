import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getGrossCarrierRentPayableAccountId } from "@/lib/gross-accounts";
import { SettlementPaymentError } from "@/lib/settlement-payments";
import { recognizeBiltyBookingIncome, BiltyRevenueRecognitionError } from "@/lib/bilty-revenue-recognition";
import { autoLinkOwnCarrierChallan } from "@/lib/carrier-trip";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";
import { challanListSearchOr } from "@/lib/search-helpers";
import { computeFilteredChallanPositions, FINANCIAL_FILTER_VALUES, type FinancialFilterValue } from "@/lib/challan-list-query";

// Re-check status codes for the in-transaction Bilty-availability
// re-validation below (POST) - kept separate from the pre-transaction
// check's own inline NextResponse statuses since these fire from
// inside the Serializable transaction and must be mapped after it
// resolves. See the comment at that re-check for why it exists.
function biltyRecheckStatus(code: string): number {
  switch (code) {
    case "BILTIES_NOT_FOUND":
      return 404;
    case "BILTY_ALREADY_ASSIGNED":
      return 409;
    default:
      return 400;
  }
}

const createChallanSchema = z.object({
  challanNo: z
    .string()
    .trim()
    .min(1, "Challan number is required"),

  loadingDate: z
    .string()
    .min(1, "Loading date is required"),

  transporterPartyId: z
    .string()
    .optional()
    .or(z.literal("")),

  // Mutually exclusive with transporterPartyId - see Challan.
  // ownCarrierId's own schema doc comment for the full "Own Carrier
  // Dispatch" accounting rationale this triggers below.
  ownCarrierId: z
    .string()
    .optional()
    .or(z.literal("")),

  driverName: z
    .string()
    .optional()
    .or(z.literal("")),

  driverPhone: z
    .string()
    .optional()
    .or(z.literal("")),

  carrierNumber: z
    .string()
    .optional()
    .or(z.literal("")),

  carrierRent: z
    .number()
    .min(0, "Carrier rent cannot be negative")
    .optional(),

  remarks: z
    .string()
    .optional()
    .or(z.literal("")),

  biltyIds: z
    .array(z.string())
    .min(1, "At least one bilty is required"),
});

const CHALLAN_STATUS_VALUES = ["IN_TRANSIT", "DELIVERED", "CANCELLED"] as const;

// ------------------------------------------------------------
// PHASE TIMING - diagnostic only, always on (negligible overhead:
// Date.now() + one console.log per request). Added to measure where
// GET /api/challan's time actually goes before/after the pagination +
// N+1 fixes in this same change - see docs/PERFORMANCE_CHALLAN_LIST.md
// for the before/after numbers this produced. Kept in place rather
// than removed after the fix, so a future regression shows up in
// plain server logs (grep "[challan-list-timing]") without needing to
// re-instrument.
// ------------------------------------------------------------
function createPhaseTimer() {
  const phases: { name: string; ms: number }[] = [];
  let last = Date.now();
  return {
    mark(name: string) {
      const now = Date.now();
      phases.push({ name, ms: now - last });
      last = now;
    },
    report(label: string, extra?: Record<string, number>) {
      const total = phases.reduce((s, p) => s + p.ms, 0);
      const extraStr = extra ? " " + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ") : "";
      console.log(
        `[challan-list-timing] ${label} total=${total}ms${extraStr} ` + phases.map((p) => `${p.name}=${p.ms}ms`).join(" ")
      );
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "challan.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const timer = createPhaseTimer();

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status");
    const status: (typeof CHALLAN_STATUS_VALUES)[number] | null =
      statusParam && (CHALLAN_STATUS_VALUES as readonly string[]).includes(statusParam) ? (statusParam as (typeof CHALLAN_STATUS_VALUES)[number]) : null;
    const financialParam = searchParams.get("financial");
    const financial = financialParam && FINANCIAL_FILTER_VALUES.includes(financialParam as FinancialFilterValue) ? (financialParam as FinancialFilterValue) : null;
    const search = searchParams.get("search")?.trim() || "";
    const dateFrom = searchParams.get("dateFrom") || "";
    const dateTo = searchParams.get("dateTo") || "";

    // Same page/pageSize validation shape as app/api/bilty/route.ts's
    // own P2-3 pagination - a syntactically valid but astronomically
    // large `page` must never reach a `skip` calculation (overflows
    // there and throws).
    const rawPage = searchParams.get("page");
    const parsedPage = rawPage ? parseInt(rawPage, 10) : 1;
    if (rawPage && !Number.isNaN(parsedPage) && !Number.isSafeInteger(parsedPage)) {
      return NextResponse.json({ success: false, message: "Invalid page number" }, { status: 400 });
    }
    const page = Math.max(1, parsedPage || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "50", 10) || 50));

    const where: Prisma.ChallanWhereInput = {
      isDeleted: false,
      ...(status ? { status } : {}),
      ...(search ? { OR: challanListSearchOr(search) } : {}),
      ...(dateFrom || dateTo
        ? {
            loadingDate: {
              // Mirrors the exact semantics the list page's own
              // (now-removed) client-side date filter used - dateFrom
              // inclusive, dateTo EXCLUSIVE of that calendar date -
              // never changed here, only moved server-side.
              ...(dateFrom ? { gte: new Date(`${dateFrom}T00:00:00`) } : {}),
              ...(dateTo ? { lt: new Date(`${dateTo}T00:00:00`) } : {}),
            },
          }
        : {}),
    };

    // LIGHTWEIGHT pass across every Challan matching the plain-column
    // filters above - computes financial position for all of them
    // (now cheap - see lib/challan-settlement-summary.ts's own doc
    // comment on the N+1 fix this relies on), applies the "financial"
    // filter (a COMPUTED value, never a column, so it can't live in
    // `where` itself), and returns the definitive ordered id list this
    // page is sliced from - never a second, independently-filtered
    // id list that could disagree with it.
    const filtered = await computeFilteredChallanPositions(where, financial);
    timer.mark("filteredPositions");

    const total = filtered.orderedIds.length;
    const pageIds = filtered.orderedIds.slice((page - 1) * pageSize, page * pageSize);

    // PAGE-SCOPED HEAVY FETCH - the full bilty/location/clearing-
    // agent/agent-party display shape, fetched ONLY for this page's
    // ids (never for every Challan matching the filters, which would
    // put list-page cost back on the whole table as it grows).
    const pageChallans = pageIds.length > 0
      ? await prisma.challan.findMany({
          where: { id: { in: pageIds } },
          include: {
            transporterParty: { select: { id: true, partyName: true } },
            ownCarrier: { select: { id: true, carrierNumber: true } },
            bilties: {
              include: {
                bilty: {
                  include: {
                    fromLocation: { select: { id: true, name: true } },
                    toLocation: { select: { id: true, name: true } },
                    consignorParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
                    consigneeParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
                    clearingAgentParty: { select: { id: true, partyName: true } },
                    agentParty: { select: { id: true, partyName: true } },
                  },
                },
              },
              orderBy: { addedAt: "asc" },
            },
          },
        })
      : [];
    timer.mark("pageHeavyFetch");

    const pageChallanById = new Map(pageChallans.map((c) => [c.id, c]));
    const items = pageIds
      .map((id) => pageChallanById.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({
        ...c,
        financials: filtered.financialsMap[c.id],
        responsibleParties: filtered.responsiblePartiesMap[c.id],
        settlementSummary: filtered.settlementSummaryMap[c.id],
        position: filtered.positionsMap[c.id],
        incomePending: filtered.incomePendingSet.has(c.id),
      }));
    timer.mark("assemble");
    timer.report("GET /api/challan", { total, pageSize, itemCount: items.length });

    return NextResponse.json(
      {
        success: true,
        items,
        pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
        // Challan Bin now also resets every linked Bilty's status and
        // reverses Booking Income (see the DELETE handler in
        // app/api/challan/[id]/route.ts) - SUPER_ADMIN only, matching
        // what that route itself enforces, regardless of the (now
        // otherwise-vestigial, for Challan) "challan.bin" permission
        // MANAGER still holds. Lets the list page hide the Bin button
        // for a role the backend would reject anyway, the same
        // capabilities-flag pattern app/api/employees/route.ts already
        // uses.
        capabilities: {
          canBin: currentUser.role === "SUPER_ADMIN",
        },
      },
      // Explicit no-store, on top of the client fetch's own
      // { cache: "no-store" } (app/challan/page.tsx) - defense in
      // depth against any intermediary (CDN/reverse proxy) that might
      // otherwise cache this exact, filter-less GET URL and serve a
      // pre-restore/pre-delete snapshot.
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" } }
    );
  } catch (error) {
    console.error("List challans error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load challans" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "challan.create")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const result = createChallanSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid challan data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    const loadingDate = new Date(`${data.loadingDate}T00:00:00`);
    if (Number.isNaN(loadingDate.getTime())) {
      return NextResponse.json(
        { success: false, message: "Invalid loading date" },
        { status: 400 }
      );
    }

    const ownCarrierId = data.ownCarrierId || null;

    if (ownCarrierId && data.transporterPartyId) {
      return NextResponse.json(
        { success: false, message: "Select either a Transporter or an Own Carrier, not both" },
        { status: 400 }
      );
    }

    if (ownCarrierId) {
      const ownCarrier = await prisma.ownCarrier.findUnique({ where: { id: ownCarrierId }, select: { isDeleted: true } });
      if (!ownCarrier || ownCarrier.isDeleted) {
        return NextResponse.json(
          { success: false, message: "Selected Own Carrier was not found" },
          { status: 400 }
        );
      }
    }

    // challanNo is no longer a plain DB-level @unique (see prisma/
    // schema.prisma's own comment) - a Bin'd Challan's number is
    // reusable, so this check (and the one inside the transaction
    // below) is scoped to ACTIVE Challans only, via findFirst.
    const existingChallan = await prisma.challan.findFirst({
      where: { challanNo: data.challanNo, isDeleted: false },
    });

    if (existingChallan) {
      return NextResponse.json(
        { success: false, message: "Challan number already exists" },
        { status: 409 }
      );
    }

    const bilties = await prisma.bilty.findMany({
      where: {
        id: { in: data.biltyIds },
      },
      include: {
        challanBilties: {
          include: {
            challan: true,
          },
        },
      },
    });

    if (bilties.length !== data.biltyIds.length) {
      return NextResponse.json(
        { success: false, message: "One or more bilties not found" },
        { status: 404 }
      );
    }

    for (const bilty of bilties) {
      if (bilty.isDeleted) {
        return NextResponse.json(
          { success: false, message: `Bilty ${bilty.biltyNo} is deleted` },
          { status: 400 }
        );
      }

      if (bilty.status !== "PENDING") {
        return NextResponse.json(
          { success: false, message: `Bilty ${bilty.biltyNo} is not pending` },
          { status: 400 }
        );
      }

      const activeChallan = bilty.challanBilties.find(
        (cb) => cb.challan && !cb.challan.isDeleted
      );

      if (activeChallan) {
        return NextResponse.json(
          {
            success: false,
            message: `Bilty ${bilty.biltyNo} is already assigned to challan ${activeChallan.challan.challanNo}`,
          },
          { status: 409 }
        );
      }
    }

    // ------------------------------------------------
    // CARRIER RENT ACCOUNTING
    //
    // Full Carrier Rent expense is recognized NOW, at dispatch
    // time - not later at Settlement. The responsible PARTY is
    // not yet known, so the offsetting side is a gross clearing
    // account that Settlement will later reclassify into the
    // real party. See lib/gross-accounts.ts.
    //
    // NEVER for an Own Carrier dispatch (ownCarrierId set) - that
    // Carrier Rent instead lives on CarrierTripDocument.
    // carrierRentAmount, entered manually per Trip-linked-Challan
    // (see Challan.ownCarrierId's own schema doc comment) - forced to
    // 0 here regardless of what was submitted, never trusting the
    // client to have left it blank.
    // ------------------------------------------------

    const carrierRentAmount = ownCarrierId ? 0 : data.carrierRent ?? 0;
    let carrierRentExpenseAccountId: string | null = null;

    if (carrierRentAmount > 0) {
      const carrierRentAccount = await prisma.account.findFirst({
        where: { category: "CARRIER_RENT", isActive: true },
        select: { id: true },
      });

      if (!carrierRentAccount) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Required account is not configured. Please configure a CARRIER_RENT account.",
          },
          { status: 400 }
        );
      }

      carrierRentExpenseAccountId = carrierRentAccount.id;
    }

    let challan;
    try {
      challan = await prisma.$transaction(async (tx) => {
      // Re-check every Bilty's availability INSIDE this SERIALIZABLE
      // transaction, on the same snapshot the writes below will use.
      // The pre-check above (lines ~201-249) only protects against a
      // Bilty that was already unavailable at the time of THAT read -
      // it cannot protect against a second, truly concurrent
      // POST /api/challan request racing this one for the SAME Bilty.
      // Under SERIALIZABLE, if both transactions read here before
      // either commits, Postgres aborts one with a serialization
      // failure (caught below as P2034 -> 409); if one has already
      // committed by the time this one reads, this explicit re-check
      // catches it directly instead of silently double-dispatching
      // the same Bilty onto two active Challans.
      const freshBilties = await tx.bilty.findMany({
        where: { id: { in: data.biltyIds } },
        include: {
          challanBilties: {
            include: {
              challan: true,
            },
          },
        },
      });

      if (freshBilties.length !== data.biltyIds.length) {
        throw new SettlementPaymentError("BILTIES_NOT_FOUND", "One or more bilties not found");
      }

      for (const bilty of freshBilties) {
        if (bilty.isDeleted) {
          throw new SettlementPaymentError("BILTY_DELETED", `Bilty ${bilty.biltyNo} is deleted`);
        }

        if (bilty.status !== "PENDING") {
          throw new SettlementPaymentError("BILTY_NOT_PENDING", `Bilty ${bilty.biltyNo} is not pending`);
        }

        const activeChallan = bilty.challanBilties.find(
          (cb) => cb.challan && !cb.challan.isDeleted
        );

        if (activeChallan) {
          throw new SettlementPaymentError(
            "BILTY_ALREADY_ASSIGNED",
            `Bilty ${bilty.biltyNo} is already assigned to challan ${activeChallan.challan.challanNo}`
          );
        }
      }

      const createdChallan = await tx.challan.create({
        data: {
          challanNo: data.challanNo,
          loadingDate,
          transporterPartyId: ownCarrierId ? undefined : data.transporterPartyId || undefined,
          ownCarrierId: ownCarrierId || undefined,
          driverName: data.driverName || undefined,
          driverPhone: data.driverPhone || undefined,
          carrierNumber: data.carrierNumber || undefined,
          carrierRent: carrierRentAmount,
          remarks: data.remarks || undefined,
          createdById: currentUser.userId,
        },
        include: {
          transporterParty: {
            select: {
              id: true,
              partyName: true,
            },
          },
          ownCarrier: {
            select: {
              id: true,
              carrierNumber: true,
            },
          },
        },
      });

      // AUTO-LINK - an own-carrier Challan is auto-linked to its
      // carrier's latest OPEN Trip (never a new one created for it) -
      // a convenience only, never failing Challan creation itself if
      // there is no open Trip or the link somehow can't be made (see
      // autoLinkOwnCarrierChallan's own doc comment). Carrier Rent on
      // the new link is left at its empty default for the user to
      // enter on the Trip slip.
      if (ownCarrierId) {
        await autoLinkOwnCarrierChallan(tx, { challanId: createdChallan.id, ownCarrierId, linkedById: currentUser.userId });
      }

      for (const biltyId of data.biltyIds) {
        await tx.challanBilty.create({
          data: {
            challanId: createdChallan.id,
            biltyId,
          },
        });
      }

      await tx.bilty.updateMany({
        where: {
          id: { in: data.biltyIds },
        },
        data: {
          status: "IN_TRANSIT",
        },
      });

      // REVENUE RECOGNITION - each dispatched Bilty's own rent, sitting
      // in Unearned Revenue since booking, is reclassified into real
      // Booking Income now - exactly once per Bilty, for exactly the
      // amount originally recognized (see
      // lib/bilty-revenue-recognition.ts). freshBilties (re-fetched
      // above, inside this transaction) is used rather than the
      // pre-transaction `bilties` so this reads the SAME race-checked
      // `total` the PENDING/already-assigned re-validation above just
      // confirmed.
      //
      // SKIPPED ENTIRELY for an Own Carrier dispatch - each Bilty's
      // rent deliberately stays in Unearned Revenue until the linking
      // Carrier Trip is CLOSED (see lib/carrier-trip.ts's
      // recognizeCarrierTripChallanIncome and Challan.ownCarrierId's
      // own schema doc comment).
      if (!ownCarrierId) {
        for (const bilty of freshBilties) {
          await recognizeBiltyBookingIncome(tx, bilty, {
            entryDate: loadingDate,
            challanNo: createdChallan.challanNo,
            createdById: currentUser.userId,
          });
        }
      }

      if (carrierRentAmount > 0 && carrierRentExpenseAccountId) {
        const grossCarrierRentPayableId = await getGrossCarrierRentPayableAccountId(tx);

        await tx.journalEntry.create({
          data: {
            entryDate: loadingDate,
            referenceType: "CHALLAN_DISPATCH",
            referenceId: createdChallan.id,
            description: `Challan Dispatch - ${createdChallan.challanNo} - Carrier Rent`,
            createdById: currentUser.userId,
            lines: {
              create: [
                {
                  accountId: carrierRentExpenseAccountId,
                  debit: carrierRentAmount,
                  credit: 0,
                  description: `Dispatch - ${createdChallan.challanNo} - Carrier Rent`,
                  sourceType: "CHALLAN",
                  sourceId: createdChallan.id,
                  sourceNumber: createdChallan.challanNo,
                },
                {
                  accountId: grossCarrierRentPayableId,
                  debit: 0,
                  credit: carrierRentAmount,
                  description: `Dispatch - ${createdChallan.challanNo} - Carrier Rent`,
                  sourceType: "CHALLAN",
                  sourceId: createdChallan.id,
                  sourceNumber: createdChallan.challanNo,
                },
              ],
            },
          },
        });
      }

      await auditCreate(tx, {
        actor: actorFromUser(currentUser),
        module: "CHALLAN",
        entityType: "Challan",
        entityId: createdChallan.id,
        documentNo: createdChallan.challanNo,
        description: `Created Challan ${createdChallan.challanNo} (${data.biltyIds.length} Bilties, Carrier Rent Rs. ${carrierRentAmount.toLocaleString()})`,
        newValues: {
          challanNo: createdChallan.challanNo,
          transporterPartyId: data.transporterPartyId || null,
          carrierRent: carrierRentAmount,
          biltyIds: data.biltyIds,
        },
        ...requestContext(request),
      });

      return createdChallan;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (txError) {
      if (txError instanceof SettlementPaymentError) {
        return NextResponse.json(
          { success: false, message: txError.message },
          { status: biltyRecheckStatus(txError.code) }
        );
      }
      if (txError instanceof BiltyRevenueRecognitionError) {
        return NextResponse.json(
          { success: false, message: txError.message },
          { status: 400 }
        );
      }
      if (txError instanceof Prisma.PrismaClientKnownRequestError && txError.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Challan could not be created due to a concurrent change. Please retry." },
          { status: 409 }
        );
      }
      throw txError;
    }

    return NextResponse.json({
      success: true,
      message: "Challan created successfully",
      challan,
    });
  } catch (error) {
    console.error("Create challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create challan" },
      { status: 500 }
    );
  }
}
