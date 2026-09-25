import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { payrollMonthLabel } from "@/lib/payroll-accounting";

function startOfDay(value: string) {
  return new Date(`${value}T00:00:00`);
}

function endOfDay(value: string) {
  const end = startOfDay(value);
  end.setDate(end.getDate() + 1);
  return end;
}

type BinItem = {
  type: "BILTY" | "CHALLAN" | "PAYSLIP" | "JOURNAL_ENTRY" | "DAILY_POSTING";
  id: string;
  reference: string;
  title: string;
  deletedAt: string;
  deletedBy: {
    id: string;
    fullName: string;
    username: string;
  } | null;
  moduleUrl: string;
  capabilities: {
    canRestore: boolean;
    canPermanentlyDelete: boolean;
  };
};

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "bin.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "ALL";
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search")?.trim();

    const deletedAt: { gte?: Date; lt?: Date } = {};

    if (from) {
      const date = startOfDay(from);
      if (Number.isNaN(date.getTime())) {
        return NextResponse.json(
          { success: false, message: "Invalid from date" },
          { status: 400 }
        );
      }
      deletedAt.gte = date;
    }

    if (to) {
      const date = endOfDay(to);
      if (Number.isNaN(date.getTime())) {
        return NextResponse.json(
          { success: false, message: "Invalid to date" },
          { status: 400 }
        );
      }
      deletedAt.lt = date;
    }

    const biltyCanRestore = hasPermission(currentUser, "bilty.restore");
    const biltyCanPermanentlyDelete = hasPermission(currentUser, "bilty.permanentlyDelete");
    const challanCanRestore = hasPermission(currentUser, "challan.restore");
    const challanCanPermanentlyDelete = hasPermission(currentUser, "challan.permanentlyDelete");
    const journalCanRestore = hasPermission(currentUser, "accountingTransactions.restore");
    const journalCanPermanentlyDelete = hasPermission(currentUser, "accountingTransactions.permanentlyDelete");
    // Matches the exact permission app/api/payslips/[id]/restore/route.ts
    // itself requires - no separate payslip-permanent-delete capability
    // exists (app/api/payslips/[id]/route.ts's DELETE only ever soft-
    // deletes, mirroring Employee's own bin-only design).
    const payslipCanRestore = hasPermission(currentUser, "accountingTransactions.restore");

    const items: BinItem[] = [];

    // Bilties
    if (type === "ALL" || type === "BILTY") {
      const bilties = await prisma.bilty.findMany({
        where: {
          isDeleted: true,
          ...(Object.keys(deletedAt).length > 0 ? { deletedAt } : {}),
          ...(search
            ? {
                OR: [
                  { biltyNo: { contains: search, mode: "insensitive" } },
                  { consignorName: { contains: search, mode: "insensitive" } },
                  { consigneeName: { contains: search, mode: "insensitive" } },
                  { notes: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        include: {
          fromLocation: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
          deletedBy: { select: { id: true, fullName: true, username: true } },
        },
        orderBy: [{ deletedAt: "desc" }, { date: "desc" }],
      });

      for (const bilty of bilties) {
        items.push({
          type: "BILTY",
          id: bilty.id,
          reference: bilty.biltyNo,
          title: `${bilty.fromLocation.name} → ${bilty.toLocation.name}`,
          deletedAt: bilty.deletedAt ? new Date(bilty.deletedAt).toISOString() : "",
          deletedBy: bilty.deletedBy,
          moduleUrl: `/bilty/${bilty.id}`,
          capabilities: {
            canRestore: biltyCanRestore,
            canPermanentlyDelete: biltyCanPermanentlyDelete,
          },
        });
      }
    }

    // Challans
    if (type === "ALL" || type === "CHALLAN") {
      const challanWhere: Prisma.ChallanWhereInput = {
        isDeleted: true,
        ...(Object.keys(deletedAt).length > 0 ? { deletedAt } : {}),
      };

      if (search) {
        challanWhere.OR = [
          { challanNo: { contains: search, mode: "insensitive" } },
          { driverName: { contains: search, mode: "insensitive" } },
          { driverPhone: { contains: search, mode: "insensitive" } },
          { carrierNumber: { contains: search, mode: "insensitive" } },
          { transporterParty: { partyName: { contains: search, mode: "insensitive" } } },
        ];
      }

      const challans = await prisma.challan.findMany({
        where: challanWhere,
        include: {
          transporterParty: { select: { id: true, partyName: true } },
          deletedBy: { select: { id: true, fullName: true, username: true } },
        },
        orderBy: [{ deletedAt: "desc" }, { loadingDate: "desc" }],
      });

      for (const challan of challans) {
        const transporter = challan.transporterParty?.partyName || "—";
        items.push({
          type: "CHALLAN",
          id: challan.id,
          reference: challan.challanNo,
          title: `${transporter} / ${new Date(challan.loadingDate).toLocaleDateString()}`,
          deletedAt: challan.deletedAt ? new Date(challan.deletedAt).toISOString() : "",
          deletedBy: challan.deletedBy,
          moduleUrl: `/challan/${challan.id}`,
          capabilities: {
            canRestore: challanCanRestore,
            canPermanentlyDelete: challanCanPermanentlyDelete,
          },
        });
      }
    }

    // Payslips - a dedicated bin item, NOT surfaced via the generic
    // Journal Entries bucket below (which explicitly excludes
    // PAYROLL_SALARY). Restoring a Payslip must go through
    // POST /api/payslips/[id]/restore, the only place that keeps
    // Payslip.isDeleted and its PAYROLL_SALARY JournalEntry.isDeleted
    // in sync - the generic accounting-transactions restore route
    // only ever touches the JournalEntry side.
    if (type === "ALL" || type === "PAYSLIP") {
      const payslipWhere: Prisma.PayslipWhereInput = {
        isDeleted: true,
        ...(Object.keys(deletedAt).length > 0 ? { deletedAt } : {}),
      };

      if (search) {
        payslipWhere.OR = [
          { payslipNo: { contains: search, mode: "insensitive" } },
          { employee: { name: { contains: search, mode: "insensitive" } } },
          { employee: { employeeCode: { contains: search, mode: "insensitive" } } },
        ];
      }

      const payslips = await prisma.payslip.findMany({
        where: payslipWhere,
        include: {
          employee: { select: { id: true, name: true, employeeCode: true } },
          deletedBy: { select: { id: true, fullName: true, username: true } },
        },
        orderBy: [{ deletedAt: "desc" }, { payDate: "desc" }],
      });

      for (const payslip of payslips) {
        items.push({
          type: "PAYSLIP",
          id: payslip.id,
          reference: payslip.payslipNo,
          title: `${payslip.employee.name} (${payslip.employee.employeeCode}) - ${payrollMonthLabel(payslip.payrollMonth)}`,
          deletedAt: payslip.deletedAt ? new Date(payslip.deletedAt).toISOString() : "",
          deletedBy: payslip.deletedBy,
          moduleUrl: `/employees`,
          capabilities: {
            canRestore: payslipCanRestore,
            // No payslip-permanent-delete capability exists (see
            // payslipCanRestore's comment above) - never true.
            canPermanentlyDelete: false,
          },
        });
      }
    }

    // Journal Entries
    if (type === "ALL" || type === "JOURNAL_ENTRY" || type === "DAILY_POSTING") {
      const journalWhere: Prisma.JournalEntryWhereInput = {
        isDeleted: true,
        // Surfaced through the dedicated Payslip bin item above instead
        // (see comment there for why this exclusion is required).
        referenceType: { not: "PAYROLL_SALARY" },
        ...(Object.keys(deletedAt).length > 0 ? { deletedAt } : {}),
      };

      if (type === "DAILY_POSTING") {
        journalWhere.referenceType = "DAILY_POSTING";
      } else if (type === "JOURNAL_ENTRY") {
        journalWhere.OR = [
          { referenceType: { not: "DAILY_POSTING" } },
          { referenceType: null },
        ];
      }

      if (search) {
        journalWhere.OR = [
          { description: { contains: search, mode: "insensitive" } },
          { referenceType: { contains: search, mode: "insensitive" } },
          { referenceId: { contains: search, mode: "insensitive" } },
        ];
      }

      const entries = await prisma.journalEntry.findMany({
        where: journalWhere,
        include: {
          deletedBy: { select: { id: true, fullName: true, username: true } },
        },
        orderBy: [{ deletedAt: "desc" }, { entryDate: "desc" }],
      });

      for (const entry of entries) {
        const entryType = entry.referenceType === "DAILY_POSTING" ? "DAILY_POSTING" : "JOURNAL_ENTRY";
        items.push({
          type: entryType,
          id: entry.id,
          reference: entry.referenceType || "DIRECT",
          title: entry.description || entry.referenceId || entry.id,
          deletedAt: entry.deletedAt ? new Date(entry.deletedAt).toISOString() : "",
          deletedBy: entry.deletedBy,
          moduleUrl: `/cash-book`,
          capabilities: {
            canRestore: journalCanRestore,
            canPermanentlyDelete: journalCanPermanentlyDelete,
          },
        });
      }
    }

    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));

    return NextResponse.json({
      success: true,
      items,
      total: items.length,
      capabilities: {
        canRestoreBilty: biltyCanRestore,
        canPermanentlyDeleteBilty: biltyCanPermanentlyDelete,
        canRestoreChallan: challanCanRestore,
        canPermanentlyDeleteChallan: challanCanPermanentlyDelete,
        canRestorePayslip: payslipCanRestore,
        canRestoreJournalEntry: journalCanRestore,
        canPermanentlyDeleteJournalEntry: journalCanPermanentlyDelete,
      },
    });
  } catch (error) {
    console.error("Get centralized Bin error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load Bin" },
      { status: 500 }
    );
  }
}
