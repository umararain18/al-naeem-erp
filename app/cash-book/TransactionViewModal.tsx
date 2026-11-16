"use client";

import { useEffect, useState } from "react";
import { formatBusinessDate } from "@/lib/date-range";
import AllocationPanel from "@/app/parties/[id]/ledger/AllocationPanel";

type TransactionEntry = {
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

type TransactionViewModalProps = {
  entry: TransactionEntry | null;
  onClose: () => void;
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export default function TransactionViewModal({
  entry,
  onClose,
}: TransactionViewModalProps) {
  const [partyLine, setPartyLine] = useState<{ partyId: string; journalLineId: string } | null>(null);
  const [showAllocation, setShowAllocation] = useState(false);

  // This row IS the Cash/Bank account's own leg of the JournalEntry -
  // the PARTY-category line (the actual Allocation anchor) lives on a
  // sibling line of the SAME entry, never in `entry` itself. One fetch
  // of the full entry, same route the Journal Entry detail page already
  // uses, to find it.
  useEffect(() => {
    setPartyLine(null);
    if (!entry) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/accounting-transactions/${entry.journalEntryId}`);
        const data = await response.json();
        if (cancelled || !response.ok || !data.success) return;
        const partyLineRaw = data.entry.lines.find(
          (l: { account: { category: string; party?: { id: string } | null } }) => l.account.category === "PARTY" && l.account.party
        );
        if (partyLineRaw) {
          setPartyLine({ partyId: partyLineRaw.account.party.id, journalLineId: partyLineRaw.id });
        }
      } catch {
        // No Allocation button if this fails - never blocks viewing the transaction.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry]);

  if (!entry) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Transaction Details
            </h2>

            <p className="mt-1 text-xs text-gray-500">
              Journal Entry Details
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-xl text-gray-500 hover:bg-gray-100"
          >
            ×
          </button>
        </div>

        {/* Details */}
        <div className="space-y-4 px-6 py-6">

          <div className="grid grid-cols-2 gap-4">

            <div>
              <p className="text-xs text-gray-500">
                Date
              </p>

              <p className="mt-1 text-sm font-medium text-gray-900">
                {formatBusinessDate(entry.date)}
              </p>
            </div>

            <div>
              <p className="text-xs text-gray-500">
                Document
              </p>

              <p className="mt-1 text-sm font-medium text-gray-900">
                {entry.document}
              </p>
            </div>

          </div>

          <div>
            <p className="text-xs text-gray-500">
              Document No.
            </p>

            <p className="mt-1 text-sm font-medium text-gray-900">
              {entry.documentNo || "—"}
            </p>
          </div>

          <div>
            <p className="text-xs text-gray-500">
              Account
            </p>

            <p className="mt-1 text-sm font-medium text-gray-900">
              {entry.account}
            </p>
          </div>

          <div>
            <p className="text-xs text-gray-500">
              Description
            </p>

            <p className="mt-1 text-sm font-medium text-gray-900">
              {entry.description || "—"}
            </p>
          </div>

          {/* Amounts */}
          <div className="grid grid-cols-3 gap-4 border-t pt-4">

            <div>
              <p className="text-xs text-gray-500">
                Debit
              </p>

              <p className="mt-1 text-sm font-semibold text-gray-900">
                {entry.debit > 0
                  ? `Rs. ${formatMoney(entry.debit)}`
                  : "—"}
              </p>
            </div>

            <div>
              <p className="text-xs text-gray-500">
                Credit
              </p>

              <p className="mt-1 text-sm font-semibold text-gray-900">
                {entry.credit > 0
                  ? `Rs. ${formatMoney(entry.credit)}`
                  : "—"}
              </p>
            </div>

            <div>
              <p className="text-xs text-gray-500">
                Balance
              </p>

              <p className="mt-1 text-sm font-semibold text-gray-900">
                Rs. {formatMoney(entry.balance)}
              </p>
            </div>

          </div>

          {/* Reference */}
          <div className="border-t pt-4">

            <p className="text-xs text-gray-500">
              Reference Type
            </p>

            <p className="mt-1 text-sm text-gray-700">
              {entry.referenceType || "—"}
            </p>

          </div>

          <div>
            <p className="text-xs text-gray-500">
              Journal Entry ID
            </p>

            <p className="mt-1 break-all text-xs text-gray-600">
              {entry.journalEntryId}
            </p>
          </div>

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t px-6 py-4">

          {partyLine && (
            <button
              type="button"
              onClick={() => setShowAllocation(true)}
              className="rounded-lg border border-blue-200 px-5 py-2.5 text-sm font-medium text-blue-600 hover:bg-blue-50"
            >
              Allocation
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[oklch(21%_0.034_264.665)] px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
          >
            Close
          </button>

        </div>

      </div>

      {showAllocation && partyLine && (
        <AllocationPanel
          partyId={partyLine.partyId}
          journalLineId={partyLine.journalLineId}
          lang="en"
          onClose={() => setShowAllocation(false)}
          onChanged={() => setShowAllocation(false)}
        />
      )}
    </div>
  );
}