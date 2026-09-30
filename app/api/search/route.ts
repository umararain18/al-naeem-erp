import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, type AuthUser } from "@/lib/auth";
import { hasPermission, type Permission } from "@/lib/permissions";
import {
  biltyGlobalExtraOr,
  biltyListSearchOr,
  challanGlobalSearchOr,
  billGlobalExtraOr,
  billListSearchOr,
  privatePhonchListSearchOr,
  phonchGlobalExtraOr,
  phonchListSearchOr,
  partySearchOr,
  accountSearchOr,
  employeeListSearchOr,
  extractPhoneSearchDigits,
  findIdsByPhoneDigits,
} from "@/lib/search-helpers";
import { getBillPaymentState, resolveBillClientAccountId } from "@/lib/bill-accounting";
import { getPhonchPaymentState } from "@/lib/phonch-accounting";
import { getEmployeeBalance } from "@/lib/payroll-accounting";
import { getPartyLedgerData, PartyLedgerLookupError } from "@/lib/ledger-description";

// ============================================================
// GET /api/search?q=...&scope=quick|full&module=...&page=&pageSize=
//
// Global ERP Search - READ ONLY. Every module query below is a plain
// `findMany`/`count`; nothing here ever calls `.create()`/`.update()`/
// `.delete()` on any model, and nothing here calls
// lib/audit-log.ts - searching never produces a JournalEntry,
// JournalLine, Party, Account, or AuditLog row (see the audit's own
// Section 8/29 accounting-safety requirement).
//
// AUTHORIZATION: authenticate once, then gate EACH module
// independently by that module's own existing `.view` permission
// (bilty.view/challan.view/bill.view/privatePhonch.view/phonch.view/
// parties.view/accounts.view/employees.view) - deliberately NOT the
// `accounts.create` blanket gate app/api/daily-posting/search-documents
// uses; that endpoint is untouched by this file and keeps working
// exactly as it did before.
//
// FINANCIAL VALUES: only ever taken from the SAME authoritative
// helper each module's own detail/list page already uses
// (getBillPaymentState/getPhonchPaymentState/getEmployeeBalance/
// getPartyLedgerData) or from an already-stored, non-derived column
// (Bilty.toPay). A module with no safe single-value helper (Challan's
// settlement, Private Phonch's multi-dimensional Payable/Recovery
// split) has its `amount`/`status` fields simply omitted here rather
// than recomputed or invented - see this file's own per-module
// comments for exactly which are covered and why.
//
// WALK-IN BILL SAFETY: a Bill's own `clientName`/`clientPhone` are
// always used for display (never a live Party re-read), and a
// walk-in Bill (clientPartyId null) is never attributed to any Party
// in the results below - it simply has `party: null`. The shared
// "Bill Book - Walk-in Customers" account is NEVER surfaced as if it
// belonged to one client, and a walk-in Bill's own amount is always
// resolved through getBillPaymentState() filtered to that ONE Bill's
// own id, never the shared account's aggregate balance.
// ============================================================

type Scope = "quick" | "full";
const QUICK_TAKE = 6;
const FULL_PAGE_SIZE_DEFAULT = 25;
const FULL_PAGE_SIZE_MAX = 50;

type SearchResultItem = {
  entityType: string;
  id: string;
  documentNo: string | null;
  title: string;
  subtitle: string | null;
  matchedField: string | null;
  date: string | null;
  status: string | null;
  amount: { value: number; label: string } | null;
  party: { id: string; partyName: string } | null;
  vehicle: { registration: string | null; chassis: string | null; engine: string | null } | null;
  route: string | null;
  relationshipSummary: string | null;
  availableActions: string[];
  href: string | null;
};

type SearchGroup = {
  type: string;
  label: string;
  count: number;
  results: SearchResultItem[];
};

/** Best-effort, display-only label of which field actually matched - never an extra query, just a string check against fields already fetched for the result. */
function pickMatchedField(candidates: Record<string, string | null | undefined>, query: string): string | null {
  const q = query.trim().toLowerCase();
  for (const [field, value] of Object.entries(candidates)) {
    if (value && value.toLowerCase().includes(q)) return field;
  }
  return null;
}

