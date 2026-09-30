import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

// ============================================================
// SHARED SEARCH HELPERS - Global ERP Search
//
// ONE place the `where`-clause fields for each module's search are
// defined, so Global Search and each module's own list route can
// never silently drift apart. Every "*ListSearchOr" function below is
// an EXACT, unchanged extraction of that module's own existing
// route's own OR array (byte-for-byte the same fields, same
// `contains`/`insensitive` semantics) - the existing routes are
// updated to call these instead of re-declaring the array inline,
// with zero behavior change. Every "*GlobalExtraOr" function adds
// ONLY the additional fields Global Search needs beyond what that
// module's own list route already searches (per the approved Global
// Search field inventory) - these are never spliced into the
// existing module route, so that route's own behavior is provably
// unchanged.
//
// Nothing here performs a write. Nothing here creates a JournalEntry/
// JournalLine/Party/Account/AuditLog - these are pure `where`-clause
// builders and read-only id lookups only.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

// ------------------------------------------------------------
// PHONE MATCHING
//
// Stored phone values are never normalized at write time (confirmed
// during the audit) - "0300-1234567" and "03001234567" are both
// legitimately present in the data. Prisma's `contains` cannot apply
// lib/phone.ts's normalizePhone() to the STORED column, only to the
// query, so a plain `contains` on a hyphenated stored value would
// miss a digits-only query (and vice versa). This resolves it by
// comparing DIGITS ONLY on both sides, via a parameterized raw SQL
// LIKE against a `regexp_replace`-stripped version of the stored
// column - never string-interpolating the user's query into SQL text
// (the digits value below always goes through Prisma's own $queryRaw
// tagged-template parameter binding), and never writing back to the
// stored value.
// ------------------------------------------------------------

/**
 * Returns the last-10-digit "national significant number" for a
 * phone-like query (e.g. "0300-1234567", "03001234567",
 * "+923001234567", "923001234567" all reduce to "3001234567"), or
 * null if the query doesn't look phone-like (fewer than 7 digits) -
 * in which case callers should fall back to ordinary text `contains`
 * search instead. Mirrors, without duplicating, the same digit-first
 * normalization lib/phone.ts's normalizePhone() already applies.
 */
export function extractPhoneSearchDigits(query: string): string | null {
  const digits = query.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

/**
 * Finds ids in `tableName` whose `columns` (phone-like text columns)
 * contain `digits` once all non-digit formatting is stripped from the
 * stored value. `tableName`/`columns` MUST be hardcoded literals
 * supplied by the caller (never derived from request input) - only
 * `digits` is a runtime value, and it is always passed through
 * Prisma's own parameter binding, never concatenated into the SQL
 * text. Read-only.
 */
export async function findIdsByPhoneDigits(tx: Tx, tableName: string, columns: string[], digits: string | null): Promise<string[]> {
  if (!digits) return [];
  const checks = columns.map(
    (column) => Prisma.sql`regexp_replace(COALESCE(${Prisma.raw(`"${column}"`)}, ''), '[^0-9]', '', 'g') LIKE ${"%" + digits}`
  );
  const whereSql = checks.reduce((acc, cur) => Prisma.sql`${acc} OR ${cur}`);
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${tableName}"`)} WHERE ${whereSql}`
  );
  return rows.map((r) => r.id);
}

function textOr(field: string, query: string) {
  return { [field]: { contains: query, mode: "insensitive" as const } };
}

// ------------------------------------------------------------
// BILTY
// ------------------------------------------------------------

/** Exact fields app/api/bilty/route.ts's own list search already uses - unchanged. */
export function biltyListSearchOr(query: string): Prisma.BiltyWhereInput[] {
  return [
    textOr("biltyNo", query),
    textOr("consignorName", query),
    textOr("consigneeName", query),
    textOr("vehicleType", query),
    textOr("registrationNumber", query),
    textOr("clearingAgentName", query),
    { fromLocation: { name: { contains: query, mode: "insensitive" } } },
    { toLocation: { name: { contains: query, mode: "insensitive" } } },
    { clearingAgentParty: { partyName: { contains: query, mode: "insensitive" } } },
  ];
}

/** Additional fields Global Search covers for Bilty, beyond the list route above. */
export function biltyGlobalExtraOr(query: string): Prisma.BiltyWhereInput[] {
  return [
    textOr("chassisNumber", query),
    textOr("engineNumber", query),
    textOr("vehicleModel", query),
    textOr("vehicleColor", query),
    textOr("consignorPhone", query),
    textOr("consigneePhone", query),
    { consignorParty: { partyName: { contains: query, mode: "insensitive" } } },
    { consigneeParty: { partyName: { contains: query, mode: "insensitive" } } },
    { agentParty: { partyName: { contains: query, mode: "insensitive" } } },
  ];
}

// ------------------------------------------------------------
// CHALLAN (no existing search route today - Global Search only)
// ------------------------------------------------------------

export function challanGlobalSearchOr(query: string): Prisma.ChallanWhereInput[] {
  return [
    textOr("challanNo", query),
    textOr("carrierNumber", query),
    textOr("driverName", query),
    textOr("driverPhone", query),
    { transporterParty: { partyName: { contains: query, mode: "insensitive" } } },
    { bilties: { some: { bilty: { biltyNo: { contains: query, mode: "insensitive" } } } } },
  ];
}

