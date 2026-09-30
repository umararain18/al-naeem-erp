import Link from "next/link";
import { ReactNode } from "react";
import { formatChangePercent, formatCurrency } from "./format";

export interface KpiComparison {
  current: number;
  previous: number | null;
  changePercent: number | null;
}

export default function KpiCard({
  label,
  value,
  href,
  comparison,
  compareEnabled,
  comparisonLabel,
  valueClassName,
  footnote,
}: {
  label: string;
  value: number;
  href?: string;
  comparison?: KpiComparison;
  compareEnabled?: boolean;
  comparisonLabel?: string;
  valueClassName?: string;
  footnote?: string;
}) {
  const changeText = compareEnabled && comparison ? formatChangePercent(comparison.changePercent) : null;

  const content: ReactNode = (
    <>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`text-xl font-bold mt-1 ${valueClassName || "text-gray-900"}`}>{formatCurrency(value)}</p>
      {changeText ? (
        <p className={`text-xs mt-1 ${comparison && comparison.changePercent !== null && comparison.changePercent < 0 ? "text-red-500" : "text-green-600"}`}>
          {changeText} <span className="text-gray-400">{comparisonLabel || "vs previous period"}</span>
        </p>
      ) : compareEnabled && comparison && comparison.previous === null ? (
        <p className="text-xs mt-1 text-gray-300">No prior-period data</p>
      ) : footnote ? (
        <p className="text-xs mt-1 text-gray-300">{footnote}</p>
      ) : null}
    </>
  );

  const className = "bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow block";

  if (href) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }
  return <div className={className}>{content}</div>;
}
