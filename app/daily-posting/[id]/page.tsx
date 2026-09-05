"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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

type JournalLine = {
  id: string;
  account: Account;
  debit: number;
  credit: number;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
};

type JournalEntry = {
  id: string;
  entryDate: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdBy: {
    id: string;
    fullName: string;
    username: string;
  } | null;
  createdAt: string;
  lines: JournalLine[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
};

export default function DailyPostingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");
        const { id } = await params;
        const response = await fetch(`/api/daily-posting/${id}`);
        const data = await response.json();
        if (!response.ok || !data.success) {
          setError(data.message || "Unable to load daily posting");
          return;
        }
        setEntry(data.entry);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [params]);

  function formatCurrency(value: number) {
    return `Rs. ${value.toLocaleString()}`;
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleString();
  }

  function formatDateOnly(dateString: string) {
    return new Date(dateString).toLocaleDateString();
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-gray-500">Loading daily posting...</p>
        </div>
      </main>
    );
  }

  if (error || !entry) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-6xl mx-auto p-6">
          <p className="text-red-600">{error || "Daily posting not found"}</p>
          <Link href="/daily-posting" className="mt-4 inline-block border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
            Back to Daily Posting
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6">
          <div className="text-xs text-gray-500 mb-1">Al Naeem Car Carriers Service</div>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">Daily Posting</h1>
              <p className="text-gray-600">{entry.id}</p>
            </div>
            <Link href="/daily-posting" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
              Back to Daily Posting
            </Link>
          </div>
        </div>

        {/* Entry Details */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Entry Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Posting Date</p>
              <p className="font-medium">{formatDateOnly(entry.entryDate)}</p>
            </div>
            <div>
              <p className="text-gray-500">Reference Type</p>
              <p className="font-medium">{entry.referenceType || "—"}</p>
            </div>
            <div>
              <p className="text-gray-500">Reference ID</p>
              <p className="font-medium">{entry.referenceId || "—"}</p>
            </div>
            <div>
              <p className="text-gray-500">Description</p>
              <p className="font-medium">{entry.description || "—"}</p>
            </div>
            <div>
              <p className="text-gray-500">Created By</p>
              <p className="font-medium">{entry.createdBy?.fullName || entry.createdBy?.username || "—"}</p>
            </div>
            <div>
              <p className="text-gray-500">Created At</p>
              <p className="font-medium">{formatDate(entry.createdAt)}</p>
            </div>
          </div>
        </div>

        {/* Journal Lines */}
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Journal Lines</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Debit</th>
                  <th className="px-4 py-3 text-right">Credit</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entry.lines.map((line) => (
                  <tr key={line.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium">{line.account.accountName}</p>
                      <p className="text-xs text-gray-500">
                        {line.account.category}
                        {line.account.party ? ` • ${line.account.party.partyName}` : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {line.debit > 0 ? formatCurrency(line.debit) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {line.credit > 0 ? formatCurrency(line.credit) : "—"}
                    </td>
                    <td className="px-4 py-3">{line.description || "—"}</td>
                    <td className="px-4 py-3">
                      {line.sourceType ? (
                        <span className="text-xs">
                          {line.sourceType}: {line.sourceNumber || line.sourceId || "—"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Totals</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-gray-500">Total Debit</p>
              <p className="font-medium text-lg">{formatCurrency(entry.totalDebit)}</p>
            </div>
            <div>
              <p className="text-gray-500">Total Credit</p>
              <p className="font-medium text-lg">{formatCurrency(entry.totalCredit)}</p>
            </div>
            <div>
              <p className="text-gray-500">Status</p>
              <p className={`font-medium ${entry.isBalanced ? "text-green-600" : "text-red-600"}`}>
                {entry.isBalanced ? "Balanced" : "Not Balanced"}
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
