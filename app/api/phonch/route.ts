import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  resolvePhonchInput,
  buildPhonchLedgerDescription,
  PhonchValidationError,
  type PhonchInput,
} from "@/lib/phonch-accounting";
import { getShowroomDeliveryIncomeAccountId, getClaimRecoveryAccountId } from "@/lib/gross-accounts";

// ============================================================
// GET /api/phonch - list (search/filter)
// POST /api/phonch - create
//
// Received/Remaining Due are computed in ONE batch pass over Daily
// Posting lines tagged sourceType "PHONCH" (see lib/phonch-accounting.ts's
// getPhonchPaymentState() for the single-document equivalent used by
// the detail page) - never a stored, manually-editable field.
// ============================================================

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "phonch.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();

    const phonches = await prisma.phonch.findMany({
      where: {
        isDeleted: false,
        ...(search
          ? {
              OR: [
                { phonchNo: { contains: search, mode: "insensitive" } },
                { carrierNumber: { contains: search, mode: "insensitive" } },
                { transporterParty: { partyName: { contains: search, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      include: {
        transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
        vehicles: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    const phonchIds = phonches.map((p) => p.id);
    const receiptLines = phonchIds.length
      ? await prisma.journalLine.findMany({
          where: {
            sourceType: "PHONCH",
            sourceId: { in: phonchIds },
            journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
          },
          select: { sourceId: true, debit: true, credit: true },
        })
      : [];
    const receivedByPhonchId = new Map<string, number>();
    for (const line of receiptLines) {
      const prev = receivedByPhonchId.get(line.sourceId!) || 0;
      receivedByPhonchId.set(line.sourceId!, prev + Number(line.credit) - Number(line.debit));
    }

    const items = phonches.map((p) => {
      const totalDeliveryCharges = p.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0);
      const totalOtherExpense = p.vehicles.reduce((s, v) => s + Number(v.otherExpenseAmount), 0);
      const totalClaim = p.vehicles.reduce((s, v) => s + Number(v.claimAmount), 0);
      const totalAmount = totalDeliveryCharges + totalOtherExpense + totalClaim;
      const receivedAmount = Math.max(0, Math.round((receivedByPhonchId.get(p.id) || 0) * 100) / 100);
      const remainingDue = Math.max(0, Math.round((totalAmount - receivedAmount) * 100) / 100);

      return {
        id: p.id,
        phonchNo: p.phonchNo,
        date: p.date,
        carrierNumber: p.carrierNumber,
        transporterParty: p.transporterParty,
        vehicleCount: p.vehicles.length,
        totalDeliveryCharges,
        totalOtherExpense,
        totalClaim,
        totalAmount,
        receivedAmount,
        remainingDue,
        status: remainingDue <= 0.009 ? "CLEARED" : "RECEIVABLE",
      };
    });

    return NextResponse.json({
      success: true,
      items,
      capabilities: {
        canEdit: hasPermission(currentUser, "phonch.edit"),
        canBin: hasPermission(currentUser, "phonch.bin"),
      },
    });
  } catch (error) {
    console.error("List phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Phonch list" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "phonch.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const data = body as PhonchInput & { idempotencyKey?: string };

    let resolved;
    try {
      resolved = resolvePhonchInput(data);
    } catch (validationError) {
      if (validationError instanceof PhonchValidationError) {
        return NextResponse.json({ success: false, message: validationError.message }, { status: validationError.status });
      }
      throw validationError;
    }

    const phonchId = data.idempotencyKey ? `phonch_${data.idempotencyKey}` : undefined;

    // Idempotent replay check FIRST - see app/api/payslips/route.ts for
    // the identical established pattern this mirrors.
    if (phonchId) {
      const alreadyProcessed = await prisma.phonch.findUnique({ where: { id: phonchId } });
      if (alreadyProcessed) {
        return NextResponse.json({
          success: true,
          message: "This Phonch was already processed.",
          idempotentReplay: true,
          phonch: { id: alreadyProcessed.id, phonchNo: alreadyProcessed.phonchNo },
        });
      }
    }

    const existingPhonchNo = await prisma.phonch.findFirst({
      where: { phonchNo: resolved.phonchNo, isDeleted: false },
      select: { id: true },
    });
    if (existingPhonchNo) {
      return NextResponse.json({ success: false, message: "Phonch No. already exists" }, { status: 409 });
    }

    try {
      const phonch = await prisma.$transaction(
        async (tx) => {
          // Re-check phonchNo uniqueness and Transporter account INSIDE
          // this SERIALIZABLE transaction - the checks above are only
          // advisory, exactly like the Challan creation race fix (see
          // app/api/challan/route.ts's own in-tx re-check).
          const dupInTx = await tx.phonch.findFirst({
            where: { phonchNo: resolved.phonchNo, isDeleted: false },
            select: { id: true },
          });
          if (dupInTx) {
            throw new PhonchValidationError("Phonch No. already exists", 409);
          }

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

          const vehiclePartyIds = [...new Set(resolved.vehicles.map((v) => v.partyId).filter((id): id is string => !!id))];
          if (vehiclePartyIds.length > 0) {
            const validParties = await tx.party.count({ where: { id: { in: vehiclePartyIds }, isActive: true } });
            if (validParties !== vehiclePartyIds.length) {
              throw new PhonchValidationError("One or more selected vehicle Parties were not found");
            }
          }

          const createdPhonch = await tx.phonch.create({
            data: {
              ...(phonchId ? { id: phonchId } : {}),
              phonchNo: resolved.phonchNo,
              date: resolved.date,
              transporterPartyId: resolved.transporterPartyId,
              carrierNumber: resolved.carrierNumber,
              description: resolved.description,
              createdById: currentUser.userId,
              vehicles: {
                create: resolved.vehicles.map((v) => ({
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
              },
            },
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
              sourceId: createdPhonch.id,
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
                sourceId: createdPhonch.id,
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
                sourceId: createdPhonch.id,
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
              sourceId: createdPhonch.id,
              sourceNumber: resolved.phonchNo,
            });
          }

          await tx.journalEntry.create({
            data: {
              entryDate: resolved.date,
              referenceType: "PHONCH",
              referenceId: createdPhonch.id,
              description,
              createdById: currentUser.userId,
              lines: { create: lines },
            },
          });

          return createdPhonch;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json(
        { success: true, message: "Phonch created successfully.", phonch: { id: phonch.id, phonchNo: phonch.phonchNo } },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof PhonchValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Phonch could not be created due to a concurrent change. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Create phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to create Phonch" }, { status: 500 });
  }
}