/** OPEN is always offered when a real detail page exists (deleted rows are never included in search results at all - see each module's own `isDeleted: false` filter below, matching Section 27's "never expose binned records"). EDIT/BIN are offered purely from the caller's own module permission - the actual mutation route remains the final, authoritative check (Section 11: a shown action is not a guarantee it will succeed). */
function baseActions(user: AuthUser, editPerm?: Permission, binPerm?: Permission): string[] {
  const actions = ["OPEN"];
  if (editPerm && hasPermission(user, editPerm)) actions.push("EDIT");
  if (binPerm && hasPermission(user, binPerm)) actions.push("BIN");
  return actions;
}

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") || "").trim();
    const scope: Scope = searchParams.get("scope") === "full" ? "full" : "quick";
    const moduleFilter = searchParams.get("module")?.trim().toUpperCase() || null;
    // See app/api/bilty/route.ts's identical guard - a syntactically
    // valid but astronomically large `page` must never reach Prisma's
    // `skip` calculation (it overflows there and throws). A garbage/
    // non-numeric value still falls back to page 1 exactly as before.
    const rawPage = searchParams.get("page");
    const parsedPage = rawPage ? parseInt(rawPage, 10) : 1;
    if (rawPage && !Number.isNaN(parsedPage) && !Number.isSafeInteger(parsedPage)) {
      return NextResponse.json(
        { success: false, message: "Invalid page number" },
        { status: 400 }
      );
    }
    const page = Math.max(1, parsedPage || 1);
    const pageSize = Math.min(FULL_PAGE_SIZE_MAX, Math.max(1, parseInt(searchParams.get("pageSize") || String(FULL_PAGE_SIZE_DEFAULT), 10) || FULL_PAGE_SIZE_DEFAULT));
    const dateFromParam = searchParams.get("dateFrom");
    const dateToParam = searchParams.get("dateTo");
    // Only meaningful for modules with their own real date field
    // (Bilty.date/Challan.loadingDate/Bill.date/PrivatePhonch.date/
    // Phonch.date) - Party/Employee/Account have none, so this filter
    // is simply not applied to those groups below.
    const dateRange =
      dateFromParam || dateToParam
        ? {
            ...(dateFromParam ? { gte: new Date(`${dateFromParam}T00:00:00`) } : {}),
            ...(dateToParam ? { lte: new Date(`${dateToParam}T23:59:59.999`) } : {}),
          }
        : null;

    if (!q) {
      return NextResponse.json({ success: true, query: q, scope, groups: [], total: 0 });
    }

    const wantsModule = (type: string) => !moduleFilter || moduleFilter === type;
    const take = scope === "quick" ? QUICK_TAKE : pageSize;
    const skip = scope === "quick" ? 0 : (page - 1) * pageSize;

    // Phone-digit ids are resolved ONCE per relevant table and reused
    // across quick/full - never recomputed per result (Section 32).
    const phoneDigits = extractPhoneSearchDigits(q);
    const [partyPhoneIds, biltyPhoneIds, challanPhoneIds, billPhoneIds, employeePhoneIds] = await Promise.all([
      phoneDigits ? findIdsByPhoneDigits(prisma, "Party", ["phone", "whatsapp"], phoneDigits) : Promise.resolve<string[]>([]),
      phoneDigits ? findIdsByPhoneDigits(prisma, "Bilty", ["consignorPhone", "consigneePhone"], phoneDigits) : Promise.resolve<string[]>([]),
      phoneDigits ? findIdsByPhoneDigits(prisma, "Challan", ["driverPhone"], phoneDigits) : Promise.resolve<string[]>([]),
      phoneDigits ? findIdsByPhoneDigits(prisma, "Bill", ["clientPhone"], phoneDigits) : Promise.resolve<string[]>([]),
      phoneDigits ? findIdsByPhoneDigits(prisma, "Employee", ["phone"], phoneDigits) : Promise.resolve<string[]>([]),
    ]);

    const groups: SearchGroup[] = [];

    // ------------------------------------------------------------
    // PARTY
    // ------------------------------------------------------------
    if (wantsModule("PARTY") && hasPermission(currentUser, "parties.view")) {
      const or = [...partySearchOr(q), ...(partyPhoneIds.length ? [{ id: { in: partyPhoneIds } }] : [])];
      const where = { OR: or };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.party.count({ where }) : Promise.resolve(0),
        prisma.party.findMany({ where, take, skip, orderBy: { partyName: "asc" } }),
      ]);

      const results: SearchResultItem[] = await Promise.all(
        rows.map(async (p) => {
          let relationshipSummary: string | null = null;
          let amount: SearchResultItem["amount"] = null;

          // Relationship counts + ledger balance are only computed for
          // Quick Search's small capped result set (Section 23/17) -
          // Full Search defers this to the Party's own Ledger page,
          // never repeated across up to 50 paginated rows.
          if (scope === "quick") {
            const [biltyCount, challanCount, privatePhonchCount, showroomPhonchCount, billCount] = await Promise.all([
              prisma.bilty.count({
                where: {
                  isDeleted: false,
                  OR: [{ consignorPartyId: p.id }, { consigneePartyId: p.id }, { clearingAgentPartyId: p.id }, { agentPartyId: p.id }],
                },
              }),
              prisma.challan.count({ where: { isDeleted: false, transporterPartyId: p.id } }),
              prisma.privatePhonch.count({
                where: { isDeleted: false, OR: [{ transporterPartyId: p.id }, { vehicles: { some: { clearingAgentPartyId: p.id } } }] },
              }),
              prisma.phonch.count({
                where: { isDeleted: false, OR: [{ transporterPartyId: p.id }, { vehicles: { some: { partyId: p.id } } }] },
              }),
              // NEVER counts a walk-in Bill (clientPartyId null) here -
              // filtering by this exact partyId already excludes them.
              prisma.bill.count({ where: { isDeleted: false, clientPartyId: p.id } }),
            ]);
            const parts = [
              biltyCount > 0 ? `${biltyCount} Bilty(ies)` : null,
              challanCount > 0 ? `${challanCount} Challan(s)` : null,
              privatePhonchCount > 0 ? `${privatePhonchCount} Private Phonch(es)` : null,
              showroomPhonchCount > 0 ? `${showroomPhonchCount} Showroom Phonch(es)` : null,
              billCount > 0 ? `${billCount} Bill(s)` : null,
            ].filter(Boolean);
            relationshipSummary = parts.length ? parts.join(" · ") : "No related documents";

            try {
              const ledger = await getPartyLedgerData(p.id, { order: "asc" });
              if (ledger.summary.balanceType !== "SETTLED") {
                amount = {
                  value: Math.abs(ledger.summary.closingBalance),
                  label: ledger.summary.balanceType === "RECEIVABLE" ? "Receivable" : "Payable",
                };
              }
            } catch (err) {
              // PARTY_NOT_FOUND/NO_ACCOUNT - genuinely no safe balance to
              // show (Section 15: omit rather than invent).
              if (!(err instanceof PartyLedgerLookupError)) throw err;
            }
          }

          return {
            entityType: "PARTY",
            id: p.id,
            documentNo: null,
            title: p.partyName,
            subtitle: p.partyTypes.join(", ") || null,
            matchedField: pickMatchedField({ partyName: p.partyName, phone: p.phone, whatsapp: p.whatsapp, cnicNtn: p.cnicNtn, address: p.address }, q),
            date: null,
            status: p.isActive ? "Active" : "Inactive",
            amount,
            party: null,
            vehicle: null,
            route: null,
            relationshipSummary,
            availableActions: baseActions(currentUser, "parties.edit").concat(hasPermission(currentUser, "parties.delete") ? ["DELETE"] : []),
            href: `/parties/${p.id}/ledger`,
          };
        })
      );

      groups.push({ type: "PARTY", label: "Parties", count: scope === "full" ? total : results.length, results });
    }

    // ------------------------------------------------------------
    // BILTY
    // ------------------------------------------------------------
    if (wantsModule("BILTY") && hasPermission(currentUser, "bilty.view")) {
      const or = [...biltyListSearchOr(q), ...biltyGlobalExtraOr(q), ...(biltyPhoneIds.length ? [{ id: { in: biltyPhoneIds } }] : [])];
      const where = { isDeleted: false, OR: or, ...(dateRange ? { date: dateRange } : {}) };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.bilty.count({ where }) : Promise.resolve(0),
        prisma.bilty.findMany({
          where,
          take,
          skip,
          orderBy: { date: "desc" },
          include: {
            fromLocation: { select: { name: true } },
            toLocation: { select: { name: true } },
            consigneeParty: { select: { id: true, partyName: true } },
          },
        }),
      ]);

      const results: SearchResultItem[] = rows.map((b) => ({
        entityType: "BILTY",
        id: b.id,
        documentNo: b.biltyNo,
        title: `Bilty ${b.biltyNo}`,
        subtitle: `${b.fromLocation.name} → ${b.toLocation.name}`,
        matchedField: pickMatchedField(
          {
            biltyNo: b.biltyNo,
            consignorName: b.consignorName,
            consigneeName: b.consigneeName,
            registrationNumber: b.registrationNumber,
            chassisNumber: b.chassisNumber,
            engineNumber: b.engineNumber,
            clearingAgentName: b.clearingAgentName,
          },
          q
        ),
        date: b.date.toISOString(),
        status: b.status,
        // Bilty.toPay is an already-stored, non-derived column (never
        // recomputed from JournalLines) - the same value the Bilty
        // list/detail pages already display directly.
        amount: { value: Number(b.toPay), label: "To Pay" },
        party: b.consigneeParty ? { id: b.consigneeParty.id, partyName: b.consigneeParty.partyName } : null,
        vehicle: { registration: b.registrationNumber, chassis: b.chassisNumber, engine: b.engineNumber },
        route: `${b.fromLocation.name} → ${b.toLocation.name}`,
        relationshipSummary: null,
        availableActions: baseActions(currentUser, "bilty.edit", "bilty.bin"),
        href: `/bilty/${b.id}`,
      }));

      groups.push({ type: "BILTY", label: "Bilty", count: scope === "full" ? total : results.length, results });
    }

    // ------------------------------------------------------------
    // CHALLAN
    // ------------------------------------------------------------
    if (wantsModule("CHALLAN") && hasPermission(currentUser, "challan.view")) {
      const or = [...challanGlobalSearchOr(q), ...(challanPhoneIds.length ? [{ id: { in: challanPhoneIds } }] : [])];
      const where = { isDeleted: false, OR: or, ...(dateRange ? { loadingDate: dateRange } : {}) };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.challan.count({ where }) : Promise.resolve(0),
        prisma.challan.findMany({
          where,
          take,
          skip,
          orderBy: { loadingDate: "desc" },
          include: {
            transporterParty: { select: { id: true, partyName: true } },
            bilties: {
              take: 1,
              orderBy: { addedAt: "asc" },
              select: { bilty: { select: { fromLocation: { select: { name: true } }, toLocation: { select: { name: true } } } } },
            },
          },
        }),
      ]);

      // Deliberately no `amount`/settlement value here - Challan has no
      // single authoritative scalar (Receivable/Payable are always kept
      // separate; computeChallanSettlementSummary is a multi-field,
      // non-trivial calculation) - omitted per Section 15 rather than
      // invented or duplicated for every quick result.
      const results: SearchResultItem[] = rows.map((c) => {
        const firstBilty = c.bilties[0]?.bilty;
        return {
          entityType: "CHALLAN",
          id: c.id,
          documentNo: c.challanNo,
          title: `Challan ${c.challanNo}`,
          subtitle: c.transporterParty?.partyName || null,
          matchedField: pickMatchedField({ challanNo: c.challanNo, carrierNumber: c.carrierNumber, driverName: c.driverName }, q),
          date: c.loadingDate.toISOString(),
          status: c.isSettled ? `${c.status} (Settled)` : c.status,
          amount: null,
          party: c.transporterParty ? { id: c.transporterParty.id, partyName: c.transporterParty.partyName } : null,
          vehicle: null,
          route: firstBilty ? `${firstBilty.fromLocation.name} → ${firstBilty.toLocation.name}` : null,
          relationshipSummary: null,
          availableActions: baseActions(currentUser, "challan.edit", "challan.bin"),
          href: `/challan/${c.id}`,
        };
      });

      groups.push({ type: "CHALLAN", label: "Challan", count: scope === "full" ? total : results.length, results });
    }

    // ------------------------------------------------------------
    // BILL
    // ------------------------------------------------------------
    if (wantsModule("BILL") && hasPermission(currentUser, "bill.view")) {
      const or = [...billListSearchOr(q), ...billGlobalExtraOr(q), ...(billPhoneIds.length ? [{ id: { in: billPhoneIds } }] : [])];
      const where = { isDeleted: false, OR: or, ...(dateRange ? { date: dateRange } : {}) };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.bill.count({ where }) : Promise.resolve(0),
        prisma.bill.findMany({
          where,
          take,
          skip,
          orderBy: { date: "desc" },
          include: {
            clientParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
            items: { select: { rent: true, delivery: true, otherExpense: true, vehicleName: true } },
          },
        }),
      ]);

      const results: SearchResultItem[] = await Promise.all(
        rows.map(async (bill) => {
          const totalAmount = Math.round(bill.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0) * 100) / 100;
          // Walk-in safety: resolveBillClientAccountId() falls back to
          // the SHARED walk-in account only for the accounting lookup
          // itself - it is never treated as "this client's account" for
          // display, and the resulting state is always scoped to this
          // ONE Bill's own id (getBillPaymentState filters by sourceId).
          const accountId = await resolveBillClientAccountId(prisma, bill.clientParty);
          const state = accountId
            ? await getBillPaymentState(prisma, bill.id, accountId, totalAmount)
            : { receivedAmount: 0, remainingDue: totalAmount, status: "UNPAID" as const };

          return {
            entityType: "BILL",
            id: bill.id,
            documentNo: bill.billNo,
            title: `Bill ${bill.billNo}`,
            // clientName/clientPhone are the Bill's own snapshot fields -
            // used for display for BOTH an existing-Party client and a
            // walk-in client, never a live re-read of the Party.
            subtitle: bill.clientName,
            matchedField: pickMatchedField(
              { billNo: bill.billNo, clientName: bill.clientName, clientPhone: bill.clientPhone },
              q
            ),
            date: bill.date.toISOString(),
            status: state.status,
            amount: { value: totalAmount, label: "Bill Total" },
            // Only ever set when clientPartyId is a REAL, selected Party -
            // null for a walk-in client, matching Section 14's locked rule.
            party: bill.clientParty ? { id: bill.clientParty.id, partyName: bill.clientParty.partyName } : null,
            vehicle: null,
            route: null,
            relationshipSummary: `Received Rs. ${Math.round(state.receivedAmount).toLocaleString()} · Remaining Rs. ${Math.round(state.remainingDue).toLocaleString()}`,
            availableActions: baseActions(currentUser, "bill.edit", "bill.bin"),
            href: `/bill/${bill.id}`,
          };
        })
      );

      groups.push({ type: "BILL", label: "Bill", count: scope === "full" ? total : results.length, results });
    }

    // ------------------------------------------------------------
    // PRIVATE PHONCH
    // ------------------------------------------------------------
    if (wantsModule("PRIVATE_PHONCH") && hasPermission(currentUser, "privatePhonch.view")) {
      const where = { isDeleted: false, OR: privatePhonchListSearchOr(q), ...(dateRange ? { date: dateRange } : {}) };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.privatePhonch.count({ where }) : Promise.resolve(0),
        prisma.privatePhonch.findMany({
          where,
          take,
          skip,
          orderBy: { date: "desc" },
          include: { transporterParty: { select: { id: true, partyName: true } }, _count: { select: { vehicles: true } } },
        }),
      ]);

      // Deliberately no `amount`/`status` - Private Phonch's own state
      // (Carrier Rent Payable, CA Payable per Clearing Agent, Delivery
      // Recovery) is a genuinely multi-dimensional split this codebase
      // never blends into one number even on its own detail page - see
      // lib/private-phonch-accounting.ts. Omitted per Section 15 rather
      // than collapsed into a misleading single value.
      const results: SearchResultItem[] = rows.map((pp) => ({
        entityType: "PRIVATE_PHONCH",
        id: pp.id,
        documentNo: pp.phonchNo,
        title: `Private Phonch ${pp.phonchNo}`,
        subtitle: pp.transporterParty.partyName,
        matchedField: pickMatchedField({ phonchNo: pp.phonchNo, billNo: pp.billNo }, q),
        date: pp.date.toISOString(),
        status: null,
        amount: null,
        party: { id: pp.transporterParty.id, partyName: pp.transporterParty.partyName },
        vehicle: null,
        route: null,
        relationshipSummary: `${pp._count.vehicles} Vehicle(s)`,
        availableActions: baseActions(currentUser, "privatePhonch.edit", "privatePhonch.bin"),
        href: `/private-phonch/${pp.id}`,
      }));

      groups.push({ type: "PRIVATE_PHONCH", label: "Private Phonch", count: scope === "full" ? total : results.length, results });
    }

    // ------------------------------------------------------------
    // SHOWROOM PHONCH
    // ------------------------------------------------------------
    if (wantsModule("SHOWROOM_PHONCH") && hasPermission(currentUser, "phonch.view")) {
      const where = { isDeleted: false, OR: [...phonchListSearchOr(q), ...phonchGlobalExtraOr(q)], ...(dateRange ? { date: dateRange } : {}) };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.phonch.count({ where }) : Promise.resolve(0),
        prisma.phonch.findMany({
          where,
          take,
          skip,
          orderBy: { date: "desc" },
          include: {
            transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
            vehicles: { select: { deliveryCharges: true, otherExpenseAmount: true, claimAmount: true } },
          },
        }),
      ]);

      const results: SearchResultItem[] = await Promise.all(
        rows.map(async (p) => {
          const totalAmount = p.vehicles.reduce((s, v) => s + Number(v.deliveryCharges) + Number(v.otherExpenseAmount) + Number(v.claimAmount), 0);
          const state = p.transporterParty.account
            ? await getPhonchPaymentState(prisma, p.id, p.transporterParty.account.id, totalAmount)
            : { receivedAmount: 0, remainingDue: totalAmount, status: "RECEIVABLE" as const };

          return {
            entityType: "SHOWROOM_PHONCH",
            id: p.id,
            documentNo: p.phonchNo,
            title: `Showroom Phonch ${p.phonchNo}`,
            subtitle: p.transporterParty.partyName,
            matchedField: pickMatchedField({ phonchNo: p.phonchNo, carrierNumber: p.carrierNumber }, q),
            date: p.date.toISOString(),
            status: state.status,
            amount: { value: state.remainingDue, label: "Remaining" },
            party: { id: p.transporterParty.id, partyName: p.transporterParty.partyName },
            vehicle: null,
            route: null,
            relationshipSummary: p.carrierNumber ? `Carrier: ${p.carrierNumber}` : null,
            availableActions: baseActions(currentUser, "phonch.edit", "phonch.bin"),
            href: `/phonch/${p.id}`,
          };
        })
      );

      groups.push({ type: "SHOWROOM_PHONCH", label: "Showroom Phonch", count: scope === "full" ? total : results.length, results });
    }

    // ------------------------------------------------------------
    // EMPLOYEE (no detail page exists - links to the list page)
    // ------------------------------------------------------------
    if (wantsModule("EMPLOYEE") && hasPermission(currentUser, "employees.view")) {
      const or = [...employeeListSearchOr(q), ...(employeePhoneIds.length ? [{ id: { in: employeePhoneIds } }] : [])];
      const where = { isDeleted: false, OR: or };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.employee.count({ where }) : Promise.resolve(0),
        prisma.employee.findMany({ where, take, skip, orderBy: { name: "asc" }, include: { account: { select: { id: true } } } }),
      ]);

      const results: SearchResultItem[] = await Promise.all(
        rows.map(async (e) => {
          const balance = e.account ? await getEmployeeBalance(prisma, e.account.id) : null;
          return {
            entityType: "EMPLOYEE",
            id: e.id,
            documentNo: e.employeeCode,
            title: e.name,
            subtitle: e.designation,
            matchedField: pickMatchedField({ name: e.name, employeeCode: e.employeeCode, designation: e.designation, phone: e.phone }, q),
            date: null,
            status: e.isActive ? "Active" : "Inactive",
            amount: balance && balance.status !== "No Activity" ? { value: Math.abs(balance.balance), label: balance.status } : null,
            party: null,
            vehicle: null,
            route: null,
            relationshipSummary: null,
            availableActions: baseActions(currentUser, "employees.edit"),
            // No per-employee detail page exists (confirmed during the
            // audit) - links to the closest legitimate existing page,
            // never a fabricated route.
            href: "/employees",
          };
        })
      );

      groups.push({ type: "EMPLOYEE", label: "Employees", count: scope === "full" ? total : results.length, results });
    }

    // ------------------------------------------------------------
    // ACCOUNT (no detail page exists - links to the list page)
    // ------------------------------------------------------------
    if (wantsModule("ACCOUNT") && hasPermission(currentUser, "accounts.view")) {
      const where = { OR: accountSearchOr(q) };
      const [total, rows] = await Promise.all([
        scope === "full" ? prisma.account.count({ where }) : Promise.resolve(0),
        prisma.account.findMany({
          where,
          take,
          skip,
          orderBy: [{ accountType: "asc" }, { accountName: "asc" }],
          select: { id: true, accountName: true, accountCode: true, accountType: true, category: true, isActive: true, isSystem: true, party: { select: { partyName: true } } },
        }),
      ]);

      const results: SearchResultItem[] = rows.map((a) => ({
        entityType: "ACCOUNT",
        id: a.id,
        documentNo: a.accountCode,
        title: a.accountName,
        subtitle: `${a.accountType} · ${a.category}`,
        matchedField: pickMatchedField({ accountName: a.accountName, accountCode: a.accountCode, partyName: a.party?.partyName }, q),
        date: null,
        status: a.isActive ? "Active" : "Inactive",
        amount: null,
        party: null,
        vehicle: null,
        route: null,
        relationshipSummary: null,
        // System accounts can only ever have name/description edited
        // (never deleted) - see app/api/accounts/[id]/route.ts's own
        // guard - so DELETE is never offered here for one, using the
        // already-selected `isSystem` flag rather than an extra query.
        availableActions: baseActions(currentUser, "accounts.edit").concat(!a.isSystem && hasPermission(currentUser, "accounts.delete") ? ["DELETE"] : []),
        href: "/accounts",
      }));

      groups.push({ type: "ACCOUNT", label: "Accounts", count: scope === "full" ? total : results.length, results });
    }

    const total = groups.reduce((s, g) => s + g.count, 0);

    return NextResponse.json({
      success: true,
      query: q,
      scope,
      page: scope === "full" ? page : undefined,
      pageSize: scope === "full" ? pageSize : undefined,
      groups,
      total,
    });
  } catch (error) {
    console.error("Global search error:", error);
    return NextResponse.json({ success: false, message: "Unable to perform search" }, { status: 500 });
  }
}
