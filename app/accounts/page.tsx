"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

type AccountType =
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "INCOME"
  | "EXPENSE";

type AccountCategory =
  | "CASH"
  | "BANK"
  | "RECEIVABLE"
  | "PAYABLE"
  | "OTHER_ASSET"
  | "TRANSPORTER_PAYABLE"
  | "DELIVERY_POINT_PAYABLE"
  | "VENDOR_PAYABLE"
  | "OTHER_LIABILITY"
  | "OWNER_CAPITAL"
  | "OWNER_DRAWING"
  | "OTHER_EQUITY"
  | "BOOKING_INCOME"
  | "DELIVERY_INCOME"
  | "CARRIER_INCOME"
  | "OTHER_INCOME"
  | "FUEL"
  | "OFFICE_RENT"
  | "SALARY"
  | "ELECTRICITY"
  | "TEA_REFRESHMENT"
  | "REPAIR_MAINTENANCE"
  | "OTHER_EXPENSE";

type Party = {
  id: string;
  partyName: string;
};

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: AccountType;
  category: AccountCategory;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;

  parentId: string | null;

  parent: {
    id: string;
    accountName: string;
    accountCode: string | null;
  } | null;

  partyId: string | null;

  party: {
    id: string;
    partyName: string;
  } | null;
};

const accountTypes: {
  value: AccountType;
  label: string;
}[] = [
  {
    value: "ASSET",
    label: "Assets",
  },
  {
    value: "LIABILITY",
    label: "Liabilities",
  },
  {
    value: "EQUITY",
    label: "Equity",
  },
  {
    value: "INCOME",
    label: "Income",
  },
  {
    value: "EXPENSE",
    label: "Expenses",
  },
];

const categoriesByType: Record<
  AccountType,
  {
    value: AccountCategory;
    label: string;
  }[]
> = {
  ASSET: [
    {
      value: "CASH",
      label: "Cash",
    },
    {
      value: "BANK",
      label: "Bank",
    },
    {
      value: "RECEIVABLE",
      label: "Receivable",
    },
    {
      value: "OTHER_ASSET",
      label: "Other Asset",
    },
  ],

  LIABILITY: [
    {
      value: "PAYABLE",
      label: "Payable",
    },
    {
      value: "TRANSPORTER_PAYABLE",
      label: "Transporter Payable",
    },
    {
      value: "DELIVERY_POINT_PAYABLE",
      label: "Delivery Point Payable",
    },
    {
      value: "VENDOR_PAYABLE",
      label: "Vendor Payable",
    },
    {
      value: "OTHER_LIABILITY",
      label: "Other Liability",
    },
  ],

  EQUITY: [
    {
      value: "OWNER_CAPITAL",
      label: "Owner Capital",
    },
    {
      value: "OWNER_DRAWING",
      label: "Owner Drawing",
    },
    {
      value: "OTHER_EQUITY",
      label: "Other Equity",
    },
  ],

  INCOME: [
    {
      value: "BOOKING_INCOME",
      label: "Booking Income",
    },
    {
      value: "DELIVERY_INCOME",
      label: "Delivery Income",
    },
    {
      value: "CARRIER_INCOME",
      label: "Carrier Income",
    },
    {
      value: "OTHER_INCOME",
      label: "Other Income",
    },
  ],

  EXPENSE: [
    {
      value: "FUEL",
      label: "Petrol / Fuel",
    },
    {
      value: "OFFICE_RENT",
      label: "Office Rent",
    },
    {
      value: "SALARY",
      label: "Salary",
    },
    {
      value: "ELECTRICITY",
      label: "Electricity",
    },
    {
      value: "TEA_REFRESHMENT",
      label: "Tea / Refreshment",
    },
    {
      value: "REPAIR_MAINTENANCE",
      label: "Repair & Maintenance",
    },
    {
      value: "OTHER_EXPENSE",
      label: "Other Expense",
    },
  ],
};

function getDefaultCategory(
  type: AccountType
): AccountCategory {
  return categoriesByType[type][0]
    .value;
}

function formatCategory(
  category: AccountCategory
) {
  for (const type of accountTypes) {
    const found =
      categoriesByType[type.value].find(
        (item) =>
          item.value === category
      );

    if (found) {
      return found.label;
    }
  }

  return category;
}

