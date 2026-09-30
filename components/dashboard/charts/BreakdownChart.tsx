"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartCard from "./ChartCard";
import { formatCompactCurrency, formatCurrency } from "../format";

export type BreakdownEntry = {
  id: string;
  accountName: string;
  accountCode: string | null;
  category: string;
  amount: number;
};

export default function BreakdownChart({
  title,
  description,
  entries,
  color,
}: {
  title: string;
  description?: string;
  entries: BreakdownEntry[];
  color: string;
}) {
  const top = entries.slice(0, 8);
  const isEmpty = top.length === 0;

  return (
    <ChartCard title={title} description={description} isEmpty={isEmpty}>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={top} layout="vertical" margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
            <XAxis type="number" tickFormatter={(v) => formatCompactCurrency(v)} tick={{ fontSize: 11 }} stroke="#9ca3af" />
            <YAxis
              type="category"
              dataKey="accountName"
              width={130}
              tick={{ fontSize: 11 }}
              stroke="#9ca3af"
            />
            <Tooltip formatter={(value) => formatCurrency(Number(value))} />
            <Bar dataKey="amount" fill={color} radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
