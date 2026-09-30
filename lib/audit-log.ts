import type { Prisma, PrismaClient, AuditAction } from "@prisma/client";

// ============================================================
// CENTRAL AUDIT LOG HELPER - the ONE place every module writes an
// AuditLog row from. See model AuditLog's own doc comment in
// prisma/schema.prisma for the full design rationale (why no User
// relation, why module/entityType are plain strings, why this is
// never a substitute for JournalEntry/JournalLine).
//
// SAFETY RULES enforced by this file's own design (never by trusting
// a caller to remember them):
//   1. Never derives userId/role from anything the frontend sent -
//      actorFromUser() only ever accepts the server-resolved
//      AuthUser from getCurrentUser().
//   2. Never computes "old"/"new" values itself - callers must read
//      the CURRENT database row themselves (inside the same
//      transaction as the mutation) before overwriting it, exactly
//      like every existing edit route in this codebase already does
//      for its own business logic. This file only shapes and writes
//      what the caller already knows to be true.
//   3. Timestamp is always DB-generated (createdAt @default(now())) -
//      never accepted as an input field here.
//   4. Writes through whichever Prisma client/transaction the caller
//      passes as `tx` - pass the SAME transaction client the business
//      mutation itself used so the audit row commits/rolls back
//      atomically with the change it describes (Section 14 of the
//      audit log spec). Passing the bare `prisma` client is only
//      correct for actions with no surrounding transaction (e.g.
//      LOGIN_SUCCESS/LOGIN_FAILED).
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type AuditActor = {
  userId: string | null;
  userNameSnapshot: string | null;
  userRoleSnapshot: string | null;
};

/** Builds the actor snapshot from the server-resolved current user - never from request body/query input. */
export function actorFromUser(user: { userId: string; username: string; role: string } | null): AuditActor {
  if (!user) return { userId: null, userNameSnapshot: null, userRoleSnapshot: null };
  return { userId: user.userId, userNameSnapshot: user.username, userRoleSnapshot: user.role };
}

/** Extracts IP/User-Agent from the incoming request's own headers - never from a client-supplied body field. */
export function requestContext(request: { headers: Headers }): { ipAddress: string | null; userAgent: string | null } {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ipAddress = (forwardedFor ? forwardedFor.split(",")[0].trim() : request.headers.get("x-real-ip")) || null;
  const userAgent = request.headers.get("user-agent") || null;
  return { ipAddress, userAgent };
}

export type AuditLogInput = {
  actor: AuditActor;
  action: AuditAction;
  /** Business area, e.g. "BILTY" | "CHALLAN" | "SETTLEMENT" | "DAILY_POSTING" - plain string, matches JournalLine.sourceType's own convention. */
  module: string;
  /** The specific Prisma model this row is about, e.g. "Bilty" | "SettlementPayment" | "Party". */
  entityType: string;
  entityId?: string | null;
  /** Human-facing document/reference number, e.g. "B-1025", "C-501", "3001" - used for search/display, never for lookups that require the real id. */
  documentNo?: string | null;
  /** Business-readable, e.g. "Changed Rent from Rs. 50,000 to Rs. 55,000" - never a raw technical dump. */
  description: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  changedFields?: Record<string, { old: unknown; new: unknown }> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

/**
 * Writes ONE append-only AuditLog row. Call this only AFTER the
 * business mutation it describes has actually succeeded (or, when
 * `tx` is a transaction client, as part of the same transaction that
 * is about to commit) - never speculatively, and never for a
 * validation failure. See this file's own doc comment for the
 * transactional-consistency contract.
 */
export async function writeAuditLog(tx: Tx, input: AuditLogInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: input.actor.userId,
      userNameSnapshot: input.actor.userNameSnapshot,
      userRoleSnapshot: input.actor.userRoleSnapshot,
      action: input.action,
      module: input.module,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      documentNo: input.documentNo ?? null,
      description: input.description,
      oldValues: (input.oldValues ?? undefined) as Prisma.InputJsonValue | undefined,
      newValues: (input.newValues ?? undefined) as Prisma.InputJsonValue | undefined,
      changedFields: (input.changedFields ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    },
  });
}

type BaseAuditParams = Omit<AuditLogInput, "action">;

export const auditCreate = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "CREATE" });
export const auditUpdate = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "UPDATE" });
export const auditDelete = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "DELETE" });
export const auditRestore = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "RESTORE" });
export const auditSettlement = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "SETTLEMENT" });
export const auditSettlementPayment = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "SETTLEMENT_PAYMENT" });
export const auditPost = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "POST" });
export const auditSettingsChange = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "SETTINGS_CHANGE" });
export const auditPermissionChange = (tx: Tx, input: BaseAuditParams) => writeAuditLog(tx, { ...input, action: "PERMISSION_CHANGE" });

/**
 * Shallow field-level diff between the record's state before and
 * after an edit, restricted to `fields` (never a blind whole-object
 * dump - Section 6/24 of the audit log spec). Prisma Decimal values
 * are normalized to plain numbers first so `55000` and a Decimal
 * wrapping `55000` compare equal rather than always "changing".
 * Returns {} (no entry written) when nothing in `fields` actually
 * changed.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<Record<keyof T, unknown>>,
  fields: (keyof T)[]
): Record<string, { old: unknown; new: unknown }> {
  const changed: Record<string, { old: unknown; new: unknown }> = {};
  for (const field of fields) {
    if (!(field in after)) continue;
    const oldValue = normalizeAuditValue(before[field]);
    const newValue = normalizeAuditValue(after[field]);
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changed[String(field)] = { old: oldValue, new: newValue };
    }
  }
  return changed;
}

function normalizeAuditValue(value: unknown): unknown {
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as { toNumber: unknown }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}