export default function AccountsPage() {
  const [accounts, setAccounts] =
    useState<Account[]>([]);

  const [parties, setParties] =
    useState<Party[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [actionLoading, setActionLoading] =
    useState<string | null>(null);

  const [editingAccount, setEditingAccount] =
    useState<Account | null>(null);

  const [error, setError] =
    useState("");

  const [message, setMessage] =
    useState("");

  const [search, setSearch] =
    useState("");

  const [typeFilter, setTypeFilter] =
    useState<
      AccountType | "ALL"
    >("ALL");

  const [statusFilter, setStatusFilter] =
    useState<
      "ALL" | "ACTIVE" | "INACTIVE"
    >("ALL");

  const [accountName, setAccountName] =
    useState("");

  const [accountCode, setAccountCode] =
    useState("");

  const [accountType, setAccountType] =
    useState<AccountType>("ASSET");

  const [category, setCategory] =
    useState<AccountCategory>(
      getDefaultCategory("ASSET")
    );

  const [description, setDescription] =
    useState("");

  const [parentId, setParentId] =
    useState("");

  const [partyId, setPartyId] =
    useState("");

  function resetForm() {
    setAccountName("");
    setAccountCode("");
    setAccountType("ASSET");
    setCategory(
      getDefaultCategory("ASSET")
    );
    setDescription("");
    setParentId("");
    setPartyId("");
  }

  async function loadAccounts() {
    try {
      setError("");

      const response = await fetch(
        "/api/accounts"
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            "Unable to load accounts"
        );
        return;
      }

      setAccounts(data.accounts);
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadParties() {
    try {
      const response = await fetch(
        "/api/parties"
      );

      const data = await response.json();

      if (response.ok) {
        setParties(
          data.parties || []
        );
      }
    } catch {
      console.error(
        "Unable to load parties"
      );
    }
  }

  useEffect(() => {
    loadAccounts();
    loadParties();
  }, []);

  function handleAccountTypeChange(
    value: AccountType
  ) {
    setAccountType(value);

    setCategory(
      getDefaultCategory(value)
    );

    setParentId("");
  }

  async function handleSubmit(
    event: FormEvent
  ) {
    event.preventDefault();

    setError("");
    setMessage("");

    if (!accountName.trim()) {
      setError(
        "Account name is required"
      );
      return;
    }

    setSaving(true);

    try {
      const url = editingAccount
        ? `/api/accounts/${editingAccount.id}`
        : "/api/accounts";

      const response = await fetch(url, {
        method: editingAccount
          ? "PATCH"
          : "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          accountName:
            accountName.trim(),

          accountCode:
            accountCode.trim(),

          accountType,

          category,

          description:
            description.trim(),

          parentId: parentId || "",

          partyId: partyId || "",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            "Unable to save account"
        );
        return;
      }

      setMessage(
        editingAccount
          ? "Account updated successfully."
          : "Account created successfully."
      );

      setEditingAccount(null);

      resetForm();

      await loadAccounts();
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setSaving(false);
    }
  }

  function startEditing(
    account: Account
  ) {
    setEditingAccount(account);

    setAccountName(
      account.accountName
    );

    setAccountCode(
      account.accountCode || ""
    );

    setAccountType(
      account.accountType
    );

    setCategory(
      account.category
    );

    setDescription(
      account.description || ""
    );

    setParentId(
      account.parentId || ""
    );

    setPartyId(
      account.partyId || ""
    );

    setError("");
    setMessage("");

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function cancelEdit() {
    setEditingAccount(null);

    resetForm();

    setError("");
    setMessage("");
  }

  async function toggleActive(
    account: Account
  ) {
    if (account.isSystem) {
      setError(
        "System accounts cannot be deactivated."
      );
      return;
    }

    const action =
      account.isActive
        ? "deactivate"
        : "activate";

    const confirmed =
      window.confirm(
        `Are you sure you want to ${action} "${account.accountName}"?`
      );

    if (!confirmed) {
      return;
    }

    setActionLoading(account.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/accounts/${account.id}`,
        {
          method: "PATCH",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            isActive:
              !account.isActive,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            `Unable to ${action} account`
        );
        return;
      }

      setMessage(
        `Account ${action}d successfully.`
      );

      await loadAccounts();
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function deleteAccount(
    account: Account
  ) {
    if (account.isSystem) {
      setError(
        "System accounts cannot be deleted."
      );
      return;
    }

    const confirmed =
      window.confirm(
        `Permanently delete "${account.accountName}"?\n\nOnly unused accounts should be deleted.`
      );

    if (!confirmed) {
      return;
    }

    setActionLoading(account.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/accounts/${account.id}`,
        {
          method: "DELETE",
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            "Unable to delete account"
        );
        return;
      }

      setMessage(
        "Account deleted successfully."
      );

      await loadAccounts();
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setActionLoading(null);
    }
  }

  const filteredAccounts =
    useMemo(() => {
      const searchText =
        search.toLowerCase().trim();

      return accounts.filter(
        (account) => {
          const matchesSearch =
            !searchText ||
            account.accountName
              .toLowerCase()
              .includes(searchText) ||
            (
              account.accountCode ||
              ""
            )
              .toLowerCase()
              .includes(searchText) ||
            formatCategory(
              account.category
            )
              .toLowerCase()
              .includes(searchText) ||
            (
              account.party
                ?.partyName || ""
            )
              .toLowerCase()
              .includes(searchText);

          const matchesType =
            typeFilter === "ALL" ||
            account.accountType ===
              typeFilter;

          const matchesStatus =
            statusFilter === "ALL" ||
            (statusFilter ===
              "ACTIVE" &&
              account.isActive) ||
            (statusFilter ===
              "INACTIVE" &&
              !account.isActive);

          return (
            matchesSearch &&
            matchesType &&
            matchesStatus
          );
        }
      );
    }, [
      accounts,
      search,
      typeFilter,
      statusFilter,
    ]);

  const parentAccounts =
    accounts.filter(
      (account) =>
        account.accountType ===
          accountType &&
        account.id !==
          editingAccount?.id &&
        account.isActive
    );

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">

        {/* HEADER */}

        <div className="mb-6">
          <h1 className="text-2xl font-bold">
            Chart of Accounts
          </h1>

          <p className="text-gray-600">
            Manage your complete accounting
            structure.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* FORM */}

          <section className="bg-white rounded-xl shadow-sm p-6">

            <h2 className="text-xl font-semibold mb-5">
              {editingAccount
                ? "Edit Account"
                : "Create Account"}
            </h2>

            <form
              onSubmit={handleSubmit}
              className="space-y-4"
            >

              <input
                type="text"
                placeholder="Account Name"
                value={accountName}
                onChange={(e) =>
                  setAccountName(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              <input
                type="text"
                placeholder="Account Code (optional)"
                value={accountCode}
                onChange={(e) =>
                  setAccountCode(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              {/* ACCOUNT TYPE */}

              <select
                value={accountType}
                onChange={(e) =>
                  handleAccountTypeChange(
                    e.target.value as AccountType
                  )
                }
                className="w-full border rounded-lg px-4 py-3 bg-white"
              >
                {accountTypes.map(
                  (type) => (
                    <option
                      key={type.value}
                      value={type.value}
                    >
                      {type.label}
                    </option>
                  )
                )}
              </select>

              {/* CATEGORY */}

              <select
                value={category}
                onChange={(e) =>
                  setCategory(
                    e.target.value as AccountCategory
                  )
                }
                className="w-full border rounded-lg px-4 py-3 bg-white"
              >
                {categoriesByType[
                  accountType
                ].map((item) => (
                  <option
                    key={item.value}
                    value={item.value}
                  >
                    {item.label}
                  </option>
                ))}
              </select>

              {/* PARENT */}

              <select
                value={parentId}
                onChange={(e) =>
                  setParentId(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3 bg-white"
              >
                <option value="">
                  No Parent Account
                </option>

                {parentAccounts.map(
                  (account) => (
                    <option
                      key={account.id}
                      value={account.id}
                    >
                      {account.accountCode
                        ? `${account.accountCode} - `
                        : ""}
                      {account.accountName}
                    </option>
                  )
                )}
              </select>

              {/* PARTY */}

              <select
                value={partyId}
                onChange={(e) =>
                  setPartyId(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3 bg-white"
              >
                <option value="">
                  No Party Link
                </option>

                {parties.map(
                  (party) => (
                    <option
                      key={party.id}
                      value={party.id}
                    >
                      {party.partyName}
                    </option>
                  )
                )}
              </select>

              <textarea
                placeholder="Description"
                value={description}
                onChange={(e) =>
                  setDescription(
                    e.target.value
                  )
                }
                rows={3}
                className="w-full border rounded-lg px-4 py-3"
              />

              {/* ERROR */}

              {error && (
                <p className="text-sm text-red-600">
                  {error}
                </p>
              )}

              {/* MESSAGE */}

              {message && (
                <p className="text-sm text-green-600">
                  {message}
                </p>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full bg-black text-white py-3 rounded-lg disabled:opacity-50"
              >
                {saving
                  ? "Saving..."
                  : editingAccount
                    ? "Update Account"
                    : "Create Account"}
              </button>

              {editingAccount && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="w-full border py-3 rounded-lg hover:bg-gray-50"
                >
                  Cancel Edit
                </button>
              )}

            </form>
          </section>

          {/* LIST */}

          <section className="lg:col-span-2 bg-white rounded-xl shadow-sm p-6">

            <div className="flex flex-col gap-4 mb-5">

              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">

                <div>
                  <h2 className="text-xl font-semibold">
                    Accounts
                  </h2>

                  <p className="text-sm text-gray-500">
                    {filteredAccounts.length}{" "}
                    accounts
                  </p>
                </div>

                <button
                  onClick={loadAccounts}
                  className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
                >
                  Refresh
                </button>

              </div>

              {/* SEARCH */}

              <input
                type="text"
                placeholder="Search account, code, category or party..."
                value={search}
                onChange={(e) =>
                  setSearch(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              {/* FILTERS */}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

                <select
                  value={typeFilter}
                  onChange={(e) =>
                    setTypeFilter(
                      e.target.value as
                        | AccountType
                        | "ALL"
                    )
                  }
                  className="border rounded-lg px-4 py-3 bg-white"
                >
                  <option value="ALL">
                    All Account Types
                  </option>

                  {accountTypes.map(
                    (type) => (
                      <option
                        key={type.value}
                        value={type.value}
                      >
                        {type.label}
                      </option>
                    )
                  )}
                </select>

                <select
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(
                      e.target.value as
                        | "ALL"
                        | "ACTIVE"
                        | "INACTIVE"
                    )
                  }
                  className="border rounded-lg px-4 py-3 bg-white"
                >
                  <option value="ALL">
                    All Status
                  </option>

                  <option value="ACTIVE">
                    Active
                  </option>

                  <option value="INACTIVE">
                    Inactive
                  </option>
                </select>

              </div>
            </div>

            {/* TABLE */}

            {loading ? (

              <p className="text-gray-500">
                Loading accounts...
              </p>

            ) : filteredAccounts.length ===
              0 ? (

              <p className="text-gray-500">
                No accounts found.
              </p>

            ) : (

              <div className="overflow-x-auto">

                <table className="w-full text-sm">

                  <thead>
                    <tr className="border-b text-left">

                      <th className="py-3 pr-4">
                        Account
                      </th>

                      <th className="py-3 pr-4">
                        Type
                      </th>

                      <th className="py-3 pr-4">
                        Category
                      </th>

                      <th className="py-3 pr-4">
                        Parent
                      </th>

                      <th className="py-3 pr-4">
                        Party
                      </th>

                      <th className="py-3 pr-4">
                        Status
                      </th>

                      <th className="py-3 pr-4">
                        Actions
                      </th>

                    </tr>
                  </thead>

                  <tbody>

                    {filteredAccounts.map(
                      (account) => (

                        <tr
                          key={account.id}
                          className="border-b"
                        >

                          <td className="py-3 pr-4">

                            <div className="font-medium">
                              {account.accountName}
                            </div>

                            {account.accountCode && (
                              <div className="text-xs text-gray-500">
                                Code:{" "}
                                {account.accountCode}
                              </div>
                            )}

                            {account.isSystem && (
                              <div className="text-xs text-blue-600 mt-1">
                                System Account
                              </div>
                            )}

                          </td>

                          <td className="py-3 pr-4">
                            {
                              accountTypes.find(
                                (item) =>
                                  item.value ===
                                  account.accountType
                              )?.label
                            }
                          </td>

                          <td className="py-3 pr-4">
                            {formatCategory(
                              account.category
                            )}
                          </td>

                          <td className="py-3 pr-4">
                            {account.parent
                              ? account.parent
                                  .accountName
                              : "-"}
                          </td>

                          <td className="py-3 pr-4">
                            {account.party
                              ? account.party
                                  .partyName
                              : "-"}
                          </td>

                          <td className="py-3 pr-4">

                            <span
                              className={
                                account.isActive
                                  ? "text-green-600"
                                  : "text-red-600"
                              }
                            >
                              {account.isActive
                                ? "Active"
                                : "Inactive"}
                            </span>

                          </td>

                          <td className="py-3 pr-4">

                            <div className="flex flex-wrap gap-2">

                              <button
                                type="button"
                                onClick={() =>
                                  startEditing(
                                    account
                                  )
                                }
                                disabled={
                                  account.isSystem
                                }
                                className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
                              >
                                Edit
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  toggleActive(
                                    account
                                  )
                                }
                                disabled={
                                  account.isSystem ||
                                  actionLoading ===
                                    account.id
                                }
                                className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
                              >
                                {account.isActive
                                  ? "Deactivate"
                                  : "Activate"}
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  deleteAccount(
                                    account
                                  )
                                }
                                disabled={
                                  account.isSystem ||
                                  actionLoading ===
                                    account.id
                                }
                                className="border border-red-300 text-red-600 rounded-lg px-3 py-1 text-sm hover:bg-red-50 disabled:opacity-40"
                              >
                                Delete
                              </button>

                            </div>

                          </td>

                        </tr>

                      )
                    )}

                  </tbody>

                </table>

              </div>

            )}

          </section>
        </div>
      </div>
    </main>
  );
}