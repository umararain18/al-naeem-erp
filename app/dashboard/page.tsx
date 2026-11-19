"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { DailySummaryResponse, DrilldownKey } from "@/lib/reports/daily-summary";
import DrillDownDrawer from "@/components/dashboard/DrillDownDrawer";
import WhatsAppSummaryButton from "@/components/dashboard/WhatsAppSummaryButton";

function fmt(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-US")}`;
}

function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatKhulasaHeader(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dayName} ${dd}-${mm}-${d.getFullYear()}`;
}

function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const isUp = pct >= 0;
  return (
    <span className={`text-[11px] font-bold ${isUp ? "text-[var(--anc-good)]" : "text-[var(--anc-bad)]"}`}>
      {isUp ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function NoAccessNote({ label }: { label?: string }) {
  return (
    <div className="text-xs text-[var(--anc-muted)] italic py-2">{label ? `${label}: ` : ""}No access - permission chahiye</div>
  );
}

function Tile({ label, value, sub, onClick, tone, locked }: { label: string; value?: string; sub?: string; onClick?: () => void; tone?: "in" | "out"; locked?: boolean }) {
  const valueColor = tone === "in" ? "text-[var(--anc-good)]" : tone === "out" ? "text-[var(--anc-bad)]" : "text-[var(--anc-ink)]";
  if (locked || value === undefined) {
    return (
      <div className="block bg-[var(--anc-soft)] rounded-lg p-3 border border-transparent opacity-70">
        <div className="text-[11px] text-[var(--anc-muted)] font-semibold">{label}</div>
        <div className="text-xs text-[var(--anc-muted)] italic mt-1.5">No access</div>
      </div>
    );
  }
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className="block text-left bg-[var(--anc-soft)] rounded-lg p-3 border border-transparent hover:border-[var(--anc-line)] w-full"
    >
      <div className="text-[11px] text-[var(--anc-muted)] font-semibold">{label}</div>
      <div className={`text-xl font-extrabold mt-1 anc-num ${valueColor}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--anc-muted)] mt-0.5">{sub}</div>}
    </Comp>
  );
}

