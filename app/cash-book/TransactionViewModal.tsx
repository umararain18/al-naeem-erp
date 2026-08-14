"use client";

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

function formatDate(value: string) {
  const [year, month, day] = value.split("-");

  if (!year || !month || !day) {
    return value;
  }

  return `${day}-${month}-${year}`;
}

export default function TransactionViewModal({
  entry,
  onClose,
}: TransactionViewModalProps) {
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
                {formatDate(entry.date)}
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
        <div className="flex justify-end border-t px-6 py-4">

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
          >
            Close
          </button>

        </div>

      </div>
    </div>
  );
}