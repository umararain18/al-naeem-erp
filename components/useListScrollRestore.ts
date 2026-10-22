"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ============================================================
// LIST SCROLL/FILTER RESTORE - shared across every list page (Bilty,
// Challan, Phonch, Private Phonch, Bill Book, Parties, General
// Ledger, Party Ledger, Daily Posting) so a user who opens a record
// and comes back (browser Back or an in-app Back link) returns to the
// exact same scroll position, filters/search/page, with the record
// they just opened briefly highlighted - never back to a reset, top-
// of-page list.
//
// sessionStorage, not React state: the list page unmounts while the
// user is on the detail page, so anything kept only in memory would
// already be gone by the time they come back. sessionStorage survives
// that (and clears itself at tab close, unlike localStorage, which
// would otherwise resurrect a stale scroll position days later).
//
// DESIGN: filters are handled by the two plain functions below
// (getSavedListFilters/saveListFilters), never by a hook - every
// existing list page already manages search/status/page/etc. as its
// own separate useState calls, and collapsing those into one object
// just to fit a hook's shape would be a much larger, riskier diff
// than this feature needs. Only the two things that genuinely need
// component lifecycle (the one-time scroll restore, the transient
// highlight) are a hook (useListScrollRestore below).
//
// Wrapped in try/catch throughout: sessionStorage can throw (private
// browsing, quota, disabled storage) - this feature must degrade to
// "always starts fresh" in that case, never break the page.
// ============================================================

interface StoredListState {
  scrollY: number;
  filters: Record<string, unknown> | null;
  openedId: string | null;
  savedAt: number;
}

const STORAGE_PREFIX = "listViewState:";
// Old state is never restored past this age - a tab left open for
// days, or a stale sessionStorage entry from an abandoned session,
// must not suddenly reposition/highlight a list long after the fact.
const TTL_MS = 30 * 60 * 1000;
const HIGHLIGHT_MS = 1800;

function readState(storageKey: string): StoredListState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredListState;
    if (!parsed || typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > TTL_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeState(storageKey: string, patch: Partial<StoredListState>): void {
  if (typeof window === "undefined") return;
  try {
    const current = readState(storageKey) ?? { scrollY: 0, filters: null, openedId: null, savedAt: Date.now() };
    const next: StoredListState = { ...current, ...patch, savedAt: Date.now() };
    window.sessionStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(next));
  } catch {
    // Storage unavailable - silently no-op, see module comment above.
  }
}

/**
 * Plain (non-hook) read - call once, synchronously, inside each of a
 * list page's own `useState(() => ...)` initializers to seed it from
 * whatever was saved before the user left this list. Returns null
 * (never throws) when nothing was saved or it expired, so the
 * caller's own default still applies untouched.
 */
export function getSavedListFilters<F>(storageKey: string): F | null {
  return (readState(storageKey)?.filters as F | undefined) ?? null;
}

/**
 * Call whenever ANY of the list's own filter/search/page state
 * changes - typically from one `useEffect` watching all of them
 * together and passing one combined snapshot object (shape is
 * entirely up to the caller).
 */
export function saveListFilters(storageKey: string, filters: Record<string, unknown>): void {
  writeState(storageKey, { filters });
}

/**
 * Call right before navigating to a record's own detail page (a
 * row's onClick, or wherever its href is built) - captures the
 * CURRENT scroll position and which record is being opened, both
 * needed again only if/when the user comes back to this exact list.
 */
export function markListRecordOpened(storageKey: string, recordId: string): void {
  if (typeof window === "undefined") return;
  writeState(storageKey, { scrollY: window.scrollY, openedId: recordId });
}

/**
 * React hook for the two things that need component lifecycle:
 *  - `highlightId`: the record id to briefly highlight (null once the
 *    highlight window has passed, or there was nothing to highlight).
 *    Consumed exactly once per return-from-detail navigation - never
 *    resurfaces on a later, unrelated visit to this list.
 *  - Automatic scroll restore, fired exactly once, only once `ready`
 *    becomes true (i.e. the caller's own real data has rendered -
 *    restoring against an empty/loading list silently fails, there is
 *    nothing tall enough yet to scroll to).
 *
 * `onOpenRecord` is returned too, purely as a stable callback wrapper
 * around markListRecordOpened so callers don't need their own import
 * for it everywhere they already hold this hook's result.
 */