// ------------------------------------------------------------
// BILL
// ------------------------------------------------------------

/** Exact fields app/api/bill/route.ts's own list search already uses - unchanged. */
export function billListSearchOr(query: string): Prisma.BillWhereInput[] {
  return [
    textOr("billNo", query),
    textOr("clientName", query),
    textOr("clientPhone", query),
    {
      items: {
        some: {
          OR: [
            textOr("vehicleName", query),
            textOr("fromText", query),
            textOr("toText", query),
            textOr("engineNumber", query),
            textOr("chassisNumber", query),
            textOr("regdNumber", query),
          ],
        },
      },
    },
    {
      sourceLinks: {
        some: {
          OR: [
            { privatePhonchVehicle: { phonch: { phonchNo: { contains: query, mode: "insensitive" } } } },
            { phonchVehicle: { phonch: { phonchNo: { contains: query, mode: "insensitive" } } } },
          ],
        },
      },
    },
  ];
}

/** Additional field Global Search covers for Bill: the client's own Party name, when one is selected (never for a walk-in Bill, which has no clientParty at all). */
export function billGlobalExtraOr(query: string): Prisma.BillWhereInput[] {
  return [{ clientParty: { partyName: { contains: query, mode: "insensitive" } } }];
}

// ------------------------------------------------------------
// PRIVATE PHONCH
// ------------------------------------------------------------

/** Exact fields app/api/private-phonch/route.ts's own list search already uses - unchanged. Already the most complete of any module; reused as-is for Global Search too, no extra needed. */
export function privatePhonchListSearchOr(query: string): Prisma.PrivatePhonchWhereInput[] {
  return [
    textOr("phonchNo", query),
    textOr("billNo", query),
    { transporterParty: { partyName: { contains: query, mode: "insensitive" } } },
    {
      vehicles: {
        some: {
          OR: [
            textOr("biltyNo", query),
            textOr("challanNo", query),
            textOr("chassisNumber", query),
            textOr("engineNumber", query),
            textOr("vehicleName", query),
            { clearingAgentParty: { partyName: { contains: query, mode: "insensitive" } } },
            { billSourceLinks: { some: { bill: { billNo: { contains: query, mode: "insensitive" } } } } },
          ],
        },
      },
    },
  ];
}

// ------------------------------------------------------------
// SHOWROOM PHONCH
// ------------------------------------------------------------

/** Exact fields app/api/phonch/route.ts's own list search already uses - unchanged. */
export function phonchListSearchOr(query: string): Prisma.PhonchWhereInput[] {
  return [
    textOr("phonchNo", query),
    textOr("carrierNumber", query),
    { transporterParty: { partyName: { contains: query, mode: "insensitive" } } },
  ];
}

/**
 * Additional fields Global Search covers for Showroom Phonch, beyond
 * the list route above: per-vehicle chassis/engine/name/Bilty-Challan
 * reference text, and each vehicle's own linked Party (PhonchVehicle
 * has a plain `partyId` field, not a "clearing agent" field the way
 * PrivatePhonchVehicle does - there is no clearing-agent concept on
 * this model, so this is the closest real relation, never invented).
 */
export function phonchGlobalExtraOr(query: string): Prisma.PhonchWhereInput[] {
  return [
    {
      vehicles: {
        some: {
          OR: [
            textOr("biltyNo", query),
            textOr("challanNo", query),
            textOr("chassisNumber", query),
            textOr("engineNumber", query),
            textOr("vehicleName", query),
            { party: { partyName: { contains: query, mode: "insensitive" } } },
          ],
        },
      },
    },
  ];
}

// ------------------------------------------------------------
// PARTY (no existing search at all today)
// ------------------------------------------------------------

const PARTY_TYPE_VALUES = ["CUSTOMER", "VENDOR", "BOTH", "TRANSPORTER", "CLEARING_AGENT"] as const;

export function partySearchOr(query: string): Prisma.PartyWhereInput[] {
  const or: Prisma.PartyWhereInput[] = [
    textOr("partyName", query),
    textOr("phone", query),
    textOr("whatsapp", query),
    textOr("cnicNtn", query),
    textOr("address", query),
  ];
  const normalizedType = query.trim().toUpperCase().replace(/\s+/g, "_");
  if ((PARTY_TYPE_VALUES as readonly string[]).includes(normalizedType)) {
    or.push({ partyTypes: { has: normalizedType as (typeof PARTY_TYPE_VALUES)[number] } });
  }
  return or;
}

// ------------------------------------------------------------
// ACCOUNT (no existing search at all today)
// ------------------------------------------------------------

export function accountSearchOr(query: string): Prisma.AccountWhereInput[] {
  return [
    textOr("accountName", query),
    textOr("accountCode", query),
    { party: { partyName: { contains: query, mode: "insensitive" } } },
  ];
}

// ------------------------------------------------------------
// EMPLOYEE
// ------------------------------------------------------------

/** Exact fields app/api/employees/route.ts's own list search already uses - unchanged. */
export function employeeListSearchOr(query: string): Prisma.EmployeeWhereInput[] {
  return [textOr("name", query), textOr("employeeCode", query), textOr("designation", query), textOr("phone", query)];
}
