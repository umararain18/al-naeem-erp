// ============================================================
// SHORT SERVER-SIDE CACHE - in-process Map, 60s TTL, keyed by
// whatever the caller passes (date + period + a permissions hash,
// for the Dashboard). This is deliberately NOT a distributed cache
// (Redis etc.) - this app runs as a single Node process (confirmed
// throughout this session), so a plain Map is the entire mechanism
// needed, and it's what actually absorbs the Dashboard's one real
// remaining cost center after profiling (see lib/reports/daily-
// summary.ts's own PERFORMANCE comment): the per-Receivable/Payable-
// account open-document lookup, ~3s on real data, paid once per 60s
// instead of on every single page load/refresh.
// ============================================================

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL_MS = 60_000;

export async function getCached<T>(key: string, compute: () => Promise<T>, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
  const now = Date.now();
  const existing = store.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.value as T;
  }

  const value = await compute();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/** Test/diagnostic only - never called from production code paths. */
export function clearReportCache(): void {
  store.clear();
}
