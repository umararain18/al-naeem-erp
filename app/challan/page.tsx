"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { formatBusinessDate } from "@/lib/date-range";
import { getSavedListFilters, saveListFilters, useListScrollRestore, useReturnToSuffix, withReturnTo, LIST_HIGHLIGHT_CLASS } from "@/components/useListScrollRestore";

const CHALLAN_LIST_KEY = "challan-list";
interface ChallanListFilters {
  search: string;
  statusFilter: string;
  financialFilter: string;
  dateFrom: string;
  dateTo: string;
}

// Shared sticky-header cell styling (see the table wrapper's own doc
// comment below for why `sticky top-0` only works correctly once the
// wrapper div is a real, bounded scroll container). Opaque bg + z-10
// keep scrolling rows from showing through; the inset box-shadow gives
// a visible bottom border without needing an extra element.
const challanHeaderCellClass = "sticky top-0 z-10 bg-gray-50 px-4 py-3 shadow-[0_1px_0_0_rgba(0,0,0,0.08)]";

type Bilty = {
  id: string;
  biltyNo: string;
  fromLocation: { id: string; name: string };
  toLocation: { id: string; name: string };
  consigneeName: string;
  vehicleType: string | null;
  vehicleModel: string | null;
  registrationNumber: string | null;
  total: number | null;
  toPay: number | null;
  clearingAgentParty: { id: string; partyName: string } | null;
};

type Transporter = {
  id: string;
  partyName: string;
};

// The raw shape GET /api/parties returns per party, narrowed to only
// the fields this file reads.
type RawPartyRecord = {
  id: string;
  partyName: string;
  partyTypes?: string[];
};

// GET /api/bilty returns every Bilty scalar field (no `select`
// narrowing it), so beyond this file's own local `Bilty` display
// type, `status`/`isDeleted` are also always present on each row.
type RawBiltySearchResult = Bilty & { status: string; isDeleted: boolean };

type ChallanStatus = "IN_TRANSIT" | "DELIVERED" | "CANCELLED";

type Challan = {
  id: string;
  challanNo: string;
  loadingDate: string;
  createdAt: string;
  status: ChallanStatus;
  transporterParty: { id: string; partyName: string } | null;
  driverName: string | null;
  driverPhone: string | null;
  carrierNumber: string | null;
  carrierRent: number | null;
  isSettled: boolean;
  bilties: {
    bilty: Bilty;
  }[];
  financials?: {
    receivable: number;
    payable: number;
    received: number;
    paid: number;
    remainingReceivable: number;
    remainingPayable: number;
    excessReceived: number;
    excessPaid: number;
    isCleared: boolean;
    status: "OPEN" | "PARTIALLY_CLEARED" | "CLEARED" | "OVERPAID";
  } | null;
  // Purely informational - who the receivable/payable totals above
  // belong to. Never used to recalculate an amount.
  responsibleParties?: {
    receivable: { accountId: string; partyId: string; partyName: string }[];
    payable: { accountId: string; partyId: string; partyName: string }[];
  };
  // Dimensionally-separated settlement summary (Bilty Rent / Paid /
  // To-Pay / Carrier Rent, never blended) - the same authoritative
  // source Final Settlement and the Challan Detail page use. See
  // lib/challan-settlement-summary.ts. Still used here ONLY for the
  // Rent column's Bilty Rent total (biltyRentTotal() below) - no
  // longer for any Receivable/Payable/Due classification.
  settlementSummary?: SettlementSummary | null;
  // ONE financial position for this Challan (lib/challan-position.ts)
  // - the single shared calculation this list's table, filter, and
  // summary cards, AND the Challan Detail page, all read.
  position?: ChallanPosition;
};

type ChallanPositionParty = {
  accountId: string | null;
  partyId: string | null;
  partyName: string;
};

type ChallanPositionLine = {
  direction: "RECEIVABLE" | "PAYABLE";
  amount: number;
  parties: ChallanPositionParty[];
};

type ChallanPositionBucket = "BEFORE_SETTLEMENT" | "RECEIVABLE" | "PAYABLE" | "RECEIVABLE_PAYABLE" | "CLEARED";

type ChallanPosition = {
  bucket: ChallanPositionBucket;
  lines: ChallanPositionLine[];
  totalReceivable: number;
  totalPayable: number;
};

type SettlementPayerBreakdown = {
  accountId: string;
  partyId: string | null;
  partyName: string;
  amount: number;
};