export function useListScrollRestore(storageKey: string, ready: boolean) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Tracks the KEY each one-time action already ran for, not just
  // whether it ran - a page whose real storageKey is only known
  // asynchronously (e.g. Party Ledger's partyId, resolved from a
  // route param Promise) calls this hook with a placeholder key on
  // its very first render, then the real key once resolved. A plain
  // boolean "already ran" ref would consume itself against that
  // placeholder and never fire again for the real key; comparing
  // against the key itself lets a genuine key CHANGE still run once.
  const consumedHighlightForKeyRef = useRef<string | null>(null);
  const restoredScrollForKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (consumedHighlightForKeyRef.current === storageKey) return;
    consumedHighlightForKeyRef.current = storageKey;
    const saved = readState(storageKey);
    if (saved?.openedId) {
      setHighlightId(saved.openedId);
      writeState(storageKey, { openedId: null });
    }
  }, [storageKey]);

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  useEffect(() => {
    if (!ready || restoredScrollForKeyRef.current === storageKey) return;
    restoredScrollForKeyRef.current = storageKey;
    const saved = readState(storageKey);
    if (saved && saved.scrollY > 0) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: saved.scrollY, behavior: "auto" });
      });
    }
  }, [ready, storageKey]);

  const onOpenRecord = useCallback((recordId: string) => markListRecordOpened(storageKey, recordId), [storageKey]);

  return { highlightId, onOpenRecord };
}

/** Shared highlight class - consistent styling across every list page,
 * same transient amber tone Daily Posting's own existing highlight uses. */
export const LIST_HIGHLIGHT_CLASS = "bg-yellow-50 transition-colors duration-1000";

// ============================================================
// returnTo - lets a document detail page's own "Back" button return
// to the EXACT page it was opened from (a ledger view, Cash Book,
// Search, a Challan's own Bilty list, ...), not just a hardcoded
// module list link. The opening page appends `?returnTo=<its own
// current path+query>` to the link it builds; the detail page reads
// it back and falls through to its usual module-list link only when
// absent (opened directly, e.g. a bookmark) or unsafe.
// ============================================================

/** Call from the page that is ABOUT TO LINK to a document detail page
 * - captures THIS page's own current path+query, to hand to that
 * detail page's Back button. Returns "" outside the browser (SSR). */
export function buildReturnTo(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname + window.location.search;
}

/** Call from a document detail page to resolve its own Back button's
 * href: the given `returnTo` value when it is a safe same-origin
 * relative path, otherwise `fallbackHref` (the module list). Rejects
 * anything not starting with a single "/" (an absolute URL or a
 * protocol-relative "//host/..." could otherwise redirect off-site if
 * a crafted link's returnTo were trusted as-is). */
export function resolveBackHref(returnTo: string | null | undefined, fallbackHref: string): string {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//")) return fallbackHref;
  return returnTo;
}

/**
 * React hook for a page that LINKS to a document detail page: returns
 * a `?returnTo=...` suffix (or "" before mount / outside the browser)
 * for THIS page's own current path+query, to append to any Bilty/
 * Challan/Bill/Phonch/Private-Phonch link this page builds.
 *
 * Deliberately NOT a plain inline `window.location` read during
 * render (every existing read of it in this codebase - app/bilty/
 * page.tsx, app/cash-book/page.tsx, app/phonch/[id]/page.tsx, etc. -
 * happens inside a useEffect/event handler, never inline in JSX):
 * reading it directly while rendering would compute "" on the
 * server (no `window`) and a real path on the client, a server/
 * client markup mismatch React would warn about on hydration.
 * Starting at "" and setting the real value only after mount (like
 * every other such read in this app) avoids that entirely - the very
 * first paint has no returnTo, exactly like a plain href would.
 */
export function useReturnToSuffix(): string {
  const [suffix, setSuffix] = useState("");
  useEffect(() => {
    const returnTo = buildReturnTo();
    setSuffix(returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "");
  }, []);
  return suffix;
}

/** Appends an already-built `returnTo` suffix (from useReturnToSuffix)
 * to `basePath`, respecting a `?` the base path may already have. */
export function withReturnTo(basePath: string, returnToSuffix: string): string {
  if (!returnToSuffix) return basePath;
  const joiner = basePath.includes("?") ? returnToSuffix.replace("?", "&") : returnToSuffix;
  return `${basePath}${joiner}`;
}
