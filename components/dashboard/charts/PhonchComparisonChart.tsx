import ChartCard from "./ChartCard";
import { formatCurrency } from "../format";

export interface ShowroomPhonchSummary {
  recordCount: number;
  vehicleCount: number;
  deliveryCharges: number;
  otherExpense: number;
  claimAmount: number;
}

export interface PrivatePhonchSummary {
  recordCount: number;
  vehicleCount: number;
  totalRent: number;
  deliveryCharges: number;
  netRent: number;
  carrierPayable: number;
  caPayable: number;
  deliveryRecovery: number;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-xs font-medium text-gray-900">{value}</span>
    </div>
  );
}

export default function PhonchComparisonChart({
  showroom,
  privatePhonch,
}: {
  showroom: ShowroomPhonchSummary | null;
  privatePhonch: PrivatePhonchSummary | null;
}) {
  const isEmpty = !showroom && !privatePhonch;

  return (
    <ChartCard
      title="Private Phonch vs Showroom Phonch"
      description="Booked amounts established at creation - each module's own accounting dimensions, never blended into one figure."
      isEmpty={isEmpty}
      emptyMessage="No Phonch activity for this period, or not permitted"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {showroom && (
          <div className="rounded-lg border border-gray-100 p-3">
            <p className="text-xs font-semibold text-gray-700 mb-1">Showroom Phonch (Receivable)</p>
            <Stat label="Records" value={showroom.recordCount} />
            <Stat label="Vehicles" value={showroom.vehicleCount} />
            <Stat label="Delivery Charges" value={formatCurrency(showroom.deliveryCharges)} />
            <Stat label="Other Expense" value={formatCurrency(showroom.otherExpense)} />
            <Stat label="Claim Amount" value={formatCurrency(showroom.claimAmount)} />
          </div>
        )}
        {privatePhonch && (
          <div className="rounded-lg border border-gray-100 p-3">
            <p className="text-xs font-semibold text-gray-700 mb-1">Private Phonch (Payable)</p>
            <Stat label="Records" value={privatePhonch.recordCount} />
            <Stat label="Vehicles" value={privatePhonch.vehicleCount} />
            <Stat label="Total Rent" value={formatCurrency(privatePhonch.totalRent)} />
            <Stat label="Net Rent" value={formatCurrency(privatePhonch.netRent)} />
            <Stat label="Carrier Payable" value={formatCurrency(privatePhonch.carrierPayable)} />
            <Stat label="CA Payable" value={formatCurrency(privatePhonch.caPayable)} />
            {privatePhonch.deliveryRecovery > 0 && (
              <Stat label="Delivery Recovery" value={formatCurrency(privatePhonch.deliveryRecovery)} />
            )}
          </div>
        )}
      </div>
    </ChartCard>
  );
}
