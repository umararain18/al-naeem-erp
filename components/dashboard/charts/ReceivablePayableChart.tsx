"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartCard from "./ChartCard";
import { formatCompactCurrency, formatCurrency } from "../format";

export default function ReceivablePayableChart({
  receivable,
  payable,
  asOfLabel,
}: {
  receivable: number;
  payable: number;
  asOfLabel: string;
}) {
  const data = [
    { name: "Receivable", value: receivable, fill: "#2563eb" },
    { name: "Payable", value: payable, fill: "#f59e0b" },
  ];
  const isEmpty = receivable === 0 && payable === 0;

  return (
    <ChartCard
      title="Receivable vs Payable"
      description={`Closing outstanding balance as of ${asOfLabel} (a snapshot, not a period total).`}
      isEmpty={isEmpty}
    >
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="#9ca3af" />
            <YAxis tickFormatter={(v) => formatCompactCurrency(v)} tick={{ fontSize: 11 }} stroke="#9ca3af" width={70} />
            <Tooltip formatter={(value) => formatCurrency(Number(value))} />
            <Bar dataKey="value" radius={[6, 6, 0, 0]}>
              {data.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
