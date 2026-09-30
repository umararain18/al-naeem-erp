"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type AuditAction =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "RESTORE"
  | "POST"
  | "PAYMENT"
  | "RECEIPT"
  | "SETTLEMENT"
  | "SETTLEMENT_PAYMENT"
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "EXPORT"
  | "SETTINGS_CHANGE"
  | "PERMISSION_CHANGE";

const ACTIONS: AuditAction[] = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "RESTORE",
  "POST",
  "PAYMENT",
  "RECEIPT",
  "SETTLEMENT",
  "SETTLEMENT_PAYMENT",
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  "EXPORT",
  "SETTINGS_CHANGE",
  "PERMISSION_CHANGE",
];

const MODULES = [
  "BILTY",
  "CHALLAN",
  "SETTLEMENT",
  "PRIVATE_PHONCH",
  "SHOWROOM_PHONCH",
  "BILL",
  "DAILY_POSTING",
  "CASH_BOOK",
  "PAYROLL",
  "PARTY",
  "ACCOUNT",
  "SETTINGS",
  "USER",
  "AUTH",
];

const ACTION_COLORS: Record<string, string> = {
  CREATE: "bg-green-50 text-green-700",
  UPDATE: "bg-blue-50 text-blue-700",
  DELETE: "bg-red-50 text-red-700",
  RESTORE: "bg-teal-50 text-teal-700",
  POST: "bg-indigo-50 text-indigo-700",
  PAYMENT: "bg-purple-50 text-purple-700",
  RECEIPT: "bg-purple-50 text-purple-700",
  SETTLEMENT: "bg-amber-50 text-amber-700",
  SETTLEMENT_PAYMENT: "bg-amber-50 text-amber-700",
  LOGIN_SUCCESS: "bg-green-50 text-green-700",
  LOGIN_FAILED: "bg-red-50 text-red-700",
  LOGOUT: "bg-gray-100 text-gray-600",
  EXPORT: "bg-sky-50 text-sky-700",
  SETTINGS_CHANGE: "bg-orange-50 text-orange-700",
  PERMISSION_CHANGE: "bg-pink-50 text-pink-700",
};

