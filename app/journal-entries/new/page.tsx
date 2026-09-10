"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SearchableSelect } from "../../daily-posting/SearchableSelect";

// ============================================================
// MANUAL JOURNAL ENTRY - CREATE
//
// Each line is fully independent: Account + Description + Debit XOR
// Credit. No document linking (v1, approved decision #12), no
// counter-account auto-resolution (that concept belongs to Daily
// Posting's document-driven flow, not here) - the user builds the
// whole balanced entry line by line, exactly like Manager.io's own
// Journal Entry form (UI inspiration only, per the approved
// diagnostic - the underlying accounting write is ANC's own,
// unmodified JournalEntry/JournalLine model via
// POST /api/journal-entries).
// ============================================================

type Account = {
  id: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  category: string;
  isActive: boolean;
  party?: { id: string; partyName: string } | null;
};

type Line = {
  id: string;
  accountId: string;
  description: string;
  debit: string;
  credit: string;
};

function createLine(): Line {
  return { id: crypto.randomUUID(), accountId: "", description: "", debit: "", credit: "" };
}

function todayYMD(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export default function NewJournalEntryPage() {
  const router = useRouter();

  const [date, setDate] = useState(todayYMD());
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<Line[]>([createLine(), createLine()]);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // One token per distinct save attempt - reused only on a retry of
  // the SAME attempt, regenerated once it actually succeeds. Same
  // idempotency convention Daily Posting already uses.
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    async function load() {
      try {
        setLoadingAccounts(true);
        const response = await fetch("/api/accounts");
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.message || "Unable to load accounts");
        }
        // Server independently re-verifies every account at submit
        // time regardless of this filter - this is purely so the
        // picker never even offers a deleted/inactive account.
        setAccounts((data.accounts || []).filter((a: Account) => a.isActive));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load accounts");
      } finally {
        setLoadingAccounts(false);
      }
    }
    load();
  }, []);

  const accountOptions = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: account.party ? `${account.party.partyName} — ${account.accountName}` : account.accountName,
        secondary: account.accountCode ? `${account.accountCode} • ${account.category}` : account.category,
      })),
    [accounts]
  );

  function updateLine(id: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((current) => [...current, createLine()]);
  }

  function removeLine(id: string) {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((line) => line.id !== id));
  }

  const totalDebit = useMemo(() => lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0), [lines]);
  const totalCredit = useMemo(() => lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0), [lines]);
  const difference = Math.round((totalDebit - totalCredit) * 100) / 100;
  const isBalanced = Math.abs(difference) < 0.01 && totalDebit > 0;

  async function handleSave() {
    setError("");

    if (!date) {
      setError("Date is required.");
      return;
    }
    if (!narration.trim()) {
      setError("Narration is required.");
      return;
    }
    if (lines.length < 2) {
      setError("At least 2 lines are required.");
      return;
    }
    for (const [index, line] of lines.entries()) {
      if (!line.accountId) {
        setError(`Line ${index + 1}: please select an account.`);
        return;
      }
      if (!line.description.trim()) {
        setError(`Line ${index + 1}: description is required.`);
        return;
      }
      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;
      if (debit > 0 && credit > 0) {
        setError(`Line ${index + 1}: enter either Debit or Credit, not both.`);
        return;
      }
      if (debit <= 0 && credit <= 0) {
        setError(`Line ${index + 1}: enter either Debit or Credit.`);
        return;
      }
    }
    if (!isBalanced) {
      setError(`Total Debit (${formatMoney(totalDebit)}) must equal Total Credit (${formatMoney(totalCredit)}).`);
      return;
    }

    try {
      setSaving(true);

      const response = await fetch("/api/journal-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          narration: narration.trim(),
          idempotencyKey: submissionKey,
          lines: lines.map((line) => ({
            accountId: line.accountId,
            description: line.description.trim(),
            debit: Number(line.debit) || 0,
            credit: Number(line.credit) || 0,
          })),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to save journal entry.");
      }

      setSubmissionKey(crypto.randomUUID());
      router.push("/journal-entries");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save journal entry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">New Journal Entry</h1>
            <p className="mt-1 text-sm text-gray-500">Manually post a balanced accounting journal entry.</p>
          </div>
          <Link href="/journal-entries" className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50">
            Back to Journal Entries
          </Link>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">Narration</label>
              <input
                type="text"
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="What is this journal entry for?"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <h2 className="font-semibold text-gray-900">Lines</h2>
            <button
              type="button"
              onClick={addLine}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              + Add Line
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[950px] w-full">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold uppercase text-gray-500">
                  <th className="px-4 py-3">No.</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3 text-right">Debit</th>
                  <th className="px-4 py-3 text-right">Credit</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lines.map((line, index) => (
                  <tr key={line.id}>
                    <td className="px-4 py-4 text-sm text-gray-500">{index + 1}</td>
                    <td className="px-4 py-4">
                      <SearchableSelect
                        value={line.accountId}
                        options={accountOptions}
                        placeholder={loadingAccounts ? "Loading accounts..." : "Search account..."}
                        disabled={loadingAccounts}
                        onChange={(value) => updateLine(line.id, { accountId: value })}
                        className="w-64"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <input
                        type="text"
                        value={line.description}
                        onChange={(e) => updateLine(line.id, { description: e.target.value })}
                        placeholder="Line description"
                        className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.debit}
                        onChange={(e) => updateLine(line.id, { debit: e.target.value, credit: Number(e.target.value) > 0 ? "" : line.credit })}
                        placeholder="0.00"
                        className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm text-right outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.credit}
                        onChange={(e) => updateLine(line.id, { credit: e.target.value, debit: Number(e.target.value) > 0 ? "" : line.debit })}
                        placeholder="0.00"
                        className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm text-right outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length <= 2}
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

          <div className="border-t bg-gray-50 px-6 py-5">
            <div className="ml-auto grid max-w-md grid-cols-2 gap-3 text-sm">
              <div className="font-medium text-gray-600">Total Debit</div>
              <div className="text-right font-semibold text-gray-900">Rs. {formatMoney(totalDebit)}</div>
              <div className="font-medium text-gray-600">Total Credit</div>
              <div className="text-right font-semibold text-gray-900">Rs. {formatMoney(totalCredit)}</div>
              <div className="font-medium text-gray-600">Difference</div>
              <div className={`text-right font-semibold ${Math.abs(difference) < 0.01 ? "text-gray-900" : "text-red-600"}`}>
                Rs. {formatMoney(Math.abs(difference))}
              </div>
              <div className="col-span-2 mt-2 border-t pt-2 text-right">
                <span
                  className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${
                    isBalanced ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}
                >
                  {isBalanced ? "Balanced" : "Not Balanced"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex justify-end border-t px-6 py-5">
            <button
              type="button"
              disabled={saving || !isBalanced}
              onClick={handleSave}
              className="rounded-lg bg-green-600 px-8 py-3 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Journal Entry"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
