"use client";

import { useEffect, useMemo, useState } from "react";import TransactionViewModal from "./TransactionViewModal"; import TransactionEditModal from "./TransactionEditModal";

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  isActive: boolean;
};

type CashBookEntry = {
  id: string;
  date: string;
  document: string;
  documentNo: string;
  account: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  journalEntryId: string;
  referenceType: string | null;
  referenceId: string | null;
};

type CashBookDay = {
  date: string;
  entries: CashBookEntry[];
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
};

type CashBookResponse = {
  success: boolean;
  message?: string;
  accounts: Account[];
  selectedAccount: Account | null;
  summary?: {
    openingBalance: number;
    totalDebit: number;
    totalCredit: number;
    closingBalance: number;
  };
  days: CashBookDay[];
};

function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-");

  if (!year || !month || !day) {
    return date;
  }

  return `${day}-${month}-${year}`;
}

export default function CashBookPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [selectedAccountId, setSelectedAccountId] =
    useState("");

  const [selectedAccountName, setSelectedAccountName] =
    useState("");

  const [accountSearch, setAccountSearch] =
    useState("");

  const [fromDate, setFromDate] =
    useState("");

  const [toDate, setToDate] =
    useState("");

  const [openDates, setOpenDates] =
    useState<string[]>([]);

  const [days, setDays] =
    useState<CashBookDay[]>([]);

  const [summary, setSummary] = useState({
    openingBalance: 0,
    totalDebit: 0,
    totalCredit: 0,
    closingBalance: 0,
  });

  const [selectedEntry, setSelectedEntry] =
  useState<CashBookEntry | null>(null);

  const [editEntry, setEditEntry] =
  useState<CashBookEntry | null>(null);

  const [loadingAccounts, setLoadingAccounts] =
    useState(false);

  const [loadingTransactions, setLoadingTransactions] =
    useState(false);

  const [error, setError] =
    useState("");

  /*
   * Load all active CASH/BANK accounts.
   *
   * Any future Cash or Bank account created
   * in the database will automatically appear here.
   */
  async function loadAccounts() {
    try {
      setLoadingAccounts(true);
      setError("");

      const response = await fetch(
        "/api/cash-book",
        {
          method: "GET",
          cache: "no-store",
        }
      );

      const data: CashBookResponse =
        await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.message ||
            "Unable to load accounts"
        );
      }

      setAccounts(data.accounts || []);
    } catch (err) {
      console.error(err);

      setError(
        err instanceof Error
          ? err.message
          : "Unable to load accounts"
      );
    } finally {
      setLoadingAccounts(false);
    }
  }

  /*
   * Load actual Cash Book transactions
   * for selected Cash/Bank account.
   */
  async function loadCashBook(
    accountId: string,
    from = fromDate,
    to = toDate
  ) {
    if (!accountId) {
      setDays([]);

      setSummary({
        openingBalance: 0,
        totalDebit: 0,
        totalCredit: 0,
        closingBalance: 0,
      });

      return;
    }

    try {
      setLoadingTransactions(true);
      setError("");

      const params = new URLSearchParams();

      params.set("accountId", accountId);

      if (from) {
        params.set("from", from);
      }

      if (to) {
        params.set("to", to);
      }

      const response = await fetch(
        `/api/cash-book?${params.toString()}`,
        {
          method: "GET",
          cache: "no-store",
        }
      );

      const data: CashBookResponse =
        await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.message ||
            "Unable to load Cash Book"
        );
      }

      setDays(data.days || []);

      setSummary(
        data.summary || {
          openingBalance: 0,
          totalDebit: 0,
          totalCredit: 0,
          closingBalance: 0,
        }
      );

      setOpenDates([]);
    } catch (err) {
      console.error(err);

      setError(
        err instanceof Error
          ? err.message
          : "Unable to load Cash Book"
      );

      setDays([]);

      setSummary({
        openingBalance: 0,
        totalDebit: 0,
        totalCredit: 0,
        closingBalance: 0,
      });
    } finally {
      setLoadingTransactions(false);
    }
  }

  useEffect(() => {
  const timer = window.setTimeout(() => {
    void loadAccounts();
  }, 0);

  return () => {
    window.clearTimeout(timer);
  };
}, []);

  /*
   * Account search.
   */
  const filteredAccounts = useMemo(() => {
    const search =
      accountSearch.trim().toLowerCase();

    if (!search) {
      return accounts;
    }

    return accounts.filter((account) =>
      account.accountName
        .toLowerCase()
        .includes(search)
    );
  }, [accounts, accountSearch]);

  /*
   * Select account.
   */
  function handleAccountSelect(account: Account) {
    setSelectedAccountId(account.id);
    setSelectedAccountName(account.accountName);
    setAccountSearch("");

    loadCashBook(
      account.id,
      fromDate,
      toDate
    );
  }

  /*
   * Search button.
   */
  function handleSearch() {
    if (!selectedAccountId) {
      setError(
        "Please select a Cash or Bank account first."
      );

      return;
    }

    loadCashBook(
      selectedAccountId,
      fromDate,
      toDate
    );
  }

  /*
   * Reset filters.
   */
  function handleReset() {
    setFromDate("");
    setToDate("");
    setError("");

    if (selectedAccountId) {
      loadCashBook(
        selectedAccountId,
        "",
        ""
      );
    }
  }

  /*
   * Expand / collapse date.
   */
  function toggleDate(date: string) {
    setOpenDates((current) =>
      current.includes(date)
        ? current.filter(
            (item) => item !== date
          )
        : [...current, date]
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">

        {/* HEADER */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Cash Book
          </h1>

          <p className="mt-1 text-sm text-gray-500">
            View date-wise transactions for each
            cash and bank account.
          </p>
        </div>

        {/* ERROR */}
        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* FILTERS */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">

          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">

            {/* MAIN ACCOUNT */}
            <div className="relative md:col-span-2">

              <label className="mb-2 block text-sm font-medium text-gray-700">
                Main Account
              </label>

              <input
                type="text"
                value={
                  selectedAccountName ||
                  accountSearch
                }
                onChange={(event) => {
                  setAccountSearch(
                    event.target.value
                  );

                  setSelectedAccountId("");
                  setSelectedAccountName("");
                }}
                placeholder={
                  loadingAccounts
                    ? "Loading accounts..."
                    : "Search account..."
                }
                disabled={loadingAccounts}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
              />

              {accountSearch &&
                !selectedAccountId && (
                  <div className="absolute left-0 top-full z-20 mt-1 w-full overflow-hidden rounded-lg border bg-white shadow-lg">

                    {filteredAccounts.length > 0 ? (
                      filteredAccounts.map(
                        (account) => (
                          <button
                            key={account.id}
                            type="button"
                            onClick={() =>
                              handleAccountSelect(
                                account
                              )
                            }
                            className="block w-full px-4 py-3 text-left text-sm hover:bg-gray-50"
                          >
                            <div className="font-medium text-gray-900">
                              {account.accountName}
                            </div>

                            <div className="text-xs text-gray-500">
                              {account.category}
                              {account.accountCode
                                ? ` • ${account.accountCode}`
                                : ""}
                            </div>
                          </button>
                        )
                      )
                    ) : (
                      <div className="px-4 py-3 text-sm text-gray-500">
                        No Cash/Bank account found
                      </div>
                    )}

                  </div>
                )}
            </div>

            {/* FROM DATE */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Date From
              </label>

              <input
                type="date"
                value={fromDate}
                onChange={(event) =>
                  setFromDate(
                    event.target.value
                  )
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
              />
            </div>

            {/* TO DATE */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Date To
              </label>

              <input
                type="date"
                value={toDate}
                onChange={(event) =>
                  setToDate(
                    event.target.value
                  )
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
              />
            </div>

          </div>

          <div className="mt-5 flex justify-end gap-3">

            <button
              type="button"
              onClick={handleReset}
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Reset
            </button>

            <button
              type="button"
              onClick={handleSearch}
              disabled={
                loadingTransactions ||
                !selectedAccountId
              }
              className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingTransactions
                ? "Loading..."
                : "Search"}
            </button>

          </div>
        </div>

        {/* SUMMARY */}
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-4">

          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">
              Opening Balance
            </p>

            <p className="mt-2 text-xl font-bold text-gray-900">
              Rs.{" "}
              {formatMoney(
                summary.openingBalance
              )}
            </p>
          </div>

          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">
              Total Debit
            </p>

            <p className="mt-2 text-xl font-bold text-gray-900">
              Rs.{" "}
              {formatMoney(
                summary.totalDebit
              )}
            </p>
          </div>

          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">
              Total Credit
            </p>

            <p className="mt-2 text-xl font-bold text-gray-900">
              Rs.{" "}
              {formatMoney(
                summary.totalCredit
              )}
            </p>
          </div>

          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">
              Closing Balance
            </p>

            <p className="mt-2 text-xl font-bold text-gray-900">
              Rs.{" "}
              {formatMoney(
                summary.closingBalance
              )}
            </p>
          </div>

        </div>

        {/* DAILY TRANSACTIONS */}
        <div className="mt-6 overflow-hidden rounded-xl border bg-white shadow-sm">

          <div className="border-b px-6 py-4">

            <h2 className="font-semibold text-gray-900">
              Daily Transactions
            </h2>

            <p className="mt-1 text-xs text-gray-500">
              Select a date to view all transactions
              for that day.
            </p>

          </div>

          {loadingTransactions ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">
              Loading Cash Book...
            </div>
          ) : !selectedAccountId ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">
              Select a Cash or Bank account to view
              transactions.
            </div>
          ) : days.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">
              No transactions found for the selected
              account and date range.
            </div>
          ) : (
            <div className="divide-y">

              {days.map((day) => {

                const isOpen =
                  openDates.includes(
                    day.date
                  );

                return (
                  <div key={day.date}>

                    {/* DATE SUMMARY */}
                    <button
                      type="button"
                      onClick={() =>
                        toggleDate(day.date)
                      }
                      className="w-full px-6 py-5 text-left hover:bg-gray-50"
                    >

                      <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-5">

                        <div className="font-semibold text-gray-900">
                          📅{" "}
                          {formatDate(
                            day.date
                          )}
                        </div>

                        <div className="text-sm text-gray-500">
                          {day.entries.length}{" "}
                          Transactions
                        </div>

                        <div>
                          <p className="text-xs text-gray-500">
                            Debit
                          </p>

                          <p className="font-semibold text-gray-900">
                            Rs.{" "}
                            {formatMoney(
                              day.totalDebit
                            )}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs text-gray-500">
                            Credit
                          </p>

                          <p className="font-semibold text-gray-900">
                            Rs.{" "}
                            {formatMoney(
                              day.totalCredit
                            )}
                          </p>
                        </div>

                        <div className="flex items-center justify-between">

                          <div>
                            <p className="text-xs text-gray-500">
                              Balance
                            </p>

                            <p className="font-semibold text-gray-900">
                              Rs.{" "}
                              {formatMoney(
                                day.closingBalance
                              )}
                            </p>
                          </div>

                          <span className="ml-4 text-sm font-medium text-blue-600">
                            {isOpen
                              ? "CLOSE ▲"
                              : "OPEN ▼"}
                          </span>

                        </div>

                      </div>

                    </button>

                    {/* EXPANDED DATE */}
                    {isOpen && (
                      <div className="border-t bg-gray-50 px-6 py-6">

                        <div className="mb-5 flex items-center justify-between">

                          <div>

                            <h3 className="font-semibold text-gray-900">
                              📅{" "}
                              {formatDate(
                                day.date
                              )}
                            </h3>

                            <p className="mt-1 text-sm text-gray-500">
                              Opening Balance:
                              {" "}
                              Rs.{" "}
                              {formatMoney(
                                day.openingBalance
                              )}
                            </p>

                          </div>

                        </div>

                        {/* TRANSACTIONS TABLE */}
                        <div className="overflow-x-auto rounded-lg border bg-white">

                          <table className="min-w-[1100px] w-full">

                            <thead className="bg-gray-50">

                              <tr className="text-left text-xs font-semibold uppercase text-gray-500">

                                <th className="px-4 py-3">
                                  Document
                                </th>

                                <th className="px-4 py-3">
                                  Doc No.
                                </th>

                                <th className="px-4 py-3">
                                  Account
                                </th>

                                <th className="px-4 py-3">
                                  Description
                                </th>

                                <th className="px-4 py-3 text-right">
                                  Debit
                                </th>

                                <th className="px-4 py-3 text-right">
                                  Credit
                                </th>

                                <th className="px-4 py-3 text-right">
                                  Balance
                                </th>

                                <th className="px-4 py-3">
                                  Action
                                </th>

                              </tr>

                            </thead>

                            <tbody className="divide-y">

                              {day.entries.map(
                                (entry) => (

                                  <tr
                                    key={
                                      entry.id
                                    }
                                    className="hover:bg-gray-50"
                                  >

                                    <td className="px-4 py-4 text-sm font-medium text-gray-900">
                                      {entry.document}
                                    </td>

                                    <td className="px-4 py-4 text-sm text-gray-600">
                                      {entry.documentNo ||
                                        "—"}
                                    </td>

                                    <td className="px-4 py-4 text-sm text-gray-600">
                                      {entry.account}
                                    </td>

                                    <td className="px-4 py-4 text-sm text-gray-600">
                                      {entry.description ||
                                        "—"}
                                    </td>

                                    <td className="px-4 py-4 text-right text-sm">
                                      {entry.debit >
                                      0
                                        ? `Rs. ${formatMoney(
                                            entry.debit
                                          )}`
                                        : "—"}
                                    </td>

                                    <td className="px-4 py-4 text-right text-sm">
                                      {entry.credit >
                                      0
                                        ? `Rs. ${formatMoney(
                                            entry.credit
                                          )}`
                                        : "—"}
                                    </td>

                                    <td className="px-4 py-4 text-right text-sm font-semibold">
                                      Rs.{" "}
                                      {formatMoney(
                                        entry.balance
                                      )}
                                    </td>

                                    <td className="px-4 py-4">

                                      <div className="flex gap-2">

                                        <button
  type="button"
  onClick={() => {
    console.log("VIEW CLICKED", entry);
    setSelectedEntry(entry);
  }}
  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
>
  View
</button>

                                        <button
  type="button"
  onClick={() => {
    console.log("EDIT CLICKED", entry);
    setEditEntry(entry);
  }}
  className="rounded-md border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
>
  Edit
</button>

                                        <button
                                          type="button"
                                          className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
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

                        {/* DAY TOTAL */}
                        <div className="mt-5 rounded-lg border bg-white p-5">

                          <div className="flex justify-end">

                            <div className="w-full max-w-sm space-y-3 text-sm">

                              <div className="flex justify-between">

                                <span className="font-medium text-gray-600">
                                  Debit
                                </span>

                                <span className="font-semibold text-gray-900">
                                  Rs.{" "}
                                  {formatMoney(
                                    day.totalDebit
                                  )}
                                </span>

                              </div>

                              <div className="flex justify-between">

                                <span className="font-medium text-gray-600">
                                  Credit
                                </span>

                                <span className="font-semibold text-gray-900">
                                  Rs.{" "}
                                  {formatMoney(
                                    day.totalCredit
                                  )}
                                </span>

                              </div>

                              <div className="flex justify-between border-t pt-3">

                                <span className="font-semibold text-gray-700">
                                  Closing Balance
                                </span>

                                <span className="font-bold text-gray-900">
                                  Rs.{" "}
                                  {formatMoney(
                                    day.closingBalance
                                  )}
                                </span>

                              </div>

                            </div>

                          </div>

                        </div>

                      </div>
                    )}

                  </div>
                );
              })}

            </div>
          )}

        </div>

      </div>
            <TransactionViewModal
        entry={selectedEntry}
        onClose={() => setSelectedEntry(null)}
      />
      <TransactionEditModal
  entry={editEntry}
  onClose={() => setEditEntry(null)}
  onSaved={() => {
    setEditEntry(null);

    if (selectedAccountId) {
      void loadCashBook(
        selectedAccountId,
        fromDate,
        toDate
      );
    }
  }}
/>
    </div>
    
   );
}