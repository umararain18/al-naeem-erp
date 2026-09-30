"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartCard from "./ChartCard";
import { formatCompactCurrency, formatCurrency } from "../format";

export type CollectionsPaymentsPoint = {
  key: string;
  label: string;
  collections: number;
  payments: number;
};

export default function CollectionsPaymentsChart({ points }: { points: CollectionsPaymentsPoint[] }) {
  const isEmpty = points.every((p) => p.collections === 0 && p.payments === 0);

  return (
    <ChartCard
      title="Collections vs Payments"
      description="Actual Cash/Bank movement during the selected period (not Receivable/Payable movement)."
      isEmpty={isEmpty}
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#9ca3af" />
            <YAxis tickFormatter={(v) => formatCompactCurrency(v)} tick={{ fontSize: 11 }} stroke="#9ca3af" width={70} />
            <Tooltip formatter={(value) => formatCurrency(Number(value))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="collections" name="Collections" fill="#16a34a" radius={[4, 4, 0, 0]} />
            <Bar dataKey="payments" name="Payments" fill="#dc2626" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