type ComponentSummaryUI = {
  total: number;
  paidOrReceived: number;
  remaining: number;
  payers: SettlementPayerBreakdown[];
  isHistoricalFallback: boolean;
  // Carrier Rent only: the economic residual claimant for the unpaid
  // remainder (see lib/challan-settlement-summary.ts). Present only
  // when remaining > 0 and safely resolved - never a guess.
  residualPartyName?: string;
};

type PartyNetEntryUI = {
  accountId: string;
  partyId: string | null;
  partyName: string;
  net: number;
  direction: "RECEIVABLE" | "PAYABLE";
};

type SettlementSummary = {
  challanId: string;
  bilties: {
    biltyId: string;
    biltyNo: string;
    rent: number;
    paidAmount: number;
    paidVerified: number;
    paidUnverified: number;
    paidResponsiblePartyName: string | null;
    paidIsInconsistent: boolean;
    toPay: ComponentSummaryUI;
  }[];
  carrierRent: ComponentSummaryUI;
  // Cross-component party net position(s) - NEVER Carrier Rent or
  // To-Pay due, never blended with either. See
  // lib/challan-settlement-summary.ts's own doc comment.
  partyNet: PartyNetEntryUI[];
};


// ============================================================
// ONE financial position per Challan - read ENTIRELY from
// challan.position (lib/challan-position.ts), the SAME shared
// calculation the summary cards below and the Challan Detail page
// also read. There is deliberately no separate, independently-
// derived status here any more: the previous version of this file
// derived its badge from challan.settlementSummary.partyNet while the
// summary cards summed challan.financials.remainingReceivable/
// remainingPayable - two different calculations that could (and did)
// disagree, e.g. the filter showing a Challan as "Due" while the
// cards showed Rs 0 for it. "DUE" no longer exists as a bucket:
// computeChallanPositionsBatch always resolves a settled Challan with
// a real remaining amount into RECEIVABLE/PAYABLE/RECEIVABLE_PAYABLE.
// ============================================================

function safePosition(challan: Challan): ChallanPosition {
  return challan.position || { bucket: challan.isSettled ? "CLEARED" : "BEFORE_SETTLEMENT", lines: [], totalReceivable: 0, totalPayable: 0 };
}

const positionChipStyles: Record<"RECEIVABLE" | "PAYABLE", string> = {
  RECEIVABLE: "bg-green-100 text-green-700",
  PAYABLE: "bg-red-100 text-red-700",
};

type FinancialFilter =
  | "ALL"
  | "BEFORE_SETTLEMENT"
  | "AFTER_SETTLEMENT"
  | "RECEIVABLE"
  | "PAYABLE"
  | "RECEIVABLE_PAYABLE"
  | "CLEARED";

function matchesFinancialFilter(challan: Challan, filter: FinancialFilter): boolean {
  if (filter === "ALL") return true;

  switch (filter) {
    case "BEFORE_SETTLEMENT":
      return !challan.isSettled;
    case "AFTER_SETTLEMENT":
      return challan.isSettled;
    case "RECEIVABLE":
      return safePosition(challan).bucket === "RECEIVABLE";
    case "PAYABLE":
      return safePosition(challan).bucket === "PAYABLE";
    case "RECEIVABLE_PAYABLE":
      return safePosition(challan).bucket === "RECEIVABLE_PAYABLE";
    case "CLEARED":
      return safePosition(challan).bucket === "CLEARED";
    default:
      return true;
  }
}

// Vehicle names only (never registration numbers), one per linked
// Bilty, comma-separated - never deduplicated and never collapsed
// into a "2 Vehicles" count, so "Alto, Rusi, Corolla" shows every
// Bilty's own vehicle exactly once. Vehicle Type is where the actual
// vehicle name is written (e.g. "Alto"/"Rusi"/"Corolla"); Vehicle
// Model (a year, on this Bilty form) is only a fallback for a Bilty
// that never had a Type entered.
function vehicleSummary(challan: Challan): string {
  const names = challan.bilties
    .map((cb) => cb.bilty.vehicleType || cb.bilty.vehicleModel || null)
    .filter((n): n is string => Boolean(n));

  if (names.length === 0) return "—";
  return names.join(", ");
}

// Clearing Agent from linked Bilty/Bilties - only shown as a
// single name when EVERY Bilty shares the same Clearing Agent.
function clearingAgentSummary(challan: Challan): string {
  const names = challan.bilties
    .map((cb) => cb.bilty.clearingAgentParty?.partyName)
    .filter((n): n is string => Boolean(n));

  if (names.length === 0) return "—";

  const unique = Array.from(new Set(names));
  if (unique.length === 1) return unique[0];

  return "Multiple";
}

