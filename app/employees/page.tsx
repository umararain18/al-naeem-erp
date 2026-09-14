"use client";

import { useEffect, useMemo, useState } from "react";
import { SearchableSelect } from "../daily-posting/SearchableSelect";
import type { EmployeeLedgerData, PayslipPaymentState } from "@/lib/payroll-accounting";

// ============================================================
// EMPLOYEES & PAYROLL - ONE unified workspace (Step 16)
//
// Three tabs, one route (/employees), state lifted here so quick
// actions (View Ledger / New Payslip) can switch tabs without ever
// leaving this page - Part 29's explicit "one page UX" requirement.
// ============================================================

type Tab = "accounts" | "ledger" | "payroll";

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
}

function todayYMD(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function thisMonth(): string {
  return todayYMD().slice(0, 7);
}

function statusColor(status: string) {
  switch (status) {
    case "Payable":
    case "Unpaid":
      return "bg-yellow-100 text-yellow-700";
    case "Partially Paid":
      return "bg-blue-100 text-blue-700";
    case "Paid":
      return "bg-green-100 text-green-700";
    case "Paid in Advance":
      return "bg-purple-100 text-purple-700";
    default:
      return "bg-gray-100 text-gray-600";
  }
}

// ============================================================
// SHARED DRAWER SHELL
// ============================================================
function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-xl text-gray-500 hover:bg-gray-100">
            ×
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN PAGE
//
// REAL-TIME REFRESH STRATEGY (fix for stale-UI-until-browser-refresh):
//
// Root causes found:
//  1. PayslipDrawer fetched its own "active employees" selector list
//     ONCE via useEffect(..., []) - since drawers are permanent,
//     always-mounted page-level siblings (never unmounted/remounted),
//     that list never refreshed after the first fetch, so a newly
//     created Employee never appeared in "New Payslip" until a full
//     browser reload re-initialized the whole page.
//  2. The previous fix relied on bumping a `key` prop to force a full
//     REMOUNT of whichever tab was visible. That happened to refetch
//     data, but as a side effect also wiped that tab's own local UI
//     state (search box, status filter) on every save - a heavy,
//     lossy way to "refresh". Replaced with a `refreshToken` counter
//     that tabs watch via a plain useEffect dependency, so a mutation
//     triggers a targeted re-fetch (GET only) without remounting or
//     losing local filter state.
//
// `refreshToken` increments once per successful mutation (create/
// edit/payment/bin/restore) and is read by every tab's own load()
// effect. The "active employees" selector list is lifted here and
// re-fetched in the same place, so every consumer (Employee Ledger's
// selector, Payslip drawer's selector) always shares one up-to-date
// copy - never a second, independently-fetched copy that can drift.
// Switching tabs already gets fresh data for free (conditional
// rendering unmounts/remounts the tab), this only fixes the
// same-tab-stays-visible and persistent-drawer cases.
// ============================================================
type EmployeeOption = { id: string; name: string; employeeCode: string; monthlySalary: number };

export default function EmployeesPayrollPage() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [ledgerEmployeeId, setLedgerEmployeeId] = useState<string>("");
  // Shared payroll period (Part 3 of the summary-cards request): lifted
  // here so the Employee Accounts summary cards and the Payroll tab's
  // own month navigator always reflect the SAME selected period,
  // rather than each keeping its own independent date state.
  const [payrollMonth, setPayrollMonth] = useState(thisMonth());
  const [employeeDrawer, setEmployeeDrawer] = useState<{ mode: "new" | "edit"; id?: string } | null>(null);
  const [payslipDrawer, setPayslipDrawer] = useState<{ mode: "new" | "edit"; id?: string; employeeId?: string } | null>(null);
  const [paymentDrawer, setPaymentDrawer] = useState<{ id: string } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [activeEmployees, setActiveEmployees] = useState<EmployeeOption[]>([]);

  async function loadActiveEmployees() {
    try {
      const res = await fetch("/api/employees?status=ACTIVE", { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json.success) setActiveEmployees(json.items || []);
    } catch {
      // non-fatal: selector lists simply stay at their last known value
    }
  }

  useEffect(() => {
    loadActiveEmployees();
  }, []);

  function refresh() {
    setRefreshToken((k) => k + 1);
    loadActiveEmployees();
  }

  function goToLedger(employeeId: string) {
    setLedgerEmployeeId(employeeId);
    setTab("ledger");
  }

  function goToNewPayslip(employeeId: string) {
    setPayslipDrawer({ mode: "new", employeeId });
    setTab("payroll");
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Employees & Payroll</h1>
          <p className="mt-1 text-sm text-gray-500">Manage employee accounts, employee ledger and payroll from one place.</p>
        </div>

        <div className="mb-6 flex gap-2 border-b">
          {(
            [
              ["accounts", "Employee Accounts"],
              ["ledger", "Employee Ledger"],
              ["payroll", "Payroll & Payslips"],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px ${
                tab === key ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "accounts" && (
          <EmployeeAccountsTab
            refreshToken={refreshToken}
            payrollMonth={payrollMonth}
            onNew={() => setEmployeeDrawer({ mode: "new" })}
            onEdit={(id) => setEmployeeDrawer({ mode: "edit", id })}
            onViewLedger={goToLedger}
            onNewPayslip={goToNewPayslip}
            onChanged={refresh}
          />
        )}

        {tab === "ledger" && (
          <EmployeeLedgerTab
            refreshToken={refreshToken}
            employees={activeEmployees}
            employeeId={ledgerEmployeeId}
            onEmployeeIdChange={setLedgerEmployeeId}
          />
        )}

        {tab === "payroll" && (
          <PayrollTab
            refreshToken={refreshToken}
            month={payrollMonth}
            onMonthChange={setPayrollMonth}
            onNewPayslip={(employeeId) => setPayslipDrawer({ mode: "new", employeeId })}
            onEditPayslip={(id) => setPayslipDrawer({ mode: "edit", id })}
            onRecordPayment={(id) => setPaymentDrawer({ id })}
            onChanged={refresh}
            initialPrefillEmployeeId={payslipDrawer?.mode === "new" ? payslipDrawer.employeeId : undefined}
          />
        )}
      </div>

      <EmployeeDrawer
        state={employeeDrawer}
        onClose={() => setEmployeeDrawer(null)}
        onSaved={() => {
          setEmployeeDrawer(null);
          refresh();
        }}
      />

      <PayslipDrawer
        state={payslipDrawer}
        employees={activeEmployees}
        onClose={() => setPayslipDrawer(null)}
        onSaved={() => {
          setPayslipDrawer(null);
          refresh();
        }}
      />

      <PaymentDrawer
        state={paymentDrawer}
        onClose={() => setPaymentDrawer(null)}
        onSaved={() => {
          setPaymentDrawer(null);
          refresh();
        }}
      />
    </div>
  );
}

// ============================================================
// TAB 1 - EMPLOYEE ACCOUNTS
// ============================================================
type EmployeeItem = {
  id: string;
  employeeCode: string;
  name: string;
  designation: string | null;
  phone: string | null;
  isActive: boolean;
  isDeleted: boolean;
  balance: number;
  balanceStatus: string;
};

// ------------------------------------------------------------
// EMPLOYEE ACCOUNTS - TOP SUMMARY CARDS
//
// Read-only. Every number comes from GET /api/employees/summary,
// which aggregates the SAME authoritative sources (Employee rows,
// employee Account JournalLines, Payslip rows) that Employee
// Accounts/Employee Ledger/Payroll already use - never a second,
// independently-calculated ledger. Always represents the GLOBAL
// dataset for the shared payrollMonth, deliberately unaffected by
// this tab's own search/status filters (Part 11: "Summary = global
// totals, Table = filtered results").
// ------------------------------------------------------------
interface EmployeeSummaryData {
  payrollMonth: string;
  totalEmployees: number;
  activeEmployees: number;
  totalPayable: number;
  totalAdvance: number;
  paidThisMonth: number;
  thisMonthPayroll: number;
}

function SummaryCard({ label, value, description, valueClassName }: { label: string; value: string; description: string; valueClassName?: string }) {
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold text-gray-900 ${valueClassName || ""}`}>{value}</p>
      <p className="mt-0.5 text-xs text-gray-400">{description}</p>
    </div>
  );
}

function EmployeeSummaryCards({ refreshToken, payrollMonth }: { refreshToken: number; payrollMonth: string }) {
  const [data, setData] = useState<EmployeeSummaryData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/employees/summary?payrollMonth=${payrollMonth}`, { cache: "no-store" });
        const json = await res.json();
        if (!cancelled && res.ok && json.success) setData(json);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // refreshToken: re-fetch (GET only) after any Employee/Payslip/
    // Payment mutation anywhere on the page - never triggered by a
    // write of its own.
    return () => {
      cancelled = true;
    };
  }, [refreshToken, payrollMonth]);

  const monthLabel = new Date(`${payrollMonth}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <SummaryCard label="Total Employees" description="All employee records" value={loading || !data ? "—" : String(data.totalEmployees)} />
      <SummaryCard label="Active Employees" description="Currently active" value={loading || !data ? "—" : String(data.activeEmployees)} />
      <SummaryCard
        label="Total Salary Payable"
        description="Outstanding salary"
        value={loading || !data ? "—" : `Rs. ${formatMoney(data.totalPayable)}`}
        valueClassName="text-yellow-700"
      />
      <SummaryCard
        label="Total Paid This Month"
        description={`Actual payments — ${monthLabel}`}
        value={loading || !data ? "—" : `Rs. ${formatMoney(data.paidThisMonth)}`}
        valueClassName="text-green-700"
      />
      <SummaryCard
        label="Total Salary Advance"
        description="Paid ahead of earned salary"
        value={loading || !data ? "—" : `Rs. ${formatMoney(data.totalAdvance)}`}
        valueClassName="text-purple-700"
      />
      <SummaryCard
        label="This Month Payroll"
        description={`Total net payroll — ${monthLabel}`}
        value={loading || !data ? "—" : `Rs. ${formatMoney(data.thisMonthPayroll)}`}
        valueClassName="text-blue-700"
      />
    </div>
  );
}

function EmployeeAccountsTab({
  refreshToken,
  payrollMonth,
  onNew,
  onEdit,
  onViewLedger,
  onNewPayslip,
  onChanged,
}: {
  refreshToken: number;
  payrollMonth: string;
  onNew: () => void;
  onEdit: (id: string) => void;
  onViewLedger: (id: string) => void;
  onNewPayslip: (id: string) => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<EmployeeItem[]>([]);
  const [capabilities, setCapabilities] = useState({ canCreate: false, canEdit: false, canBin: false });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewId, setViewId] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (status) params.set("status", status);
      const res = await fetch(`/api/employees?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load employees");
      setItems(data.items || []);
      setCapabilities(data.capabilities || { canCreate: false, canEdit: false, canBin: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load employees");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Re-fetches (GET only) whenever refreshToken bumps, i.e. after any
    // Employee/Payslip/Payment mutation elsewhere on the page, WITHOUT
    // remounting this component - search/status filters stay intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  async function handleMoveToBin(item: EmployeeItem) {
    const confirmed = window.confirm(
      `Move ${item.name} to Bin?\n\nThe employee will no longer appear in active Employee Accounts or Payroll. Historical ledger/payslips remain intact and this can be restored later.`
    );
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/employees/${item.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to move employee to Bin.");
      onChanged(); // bumps refreshToken -> the effect above refetches this tab
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move employee to Bin.");
    }
  }

  const filtered = useMemo(() => items, [items]);

  return (
    <div>
      <EmployeeSummaryCards refreshToken={refreshToken} payrollMonth={payrollMonth} />

      <div className="mb-4 flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Search employee..."
            className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
            <option value="">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="BINNED">Binned</option>
          </select>
          <button type="button" onClick={load} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            Search
          </button>
        </div>
        {capabilities.canCreate && (
          <button type="button" onClick={onNew} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            + New Employee
          </button>
        )}
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
        {loading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">Loading employees...</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">
            <p className="mb-3">No employees found.</p>
            {capabilities.canCreate && (
              <button type="button" onClick={onNew} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                + New Employee
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Designation</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setViewId(item.id)} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
                          View
                        </button>
                        {capabilities.canEdit && !item.isDeleted && (
                          <button type="button" onClick={() => onEdit(item.id)} className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50">
                            Edit
                          </button>
                        )}
                        {capabilities.canBin && !item.isDeleted && (
                          <button type="button" onClick={() => handleMoveToBin(item)} className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
                            Move to Bin
                          </button>
                        )}
                        {capabilities.canEdit && item.isDeleted && (
                          <button
                            type="button"
                            onClick={async () => {
                              await fetch(`/api/employees/${item.id}/restore`, { method: "POST" });
                              onChanged(); // bumps refreshToken -> the effect above refetches this tab
                            }}
                            className="rounded-md border border-green-200 px-3 py-1.5 text-xs font-medium text-green-600 hover:bg-green-50"
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{item.name}</div>
                      <div className="text-xs text-gray-500">{item.employeeCode}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{item.designation || "—"}</td>
                    <td className="px-4 py-3 text-gray-600">{item.phone || "—"}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {item.balanceStatus === "No Activity" ? "—" : `Rs. ${formatMoney(item.balance)}`}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor(item.isDeleted ? "Binned" : item.isActive ? item.balanceStatus : "Inactive")}`}>
                        {item.isDeleted ? "Binned" : !item.isActive ? "Inactive" : item.balanceStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewId && (
        <EmployeeQuickViewDrawer
          id={viewId}
          onClose={() => setViewId(null)}
          onEdit={() => {
            const id = viewId;
            setViewId(null);
            onEdit(id);
          }}
          onViewLedger={() => {
            const id = viewId;
            setViewId(null);
            onViewLedger(id);
          }}
          onNewPayslip={() => {
            const id = viewId;
            setViewId(null);
            onNewPayslip(id);
          }}
        />
      )}
    </div>
  );
}

// Traced to GET /api/employees/[id]'s `employee` field
// (app/api/employees/[id]/route.ts) - the exact response shape.
type EmployeeDetail = {
  name: string;
  employeeCode: string;
  designation: string | null;
  balance: number;
  balanceStatus: string;
  monthlySalary: number;
  recentPayslips: { id: string; payrollMonth: string; netPay: number }[];
};

function EmployeeQuickViewDrawer({
  id,
  onClose,
  onEdit,
  onViewLedger,
  onNewPayslip,
}: {
  id: string;
  onClose: () => void;
  onEdit: () => void;
  onViewLedger: () => void;
  onNewPayslip: () => void;
}) {
  const [data, setData] = useState<EmployeeDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/employees/${id}`);
      const json = await res.json();
      if (res.ok && json.success) setData(json.employee);
      setLoading(false);
    })();
  }, [id]);

  return (
    <Drawer open onClose={onClose} title="Employee">
      {loading || !data ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <div className="space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{data.name}</h3>
            <p className="text-sm text-gray-500">
              {data.employeeCode} {data.designation ? `• ${data.designation}` : ""}
            </p>
          </div>
          <div className="rounded-lg border bg-gray-50 p-4">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Current Balance</span>
              <span className="font-semibold text-gray-900">{data.balanceStatus === "No Activity" ? "—" : `Rs. ${formatMoney(data.balance)}`}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-gray-500">Status</span>
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(data.balanceStatus)}`}>{data.balanceStatus}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-gray-500">Monthly Salary</span>
              <span className="font-medium text-gray-900">Rs. {formatMoney(data.monthlySalary)}</span>
            </div>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-gray-700">Recent Payroll</h4>
            {data.recentPayslips.length === 0 ? (
              <p className="text-sm text-gray-500">No payslips yet.</p>
            ) : (
              <div className="space-y-2">
                {data.recentPayslips.map((p) => (
                  <div key={p.id} className="flex justify-between rounded-lg border px-3 py-2 text-sm">
                    <span>{p.payrollMonth}</span>
                    <span className="font-medium">Rs. {formatMoney(p.netPay)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <button type="button" onClick={onViewLedger} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
              View Ledger
            </button>
            <button type="button" onClick={onNewPayslip} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
              New Payslip
            </button>
            <button type="button" onClick={onEdit} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Edit Employee
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ============================================================
// TAB 2 - EMPLOYEE LEDGER
// ============================================================
function EmployeeLedgerTab({
  refreshToken,
  employees,
  employeeId,
  onEmployeeIdChange,
}: {
  refreshToken: number;
  employees: { id: string; name: string; employeeCode: string }[];
  employeeId: string;
  onEmployeeIdChange: (id: string) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<EmployeeLedgerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(id: string) {
    if (!id) return;
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/employees/${id}/ledger?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || "Unable to load ledger");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load ledger");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (employeeId) load(employeeId);
    // refreshToken dependency: if a payslip/payment is recorded while
    // this employee's ledger is the visible tab, reconcile immediately
    // (GET only) without requiring a tab switch or browser refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, refreshToken]);

  const employeeOptions = useMemo(
    () => employees.map((e) => ({ value: e.id, label: e.name, secondary: e.employeeCode })),
    [employees]
  );

  async function handleExport(format: "pdf" | "excel") {
    if (!employeeId) return;
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    window.open(`/api/employees/${employeeId}/ledger/${format}?${params.toString()}`, "_blank");
  }

  return (
    <div>
      <div className="mb-4 rounded-xl border bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs font-medium text-gray-600">Employee</label>
            <SearchableSelect value={employeeId} options={employeeOptions} placeholder="Search employee..." onChange={onEmployeeIdChange} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Date From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Date To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description..."
            className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <button type="button" onClick={() => load(employeeId)} disabled={!employeeId} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            Search
          </button>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={() => handleExport("pdf")} disabled={!employeeId} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50">
              PDF
            </button>
            <button type="button" onClick={() => handleExport("excel")} disabled={!employeeId} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50">
              Excel
            </button>
          </div>
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {!employeeId ? (
        <div className="rounded-xl border bg-white px-6 py-12 text-center text-sm text-gray-500 shadow-sm">Select an employee to view their ledger.</div>
      ) : loading ? (
        <div className="rounded-xl border bg-white px-6 py-12 text-center text-sm text-gray-500 shadow-sm">Loading ledger...</div>
      ) : data ? (
        <div className="rounded-xl border bg-white shadow-sm">
          <div className="border-b px-6 py-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{data.employee.name}</h2>
                <p className="text-sm text-gray-500">
                  Employee Account {data.employee.designation ? `• ${data.employee.designation}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-gray-900">
                  {data.currentStatus === "No Activity" ? "—" : `Rs. ${formatMoney(data.currentBalance)}`}
                </p>
                <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor(data.currentStatus)}`}>{data.currentStatus}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 border-b bg-gray-50 px-6 py-4 md:grid-cols-4">
            <div>
              <p className="text-xs text-gray-500">Opening Balance</p>
              <p className="font-semibold text-gray-900">Rs. {formatMoney(data.summary.openingBalance)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Debit</p>
              <p className="font-semibold text-gray-900">Rs. {formatMoney(data.summary.totalDebit)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Credit</p>
              <p className="font-semibold text-gray-900">Rs. {formatMoney(data.summary.totalCredit)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Closing Balance</p>
              <p className="font-semibold text-gray-900">Rs. {formatMoney(data.summary.closingBalance)}</p>
            </div>
          </div>

          {data.entries.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">No ledger transactions.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[700px] w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-3 text-gray-600">{new Date(e.date).toLocaleDateString("en-GB")}</td>
                      <td className="px-4 py-3 text-gray-900">{e.description}</td>
                      <td className="px-4 py-3 text-right">{e.debit > 0 ? `Rs. ${formatMoney(e.debit)}` : "—"}</td>
                      <td className="px-4 py-3 text-right">{e.credit > 0 ? `Rs. ${formatMoney(e.credit)}` : "—"}</td>
                      <td className="px-4 py-3 text-right font-semibold">Rs. {formatMoney(e.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================
// TAB 3 - PAYROLL & PAYSLIPS
// ============================================================

// Traced to GET /api/payslips's `items` field
// (app/api/payslips/route.ts) - the exact response shape.
type PayslipListItem = {
  id: string;
  payslipNo: string;
  employeeId: string;
  employeeName: string;
  designation: string | null;
  payrollMonth: string;
  payDate: string;
  grossPay: number;
  deduction: number;
  netPay: number;
  contribution: number;
  paidAmount: number;
  remainingAmount: number;
  status: PayslipPaymentState["status"];
};

function PayrollTab({
  refreshToken,
  month,
  onMonthChange,
  onNewPayslip,
  onEditPayslip,
  onRecordPayment,
  onChanged,
  initialPrefillEmployeeId,
}: {
  refreshToken: number;
  month: string;
  onMonthChange: (month: string) => void;
  onNewPayslip: (employeeId?: string) => void;
  onEditPayslip: (id: string) => void;
  onRecordPayment: (id: string) => void;
  onChanged: () => void;
  initialPrefillEmployeeId?: string;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [items, setItems] = useState<PayslipListItem[]>([]);
  const [totals, setTotals] = useState({ grossPay: 0, deduction: 0, netPay: 0, paid: 0, payable: 0 });
  const [capabilities, setCapabilities] = useState({ canCreate: false, canEdit: false, canBin: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewId, setViewId] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      params.set("payrollMonth", month);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/payslips?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to load payroll");
      setItems(data.items || []);
      setTotals(data.totals || { grossPay: 0, deduction: 0, netPay: 0, paid: 0, payable: 0 });
      setCapabilities(data.capabilities || { canCreate: false, canEdit: false, canBin: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load payroll");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // refreshToken: re-fetch (GET only) after any mutation elsewhere
    // on the page, without remounting - search/status filters and the
    // selected month stay intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, refreshToken]);

  useEffect(() => {
    if (initialPrefillEmployeeId) onNewPayslip(initialPrefillEmployeeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrefillEmployeeId]);

  const filtered = statusFilter ? items.filter((i) => i.status === statusFilter) : items;

  function shiftMonth(delta: number) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    onMonthChange(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  async function handleMoveToBin(item: PayslipListItem) {
    const confirmed = window.confirm(
      "Move this payslip to Bin?\n\nIts salary recognition accounting will be excluded from normal reports. This is not permanent deletion."
    );
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/payslips/${item.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to move payslip to Bin.");
      onChanged(); // bumps refreshToken -> the effect above refetches this tab
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to move payslip to Bin.");
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5 shadow-sm">
          <button type="button" onClick={() => shiftMonth(-1)} className="rounded-md px-2 py-1 text-sm hover:bg-gray-50">
            ← Previous Month
          </button>
          <span className="min-w-[140px] text-center font-semibold text-gray-900">{new Date(`${month}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</span>
          <button type="button" onClick={() => shiftMonth(1)} className="rounded-md px-2 py-1 text-sm hover:bg-gray-50">
            Next Month →
          </button>
        </div>
        <div className="flex gap-2">
          {capabilities.canCreate && (
            <button type="button" onClick={() => onNewPayslip()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              + New Payslip
            </button>
          )}
          <button type="button" onClick={() => window.open(`/api/payslips/export?payrollMonth=${month}`, "_blank")} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            Export
          </button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-5">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Total Gross Pay</p>
          <p className="mt-1 font-semibold text-gray-900">Rs. {formatMoney(totals.grossPay)}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Total Deductions</p>
          <p className="mt-1 font-semibold text-gray-900">Rs. {formatMoney(totals.deduction)}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Total Net Pay</p>
          <p className="mt-1 font-semibold text-gray-900">Rs. {formatMoney(totals.netPay)}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Total Paid</p>
          <p className="mt-1 font-semibold text-green-700">Rs. {formatMoney(totals.paid)}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Total Payable</p>
          <p className="mt-1 font-semibold text-yellow-700">Rs. {formatMoney(totals.payable)}</p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Search employee/payslip no..."
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
          <option value="">All Status</option>
          <option value="Unpaid">Unpaid</option>
          <option value="Partially Paid">Partially Paid</option>
          <option value="Paid">Paid</option>
          <option value="Paid in Advance">Paid in Advance</option>
        </select>
        <button type="button" onClick={load} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
          Search
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
        {loading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">Loading payroll...</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-500">No payslips for this payroll period.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[950px] w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3 text-right">Gross Pay</th>
                  <th className="px-4 py-3 text-right">Deduction</th>
                  <th className="px-4 py-3 text-right">Net Pay</th>
                  <th className="px-4 py-3 text-right">Contribution</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setViewId(p.id)} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
                          View
                        </button>
                        {capabilities.canEdit && (
                          <button type="button" onClick={() => onEditPayslip(p.id)} className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50">
                            Edit
                          </button>
                        )}
                        {capabilities.canBin && (
                          <button type="button" onClick={() => handleMoveToBin(p)} className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
                            Move to Bin
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{new Date(p.payDate).toLocaleDateString("en-GB")}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{p.employeeName}</div>
                      <div className="text-xs text-gray-500">{p.payslipNo}</div>
                    </td>
                    <td className="px-4 py-3 text-right">Rs. {formatMoney(p.grossPay)}</td>
                    <td className="px-4 py-3 text-right">Rs. {formatMoney(p.deduction)}</td>
                    <td className="px-4 py-3 text-right font-semibold">Rs. {formatMoney(p.netPay)}</td>
                    <td className="px-4 py-3 text-right">{p.contribution > 0 ? `Rs. ${formatMoney(p.contribution)}` : "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor(p.status)}`}>{p.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewId && (
        <PayslipViewDrawer
          id={viewId}
          onClose={() => setViewId(null)}
          onRecordPayment={() => {
            const id = viewId;
            setViewId(null);
            onRecordPayment(id);
          }}
        />
      )}
    </div>
  );
}

// Traced to GET /api/payslips/[id]'s `payslip` field
// (app/api/payslips/[id]/route.ts) - the exact response shape.
type PayslipDetail = {
  payslipNo: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  designation: string | null;
  payrollMonth: string;
  payDate: string;
  grossPay: number;
  deduction: number;
  netPay: number;
  contribution: number;
  notes: string | null;
  paidAmount: number;
  remainingAmount: number;
  status: PayslipPaymentState["status"];
  canEditAmounts: boolean;
  payments: { date: string; amount: number }[];
};

function PayslipViewDrawer({ id, onClose, onRecordPayment }: { id: string; onClose: () => void; onRecordPayment: () => void }) {
  const [data, setData] = useState<PayslipDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/payslips/${id}`);
      const json = await res.json();
      if (res.ok && json.success) setData(json.payslip);
      setLoading(false);
    })();
  }, [id]);

  return (
    <Drawer open onClose={onClose} title="Payslip">
      {loading || !data ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <div className="space-y-5 text-sm">
          <div className="text-center border-b pb-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">Al Naeem Car Carriers Service</p>
            <h3 className="mt-1 text-lg font-semibold text-gray-900">{data.payslipNo}</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500">Employee</p>
              <p className="font-medium">{data.employeeName}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Designation</p>
              <p className="font-medium">{data.designation || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Payroll Month</p>
              <p className="font-medium">{data.payrollMonth}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Pay Date</p>
              <p className="font-medium">{new Date(data.payDate).toLocaleDateString("en-GB")}</p>
            </div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="flex justify-between py-1"><span className="text-gray-500">Gross Pay</span><span className="font-medium">Rs. {formatMoney(data.grossPay)}</span></div>
            <div className="flex justify-between py-1"><span className="text-gray-500">Deduction</span><span className="font-medium">Rs. {formatMoney(data.deduction)}</span></div>
            <div className="flex justify-between border-t py-1 mt-1"><span className="font-semibold">Net Pay</span><span className="font-bold">Rs. {formatMoney(data.netPay)}</span></div>
            {data.contribution > 0 && <div className="flex justify-between py-1 text-xs text-gray-500"><span>Contribution (informational)</span><span>Rs. {formatMoney(data.contribution)}</span></div>}
          </div>
          <div className="rounded-lg border bg-gray-50 p-4">
            <div className="flex justify-between py-1"><span className="text-gray-500">Paid</span><span className="font-medium text-green-700">Rs. {formatMoney(data.paidAmount)}</span></div>
            <div className="flex justify-between py-1"><span className="text-gray-500">Remaining</span><span className="font-medium">Rs. {formatMoney(data.remainingAmount)}</span></div>
            <div className="flex justify-between py-1"><span className="text-gray-500">Status</span><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(data.status)}`}>{data.status}</span></div>
          </div>
          <div className="flex gap-2 border-t pt-4">
            <button type="button" onClick={() => window.print()} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">Print</button>
            {data.remainingAmount > 0.01 && (
              <button type="button" onClick={onRecordPayment} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700">Record Payment</button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ============================================================
// EMPLOYEE DRAWER (New/Edit)
// ============================================================
function EmployeeDrawer({ state, onClose, onSaved }: { state: { mode: "new" | "edit"; id?: string } | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [designation, setDesignation] = useState("");
  const [phone, setPhone] = useState("");
  const [joiningDate, setJoiningDate] = useState(todayYMD());
  const [monthlySalary, setMonthlySalary] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!state) return;
    setError("");
    if (state.mode === "new") {
      setName("");
      setDesignation("");
      setPhone("");
      setJoiningDate(todayYMD());
      setMonthlySalary("");
      setIsActive(true);
      setNotes("");
    } else if (state.id) {
      (async () => {
        const res = await fetch(`/api/employees/${state.id}`);
        const json = await res.json();
        if (res.ok && json.success) {
          const e = json.employee;
          setName(e.name);
          setDesignation(e.designation || "");
          setPhone(e.phone || "");
          setJoiningDate(e.joiningDate ? e.joiningDate.slice(0, 10) : todayYMD());
          setMonthlySalary(String(e.monthlySalary));
          setIsActive(e.isActive);
          setNotes(e.notes || "");
        }
      })();
    }
  }, [state]);

  async function handleSave() {
    setError("");
    if (!name.trim()) {
      setError("Employee name is required.");
      return;
    }
    const salary = Number(monthlySalary) || 0;
    if (salary < 0) {
      setError("Monthly salary cannot be negative.");
      return;
    }
    try {
      setSaving(true);
      const payload = { name: name.trim(), designation: designation.trim() || undefined, phone: phone.trim() || undefined, joiningDate: joiningDate || undefined, monthlySalary: salary, isActive, notes: notes.trim() || undefined };
      const url = state?.mode === "edit" ? `/api/employees/${state.id}` : "/api/employees";
      const method = state?.mode === "edit" ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to save employee.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save employee.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={!!state} onClose={onClose} title={state?.mode === "edit" ? "Edit Employee" : "New Employee"}>
      <div className="space-y-5">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">Employee Information</h3>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Employee Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Designation</label>
              <input type="text" value={designation} onChange={(e) => setDesignation(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Phone</label>
              <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Joining Date</label>
              <input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          </div>
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">Salary & Account</h3>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Monthly Salary</label>
              <input type="number" min="0" step="0.01" value={monthlySalary} onChange={(e) => setMonthlySalary(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
            {state?.mode === "edit" && (
              <p className="text-xs text-gray-500">Linked Employee Account is fixed for the life of this record - it cannot be reassigned here.</p>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>

        <div className="flex justify-end gap-3 border-t pt-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border px-5 py-2.5 text-sm font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving..." : "Save Employee"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

// ============================================================
// PAYSLIP DRAWER (New/Edit)
// ============================================================
function PayslipDrawer({
  state,
  employees,
  onClose,
  onSaved,
}: {
  state: { mode: "new" | "edit"; id?: string; employeeId?: string } | null;
  employees: { id: string; name: string; employeeCode: string; monthlySalary: number }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [payrollMonth, setPayrollMonth] = useState(thisMonth());
  const [payDate, setPayDate] = useState(todayYMD());
  const [grossPay, setGrossPay] = useState("");
  const [deduction, setDeduction] = useState("0");
  const [contribution, setContribution] = useState("0");
  const [notes, setNotes] = useState("");
  const [canEditAmounts, setCanEditAmounts] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!state) return;
    setError("");
    if (state.mode === "new") {
      setEmployeeId(state.employeeId || "");
      setPayrollMonth(thisMonth());
      setPayDate(todayYMD());
      setGrossPay("");
      setDeduction("0");
      setContribution("0");
      setNotes("");
      setCanEditAmounts(true);
      setSubmissionKey(crypto.randomUUID());
    } else if (state.id) {
      (async () => {
        const res = await fetch(`/api/payslips/${state.id}`);
        const json = await res.json();
        if (res.ok && json.success) {
          const p = json.payslip;
          setEmployeeId(p.employeeId);
          setPayrollMonth(p.payrollMonth);
          setPayDate(p.payDate.slice(0, 10));
          setGrossPay(String(p.grossPay));
          setDeduction(String(p.deduction));
          setContribution(String(p.contribution));
          setNotes(p.notes || "");
          setCanEditAmounts(p.canEditAmounts);
        }
      })();
    }
  }, [state]);

  useEffect(() => {
    if (state?.mode === "new" && employeeId) {
      const emp = employees.find((e) => e.id === employeeId);
      if (emp && !grossPay) setGrossPay(String(emp.monthlySalary));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, employees]);

  const netPay = Math.max(0, (Number(grossPay) || 0) - (Number(deduction) || 0));

  const employeeOptions = useMemo(() => employees.map((e) => ({ value: e.id, label: e.name, secondary: e.employeeCode })), [employees]);

  async function handleSave() {
    setError("");
    if (!employeeId) {
      setError("Please select an employee.");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(payrollMonth)) {
      setError("Invalid payroll month.");
      return;
    }
    const gross = Number(grossPay) || 0;
    const ded = Number(deduction) || 0;
    const contrib = Number(contribution) || 0;
    if (gross < 0) return setError("Gross Pay cannot be negative.");
    if (ded < 0) return setError("Deduction cannot be negative.");
    if (ded > gross) return setError("Deduction cannot exceed Gross Pay.");

    try {
      setSaving(true);
      if (state?.mode === "edit") {
        const res = await fetch(`/api/payslips/${state.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payDate, grossPay: gross, deduction: ded, contribution: contrib, notes: notes.trim() || undefined }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || "Unable to update payslip.");
      } else {
        const res = await fetch("/api/payslips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employeeId,
            payrollMonth,
            payDate,
            grossPay: gross,
            deduction: ded,
            contribution: contrib,
            notes: notes.trim() || undefined,
            idempotencyKey: submissionKey,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || "Unable to create payslip.");
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save payslip.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={!!state} onClose={onClose} title={state?.mode === "edit" ? "Edit Payslip" : "New Payslip"}>
      <div className="space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {state?.mode === "edit" && !canEditAmounts && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-xs text-yellow-800">
            A payment has already been recorded against this payslip - Gross Pay, Deduction, and Contribution can no longer be changed.
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Employee</label>
          <SearchableSelect value={employeeId} options={employeeOptions} placeholder="Search employee..." onChange={setEmployeeId} disabled={state?.mode === "edit"} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Payroll Month</label>
            <input type="month" value={payrollMonth} onChange={(e) => setPayrollMonth(e.target.value)} disabled={state?.mode === "edit"} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Pay Date</label>
            <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Gross Pay</label>
            <input type="number" min="0" step="0.01" value={grossPay} disabled={!canEditAmounts} onChange={(e) => setGrossPay(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Deduction</label>
            <input type="number" min="0" step="0.01" value={deduction} disabled={!canEditAmounts} onChange={(e) => setDeduction(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Contribution (informational only)</label>
          <input type="number" min="0" step="0.01" value={contribution} disabled={!canEditAmounts} onChange={(e) => setContribution(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100" />
        </div>
        <div className="rounded-lg border bg-gray-50 px-4 py-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Net Pay</span>
            <span className="font-bold text-gray-900">Rs. {formatMoney(netPay)}</span>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
        </div>

        <div className="flex justify-end gap-3 border-t pt-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border px-5 py-2.5 text-sm font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving..." : "Save Payslip"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}

// ============================================================
// PAYMENT DRAWER
// ============================================================

// Traced to GET /api/accounts's `accounts` field (each Account row) -
// narrowed to only the fields this drawer reads.
type RawAccountRecord = {
  id: string;
  accountName: string;
  category: string;
  isActive: boolean;
};

function PaymentDrawer({ state, onClose, onSaved }: { state: { id: string } | null; onClose: () => void; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<{ id: string; accountName: string; category: string }[]>([]);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayYMD());
  const [remaining, setRemaining] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!state) return;
    setError("");
    setAccountId("");
    setAmount("");
    setPaymentDate(todayYMD());
    setSubmissionKey(crypto.randomUUID());
    (async () => {
      const [accRes, psRes] = await Promise.all([fetch("/api/accounts"), fetch(`/api/payslips/${state.id}`)]);
      const accData = await accRes.json();
      const psData = await psRes.json();
      if (accRes.ok && accData.success) {
        setAccounts((accData.accounts || []).filter((a: RawAccountRecord) => a.isActive && (a.category === "CASH" || a.category === "BANK")));
      }
      if (psRes.ok && psData.success) {
        setRemaining(psData.payslip.remainingAmount);
        setAmount(String(psData.payslip.remainingAmount));
      }
    })();
  }, [state]);

  const accountOptions = useMemo(() => accounts.map((a) => ({ value: a.id, label: a.accountName, secondary: a.category })), [accounts]);

  async function handleSave() {
    setError("");
    const amt = Number(amount) || 0;
    if (amt <= 0) return setError("Payment amount must be greater than zero.");
    if (!accountId) return setError("Please select a Cash or Bank account.");
    // A payment MAY exceed the remaining payable amount - approved as
    // a deliberate advance against the employee (drives the payslip/
    // employee balance into "Paid in Advance"). Not blocked here; see
    // the advance notice rendered below the Amount field instead.

    try {
      setSaving(true);
      const res = await fetch(`/api/payslips/${state!.id}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt, paymentDate, accountId, idempotencyKey: submissionKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "Unable to record payment.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to record payment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={!!state} onClose={onClose} title="Record Salary Payment">
      <div className="space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <div className="rounded-lg border bg-gray-50 px-4 py-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Remaining Payable</span>
            <span className="font-bold text-gray-900">Rs. {formatMoney(remaining)}</span>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Payment Account (Cash/Bank)</label>
          <SearchableSelect value={accountId} options={accountOptions} placeholder="Search account..." onChange={setAccountId} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Amount</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Payment Date</label>
            <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </div>
        </div>
        {Number(amount) > remaining + 0.01 && (
          <div className="rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-xs text-purple-800">
            This payment exceeds the remaining payable amount by Rs. {formatMoney(Number(amount) - remaining)} - it will be recorded as an advance to this employee (status &quot;Paid in Advance&quot;).
          </div>
        )}
        <div className="flex justify-end gap-3 border-t pt-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border px-5 py-2.5 text-sm font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="rounded-lg bg-green-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
            {saving ? "Recording..." : "Record Payment"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
