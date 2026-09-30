"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

// ============================================================
// Global ERP Search - desktop Ctrl+K overlay.
//
// Mounted ONCE at the root layout (see app/layout.tsx) - never
// per-page, so there is exactly one global keydown listener for the
// whole app (Section 20 of the spec). Talks only to the read-only
// GET /api/search endpoint; this component never mutates anything -
// Open/Edit/Bin all navigate to the SAME existing detail/edit routes
// every module already has, never a duplicate action here.
// ============================================================

type SearchResultItem = {
  entityType: string;
  id: string;
  documentNo: string | null;
  title: string;
  subtitle: string | null;
  date: string | null;
  status: string | null;
  amount: { value: number; label: string } | null;
  relationshipSummary: string | null;
  href: string | null;
};

type SearchGroup = {
  type: string;
  label: string;
  count: number;
  results: SearchResultItem[];
};

function formatAmount(amount: SearchResultItem["amount"]) {
  if (!amount) return null;
  return `${amount.label}: Rs. ${Math.round(amount.value).toLocaleString()}`;
}

export default function GlobalSearch({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const flatResults = groups.flatMap((g) => g.results);

  const closeOverlay = useCallback(() => {
    setOpen(false);
    setQuery("");
    setGroups([]);
    setActiveIndex(0);
  }, []);

  const openResult = useCallback(
    (result: SearchResultItem) => {
      if (!result.href) return;
      closeOverlay();
      router.push(result.href);
    },
    [router, closeOverlay]
  );

  // ONE root-level keydown listener for the whole app - Ctrl/Cmd+K
  // always opens (even while another input is focused - a global
  // shortcut is expected to take over, per Section 20), Escape closes,
  // Up/Down/Enter only act while the overlay itself is open.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeOverlay();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatResults.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        const result = flatResults[activeIndex];
        if (result) {
          event.preventDefault();
          openResult(result);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, flatResults, activeIndex, closeOverlay, openResult]);

  // Debounced quick search - mirrors the same 250ms debounce pattern
  // already used by app/bill/BillForm.tsx's own source-document search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setGroups([]);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=quick`, { cache: "no-store" });
        const data = await res.json();
        if (data?.success) {
          setGroups(data.groups || []);
          setActiveIndex(0);
        }
      } catch {
        // Best-effort - a failed search must never break the rest of the app.
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  function goToFullSearch() {
    const q = query.trim();
    closeOverlay();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }

  return (
    <>
      {/* Desktop trigger - compact, does not disturb sidebar nav/layout.
          Collapsed sidebar gets an icon-only trigger so the fixed-width
          rail never overflows (Section 18). */}
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className={
          collapsed
            ? "hidden lg:flex items-center justify-center w-8 h-8 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white"
            : "hidden lg:flex items-center gap-2 w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
        }
        aria-label="Global Search"
        title={collapsed ? "Search (Ctrl+K)" : undefined}
      >
        <Search className="h-3.5 w-3.5 flex-shrink-0" />
        {!collapsed && (
          <>
            <span className="truncate">Search...</span>
            <span className="ml-auto flex-shrink-0 rounded border border-gray-600 px-1 text-[10px]">Ctrl K</span>
          </>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 pt-[10vh] px-4" onClick={closeOverlay}>
          <div
            className="w-full max-w-2xl rounded-xl bg-white shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !flatResults[activeIndex]) {
                    e.preventDefault();
                    goToFullSearch();
                  }
                }}
                placeholder="Search Bilty, Challan, Bill, Party, phone, chassis, carrier..."
                className="flex-1 outline-none text-sm placeholder:text-gray-400"
              />
              <button type="button" onClick={closeOverlay} aria-label="Close search" className="text-gray-400 hover:text-gray-600">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {loading && <div className="px-4 py-6 text-center text-sm text-gray-500">Searching...</div>}

              {!loading && query.trim() && groups.every((g) => g.results.length === 0) && (
                <div className="px-4 py-6 text-center text-sm text-gray-500">No results found.</div>
              )}

              {!loading &&
                groups.map((group) => {
                  if (group.results.length === 0) return null;
                  return (
                    <div key={group.type} className="border-b last:border-b-0">
                      <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                        {group.label}
                      </div>
                      {group.results.map((result) => {
                        const flatIndex = flatResults.indexOf(result);
                        const isActive = flatIndex === activeIndex;
                        return (
                          <button
                            key={`${result.entityType}-${result.id}`}
                            type="button"
                            onMouseEnter={() => setActiveIndex(flatIndex)}
                            onClick={() => openResult(result)}
                            className={`block w-full px-4 py-2.5 text-left ${isActive ? "bg-blue-50" : "hover:bg-gray-50"}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium text-gray-900 truncate">{result.title}</span>
                              {result.status && (
                                <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-gray-500">{result.status}</span>
                              )}
                            </div>
                            {(result.subtitle || result.relationshipSummary || result.amount) && (
                              <div className="mt-0.5 truncate text-xs text-gray-500">
                                {[result.subtitle, result.relationshipSummary, formatAmount(result.amount)].filter(Boolean).join(" · ")}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
            </div>

            <div className="border-t px-4 py-2">
              <button type="button" onClick={goToFullSearch} className="text-xs font-medium text-blue-600 hover:underline">
                View all results in Full Search →
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