// The single Clearing Agent's own Party id, when every linked Bilty
// shares the exact same one (never when "Multiple" applies - no single
// party to link to in that case).
function clearingAgentPartyId(challan: Challan): string | null {
  const ids = challan.bilties
    .map((cb) => cb.bilty.clearingAgentParty?.id)
    .filter((id): id is string => Boolean(id));
  const unique = Array.from(new Set(ids));
  return unique.length === 1 ? unique[0] : null;
}

// Clickable "107, 108" (both linked) / "107, 108 +2 more" (3+, only
// the shown ones are links) - never guesses an id, always the exact
// Bilty this Challan is actually linked to.
function BiltyLinks({ challan }: { challan: Challan }) {
  const returnToSuffix = useReturnToSuffix();
  const bilties = challan.bilties.map((cb) => cb.bilty);
  if (bilties.length === 0) return <>—</>;

  const shown = bilties.slice(0, 2);
  const rest = bilties.length - shown.length;

  return (
    <>
      {shown.map((b, i) => (
        <span key={b.id}>
          {i > 0 && ", "}
          <Link href={withReturnTo(`/bilty/${b.id}`, returnToSuffix)} className="text-blue-600 hover:underline">
            {b.biltyNo}
          </Link>
        </span>
      ))}
      {rest > 0 && ` +${rest} more`}
    </>
  );
}

// Authoritative per-Bilty rent, summed - reuses
// challan.settlementSummary.bilties[].rent (lib/challan-settlement-
// summary.ts) exactly, never independently recomputed from the raw
// Bilty rows.
function biltyRentTotal(challan: Challan): number {
  return (challan.settlementSummary?.bilties || []).reduce((s, b) => s + Number(b.rent || 0), 0);
}

// "ABC Motors" / "ABC Motors + Ali Clearing" (exactly 2, both
// clickable) / "ABC Motors + 2 more" (3+, only the first is clickable,
// "+N more" is plain text) - never nets unrelated parties into one
// balance, each name comes straight from settlementSummary.partyNet
// (lib/challan-settlement-summary.ts), split by its own `direction`,
// linked by its own partyId straight to that Party's own Ledger.
function PartyLinks({ parties }: { parties: { partyId: string | null; partyName: string }[] }) {
  if (parties.length === 0) return <>—</>;

  function nameNode(p: { partyId: string | null; partyName: string }, key: string) {
    return p.partyId ? (
      <Link key={key} href={`/parties/${p.partyId}/ledger`} className="hover:underline">
        {p.partyName}
      </Link>
    ) : (
      <span key={key}>{p.partyName}</span>
    );
  }

  if (parties.length === 1) return nameNode(parties[0], parties[0].partyId || parties[0].partyName);
  if (parties.length === 2) {
    return (
      <>
        {nameNode(parties[0], "a")} + {nameNode(parties[1], "b")}
      </>
    );
  }
  return (
    <>
      {nameNode(parties[0], "a")} + {parties.length - 1} more
    </>
  );
}

