"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import ChartCard from "./ChartCard";

export type OperationalVolumePoint = {
  key: string;
  label: string;
  bilty?: number;
  challan?: number;
  bill?: number;
};

const SERIES_META: Record<string, { name: string; color: string }> = {
  bilty: { name: "Bilty Bookings", color: "#2563eb" },
  challan: { name: "Challans/Dispatches", color: "#7c3aed" },
  bill: { name: "Bills", color: "#0891b2" },
};

export default function OperationalVolumeChart({
  points,
  series,
}: {
  points: OperationalVolumePoint[];
  series: string[];
}) {
  const isEmpty =
    series.length === 0 ||
    points.every((p) => series.every((s) => !((p as Record<string, unknown>)[s])));

  return (
    <ChartCard
      title="Operational Volume"
      description="Bilty / Challan / Bill counts for the selected period (operational, not accounting)."
      isEmpty={isEmpty}
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#9ca3af" />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#9ca3af" width={40} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {series.map((s) => (
              <Bar key={s} dataKey={s} name={SERIES_META[s]?.name || s} fill={SERIES_META[s]?.color || "#6b7280"} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}
