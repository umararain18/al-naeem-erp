import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  resolveBillInput,
  buildBillLedgerDescription,
  getBillPaymentState,
  resolveBillClientAccountId,
  BillValidationError,
  type BillInput,
} from "@/lib/bill-accounting";
import { getBillIncomeAccountId, getBillWalkInReceivableAccountId } from "@/lib/gross-accounts";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";
import { billListSearchOr } from "@/lib/search-helpers";

// ============================================================
// GET /api/bill - list (search)
// POST /api/bill - create
//
// Mirrors app/api/phonch/route.ts's own shape exactly, adapted for a
// single Client Party RECEIVABLE (same shape as Showroom Phonch's own
// single-Transporter model). Received/Remaining/Status are computed
// per-Bill using the SAME authoritative getBillPaymentState() the
// detail page uses - filtered to the Client Party's own accountId,
// never a batched sourceId-only sum (the exact Showroom Phonch list
// bug this task's own spec calls out).
// ============================================================

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();

    const bills = await prisma.bill.findMany({
      where: {
        isDeleted: false,
        ...(search ? { OR: billListSearchOr(search) } : {}),
      },
      include: {
        clientParty: { select: { id: true, account: { select: { id: true } } } },
        items: { select: { vehicleName: true, rent: true, delivery: true, otherExpense: true } },
        sourceLinks: {
          select: {
            privatePhonchVehicle: { select: { phonch: { select: { id: true, phonchNo: true } } } },
            phonchVehicle: { select: { phonch: { select: { id: true, phonchNo: true } } } },
          },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    const items = await Promise.all(
      bills.map(async (b) => {
        const rentTotal = Math.round(b.items.reduce((s, i) => s + Number(i.rent), 0) * 100) / 100;
        const totalAmount = Math.round(
          b.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0) * 100
        ) / 100;

        const clientAccountId = await resolveBillClientAccountId(prisma, b.clientParty);
        const state = clientAccountId
          ? await getBillPaymentState(prisma, b.id, clientAccountId, totalAmount)
          : { receivedAmount: 0, remainingDue: totalAmount, status: "UNPAID" as const };

        const vehicleNames = b.items.map((i) => i.vehicleName).filter((n): n is string => !!n && n.trim().length > 0);

        // Compact, clickable reverse reference (Agent 1/3 requirement) -
        // a Bill is locked to ONE source type (Section 3), so its linked
        // source Phonch numbers are always either all Private Phonch or
        // all Showroom Phonch - deduplicated by id, never guessed.
        const phonchLinksById = new Map<string, string>();
        for (const l of b.sourceLinks) {
          const phonch = l.privatePhonchVehicle?.phonch || l.phonchVehicle?.phonch;
          if (phonch) phonchLinksById.set(phonch.id, phonch.phonchNo);
        }
        const phonchLinks = [...phonchLinksById].map(([id, phonchNo]) => ({ id, phonchNo }));

        return {
          id: b.id,
          billNo: b.billNo,
          date: b.date,
          clientName: b.clientName,
          clientPhone: b.clientPhone,
          vehicleCount: b.items.length,
          vehicleNames,
          sourceType: b.sourceType,
          phonchLinks,
          rentTotal,
          totalAmount,
          receivedAmount: state.receivedAmount,
          remainingDue: state.remainingDue,
          status: state.status,
        };
      })
    );

    return NextResponse.json({
      success: true,
      items,
      capabilities: {
        canEdit: hasPermission(currentUser, "bill.edit"),
        canBin: hasPermission(currentUser, "bill.bin"),
      },
    });
  } catch (error) {
    console.error("List bill error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Bill list" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const data = body as BillInput & { clientPartyId?: string; idempotencyKey?: string };

    let resolved;
    try {
      resolved = resolveBillInput(data);
    } catch (validationError) {
      if (validationError instanceof BillValidationError) {
        return NextResponse.json({ success: false, message: validationError.message }, { status: validationError.status });
      }
      throw validationError;
    }

    const billId = data.idempotencyKey ? `bill_${data.idempotencyKey}` : undefined;

    if (billId) {
      const alreadyProcessed = await prisma.bill.findUnique({ where: { id: billId } });
      if (alreadyProcessed) {
        return NextResponse.json({
          success: true,
          message: "This Bill was already processed.",
          idempotentReplay: true,
          bill: { id: alreadyProcessed.id, billNo: alreadyProcessed.billNo },
        });
      }
    }

    const existingBillNo = await prisma.bill.findFirst({
      where: { billNo: resolved.billNo, isDeleted: false },
      select: { id: true },
    });
    if (existingBillNo) {
      return NextResponse.json({ success: false, message: "Bill No. already exists" }, { status: 409 });
    }

    try {
      const bill = await prisma.$transaction(
        async (tx) => {
          const dupInTx = await tx.bill.findFirst({
            where: { billNo: resolved.billNo, isDeleted: false },
            select: { id: true },
          });
          if (dupInTx) {
            throw new BillValidationError("Bill No. already exists", 409);
          }

          // ------------------------------------------------------------
          // CLIENT RESOLUTION - either the explicitly-selected existing
          // Party (data.clientPartyId, using that Party's own Account),
          // or a random/one-time client (no clientPartyId) whose Bill
          // is NEVER allowed to transparently create a new Party or
          // Account - see model Bill's own doc comment in
          // prisma/schema.prisma. A walk-in client's Bill instead posts
          // against the single shared "Bill Book - Walk-in Customers"
          // system account (lib/gross-accounts.ts).
          // ------------------------------------------------------------
          let clientPartyId: string | null;
          let clientAccountId: string;

          if (data.clientPartyId) {
            const party = await tx.party.findUnique({
              where: { id: data.clientPartyId },
              select: { id: true, isActive: true, account: { select: { id: true, isActive: true } } },
            });
            if (!party || !party.isActive) {
              throw new BillValidationError("Selected Client was not found");
            }
            if (!party.account || !party.account.isActive) {
              throw new BillValidationError("Selected Client does not have an active account");
            }
            clientPartyId = party.id;
            clientAccountId = party.account.id;
          } else {
            clientPartyId = null;
            clientAccountId = await getBillWalkInReceivableAccountId(tx);
          }

          // ------------------------------------------------------------
          // DUPLICATE BILLING PROTECTION (Section 5) - re-checked here,
          // inside the Serializable transaction, for every sourced item.
          // ------------------------------------------------------------
          for (const item of resolved.items) {
            if (!item.source) continue;
            const existingLink = await tx.billSourceLink.findFirst({
              where: {
                bill: { isDeleted: false },
                ...(item.source.sourceType === "PRIVATE_PHONCH"
                  ? { privatePhonchVehicleId: item.source.privatePhonchVehicleId }
                  : { phonchVehicleId: item.source.phonchVehicleId }),
              },
              select: { bill: { select: { billNo: true } } },
            });
            if (existingLink) {
              throw new BillValidationError(
                `Vehicle line ${item.lineNo}: this vehicle is already billed in Bill ${existingLink.bill.billNo}.`
              );
            }
          }

          const createdBill = await tx.bill.create({
            data: {
              ...(billId ? { id: billId } : {}),
              billNo: resolved.billNo,
              date: resolved.date,
              clientPartyId,
              clientName: resolved.clientName,
              clientPhone: resolved.clientPhone,
              sourceType: resolved.sourceType,
              createdById: currentUser.userId,
              items: {
                create: resolved.items.map((item) => ({
                  lineNo: item.lineNo,
                  vehicleName: item.vehicleName,
                  fromText: item.fromText,
                  toText: item.toText,
                  engineNumber: item.engineNumber,
                  chassisNumber: item.chassisNumber,
                  regdNumber: item.regdNumber,
                  rent: item.rent,
                  delivery: item.delivery,
                  otherExpense: item.otherExpense,
                })),
              },
            },
            include: { items: true },
          });

          // Source links - created AFTER items so each link can point
          // at its own item's real id (1:1, matched by lineNo).
          const itemByLineNo = new Map(createdBill.items.map((i) => [i.lineNo, i]));
          for (const item of resolved.items) {
            if (!item.source) continue;
            const dbItem = itemByLineNo.get(item.lineNo)!;
            await tx.billSourceLink.create({
              data: {
                billId: createdBill.id,
                billItemId: dbItem.id,
                sourceType: item.source.sourceType,
                privatePhonchVehicleId: item.source.privatePhonchVehicleId,
                phonchVehicleId: item.source.phonchVehicleId,
              },
            });
          }

          // ------------------------------------------------------------
          // ONE balanced JournalEntry - Dr Client Party (Bill Total) /
          // Cr Bill Income - see model Bill's own doc comment in
          // prisma/schema.prisma for why this is a NEW, independent
          // client-side transaction, never touching Private/Showroom
          // Phonch's own carrier-side accounting.
          // ------------------------------------------------------------
          const description = buildBillLedgerDescription({ billNo: resolved.billNo }, resolved.items, resolved.total);
          const billIncomeId = await getBillIncomeAccountId(tx);

          await tx.journalEntry.create({
            data: {
              entryDate: resolved.date,
              referenceType: "BILL",
              referenceId: createdBill.id,
              description,
              createdById: currentUser.userId,
              lines: {
                create: [
                  {
                    accountId: clientAccountId,
                    debit: resolved.total,
                    credit: 0,
                    description,
                    sourceType: "BILL",
                    sourceId: createdBill.id,
                    sourceNumber: resolved.billNo,
                  },
                  {
                    accountId: billIncomeId,
                    debit: 0,
                    credit: resolved.total,
                    description,
                    sourceType: "BILL",
                    sourceId: createdBill.id,
                    sourceNumber: resolved.billNo,
                  },
                ],
              },
            },
          });

          await auditCreate(tx, {
            actor: actorFromUser(currentUser),
            module: "BILL",
            entityType: "Bill",
            entityId: createdBill.id,
            documentNo: createdBill.billNo,
            description: `Created Bill ${createdBill.billNo} for ${resolved.clientName} (Rs. ${resolved.total.toLocaleString()})`,
            newValues: {
              billNo: createdBill.billNo,
              clientPartyId,
              clientName: resolved.clientName,
              clientPhone: resolved.clientPhone,
              total: resolved.total,
              itemCount: resolved.items.length,
            },
            ...requestContext(request),
          });

          return createdBill;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json(
        { success: true, message: "Bill created successfully.", bill: { id: bill.id, billNo: bill.billNo } },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof BillValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Bill could not be created due to a concurrent change. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Create bill error:", error);
    return NextResponse.json({ success: false, message: "Unable to create Bill" }, { status: 500 });
  }
}