// "Receivable Rs X from <party>" (green) / "Payable Rs X to <party>"
// (red) / "Cleared" (grey) / "Before Settlement" (grey) - the ONE
// position chip, read straight from challan.position
// (lib/challan-position.ts), used identically in the table and the
// mobile card view below. Two lines (one per direction) only when
// the Challan genuinely has a different party on each side - never
// netted together (see lib/challan-position.ts's own doc comment).
function PositionCell({ challan }: { challan: Challan }) {
  const position = safePosition(challan);

  if (position.bucket === "BEFORE_SETTLEMENT") {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap bg-gray-100 text-gray-700">Before Settlement</span>;
  }
  if (position.lines.length === 0) {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap bg-gray-100 text-gray-700">Cleared</span>;
  }

  return (
    <div className="space-y-1.5">
      {position.lines.map((line) => (
        <div key={line.direction}>
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${positionChipStyles[line.direction]}`}>
            {line.direction === "RECEIVABLE" ? "Receivable" : "Payable"} Rs. {line.amount.toLocaleString()}
          </span>
          <p className="mt-0.5 text-xs text-gray-500">
            {line.parties.length > 0 ? (
              <>
                {line.direction === "RECEIVABLE" ? "from" : "to"} <PartyLinks parties={line.parties} />
              </>
            ) : (
              <span className="font-medium text-amber-600">Party not set</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

// Numeric-aware Challan No. comparator (ascending): "4002" sorts
// before "40010" (unlike plain string comparison, which would put
// "40010" first). Non-numeric challan numbers sort after numeric
// ones, alphabetically among themselves.
function compareChallanNo(a: Challan, b: Challan): number {
  const aNum = /^\d+$/.test(a.challanNo.trim());
  const bNum = /^\d+$/.test(b.challanNo.trim());

  if (aNum && bNum) {
    return parseInt(a.challanNo, 10) - parseInt(b.challanNo, 10);
  }
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.challanNo.localeCompare(b.challanNo);
}

// Newest-Challan-first list ordering. Primary key: Challan No.
// sequence, numeric-aware, descending - the actual identity of "which
// Challan is newer", never loadingDate (a user-editable, often-
// backdated business field - see app/api/challan/route.ts's matching
// server-side fix for the same reason) and never vehicle/updatedAt/
// unspecified order. Secondary tiebreak: createdAt descending, for
// the rare case of two Challans sharing a challanNo pattern.
function compareChallanNewestFirst(a: Challan, b: Challan): number {
  const noDiff = -compareChallanNo(a, b);
  if (noDiff !== 0) return noDiff;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export default function ChallanPage() {
  const router = useRouter();
  const returnToSuffix = useReturnToSuffix();
  const [challans, setChallans] = useState<Challan[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const savedChallanFilters = useMemo(() => getSavedListFilters<ChallanListFilters>(CHALLAN_LIST_KEY), []);

  const [search, setSearch] = useState(() => savedChallanFilters?.search ?? "");
  // A drill-down link (e.g. Dashboard's Challan status counts) may
  // deep-link straight to a filter via ?status=... / ?financial=...
  // Seeded from the URL on first mount, then kept in sync via the
  // useSearchParams()-driven effect below - a plain
  // window.location.search read (this app's usual pattern elsewhere)
  // only fires once per component instance and goes stale when
  // Next.js's client-side router reuses this SAME mounted page across
  // two different /challan?... navigations (e.g. Dashboard -> Challan
  // -> Dashboard -> a different Challan filter card), which is exactly
  // the "works after a manual refresh" bug this fixes. Manually
  // changing the dropdown below still works exactly as before - it
  // only touches this state, never the URL, so it can never fight with
  // the sync effect.
  const searchParams = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") || savedChallanFilters?.statusFilter || "ALL");
  const [financialFilter, setFinancialFilter] = useState<FinancialFilter>(
    () => (searchParams.get("financial") as FinancialFilter) || (savedChallanFilters?.financialFilter as FinancialFilter) || "ALL"
  );

  // Only an EXPLICIT status/financial query param overrides the current
  // filter (a fresh, intentional deep-link beats "where I was") - it no
  // longer force-resets to "ALL" merely because a plain /challan
  // navigation (e.g. Back to this list, see useListScrollRestore) has no
  // query string at all, which would otherwise silently undo a restored
  // filter a moment after mount.
  useEffect(() => {
    const urlStatus = searchParams.get("status");
    const urlFinancial = searchParams.get("financial");
    if (urlStatus) setStatusFilter(urlStatus);
    if (urlFinancial) setFinancialFilter(urlFinancial as FinancialFilter);
  }, [searchParams]);

  const [dateFrom, setDateFrom] = useState(() => savedChallanFilters?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(() => savedChallanFilters?.dateTo ?? "");

  const [showForm, setShowForm] = useState(false);

  const [challanNo, setChallanNo] = useState("");
  const [loadingDate, setLoadingDate] = useState("");
  const [transporterPartyId, setTransporterPartyId] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [carrierNumber, setCarrierNumber] = useState("");
  const [carrierRent, setCarrierRent] = useState("");
  const [remarks, setRemarks] = useState("");

  const [biltySearch, setBiltySearch] = useState("");
  const [selectedBilties, setSelectedBilties] = useState<Bilty[]>([]);
  const [allBilties, setAllBilties] = useState<Bilty[]>([]);
  const [loadingBilties, setLoadingBilties] = useState(false);
  const [transporters, setTransporters] = useState<Transporter[]>([]);
  const [loadingTransporters, setLoadingTransporters] = useState(false);

  const filteredChallans = useMemo(() => {
    const filtered = challans.filter((challan) => {
      if (statusFilter !== "ALL" && challan.status !== statusFilter) {
        return false;
      }

      if (!matchesFinancialFilter(challan, financialFilter)) {
        return false;
      }

      if (dateFrom) {
        const from = new Date(`${dateFrom}T00:00:00`);
        const challanDate = new Date(challan.loadingDate);
        if (challanDate < from) return false;
      }

      if (dateTo) {
        const to = new Date(`${dateTo}T00:00:00`);
        const challanDate = new Date(challan.loadingDate);
        if (challanDate >= to) return false;
      }

      if (!search.trim()) return true;

      const searchLower = search.toLowerCase();
      return (
        challan.challanNo.toLowerCase().includes(searchLower) ||
        challan.driverName?.toLowerCase().includes(searchLower) ||
        challan.driverPhone?.toLowerCase().includes(searchLower) ||
        challan.carrierNumber?.toLowerCase().includes(searchLower) ||
        challan.transporterParty?.partyName.toLowerCase().includes(searchLower) ||
        clearingAgentSummary(challan).toLowerCase().includes(searchLower) ||
        vehicleSummary(challan).toLowerCase().includes(searchLower) ||
        challan.bilties.some(
          (cb) =>
            cb.bilty.biltyNo.toLowerCase().includes(searchLower) ||
            cb.bilty.clearingAgentParty?.partyName.toLowerCase().includes(searchLower) ||
            [cb.bilty.vehicleType, cb.bilty.vehicleModel, cb.bilty.registrationNumber]
              .filter(Boolean)
              .join(" / ")
              .toLowerCase()
              .includes(searchLower)
        )
      );
    });

    return [...filtered].sort(compareChallanNewestFirst);
  }, [challans, search, statusFilter, financialFilter, dateFrom, dateTo]);

  // Sums challan.position's own totalReceivable/totalPayable (lib/
  // challan-position.ts) - the EXACT same per-Challan figures the
  // RECEIVABLE/PAYABLE filter options and the table's Position chips
  // read, so these cards can never show a different total than what
  // the filter/table agree on.
  const summary = useMemo(() => {
    let totalReceivable = 0;
    let totalPayable = 0;

    for (const challan of filteredChallans) {
      const position = safePosition(challan);
      totalReceivable += position.totalReceivable;
      totalPayable += position.totalPayable;
    }

    const net = totalReceivable - totalPayable;

    return { totalReceivable, totalPayable, net };
  }, [filteredChallans]);

  async function loadChallans() {
    try {
      setError("");
      // Real server-side filtering (Dashboard's "Active/Delivered/
      // Settled Challan" drill-down cards) - status/financial are sent
      // to GET /api/challan and applied there, never trusted to the
      // client-only filteredChallans re-check below (which stays, as a
      // harmless no-op once the server already filtered, and still
      // does the actual work for date range/free-text search).
      const query = new URLSearchParams();
      if (statusFilter !== "ALL") query.set("status", statusFilter);
      if (financialFilter !== "ALL") query.set("financial", financialFilter);
      // no-store: unlike every other list fetch here (next-number,
      // cancel, deliver, etc.) this one's URL is IDENTICAL across
      // visits whenever no filter is active (plain "/api/challan") -
      // exactly the case a bare Bin -> Restore -> back-to-list round
      // trip hits. Without no-store, the browser's own HTTP cache can
      // legitimately serve the pre-restore response for that
      // unchanged URL instead of refetching, since the server sends
      // no explicit Cache-Control header either way.
      const response = await fetch(`/api/challan${query.toString() ? `?${query.toString()}` : ""}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to load challans");
        return;
      }
      setChallans(data.items || []);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  async function loadTransporters() {
    try {
      setLoadingTransporters(true);
      const response = await fetch("/api/parties");
      const data = await response.json();
      if (!response.ok || !data.success) {
        return;
      }
      const transporterList = (data.parties || []).filter((party: RawPartyRecord) =>
        party.partyTypes?.includes("TRANSPORTER")
      );
      setTransporters(transporterList);
    } catch {
      // silent
    } finally {
      setLoadingTransporters(false);
    }
  }

  async function loadNextChallanNo() {
    try {
      const response = await fetch("/api/challan/next-number");
      const data = await response.json();
      if (response.ok && data.success && data.nextChallanNo) {
        setChallanNo(data.nextChallanNo);
      }
    } catch {
      // silent - Challan No. remains a free-text field either way
    }
  }

  async function searchBilties() {
    if (!biltySearch.trim()) return;
    try {
      setLoadingBilties(true);
      const response = await fetch(`/api/bilty?search=${encodeURIComponent(biltySearch.trim())}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to search bilties");
        return;
      }
      const pendingBilties = (data.bilties || []).filter(
        (b: RawBiltySearchResult) => b.status === "PENDING" && !b.isDeleted
      );
      setAllBilties(pendingBilties);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoadingBilties(false);
    }
  }

  useEffect(() => {
    loadTransporters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadChallans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, financialFilter]);

  // Persist filters/search whenever any of them change, so a Back
  // navigation to this list (see useListScrollRestore) restores the
  // exact same view, not a reset one.
  useEffect(() => {
    saveListFilters(CHALLAN_LIST_KEY, { search, statusFilter, financialFilter, dateFrom, dateTo });
  }, [search, statusFilter, financialFilter, dateFrom, dateTo]);

  const { highlightId, onOpenRecord } = useListScrollRestore(CHALLAN_LIST_KEY, !loading);

  function resetForm() {
    setChallanNo("");
    setLoadingDate("");
    setTransporterPartyId("");
    setDriverName("");
    setDriverPhone("");
    setCarrierNumber("");
    setCarrierRent("");
    setRemarks("");
    setSelectedBilties([]);
    setBiltySearch("");
    setAllBilties([]);
  }

  function addBilty(bilty: Bilty) {
    if (selectedBilties.find((b) => b.id === bilty.id)) return;
    setSelectedBilties([...selectedBilties, bilty]);
    setBiltySearch("");
    setAllBilties([]);
  }

  function removeBilty(biltyId: string) {
    setSelectedBilties(selectedBilties.filter((b) => b.id !== biltyId));
  }

  async function handleCreateChallan(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setCreating(true);

    try {
      const response = await fetch("/api/challan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challanNo,
          loadingDate,
          transporterPartyId: transporterPartyId || undefined,
          driverName: driverName || undefined,
          driverPhone: driverPhone || undefined,
          carrierNumber: carrierNumber || undefined,
          carrierRent: carrierRent === "" ? 0 : Number(carrierRent),
          remarks: remarks || undefined,
          biltyIds: selectedBilties.map((b) => b.id),
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to create challan");
        return;
      }

      setMessage("Challan created successfully.");
      resetForm();
      setShowForm(false);
      await loadChallans();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Challan</h1>
          <p className="text-gray-600">Manage challans and shipments.</p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">Remaining Receivable</p>
            <p className="text-2xl font-bold mt-1">
              Rs. {summary.totalReceivable.toLocaleString()}
            </p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">Remaining Payable</p>
            <p className="text-2xl font-bold mt-1">
              Rs. {summary.totalPayable.toLocaleString()}
            </p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">Net Position</p>
            <p className={`text-2xl font-bold mt-1 ${summary.net >= 0 ? "text-green-600" : "text-red-600"}`}>
              Rs. {summary.net.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              <option value="ALL">All Statuses</option>
              <option value="IN_TRANSIT">In Transit</option>
              <option value="DELIVERED">Delivered</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
            <select
              value={financialFilter}
              onChange={(e) => setFinancialFilter(e.target.value as FinancialFilter)}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              <option value="ALL">All Financial</option>
              <option value="BEFORE_SETTLEMENT">Before Settlement</option>
              <option value="AFTER_SETTLEMENT">After Settlement</option>
              <option value="RECEIVABLE">Receivable</option>
              <option value="PAYABLE">Payable</option>
              <option value="RECEIVABLE_PAYABLE">Receivable + Payable</option>
              <option value="CLEARED">Financially Cleared</option>
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
            <input
              type="text"
              placeholder="Search challan, bilty, vehicle, agent..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm md:col-span-2"
            />
          </div>
        </div>

        {/* Create Form */}
        {showForm && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">New Challan</h2>
            <form onSubmit={handleCreateChallan} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Challan No *</label>
                  <input
                    type="text"
                    value={challanNo}
                    onChange={(e) => setChallanNo(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Loading Date *</label>
                  <input
                    type="date"
                    value={loadingDate}
                    onChange={(e) => setLoadingDate(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Transporter</label>
                  <select
                    value={transporterPartyId}
                    onChange={(e) => setTransporterPartyId(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                    disabled={loadingTransporters}
                  >
                    <option value="">Select Transporter</option>
                    {transporters.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.partyName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Carrier Rent</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={carrierRent}
                    onChange={(e) => setCarrierRent(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Driver Name</label>
                  <input
                    type="text"
                    value={driverName}
                    onChange={(e) => setDriverName(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Driver Phone</label>
                  <input
                    type="text"
                    value={driverPhone}
                    onChange={(e) => setDriverPhone(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Carrier Number</label>
                  <input
                    type="text"
                    value={carrierNumber}
                    onChange={(e) => setCarrierNumber(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium mb-1">Remarks</label>
                  <textarea
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    rows={2}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
              </div>

              {/* Bilties Section */}
              <div className="border-t pt-4">
                <h3 className="font-medium mb-2">Bilties</h3>
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    placeholder="Search bilty no, consignee..."
                    value={biltySearch}
                    onChange={(e) => setBiltySearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchBilties()}
                    className="flex-1 border rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={searchBilties}
                    disabled={loadingBilties}
                    className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                  >
                    Search
                  </button>
                </div>

                {allBilties.length > 0 && (
                  <div className="border rounded-lg max-h-48 overflow-y-auto mb-3">
                    {allBilties.map((bilty) => (
                      <div
                        key={bilty.id}
                        className="flex items-center justify-between p-2 border-b last:border-b-0 hover:bg-gray-50"
                      >
                        <div className="flex-1">
                          <div className="font-medium text-sm">{bilty.biltyNo}</div>
                          <div className="text-xs text-gray-500">
                            {bilty.fromLocation.name} → {bilty.toLocation.name}
                          </div>
                          <div className="text-xs text-gray-500">
                            Clearing Agent: {bilty.clearingAgentParty?.partyName || "Not Assigned"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => addBilty(bilty)}
                          className="text-xs bg-blue-600 text-white px-2 py-1 rounded"
                        >
                          Add
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {selectedBilties.length > 0 && (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left">Bilty No</th>
                          <th className="px-3 py-2 text-left">Route</th>
                          <th className="px-3 py-2 text-left">Consignee</th>
                          <th className="px-3 py-2 text-left">Vehicle</th>
                          <th className="px-3 py-2 text-left">Clearing Agent</th>
                          <th className="px-3 py-2 text-left">To Pay</th>
                          <th className="px-3 py-2 text-left">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedBilties.map((bilty) => (
                          <tr key={bilty.id} className="border-t">
                            <td className="px-3 py-2 font-medium">{bilty.biltyNo}</td>
                            <td className="px-3 py-2">
                              {bilty.fromLocation.name} → {bilty.toLocation.name}
                            </td>
                            <td className="px-3 py-2">{bilty.consigneeName}</td>
                            <td className="px-3 py-2">
                              {[bilty.vehicleType, bilty.vehicleModel, bilty.registrationNumber].filter(Boolean).join(" / ") || "—"}
                            </td>
                            <td className="px-3 py-2">
                              {bilty.clearingAgentParty?.partyName || "Not Assigned"}
                            </td>
                            <td className="px-3 py-2">Rs. {Number(bilty.toPay || 0).toLocaleString()}</td>
                            <td className="px-3 py-2">
                              <div className="flex gap-2">
                                <Link
                                  href={withReturnTo(`/bilty/${bilty.id}`, returnToSuffix)}
                                  className="text-xs border rounded px-2 py-1 hover:bg-gray-50"
                                >
                                  View
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => removeBilty(bilty.id)}
                                  className="text-xs text-red-600 hover:underline"
                                >
                                  Remove
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
              {message && <p className="text-sm text-green-600">{message}</p>}

              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={creating}
                  className="bg-black text-white px-6 py-2 rounded-lg disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create Challan"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    resetForm();
                  }}
                  className="border px-6 py-2 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Actions */}
        {!showForm && (
          <div className="mb-4">
            <button
              onClick={() => {
                setShowForm(true);
                loadNextChallanNo();
              }}
              className="bg-black text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-800"
            >
              New Challan
            </button>
          </div>
        )}

        {/* Error/Message */}
        {(error || message) && (
          <div
            className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
              error
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {error || message}
          </div>
        )}

      </div>

      {/* List - full width next to the sidebar (not constrained to
          the max-w-7xl container above, which the top area - title/
          cards/filters/New Challan - keeps exactly as before), 16-24px
          side padding, no horizontal scroll needed at 1366px since this
          is only 7 columns. */}
      <div className="px-4 sm:px-6 pb-6">
        {/* No overflow-hidden here (or on the table wrapper below) -
            either one would make this element the nearest "scroll
            container" ancestor for the header's sticky positioning,
            which only ever stays visually stuck while THIS element's
            own (never-actually-scrolled) internal scroll position
            changes - never while the page itself scrolls past it.
            Only the page scrolls now; the header stays sticky to the
            page's own viewport instead. */}
        <div className="bg-white rounded-xl shadow-sm">
          {loading ? (
            <div className="p-10 text-center text-gray-500">Loading challans...</div>
          ) : filteredChallans.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              {search || statusFilter !== "ALL" || financialFilter !== "ALL" || dateFrom || dateTo
                ? "No matching challans found."
                : "No challans found."}
            </div>
          ) : (
            <>
              {/* Desktop/tablet table, 768px and up - 7 columns, two-line
                  cells. The whole row is clickable (navigates to the
                  Challan detail page, carrying returnTo + the existing
                  scroll-restore record-open); a cell with its own nested
                  link (Bilty, Clearing Agent, Transporter, Position's
                  party) stops that click from also bubbling into the
                  row's own navigation. */}
              <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className={challanHeaderCellClass}>Challan</th>
                      <th className={challanHeaderCellClass}>Bilty / Vehicle</th>
                      <th className={challanHeaderCellClass}>Clearing Agent</th>
                      <th className={challanHeaderCellClass}>Transporter</th>
                      <th className={`${challanHeaderCellClass} text-right`}>Rent</th>
                      <th className={challanHeaderCellClass}>Position</th>
                      <th className={challanHeaderCellClass}></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredChallans.map((challan) => {
                      const clearingAgentId = clearingAgentPartyId(challan);
                      return (
                        <tr
                          key={challan.id}
                          onClick={() => {
                            onOpenRecord(challan.id);
                            router.push(withReturnTo(`/challan/${challan.id}`, returnToSuffix));
                          }}
                          className={`cursor-pointer hover:bg-gray-50 ${highlightId === challan.id ? LIST_HIGHLIGHT_CLASS : ""}`}
                        >
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <p className="font-semibold text-gray-900">{challan.challanNo}</p>
                            <p className="text-xs text-gray-500">{formatBusinessDate(challan.loadingDate)}</p>
                          </td>
                          <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                            <p><BiltyLinks challan={challan} /></p>
                            <p className="text-xs text-gray-500">{vehicleSummary(challan)}</p>
                          </td>
                          <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                            {clearingAgentId ? (
                              <Link href={`/parties/${clearingAgentId}/ledger`} className="text-blue-600 hover:underline">
                                {clearingAgentSummary(challan)}
                              </Link>
                            ) : (
                              clearingAgentSummary(challan)
                            )}
                          </td>
                          <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                            <p>
                              {challan.transporterParty ? (
                                <Link href={`/parties/${challan.transporterParty.id}/ledger`} className="text-blue-600 hover:underline">
                                  {challan.transporterParty.partyName}
                                </Link>
                              ) : (
                                "—"
                              )}
                            </p>
                            <p className="text-xs text-gray-500">{challan.carrierNumber || "—"}</p>
                          </td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <p>Rs. {biltyRentTotal(challan).toLocaleString()}</p>
                            <p className="text-xs text-gray-500">Carrier Rs. {Number(challan.carrierRent || 0).toLocaleString()}</p>
                          </td>
                          <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                            <PositionCell challan={challan} />
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-300">›</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards, below 768px - one card per Challan,
                  replacing the table entirely (same whole-card-clickable
                  + nested-link-stopPropagation pattern as the table). */}
              <div className="md:hidden divide-y">
                {filteredChallans.map((challan) => {
                  const clearingAgentId = clearingAgentPartyId(challan);
                  return (
                    <div
                      key={challan.id}
                      onClick={() => {
                        onOpenRecord(challan.id);
                        router.push(withReturnTo(`/challan/${challan.id}`, returnToSuffix));
                      }}
                      className={`p-4 cursor-pointer active:bg-gray-100 ${highlightId === challan.id ? LIST_HIGHLIGHT_CLASS : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-gray-900">{challan.challanNo}</p>
                          <p className="text-xs text-gray-500">{formatBusinessDate(challan.loadingDate)}</p>
                        </div>
                        <span className="text-gray-300">›</span>
                      </div>
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        <p className="text-sm"><BiltyLinks challan={challan} /></p>
                        <p className="text-xs text-gray-500">{vehicleSummary(challan)}</p>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm" onClick={(e) => e.stopPropagation()}>
                        <div>
                          <p className="text-xs text-gray-500">Clearing Agent</p>
                          <p>
                            {clearingAgentId ? (
                              <Link href={`/parties/${clearingAgentId}/ledger`} className="text-blue-600 hover:underline">
                                {clearingAgentSummary(challan)}
                              </Link>
                            ) : (
                              clearingAgentSummary(challan)
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500">Transporter</p>
                          <p>
                            {challan.transporterParty ? (
                              <Link href={`/parties/${challan.transporterParty.id}/ledger`} className="text-blue-600 hover:underline">
                                {challan.transporterParty.partyName}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </p>
                          <p className="text-xs text-gray-500">{challan.carrierNumber || "—"}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex items-end justify-between gap-2">
                        <div className="text-sm">
                          <p>Rs. {biltyRentTotal(challan).toLocaleString()}</p>
                          <p className="text-xs text-gray-500">Carrier Rs. {Number(challan.carrierRent || 0).toLocaleString()}</p>
                        </div>
                        <div onClick={(e) => e.stopPropagation()}>
                          <PositionCell challan={challan} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
