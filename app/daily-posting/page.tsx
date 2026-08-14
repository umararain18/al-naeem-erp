"use client";

import { useEffect, useMemo, useState } from "react";

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  party?: {
    id: string;
    partyName: string;
  } | null;
};

type PostingLine = {
  id: string;
  counterAccountId: string;
  description: string;
  amount: string;
  direction: "DEBIT" | "CREDIT";
  sourceType: string;
  sourceId: string;
  sourceNumber: string;
};

type SearchOption = {
  value: string;
  label: string;
  secondary?: string;
};

function SearchableSelect({
  value,
  options,
  placeholder,
  disabled = false,
  onChange,
  className = "w-full",
}: {
  value: string;
  options: SearchOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    setQuery(selected?.label || "");
  }, [value, selected?.label]);

  const filteredOptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return options;

    return options.filter((option) =>
      `${option.label} ${option.secondary || ""}`
        .toLowerCase()
        .includes(search)
    );
  }, [options, query]);

  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => {
          if (!disabled) {
            setOpen(true);
            setQuery("");
          }
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          if (value) onChange("");
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 150);
        }}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
      />

      {open && !disabled && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(option.value);
                  setQuery(option.label);
                  setOpen(false);
                }}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-blue-50"
              >
                <div className="font-medium text-gray-900">{option.label}</div>
                {option.secondary && (
                  <div className="mt-0.5 text-xs text-gray-500">{option.secondary}</div>
                )}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-gray-500">No account found</div>
          )}
        </div>
      )}
    </div>
  );
}

const sourceOptions = [
  { value: "DIRECT", label: "Direct Account" },
  { value: "PARTY", label: "Party" },
  { value: "CHALLAN", label: "CN - Challan" },
  { value: "PHONCH", label: "PN - Phonch" },
  { value: "BILTY", label: "BL - Bilty" },
  { value: "BILL", label: "BI - Bill" },
];

function createLine(): PostingLine {
  return {
    id: crypto.randomUUID(),
    counterAccountId: "",
    description: "",
    amount: "",
    direction: "DEBIT",
    sourceType: "DIRECT",
    sourceId: "",
    sourceNumber: "",
  };
}

