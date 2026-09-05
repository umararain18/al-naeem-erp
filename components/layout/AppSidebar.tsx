"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  FileText,
  ClipboardList,
  Users,
  Wallet,
  PenLine,
  Banknote,
  BookOpen,
  BarChart3,
  Trash2,
  Menu,
  X,
  ChevronLeft,
} from "lucide-react";

type User = {
  username: string;
  role: "SUPER_ADMIN" | "MANAGER" | "VIEWER";
};

type NavItem = {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
  match: (pathname: string) => boolean;
};

const navigation: { section: string; items: NavItem[] }[] = [
  {
    section: "MAIN",
    items: [
      {
        label: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        match: (pathname) => pathname === "/dashboard",
      },
    ],
  },
  {
    section: "OPERATIONS",
    items: [
      {
        label: "Bilty",
        href: "/bilty",
        icon: FileText,
        permission: "bilty.view",
        match: (pathname) => pathname === "/bilty" || pathname.startsWith("/bilty/"),
      },
      {
        label: "Challan",
        href: "/challan",
        icon: ClipboardList,
        permission: "challan.view",
        match: (pathname) => pathname === "/challan" || pathname.startsWith("/challan/"),
      },
    ],
  },
  {
    section: "PARTIES",
    items: [
      {
        label: "Parties",
        href: "/parties",
        icon: Users,
        permission: "parties.view",
        match: (pathname) => pathname === "/parties" || pathname.startsWith("/parties/"),
      },
    ],
  },
  {
    section: "ACCOUNTING",
    items: [
      {
        label: "Accounts",
        href: "/accounts",
        icon: Wallet,
        permission: "accounts.view",
        match: (pathname) => pathname === "/accounts" || pathname.startsWith("/accounts/"),
      },
      {
        label: "Daily Posting",
        href: "/daily-posting",
        icon: PenLine,
        permission: "accountingTransactions.view",
        match: (pathname) => pathname === "/daily-posting" || pathname.startsWith("/daily-posting/"),
      },
      {
        label: "Cash Book",
        href: "/cash-book",
        icon: Banknote,
        permission: "accounts.view",
        match: (pathname) => pathname === "/cash-book" || pathname.startsWith("/cash-book/"),
      },
      {
        label: "General Ledger",
        href: "/ledger",
        icon: BookOpen,
        permission: "accounts.view",
        match: (pathname) => pathname === "/ledger" || pathname.startsWith("/ledger/"),
      },
    ],
  },
  {
    section: "REPORTS",
    items: [
      {
        label: "Trial Balance",
        href: "/reports/trial-balance",
        icon: BarChart3,
        permission: "reports.view",
        match: (pathname) => pathname === "/reports/trial-balance",
      },
      {
        label: "Profit & Loss",
        href: "/reports/profit-loss",
        icon: BarChart3,
        permission: "reports.view",
        match: (pathname) => pathname === "/reports/profit-loss",
      },
      {
        label: "Receivable",
        href: "/reports/receivable",
        icon: BarChart3,
        permission: "reports.view",
        match: (pathname) => pathname === "/reports/receivable",
      },
      {
        label: "Payable",
        href: "/reports/payable",
        icon: BarChart3,
        permission: "reports.view",
        match: (pathname) => pathname === "/reports/payable",
      },
    ],
  },
  {
    section: "SYSTEM",
    items: [
      {
        label: "Bin",
        href: "/bin",
        icon: Trash2,
        permission: "bin.view",
        match: (pathname) => pathname === "/bin" || pathname.startsWith("/bin/"),
      },
    ],
  },
];

