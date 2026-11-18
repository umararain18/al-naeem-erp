"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { DrilldownDataset } from "@/lib/reports/daily-summary";

function formatRs(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-US")}`;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function downloadCsv(filename: string, columns: string[], rows: (string | number)[][]) {
  const lines = [columns.map((c) => csvEscape(c)).join(","), ...rows.map((r) => r.map((v) => csvEscape(String(v))).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Universal drill-down drawer - every clickable card/tile/heading/top-
 * list row on the Dashboard opens this with its own already-fetched
 * DrilldownDataset (part of the SAME daily-summary JSON the card
 * itself rendered from - never a second fetch, never different
 * numbers than the card showed).
 */
export default function DrillDownDrawer({ dataset, onClose }: { dataset: DrilldownDataset | null; onClose: () => void }) {
  const [search, setSearch] = useState("");

  useEffect(() => {
    setSearch("");
  }, [dataset]);

  useEffect(() => {
    if (!dataset) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [dataset, onClose]);

  const filteredRows = useMemo(() => {
    if (!dataset) return [];
    const q = search.trim().toLowerCase();
    const rows = q ? dataset.rows.filter((r) => r.name.toLowerCase().includes(q)) : dataset.rows;
    return [...rows].sort((a, b) => b.amount - a.amount || b.count - a.count);
  }, [dataset, search]);

  const maxAmount = useMemo(() => Math.max(1, ...filteredRows.map((r) => Math.abs(r.amount))), [filteredRows]);
  const totals = useMemo(
    () => filteredRows.reduce((acc, r) => ({ count: acc.count + r.count, amount: acc.amount + r.amount }), { count: 0, amount: 0 }),
    [filteredRows]
  );

  if (!dataset) return null;

  return (
    <div className="anc-theme fixed inset-0 z-[100]" style={{ fontFamily: "var(--anc-font)" }}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-[640px] bg-[var(--anc-card)] text-[var(--anc-ink)] border-l-4 border-[var(--anc-crimson)] flex flex-col shadow-xl">
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--anc-line)]">
          <div>
            <h2 className="text-lg font-bold">{dataset.title}</h2>
            <p className="text-xs text-[var(--anc-muted)] mt-0.5">{dataset.subtitle}</p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => downloadCsv(`${dataset.title.replace(/\s+/g, "-")}.csv`, dataset.columns, filteredRows.map((r) => [r.name, r.count, r.amount]))}
              className="rounded-md border border-[var(--anc-line)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--anc-soft)]"
            >
              Excel
            </button>
            <button type="button" onClick={onClose} className="rounded-md border border-[var(--anc-line)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--anc-soft)]">
              Band karein
            </button>
          </div>
        </header>

        <div className="px-5 py-3 overflow-y-auto flex-1">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Naam ya number likhein..."
            className="w-full rounded-lg border border-[var(--anc-line)] bg-[var(--anc-bg)] px-3 py-2 text-sm outline-none mb-3"
          />

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--anc-muted)]">
                <th className="py-1.5">#</th>
                <th className="py-1.5">{dataset.columns[0]}</th>
                <th className="py-1.5 text-right">{dataset.columns[1]}</th>
                <th className="py-1.5 text-right">{dataset.columns[2]}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--anc-line)]">
              {filteredRows.map((row) => (
                <tr key={row.rank}>
                  <td className="py-2 text-[var(--anc-muted)]">{row.rank}</td>
                  <td className="py-2">
                    {row.link ? (
                      <Link href={row.link} className="text-[var(--anc-blue)] hover:underline">
                        {row.name}
                      </Link>
                    ) : (
                      row.name
                    )}
                    <span className="block h-1 bg-[var(--anc-soft)] rounded-full mt-1 overflow-hidden">
                      <span className="block h-full bg-[var(--anc-green-2)]" style={{ width: `${Math.round((Math.abs(row.amount) / maxAmount) * 100)}%` }} />
                    </span>
                  </td>
                  <td className="py-2 text-right anc-num">{row.count.toLocaleString("en-US")}</td>
                  <td className="py-2 text-right anc-num">{formatRs(row.amount)}</td>
                </tr>
              ))}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-[var(--anc-muted)]">
                    Kuch nahi mila
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="font-bold border-t-2 border-[var(--anc-line)]">
                <td></td>
                <td className="py-2">Kul ({filteredRows.length})</td>
                <td className="py-2 text-right anc-num">{totals.count.toLocaleString("en-US")}</td>
                <td className="py-2 text-right anc-num">{formatRs(totals.amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
