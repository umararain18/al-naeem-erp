"use client";

import { useState } from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartCard from "./ChartCard";
import { formatCompactCurrency, formatCurrency } from "../format";

export interface TopClientRevenueRow {
  key: string;
  name: string;
  phone: string | null;
  isParty: boolean;
  partyId: string | null;
  mostRecentBillId: string;
  revenue: number;
  billCount: number;
  percentOfTotal: number;
}

export interface TopClientActivityRow {
  partyId: string;
  name: string;
  biltyCount: number;
  billCount: number;
}

function clientHref(row: TopClientRevenueRow): string {
  return row.isParty && row.partyId ? `/parties/${row.partyId}/ledger` : `/bill/${row.mostRecentBillId}`;
}

export default function TopClientsChart({
  revenue,
  activity,
}: {
  revenue: { rows: TopClientRevenueRow[]; totalRevenue: number } | null;
  activity: TopClientActivityRow[] | null;
}) {
  const [tab, setTab] = useState<"revenue" | "bookings">("revenue");
  const hasRevenue = Boolean(revenue && revenue.rows.length > 0);
  const hasActivity = Boolean(activity && activity.length > 0);
  const isEmpty = tab === "revenue" ? !hasRevenue : !hasActivity;

  return (
    <ChartCard
      title="Top Clients"
      description={
        tab === "revenue"
          ? "By Bill revenue for the selected period. Walk-in clients are shown separately from Party clients."
          : "By booking/document activity for the selected period (counts only - not summed into one amount)."
      }
      isEmpty={isEmpty}
      emptyMessage="No client data for this period"
    >
      <div className="mb-3 flex gap-1 rounded-lg bg-gray-100 p-1 text-xs w-fit">
        <button
          type="button"
          onClick={() => setTab("revenue")}
          className={`rounded-md px-3 py-1 font-medium ${tab === "revenue" ? "bg-white shadow-sm text-gray-900" : "text-gray-500"}`}
        >
          Revenue
        </button>
        <button
          type="button"
          onClick={() => setTab("bookings")}
          className={`rounded-md px-3 py-1 font-medium ${tab === "bookings" ? "bg-white shadow-sm text-gray-900" : "text-gray-500"}`}
        >
          Bookings
        </button>
      </div>

      {tab === "revenue" && hasRevenue && revenue && (
        <>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenue.rows} layout="vertical" margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => formatCompactCurrency(v)} tick={{ fontSize: 11 }} stroke="#9ca3af" />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} stroke="#9ca3af" />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Bar dataKey="revenue" fill="#2563eb" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 divide-y text-xs">
            {revenue.rows.map((row) => (
              <Link
                key={row.key}
                href={clientHref(row)}
                className="flex items-center justify-between py-1.5 hover:bg-gray-50 rounded px-1 -mx-1"
              >
                <span className="text-gray-700">
                  {row.name}
                  {!row.isParty && <span className="ml-1 text-gray-400">(walk-in)</span>}
                </span>
                <span className="text-gray-500">
                  {formatCurrency(row.revenue)} · {row.percentOfTotal}% · {row.billCount} bill{row.billCount === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}

      {tab === "bookings" && hasActivity && activity && (
        <div className="divide-y text-xs">
          {activity.map((row) => (
            <Link
              key={row.partyId}
              href={`/parties/${row.partyId}/ledger`}
              className="flex items-center justify-between py-2 hover:bg-gray-50 rounded px-1 -mx-1"
            >
              <span className="text-gray-700">{row.name}</span>
              <span className="text-gray-500">
                {row.biltyCount} Bilty{row.biltyCount === 1 ? "" : "s"} · {row.billCount} Bill{row.billCount === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </ChartCard>
  );
}
