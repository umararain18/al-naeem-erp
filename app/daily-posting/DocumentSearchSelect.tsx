"use client";

// Shared, authoritative Bilty/Challan document lookup component.
// Extracted unchanged from app/daily-posting/page.tsx (the Daily Posting
// Create form) so Edit workflows can reuse the EXACT same search/fetch
// logic instead of a second, parallel document-lookup implementation.
// Create's own usage is unaffected - `readOnly` defaults to false, and
// every prop/behavior below is identical to the original inline version.

import { useEffect, useState } from "react";

export type DocumentSearchResult = {
  type: "CHALLAN" | "BILTY" | "PHONCH" | "PRIVATE_PHONCH";
  id: string;
  number: string;
  subtitle: string;
  detail: string;
  resolvedParty: { accountId: string; partyName: string } | null;
  // CHALLAN and PRIVATE_PHONCH only, and only once `direction` is
  // known - see app/api/daily-posting/search-documents/route.ts.
  eligibleParties?: { accountId: string; partyName: string; amount: number }[];
};

export function DocumentSearchSelect({
  sourceType,
  sourceId,
  sourceNumber,
  direction,
  onSelect,
  onClear,
  readOnly = false,
}: {
  sourceType: string;
  sourceId: string;
  sourceNumber: string;
  // The line's DEBIT/CREDIT direction, forwarded to the resolver so a
  // CHALLAN's auto-resolved party reflects the LOCKED Receivable/
  // Payable rule (see resolveChallanParty() in
  // lib/document-party-resolution.ts). Unused for BILTY/PHONCH.
  direction?: "DEBIT" | "CREDIT";
  onSelect: (result: DocumentSearchResult) => void;
  onClear: () => void;
  // When true, the field only DISPLAYS the already-linked document
  // (via the exact same "selected" rendering Create uses) and never
  // accepts typed input or opens the search dropdown - used by Edit
  // for a posted transaction, where the linked Bilty/Challan must not
  // be silently reassigned through this field. See
  // app/cash-book/TransactionEditModal.tsx.
  readOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<DocumentSearchResult[]>([]);

  useEffect(() => {
    if (!sourceId) {
      setQuery("");
    }
  }, [sourceId]);

  useEffect(() => {
    if (!open || readOnly) return;

    const search = query.trim();

    if (!search) {
      setResults([]);
      return;
    }

    const handle = window.setTimeout(async () => {
      try {
        setLoading(true);

        const directionQuery = direction ? `&direction=${direction}` : "";
        const response = await fetch(
          `/api/daily-posting/search-documents?q=${encodeURIComponent(search)}${directionQuery}`
        );

        const data = await response.json();

        if (response.ok && data.success) {
          setResults(data.results || []);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(handle);
  }, [query, open, readOnly, direction]);

  // A document may be selected BEFORE its line's direction is chosen
  // (the "Type" column is filled in after "Document No." in the
  // Create table) - re-resolve the already-selected CHALLAN/BILTY/
  // PRIVATE_PHONCH's counterparty whenever direction changes
  // afterward, so the LOCKED Receivable/Payable rule (Challan), the
  // narrow Gross Bilty Receivable RECEIPT-only exception (Bilty), and
  // the payable-vs-deposit eligibility split (Private Phonch) are
  // applied to whichever direction is current at save time, not just
  // whichever was current at selection time. A no-op for PHONCH
  // (direction never affects its resolution) and for any caller that
  // never passes a direction prop at all (e.g.
  // app/cash-book/TransactionEditModal.tsx, which resolves the
  // Counter Account server-side instead) - only fires once a
  // concrete direction is actually known.
  useEffect(() => {
    if (
      readOnly ||
      !sourceId ||
      (sourceType !== "CHALLAN" && sourceType !== "BILTY" && sourceType !== "PRIVATE_PHONCH") ||
      !direction
    )
      return;

    let cancelled = false;

    (async () => {
      try {
        const directionQuery = direction ? `&direction=${direction}` : "";
        const response = await fetch(
          `/api/daily-posting/search-documents?q=${encodeURIComponent(sourceNumber)}${directionQuery}`
        );
        const data = await response.json();
        if (cancelled || !response.ok || !data.success) return;

        const match = (data.results || []).find(
          (r: DocumentSearchResult) => r.type === sourceType && r.id === sourceId
        );
        if (match) onSelect(match);
      } catch {
        // silent - identical failure handling to the search above.
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  const displayValue = sourceId
    ? `${sourceType} ${sourceNumber}`
    : query;

  return (
    <div className="relative w-56">
      <input
        type="text"
        value={displayValue}
        readOnly={readOnly}
        placeholder="Search Challan/Bilty no..."
        onFocus={() => {
          if (readOnly) return;
          setOpen(true);
          if (sourceId) setQuery("");
        }}
        onChange={(event) => {
          if (readOnly) return;
          setQuery(event.target.value);
          setOpen(true);
          if (sourceId) onClear();
        }}
        onBlur={() => {
          if (readOnly) return;
          window.setTimeout(() => setOpen(false), 150);
        }}
        className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 ${
          readOnly ? "cursor-not-allowed bg-gray-100" : ""
        }`}
      />

      {sourceId && !readOnly && (
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            onClear();
            setQuery("");
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-red-500"
        >
          ✕
        </button>
      )}

      {open && !sourceId && !readOnly && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-80 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {loading && (
            <div className="px-3 py-3 text-sm text-gray-500">Searching...</div>
          )}

          {!loading && query.trim() && results.length === 0 && (
            <div className="px-3 py-3 text-sm text-gray-500">
              No Challan or Bilty found.
            </div>
          )}

          {!loading && !query.trim() && (
            <div className="px-3 py-3 text-sm text-gray-500">
              Type a Challan or Bilty number to search.
            </div>
          )}

          {results.map((result) => (
            <button
              key={`${result.type}-${result.id}`}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(result);
                setOpen(false);
              }}
              className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-blue-50"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    result.type === "CHALLAN"
                      ? "bg-purple-100 text-purple-700"
                      : "bg-teal-100 text-teal-700"
                  }`}
                >
                  {result.type}
                </span>
                <span className="font-medium text-gray-900">
                  {result.number}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                {result.subtitle}
              </div>
              <div className="text-xs text-gray-400">{result.detail}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
