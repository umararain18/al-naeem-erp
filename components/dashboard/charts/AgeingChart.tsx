"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartCard from "./ChartCard";
import { formatCompactCurrency, formatCurrency } from "../format";

export interface AgeingBucket {
  bucket: string;
  amount: number;
  partyCount: number;
}

export default function AgeingChart({
  title,
  buckets,
  asOfLabel,
  color,
}: {
  title: string;
  buckets: AgeingBucket[];
  asOfLabel: string;
  color: string;
}) {
  const isEmpty = buckets.every((b) => b.amount === 0);

  return (
    <ChartCard
      title={title}
      description={`Approximate - based on days since each account's last recorded transaction (as of ${asOfLabel}), since the ERP does not track per-invoice ageing.`}
      isEmpty={isEmpty}
    >
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="bucket" tick={{ fontSize: 10 }} stroke="#9ca3af" />
            <YAxis tickFormatter={(v) => formatCompactCurrency(v)} tick={{ fontSize: 11 }} stroke="#9ca3af" width={70} />
            <Tooltip
              formatter={(value, name, item) => [
                formatCurrency(Number(value)),
                `${item?.payload?.partyCount ?? 0} party/parties`,
              ]}
            />
            <Bar dataKey="amount" fill={color} radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
