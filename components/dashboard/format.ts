export function formatCurrency(value: number | undefined | null): string {
  const safeValue = typeof value === "number" && !Number.isNaN(value) ? value : 0;
  return `Rs. ${safeValue.toLocaleString()}`;
}

export function formatCompactCurrency(value: number | undefined | null): string {
  const safeValue = typeof value === "number" && !Number.isNaN(value) ? value : 0;
  const abs = Math.abs(safeValue);
  if (abs >= 1_000_000) return `Rs. ${(safeValue / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `Rs. ${(safeValue / 1_000).toFixed(1)}K`;
  return `Rs. ${safeValue.toLocaleString()}`;
}

export function formatChangePercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const arrow = value >= 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(value).toLocaleString()}%`;
}
