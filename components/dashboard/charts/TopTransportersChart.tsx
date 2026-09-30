"use client";

import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartCard from "./ChartCard";
import { formatCompactCurrency, formatCurrency } from "../format";

export interface TopTransporterRow {
  partyId: string;
  name: string;
  carrierRent: number;
  challanCount: number;
  paid: number;
  outstandingPayable: number;
  percentOfTotal: number;
}

export default function TopTransportersChart({
  data,
}: {
  data: { rows: TopTransporterRow[]; totalCarrierRent: number } | null;
}) {
  const rows = data?.rows || [];
  const isEmpty = rows.length === 0;

  return (
    <ChartCard
      title="Top Transporters"
      description="By Carrier Rent for the selected period. Clearing Agent Payable is never mixed in here."
      isEmpty={isEmpty}
      emptyMessage="No transporter activity for this period"
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
            <XAxis type="number" tickFormatter={(v) => formatCompactCurrency(v)} tick={{ fontSize: 11 }} stroke="#9ca3af" />
            <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} stroke="#9ca3af" />
            <Tooltip formatter={(value) => formatCurrency(Number(value))} />
            <Bar dataKey="carrierRent" fill="#7c3aed" radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 divide-y text-xs">
        {rows.map((row) => (
          <Link
            key={row.partyId}
            href={`/parties/${row.partyId}/ledger`}
            className="flex items-center justify-between py-1.5 hover:bg-gray-50 rounded px-1 -mx-1"
          >
            <span className="text-gray-700">{row.name}</span>
            <span className="text-gray-500">
              {formatCurrency(row.carrierRent)} · {row.challanCount} Challan{row.challanCount === 1 ? "" : "s"} · Outstanding{" "}
              {formatCurrency(row.outstandingPayable)}
            </span>
          </Link>
        ))}
      </div>
    </ChartCard>
  );
}
