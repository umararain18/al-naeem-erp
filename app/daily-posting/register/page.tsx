import { redirect } from "next/navigation";

// Thin backward-compatibility redirect only. The Daily Posting
// register UI (list/edit/delete for a date) was merged into
// app/daily-posting/page.tsx itself - this route no longer renders
// anything of its own. Preserves `date`/`highlight` for any existing
// bookmark/external link (Cash Book, Party Ledger Outstanding) that
// still points here, so nothing 404s.
export default async function DailyPostingRegisterRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  const date = params.date;
  const highlight = params.highlight;
  if (typeof date === "string" && date) query.set("date", date);
  if (typeof highlight === "string" && highlight) query.set("highlight", highlight);
  const qs = query.toString();
  redirect(`/daily-posting${qs ? `?${qs}` : ""}`);
}
