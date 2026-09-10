"use client";

import { useEffect, useState } from "react";
import { DocumentSearchSelect, type DocumentSearchResult } from "../daily-posting/DocumentSearchSelect";
import { SearchableSelect, sourceOptions } from "../daily-posting/SearchableSelect";

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
  // Only present for a Daily Posting transaction (see
  // app/daily-posting/register/page.tsx) - the authoritative Bilty/
  // Challan id behind `document`/`documentNo`, used ONLY to render the
  // already-linked document as a recognized, read-only selection below.
  // Absent for plain Cash Book rows, which are unaffected by this field.
  sourceId?: string | null;
};

type TransactionEditModalProps = {
  entry: TransactionEntry | null;
  onClose: () => void;
  onSaved?: () => void;
};

export default function TransactionEditModal({
  entry,
  onClose,
  onSaved,
}: TransactionEditModalProps) {
  const [date, setDate] = useState("");
  const [document, setDocument] = useState("");
  const [documentNo, setDocumentNo] = useState("");
  // Only meaningful for a BILTY/CHALLAN Daily Posting line - the real
  // Bilty/Challan id backing document/documentNo. Cleared whenever the
  // user picks a different Document Type or a different document, and
  // re-set by DocumentSearchSelect's onSelect below.
  const [sourceId, setSourceId] = useState("");
  const [description, setDescription] = useState("");
  const [debit, setDebit] = useState("0");
  const [credit, setCredit] = useState("0");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  /*
   * Set values whenever a different transaction is selected
   */
  useEffect(() => {
    if (!entry) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
setDate(entry.date || "");
    setDocument(entry.document || "");
    setDocumentNo(entry.documentNo || "");
    setSourceId(entry.sourceId || "");
    setDescription(entry.description || "");
    setDebit(String(entry.debit ?? 0));
    setCredit(String(entry.credit ?? 0));

    setError("");
    setMessage("");
  }, [entry]);

  /*
   * Save transaction
   */
  async function handleSave() {
    console.log("SAVE BUTTON CLICKED");
    if (!entry) {
      return;
    }

    setError("");
    setMessage("");

    if (!date) {
      setError("Date is required.");
      return;
    }

    const debitAmount = Number(debit) || 0;
    const creditAmount = Number(credit) || 0;

    if (debitAmount < 0 || creditAmount < 0) {
      setError(
        "Debit and Credit cannot be negative."
      );
      return;
    }

    if (
      (debitAmount > 0 && creditAmount > 0) ||
      (debitAmount === 0 && creditAmount === 0)
    ) {
      setError(
        "Enter either Debit or Credit, not both."
      );
      return;
    }

    try {
      setSaving(true);

      const response = await fetch(
        `/api/cash-book/${entry.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            date,
            document,
            documentNo,
            sourceId,
            description,
            debit: debitAmount,
            credit: creditAmount,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.message ||
            "Unable to update transaction"
        );
      }

      setMessage(
        data.message ||
          "Transaction updated successfully."
      );

      /*
       * Refresh Cash Book
       */
      if (onSaved) {
        onSaved();
      }

      /*
       * Close after successful save
       */
      window.setTimeout(() => {
        onClose();
      }, 500);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update transaction"
      );
    } finally {
      setSaving(false);
    }
  }

  if (!entry) {
    return null;
  }

  // Only a Daily Posting transaction (app/daily-posting/register/page.tsx)
  // reaches this modal with a document-aware source (BILTY/CHALLAN linked
  // to a real record) or a DIRECT/PARTY/PHONCH/BILL entry. Every other
  // Cash Book row (referenceType e.g. SETTLEMENT, or none) keeps today's
  // exact free-text Document/Document No. fields below, fully unchanged.
  // For a Daily Posting row, Document/Document No. are now fully
  // editable using the SAME components and validation as the Daily
  // Posting Create form (see lib/daily-posting-validation.ts and
  // PATCH /api/cash-book/[id]/route.ts's isDailyPosting branch, which
  // re-resolves and re-validates the Counter Account exactly like a
  // brand-new posting whenever the document actually changes).
  const isDailyPosting = entry.referenceType === "DAILY_POSTING";
  const isSearchableDocument = isDailyPosting && (document === "BILTY" || document === "CHALLAN");
  const isDirectDocument = isDailyPosting && document === "DIRECT";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl rounded-xl bg-white shadow-xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Edit Transaction
            </h2>

            <p className="mt-1 text-xs text-gray-500">
              Transaction #
              {entry.documentNo || entry.id}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-3 py-1 text-xl text-gray-500 hover:bg-gray-100"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-6">

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Success */}
          {message && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {message}
            </div>
          )}

          {/* Date */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Date
            </label>

            <input
              type="date"
              value={date}
              onChange={(e) =>
                setDate(e.target.value)
              }
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Cash / Bank Account
            </label>
            <p className="rounded-lg border bg-gray-50 px-3 py-2 text-sm text-gray-700">
              {entry.account}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Account reassignment is not supported when editing a posted transaction.
            </p>
          </div>

          {/* Document */}
          <div className="grid grid-cols-2 gap-4">

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Document
              </label>

              {isDailyPosting ? (
                <SearchableSelect
                  value={document}
                  options={sourceOptions}
                  placeholder="Search document..."
                  onChange={(value) => {
                    setDocument(value);
                    // A different Document Type has no relationship to
                    // whatever was previously selected - clear the
                    // number/id so the user must pick again, exactly
                    // like Create's own Document Type change handler.
                    setDocumentNo("");
                    setSourceId("");
                  }}
                />
              ) : (
                <input
                  type="text"
                  value={document}
                  onChange={(e) =>
                    setDocument(e.target.value)
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Document No.
              </label>

              {isSearchableDocument ? (
                <DocumentSearchSelect
                  sourceType={document}
                  sourceId={sourceId}
                  sourceNumber={documentNo}
                  onSelect={(result: DocumentSearchResult) => {
                    setDocument(result.type);
                    setDocumentNo(result.number);
                    setSourceId(result.id);
                  }}
                  onClear={() => {
                    setDocumentNo("");
                    setSourceId("");
                  }}
                />
              ) : isDirectDocument ? (
                <input
                  type="text"
                  value=""
                  disabled
                  placeholder="Not required"
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:bg-gray-100"
                />
              ) : (
                <input
                  type="text"
                  value={documentNo}
                  onChange={(e) =>
                    setDocumentNo(e.target.value)
                  }
                  placeholder={isDailyPosting ? "e.g. 4252" : undefined}
                  className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
              )}
            </div>

          </div>

          {isDailyPosting && (
            <p className="-mt-3 text-xs text-gray-500">
              Changing the document re-validates this transaction using the same rules as a new Daily Posting entry (e.g. the Paid-amount verification ceiling).
            </p>
          )}

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Description
            </label>

            <textarea
              value={description}
              onChange={(e) =>
                setDescription(e.target.value)
              }
              rows={3}
              className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>

          {/* Debit / Credit */}
          <div className="grid grid-cols-2 gap-4">

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Debit
              </label>

              <input
                type="number"
                min="0"
                value={debit}
                onChange={(e) => {
                  setDebit(e.target.value);

                  if (Number(e.target.value) > 0) {
                    setCredit("0");
                  }
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Credit
              </label>

              <input
                type="number"
                min="0"
                value={credit}
                onChange={(e) => {
                  setCredit(e.target.value);

                  if (Number(e.target.value) > 0) {
                    setDebit("0");
                  }
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </div>

          </div>

          {/* Balance */}
          <div className="rounded-lg border bg-gray-50 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">
                Current Balance
              </span>

              <span className="text-sm font-semibold text-gray-900">
                Rs.{" "}
                {new Intl.NumberFormat("en-PK").format(
                  entry.balance
                )}
              </span>
            </div>
          </div>

          {/* Warning */}
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-800">
            Saving this transaction will update its
            accounting journal and Cash Book balance.
          </div>

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t px-6 py-4">

          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border px-5 py-2.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>

        </div>

      </div>
    </div>
  );
}
