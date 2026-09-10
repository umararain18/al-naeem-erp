import type { AuthUser } from "@/lib/auth";

export type Permission =
  | "users.view"
  | "users.create"
  | "users.edit"
  | "users.delete"
  | "parties.view"
  | "parties.create"
  | "parties.edit"
  | "parties.delete"
  | "bilty.view"
      | "bilty.bin"
  | "bilty.binView"
  | "bilty.restore"
  | "bilty.permanentlyDelete"
  | "bilty.create"
  | "bilty.edit"
  | "bilty.delete"
    
  | "challan.view"
  | "challan.create"
  | "challan.edit"
  | "challan.delete"
  | "accounts.view"
  | "accounts.create"
  | "accounts.edit"
  | "accounts.delete"
  | "reports.view"
  | "reports.export"
  | "settings.view"
  | "settings.edit"
  | "accountingTransactions.view"
  | "accountingTransactions.bin"
  | "accountingTransactions.binView"
  | "accountingTransactions.restore"
  | "accountingTransactions.permanentlyDelete"
  | "bin.view";

const permissions: Record<AuthUser["role"], Permission[]> = {
  SUPER_ADMIN: [
    "users.view",
    "users.create",
    "users.edit",
    "users.delete",

    "bilty.view",
    "bilty.create",
    "bilty.edit",
    "bilty.delete",
        "bilty.bin",
    "bilty.binView",
    "bilty.restore",
    "bilty.permanentlyDelete",
    

    "parties.view",
    "parties.create",
    "parties.edit",
    "parties.delete",

    "challan.view",
    "challan.create",
    "challan.edit",
    "challan.delete",

    "accounts.view",
    "accounts.create",
    "accounts.edit",
    "accounts.delete",

    "reports.view",
    "reports.export",

    "settings.view",
    "settings.edit",

    "accountingTransactions.view",
    "accountingTransactions.bin",
    "accountingTransactions.binView",
    "accountingTransactions.restore",
    "accountingTransactions.permanentlyDelete",

    "bin.view",
  ],

  MANAGER: [
    "users.view",

    "bilty.view",
    "bilty.create",
    "bilty.edit",
        "bilty.bin",
    "bilty.binView",
    "bilty.restore",
    
    "parties.view",
    "parties.create",
    "parties.edit",

    "challan.view",
    "challan.create",
    "challan.edit",

    "accounts.view",
    "accounts.create",
    "accounts.edit",

    "reports.view",
    "reports.export",

    "settings.view",

    "accountingTransactions.view",
    "accountingTransactions.bin",
    "accountingTransactions.binView",
    "accountingTransactions.restore",

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

export function hasPermission(
  user: AuthUser,
  permission: Permission
): boolean {
  return permissions[user.role].includes(permission);
}

export function requirePermission(
  user: AuthUser,
  permission: Permission
): void {
  if (!hasPermission(user, permission)) {
    throw new Error("FORBIDDEN");
  }
}
