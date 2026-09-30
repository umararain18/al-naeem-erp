import { formatChangePercent, formatCurrency } from "./format";

const COUNT_METRICS = new Set(["Bilty Bookings", "Challans", "Bills"]);

export interface ComparisonRow {
  metric: string;
  current: number;
  previous: number | null;
  changePercent: number | null;
}

function formatValue(metric: string, value: number): string {
  return COUNT_METRICS.has(metric) ? value.toLocaleString() : formatCurrency(value);
}

export default function ComparisonTable({
  rows,
  comparisonRangeLabel,
}: {
  rows: ComparisonRow[];
  comparisonRangeLabel: string | null;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Period Comparison</h3>
        {comparisonRangeLabel && (
          <p className="text-xs text-gray-400 mt-0.5">Current period vs {comparisonRangeLabel}</p>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-400">
            <tr>
              <th className="py-2 pr-4">Metric</th>
              <th className="py-2 pr-4 text-right">Current Period</th>
              <th className="py-2 pr-4 text-right">Previous Period</th>
              <th className="py-2 pr-4 text-right">Difference</th>
              <th className="py-2 text-right">Change %</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => {
              const difference = row.previous === null ? null : row.current - row.previous;
              const changeText = formatChangePercent(row.changePercent);
              return (
                <tr key={row.metric}>
                  <td className="py-2 pr-4 text-gray-700">{row.metric}</td>
                  <td className="py-2 pr-4 text-right text-gray-900">{formatValue(row.metric, row.current)}</td>
                  <td className="py-2 pr-4 text-right text-gray-500">
                    {row.previous === null ? "—" : formatValue(row.metric, row.previous)}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-500">
                    {difference === null ? "—" : formatValue(row.metric, difference)}
                  </td>
                  <td
                    className={`py-2 text-right ${
                      row.changePercent === null ? "text-gray-400" : row.changePercent < 0 ? "text-red-500" : "text-green-600"
                    }`}
                  >
                    {changeText || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
