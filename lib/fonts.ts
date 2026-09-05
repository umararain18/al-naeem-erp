import { Noto_Nastaliq_Urdu } from "next/font/google";

// ============================================================
// Self-hosted via next/font/google (built into the `next` package -
// no new npm dependency). CSS + font files are downloaded once at
// build/dev time and served from this app's own origin; no runtime
// request to Google. Scoped to Party Ledger 2.0's Urdu (RTL) mode
// only - see app/parties/[id]/ledger/page.tsx - not applied
// app-wide, since the rest of the ERP has no Urdu mode.
// ============================================================
export const notoNastaliqUrdu = Noto_Nastaliq_Urdu({
  subsets: ["arabic"],
  display: "swap",
  variable: "--font-urdu",
});