type AuditLogEntry = {
  id: string;
  createdAt: string;
  userId: string | null;
  userNameSnapshot: string | null;
  userRoleSnapshot: string | null;
  action: AuditAction;
  module: string;
  entityType: string;
  entityId: string | null;
  documentNo: string | null;
  description: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  changedFields: Record<string, { old: unknown; new: unknown }> | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [entry, setEntry] = useState<AuditLogEntry | null>(null);
  const [link, setLink] = useState<{ href: string; exists: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showTechnical, setShowTechnical] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch(`/api/audit-log/${id}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || "Unable to load entry");
        setEntry(data.entry);
        setLink(data.link);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load entry");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Audit Log Detail</h2>
          <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>

        {loading && <p className="text-sm text-gray-500">Loading...</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {entry && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs uppercase text-gray-500">Date &amp; Time</div>
                <div className="mt-0.5 font-medium">{formatDateTime(entry.createdAt)}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">User</div>
                <div className="mt-0.5 font-medium">{entry.userNameSnapshot || "System"}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">Role at time</div>
                <div className="mt-0.5 font-medium">{entry.userRoleSnapshot || "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">Action</div>
                <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_COLORS[entry.action] || "bg-gray-100 text-gray-700"}`}>
                  {entry.action.replace("_", " ")}
                </span>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">Module</div>
                <div className="mt-0.5 font-medium">{entry.module.replace("_", " ")}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">Record</div>
                <div className="mt-0.5 font-medium">
                  {link ? (
                    link.exists ? (
                      <Link href={link.href} className="text-blue-600 hover:underline">
                        {entry.documentNo || entry.entityType}
                      </Link>
                    ) : (
                      <span className="text-gray-400">Record no longer available</span>
                    )
                  ) : (
                    entry.documentNo || entry.entityType || "—"
                  )}
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500">Description</div>
              <div className="mt-0.5">{entry.description}</div>
            </div>

            {entry.changedFields && Object.keys(entry.changedFields).length > 0 && (
              <div>
                <div className="mb-1.5 text-xs uppercase text-gray-500">Changed Fields</div>
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-3 py-2">Field</th>
                        <th className="px-3 py-2">Old Value</th>
                        <th className="px-3 py-2"></th>
                        <th className="px-3 py-2">New Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {Object.entries(entry.changedFields).map(([field, { old, new: nv }]) => (
                        <tr key={field}>
                          <td className="px-3 py-2 font-medium">{field}</td>
                          <td className="px-3 py-2 text-gray-600">{formatValue(old)}</td>
                          <td className="px-3 py-2 text-gray-400">→</td>
                          <td className="px-3 py-2 font-medium text-gray-900">{formatValue(nv)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {!entry.changedFields && (entry.oldValues || entry.newValues) && (
              <div>
                <div className="mb-1.5 text-xs uppercase text-gray-500">Details</div>
                {entry.newValues && (
                  <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify(entry.newValues, null, 2)}</pre>
                )}
              </div>
            )}

            <div className="border-t pt-3">
              <button
                type="button"
                onClick={() => setShowTechnical((v) => !v)}
                className="text-xs font-medium text-gray-500 hover:text-gray-700"
              >
                {showTechnical ? "Hide" : "Show"} technical metadata
              </button>
              {showTechnical && (
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-500">
                  <div>IP Address: {entry.ipAddress || "—"}</div>
                  <div>Request ID: {entry.requestId || "—"}</div>
                  <div className="col-span-2">User Agent: {entry.userAgent || "—"}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuditLogPage() {
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [action, setAction] = useState("");
  const [module, setModule] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (action) params.set("action", action);
      if (module) params.set("module", module);
      if (search) params.set("search", search);

      const res = await fetch(`/api/audit-log?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load Audit Log");
      setItems(data.items);
      setTotalPages(data.totalPages);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Audit Log");
    } finally {
      setLoading(false);
    }
  }, [page, dateFrom, dateTo, action, module, search]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilters() {
    setPage(1);
    setSearch(searchInput.trim());
  }

  function clearFilters() {
    setDateFrom("");
    setDateTo("");
    setAction("");
    setModule("");
    setSearch("");
    setSearchInput("");
    setPage(1);
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
          <p className="mt-1 text-sm text-gray-500">Who changed what, when, and from what value to what value.</p>
        </div>

        <div className="mb-4 rounded-xl border bg-white p-4 shadow-sm">
          <div className="grid gap-3 md:grid-cols-5">
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Date From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Date To</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Action</span>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value="">All Actions</option>
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Module</span>
              <select
                value={module}
                onChange={(e) => setModule(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value="">All Modules</option>
                {MODULES.map((m) => (
                  <option key={m} value={m}>
                    {m.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Search</span>
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                placeholder="User, record, description..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={applyFilters} className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
              Apply Filters
            </button>
            <button type="button" onClick={clearFilters} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
              Clear
            </button>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Date/Time</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Module</th>
                  <th className="px-4 py-3">Record</th>
                  <th className="px-4 py-3">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                      Loading...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                      No audit log entries found.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} className="cursor-pointer hover:bg-gray-50" onClick={() => setSelectedId(item.id)}>
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-600">{formatDateTime(item.createdAt)}</td>
                      <td className="px-4 py-2.5">{item.userNameSnapshot || "System"}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_COLORS[item.action] || "bg-gray-100 text-gray-700"}`}>
                          {item.action.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">{item.module.replace("_", " ")}</td>
                      <td className="px-4 py-2.5 font-medium">{item.documentNo || item.entityType || "—"}</td>
                      <td className="max-w-md truncate px-4 py-2.5 text-gray-600">{item.description}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
          <span>
            {total} entries · Page {page} of {totalPages}
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
      </div>

      {selectedId && <DetailModal id={selectedId} onClose={() => setSelectedId(null)} />}
    </main>
  );
}
