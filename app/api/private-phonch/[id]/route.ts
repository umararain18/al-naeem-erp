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
    const phonch = await prisma.privatePhonch.findUnique({
      where: { id },
      include: {
        transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
        vehicles: {
          orderBy: { lineNo: "asc" },
          include: { clearingAgentParty: { select: { id: true, partyName: true, account: { select: { id: true } } } } },
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

    return NextResponse.json({
      success: true,
      phonch: {
        ...phonch,
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
        vehicles: { select: { totalRent: true, deliveryCharges: true, carrierPayable: true, clearingAgentPartyId: true } },
        transporterParty: { select: { account: { select: { id: true } } } },
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

          // Changing the Transporter PARTY itself while the CURRENT
          // Transporter already has a settled amount is rejected -
          // reassigning would misattribute (or orphan) that Daily
          // Posting history onto a different party's account. An
          // amount-only edit to the SAME Transporter is validated
          // below instead, per this task's own "not below already
          // settled" rule.
          if (currentTransporterAccountId && resolved.transporterPartyId !== current.transporterPartyId) {
            const carrierAlreadyPaid = await getPrivatePhonchAlreadySettledAmount(tx, id, currentTransporterAccountId, "CARRIER_PAYABLE");
            const recoveryAlreadyReceived = await getPrivatePhonchAlreadySettledAmount(tx, id, currentTransporterAccountId, "DELIVERY_RECOVERY");
            if (carrierAlreadyPaid > 0.009 || recoveryAlreadyReceived > 0.009) {
              throw new PrivatePhonchValidationError(
                "Cannot change the Transporter - a Daily Posting payment/receipt has already been recorded against the current Transporter."
              );
            }
          }

          // Financial edit is allowed after partial payment, as long
          // as every independent payable/receivable line's NEW amount
          // is still >= what has already been paid/received against
          // it via Daily Posting (never netted against each other) -
          // read live, inside this Serializable transaction, so a
          // concurrent Daily Posting can never be missed (replaces the
          // old blanket "any payment exists" edit lock entirely).
          // Non-financial fields (vehicle name, chassis, engine, Bilty
          // No., Challan No.) are never gated by this check.
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

          await tx.privatePhonchVehicle.deleteMany({ where: { phonchId: id } });
          await tx.privatePhonchVehicle.createMany({
            data: resolved.vehicles.map((v) => ({
              phonchId: id,
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
            })),
          });

          // Replace-on-edit: soft-delete the old JournalEntry, post a
          // fresh one with the new totals - never mutate history in
          // place, mirroring Showroom Phonch's own edit behavior.
          await tx.journalEntry.updateMany({
            where: { referenceType: "PRIVATE_PHONCH", referenceId: id, isDeleted: false },
            data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
          });

          const carrierRentExpenseId = await getPrivatePhonchCarrierRentExpenseAccountId(tx);

          const lines: {
            accountId: string;
            debit: number;
            credit: number;
            description: string;
            sourceType: string;
            sourceId: string;
            sourceNumber: string;
          }[] = [];

          const transporterDescription = buildPrivatePhonchTransporterDescription(
            { phonchNo: resolved.phonchNo },
            resolved.vehicles,
            resolved.totalCarrierPayable
          );

          // See the identical guard's comment in
          // app/api/private-phonch/route.ts (POST).
          if (resolved.totalRent > 0) {
            lines.push({
              accountId: carrierRentExpenseId,
              debit: resolved.totalRent,
              credit: 0,
              description: transporterDescription,
              sourceType: "PRIVATE_PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            });
          }

          if (resolved.totalCarrierPayable > 0) {
            lines.push({
              accountId: transporterParty.account.id,
              debit: 0,
              credit: resolved.totalCarrierPayable,
              description: transporterDescription,
              sourceType: "PRIVATE_PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            });
          }

          // Delivery Recovery - see the identical block's comment in
          // app/api/private-phonch/route.ts (POST).
          if (resolved.totalTransporterDeliveryRecovery > 0) {
            lines.push({
              accountId: transporterParty.account.id,
              debit: resolved.totalTransporterDeliveryRecovery,
              credit: 0,
              description: `Private Phonch ${resolved.phonchNo} - Transporter Delivery Recovery`,
              sourceType: "PRIVATE_PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            });
          }
          for (const [caPartyId, amount] of resolved.caDeliveryRecoveryByPartyId) {
            if (amount <= 0) continue;
            const ca = caById.get(caPartyId)!;
            lines.push({
              accountId: ca.account!.id,
              debit: amount,
              credit: 0,
              description: `Private Phonch ${resolved.phonchNo} - Clearing Agent Delivery Recovery (${ca.partyName})`,
              sourceType: "PRIVATE_PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            });
          }

          const caPayableByPartyId = new Map<string, number>();
          for (const v of resolved.vehicles) {
            if (!v.clearingAgentPartyId || v.caPayable <= 0) continue;
            caPayableByPartyId.set(
              v.clearingAgentPartyId,
              Math.round(((caPayableByPartyId.get(v.clearingAgentPartyId) || 0) + v.caPayable) * 100) / 100
            );
          }
          for (const [caPartyId, amount] of caPayableByPartyId) {
            const ca = caById.get(caPartyId)!;
            const description = buildPrivatePhonchClearingAgentDescription(
              { phonchNo: resolved.phonchNo },
              resolved.vehicles.filter((v) => v.clearingAgentPartyId === caPartyId),
              ca.partyName,
              amount
            );
            lines.push({
              accountId: ca.account!.id,
              debit: 0,
              credit: amount,
              description,
              sourceType: "PRIVATE_PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            });
          }

          if (resolved.totalDeliveryCharges > 0) {
            const deliveryIncomeId = await getPrivatePhonchDeliveryIncomeAccountId(tx);
            lines.push({
              accountId: deliveryIncomeId,
              debit: 0,
              credit: resolved.totalDeliveryCharges,
              description: `Private Phonch ${resolved.phonchNo} - Delivery Charges`,
              sourceType: "PRIVATE_PHONCH",
              sourceId: id,
              sourceNumber: resolved.phonchNo,
            });
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
    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "privatePhonch.permanentlyDelete")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      const existing = await prisma.privatePhonch.findUnique({ where: { id }, select: { id: true, isDeleted: true } });
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

    await prisma.privatePhonch.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
    });

    return NextResponse.json({ success: true, message: "Private Phonch moved to Bin successfully." });
  } catch (error) {
    console.error("Bin private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to move Private Phonch to Bin" }, { status: 500 });
  }
}
