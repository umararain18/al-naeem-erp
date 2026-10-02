import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  resolveBillInput,
  buildBillLedgerDescription,
  getBillPaymentState,
  assertBillEditNotBelowSettled,
  resolveBillClientAccountId,
  BillValidationError,
  type BillInput,
} from "@/lib/bill-accounting";
import { getBillIncomeAccountId, getBillWalkInReceivableAccountId } from "@/lib/gross-accounts";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // See the identical guard in app/api/challan/[id]/route.ts - a raw
    // null byte in the id is rejected by PostgreSQL's text encoding
    // before Prisma even gets to compare it against a real row,
    // throwing an exception that would otherwise become an
    // unexplained 500. A real Bill id can never contain one.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Bill not found" },
        { status: 404 }
      );
    }

    const bill = await prisma.bill.findUnique({
      where: { id },
      include: {
        clientParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
        items: {
          orderBy: { lineNo: "asc" },
          include: {
            sourceLink: {
              select: {
                sourceType: true,
                privatePhonchVehicleId: true,
                phonchVehicleId: true,
                privatePhonchVehicle: { select: { phonch: { select: { id: true, phonchNo: true } } } },
                phonchVehicle: { select: { phonch: { select: { id: true, phonchNo: true } } } },
              },
            },
          },
        },
        createdBy: { select: { id: true, fullName: true, username: true } },
        deletedBy: { select: { id: true, fullName: true, username: true } },
      },
    });

    if (!bill) {
      return NextResponse.json({ success: false, message: "Bill not found" }, { status: 404 });
    }

    const totalAmount = bill.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0);

    const clientAccountId = await resolveBillClientAccountId(prisma, bill.clientParty);
    const paymentState = clientAccountId
      ? await getBillPaymentState(prisma, id, clientAccountId, totalAmount)
      : { totalAmount, receivedAmount: 0, remainingDue: totalAmount, isInconsistent: false, status: "UNPAID" as const };

    return NextResponse.json({
      success: true,
      bill: {
        ...bill,
        totals: { totalAmount },
        ...paymentState,
      },
      capabilities: {
        canEdit: hasPermission(currentUser, "bill.edit"),
        canBin: hasPermission(currentUser, "bill.bin"),
      },
    });
  } catch (error) {
    console.error("Get bill error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Bill" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Bill not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const data = body as BillInput & { clientPartyId?: string };

    let resolved;
    try {
      resolved = resolveBillInput(data);
    } catch (validationError) {
      if (validationError instanceof BillValidationError) {
        return NextResponse.json({ success: false, message: validationError.message }, { status: validationError.status });
      }
      throw validationError;
    }

    const current = await prisma.bill.findUnique({
      where: { id },
      include: {
        items: { select: { rent: true, delivery: true, otherExpense: true } },
        clientParty: { select: { account: { select: { id: true } } } },
      },
    });
    if (!current) {
      return NextResponse.json({ success: false, message: "Bill not found" }, { status: 404 });
    }
    if (current.isDeleted) {
      return NextResponse.json({ success: false, message: "Binned Bill cannot be edited. Restore it first." }, { status: 400 });
    }

    const currentClientAccountId = await resolveBillClientAccountId(prisma, current.clientParty);
    const currentTotal = current.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0);

    if (resolved.billNo !== current.billNo) {
      const dup = await prisma.bill.findFirst({
        where: { billNo: resolved.billNo, isDeleted: false, id: { not: id } },
        select: { id: true },
      });
      if (dup) {
        return NextResponse.json({ success: false, message: "Bill No. already exists" }, { status: 409 });
      }
    }

    try {
      await prisma.$transaction(
        async (tx) => {
          // ------------------------------------------------------------
          // CLIENT RESOLUTION - same rule as create (see
          // app/api/bill/route.ts's own doc comment): never
          // transparently create a new Party/Account for a random
          // client - a walk-in edit posts against the shared "Bill
          // Book - Walk-in Customers" system account instead.
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

          // Changing the Client PARTY itself while the CURRENT client
          // already has a received amount is rejected - reassigning
          // would misattribute (or orphan) that Daily Posting history
          // onto a different party's account. An amount-only edit to
          // the SAME client is validated below instead (Section 18/26).
          if (currentClientAccountId && clientAccountId !== currentClientAccountId) {
            const currentState = await getBillPaymentState(tx, id, currentClientAccountId, currentTotal);
            if (currentState.receivedAmount > 0.009) {
              throw new BillValidationError(
                "Cannot change the Client - a Daily Posting receipt has already been recorded against the current Client."
              );
            }
          }

          // Financial edit is allowed after partial receipt, as long as
          // the NEW Bill Total is still >= what has already been
          // received via Daily Posting - read live, inside this
          // Serializable transaction. Non-financial fields (Vehicle,
          // From, To, Engine, Chassis, Regd) are never gated by this.
          await assertBillEditNotBelowSettled(tx, id, currentClientAccountId, currentTotal, resolved.total);

          // ------------------------------------------------------------
          // DUPLICATE BILLING PROTECTION - re-checked for every sourced
          // item, EXCLUDING this Bill's own existing links (a Bill may
          // freely keep referencing its own already-linked vehicles).
          // ------------------------------------------------------------
          for (const item of resolved.items) {
            if (!item.source) continue;
            const existingLink = await tx.billSourceLink.findFirst({
              where: {
                billId: { not: id },
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

          await tx.bill.update({
            where: { id },
            data: {
              billNo: resolved.billNo,
              date: resolved.date,
              clientPartyId,
              clientName: resolved.clientName,
              clientPhone: resolved.clientPhone,
              sourceType: resolved.sourceType,
              updatedById: currentUser.userId,
            },
          });

          // Replace-on-edit for items/source links - never mutate
          // history, mirrors every other module's own edit pattern.
          await tx.billSourceLink.deleteMany({ where: { billId: id } });
          await tx.billItem.deleteMany({ where: { billId: id } });
          const createdItems = await Promise.all(
            resolved.items.map((item) =>
              tx.billItem.create({
                data: {
                  billId: id,
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
                },
              })
            )
          );
          for (let i = 0; i < resolved.items.length; i++) {
            const item = resolved.items[i];
            if (!item.source) continue;
            await tx.billSourceLink.create({
              data: {
                billId: id,
                billItemId: createdItems[i].id,
                sourceType: item.source.sourceType,
                privatePhonchVehicleId: item.source.privatePhonchVehicleId,
                phonchVehicleId: item.source.phonchVehicleId,
              },
            });
          }

          // Replace-on-edit: soft-delete the old JournalEntry, post a
          // fresh one with the new totals - never mutate history in
          // place, mirroring every other module's own edit behavior.
          await tx.journalEntry.updateMany({
            where: { referenceType: "BILL", referenceId: id, isDeleted: false },
            data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
          });

          const description = buildBillLedgerDescription({ billNo: resolved.billNo }, resolved.items, resolved.total);
          const billIncomeId = await getBillIncomeAccountId(tx);

          await tx.journalEntry.create({
            data: {
              entryDate: resolved.date,
              referenceType: "BILL",
              referenceId: id,
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
                    sourceId: id,
                    sourceNumber: resolved.billNo,
                  },
                  {
                    accountId: billIncomeId,
                    debit: 0,
                    credit: resolved.total,
                    description,
                    sourceType: "BILL",
                    sourceId: id,
                    sourceNumber: resolved.billNo,
                  },
                ],
              },
            },
          });

          const changedFields = diffFields(
            { billNo: current.billNo, clientPartyId: current.clientPartyId, clientName: current.clientName, clientPhone: current.clientPhone, total: currentTotal },
            { billNo: resolved.billNo, clientPartyId, clientName: resolved.clientName, clientPhone: resolved.clientPhone, total: resolved.total },
            ["billNo", "clientPartyId", "clientName", "clientPhone", "total"]
          );
          if (Object.keys(changedFields).length > 0) {
            const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
            await auditUpdate(tx, {
              actor: actorFromUser(currentUser),
              module: "BILL",
              entityType: "Bill",
              entityId: id,
              documentNo: resolved.billNo,
              description: `Updated Bill ${resolved.billNo}: ${summary}`,
              changedFields,
              ...requestContext(request),
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json({ success: true, message: "Bill updated successfully." });
    } catch (error) {
      if (error instanceof BillValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Bill was modified concurrently. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Update bill error:", error);
    return NextResponse.json({ success: false, message: "Unable to update Bill" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Bill not found" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "bill.permanentlyDelete")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      const existing = await prisma.bill.findUnique({ where: { id }, select: { id: true, isDeleted: true, billNo: true } });
      if (!existing) {
        return NextResponse.json({ success: false, message: "Bill not found" }, { status: 404 });
      }
      if (!existing.isDeleted) {
        return NextResponse.json({ success: false, message: "Only binned Bills can be permanently deleted" }, { status: 400 });
      }

      // Mirrors app/api/phonch/[id]/route.ts's own permanent-delete
      // exactly: the row is hard-deleted (BillItem/BillSourceLink
      // cascade via schema), but its JournalEntry/JournalLines are
      // NEVER touched - historical accounting remains fully intact
      // regardless of whether the source document itself still exists.
      await prisma.bill.delete({ where: { id } });

      await auditDelete(prisma, {
        actor: actorFromUser(currentUser),
        module: "BILL",
        entityType: "Bill",
        entityId: id,
        documentNo: existing.billNo,
        description: `Permanently deleted Bill ${existing.billNo}`,
        ...requestContext(request),
      });

      return NextResponse.json({ success: true, message: "Bill permanently deleted.", billId: id });
    }

    if (!hasPermission(currentUser, "bill.bin")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const bill = await prisma.bill.findUnique({
      where: { id },
      include: {
        items: { select: { rent: true, delivery: true, otherExpense: true } },
        clientParty: { select: { account: { select: { id: true } } } },
      },
    });
    if (!bill) {
      return NextResponse.json({ success: false, message: "Bill not found" }, { status: 404 });
    }
    if (bill.isDeleted) {
      return NextResponse.json({ success: false, message: "This Bill is already in Bin." }, { status: 400 });
    }

    const binClientAccountId = await resolveBillClientAccountId(prisma, bill.clientParty);
    if (binClientAccountId) {
      const totalAmount = bill.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0);
      const state = await getBillPaymentState(prisma, id, binClientAccountId, totalAmount);
      if (state.receivedAmount > 0.009) {
        return NextResponse.json(
          { success: false, message: "This Bill has recorded Daily Posting receipts and cannot be moved to Bin." },
          { status: 400 }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      // Document-owned accounting: a Bill's BILL-referenceType entry
      // is replace-on-edit (see this file's PATCH handler - exactly
      // ONE is ever active at a time), so this `updateMany` scoped to
      // isDeleted: false always touches exactly that one row. Moves
      // to Bin together with the Bill itself, in the SAME transaction -
      // never DAILY_POSTING, already excluded above (zero received
      // amount required to Bin).
      await tx.journalEntry.updateMany({
        where: { referenceType: "BILL", referenceId: id, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await tx.bill.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "BILL",
        entityType: "Bill",
        entityId: id,
        documentNo: bill.billNo,
        description: `Moved Bill ${bill.billNo} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Bill moved to Bin successfully." });
  } catch (error) {
    console.error("Bin bill error:", error);
    return NextResponse.json({ success: false, message: "Unable to move Bill to Bin" }, { status: 500 });
  }
}
