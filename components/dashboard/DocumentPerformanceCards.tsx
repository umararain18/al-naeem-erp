import Link from "next/link";
import { formatCurrency } from "./format";

export interface BiltySummary {
  count: number;
  totalBookingAmount: number;
  paidAmount: number;
  toPayAmount: number;
}

export interface ChallanSummary {
  count: number;
  totalCarrierRent: number;
  totalReceivable: number;
  totalPayable: number;
  statusCounts: { OPEN: number; PARTIALLY_CLEARED: number; CLEARED: number; OVERPAID: number };
}

export interface BillSummary {
  count: number;
  totalAmount: number;
  collected: number;
  outstanding: number;
  paidCount: number;
  partiallyPaidCount: number;
  unpaidCount: number;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-[11px] text-gray-400">{label}</p>
      <p className="text-sm font-semibold text-gray-900">{value}</p>
    </div>
  );
}

export default function DocumentPerformanceCards({
  bilty,
  challan,
  bill,
}: {
  bilty: BiltySummary | null;
  challan: ChallanSummary | null;
  bill: BillSummary | null;
}) {
  if (!bilty && !challan && !bill) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {bilty && (
        <Link href="/bilty" className="bg-white rounded-xl shadow-sm p-5 hover:shadow-md transition-shadow block">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Bilty Summary</h3>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Total Bilties" value={bilty.count} />
            <Stat label="Booking Amount" value={formatCurrency(bilty.totalBookingAmount)} />
            <Stat label="Paid (recorded)" value={formatCurrency(bilty.paidAmount)} />
            <Stat label="To Pay" value={formatCurrency(bilty.toPayAmount)} />
          </div>
        </Link>
      )}

      {challan && (
        <Link href="/challan" className="bg-white rounded-xl shadow-sm p-5 hover:shadow-md transition-shadow block">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Challan Summary</h3>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <Stat label="Total Challans" value={challan.count} />
            <Stat label="Carrier Rent" value={formatCurrency(challan.totalCarrierRent)} />
            <Stat label="Receivable" value={formatCurrency(challan.totalReceivable)} />
            <Stat label="Payable" value={formatCurrency(challan.totalPayable)} />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 border-t pt-2">
            <span>Open: {challan.statusCounts.OPEN}</span>
            <span>Partially Cleared: {challan.statusCounts.PARTIALLY_CLEARED}</span>
            <span>Cleared: {challan.statusCounts.CLEARED}</span>
            <span>Overpaid: {challan.statusCounts.OVERPAID}</span>
          </div>
        </Link>
      )}

      {bill && (
        <Link href="/bill" className="bg-white rounded-xl shadow-sm p-5 hover:shadow-md transition-shadow block">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Bill Summary</h3>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <Stat label="Total Bills" value={bill.count} />
            <Stat label="Bill Amount" value={formatCurrency(bill.totalAmount)} />
            <Stat label="Collected" value={formatCurrency(bill.collected)} />
            <Stat label="Outstanding" value={formatCurrency(bill.outstanding)} />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 border-t pt-2">
            <span>Paid: {bill.paidCount}</span>
            <span>Partially Paid: {bill.partiallyPaidCount}</span>
            <span>Unpaid: {bill.unpaidCount}</span>
          </div>
        </Link>
      )}
    </div>
  );
}
