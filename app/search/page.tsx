"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

// ============================================================
// Full Search page - paginated, filterable view over the same
// read-only GET /api/search endpoint the Ctrl+K overlay uses
// (components/layout/GlobalSearch.tsx). This page never mutates
// anything itself - every action pill below is a plain link to the
// SAME existing detail page each module already has (Bill/Bilty/
// Challan/Private Phonch/Showroom Phonch/Party Ledger), where the
// real Edit/Bin/Delete controls already live. No duplicate mutation
// logic exists here.
// ============================================================

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

const MODULE_TABS: { value: string; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PARTY", label: "Parties" },
  { value: "BILTY", label: "Bilty" },
  { value: "CHALLAN", label: "Challan" },
  { value: "BILL", label: "Bill" },
  { value: "PRIVATE_PHONCH", label: "Private Phonch" },
  { value: "SHOWROOM_PHONCH", label: "Showroom Phonch" },
  { value: "EMPLOYEE", label: "Employees" },
  { value: "ACCOUNT", label: "Accounts" },
];

// Only these modules support jumping straight into edit mode via
// `?edit=1` (a pattern already established on their own detail pages -
// see app/bill/[id]/page.tsx, app/private-phonch/[id]/page.tsx,
// app/phonch/[id]/page.tsx). Bilty/Challan/Party edit inline on their
// own detail page instead, so EDIT there just opens that same page.
const SUPPORTS_EDIT_QUERY_PARAM = new Set(["BILL", "PRIVATE_PHONCH", "SHOWROOM_PHONCH"]);

function formatDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function actionHref(result: SearchResultItem, action: string): string | null {
  if (!result.href) return null;
  if (action === "EDIT" && SUPPORTS_EDIT_QUERY_PARAM.has(result.entityType)) {
    return `${result.href}?edit=1`;
  }
  return result.href;
}

function ResultRow({ result }: { result: SearchResultItem }) {
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{result.entityType.replace("_", " ")}</span>
            {result.status && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase text-gray-600">{result.status}</span>
            )}
          </div>
          <div className="mt-1 truncate text-base font-semibold text-gray-900">{result.title}</div>
          {result.subtitle && <div className="text-sm text-gray-600">{result.subtitle}</div>}
          {result.route && <div className="text-sm text-gray-500">{result.route}</div>}
          {result.vehicle && (result.vehicle.registration || result.vehicle.chassis || result.vehicle.engine) && (
            <div className="mt-1 text-xs text-gray-500">
              {[
                result.vehicle.registration ? `Reg: ${result.vehicle.registration}` : null,
                result.vehicle.chassis ? `Chassis: ${result.vehicle.chassis}` : null,
                result.vehicle.engine ? `Engine: ${result.vehicle.engine}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
          {result.relationshipSummary && <div className="mt-1 text-xs text-gray-500">{result.relationshipSummary}</div>}
          {result.amount && (
            <div className="mt-1 text-sm font-medium text-gray-800">
              {result.amount.label}: Rs. {Math.round(result.amount.value).toLocaleString()}
            </div>
          )}
          {result.date && <div className="mt-1 text-xs text-gray-400">{formatDate(result.date)}</div>}
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
          {result.availableActions.map((action) => {
            const href = actionHref(result, action);
            if (!href) return null;
            return (
              <Link
                key={action}
                href={href}
                className="rounded-lg border px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                {action.charAt(0) + action.slice(1).toLowerCase()}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SearchPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [queryInput, setQueryInput] = useState(searchParams.get("q") || "");
  const [activeModule, setActiveModule] = useState("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Reactive to the URL's own `q` (never a one-time initializer) - a
  // "View all results" navigation from an already-open /search page
  // (same route, new query string) must still update the input.
  useEffect(() => {
    setQueryInput(searchParams.get("q") || "");
  }, [searchParams]);

  const query = queryInput.trim();

  const load = useCallback(async () => {
    if (!query) {
      setGroups([]);
      setTotal(0);
      return;
    }
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ q: query, scope: "full", page: String(page), pageSize: "25" });
      if (activeModule !== "ALL") params.set("module", activeModule);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const res = await fetch(`/api/search?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to search");
      setGroups(data.groups || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search");
    } finally {
      setLoading(false);
    }
  }, [query, activeModule, dateFrom, dateTo, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    router.replace(`/search?q=${encodeURIComponent(queryInput.trim())}`);
  }

  // Real, module-scoped pagination only makes sense once a single
  // module is selected (a shared page/pageSize across heterogeneous
  // entity types would require a real UNION query, deliberately not
  // built here - see the audit's own Section 25/Section 11 note). The
  // "All" tab shows each module's own first page (capped at 25) with
  // a per-group link to switch into that module's own paginated tab.
  const singleGroup = activeModule !== "ALL" ? groups[0] : null;
  const totalPages = singleGroup ? Math.max(1, Math.ceil(singleGroup.count / 25)) : 1;

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Search</h1>
          <p className="mt-1 text-sm text-gray-500">Search Bilty, Challan, Bill, Parties, phone numbers, chassis/engine, and more across the ERP.</p>
        </div>

        <form onSubmit={submitSearch} className="mb-4 rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex gap-2">
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="TMH-786, NKB, Muhammad Ali, 03001234567, B-1025..."
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            <button type="submit" className="rounded-lg bg-black px-5 py-2 text-sm font-medium text-white hover:bg-gray-800">
              Search
            </button>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Date From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Date To</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
          </div>
        </form>

        <div className="mb-4 flex flex-wrap gap-2">
          {MODULE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => {
                setActiveModule(tab.value);
                setPage(1);
              }}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                activeModule === tab.value ? "border-black bg-black text-white" : "hover:bg-gray-50"
              }`}
            >
              {tab.label}
              {activeModule !== tab.value && groups.find((g) => g.type === tab.value) ? ` (${groups.find((g) => g.type === tab.value)?.count})` : ""}
            </button>
          ))}
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {!query && <div className="rounded-xl border bg-white p-6 text-center text-sm text-gray-500 shadow-sm">Type a search term above to begin.</div>}

        {query && loading && <div className="rounded-xl border bg-white p-6 text-center text-sm text-gray-500 shadow-sm">Searching...</div>}

        {query && !loading && total === 0 && (
          <div className="rounded-xl border bg-white p-6 text-center text-sm text-gray-500 shadow-sm">No results found for &quot;{query}&quot;.</div>
        )}

        {query &&
          !loading &&
          groups.map((group) => {
            if (group.results.length === 0) return null;
            if (activeModule !== "ALL" && group.type !== activeModule) return null;
            return (
              <div key={group.type} className="mb-6">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                    {group.label} ({group.count})
                  </h2>
                  {activeModule === "ALL" && group.count > group.results.length && (
                    <button
                      type="button"
                      onClick={() => {
                        setActiveModule(group.type);
                        setPage(1);
                      }}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      See all {group.count} in {group.label} →
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {group.results.map((result) => (
                    <ResultRow key={`${result.entityType}-${result.id}`} result={result} />
                  ))}
                </div>
              </div>
            );
          })}

        {query && !loading && singleGroup && singleGroup.count > 25 && (
          <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">Loading...</main>}>
      <SearchPageInner />
    </Suspense>
  );
}