function hasPermission(user: User | null, permission?: string): boolean {
  if (!permission) return true;
  if (!user) return false;
  
  const permissions: Record<string, string[]> = {
    SUPER_ADMIN: [
      "users.view", "users.create", "users.edit", "users.delete",
      "bilty.view", "bilty.create", "bilty.edit", "bilty.delete", "bilty.bin", "bilty.binView", "bilty.restore", "bilty.permanentlyDelete",
      "parties.view", "parties.create", "parties.edit", "parties.delete",
      "challan.view", "challan.create", "challan.edit", "challan.delete", "challan.bin", "challan.binView", "challan.restore", "challan.permanentlyDelete",
      "accounts.view", "accounts.create", "accounts.edit", "accounts.delete",
      "reports.view", "reports.export",
      "settings.view", "settings.edit",
      "accountingTransactions.view", "accountingTransactions.bin", "accountingTransactions.binView", "accountingTransactions.restore", "accountingTransactions.permanentlyDelete",
      "bin.view",
    ],
    MANAGER: [
      "users.view",
      "bilty.view", "bilty.create", "bilty.edit", "bilty.bin", "bilty.binView", "bilty.restore",
      "parties.view", "parties.create", "parties.edit",
      "challan.view", "challan.create", "challan.edit", "challan.bin", "challan.binView", "challan.restore",
      "accounts.view", "accounts.create", "accounts.edit",
      "reports.view", "reports.export",
      "settings.view",
      "accountingTransactions.view", "accountingTransactions.bin", "accountingTransactions.binView", "accountingTransactions.restore",
      "bin.view",
    ],
    VIEWER: [
      "bilty.view",
      "challan.view",
      "accounts.view",
      "parties.view",
      "accountingTransactions.view",
      "reports.view",
      "reports.export",
    ],
  };

  return permissions[user.role]?.includes(permission) ?? false;
}

export default function AppSidebar({ user }: { user: User | null }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNavigate = () => {
    setMobileOpen(false);
  };

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile menu button */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed top-4 left-4 z-50 lg:hidden border rounded-lg p-2 bg-white shadow-sm hover:bg-gray-50"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 bg-gray-900 text-white transition-all duration-300 flex flex-col
          lg:sticky lg:top-0 lg:h-screen lg:z-auto
          ${collapsed ? "w-[64px]" : "w-[240px]"}
          ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
      >
        {/* Brand */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-gray-800 flex-shrink-0">
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">AL NAEEM</p>
              <p className="text-[10px] text-gray-400 truncate">CAR CARRIERS SERVICE</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex items-center justify-center w-8 h-8 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronLeft className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="lg:hidden flex items-center justify-center w-8 h-8 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-4">
          {user &&
            navigation.map((group) => {
            const visibleItems = group.items.filter((item) =>
              hasPermission(user, item.permission)
            );

            if (visibleItems.length === 0) return null;

            return (
              <div key={group.section}>
                {!collapsed && (
                  <p className="px-2 mb-2 text-[10px] font-medium text-gray-500 uppercase tracking-wider">
                    {group.section}
                  </p>
                )}
                <div className="space-y-1">
                  {visibleItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = pathname ? item.match(pathname) : false;

                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={handleNavigate}
                        title={collapsed ? item.label : undefined}
                        className={`
                          flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors
                          ${isActive
                            ? "bg-gray-800 text-white"
                            : "text-gray-300 hover:bg-gray-800 hover:text-white"
                          }
                          ${collapsed ? "justify-center" : ""}
                        `}
                      >
                        <Icon className="h-4 w-4 flex-shrink-0" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* User / Logout */}
        {user && (
          <div className="border-t border-gray-800 p-2">
            {!collapsed ? (
              <div className="space-y-2">
                <div className="px-2 py-1">
                  <p className="text-sm font-medium truncate">{user.username}</p>
                  <p className="text-[10px] text-gray-400">{user.role.replace("_", " ")}</p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch("/api/auth/logout", { method: "POST" });
                    window.location.reload();
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white w-full"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-log-out"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y2="12"/></svg>
                  <span>Logout</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs font-medium">
                  {user.username.charAt(0).toUpperCase()}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch("/api/auth/logout", { method: "POST" });
                    window.location.reload();
                  }}
                  className="text-gray-400 hover:text-white"
                  title="Logout"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-log-out"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y2="12"/></svg>
                </button>
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Mobile padding */}
      <div className="lg:hidden h-14" />
    </>
  );
}
