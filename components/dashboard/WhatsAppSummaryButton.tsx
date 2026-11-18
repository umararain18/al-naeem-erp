"use client";

import { useState } from "react";
import type { DailySummaryResponse } from "@/lib/reports/daily-summary";
import { buildWhatsAppSummaryText, buildWaMeLink } from "@/lib/reports/whatsapp-summary";

export default function WhatsAppSummaryButton({ summary }: { summary: DailySummaryResponse }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // The summary itself is financial (profit, cash, wasooli) - requires
  // reports.view, same as the Profit/Cash/Receivable cards it reads
  // from. Those fields are null (not just hidden) when the requesting
  // user lacks that permission - see lib/reports/daily-summary-
  // permissions.ts - so there is nothing to build a report from here.
  if (summary.profit === null) return null;

  const text = buildWhatsAppSummaryText(summary);
  const waLink = summary.ownerWhatsapp ? buildWaMeLink(summary.ownerWhatsapp, text) : null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-[var(--anc-line)] bg-[var(--anc-card)] px-3 py-2 text-sm font-semibold hover:bg-[var(--anc-soft)]"
      >
        WhatsApp summary
      </button>

      {open && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4" style={{ fontFamily: "var(--anc-font)" }}>
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-lg rounded-xl border border-[var(--anc-line)] bg-[var(--anc-card)] text-[var(--anc-ink)] p-5 shadow-xl">
            <h2 className="text-base font-bold mb-3">Aaj ki report - WhatsApp</h2>
            <pre className="whitespace-pre-wrap text-sm bg-[var(--anc-soft)] rounded-lg p-3 max-h-[50vh] overflow-auto">{text}</pre>
            {!summary.ownerWhatsapp && (
              <p className="text-xs text-[var(--anc-warn)] mt-2">
                Owner WhatsApp number not set - add it in Settings to enable the direct open-WhatsApp link.
              </p>
            )}
            <div className="flex justify-end gap-2 mt-4 flex-wrap">
              {copied && <span className="text-xs text-[var(--anc-good)] self-center">Copy ho gaya</span>}
              <button type="button" onClick={handleCopy} className="rounded-md border border-[var(--anc-line)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--anc-soft)]">
                Copy
              </button>
              {waLink && (
                <a href={waLink} target="_blank" rel="noopener noreferrer" className="rounded-md bg-[var(--anc-blue)] text-white px-3 py-1.5 text-xs font-semibold">
                  WhatsApp kholein
                </a>
              )}
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-[var(--anc-line)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--anc-soft)]">
                Band karein
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
