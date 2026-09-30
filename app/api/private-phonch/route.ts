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
  derivePrivatePhonchOverallStatus,
  PrivatePhonchValidationError,
  type PrivatePhonchInput,
} from "@/lib/private-phonch-accounting";
import {
  getPrivatePhonchCarrierRentExpenseAccountId,
  getPrivatePhonchDeliveryIncomeAccountId,
} from "@/lib/gross-accounts";
import { getBillPaymentState, resolveBillClientAccountId } from "@/lib/bill-accounting";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";
import { privatePhonchListSearchOr } from "@/lib/search-helpers";

// ============================================================
// GET /api/private-phonch - list (search)
// POST /api/private-phonch - create
//
// Mirrors app/api/phonch/route.ts's own shape exactly, adapted for a
// PAYABLE (Transporter Carrier Payable + per-Clearing-Agent CA
// Payable) instead of a single RECEIVABLE. Paid/Remaining is computed
// in one batch pass over Daily Posting lines tagged sourceType
// "PRIVATE_PHONCH" (never a stored, manually-editable field) - see
// lib/private-phonch-accounting.ts's getPrivatePhonchPaymentState().
// ============================================================

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "privatePhonch.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();

    const phonches = await prisma.privatePhonch.findMany({
      where: {
        isDeleted: false,
        // Matches the complete saved Private Phonch record, not just
        // the number/Transporter - every field a user would actually
        // search by, including per-vehicle fields (via the `some`
        // relation filter) and each vehicle's own Clearing Agent name.
        ...(search ? { OR: privatePhonchListSearchOr(search) } : {}),
      },
      include: {
        transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
        vehicles: {
          orderBy: { lineNo: "asc" },
          select: {
            vehicleName: true,
            totalRent: true,
            deliveryCharges: true,
            carrierPayable: true,
            clearingAgentPartyId: true,
            deliveryRecoveryParty: true,
            clearingAgentParty: { select: { account: { select: { id: true } } } },
            // Compact reverse Bill Book link for the List (Section 20).
            billSourceLinks: {
              where: { bill: { isDeleted: false } },
              take: 1,
              select: { bill: { select: { id: true, billNo: true } } },
            },
          },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    // ------------------------------------------------------------
    // Bill summary (Agent 2 - "PP-001 / Bill: B-1025 / Amount: Rs.
    // 43,000 / Status: Partially Paid") - batched across every distinct
    // Bill linked from any vehicle on this page, computed through the
    // SAME authoritative getBillPaymentState() the Bill list/detail
    // pages use, never re-derived. Only ever shown when a Private
    // Phonch's billed vehicles all point to exactly ONE distinct Bill -
    // when different vehicles are billed to DIFFERENT Bills, this stays
    // null and the UI falls back to the existing per-vehicle
    // vehicleBillLabels below, so one Bill's status is never wrongly
    // shown as if it applied to the whole Phonch (Section 21).
    // ------------------------------------------------------------
    const distinctBillIds = new Set<string>();
    for (const p of phonches) {
      for (const v of p.vehicles) {
        const billId = v.billSourceLinks[0]?.bill.id;
        if (billId) distinctBillIds.add(billId);
      }
    }
    const billSummaryById = new Map<string, { billId: string; billNo: string; amount: number; status: "UNPAID" | "PARTIALLY_PAID" | "PAID" }>();
    if (distinctBillIds.size > 0) {
      const bills = await prisma.bill.findMany({
        where: { id: { in: [...distinctBillIds] } },
        select: {
          id: true,
          billNo: true,
          clientParty: { select: { account: { select: { id: true } } } },
          items: { select: { rent: true, delivery: true, otherExpense: true } },
        },
      });
      for (const bill of bills) {
        const amount = Math.round(bill.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0) * 100) / 100;
        const accountId = await resolveBillClientAccountId(prisma, bill.clientParty);
        const state = accountId
          ? await getBillPaymentState(prisma, bill.id, accountId, amount)
          : { status: "UNPAID" as const };
        billSummaryById.set(bill.id, { billId: bill.id, billNo: bill.billNo, amount, status: state.status });
      }
    }

    const items = await Promise.all(
      phonches.map(async (p) => {
        // Distinct Bill ids across this Phonch's own vehicles - a
        // compact billSummary is only produced when there is exactly
        // one, per the module comment above.
        const phonchBillIds = new Set(
          p.vehicles.map((v) => v.billSourceLinks[0]?.bill.id).filter((id): id is string => !!id)
        );
        const billSummary =
          phonchBillIds.size === 1 ? billSummaryById.get([...phonchBillIds][0]) || null : null;
        const totalCarrierPayable = Math.round(p.vehicles.reduce((s, v) => s + Number(v.carrierPayable), 0) * 100) / 100;
        const totalCaPayable = Math.round(
          p.vehicles.reduce(
            (s, v) => s + Math.max(0, Number(v.totalRent) - Number(v.deliveryCharges) - Number(v.carrierPayable)),
            0
          ) * 100
        ) / 100;
        // Fully-paid (Total Rent = 0) vehicles' Delivery Charges, split
        // by WHO they're owed by (see resolvePrivatePhonchInput()'s
        // own mutual-exclusivity guard).
        const totalDeliveryRecovery = Math.round(
          p.vehicles.reduce((s, v) => s + (Number(v.totalRent) <= 0.009 ? Number(v.deliveryCharges) : 0), 0) * 100
        ) / 100;
        const totalTransporterDeliveryRecovery = Math.round(
          p.vehicles.reduce(
            (s, v) => s + (Number(v.totalRent) <= 0.009 && v.deliveryRecoveryParty !== "CLEARING_AGENT" ? Number(v.deliveryCharges) : 0),
            0
          ) * 100
        ) / 100;

        const transporterAccountId = p.transporterParty.account?.id;

        // Carrier Payable and Delivery Recovery read through the SAME
        // authoritative helpers the detail page uses - never a second,
        // separately-computed "remaining" figure that could drift out
        // of sync (see this task's own diagnosis: the old paidByKey
        // netting merged these two opposite-polarity balances into one
        // combined figure per account, which is wrong once both exist
        // together on the same Transporter account).
        const transporterState = transporterAccountId
          ? await getPrivatePhonchPaymentState(prisma, p.id, transporterAccountId, totalCarrierPayable, undefined, true)
          : { paidAmount: 0, remainingDue: totalCarrierPayable };
        const transporterRecoveryState = transporterAccountId && totalTransporterDeliveryRecovery > 0.009
          ? await getPrivatePhonchDeliveryRecoveryState(prisma, p.id, transporterAccountId, totalTransporterDeliveryRecovery)
          : { recoveredAmount: 0, remainingDue: totalTransporterDeliveryRecovery };

        const transporterPaid = transporterState.paidAmount;
        const transporterRemaining = transporterState.remainingDue;
        const transporterRecovered = transporterRecoveryState.recoveredAmount;
        const transporterRecoveryRemaining = transporterRecoveryState.remainingDue;

        // Every distinct Clearing Agent's OWN account, each read
        // through the SAME authoritative helpers - never the old
        // batched paidByKey net, which would wrongly combine a CA
        // Payable with an unrelated CA Delivery Recovery on the same
        // account (the exact contamination bug already fixed for the
        // Transporter above - see this task's own guard against a CA
        // ever having both on one Private Phonch, which keeps these
        // two reads from ever colliding on the same account).
        const caAccountByPartyId = new Map<string, string>();
        for (const v of p.vehicles) {
          if (v.clearingAgentPartyId && v.clearingAgentParty?.account?.id) {
            caAccountByPartyId.set(v.clearingAgentPartyId, v.clearingAgentParty.account.id);
          }
        }
        const caPayableByPartyId = new Map<string, number>();
        const caRecoveryByPartyId = new Map<string, number>();
        for (const v of p.vehicles) {
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

        let caPaidTotal = 0;
        let caRemaining = 0;
        for (const [partyId, amount] of caPayableByPartyId) {
          if (amount <= 0.009) continue;
          const accountId = caAccountByPartyId.get(partyId);
          if (!accountId) {
            caRemaining = Math.round((caRemaining + amount) * 100) / 100;
            continue;
          }
          const state = await getPrivatePhonchPaymentState(prisma, p.id, accountId, amount);
          caPaidTotal = Math.round((caPaidTotal + state.paidAmount) * 100) / 100;
          caRemaining = Math.round((caRemaining + state.remainingDue) * 100) / 100;
        }

        let caRecovered = 0;
        let caRecoveryRemaining = 0;
        for (const [partyId, amount] of caRecoveryByPartyId) {
          if (amount <= 0.009) continue;
          const accountId = caAccountByPartyId.get(partyId);
          if (!accountId) {
            caRecoveryRemaining = Math.round((caRecoveryRemaining + amount) * 100) / 100;
            continue;
          }
          const state = await getPrivatePhonchDeliveryRecoveryState(prisma, p.id, accountId, amount);
          caRecovered = Math.round((caRecovered + state.recoveredAmount) * 100) / 100;
          caRecoveryRemaining = Math.round((caRecoveryRemaining + state.remainingDue) * 100) / 100;
        }

        const overallStatus = derivePrivatePhonchOverallStatus({
          carrierRemaining: transporterRemaining,
          caRemaining,
          recoveryRemaining: Math.round((transporterRecoveryRemaining + caRecoveryRemaining) * 100) / 100,
        });

        const vehicleNames = p.vehicles.map((v) => v.vehicleName).filter((n): n is string => !!n && n.trim().length > 0);
        // Compact per-vehicle Bill reference for the List (Section 20)
        // - "Vehicle (Bill No)" when billed, plain vehicle name
        // otherwise. Never one misleading Bill status for the whole
        // document (Section 21).
        const vehicleBillLabels = p.vehicles
          .filter((v) => v.vehicleName && v.vehicleName.trim().length > 0)
          .map((v) => (v.billSourceLinks[0] ? `${v.vehicleName} (${v.billSourceLinks[0].bill.billNo})` : v.vehicleName!));

        return {
          id: p.id,
          phonchNo: p.phonchNo,
          date: p.date,
          billNo: p.billNo,
          transporterParty: p.transporterParty,
          vehicleCount: p.vehicles.length,
          vehicleNames,
          vehicleBillLabels,
          billSummary,
          totalCarrierPayable,
          totalCaPayable,
          totalDeliveryRecovery,
          transporterPaid,
          transporterRemaining,
          transporterRecovered,
          transporterRecoveryRemaining,
          caPaidTotal,
          caRemaining,
          caRecovered,
          caRecoveryRemaining,
          status: overallStatus,
        };
      })
    );

    return NextResponse.json({
      success: true,
      items,
      capabilities: {
        canEdit: hasPermission(currentUser, "privatePhonch.edit"),
        canBin: hasPermission(currentUser, "privatePhonch.bin"),
      },
    });
  } catch (error) {
    console.error("List private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Private Phonch list" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "privatePhonch.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const data = body as PrivatePhonchInput & { idempotencyKey?: string };

    let resolved;
    try {
      resolved = resolvePrivatePhonchInput(data);
    } catch (validationError) {
      if (validationError instanceof PrivatePhonchValidationError) {
        return NextResponse.json({ success: false, message: validationError.message }, { status: validationError.status });
      }
      throw validationError;
    }

    const phonchId = data.idempotencyKey ? `pphonch_${data.idempotencyKey}` : undefined;

    if (phonchId) {
      const alreadyProcessed = await prisma.privatePhonch.findUnique({ where: { id: phonchId } });
      if (alreadyProcessed) {
        return NextResponse.json({
          success: true,
          message: "This Private Phonch was already processed.",
          idempotentReplay: true,
          phonch: { id: alreadyProcessed.id, phonchNo: alreadyProcessed.phonchNo },
        });
      }
    }

    const existingPhonchNo = await prisma.privatePhonch.findFirst({
      where: { phonchNo: resolved.phonchNo, isDeleted: false },
      select: { id: true },
    });
    if (existingPhonchNo) {
      return NextResponse.json({ success: false, message: "Private Phonch No. already exists" }, { status: 409 });
    }

    try {
      const phonch = await prisma.$transaction(
        async (tx) => {
          const dupInTx = await tx.privatePhonch.findFirst({
            where: { phonchNo: resolved.phonchNo, isDeleted: false },
            select: { id: true },
          });
          if (dupInTx) {
            throw new PrivatePhonchValidationError("Private Phonch No. already exists", 409);
          }

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

          const caPartyIds = [...new Set(resolved.vehicles.map((v) => v.clearingAgentPartyId).filter((id): id is string => !!id))];
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

          const createdPhonch = await tx.privatePhonch.create({
            data: {
              ...(phonchId ? { id: phonchId } : {}),
              phonchNo: resolved.phonchNo,
              date: resolved.date,
              transporterPartyId: resolved.transporterPartyId,
              createdById: currentUser.userId,
              vehicles: {
                create: resolved.vehicles.map((v) => ({
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
              },
            },
          });

          // ------------------------------------------------------------
          // ONE balanced JournalEntry, exactly mirroring Showroom
          // Phonch's own single-entry-at-creation shape:
          //
          //   Dr Private Phonch Carrier Rent Expense   Total Rent
          //     Cr Transporter                          Carrier Payable
          //     Cr Clearing Agent A                     CA Payable (A's rows)
          //     Cr Clearing Agent B                     CA Payable (B's rows)
          //     Cr Private Phonch Delivery Income        Delivery Charges
          //
          // Balances because Total Rent = Carrier Payable + CA Payable
          // + Delivery Charges per vehicle (resolvePrivatePhonchInput()'s
          // own invariant, summed). Never a second JournalEntry per
          // vehicle line.
          // ------------------------------------------------------------

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

          // Skipped entirely when Total Rent is 0 (every vehicle
          // fully paid, only Delivery Recovery applies) - a zero-
          // value line has no accounting effect but would otherwise
          // clutter the Carrier Rent Expense account's own ledger.
          if (resolved.totalRent > 0) {
            lines.push({
              accountId: carrierRentExpenseId,
              debit: resolved.totalRent,
              credit: 0,
              description: transporterDescription,
              sourceType: "PRIVATE_PHONCH",
              sourceId: createdPhonch.id,
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
              sourceId: createdPhonch.id,
              sourceNumber: resolved.phonchNo,
            });
          }

          // Delivery Recovery - a genuine RECEIVABLE (opposite polarity
          // from a Payable), arising only from fully-paid (Total Rent =
          // 0) vehicles' Delivery Charges - see
          // resolvePrivatePhonchInput()'s own doc comment. Owed by
          // EITHER the Transporter or a specific Clearing Agent per
          // vehicle (never both on the same account - see the
          // mutual-exclusivity guard in resolvePrivatePhonchInput()) -
          // posted as a separate, independent line on whichever
          // account it belongs to, never netted against that same
          // account's own Payable.
          if (resolved.totalTransporterDeliveryRecovery > 0) {
            lines.push({
              accountId: transporterParty.account.id,
              debit: resolved.totalTransporterDeliveryRecovery,
              credit: 0,
              description: `Private Phonch ${resolved.phonchNo} - Transporter Delivery Recovery`,
              sourceType: "PRIVATE_PHONCH",
              sourceId: createdPhonch.id,
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
              sourceId: createdPhonch.id,
              sourceNumber: resolved.phonchNo,
            });
          }

          // Group CA Payable by Clearing Agent - the SAME Clearing
          // Agent on several vehicle rows (Case 3) sums into ONE
          // credit line, never one line per vehicle.
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
              sourceId: createdPhonch.id,
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
              sourceId: createdPhonch.id,
              sourceNumber: resolved.phonchNo,
            });
          }

          await tx.journalEntry.create({
            data: {
              entryDate: resolved.date,
              referenceType: "PRIVATE_PHONCH",
              referenceId: createdPhonch.id,
              description: transporterDescription,
              createdById: currentUser.userId,
              lines: { create: lines },
            },
          });

          await auditCreate(tx, {
            actor: actorFromUser(currentUser),
            module: "PRIVATE_PHONCH",
            entityType: "PrivatePhonch",
            entityId: createdPhonch.id,
            documentNo: createdPhonch.phonchNo,
            description: `Created Private Phonch ${createdPhonch.phonchNo} (Transporter: ${transporterParty.partyName}, ${resolved.vehicles.length} vehicle(s))`,
            newValues: {
              phonchNo: createdPhonch.phonchNo,
              transporterPartyId: resolved.transporterPartyId,
              vehicleCount: resolved.vehicles.length,
            },
            ...requestContext(request),
          });

          return createdPhonch;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json(
        { success: true, message: "Private Phonch created successfully.", phonch: { id: phonch.id, phonchNo: phonch.phonchNo } },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof PrivatePhonchValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Private Phonch could not be created due to a concurrent change. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Create private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to create Private Phonch" }, { status: 500 });
  }
}
