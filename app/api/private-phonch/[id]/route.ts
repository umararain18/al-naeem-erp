import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  resolvePrivatePhonchInput,
  buildPrivatePhonchTransporterDescription,
  buildPrivatePhonchClearingAgentDescription,
  getPrivatePhonchPaymentState,
  getPrivatePhonchDeliveryRecoveryState,
  getPrivatePhonchAlreadySettledAmount,
  assertPrivatePhonchEditNotBelowSettled,
  derivePrivatePhonchOverallStatus,
  PrivatePhonchValidationError,
  type PrivatePhonchInput,
} from "@/lib/private-phonch-accounting";
import {
  getPrivatePhonchCarrierRentExpenseAccountId,
  getPrivatePhonchDeliveryIncomeAccountId,
} from "@/lib/gross-accounts";
import { getBillPaymentState, resolveBillClientAccountId } from "@/lib/bill-accounting";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

type Tx = Prisma.TransactionClient | typeof prisma;

// Every distinct payer account (Transporter + every distinct Clearing
// Agent) this Private Phonch could have a Daily Posting payment
// against, each with its own established payable and its own
// paid/remaining state - the multi-party analogue of Showroom
// Phonch's single getPhonchPaymentState() call. Returns the sum of
// every account's OWN paidAmount (never netted across accounts,
// since a deposit/payment to one Clearing Agent must never appear to
// "cover" another's unrelated payable) - used only to answer "has
// ANY payment been recorded against this Private Phonch at all",
// exactly mirroring Showroom Phonch's own edit/bin protection.
async function getTotalPaidAcrossAllPayers(
  tx: Tx,
  phonchId: string,
  transporterAccountId: string | null,
  vehicles: {
    totalRent: number;
    deliveryCharges: number;
    carrierPayable: number;
    clearingAgentPartyId: string | null;
    deliveryRecoveryParty: string | null;
  }[],
  caAccountByPartyId: Map<string, string>
): Promise<number> {
  let total = 0;

  if (transporterAccountId) {
    const totalCarrierPayable = Math.round(vehicles.reduce((s, v) => s + v.carrierPayable, 0) * 100) / 100;
    if (totalCarrierPayable > 0.009) {
      const state = await getPrivatePhonchPaymentState(tx, phonchId, transporterAccountId, totalCarrierPayable, undefined, true);
      total += state.paidAmount;
    }

    // Transporter Delivery Recovery - a separate, opposite-polarity
    // receivable (fully-paid, Total Rent = 0 vehicles attributed to
    // the Transporter) - any receipt already recorded against it must
    // ALSO block edit/bin, exactly like Carrier Payable payments
    // already do.
    const totalTransporterDeliveryRecovery = Math.round(
      vehicles.reduce((s, v) => s + (v.totalRent <= 0.009 && v.deliveryRecoveryParty !== "CLEARING_AGENT" ? v.deliveryCharges : 0), 0) * 100
    ) / 100;
    if (totalTransporterDeliveryRecovery > 0.009) {
      const recoveryState = await getPrivatePhonchDeliveryRecoveryState(tx, phonchId, transporterAccountId, totalTransporterDeliveryRecovery);
      total += recoveryState.recoveredAmount;
    }
  }

  const caPayableByPartyId = new Map<string, number>();
  const caRecoveryByPartyId = new Map<string, number>();
  for (const v of vehicles) {
    if (!v.clearingAgentPartyId) continue;
    if (v.totalRent <= 0.009 && v.deliveryRecoveryParty === "CLEARING_AGENT") {
      caRecoveryByPartyId.set(v.clearingAgentPartyId, Math.round(((caRecoveryByPartyId.get(v.clearingAgentPartyId) || 0) + v.deliveryCharges) * 100) / 100);
      continue;
    }
    const caPayable = Math.max(0, Math.round((v.totalRent - v.deliveryCharges - v.carrierPayable) * 100) / 100);
    caPayableByPartyId.set(v.clearingAgentPartyId, Math.round(((caPayableByPartyId.get(v.clearingAgentPartyId) || 0) + caPayable) * 100) / 100);
  }
  for (const [partyId, amount] of caPayableByPartyId) {
    const accountId = caAccountByPartyId.get(partyId);
    if (!accountId || amount <= 0.009) continue;
    const state = await getPrivatePhonchPaymentState(tx, phonchId, accountId, amount);
    total += state.paidAmount;
  }
  // Clearing Agent Delivery Recovery - the same generic
  // getPrivatePhonchDeliveryRecoveryState() the Transporter's own
  // recovery uses above, applied to a CA's account instead (see its
  // own doc comment: it works for any account, not just the
  // Transporter's).
  for (const [partyId, amount] of caRecoveryByPartyId) {
    const accountId = caAccountByPartyId.get(partyId);
    if (!accountId || amount <= 0.009) continue;
    const recoveryState = await getPrivatePhonchDeliveryRecoveryState(tx, phonchId, accountId, amount);
    total += recoveryState.recoveredAmount;
  }

  return Math.round(total * 100) / 100;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "privatePhonch.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // See the identical guard in app/api/challan/[id]/route.ts - a raw
    // null byte in the id is rejected by PostgreSQL's text encoding
    // before Prisma even gets to compare it against a real row,
    // throwing an exception that would otherwise become an
    // unexplained 500. A real Private Phonch id can never contain one.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Private Phonch not found" },
        { status: 404 }
      );
    }

    const phonch = await prisma.privatePhonch.findUnique({
      where: { id },
      include: {
        transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
        vehicles: {
          orderBy: { lineNo: "asc" },
          include: {
            clearingAgentParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
            // Reverse Bill Book link (Section 20/21 of the Bill Book
            // spec) - at most one ACTIVE Bill per vehicle, per the
            // application-level duplicate-billing guard in
            // app/api/bill/route.ts.
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
      return NextResponse.json({ success: false, message: "Private Phonch not found" }, { status: 404 });
    }

    const totalRent = phonch.vehicles.reduce((s, v) => s + Number(v.totalRent), 0);
    const totalDeliveryCharges = phonch.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0);
    const totalCarrierPayable = phonch.vehicles.reduce((s, v) => s + Number(v.carrierPayable), 0);
    const totalCaPayable = phonch.vehicles.reduce(
      (s, v) => s + Math.max(0, Number(v.totalRent) - Number(v.deliveryCharges) - Number(v.carrierPayable)),
      0
    );

    // Delivery Recovery, split by WHO it's owed by (see
    // resolvePrivatePhonchInput()'s own mutual-exclusivity guard - a
    // Clearing Agent never has both a Payable and a Recovery on the
    // same Private Phonch).
    const totalTransporterDeliveryRecovery = Math.round(
      phonch.vehicles.reduce(
        (s, v) => s + (Number(v.totalRent) <= 0.009 && v.deliveryRecoveryParty !== "CLEARING_AGENT" ? Number(v.deliveryCharges) : 0),
        0
      ) * 100
    ) / 100;
    const totalDeliveryRecovery = Math.round(
      phonch.vehicles.reduce((s, v) => s + (Number(v.totalRent) <= 0.009 ? Number(v.deliveryCharges) : 0), 0) * 100
    ) / 100;

    const transporterAccountId = phonch.transporterParty.account?.id || null;
    const transporterState = transporterAccountId
      ? await getPrivatePhonchPaymentState(prisma, id, transporterAccountId, totalCarrierPayable, undefined, true)
      : { totalPayable: totalCarrierPayable, paidAmount: 0, remainingDue: totalCarrierPayable, isInconsistent: false, status: "PAYABLE" as const };

    // Transporter Delivery Recovery state - the independent, opposite-
    // polarity receivable rendered alongside Carrier Rent Payable in
    // the Status section (see app/private-phonch/[id]/page.tsx).
    const transporterDeliveryRecoveryState = transporterAccountId && totalTransporterDeliveryRecovery > 0.009
      ? await getPrivatePhonchDeliveryRecoveryState(prisma, id, transporterAccountId, totalTransporterDeliveryRecovery)
      : {
          totalRecovery: totalTransporterDeliveryRecovery,
          recoveredAmount: 0,
          remainingDue: totalTransporterDeliveryRecovery,
          isInconsistent: false,
          status: totalTransporterDeliveryRecovery > 0.009 ? ("RECEIVABLE" as const) : ("CLEARED" as const),
        };

    // Per-Clearing-Agent Payable state, each keyed by their OWN
    // account - never blended (Case 2/3's own "no mixing"
    // requirement). Zero-rent vehicles attributed to the Transporter
    // or to a DIFFERENT Clearing Agent for recovery never contribute
    // here (their caPayable is always 0 for a zero-rent row).
    const caPayableByPartyId = new Map<string, number>();
    // Per-Clearing-Agent Delivery Recovery, the opposite-polarity
    // receivable - kept in a SEPARATE map, never combined with the
    // Payable map above.
    const caRecoveryByPartyId = new Map<string, number>();
    for (const v of phonch.vehicles) {
      if (!v.clearingAgentPartyId) continue;
      if (Number(v.totalRent) <= 0.009 && v.deliveryRecoveryParty === "CLEARING_AGENT") {
        caRecoveryByPartyId.set(
          v.clearingAgentPartyId,
          Math.round(((caRecoveryByPartyId.get(v.clearingAgentPartyId) || 0) + Number(v.deliveryCharges)) * 100) / 100
        );
        continue;
      }
      const caPayable = Math.max(0, Number(v.totalRent) - Number(v.deliveryCharges) - Number(v.carrierPayable));
      caPayableByPartyId.set(v.clearingAgentPartyId, Math.round(((caPayableByPartyId.get(v.clearingAgentPartyId) || 0) + caPayable) * 100) / 100);
    }
    const caById = new Map<string, { id: string; partyName: string; account: { id: string } | null }>();
    for (const v of phonch.vehicles) {
      if (v.clearingAgentPartyId && v.clearingAgentParty) caById.set(v.clearingAgentPartyId, v.clearingAgentParty);
    }
    const clearingAgentStates = [];
    for (const [partyId, amount] of caPayableByPartyId) {
      const ca = caById.get(partyId);
      const accountId = ca?.account?.id;
      const state = accountId
        ? await getPrivatePhonchPaymentState(prisma, id, accountId, amount)
        : { totalPayable: amount, paidAmount: 0, remainingDue: amount, isInconsistent: false, status: "PAYABLE" as const };
      clearingAgentStates.push({ partyId, partyName: ca?.partyName || "Clearing Agent", accountId: accountId || null, ...state });
    }

    const clearingAgentRecoveryStates = [];
    for (const [partyId, amount] of caRecoveryByPartyId) {
      if (amount <= 0.009) continue;
      const ca = caById.get(partyId);
      const accountId = ca?.account?.id;
      const state = accountId
        ? await getPrivatePhonchDeliveryRecoveryState(prisma, id, accountId, amount)
        : { totalRecovery: amount, recoveredAmount: 0, remainingDue: amount, isInconsistent: false, status: "RECEIVABLE" as const };
      clearingAgentRecoveryStates.push({ partyId, partyName: ca?.partyName || "Clearing Agent", accountId: accountId || null, ...state });
    }

    const caRemainingTotal = Math.round(
      clearingAgentStates.reduce((s, ca) => s + ca.remainingDue, 0) * 100
    ) / 100;
    const caRecoveryRemainingTotal = Math.round(
      clearingAgentRecoveryStates.reduce((s, ca) => s + ca.remainingDue, 0) * 100
    ) / 100;

    const overallStatus = derivePrivatePhonchOverallStatus({
      carrierRemaining: transporterState.remainingDue,
      caRemaining: caRemainingTotal,
      recoveryRemaining: Math.round((transporterDeliveryRecoveryState.remainingDue + caRecoveryRemainingTotal) * 100) / 100,
    });

    // Compact per-vehicle Bill reference (Section 20/21) - "Bill No |
    // Amount | Status", or null when not yet billed. Never a single
    // misleading Bill status for the whole Private Phonch.
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
        totals: { totalRent, totalDeliveryCharges, totalCarrierPayable, totalCaPayable, totalDeliveryRecovery },
        transporterState,
        clearingAgentRecoveryStates,
        transporterDeliveryRecoveryState,
        clearingAgentStates,
        overallStatus,
      },
      capabilities: {
        canEdit: hasPermission(currentUser, "privatePhonch.edit"),
        canBin: hasPermission(currentUser, "privatePhonch.bin"),
      },
    });
  } catch (error) {
    console.error("Get private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Private Phonch" }, { status: 500 });
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
    if (!hasPermission(currentUser, "privatePhonch.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json(
        { success: false, message: "Private Phonch not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const data = body as PrivatePhonchInput;

    let resolved;
    try {
      resolved = resolvePrivatePhonchInput(data);
    } catch (validationError) {
      if (validationError instanceof PrivatePhonchValidationError) {
        return NextResponse.json({ success: false, message: validationError.message }, { status: validationError.status });
      }
      throw validationError;
    }

    const current = await prisma.privatePhonch.findUnique({
      where: { id },
      include: {
        vehicles: { select: { lineNo: true, totalRent: true, deliveryCharges: true, carrierPayable: true, clearingAgentPartyId: true } },
        transporterParty: { select: { partyName: true, account: { select: { id: true } } } },
      },
    });
    if (!current) {
      return NextResponse.json({ success: false, message: "Private Phonch not found" }, { status: 404 });
    }
    if (current.isDeleted) {
      return NextResponse.json({ success: false, message: "Binned Private Phonch cannot be edited. Restore it first." }, { status: 400 });
    }

    const currentTransporterAccountId = current.transporterParty.account?.id || null;

    if (resolved.phonchNo !== current.phonchNo) {
      const dup = await prisma.privatePhonch.findFirst({
        where: { phonchNo: resolved.phonchNo, isDeleted: false, id: { not: id } },
        select: { id: true },
      });
      if (dup) {
        return NextResponse.json({ success: false, message: "Private Phonch No. already exists" }, { status: 409 });
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
            throw new PrivatePhonchValidationError("Selected Transporter was not found");
          }
          if (!transporterParty.account || !transporterParty.account.isActive) {
            throw new PrivatePhonchValidationError("Selected Transporter does not have an active account");
          }

          const caPartyIds = [...new Set(resolved.vehicles.map((v) => v.clearingAgentPartyId).filter((pid): pid is string => !!pid))];
          const caParties = caPartyIds.length
            ? await tx.party.findMany({
                where: { id: { in: caPartyIds } },
                select: { id: true, partyName: true, isActive: true, account: { select: { id: true, isActive: true } } },
              })
            : [];
          if (caParties.length !== caPartyIds.length) {
            throw new PrivatePhonchValidationError("One or more selected Clearing Agents were not found");
          }
          for (const ca of caParties) {
            if (!ca.isActive || !ca.account || !ca.account.isActive) {
              throw new PrivatePhonchValidationError(`Clearing Agent "${ca.partyName}" does not have an active account`);
            }
          }
          const caById = new Map(caParties.map((ca) => [ca.id, ca]));

          // ----------------------------------------------------------
          // IDENTITY CHANGE DETECTION - a Transporter or a vehicle's
          // own Clearing Agent being reassigned to a DIFFERENT real
          // Party (never a vehicle simply being added/removed, nor
          // any amount changing on its own) takes the dedicated
          // surgical reassignment path below: the entry's EXISTING
          // JournalLines are matched to the new desired state by
          // stable semantic role and updated/created/removed
          // individually - never a delete-and-recreate of the whole
          // entry. An edit that changes no party identity at all
          // keeps today's exact replace-on-edit behavior (soft-delete
          // the old JournalEntry, post a fresh one), byte-for-byte
          // unchanged.
          // ----------------------------------------------------------
          const transporterChanged = resolved.transporterPartyId !== current.transporterPartyId;
          const currentVehiclesByLineNo = new Map(current.vehicles.map((v) => [v.lineNo, v]));
          const caChanges: { lineNo: number; oldPartyId: string | null; newPartyId: string | null }[] = [];
          for (const v of resolved.vehicles) {
            const old = currentVehiclesByLineNo.get(v.lineNo);
            if (old && (old.clearingAgentPartyId || null) !== (v.clearingAgentPartyId || null)) {
              caChanges.push({ lineNo: v.lineNo, oldPartyId: old.clearingAgentPartyId, newPartyId: v.clearingAgentPartyId });
            }
          }
          const identityChanged = transporterChanged || caChanges.length > 0;

          // Changing the Transporter PARTY itself while the CURRENT
          // Transporter already has a settled amount is rejected -
          // reassigning would misattribute (or orphan) that Daily
          // Posting history onto a different party's account. An
          // amount-only edit to the SAME Transporter is validated
          // below instead, via assertPrivatePhonchEditNotBelowSettled().
          if (transporterChanged && currentTransporterAccountId) {
            const carrierAlreadyPaid = await getPrivatePhonchAlreadySettledAmount(tx, id, currentTransporterAccountId, "CARRIER_PAYABLE");
            const recoveryAlreadyReceived = await getPrivatePhonchAlreadySettledAmount(tx, id, currentTransporterAccountId, "DELIVERY_RECOVERY");
            if (carrierAlreadyPaid > 0.009 || recoveryAlreadyReceived > 0.009) {
              throw new PrivatePhonchValidationError(
                `${current.transporterParty.partyName} ko is phonch ki payment ho chuki hai - pehle wo payment Daily Posting se hatayein, phir agent badlein.`
              );
            }
          }

          // Financial edit is allowed after partial payment, as long
          // as every independent payable/receivable line's NEW amount
          // is still >= what has already been paid/received against
          // it via Daily Posting (never netted against each other) -
          // read live, inside this Serializable transaction, so a
          // concurrent Daily Posting can never be missed. Also catches
          // a Clearing Agent reassignment away from an already-paid CA
          // (its new effective amount becomes 0) - see that function's
          // own messaging for the reassignment-specific wording.
          const caAccountIdByPartyId = new Map(caParties.filter((ca) => ca.account).map((ca) => [ca.id, ca.account!.id]));
          await assertPrivatePhonchEditNotBelowSettled(tx, id, currentTransporterAccountId, resolved, caAccountIdByPartyId);

          await tx.privatePhonch.update({
            where: { id },
            data: {
              phonchNo: resolved.phonchNo,
              date: resolved.date,
              transporterPartyId: resolved.transporterPartyId,
              updatedById: currentUser.userId,
            },
          });

          // ----------------------------------------------------------
          // VEHICLES - a row that has ever been linked to a Bill can
          // never be deleted (schema: BillSourceLink.
          // privatePhonchVehicleId is onDelete: Restrict) - update
          // those rows in place instead of the previous blanket
          // deleteMany()+createMany(), which threw an unhandled P2003
          // on EVERY edit of a billed Private Phonch (the confirmed
          // root cause of the reported generic-error bug - reproduced
          // live even for an amount-only edit, independent of any
          // party change). Every other vehicle keeps the exact same
          // delete-and-recreate behavior as before.
          // ----------------------------------------------------------
          const existingVehicleRows = await tx.privatePhonchVehicle.findMany({
            where: { phonchId: id },
            select: { id: true, lineNo: true, billSourceLinks: { select: { id: true } } },
          });
          const billedLineNos = new Set(existingVehicleRows.filter((v) => v.billSourceLinks.length > 0).map((v) => v.lineNo));
          for (const lineNo of billedLineNos) {
            if (!resolved.vehicles.some((v) => v.lineNo === lineNo)) {
              throw new PrivatePhonchValidationError(
                `Vehicle line ${lineNo} has already been billed and cannot be removed. Edit its other fields instead of removing it.`
              );
            }
          }

          await tx.privatePhonchVehicle.deleteMany({ where: { phonchId: id, billSourceLinks: { none: {} } } });
          for (const v of resolved.vehicles) {
            const vehicleData = {
              lineNo: v.lineNo,
              biltyNo: v.biltyNo,
              challanNo: v.challanNo,
              chassisNumber: v.chassisNumber,
              engineNumber: v.engineNumber,
              vehicleName: v.vehicleName,
              clearingAgentPartyId: v.clearingAgentPartyId,
              totalRent: v.totalRent,
              deliveryCharges: v.deliveryCharges,
              carrierPayable: v.carrierPayable,
              deliveryRecoveryParty: v.deliveryRecoveryParty,
              note: v.note,
            };
            const billedRow = billedLineNos.has(v.lineNo) ? existingVehicleRows.find((ev) => ev.lineNo === v.lineNo) : undefined;
            if (billedRow) {
              await tx.privatePhonchVehicle.update({ where: { id: billedRow.id }, data: vehicleData });
            } else {
              await tx.privatePhonchVehicle.create({ data: { phonchId: id, ...vehicleData } });
            }
          }

          const carrierRentExpenseId = await getPrivatePhonchCarrierRentExpenseAccountId(tx);
          const transporterDescription = buildPrivatePhonchTransporterDescription(
            { phonchNo: resolved.phonchNo },
            resolved.vehicles,
            resolved.totalCarrierPayable
          );

          const caPayableByPartyId = new Map<string, number>();
          for (const v of resolved.vehicles) {
            if (!v.clearingAgentPartyId || v.caPayable <= 0) continue;
            caPayableByPartyId.set(
              v.clearingAgentPartyId,
              Math.round(((caPayableByPartyId.get(v.clearingAgentPartyId) || 0) + v.caPayable) * 100) / 100
            );
          }

          if (!identityChanged) {
            // --------------------------------------------------------
            // NO PARTY IDENTITY CHANGED - existing replace-on-edit
            // behavior, byte-for-byte unchanged: soft-delete the old
            // JournalEntry, post a fresh one with the new totals.
            // --------------------------------------------------------
            await tx.journalEntry.updateMany({
              where: { referenceType: "PRIVATE_PHONCH", referenceId: id, isDeleted: false },
              data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
            });

            const lines: {
              accountId: string;
              debit: number;
              credit: number;
              description: string;
              sourceType: string;
              sourceId: string;
              sourceNumber: string;
            }[] = [];

            if (resolved.totalRent > 0) {
              lines.push({ accountId: carrierRentExpenseId, debit: resolved.totalRent, credit: 0, description: transporterDescription, sourceType: "PRIVATE_PHONCH", sourceId: id, sourceNumber: resolved.phonchNo });
            }
            if (resolved.totalCarrierPayable > 0) {
              lines.push({ accountId: transporterParty.account.id, debit: 0, credit: resolved.totalCarrierPayable, description: transporterDescription, sourceType: "PRIVATE_PHONCH", sourceId: id, sourceNumber: resolved.phonchNo });
            }
            if (resolved.totalTransporterDeliveryRecovery > 0) {
              lines.push({ accountId: transporterParty.account.id, debit: resolved.totalTransporterDeliveryRecovery, credit: 0, description: `Private Phonch ${resolved.phonchNo} - Transporter Delivery Recovery`, sourceType: "PRIVATE_PHONCH", sourceId: id, sourceNumber: resolved.phonchNo });
            }
            for (const [caPartyId, amount] of resolved.caDeliveryRecoveryByPartyId) {
              if (amount <= 0) continue;
              const ca = caById.get(caPartyId)!;
              lines.push({ accountId: ca.account!.id, debit: amount, credit: 0, description: `Private Phonch ${resolved.phonchNo} - Clearing Agent Delivery Recovery (${ca.partyName})`, sourceType: "PRIVATE_PHONCH", sourceId: id, sourceNumber: resolved.phonchNo });
            }
            for (const [caPartyId, amount] of caPayableByPartyId) {
              const ca = caById.get(caPartyId)!;
              const description = buildPrivatePhonchClearingAgentDescription({ phonchNo: resolved.phonchNo }, resolved.vehicles.filter((v) => v.clearingAgentPartyId === caPartyId), ca.partyName, amount);
              lines.push({ accountId: ca.account!.id, debit: 0, credit: amount, description, sourceType: "PRIVATE_PHONCH", sourceId: id, sourceNumber: resolved.phonchNo });
            }
            if (resolved.totalDeliveryCharges > 0) {
              const deliveryIncomeId = await getPrivatePhonchDeliveryIncomeAccountId(tx);
              lines.push({ accountId: deliveryIncomeId, debit: 0, credit: resolved.totalDeliveryCharges, description: `Private Phonch ${resolved.phonchNo} - Delivery Charges`, sourceType: "PRIVATE_PHONCH", sourceId: id, sourceNumber: resolved.phonchNo });
            }

            await tx.journalEntry.create({
              data: {
                entryDate: resolved.date,
                referenceType: "PRIVATE_PHONCH",
                referenceId: id,
                description: transporterDescription,
                createdById: currentUser.userId,
                lines: { create: lines },
              },
            });
          } else {
            // --------------------------------------------------------
            // PARTY IDENTITY CHANGED - surgical reconciliation. The
            // entry's EXISTING active JournalLines are matched against
            // the new desired line set by stable semantic ROLE (never
            // by array position), and only updated/created/removed
            // where the role itself actually differs. A role whose
            // party/amount is unchanged keeps its exact JournalLine id
            // untouched. A role that disappears (its party fully
            // reassigned away, or its amount zeroed) is deleted only
            // after re-confirming nothing is settled against it
            // (assertPrivatePhonchEditNotBelowSettled above already
            // guarantees this - this is a defensive re-check
            // immediately before the destructive write, mirroring the
            // same safety principle the Daily Posting multi-line edit
            // endpoint already established for PaymentAllocation). A
            // role that newly appears is created fresh. The resulting
            // line SET is identical to what the branch above would
            // have created wholesale (same formulas), so Dr = Cr is
            // preserved by construction either way.
            // --------------------------------------------------------
            const deliveryIncomeId = resolved.totalDeliveryCharges > 0 ? await getPrivatePhonchDeliveryIncomeAccountId(tx) : null;

            const desired = new Map<string, { accountId: string; debit: number; credit: number; description: string }>();
            if (resolved.totalRent > 0) {
              desired.set("CARRIER_RENT_EXPENSE", { accountId: carrierRentExpenseId, debit: resolved.totalRent, credit: 0, description: transporterDescription });
            }
            if (resolved.totalCarrierPayable > 0) {
              desired.set("TRANSPORTER_PAYABLE", { accountId: transporterParty.account.id, debit: 0, credit: resolved.totalCarrierPayable, description: transporterDescription });
            }
            if (resolved.totalTransporterDeliveryRecovery > 0) {
              desired.set("TRANSPORTER_RECOVERY", { accountId: transporterParty.account.id, debit: resolved.totalTransporterDeliveryRecovery, credit: 0, description: `Private Phonch ${resolved.phonchNo} - Transporter Delivery Recovery` });
            }
            for (const [caPartyId, amount] of resolved.caDeliveryRecoveryByPartyId) {
              if (amount <= 0) continue;
              const ca = caById.get(caPartyId)!;
              desired.set(`CA_RECOVERY:${ca.account!.id}`, { accountId: ca.account!.id, debit: amount, credit: 0, description: `Private Phonch ${resolved.phonchNo} - Clearing Agent Delivery Recovery (${ca.partyName})` });
            }
            for (const [caPartyId, amount] of caPayableByPartyId) {
              const ca = caById.get(caPartyId)!;
              const description = buildPrivatePhonchClearingAgentDescription({ phonchNo: resolved.phonchNo }, resolved.vehicles.filter((v) => v.clearingAgentPartyId === caPartyId), ca.partyName, amount);
              desired.set(`CA_PAYABLE:${ca.account!.id}`, { accountId: ca.account!.id, debit: 0, credit: amount, description });
            }
            if (deliveryIncomeId) {
              desired.set("DELIVERY_INCOME", { accountId: deliveryIncomeId, debit: 0, credit: resolved.totalDeliveryCharges, description: `Private Phonch ${resolved.phonchNo} - Delivery Charges` });
            }

            let activeEntry = await tx.journalEntry.findFirst({
              where: { referenceType: "PRIVATE_PHONCH", referenceId: id, isDeleted: false },
              include: { lines: true },
            });
            if (!activeEntry) {
              activeEntry = await tx.journalEntry.create({
                data: { entryDate: resolved.date, referenceType: "PRIVATE_PHONCH", referenceId: id, description: transporterDescription, createdById: currentUser.userId },
                include: { lines: true },
              });
            } else {
              await tx.journalEntry.update({ where: { id: activeEntry.id }, data: { entryDate: resolved.date, description: transporterDescription } });
            }

            const existingByRole = new Map<string, (typeof activeEntry.lines)[number]>();
            for (const line of activeEntry.lines) {
              let role: string;
              if (line.accountId === carrierRentExpenseId) role = "CARRIER_RENT_EXPENSE";
              else if (deliveryIncomeId && line.accountId === deliveryIncomeId) role = "DELIVERY_INCOME";
              else if (currentTransporterAccountId && line.accountId === currentTransporterAccountId) {
                role = Number(line.credit) > 0 ? "TRANSPORTER_PAYABLE" : "TRANSPORTER_RECOVERY";
              } else {
                role = Number(line.credit) > 0 ? `CA_PAYABLE:${line.accountId}` : `CA_RECOVERY:${line.accountId}`;
              }
              existingByRole.set(role, line);
            }

            const allRoles = new Set<string>([...existingByRole.keys(), ...desired.keys()]);
            for (const role of allRoles) {
              const existingLine = existingByRole.get(role);
              const target = desired.get(role);

              if (existingLine && target) {
                if (
                  existingLine.accountId !== target.accountId ||
                  Number(existingLine.debit) !== target.debit ||
                  Number(existingLine.credit) !== target.credit ||
                  existingLine.description !== target.description
                ) {
                  await tx.journalLine.update({
                    where: { id: existingLine.id },
                    data: { accountId: target.accountId, debit: target.debit, credit: target.credit, description: target.description },
                  });
                }
              } else if (existingLine && !target) {
                const isPayableRole = role === "TRANSPORTER_PAYABLE" || role.startsWith("CA_PAYABLE:");
                const isRecoveryRole = role === "TRANSPORTER_RECOVERY" || role.startsWith("CA_RECOVERY:");
                if (isPayableRole) {
                  const settled = await getPrivatePhonchAlreadySettledAmount(tx, id, existingLine.accountId, role === "TRANSPORTER_PAYABLE" ? "CARRIER_PAYABLE" : "CA_PAYABLE");
                  if (settled > 0.009) {
                    throw new PrivatePhonchValidationError("A Daily Posting payment already exists against this line - it cannot be removed this way.");
                  }
                } else if (isRecoveryRole) {
                  const settled = await getPrivatePhonchAlreadySettledAmount(tx, id, existingLine.accountId, "DELIVERY_RECOVERY");
                  if (settled > 0.009) {
                    throw new PrivatePhonchValidationError("A Daily Posting receipt already exists against this line - it cannot be removed this way.");
                  }
                }
                await tx.journalLine.delete({ where: { id: existingLine.id } });
              } else if (!existingLine && target) {
                await tx.journalLine.create({
                  data: {
                    journalEntryId: activeEntry.id,
                    accountId: target.accountId,
                    debit: target.debit,
                    credit: target.credit,
                    description: target.description,
                    sourceType: "PRIVATE_PHONCH",
                    sourceId: id,
                    sourceNumber: resolved.phonchNo,
                  },
                });
              }
            }
          }

          const currentTotals = {
            phonchNo: current.phonchNo,
            transporterPartyId: current.transporterPartyId,
            totalRent: current.vehicles.reduce((s, v) => s + Number(v.totalRent), 0),
            totalDeliveryCharges: current.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0),
            totalCarrierPayable: current.vehicles.reduce((s, v) => s + Number(v.carrierPayable), 0),
          };
          const changedFields = diffFields(currentTotals, {
            phonchNo: resolved.phonchNo,
            transporterPartyId: resolved.transporterPartyId,
            totalRent: resolved.totalRent,
            totalDeliveryCharges: resolved.totalDeliveryCharges,
            totalCarrierPayable: resolved.totalCarrierPayable,
          }, ["phonchNo", "transporterPartyId", "totalRent", "totalDeliveryCharges", "totalCarrierPayable"]);
          let caChangeSummary = "";
          if (caChanges.length > 0) {
            const oldCaPartyIds = [...new Set(caChanges.map((c) => c.oldPartyId).filter((pid): pid is string => !!pid))];
            const oldCaParties = oldCaPartyIds.length
              ? await tx.party.findMany({ where: { id: { in: oldCaPartyIds } }, select: { id: true, partyName: true } })
              : [];
            const oldCaNameById = new Map(oldCaParties.map((p) => [p.id, p.partyName]));
            caChangeSummary = caChanges
              .map((c) => {
                const oldName = c.oldPartyId ? oldCaNameById.get(c.oldPartyId) || c.oldPartyId : "—";
                const newName = c.newPartyId ? caById.get(c.newPartyId)?.partyName || c.newPartyId : "—";
                return `Vehicle line ${c.lineNo} Clearing Agent ${oldName} → ${newName}`;
              })
              .join("; ");
          }
          if (Object.keys(changedFields).length > 0 || caChangeSummary) {
            const summary = [
              Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; "),
              caChangeSummary,
            ]
              .filter(Boolean)
              .join("; ");
            await auditUpdate(tx, {
              actor: actorFromUser(currentUser),
              module: "PRIVATE_PHONCH",
              entityType: "PrivatePhonch",
              entityId: id,
              documentNo: resolved.phonchNo,
              description: `Updated Private Phonch ${resolved.phonchNo}: ${summary}`,
              changedFields,
              ...requestContext(request),
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json({ success: true, message: "Private Phonch updated successfully." });
    } catch (error) {
      if (error instanceof PrivatePhonchValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Private Phonch was modified concurrently. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Update private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to update Private Phonch" }, { status: 500 });
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
        { success: false, message: "Private Phonch not found" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "privatePhonch.permanentlyDelete")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      const existing = await prisma.privatePhonch.findUnique({ where: { id }, select: { id: true, isDeleted: true, phonchNo: true } });
      if (!existing) {
        return NextResponse.json({ success: false, message: "Private Phonch not found" }, { status: 404 });
      }
      if (!existing.isDeleted) {
        return NextResponse.json({ success: false, message: "Only binned Private Phonch records can be permanently deleted" }, { status: 400 });
      }

      // Mirrors Showroom Phonch's own permanent-delete exactly: the
      // row is hard-deleted (PrivatePhonchVehicle cascades via
      // schema), but its JournalEntry/JournalLines are NEVER touched -
      // historical accounting remains fully intact regardless of
      // whether the source document itself still exists.
      await prisma.privatePhonch.delete({ where: { id } });

      await auditDelete(prisma, {
        actor: actorFromUser(currentUser),
        module: "PRIVATE_PHONCH",
        entityType: "PrivatePhonch",
        entityId: id,
        documentNo: existing.phonchNo,
        description: `Permanently deleted Private Phonch ${existing.phonchNo}`,
        ...requestContext(request),
      });

      return NextResponse.json({ success: true, message: "Private Phonch permanently deleted.", phonchId: id });
    }

    if (!hasPermission(currentUser, "privatePhonch.bin")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const phonch = await prisma.privatePhonch.findUnique({
      where: { id },
      include: {
        vehicles: {
          select: { totalRent: true, deliveryCharges: true, carrierPayable: true, clearingAgentPartyId: true, deliveryRecoveryParty: true },
        },
        transporterParty: { select: { account: { select: { id: true } } } },
      },
    });
    if (!phonch) {
      return NextResponse.json({ success: false, message: "Private Phonch not found" }, { status: 404 });
    }
    if (phonch.isDeleted) {
      return NextResponse.json({ success: false, message: "This Private Phonch is already in Bin." }, { status: 400 });
    }

    const caPartyIds = [...new Set(phonch.vehicles.map((v) => v.clearingAgentPartyId).filter((pid): pid is string => !!pid))];
    const caAccounts = caPartyIds.length
      ? await prisma.party.findMany({ where: { id: { in: caPartyIds } }, select: { id: true, account: { select: { id: true } } } })
      : [];
    const caAccountByPartyId = new Map(caAccounts.filter((p) => p.account).map((p) => [p.id, p.account!.id]));

    const totalPaidSoFar = await getTotalPaidAcrossAllPayers(
      prisma,
      id,
      phonch.transporterParty.account?.id || null,
      phonch.vehicles.map((v) => ({
        totalRent: Number(v.totalRent),
        deliveryCharges: Number(v.deliveryCharges),
        carrierPayable: Number(v.carrierPayable),
        clearingAgentPartyId: v.clearingAgentPartyId,
        deliveryRecoveryParty: v.deliveryRecoveryParty,
      })),
      caAccountByPartyId
    );
    if (totalPaidSoFar > 0.009) {
      return NextResponse.json(
        { success: false, message: "This Private Phonch has recorded Daily Posting payment(s)/deposit(s) and cannot be moved to Bin." },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      // Document-owned accounting: a PrivatePhonch's PRIVATE_PHONCH-
      // referenceType entry is replace-on-edit (see this file's PATCH
      // handler - exactly ONE is ever active at a time), so this
      // `updateMany` scoped to isDeleted: false always touches exactly
      // that one row. Moves to Bin together with the PrivatePhonch
      // itself, in the SAME transaction - never DAILY_POSTING, already
      // excluded above (zero payment/deposit amount required to Bin).
      await tx.journalEntry.updateMany({
        where: { referenceType: "PRIVATE_PHONCH", referenceId: id, isDeleted: false },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await tx.privatePhonch.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "PRIVATE_PHONCH",
        entityType: "PrivatePhonch",
        entityId: id,
        documentNo: phonch.phonchNo,
        description: `Moved Private Phonch ${phonch.phonchNo} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Private Phonch moved to Bin successfully." });
  } catch (error) {
    console.error("Bin private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to move Private Phonch to Bin" }, { status: 500 });
  }
}
