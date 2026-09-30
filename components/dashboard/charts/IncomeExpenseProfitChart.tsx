"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import ChartCard from "./ChartCard";
import { formatCompactCurrency, formatCurrency } from "../format";

export type IncomeExpenseProfitPoint = {
  key: string;
  label: string;
  income: number;
  expense: number;
  profit: number;
};

export default function IncomeExpenseProfitChart({
  points,
}: {
  points: IncomeExpenseProfitPoint[];
}) {
  const isEmpty = points.every((p) => p.income === 0 && p.expense === 0 && p.profit === 0);

  return (
    <ChartCard
      title="Income vs Expense vs Profit"
      description="Same accounting basis as the Profit & Loss report, for the selected date range."
      isEmpty={isEmpty}
    >
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#9ca3af" />
            <YAxis tickFormatter={(v) => formatCompactCurrency(v)} tick={{ fontSize: 11 }} stroke="#9ca3af" width={70} />
            <Tooltip formatter={(value) => formatCurrency(Number(value))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="income" name="Income" stroke="#16a34a" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="expense" name="Expense" stroke="#dc2626" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="profit" name="Profit" stroke="#2563eb" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
