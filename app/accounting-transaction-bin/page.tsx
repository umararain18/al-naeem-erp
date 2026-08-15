"use client";

import { useEffect, useMemo, useState } from "react";

type JournalLine = {
  id: string;
  description: string | null;
  sourceType: string | null;
  sourceNumber: string | null;
  debit: string | number;
  credit: string | number;
  account: {
    id: string;
    accountName: string;
    accountCode: string | null;
    party: { id: string; partyName: string } | null;
  };
};

type BinnedTransaction = {
  id: string;
  entryDate: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  deletedAt: string | null;
  deletedBy: { id: string; fullName: string; username: string } | null;
  lines: JournalLine[];
  amount: number;
  totalDebit: number;
  totalCredit: number;
  accounts: JournalLine["account"][];
  parties: { id: string; partyName: string }[];
  journalLineCount: number;
};

type Capabilities = {
  canRestore: boolean;
  canPermanentlyDelete: boolean;
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).format(new Date(value));
}

export default function AccountingTransactionBinPage() {
  const [transactions, setTransactions] = useState<BinnedTransaction[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    canRestore: false,
    canPermanentlyDelete: false,
  });
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<BinnedTransaction | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BinnedTransaction | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [from, search, to]);

  async function loadBin() {
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`/api/accounting-transactions/bin?${query}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Unable to load the Accounting Transaction Bin");
      }
      setTransactions(data.transactions || []);
      setCapabilities(data.capabilities || {
        canRestore: false,
        canPermanentlyDelete: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the Accounting Transaction Bin");
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBin();
    }, 0);

    return () => window.clearTimeout(timer);
    // Search runs when the user explicitly selects Search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function restoreTransaction(transaction: BinnedTransaction) {
    if (!window.confirm("Restore this complete Journal Entry and all of its journal lines?")) return;
    try {
      setActionId(transaction.id);
      setError("");
      const response = await fetch(
        `/api/accounting-transactions/${transaction.id}/restore`,
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Unable to restore transaction");
      setMessage(data.message);
      setSelected(null);
      await loadBin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore transaction");
    } finally {
      setActionId(null);
    }
  }

  async function permanentlyDeleteTransaction() {
    if (!deleteTarget) return;
    try {
      setActionId(deleteTarget.id);
      setError("");
      const response = await fetch(`/api/accounting-transactions/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Unable to permanently delete transaction");
      setMessage(data.message);
      setDeleteTarget(null);
      setConfirmation("");
      await loadBin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to permanently delete transaction");
    } finally {
      setActionId(null);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Bin — Accounting Transactions</h1>
          <p className="mt-1 text-sm text-gray-500">
            This category currently contains binned Journal Entries. They are excluded from normal accounting until restored.
          </p>
        </div>

        {(error || message) && (
          <div className={`mb-5 rounded-lg border px-4 py-3 text-sm ${error ? "border-red-200 bg-red-50 text-red-700" : "border-green-200 bg-green-50 text-green-700"}`}>
            {error || message}
          </div>
        )}

        <div className="grid gap-4 rounded-xl border bg-white p-5 shadow-sm md:grid-cols-4">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search document, account, party..." className="rounded-lg border px-3 py-2 text-sm md:col-span-2" />
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="rounded-lg border px-3 py-2 text-sm" />
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="rounded-lg border px-3 py-2 text-sm" />
          <div className="md:col-span-4 flex justify-end gap-3">
            <button type="button" onClick={() => { setSearch(""); setFrom(""); setTo(""); }} className="rounded-lg border px-4 py-2 text-sm">Reset</button>
            <button type="button" onClick={() => void loadBin()} disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Search</button>
          </div>
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          {loading ? <div className="p-10 text-center text-sm text-gray-500">Loading Bin...</div> : transactions.length === 0 ? <div className="p-10 text-center text-sm text-gray-500">No binned transactions found.</div> : (
            <table className="min-w-[1150px] w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-4 py-3">Original date</th><th className="px-4 py-3">Description / reference</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Accounts / parties</th><th className="px-4 py-3">Deleted</th><th className="px-4 py-3">Actions</th></tr></thead>
              <tbody className="divide-y">
                {transactions.map((transaction) => <tr key={transaction.id} className="align-top hover:bg-gray-50"><td className="px-4 py-4">{formatDate(transaction.entryDate)}</td><td className="px-4 py-4"><div className="font-medium">{transaction.description || "—"}</div><div className="mt-1 text-xs text-gray-500">{transaction.referenceType || "DIRECT"}{transaction.referenceId ? ` · ${transaction.referenceId}` : ""}</div><div className="mt-1 text-xs text-gray-500">{transaction.journalLineCount} journal lines</div></td><td className="px-4 py-4">Rs. {formatMoney(transaction.amount)}</td><td className="px-4 py-4"><div>{transaction.accounts.map((account) => account.accountName).join(", ")}</div>{transaction.parties.length > 0 && <div className="mt-1 text-xs text-gray-500">{transaction.parties.map((party) => party.partyName).join(", ")}</div>}</td><td className="px-4 py-4"><div>{formatDate(transaction.deletedAt)}</div><div className="mt-1 text-xs text-gray-500">{transaction.deletedBy ? `${transaction.deletedBy.fullName} (${transaction.deletedBy.username})` : "Unknown user"}</div></td><td className="px-4 py-4"><div className="flex gap-2"><button type="button" onClick={() => setSelected(transaction)} className="rounded border px-3 py-1.5 text-xs">View</button>{capabilities.canRestore && <button type="button" disabled={actionId === transaction.id} onClick={() => void restoreTransaction(transaction)} className="rounded border border-green-200 px-3 py-1.5 text-xs text-green-700 disabled:opacity-50">Restore</button>}{capabilities.canPermanentlyDelete && <button type="button" onClick={() => { setDeleteTarget(transaction); setConfirmation(""); }} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700">Permanent Delete</button>}</div></td></tr>)}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-xl"><div className="flex items-center justify-between border-b px-6 py-4"><div><h2 className="font-semibold">Binned Journal Entry</h2><p className="text-xs text-gray-500">{selected.id}</p></div><button type="button" onClick={() => setSelected(null)} className="text-xl">×</button></div><div className="space-y-4 p-6"><div className="grid grid-cols-2 gap-4 text-sm"><div><span className="text-gray-500">Original date</span><p>{formatDate(selected.entryDate)}</p></div><div><span className="text-gray-500">Deleted date</span><p>{formatDate(selected.deletedAt)}</p></div><div><span className="text-gray-500">Deleted by</span><p>{selected.deletedBy ? `${selected.deletedBy.fullName} (${selected.deletedBy.username})` : "Unknown user"}</p></div><div><span className="text-gray-500">Reference</span><p>{selected.referenceType || "DIRECT"}{selected.referenceId ? ` · ${selected.referenceId}` : ""}</p></div></div><p className="text-sm"><span className="text-gray-500">Description: </span>{selected.description || "—"}</p><table className="w-full border text-sm"><thead className="bg-gray-50"><tr><th className="p-2 text-left">Account</th><th className="p-2 text-left">Document</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th></tr></thead><tbody>{selected.lines.map((line) => <tr key={line.id} className="border-t"><td className="p-2">{line.account.accountName}{line.account.party && <div className="text-xs text-gray-500">{line.account.party.partyName}</div>}</td><td className="p-2">{line.sourceType || "DIRECT"}{line.sourceNumber ? ` · ${line.sourceNumber}` : ""}<div className="text-xs text-gray-500">{line.description || "—"}</div></td><td className="p-2 text-right">{Number(line.debit) > 0 ? `Rs. ${formatMoney(Number(line.debit))}` : "—"}</td><td className="p-2 text-right">{Number(line.credit) > 0 ? `Rs. ${formatMoney(Number(line.credit))}` : "—"}</td></tr>)}</tbody></table></div><div className="flex justify-end border-t p-4"><button type="button" onClick={() => setSelected(null)} className="rounded bg-gray-900 px-4 py-2 text-sm text-white">Close</button></div></div></div>}

      {deleteTarget && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div className="w-full max-w-md rounded-xl bg-white shadow-xl"><div className="border-b px-6 py-4"><h2 className="font-semibold text-red-700">Permanently delete Journal Entry</h2><p className="mt-1 text-sm text-gray-500">This permanently deletes all {deleteTarget.journalLineCount} journal lines and cannot be undone.</p></div><div className="space-y-4 p-6"><label className="block text-sm">Type <strong>DELETE</strong> to confirm.<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 w-full rounded border px-3 py-2" /></label></div><div className="flex justify-end gap-3 border-t p-4"><button type="button" onClick={() => setDeleteTarget(null)} className="rounded border px-4 py-2 text-sm">Cancel</button><button type="button" disabled={confirmation !== "DELETE" || actionId === deleteTarget.id} onClick={() => void permanentlyDeleteTransaction()} className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50">Permanently Delete</button></div></div></div>}
    </main>
  );
}