function Card({ title, subtitle, children, onTitleClick }: { title: string; subtitle?: string; children: React.ReactNode; onTitleClick?: () => void }) {
  return (
    <section className="bg-[var(--anc-card)] border border-[var(--anc-line)] rounded-xl p-4">
      <h2 className="flex items-center justify-between gap-2 mb-3">
        <span className="flex items-center gap-2 text-sm font-extrabold">
          <span className="inline-block w-[3px] h-3.5 bg-[var(--anc-crimson)] rounded-sm" />
          {onTitleClick ? (
            <button type="button" onClick={onTitleClick} className="hover:underline text-left">
              {title} ›
            </button>
          ) : (
            title
          )}
        </span>
        {subtitle && <small className="text-[11px] font-semibold text-[var(--anc-muted)]">{subtitle}</small>}
      </h2>
      {children}
    </section>
  );
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<DailySummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("THIS_MONTH");
  const [khulasaDate, setKhulasaDate] = useState<string | null>(null);
  const [drilldownKey, setDrilldownKey] = useState<DrilldownKey | null>(null);
  const [fifoMismatchCount, setFifoMismatchCount] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const dateParam = khulasaDate ? `&date=${khulasaDate}` : "";
        const res = await fetch(`/api/reports/daily-summary?period=${period}${dateParam}`);
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.message || "Unable to load dashboard");
          return;
        }
        setSummary(json.summary);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    })();
  }, [period, khulasaDate]);

  // PERFORMANCE: fetched separately, AFTER the main dashboard has
  // already rendered - a full FIFO reconciliation sweep is too slow
  // to be on the main load path (see getFifoMismatchCount()'s own doc
  // comment in lib/reports/daily-summary.ts). Shows "…" until it
  // resolves, never blocking anything else on the page.
  useEffect(() => {
    setFifoMismatchCount(null);
    (async () => {
      try {
        const res = await fetch("/api/reports/daily-summary/fifo-mismatch");
        const json = await res.json();
        if (res.ok && json.success) setFifoMismatchCount(json.fifoMismatchCount);
      } catch {
        // Leave as "…" - this is a secondary alert count, never worth
        // failing the dashboard over.
      }
    })();
  }, [period]);

  const drilldown = useMemo(() => (summary && drilldownKey ? summary.drilldowns[drilldownKey] ?? null : null), [summary, drilldownKey]);

  if (loading && !summary) {
    return (
      <div className="anc-theme min-h-screen bg-[var(--anc-bg)] p-6" style={{ fontFamily: "var(--anc-font)" }}>
        <p className="text-[var(--anc-muted)]">Loading dashboard...</p>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="anc-theme min-h-screen bg-[var(--anc-bg)] p-6" style={{ fontFamily: "var(--anc-font)" }}>
        <p className="text-[var(--anc-bad)]">{error || "Unable to load dashboard"}</p>
      </div>
    );
  }

  const { today, profit, wasooli, denaHai, alerts, topCustomers, topClearingAgents, topShowroomTransporters, topChallanTransporters, routes, emptyReturnCities, ownCarriers, marketing, charts } = summary;

  const maxMonthValue = charts ? Math.max(1, ...charts.incomeExpense6mo.flatMap((m) => [m.income, m.expense])) : 1;
  const maxExpense = charts ? Math.max(1, ...charts.expenseBreakdown.map((e) => e.amount)) : 1;
  const totalAgeing = charts ? charts.receivableAgeing.reduce((s, b) => s + b.amount, 0) || 1 : 1;
  const ageingColors: Record<string, string> = { Current: "var(--anc-green-2)", "1-30 Days": "var(--anc-green-2)", "31-60 Days": "var(--anc-gold)", "61-90 Days": "var(--anc-warn)", "90+ Days": "var(--anc-crimson)" };

  return (
    <div className="anc-theme min-h-screen bg-[var(--anc-bg)] text-[var(--anc-ink)]" style={{ fontFamily: "var(--anc-font)" }}>
      <div className="h-1 bg-[var(--anc-crimson)]" />
      <div className="max-w-[1320px] mx-auto p-5 flex flex-col gap-5">
        {/* TOP BAR */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-extrabold">ANC Dashboard</h1>
            <p className="text-xs text-[var(--anc-muted)] mt-0.5">{summary.meta.periodLabel}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="rounded-lg border border-[var(--anc-line)] bg-[var(--anc-card)] px-3 py-2 text-sm font-semibold"
            >
              <option value="THIS_MONTH">This Month</option>
              <option value="LAST_MONTH">Last Month</option>
              <option value="THIS_YEAR">This Year</option>
            </select>
            <Link href="/bilty" className="rounded-lg bg-[var(--anc-blue)] text-white px-3 py-2 text-sm font-semibold">
              + New Bilty
            </Link>
            <Link href="/challan" className="rounded-lg border border-[var(--anc-line)] bg-[var(--anc-card)] px-3 py-2 text-sm font-semibold hover:bg-[var(--anc-soft)]">
              + Challan
            </Link>
            <Link href="/daily-posting" className="rounded-lg border border-[var(--anc-line)] bg-[var(--anc-card)] px-3 py-2 text-sm font-semibold hover:bg-[var(--anc-soft)]">
              Daily Posting
            </Link>
            <WhatsAppSummaryButton summary={summary} />
          </div>
        </div>

        {/* 1. AAJ KA KHULASA */}
        <section className="bg-[var(--anc-card)] border border-[var(--anc-line)] border-t-[3px] border-t-[var(--anc-gold)] rounded-xl p-4">
          <h2 className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <span className="flex items-center gap-2 text-sm font-extrabold">
              <span className="inline-block w-[3px] h-3.5 bg-[var(--anc-crimson)] rounded-sm" />
              Khulasa: {formatKhulasaHeader(summary.meta.todayISO)}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {([
                ["Kal", localISODate(new Date(Date.now() - 86400000))],
                ["Aaj", localISODate(new Date())],
                ...(summary.meta.latestPostedDateISO ? [["Aakhri posted din", summary.meta.latestPostedDateISO] as [string, string]] : []),
              ] as [string, string][]).map(([label, iso]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setKhulasaDate(iso)}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                    summary.meta.todayISO === iso
                      ? "border-[var(--anc-gold)] bg-[var(--anc-gold)] text-black"
                      : "border-[var(--anc-line)] bg-[var(--anc-card)] hover:bg-[var(--anc-soft)]"
                  }`}
                >
                  {label}
                </button>
              ))}
              <input
                type="date"
                value={summary.meta.todayISO}
                onChange={(e) => setKhulasaDate(e.target.value)}
                className="rounded-lg border border-[var(--anc-line)] bg-[var(--anc-card)] px-2 py-1 text-[11px] font-semibold"
              />
            </div>
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <Tile label="Bilty bani" locked={today.biltyCount === null} value={today.biltyCount !== null ? String(today.biltyCount) : undefined} sub={today.biltyBookingAmount !== null ? `Booking ${fmt(today.biltyBookingAmount)}` : undefined} onClick={today.biltyCount !== null ? () => setDrilldownKey("tb") : undefined} />
            <Tile label="Challan bane" locked={today.challanCount === null} value={today.challanCount !== null ? String(today.challanCount) : undefined} sub={today.challanDispatchedCount !== null ? `${today.challanDispatchedCount} dispatch` : undefined} onClick={today.challanCount !== null ? () => setDrilldownKey("tc") : undefined} />
            <Tile label="Bill bane" locked={today.billCount === null} value={today.billCount !== null ? String(today.billCount) : undefined} sub={today.billAmount !== null ? fmt(today.billAmount) : undefined} onClick={today.billCount !== null ? () => setDrilldownKey("tbill") : undefined} />
            <Tile label="Showroom Phonch gaariyan" locked={today.showroomPhonchVehicleCount === null} value={today.showroomPhonchVehicleCount !== null ? String(today.showroomPhonchVehicleCount) : undefined} sub={today.showroomPhonchDeliveryCharges !== null ? fmt(today.showroomPhonchDeliveryCharges) : undefined} onClick={today.showroomPhonchVehicleCount !== null ? () => setDrilldownKey("tsr") : undefined} />
            <Tile label="Private Phonch gaariyan" locked={today.privatePhonchVehicleCount === null} value={today.privatePhonchVehicleCount !== null ? String(today.privatePhonchVehicleCount) : undefined} sub={today.privatePhonchRent !== null ? fmt(today.privatePhonchRent) : undefined} onClick={today.privatePhonchVehicleCount !== null ? () => setDrilldownKey("tpp") : undefined} />
            <Tile label="Paise aaye (In)" locked={today.cashIn === null} value={today.cashIn !== null ? fmt(today.cashIn) : undefined} sub="Cash + Bank, aaj" tone="in" onClick={today.cashIn !== null ? () => setDrilldownKey("tin") : undefined} />
            <Tile label="Paise gaye (Out)" locked={today.cashOut === null} value={today.cashOut !== null ? fmt(today.cashOut) : undefined} sub="Cash + Bank, aaj" tone="out" onClick={today.cashOut !== null ? () => setDrilldownKey("tout") : undefined} />
            <Tile label="Farq (In - Out)" locked={today.netCash === null} value={today.netCash !== null ? `${today.netCash >= 0 ? "+" : ""}${fmt(today.netCash)}` : undefined} sub="aaj ka net cash" />
          </div>
          {today.cashByAccount === null ? (
            <NoAccessNote label="Cash balances" />
          ) : (
            <div className="flex flex-wrap gap-2.5 mt-3">
              {today.cashByAccount.filter((acc) => acc.balance !== 0).map((acc) => (
                <div key={acc.accountId} className="flex-1 min-w-[150px] border border-dashed border-[var(--anc-line)] rounded-lg px-3 py-2 flex justify-between items-center text-sm">
                  <span>{acc.accountName}</span>
                  <b className="anc-num">{fmt(acc.balance)}</b>
                </div>
              ))}
              <div className="flex-1 min-w-[150px] rounded-lg px-3 py-2 flex justify-between items-center text-sm bg-[var(--anc-green)] text-white">
                <span>Kul Cash + Bank</span>
                <b className="anc-num">{today.totalCash !== null ? fmt(today.totalCash) : "—"}</b>
              </div>
            </div>
          )}
        </section>

        {/* 2. PROFIT */}
        <section className="bg-[var(--anc-card)] border border-[var(--anc-line)] rounded-xl p-4">
          <h2 className="flex items-center justify-between gap-2 mb-3">
            <span className="flex items-center gap-2 text-sm font-extrabold">
              <span className="inline-block w-[3px] h-3.5 bg-[var(--anc-crimson)] rounded-sm" />
              Is period ka munafa
            </span>
            <small className="text-[11px] font-semibold text-[var(--anc-muted)]">{summary.meta.comparisonLabel ? `${summary.meta.comparisonLabel} ke muqable` : ""}</small>
          </h2>
          {profit === null ? (
            <NoAccessNote label="Profit / Income / Kharcha" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1.3fr] gap-2.5 items-center">
              <button type="button" onClick={() => setDrilldownKey("inc")} className="text-left border border-[var(--anc-line)] rounded-lg p-3">
                <div className="text-[11px] text-[var(--anc-muted)] font-semibold">Kul Income</div>
                <div className="text-xl font-extrabold anc-num">{fmt(profit.totalIncome)}</div>
                <Delta pct={profit.incomeDeltaPct} />
              </button>
              <span className="hidden md:block text-2xl font-extrabold text-[var(--anc-muted)] text-center">−</span>
              <button type="button" onClick={() => setDrilldownKey("exp")} className="text-left border border-[var(--anc-line)] rounded-lg p-3">
                <div className="text-[11px] text-[var(--anc-muted)] font-semibold">Kul Kharcha</div>
                <div className="text-xl font-extrabold anc-num">{fmt(profit.totalExpense)}</div>
                <Delta pct={profit.expenseDeltaPct} />
              </button>
              <span className="hidden md:block text-2xl font-extrabold text-[var(--anc-muted)] text-center">=</span>
              <div className="border border-transparent rounded-lg p-3 bg-[var(--anc-good-bg)]">
                <div className="text-[11px] text-[var(--anc-muted)] font-semibold">Profit</div>
                <div className="text-2xl font-extrabold anc-num">{fmt(profit.profit)}</div>
                <Delta pct={profit.profitDeltaPct} />
              </div>
            </div>
          )}
        </section>

        {/* 3. WASOOLI | DENA HAI */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Card title="Wasooli karni hai" subtitle={wasooli !== null ? `30 din se purana - ${fmt(summary.wasooliTotal!)} kul` : undefined} onTitleClick={wasooli !== null ? () => setDrilldownKey("rec") : undefined}>
            {wasooli === null ? (
              <NoAccessNote />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-[var(--anc-muted)]">
                    <th className="py-1">Party</th>
                    <th className="py-1 text-right">Baaqi</th>
                    <th className="py-1 text-right">Din</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--anc-line)]">
                  {wasooli.map((w) => (
                    <tr key={w.partyId ?? w.name}>
                      <td className="py-1.5">{w.partyId ? <Link href={`/parties/${w.partyId}/ledger`} className="text-[var(--anc-blue)] hover:underline">{w.name}</Link> : w.name}</td>
                      <td className="py-1.5 text-right anc-num">{fmt(w.amount)}</td>
                      <td className="py-1.5 text-right">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${w.days > 45 ? "bg-[var(--anc-bad-bg)] text-[var(--anc-bad)]" : "bg-[var(--anc-warn-bg)] text-[var(--anc-warn)]"}`}>
                          {w.days === Infinity ? "—" : `${w.days} din`}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {wasooli.length === 0 && <tr><td colSpan={3} className="py-4 text-center text-[var(--anc-muted)]">Kuch baaqi nahi</td></tr>}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Dena hai" subtitle={denaHai !== null ? `carriers / transporters - ${fmt(summary.denaHaiTotal!)} kul` : undefined} onTitleClick={denaHai !== null ? () => setDrilldownKey("pay") : undefined}>
            {denaHai === null ? (
              <NoAccessNote />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-[var(--anc-muted)]">
                    <th className="py-1">Party</th>
                    <th className="py-1 text-right">Dena</th>
                    <th className="py-1 text-right">Sab se purana</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--anc-line)]">
                  {denaHai.map((d) => (
                    <tr key={d.partyId}>
                      <td className="py-1.5"><Link href={`/parties/${d.partyId}/ledger`} className="text-[var(--anc-blue)] hover:underline">{d.name}</Link></td>
                      <td className="py-1.5 text-right anc-num">{fmt(d.amount)}</td>
                      <td className="py-1.5 text-right text-[11px] text-[var(--anc-muted)]">{d.oldestDocNo ? `${d.oldestDocNo} · ${d.oldestDocDays} din` : "—"}</td>
                    </tr>
                  ))}
                  {denaHai.length === 0 && <tr><td colSpan={3} className="py-4 text-center text-[var(--anc-muted)]">Kuch dena nahi</td></tr>}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        {/* 4. ALERTS */}
        <Card title="Dhyan dein" subtitle={`${[alerts.lossChallanCount > 0, alerts.settlementPendingCount > 0, alerts.unearnedRevenueBalance > 0, alerts.noPhoneBiltyCount > 0].filter(Boolean).length} alerts`}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <button type="button" onClick={() => setDrilldownKey("loss")} className="flex justify-between items-center gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--anc-bad-bg)]">
              <span>Nuqsan wale challan (rent &gt; booking)</span>
              <b className="anc-num">{alerts.lossChallanCount}</b>
            </button>
            <button type="button" onClick={() => setDrilldownKey("settle")} className="flex justify-between items-center gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--anc-warn-bg)]">
              <span>Settlement baaqi challan</span>
              <b className="anc-num">{alerts.settlementPendingCount}</b>
            </button>
            <div className="flex justify-between items-center gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--anc-warn-bg)]">
              <span>Unearned balance</span>
              <b className="anc-num">{fmt(alerts.unearnedRevenueBalance)}</b>
            </div>
            <div className="flex justify-between items-center gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--anc-info-bg)]">
              <span>FIFO mismatch parties</span>
              <b className="anc-num">{fifoMismatchCount === null ? "…" : fifoMismatchCount}</b>
            </div>
            <div className="flex justify-between items-center gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--anc-info-bg)]">
              <span>Bina phone number bilties (is period)</span>
              <b className="anc-num">{alerts.noPhoneBiltyCount}</b>
            </div>
          </div>
        </Card>

        {/* 5. TOP PARTIES */}
        <Card title="Top parties" subtitle="is period - sab se zyada kaam dene wale">
          {topCustomers === null || topClearingAgents === null || topShowroomTransporters === null || topChallanTransporters === null ? (
            <NoAccessNote label="Top parties" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <TopList title="Top Customers" subtitle="sab se zyada bilties banwayin" unit="bilty" rows={topCustomers} onOpen={() => setDrilldownKey("cust")} />
              <TopList title="Top Clearing Agents" subtitle="Private Phonch par gaariyan" unit="gaari" rows={topClearingAgents} onOpen={() => setDrilldownKey("ca")} />
              <TopList title="Top Transporters - Showroom" subtitle="Showroom Phonch par gaariyan" unit="gaari" rows={topShowroomTransporters} onOpen={() => setDrilldownKey("sr")} />
              <TopList title="Top Transporters - Challan" subtitle="hamari gaariyan load kin" unit="challan" rows={topChallanTransporters} onOpen={() => setDrilldownKey("ch")} />
            </div>
          )}
        </Card>

        {/* 6. ROUTES | OWN CARRIER | MARKETING */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <Card title="Behtareen routes" subtitle="profit se sorted" onTitleClick={() => setDrilldownKey("routes")}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase text-[var(--anc-muted)]">
                  <th className="py-1">Route</th>
                  <th className="py-1 text-right">Bilties</th>
                  <th className="py-1 text-right">Booking</th>
                  <th className="py-1 text-right">Carrier Rent</th>
                  <th className="py-1 text-right">Profit</th>
                  <th className="py-1 text-right">Margin %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--anc-line)]">
                {routes.map((r) => (
                  <tr key={r.route}>
                    <td className="py-1.5">{r.route}</td>
                    <td className="py-1.5 text-right anc-num">{r.biltyCount}</td>
                    <td className="py-1.5 text-right anc-num">{fmt(r.booking)}</td>
                    <td className="py-1.5 text-right anc-num">{fmt(r.carrierRent)}</td>
                    <td className={`py-1.5 text-right anc-num ${r.margin >= 0 ? "text-[var(--anc-good)]" : "text-[var(--anc-bad)]"}`}>{fmt(r.margin)}</td>
                    <td className="py-1.5 text-right anc-num">{r.marginPct.toFixed(1)}%</td>
                  </tr>
                ))}
                {routes.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-[var(--anc-muted)]">Koi route nahi</td></tr>}
              </tbody>
            </table>
            {emptyReturnCities.length > 0 && (
              <div className="mt-2.5 px-3 py-2 rounded-lg text-sm bg-[var(--anc-warn-bg)]">
                Khali wapsi: {emptyReturnCities.slice(0, 3).map((c) => c.city).join(", ")}
              </div>
            )}
          </Card>

          <Card title={ownCarriers[0] ? `Own Carrier - ${ownCarriers[0].carrierNumber}` : "Own Carrier"} subtitle="apna carrier">
            {ownCarriers.length === 0 && <p className="text-sm text-[var(--anc-muted)]">Koi Own Carrier nahi</p>}
            {ownCarriers.map((oc) => (
              <div key={oc.carrierId} className="mb-3">
                {oc.activeTrip ? (
                  <div className="rounded-lg p-3 bg-[var(--anc-soft)] shadow-[inset_3px_0_0_var(--anc-blue)] mb-2.5">
                    <div className="text-xs font-bold">Chalti trip #{oc.activeTrip.tripNo}</div>
                    <div className="text-[11px] text-[var(--anc-muted)]">{oc.activeTrip.route ?? "-"} · {oc.activeTrip.daysRunning} din se</div>
                    <div className="text-[11px] text-[var(--anc-muted)] anc-num">Kharcha ab tak {fmt(oc.activeTrip.expenseSoFar)}</div>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--anc-muted)] mb-2.5">Koi chalti trip nahi</p>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-[var(--anc-muted)]">
                      <th className="py-1">Pichli trips</th>
                      <th className="py-1 text-right">Munafa</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--anc-line)]">
                    {oc.recentTrips.map((t) => (
                      <tr key={t.tripId}>
                        <td className="py-1">Trip {t.tripNo}</td>
                        <td className={`py-1 text-right anc-num ${t.profit >= 0 ? "text-[var(--anc-good)]" : "text-[var(--anc-bad)]"}`}>{t.profit >= 0 ? fmt(t.profit) : `- ${fmt(Math.abs(t.profit))}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </Card>

          <Card title="Marketing" subtitle="is period">
            <div className="grid grid-cols-2 gap-2.5">
              <Tile label="Aaj ke follow-ups" value={String(marketing.followUpsDueToday)} />
              <Tile label="Messages bheje" value={String(marketing.messagesSentThisPeriod)} />
              <Tile label="Leads" value={String(marketing.leadsThisPeriod)} />
              <Tile label="Campaign se booking" value={String(marketing.campaignBookingsCount)} sub={fmt(marketing.campaignBookingsAmount)} tone="in" />
            </div>
          </Card>
        </div>

        {/* 7. CHARTS */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <Card title="Income vs Kharcha" subtitle="6 mahine">
            {charts === null ? (
              <NoAccessNote />
            ) : (
              <>
                <div className="flex items-end gap-3 h-40">
                  {charts.incomeExpense6mo.map((m) => (
                    <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                      <div className="flex items-end gap-0.5 h-32 w-full justify-center">
                        <div className="w-2.5 bg-[var(--anc-green-2)] rounded-t-sm" style={{ height: `${Math.max(2, (m.income / maxMonthValue) * 100)}%` }} title={fmt(m.income)} />
                        <div className="w-2.5 bg-[var(--anc-gold)] rounded-t-sm" style={{ height: `${Math.max(2, (m.expense / maxMonthValue) * 100)}%` }} title={fmt(m.expense)} />
                      </div>
                      <span className="text-[10px] text-[var(--anc-muted)]">{m.month}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3.5 text-xs text-[var(--anc-muted)] mt-2">
                  <span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1 bg-[var(--anc-green-2)]" />Kul Income</span>
                  <span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1 bg-[var(--anc-gold)]" />Kharcha</span>
                </div>
              </>
            )}
          </Card>

          <Card title="Kharcha kahan gaya" subtitle={summary.meta.periodLabel} onTitleClick={charts !== null ? () => setDrilldownKey("exp") : undefined}>
            {charts === null ? (
              <NoAccessNote />
            ) : (
              <>
                {charts.expenseBreakdown.map((e) => (
                  <div key={e.account} className="grid grid-cols-[110px_1fr_90px] gap-2 items-center text-xs my-1.5">
                    <span className="truncate">{e.account}</span>
                    <span className="h-2.5 bg-[var(--anc-soft)] rounded-full overflow-hidden">
                      <span className="block h-full bg-[var(--anc-green-2)] rounded-full" style={{ width: `${Math.max(2, (e.amount / maxExpense) * 100)}%` }} />
                    </span>
                    <span className="text-right anc-num">{fmt(e.amount)}</span>
                  </div>
                ))}
                {charts.expenseBreakdown.length === 0 && <p className="text-sm text-[var(--anc-muted)]">Is period koi kharcha nahi</p>}
              </>
            )}
          </Card>

          <Card title="Receivable ageing" subtitle={summary.wasooliTotal !== null ? fmt(summary.wasooliTotal) : undefined} onTitleClick={wasooli !== null ? () => setDrilldownKey("rec") : undefined}>
            {charts === null ? (
              <NoAccessNote />
            ) : (
              <>
                <div className="flex h-5.5 rounded-md overflow-hidden my-1.5" style={{ height: "22px" }}>
                  {charts.receivableAgeing.filter((b) => b.amount > 0).map((b) => (
                    <span key={b.bucket} style={{ width: `${(b.amount / totalAgeing) * 100}%`, background: ageingColors[b.bucket] ?? "var(--anc-muted)" }} title={`${b.bucket}: ${fmt(b.amount)}`} />
                  ))}
                </div>
                <table className="w-full text-sm mt-2">
                  <tbody className="divide-y divide-[var(--anc-line)]">
                    {charts.receivableAgeing.map((b) => (
                      <tr key={b.bucket}>
                        <td className="py-1">
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: `color-mix(in srgb, ${ageingColors[b.bucket] ?? "var(--anc-muted)"} 18%, transparent)`, color: ageingColors[b.bucket] ?? "var(--anc-muted)" }}>
                            {b.bucket}
                          </span>
                        </td>
                        <td className="py-1 text-right anc-num">{fmt(b.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>
        </div>
      </div>

      <DrillDownDrawer dataset={drilldown} onClose={() => setDrilldownKey(null)} />
    </div>
  );
}

function TopList({
  title,
  subtitle,
  unit,
  rows,
  onOpen,
}: {
  title: string;
  subtitle: string;
  unit: string;
  rows: { partyId: string; name: string; count: number; amount: number }[];
  onOpen: () => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      <button type="button" onClick={onOpen} className="text-left">
        <h3 className="text-sm font-extrabold hover:underline">{title} ›</h3>
      </button>
      <p className="text-[11px] text-[var(--anc-muted)] mb-2">{subtitle}</p>
      <ol className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <li key={r.partyId} className="grid grid-cols-[20px_1fr_auto] gap-2 items-center text-xs">
            <span className={`w-5 h-5 rounded-md grid place-items-center font-extrabold text-[11px] ${i === 0 ? "bg-[var(--anc-gold)] text-black" : "bg-[var(--anc-soft)]"}`}>{i + 1}</span>
            <span className="min-w-0 flex flex-col gap-0.5">
              <Link href={`/parties/${r.partyId}/ledger`} className="text-[var(--anc-blue)] hover:underline truncate block">
                {r.name}
              </Link>
              <span className="block h-1 bg-[var(--anc-soft)] rounded-full overflow-hidden">
                <span className="block h-full bg-[var(--anc-green-2)]" style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
              </span>
            </span>
            <b className="anc-num whitespace-nowrap">{r.count} {unit}</b>
          </li>
        ))}
        {rows.length === 0 && <li className="text-[var(--anc-muted)]">Koi data nahi</li>}
      </ol>
    </div>
  );
}
