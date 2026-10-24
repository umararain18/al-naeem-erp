import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { computeChallanFinancialsBatch } from "@/lib/challan-financials";
import { getGrossCarrierRentPayableAccountId } from "@/lib/gross-accounts";
import { getChallanResponsiblePartiesBatch } from "@/lib/document-party-resolution";
import { computeChallanSettlementSummaryBatch } from "@/lib/challan-settlement-summary";
import { computeChallanPositionsBatch, type ChallanPosition } from "@/lib/challan-position";
import { SettlementPaymentError } from "@/lib/settlement-payments";
import { recognizeBiltyBookingIncome, BiltyRevenueRecognitionError } from "@/lib/bilty-revenue-recognition";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";

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

// Newest-Challan-first list ordering. challanNo is a plain String
// column (real data: "4028", "4029", ... - no fixed-width guarantee,
// so a lexicographic sort/orderBy would wrongly rank "10000" behind
// "9999" once the sequence crosses a digit boundary) - Prisma has no
// numeric-cast `orderBy`, so this compares the trailing digit run of
// each challanNo as a BigInt (safe for any length) instead. Falls
// back to a plain string compare only when a challanNo has no digits
// at all, so a genuinely non-numeric value still sorts deterministically
// instead of crashing. createdAt (desc) is the secondary tiebreak for a
// genuine tie (e.g. two Challans sharing a challanNo pattern) - never
// loadingDate (a user-editable, often-backdated business field) and
// never vehicle/updatedAt/DB default order.
function extractChallanSeq(challanNo: string): bigint | null {
  const match = challanNo.match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

function compareChallanNoDesc(a: string, b: string): number {
  const seqA = extractChallanSeq(a);
  const seqB = extractChallanSeq(b);
  if (seqA !== null && seqB !== null && seqA !== seqB) {
    return seqA > seqB ? -1 : 1;
  }
  return b.localeCompare(a);
}

// "financial" filter values - driven ENTIRELY by challan.position
// (lib/challan-position.ts), the SAME one shared calculation the
// list's summary cards and the Challan Detail page also read. There
// is no more separate, independently-derived "compact status" here -
// that used to read challan.settlementSummary.partyNet while the
// summary cards summed challan.financials.remainingReceivable/
// remainingPayable, two different calculations that could (and did)
// disagree. "DUE" no longer exists as a bucket: computeChallanPositionsBatch
// always resolves a settled Challan with a real remaining amount into
// RECEIVABLE/PAYABLE/RECEIVABLE_PAYABLE, never an unclassified
// leftover.
type FinancialFilterValue = "BEFORE_SETTLEMENT" | "AFTER_SETTLEMENT" | "RECEIVABLE" | "PAYABLE" | "RECEIVABLE_PAYABLE" | "CLEARED";
const FINANCIAL_FILTER_VALUES: FinancialFilterValue[] = ["BEFORE_SETTLEMENT", "AFTER_SETTLEMENT", "RECEIVABLE", "PAYABLE", "RECEIVABLE_PAYABLE", "CLEARED"];

function matchesFinancialFilter(item: { isSettled: boolean; position?: ChallanPosition }, filter: FinancialFilterValue): boolean {
  switch (filter) {
    case "BEFORE_SETTLEMENT":
      return !item.isSettled;
    case "AFTER_SETTLEMENT":
      return item.isSettled;
    case "RECEIVABLE":
      return item.position?.bucket === "RECEIVABLE";
    case "PAYABLE":
      return item.position?.bucket === "PAYABLE";
    case "RECEIVABLE_PAYABLE":
      return item.position?.bucket === "RECEIVABLE_PAYABLE";
    case "CLEARED":
      return item.position?.bucket === "CLEARED";
    default:
      return true;
  }
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

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status");
    const status: (typeof CHALLAN_STATUS_VALUES)[number] | null =
      statusParam && (CHALLAN_STATUS_VALUES as readonly string[]).includes(statusParam) ? (statusParam as (typeof CHALLAN_STATUS_VALUES)[number]) : null;
    const financialParam = searchParams.get("financial");
    const financial = financialParam && FINANCIAL_FILTER_VALUES.includes(financialParam as FinancialFilterValue) ? (financialParam as FinancialFilterValue) : null;

    const challans = await prisma.challan.findMany({
      where: { isDeleted: false, ...(status ? { status } : {}) },
      include: {
        transporterParty: {
          select: {
            id: true,
            partyName: true,
          },
        },
        bilties: {
          include: {
            bilty: {
              include: {
                fromLocation: { select: { id: true, name: true } },
                toLocation: { select: { id: true, name: true } },
                consignorParty: { select: { id: true, partyName: true } },
                consigneeParty: { select: { id: true, partyName: true } },
                clearingAgentParty: { select: { id: true, partyName: true } },
                agentParty: { select: { id: true, partyName: true } },
              },
            },
          },
          orderBy: { addedAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Definitive display order: Challan number sequence, numeric-aware,
    // descending - see compareChallanNoDesc() above. The Prisma
    // `orderBy` above is only a reasonable DB-level starting order;
    // this in-memory sort is what actually determines the final
    // order (this list has no pagination - it always returns every
    // non-deleted Challan - so a stable, full in-memory sort is safe
    // and correct here, never partial/page-dependent).
    challans.sort((a, b) => compareChallanNoDesc(a.challanNo, b.challanNo) || b.createdAt.getTime() - a.createdAt.getTime());

    const financialsMap = await computeChallanFinancialsBatch(
      challans.map((c) => ({
        id: c.id,
        outstandingReceivable: c.outstandingReceivable,
        outstandingPayable: c.outstandingPayable,
        biltyIds: c.bilties.map((cb) => cb.biltyId),
      }))
    );

    // Purely informational "who" behind the receivable/payable
    // totals above - does not affect the amounts themselves.
    const responsiblePartiesMap = await getChallanResponsiblePartiesBatch(
      challans.filter((c) => c.isSettled).map((c) => c.id)
    );

    // Dimensionally-separated settlement summary (same authoritative
    // source Final Settlement and the Challan Detail page use) -
    // needed here both for the list's own "Bilty Rent" column total
    // (biltyRentTotal() in app/challan/page.tsx) AND, below, to feed
    // `position`'s own party resolution (its partyNet and live
    // "Collected by"/"Paid by" payers - tiers 1-2, see lib/challan-
    // position.ts's own doc comment) - never a separate calculation.
    const settlementSummaryMap = await computeChallanSettlementSummaryBatch(challans.map((c) => c.id));

    // ONE financial position per Challan (lib/challan-position.ts) -
    // the single shared calculation the list's table, filter, and
    // summary cards, AND the Challan Detail page, all read. Built
    // from financialsMap's own amounts (above) and
    // settlementSummaryMap's own partyNet/live payers (party names,
    // tiers 1-2) plus document role fields (tier 3) - never a
    // fourth, independent calculation.
    const positionsMap = await computeChallanPositionsBatch(
      challans.map((c) => {
        const summary = settlementSummaryMap[c.id];
        return {
          id: c.id,
          isSettled: c.isSettled,
          outstandingReceivable: c.outstandingReceivable,
          outstandingPayable: c.outstandingPayable,
          biltyIds: c.bilties.map((cb) => cb.biltyId),
          partyNet: summary?.partyNet || [],
          collectedByParties: summary?.bilties.flatMap((b) => b.toPay.payers) || [],
          paidByParties: summary?.carrierRent.payers || [],
          transporterParty: c.transporterParty
            ? { partyId: c.transporterParty.id, partyName: c.transporterParty.partyName }
            : null,
          biltyParties: c.bilties.map((cb) => ({
            consignor: cb.bilty.consignorParty
              ? { partyId: cb.bilty.consignorParty.id, partyName: cb.bilty.consignorParty.partyName }
              : null,
            consignee: cb.bilty.consigneeParty
              ? { partyId: cb.bilty.consigneeParty.id, partyName: cb.bilty.consigneeParty.partyName }
              : null,
          })),
        };
      })
    );

    const itemsBeforeFinancialFilter = challans.map((c) => ({
      ...c,
      financials: financialsMap[c.id],
      responsibleParties: responsiblePartiesMap[c.id],
      settlementSummary: settlementSummaryMap[c.id],
      position: positionsMap[c.id],
    }));

    // "financial" (RECEIVABLE/PAYABLE/RECEIVABLE_PAYABLE/CLEARED/...)
    // is a computed value, not a raw column - filtered here, server-
    // side, AFTER the batch computation above, rather than in the
    // Prisma `where` clause. Real server-side filtering either way -
    // the dashboard's "Settled Challan" etc. drill-down cards never
    // rely on the client to filter an unfiltered fetch.
    const items = financial ? itemsBeforeFinancialFilter.filter((item) => matchesFinancialFilter(item, financial)) : itemsBeforeFinancialFilter;

    return NextResponse.json(
      {
        success: true,
        items,
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
    // ------------------------------------------------

    const carrierRentAmount = data.carrierRent ?? 0;
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
          transporterPartyId: data.transporterPartyId || undefined,
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
        },
      });

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
      for (const bilty of freshBilties) {
        await recognizeBiltyBookingIncome(tx, bilty, {
          entryDate: loadingDate,
          challanNo: createdChallan.challanNo,
          createdById: currentUser.userId,
        });
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
