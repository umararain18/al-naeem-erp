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
import { SettlementPaymentError } from "@/lib/settlement-payments";
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

// Mirrors app/challan/page.tsx's own compactStatus()/matchesFinancialFilter()
// exactly (same field names, same derivation) - a single source of truth so
// the dashboard's "Active/Delivered/Settled Challan" drill-down cards get a
// REAL server-side filtered result, never a trust-the-client filter. This
// value is computed (not a raw column), so it is applied by filtering the
// already-batch-computed `items` array below, after settlementSummary is
// available - never pushed into the Prisma `where` clause directly.
type CompactStatus = "BEFORE SETTLEMENT" | "RECEIVABLE" | "PAYABLE" | "RECEIVABLE + PAYABLE" | "DUE" | "CLEARED";

function totalDueFromSummary(item: { settlementSummary?: { bilties: { toPay: { remaining: number } }[]; carrierRent: { remaining: number } } }): number {
  const summary = item.settlementSummary;
  if (!summary) return 0;
  const toPayRemaining = summary.bilties.reduce((s, b) => s + b.toPay.remaining, 0);
  return toPayRemaining + summary.carrierRent.remaining;
}

function compactStatus(item: {
  isSettled: boolean;
  settlementSummary?: { partyNet: { net: number }[]; bilties: { toPay: { remaining: number } }[]; carrierRent: { remaining: number } };
}): CompactStatus {
  if (!item.isSettled) return "BEFORE SETTLEMENT";

  const partyNet = item.settlementSummary?.partyNet || [];
  const hasReceivable = partyNet.some((p) => p.net > 0);
  const hasPayable = partyNet.some((p) => p.net < 0);

  if (hasReceivable && hasPayable) return "RECEIVABLE + PAYABLE";
  if (hasReceivable) return "RECEIVABLE";
  if (hasPayable) return "PAYABLE";

  return totalDueFromSummary(item) > 0.009 ? "DUE" : "CLEARED";
}

type FinancialFilterValue = "BEFORE_SETTLEMENT" | "AFTER_SETTLEMENT" | "RECEIVABLE" | "PAYABLE" | "RECEIVABLE_PAYABLE" | "DUE" | "CLEARED";
const FINANCIAL_FILTER_VALUES: FinancialFilterValue[] = ["BEFORE_SETTLEMENT", "AFTER_SETTLEMENT", "RECEIVABLE", "PAYABLE", "RECEIVABLE_PAYABLE", "DUE", "CLEARED"];

function matchesFinancialFilter(item: { isSettled: boolean; settlementSummary?: { partyNet: { net: number }[]; bilties: { toPay: { remaining: number } }[]; carrierRent: { remaining: number } } }, filter: FinancialFilterValue): boolean {
  switch (filter) {
    case "BEFORE_SETTLEMENT":
      return !item.isSettled;
    case "AFTER_SETTLEMENT":
      return item.isSettled;
    case "RECEIVABLE":
      return compactStatus(item) === "RECEIVABLE";
    case "PAYABLE":
      return compactStatus(item) === "PAYABLE";
    case "RECEIVABLE_PAYABLE":
      return compactStatus(item) === "RECEIVABLE + PAYABLE";
    case "DUE":
      return compactStatus(item) === "DUE";
    case "CLEARED":
      return compactStatus(item) === "CLEARED";
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
    // batched across every Challan in ONE pass (see
    // lib/challan-settlement-summary.ts). `financials`/
    // `responsibleParties` above are left unchanged for now; only
    // what the list UI displays for Financial Summary changes.
    const settlementSummaryMap = await computeChallanSettlementSummaryBatch(challans.map((c) => c.id));

    const itemsBeforeFinancialFilter = challans.map((c) => ({
      ...c,
      financials: financialsMap[c.id],
      responsibleParties: responsiblePartiesMap[c.id],
      settlementSummary: settlementSummaryMap[c.id],
    }));

    // "financial" (RECEIVABLE/PAYABLE/DUE/CLEARED/...) is a computed
    // value, not a raw column - filtered here, server-side, AFTER the
    // batch computation above, rather than in the Prisma `where`
    // clause. Real server-side filtering either way - the dashboard's
    // "Settled Challan" etc. drill-down cards never rely on the client
    // to filter an unfiltered fetch.
    const items = financial ? itemsBeforeFinancialFilter.filter((item) => matchesFinancialFilter(item, financial)) : itemsBeforeFinancialFilter;

    return NextResponse.json({
      success: true,
      items,
      // Matches the exact permission DELETE /api/challan/[id] (the
      // Bin action) already enforces - lets the list page hide the
      // Delete button for a role the backend would reject anyway,
      // the same capabilities-flag pattern app/api/employees/route.ts
      // already uses.
      capabilities: {
        canBin: hasPermission(currentUser, "challan.bin"),
      },
    });
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

    const existingChallan = await prisma.challan.findUnique({
      where: { challanNo: data.challanNo },
    });

    if (existingChallan && !existingChallan.isDeleted) {
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