export default function DailyPostingPage() {
  const today = new Date().toISOString().split("T")[0];

  const [postingDate, setPostingDate] = useState(today);
  const [accountId, setAccountId] = useState("");
  const [remarks, setRemarks] = useState("");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lines, setLines] = useState<PostingLine[]>([createLine()]);

  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [posting, setPosting] = useState(false);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [duplicateData, setDuplicateData] = useState<any[]>([]);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      setLoadingAccounts(true);
      setError("");

      const response = await fetch("/api/accounts");

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to load accounts");
      }

      setAccounts(data.accounts || []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load accounts"
      );
    } finally {
      setLoadingAccounts(false);
    }
  }

  function updateLine(
    id: string,
    field: keyof PostingLine,
    value: string
  ) {
    setLines((current) =>
      current.map((line) =>
        line.id === id
          ? {
              ...line,
              [field]: value,
            }
          : line
      )
    );
  }

  function addLine() {
    setLines((current) => [...current, createLine()]);
  }

  function removeLine(id: string) {
    if (lines.length === 1) {
      return;
    }

    setLines((current) =>
      current.filter((line) => line.id !== id)
    );
  }

  const selectedMainAccount = useMemo(
    () =>
      accounts.find(
        (account) => account.id === accountId
      ),
    [accounts, accountId]
  );

  const counterAccounts = useMemo(
    () =>
      accounts.filter(
        (account) => account.id !== accountId
      ),
    [accounts, accountId]
  );

  const mainAccountOptions = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: account.accountName,
        secondary: account.accountCode
          ? `${account.accountCode} • ${account.accountType}`
          : account.accountType,
      })),
    [accounts]
  );

  const counterAccountOptions = useMemo(
    () =>
      counterAccounts.map((account) => ({
        value: account.id,
        label: account.party
          ? `${account.party.partyName} — ${account.accountName}`
          : account.accountName,
        secondary: account.accountCode
          ? `${account.accountCode} • ${account.accountType}`
          : account.accountType,
      })),
    [counterAccounts]
  );

  const totalDebit = useMemo(
    () =>
      lines.reduce((total, line) => {
        if (line.direction !== "DEBIT") return total;

        return total + (Number(line.amount) || 0);
      }, 0),
    [lines]
  );

  const totalCredit = useMemo(
    () =>
      lines.reduce((total, line) => {
        if (line.direction !== "CREDIT") return total;

        return total + (Number(line.amount) || 0);
      }, 0),
    [lines]
  );

  async function postDailyPosting(
    confirmDuplicate = false
  ) {
    setError("");
    setMessage("");

    if (!postingDate) {
      setError("Posting date is required.");
      return;
    }

    if (!accountId) {
      setError("Please select the main account.");
      return;
    }

    for (const [index, line] of lines.entries()) {
      if (!line.counterAccountId) {
        setError(
          `Please select counter account in entry ${
            index + 1
          }.`
        );
        return;
      }

      if (!line.description.trim()) {
        setError(
          `Please enter description in entry ${
            index + 1
          }.`
        );
        return;
      }

      if (!line.amount || Number(line.amount) <= 0) {
        setError(
          `Please enter a valid amount in entry ${
            index + 1
          }.`
        );
        return;
      }

      if (
        line.sourceType !== "DIRECT" &&
        !line.sourceNumber.trim()
      ) {
        setError(
          `Please enter document number in entry ${
            index + 1
          }.`
        );
        return;
      }
    }

    try {
      setPosting(true);

      const payload = {
        postingDate,
        accountId,
        remarks: remarks.trim() || undefined,
        confirmDuplicate,
        lines: lines.map((line) => ({
          counterAccountId: line.counterAccountId,
          description: line.description.trim(),
          amount: Number(line.amount),
          direction: line.direction,
          sourceType: line.sourceType,
          sourceId:
            line.sourceId.trim() || undefined,
          sourceNumber:
            line.sourceNumber.trim() || undefined,
        })),
      };

      const response = await fetch(
        "/api/daily-posting",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await response.json();

      if (response.status === 409 && data.warning) {
        setDuplicateData(data.duplicates || []);
        setShowDuplicateWarning(true);
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(
          data.message ||
            "Unable to post daily transaction."
        );
      }

      setMessage(
        data.message ||
          "Daily posting posted successfully."
      );

      setShowDuplicateWarning(false);
      setDuplicateData([]);

      setLines([createLine()]);
      setRemarks("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while posting."
      );
    } finally {
      setPosting(false);
    }
  }

  function formatMoney(value: number) {
    return new Intl.NumberFormat("en-PK", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        {/* HEADER */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Daily Posting
          </h1>

          <p className="mt-1 text-sm text-gray-500">
            Post daily income, expenses, receipts and
            payments from one screen.
          </p>
        </div>

        {/* SUCCESS */}
        {message && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {message}
          </div>
        )}

        {/* ERROR */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* MAIN ACCOUNT */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Posting Date
              </label>

              <input
                type="date"
                value={postingDate}
                onChange={(e) =>
                  setPostingDate(e.target.value)
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Main Account
              </label>

              <SearchableSelect
                value={accountId}
                options={mainAccountOptions}
                placeholder={
                  loadingAccounts
                    ? "Loading accounts..."
                    : "Search main account..."
                }
                disabled={loadingAccounts}
                onChange={setAccountId}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Remarks
              </label>

              <input
                type="text"
                value={remarks}
                onChange={(e) =>
                  setRemarks(e.target.value)
                }
                placeholder="Optional daily remarks"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {selectedMainAccount && (
            <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <strong>
                Main Account:
              </strong>{" "}
              {selectedMainAccount.accountName}
            </div>
          )}
        </div>

        {/* ENTRIES */}
        <div className="mt-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <h2 className="font-semibold text-gray-900">
                Daily Entries
              </h2>

              <p className="text-xs text-gray-500">
                Multiple transactions can be posted under
                the same main account.
              </p>
            </div>

            <button
              type="button"
              onClick={addLine}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              + Add Entry
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1250px] w-full">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold uppercase text-gray-500">
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Counter Account</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Document No.</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>

              <tbody className="divide-y">
                {lines.map((line, index) => (
                  <tr key={line.id}>
                    <td className="px-4 py-4 text-sm text-gray-500">
                      {index + 1}
                    </td>

                    <td className="px-4 py-4">
                      <SearchableSelect
                        value={line.counterAccountId}
                        options={counterAccountOptions}
                        placeholder="Search account..."
                        onChange={(value) =>
                          updateLine(
                            line.id,
                            "counterAccountId",
                            value
                          )
                        }
                        className="w-72"
                      />
                    </td>

                    <td className="px-4 py-4">
                      <SearchableSelect
                        value={line.sourceType}
                        options={sourceOptions}
                        placeholder="Search document..."
                        onChange={(value) => {
                          updateLine(line.id, "sourceType", value);

                          if (value === "DIRECT") {
                            updateLine(line.id, "sourceId", "");
                            updateLine(line.id, "sourceNumber", "");
                          }
                        }}
                        className="w-48"
                      />
                    </td>

                    <td className="px-4 py-4">
                      <input
                        type="text"
                        value={line.sourceNumber}
                        onChange={(e) =>
                          updateLine(
                            line.id,
                            "sourceNumber",
                            e.target.value
                          )
                        }
                        placeholder={
                          line.sourceType === "DIRECT"
                            ? "Not required"
                            : "e.g. 4252"
                        }
                        disabled={line.sourceType === "DIRECT"}
                        className="w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none disabled:bg-gray-100 focus:border-blue-500"
                      />
                    </td>

                    <td className="px-4 py-4">
                      <input
                        type="text"
                        value={line.description}
                        onChange={(e) =>
                          updateLine(
                            line.id,
                            "description",
                            e.target.value
                          )
                        }
                        placeholder="Fuel, rent, receipt..."
                        className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                      />
                    </td>

                    <td className="px-4 py-4">
                      <select
                        value={line.direction}
                        onChange={(e) =>
                          updateLine(
                            line.id,
                            "direction",
                            e.target.value
                          )
                        }
                        className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                      >
                        <option value="DEBIT">Debit</option>
                        <option value="CREDIT">Credit</option>
                      </select>
                    </td>

                    <td className="px-4 py-4">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.amount}
                        onChange={(e) =>
                          updateLine(
                            line.id,
                            "amount",
                            e.target.value
                          )
                        }
                        placeholder="0.00"
                        className="w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                      />
                    </td>

                    <td className="px-4 py-4">
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length === 1}
                        className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* TOTALS */}
          <div className="border-t bg-gray-50 px-6 py-5">
            <div className="ml-auto grid max-w-md grid-cols-2 gap-3 text-sm">
              <div className="font-medium text-gray-600">
                Total Debit
              </div>

              <div className="text-right font-semibold text-gray-900">
                Rs. {formatMoney(totalDebit)}
              </div>

              <div className="font-medium text-gray-600">
                Total Credit
              </div>

              <div className="text-right font-semibold text-gray-900">
                Rs. {formatMoney(totalCredit)}
              </div>
            </div>
          </div>

          {/* POST BUTTON */}
          <div className="flex justify-end border-t px-6 py-5">
            <button
              type="button"
              disabled={
                posting ||
                !accountId ||
                lines.length === 0
              }
              onClick={() =>
                postDailyPosting(false)
              }
              className="rounded-lg bg-green-600 px-8 py-3 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {posting
                ? "Posting..."
                : "POST DAILY ENTRIES"}
            </button>
          </div>
        </div>
      </div>

      {/* DUPLICATE WARNING MODAL */}
      {showDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
            <div className="border-b px-6 py-5">
              <h2 className="text-lg font-bold text-gray-900">
                Document Already Posted
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                One or more selected documents have
                already been posted.
              </p>
            </div>

            <div className="max-h-72 overflow-y-auto px-6 py-4">
              {duplicateData.map(
                (duplicate, index) => (
                  <div
                    key={`${duplicate.sourceId}-${index}`}
                    className="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 p-4"
                  >
                    <div className="text-sm font-semibold text-gray-900">
                      {duplicate.sourceType}{" "}
                      {duplicate.sourceNumber ||
                        duplicate.sourceId}
                    </div>

                    <div className="mt-1 text-xs text-gray-600">
                      Existing amount: Rs.{" "}
                      {duplicate.amount}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="flex justify-end gap-3 border-t px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  setShowDuplicateWarning(false);
                  setDuplicateData([]);
                }}
                disabled={posting}
                className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() =>
                  postDailyPosting(true)
                }
                disabled={posting}
                className="rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {posting
                  ? "Posting..."
                  : "Post Anyway"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}