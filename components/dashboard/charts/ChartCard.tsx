import { ReactNode } from "react";

export default function ChartCard({
  title,
  description,
  isEmpty,
  emptyMessage,
  children,
}: {
  title: string;
  description?: string;
  isEmpty?: boolean;
  emptyMessage?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {description && <p className="text-xs text-gray-400 mt-0.5">{description}</p>}
      </div>
      {isEmpty ? (
        <div className="flex h-56 items-center justify-center text-sm text-gray-400">
          {emptyMessage || "No data for this period"}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
