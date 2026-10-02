import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  resolvePhonchInput,
  buildPhonchLedgerDescription,
  getPhonchPaymentState,
  assertPhonchEditNotBelowSettled,
  PhonchValidationError,
  type PhonchInput,
} from "@/lib/phonch-accounting";
import { getShowroomDeliveryIncomeAccountId, getClaimRecoveryAccountId } from "@/lib/gross-accounts";
import { getBillPaymentState, resolveBillClientAccountId } from "@/lib/bill-accounting";
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
    if (!hasPermission(currentUser, "phonch.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // See the identical guard in app/api/challan/[id]/route.ts - a raw
    // null byte in the id is rejected by PostgreSQL's text encoding
    // before Prisma even gets to compare it against a real row,
    // throwing an exception that would otherwise become an
    // unexplained 500. A real Phonch id can never contain one.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Phonch not found" },
        { status: 404 }
      );
    }

    const phonch = await prisma.phonch.findUnique({
      where: { id },
      include: {
        transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
        vehicles: {
          orderBy: { lineNo: "asc" },
          include: {
            party: { select: { id: true, partyName: true } },
            // Reverse Bill Book link (Section 20/21 of the Bill Book
            // spec) - at most one ACTIVE Bill per vehicle.
            billSourceLinks: {
              where: { bill: { isDeleted: false } },
              take: 1,
              select: {
                bill: {
                  select: {
                    id: true,
                    billNo: true,
                    clientParty: { select: { account: { select: { id: true } } } },
                    items: { select: { rent: true, delivery: true, otherExpense: true } },
                  },
                },
              },
            },
          },
        },
        createdBy: { select: { id: true, fullName: true, username: true } },
        deletedBy: { select: { id: true, fullName: true, username: true } },
      },
    });

    if (!phonch) {
      return NextResponse.json({ success: false, message: "Phonch not found" }, { status: 404 });
    }

    const totalDeliveryCharges = phonch.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0);
    const totalOtherExpense = phonch.vehicles.reduce((s, v) => s + Number(v.otherExpenseAmount), 0);
    const totalClaim = phonch.vehicles.reduce((s, v) => s + Number(v.claimAmount), 0);
    const totalAmount = totalDeliveryCharges + totalOtherExpense + totalClaim;

    const paymentState = phonch.transporterParty.account
      ? await getPhonchPaymentState(prisma, phonch.id, phonch.transporterParty.account.id, totalAmount)
      : { receivedAmount: 0, remainingDue: totalAmount, isInconsistent: false, status: "RECEIVABLE" as const };

    // Compact per-vehicle Bill reference (Section 20/21) - "Bill No |
    // Amount | Status", or null when not yet billed.
    const vehiclesWithBillInfo = await Promise.all(
      phonch.vehicles.map(async (v) => {
        const link = v.billSourceLinks[0]?.bill;
        if (!link) return { ...v, billInfo: null };
        const billTotal = Math.round(
          link.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0) * 100
        ) / 100;
        const linkAccountId = await resolveBillClientAccountId(prisma, link.clientParty);
        const billState = linkAccountId
          ? await getBillPaymentState(prisma, link.id, linkAccountId, billTotal)
          : { status: "UNPAID" as const };
        return {
          ...v,
          billInfo: { billId: link.id, billNo: link.billNo, billAmount: billTotal, billStatus: billState.status },
        };
      })
    );

    return NextResponse.json({
      success: true,
      phonch: {
        ...phonch,
        vehicles: vehiclesWithBillInfo,
        totals: { totalDeliveryCharges, totalOtherExpense, totalClaim, totalAmount },
        ...paymentState,
      },
      capabilities: {
        canEdit: hasPermission(currentUser, "phonch.edit"),
        canBin: hasPermission(currentUser, "phonch.bin"),
      },
    });
  } catch (error) {
    console.error("Get phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Phonch" }, { status: 500 });
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
    if (!hasPermission(currentUser, "phonch.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Phonch not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const data = body as PhonchInput;

    let resolved;
    try {
      resolved = resolvePhonchInput(data);
    } catch (validationError) {
      if (validationError instanceof PhonchValidationError) {
        return NextResponse.json({ success: false, message: validationError.message }, { status: validationError.status });
      }
      throw validationError;
    }

    const current = await prisma.phonch.findUnique({
      where: { id },
      include: {
        vehicles: { select: { deliveryCharges: true, otherExpenseAmount: true, claimAmount: true } },
        transporterParty: { select: { account: { select: { id: true } } } },
      },
    });
    if (!current) {
      return NextResponse.json({ success: false, message: "Phonch not found" }, { status: 404 });
    }
    if (current.isDeleted) {
      return NextResponse.json({ success: false, message: "Binned Phonch cannot be edited. Restore it first." }, { status: 400 });
    }

    const currentTransporterAccountId = current.transporterParty.account?.id || null;
    const currentTotal = current.vehicles.reduce(
      (s, v) => s + Number(v.deliveryCharges) + Number(v.otherExpenseAmount) + Number(v.claimAmount),
      0
    );

    if (resolved.phonchNo !== current.phonchNo) {
      const dup = await prisma.phonch.findFirst({
        where: { phonchNo: resolved.phonchNo, isDeleted: false, id: { not: id } },
        select: { id: true },
      });
      if (dup) {
        return NextResponse.json({ success: false, message: "Phonch No. already exists" }, { status: 409 });
      }
    }

    try {
      await prisma.$transaction(
        async (tx) => {
          const transporterParty = await tx.party.findUnique({
            where: { id: resolved.transporterPartyId },
            select: { partyName: true, isActive: true, account: { select: { id: true, isActive: true } } },
          });
          if (!transporterParty || !transporterParty.isActive) {
            throw new PhonchValidationError("Selected Transporter was not found");
          }
          if (!transporterParty.account || !transporterParty.account.isActive) {
            throw new PhonchValidationError("Selected Transporter does not have an active account");
          }

          const vehiclePartyIds = [...new Set(resolved.vehicles.map((v) => v.partyId).filter((pid): pid is string => !!pid))];
          if (vehiclePartyIds.length > 0) {
            const validParties = await tx.party.count({ where: { id: { in: vehiclePartyIds }, isActive: true } });
            if (validParties !== vehiclePartyIds.length) {
              throw new PhonchValidationError("One or more selected vehicle Parties were not found");
            }
          }

          // Changing the Transporter PARTY itself while the CURRENT
          // Transporter already has a received amount is rejected -
          // reassigning would misattribute (or orphan) that Daily
          // Posting history onto a different party's account. An
          // amount-only edit to the SAME Transporter is validated
          // below instead.
          if (currentTransporterAccountId && resolved.transporterPartyId !== current.transporterPartyId) {
            const currentState = await getPhonchPaymentState(tx, id, currentTransporterAccountId, currentTotal);
            if (currentState.receivedAmount > 0.009) {
              throw new PhonchValidationError(
                "Cannot change the Transporter - a Daily Posting receipt has already been recorded against the current Transporter."
              );
            }
          }

          // Financial edit is allowed after partial receipt, as long as
          // the NEW Total Amount is still >= what has already been
          // received via Daily Posting - read live, inside this
          // Serializable transaction, so a concurrent Daily Posting can
          // never be missed (replaces the old blanket "any receipt
          // exists" edit lock entirely). Non-financial fields (Vehicle,
          // Chassis, Engine, Bilty No., Challan No.) are never gated by
          // this check.
          await assertPhonchEditNotBelowSettled(tx, id, currentTransporterAccountId, currentTotal, resolved.totalAmount);

          await tx.phonch.update({
            where: { id },
            data: {
              phonchNo: resolved.phonchNo,
              date: resolved.date,
              transporterPartyId: resolved.transporterPartyId,
              carrierNumber: resolved.carrierNumber,
              description: resolved.description,
              updatedById: currentUser.userId,
            },
          });

          await tx.phonchVehicle.deleteMany({ where: { phonchId: id } });
          await tx.phonchVehicle.createMany({
            data: resolved.vehicles.map((v) => ({
              phonchId: id,
              lineNo: v.lineNo,
              biltyNo: v.biltyNo,
              challanNo: v.challanNo,
              chassisNumber: v.chassisNumber,
              engineNumber: v.engineNumber,
              vehicleName: v.vehicleName,
              partyId: v.partyId,
              deliveryCharges: v.deliveryCharges,
              note: v.note,
              otherExpenseAmount: v.otherExpenseAmount,
              otherExpenseReason: v.otherExpenseReason,
              claimAmount: v.claimAmount,
              claimReason: v.claimReason,
            })),
          });

          // Replace-on-edit: soft-delete the old JournalEntry, post a
          // fresh one with the new totals - never mutate history in
          // place, mirroring app/api/payslips/[id]/route.ts's own
          // financial-field edit behavior exactly.
          await tx.journalEntry.updateMany({
            where: { referenceType: "PHONCH", referenceId: id, isDeleted: false },
            data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
          });

          const vehicleParties = vehiclePartyIds.length
            ? await tx.party.findMany({ where: { id: { in: vehiclePartyIds } }, select: { id: true, partyName: true } })
            : [];
          const vehiclePartyNames = new Map(vehicleParties.map((p) => [p.id, p.partyName]));

          const description = buildPhonchLedgerDescription(
            { phonchNo: resolved.phonchNo, carrierNumber: resolved.carrierNumber, description: resolved.description },
            resolved.vehicles,
            {
              totalDeliveryCharges: resolved.totalDeliveryCharges,
              totalOtherExpense: resolved.totalOtherExpense,
              totalClaim: resolved.totalClaim,
            },
            vehiclePartyNames,
            transporterParty.partyName
          );

          const lines: {
            accountId: string;
            debit: number;
            credit: number;
            description: string;
            sourceType: string;
            sourceId: string;
            sourceNumber: string;
          }[] = [
            {
              accountId: transporterParty.account.id,
              debit: resolved.totalAmount,
              credit: 0,
              description,
              sourceType: "PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            },
          ];

          if (resolved.totalDeliveryCharges > 0 || resolved.totalOtherExpense > 0) {
            const showroomIncomeId = await getShowroomDeliveryIncomeAccountId(tx);
            if (resolved.totalDeliveryCharges > 0) {
              lines.push({
                accountId: showroomIncomeId,
                debit: 0,
                credit: resolved.totalDeliveryCharges,
                description: `Phonch ${resolved.phonchNo} - Delivery Charges`,
                sourceType: "PHONCH",
                sourceId: id,
                sourceNumber: resolved.phonchNo,
              });
            }
            if (resolved.totalOtherExpense > 0) {
              lines.push({
                accountId: showroomIncomeId,
                debit: 0,
                credit: resolved.totalOtherExpense,
                description: `Phonch ${resolved.phonchNo} - Other Expense Recovery`,
                sourceType: "PHONCH",
                sourceId: id,
                sourceNumber: resolved.phonchNo,
              });
            }
          }

          if (resolved.totalClaim > 0) {
            const claimRecoveryId = await getClaimRecoveryAccountId(tx);
            lines.push({
              accountId: claimRecoveryId,
              debit: 0,
              credit: resolved.totalClaim,
              description: `Phonch ${resolved.phonchNo} - Claim Recovery`,
              sourceType: "PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            });
          }

          await tx.journalEntry.create({
            data: {
              entryDate: resolved.date,
              referenceType: "PHONCH",
              referenceId: id,
              description,
              createdById: currentUser.userId,
              lines: { create: lines },
            },
          });

          const currentTotals = {
            phonchNo: current.phonchNo,
            transporterPartyId: current.transporterPartyId,
            carrierNumber: current.carrierNumber,
            totalAmount: currentTotal,
          };
          const changedFields = diffFields(currentTotals, {
            phonchNo: resolved.phonchNo,
            transporterPartyId: resolved.transporterPartyId,
            carrierNumber: resolved.carrierNumber,
            totalAmount: resolved.totalAmount,
          }, ["phonchNo", "transporterPartyId", "carrierNumber", "totalAmount"]);
          if (Object.keys(changedFields).length > 0) {
            const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
            await auditUpdate(tx, {
              actor: actorFromUser(currentUser),
              module: "SHOWROOM_PHONCH",
              entityType: "Phonch",
              entityId: id,
              documentNo: resolved.phonchNo,
              description: `Updated Showroom Phonch ${resolved.phonchNo}: ${summary}`,
              changedFields,
              ...requestContext(request),
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json({ success: true, message: "Phonch updated successfully." });
    } catch (error) {
      if (error instanceof PhonchValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Phonch was modified concurrently. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Update phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to update Phonch" }, { status: 500 });
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
        { success: false, message: "Phonch not found" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "phonch.permanentlyDelete")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      const existing = await prisma.phonch.findUnique({ where: { id }, select: { id: true, isDeleted: true, phonchNo: true } });
      if (!existing) {
        return NextResponse.json({ success: false, message: "Phonch not found" }, { status: 404 });
      }
      if (!existing.isDeleted) {
        return NextResponse.json({ success: false, message: "Only binned Phonch records can be permanently deleted" }, { status: 400 });
      }

      // Mirrors app/api/bilty/[id]/route.ts's own permanent-delete
      // exactly: the row is hard-deleted (PhonchVehicle cascades via
      // schema), but its JournalEntry/JournalLines are NEVER touched -
      // historical accounting remains fully intact regardless of
      // whether the source document itself still exists.
      await prisma.phonch.delete({ where: { id } });

      await auditDelete(prisma, {
        actor: actorFromUser(currentUser),
        module: "SHOWROOM_PHONCH",
        entityType: "Phonch",
        entityId: id,
        documentNo: existing.phonchNo,
        description: `Permanently deleted Showroom Phonch ${existing.phonchNo}`,
        ...requestContext(request),
      });

      return NextResponse.json({ success: true, message: "Phonch permanently deleted.", phonchId: id });
    }

    if (!hasPermission(currentUser, "phonch.bin")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const phonch = await prisma.phonch.findUnique({
      where: { id },
      include: {
        vehicles: { select: { deliveryCharges: true, otherExpenseAmount: true, claimAmount: true } },
        transporterParty: { select: { account: { select: { id: true } } } },
      },
    });
    if (!phonch) {
      return NextResponse.json({ success: false, message: "Phonch not found" }, { status: 404 });
    }
    if (phonch.isDeleted) {
      return NextResponse.json({ success: false, message: "This Phonch is already in Bin." }, { status: 400 });
    }

    if (phonch.transporterParty.account) {
      const totalAmount = phonch.vehicles.reduce(
        (s, v) => s + Number(v.deliveryCharges) + Number(v.otherExpenseAmount) + Number(v.claimAmount),
        0
      );
      const state = await getPhonchPaymentState(prisma, id, phonch.transporterParty.account.id, totalAmount);
      if (state.receivedAmount > 0.009) {
        return NextResponse.json(
          { success: false, message: "This Phonch has recorded Daily Posting receipts and cannot be moved to Bin." },
          { status: 400 }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      // Document-owned accounting: a Phonch's PHONCH-referenceType
      // entry is replace-on-edit (see this file's PATCH handler -
      // exactly ONE is ever active at a time), so this `updateMany`
      // scoped to isDeleted: false always touches exactly that one
      // row. Moves to Bin together with the Phonch itself, in the
      // SAME transaction - never DAILY_POSTING, already excluded
      // above (zero received amount required to Bin).
      await tx.journalEntry.updateMany({
        where: { referenceType: "PHONCH", referenceId: id, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await tx.phonch.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "SHOWROOM_PHONCH",
        entityType: "Phonch",
        entityId: id,
        documentNo: phonch.phonchNo,
        description: `Moved Showroom Phonch ${phonch.phonchNo} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Phonch moved to Bin successfully." });
  } catch (error) {
    console.error("Bin phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to move Phonch to Bin" }, { status: 500 });
  }
}
