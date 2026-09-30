import { formatCurrency } from "./format";

export interface ManagementSummaryData {
  rangeLabel: string;
  revenue: number | null;
  expense: number | null;
  profit: number | null;
  collections: number | null;
  outstandingReceivable: number | null;
  outstandingPayable: number | null;
  bookings: number | null;
  dispatches: number | null;
  bills: number | null;
}

function Item({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-base font-semibold text-gray-900">{value}</p>
    </div>
  );
}

// Purely a data recap - never a speculative/judgmental statement (no
// "business is doing great" style text), per the Phase 2 spec.
export default function ManagementSummary({ data }: { data: ManagementSummaryData }) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Business Overview</h2>
        <p className="text-xs text-gray-400 mt-0.5">{data.rangeLabel}</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
        <Item label="Revenue" value={data.revenue === null ? null : formatCurrency(data.revenue)} />
        <Item label="Expenses" value={data.expense === null ? null : formatCurrency(data.expense)} />
        <Item label="Profit" value={data.profit === null ? null : formatCurrency(data.profit)} />
        <Item label="Collections" value={data.collections === null ? null : formatCurrency(data.collections)} />
        <Item
          label="Outstanding Receivable"
          value={data.outstandingReceivable === null ? null : formatCurrency(data.outstandingReceivable)}
        />
        <Item
          label="Outstanding Payable"
          value={data.outstandingPayable === null ? null : formatCurrency(data.outstandingPayable)}
        />
        <Item label="Bookings" value={data.bookings === null ? null : data.bookings.toLocaleString()} />
        <Item label="Dispatches" value={data.dispatches === null ? null : data.dispatches.toLocaleString()} />
        <Item label="Bills" value={data.bills === null ? null : data.bills.toLocaleString()} />
      </div>
    </div>
  );
}
