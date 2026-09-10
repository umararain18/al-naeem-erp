"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DocumentSearchSelect } from "./DocumentSearchSelect";
import { SearchableSelect, sourceOptions } from "./SearchableSelect";

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
  // Client-side only - not sent to the server. Tracks the party
  // auto-resolved from the selected document ("" = none), purely
  // so the UI can show "Resolved Party: X" / explain why Counter
  // Account is empty. The server independently re-resolves at
  // submit time regardless of this value.
  resolvedPartyLabel: string;
};

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
    resolvedPartyLabel: "",
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

  // One token per distinct posting attempt - reused across a retry
  // of the SAME attempt (e.g. confirming the duplicate-document
  // warning), regenerated only once that attempt actually succeeds,
  // so an accidental resubmission (double-click, network retry,
  // duplicate tab) of an already-posted entry safely no-ops on the
  // server instead of posting twice. See app/api/daily-posting/route.ts.
  const [submissionKey, setSubmissionKey] = useState(() =>
    crypto.randomUUID()
  );

  useEffect(() => {
    loadAccounts();
  }, []);

  // Arriving from the Daily Posting register's "+ Add Entry" button
  // (?date=YYYY-MM-DD) starts the form on that same date instead of
  // today - a pure convenience default, never required. Read
  // directly from the URL (not next/navigation's useSearchParams),
  // matching the same one-time-on-mount pattern already used by
  // app/cash-book/page.tsx, to avoid that hook's Suspense-boundary
  // requirement.
  useEffect(() => {
    const urlDate = new URLSearchParams(window.location.search).get("date");
    if (urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) {
      setPostingDate(urlDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // A Challan/Bilty-linked entry may leave Counter Account
      // empty - the server resolves the responsible party from the
      // document itself. Every other entry still requires it.
      if (
        line.sourceType !== "CHALLAN" &&
        line.sourceType !== "BILTY" &&
        !line.counterAccountId
      ) {
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
        idempotencyKey: submissionKey,
        lines: lines.map((line) => ({
          counterAccountId: line.counterAccountId || undefined,
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
      // This attempt is done - the next Post is a new, separate
      // posting and must get its own idempotency key.
      setSubmissionKey(crypto.randomUUID());
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
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Daily Posting
            </h1>

            <p className="mt-1 text-sm text-gray-500">
              Post daily income, expenses, receipts and
              payments from one screen.
            </p>
          </div>

          <Link href="/daily-posting/register" className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 whitespace-nowrap">
            View Daily Register
          </Link>
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
                        placeholder={
                          line.sourceType === "CHALLAN" || line.sourceType === "BILTY"
                            ? "Optional - auto-resolved from document"
                            : "Search account..."
                        }
                        onChange={(value) => {
                          updateLine(line.id, "counterAccountId", value);
                          // A manual change supersedes the earlier
                          // auto-resolution label.
                          updateLine(line.id, "resolvedPartyLabel", "");
                        }}
                        className="w-72"
                      />
                      {(line.sourceType === "CHALLAN" || line.sourceType === "BILTY") &&
                        line.sourceId &&
                        line.resolvedPartyLabel && (
                          <p className="mt-1 text-xs text-green-600">
                            Resolved Party: {line.resolvedPartyLabel}
                          </p>
                        )}
                      {(line.sourceType === "CHALLAN" || line.sourceType === "BILTY") &&
                        line.sourceId &&
                        !line.resolvedPartyLabel &&
                        !line.counterAccountId && (
                          <p className="mt-1 text-xs text-amber-600">
                            No party could be auto-resolved - please select a
                            Counter Account.
                          </p>
                        )}
                    </td>

                    <td className="px-4 py-4">
                      <SearchableSelect
                        value={line.sourceType}
                        options={sourceOptions}
                        placeholder="Search document..."
                        onChange={(value) => {
                          updateLine(line.id, "sourceType", value);
                          updateLine(line.id, "sourceId", "");
                          updateLine(line.id, "sourceNumber", "");
                        }}
                        className="w-48"
                      />
                    </td>

                    <td className="px-4 py-4">
                      {line.sourceType === "CHALLAN" ||
                      line.sourceType === "BILTY" ? (
                        <DocumentSearchSelect
                          sourceType={line.sourceType}
                          sourceId={line.sourceId}
                          sourceNumber={line.sourceNumber}
                          onSelect={(result) => {
                            updateLine(line.id, "sourceType", result.type);
                            updateLine(line.id, "sourceId", result.id);
                            updateLine(line.id, "sourceNumber", result.number);
                            // Auto-resolve the responsible party from the
                            // document so the user does not have to search
                            // for the same party again. Still fully
                            // editable/clearable afterward.
                            updateLine(
                              line.id,
                              "counterAccountId",
                              result.resolvedParty?.accountId || ""
                            );
                            updateLine(
                              line.id,
                              "resolvedPartyLabel",
                              result.resolvedParty?.partyName || ""
                            );
                          }}
                          onClear={() => {
                            updateLine(line.id, "sourceId", "");
                            updateLine(line.id, "sourceNumber", "");
                            updateLine(line.id, "resolvedPartyLabel", "");
                          }}
                        />
                      ) : (
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
                      )}
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