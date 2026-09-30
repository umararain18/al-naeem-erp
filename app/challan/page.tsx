"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

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
  // lib/challan-settlement-summary.ts.
  settlementSummary?: SettlementSummary | null;
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

type EngineFinancials = {
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
};

function safeFinancials(challan: Challan | null | undefined): EngineFinancials {
  const f = challan?.financials;
  return {
    receivable: Number(f?.receivable || 0),
    payable: Number(f?.payable || 0),
    received: Number(f?.received || 0),
    paid: Number(f?.paid || 0),
    remainingReceivable: Number(f?.remainingReceivable || 0),
    remainingPayable: Number(f?.remainingPayable || 0),
    excessReceived: Number(f?.excessReceived || 0),
    excessPaid: Number(f?.excessPaid || 0),
    isCleared: Boolean(f?.isCleared),
    status: (f?.status || "OPEN") as EngineFinancials["status"],
  };
}

// ============================================================
// Compact Financial Status label - derived ENTIRELY from
// challan.settlementSummary (lib/challan-settlement-summary.ts), the
// same dimensionally-separated source the Financial Summary and
// expanded SettlementDetails already use, via totalDueFromSummary()
// below. This is deliberately a single aggregate "how much is still
// outstanding across every component/party on this Challan" figure -
// it is NEVER presented as one party's Receivable or Payable amount
// (see totalDueFromSummary()'s own comment for why that distinction
// would be misleading once Collection and Carrier Rent can each be
// owed by/to different parties on the same Challan).
// ============================================================

// Sum of every component's still-outstanding amount for this
// Challan (To-Pay remaining across all Bilties + Carrier Rent
// remaining) - a neutral "Total Due" figure. Deliberately NOT the
// old blended outstandingReceivable/outstandingPayable split: that
// split implies a single direction/party per Challan, which no
// longer holds once Collection and Carrier Rent can each be owed by
// or to a DIFFERENT party on the very same Challan (e.g. a Clearing
// Agent still owes To-Pay while the Transporter is separately owed
// the Carrier Rent remainder) - summing the two into one signed
// number would silently misrepresent who owes what to whom.
function totalDueFromSummary(challan: Challan): number {
  const summary = challan.settlementSummary;
  if (!summary) return 0;
  const toPayRemaining = summary.bilties.reduce((s, b) => s + b.toPay.remaining, 0);
  return toPayRemaining + summary.carrierRent.remaining;
}

// Status is driven by the cross-component PARTY NET (challan.
// settlementSummary.partyNet), per the approved locked prototype -
// NOT by component remaining amounts. A Challan can have To-Pay
// remaining=0 AND Carrier Rent remaining=0 and still be RECEIVABLE
// (a party collected more than they paid out) or PAYABLE (the
// reverse) - see lib/challan-settlement-summary.ts's own doc comment
// on partyNet for why. "DUE" is a fallback for the (rare) case where
// some component still has a real remaining amount but no party has
// been resolved to hold it yet - never silently reported as CLEARED.
type CompactStatus = "BEFORE SETTLEMENT" | "RECEIVABLE" | "PAYABLE" | "RECEIVABLE + PAYABLE" | "DUE" | "CLEARED";

function compactStatus(challan: Challan): CompactStatus {
  if (!challan.isSettled) return "BEFORE SETTLEMENT";

  const partyNet = challan.settlementSummary?.partyNet || [];
  const hasReceivable = partyNet.some((p) => p.net > 0);
  const hasPayable = partyNet.some((p) => p.net < 0);

  if (hasReceivable && hasPayable) return "RECEIVABLE + PAYABLE";
  if (hasReceivable) return "RECEIVABLE";
  if (hasPayable) return "PAYABLE";

  // No non-zero party net anywhere - CLEARED only if every component
  // balance is also actually zero, never assumed.
  return totalDueFromSummary(challan) > 0.009 ? "DUE" : "CLEARED";
}

const compactStatusStyles: Record<CompactStatus, string> = {
  "BEFORE SETTLEMENT": "bg-gray-100 text-gray-700",
  RECEIVABLE: "bg-blue-100 text-blue-700",
  PAYABLE: "bg-purple-100 text-purple-700",
  "RECEIVABLE + PAYABLE": "bg-indigo-100 text-indigo-700",
  DUE: "bg-amber-100 text-amber-700",
  CLEARED: "bg-green-100 text-green-700",
};

type FinancialFilter =
  | "ALL"
  | "BEFORE_SETTLEMENT"
  | "AFTER_SETTLEMENT"
  | "RECEIVABLE"
  | "PAYABLE"
  | "RECEIVABLE_PAYABLE"
  | "DUE"
  | "CLEARED";

function matchesFinancialFilter(challan: Challan, filter: FinancialFilter): boolean {
  if (filter === "ALL") return true;

  switch (filter) {
    case "BEFORE_SETTLEMENT":
      return !challan.isSettled;
    case "AFTER_SETTLEMENT":
      return challan.isSettled;
    case "RECEIVABLE":
      return compactStatus(challan) === "RECEIVABLE";
    case "PAYABLE":
      return compactStatus(challan) === "PAYABLE";
    case "RECEIVABLE_PAYABLE":
      return compactStatus(challan) === "RECEIVABLE + PAYABLE";
    case "DUE":
      return compactStatus(challan) === "DUE";
    case "CLEARED":
      return compactStatus(challan) === "CLEARED";
    default:
      return true;
  }
}

// Vehicle info from linked Bilty/Bilties, compacted for the list.
function vehicleSummary(challan: Challan): string {
  const descriptors = challan.bilties
    .map((cb) =>
      [cb.bilty.vehicleType, cb.bilty.vehicleModel, cb.bilty.registrationNumber]
        .filter(Boolean)
        .join(" / ")
    )
    .filter((d) => d.length > 0);

  if (descriptors.length === 0) return "—";

  const unique = Array.from(new Set(descriptors));
  if (unique.length === 1) return unique[0];

  return `${challan.bilties.length} Vehicles`;
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
  const bilties = challan.bilties.map((cb) => cb.bilty);
  if (bilties.length === 0) return <>—</>;

  const shown = bilties.slice(0, 2);
  const rest = bilties.length - shown.length;

  return (
    <>
      {shown.map((b, i) => (
        <span key={b.id}>
          {i > 0 && ", "}
          <Link href={`/bilty/${b.id}`} className="text-blue-600 hover:underline">
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
  const [challans, setChallans] = useState<Challan[]>([]);
  const [capabilities, setCapabilities] = useState({ canBin: false });
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");
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
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") || "ALL");
  const [financialFilter, setFinancialFilter] = useState<FinancialFilter>(() => (searchParams.get("financial") as FinancialFilter) || "ALL");

  useEffect(() => {
    setStatusFilter(searchParams.get("status") || "ALL");
    setFinancialFilter((searchParams.get("financial") as FinancialFilter) || "ALL");
  }, [searchParams]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

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

  const summary = useMemo(() => {
    let totalReceivable = 0;
    let totalPayable = 0;

    for (const challan of filteredChallans) {
      const fin = safeFinancials(challan);
      totalReceivable += fin.remainingReceivable;
      totalPayable += fin.remainingPayable;
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
      const response = await fetch(`/api/challan${query.toString() ? `?${query.toString()}` : ""}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to load challans");
        return;
      }
      setChallans(data.items || []);
      setCapabilities(data.capabilities || { canBin: false });
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

  async function cancelChallan(challan: Challan) {
    const confirmed = window.confirm(
      `Are you sure you want to cancel challan ${challan.challanNo}?`
    );
    if (!confirmed) return;

    setActionLoading(challan.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/challan/${challan.id}/cancel`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to cancel challan");
        return;
      }
      setMessage("Challan cancelled successfully.");
      await loadChallans();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  async function deliverChallan(challan: Challan) {
    const confirmed = window.confirm(
      `Mark challan ${challan.challanNo} as delivered?`
    );
    if (!confirmed) return;

    setActionLoading(challan.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/challan/${challan.id}/deliver`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to deliver challan");
        return;
      }
      setMessage("Challan delivered successfully.");
      await loadChallans();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  async function deleteChallan(challan: Challan) {
    const confirmed = window.confirm(
      `Are you sure you want to move challan ${challan.challanNo} to Bin?`
    );
    if (!confirmed) return;

    setActionLoading(challan.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/challan/${challan.id}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Unable to delete challan");
        return;
      }
      setMessage(data.message || "Challan moved to Bin successfully.");
      await loadChallans();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
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
              <option value="DUE">Due</option>
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
                                  href={`/bilty/${bilty.id}`}
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

        {/* List */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-gray-500">Loading challans...</div>
          ) : filteredChallans.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              {search || statusFilter !== "ALL" || financialFilter !== "ALL" || dateFrom || dateTo
                ? "No matching challans found."
                : "No challans found."}
            </div>
          ) : (
            // Compact, scannable list (Private Phonch's own list as the UX
            // reference) - one flat row per Challan, no per-row expandable
            // sub-table. The full Financial Details / per-Bilty breakdown
            // this used to show inline remains fully available on the
            // Challan detail page's own "Settlement Breakdown"/"Bilties"
            // sections - nothing here was removed, only moved one click
            // away.
            // ROOT CAUSE of the previous attempt's failure: `sticky top-0`
            // on the <th> was never actually broken by itself, but its
            // positioning ancestor was wrong. The wrapping div only had
            // `overflow-x-auto` with no `overflow-y`/height of its own -
            // per the CSS overflow spec, a non-`visible` overflow-x on an
            // element whose overflow-y is otherwise `visible` bumps that
            // axis's COMPUTED value to `auto` too, so this div silently
            // became a "scroll container" for sticky-positioning purposes
            // even though it never actually clips/scrolls anything itself
            // (it has no bounded height - it just grows to fit the whole
            // table). Because sticky elements stick relative to their
            // NEAREST scroll-container ancestor, and that ancestor here
            // never scrolls, the header had nowhere real to "stick" -
            // it just flowed away with the rest of the table as the page
            // scrolled. `app/layout.tsx`'s <main> was never reached, and
            // never mattered either way.
            //
            // FIX: make this div the genuine, explicit, BOUNDED scroll
            // container for the table (both axes) - the standard "frozen
            // header" data-table pattern. `max-h-[70vh]` + `overflow-auto`
            // give it a real, definite height smaller than its content, so
            // it actually scrolls itself, and `sticky top-0` on each <th>
            // now sticks to a real thing. Horizontal scroll keeps working
            // exactly as before (still the same `overflow-auto` axis);
            // header/body columns stay aligned since both are cells of the
            // one <table>. This nested scroll region is intentional, not a
            // "double scrollbar" bug - the page still scrolls normally to
            // reveal the table section; the table's OWN rows then scroll
            // within their own bounded box, same as any spreadsheet-style
            // widget.
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className={challanHeaderCellClass}>Date</th>
                    <th className={challanHeaderCellClass}>Challan No.</th>
                    <th className={challanHeaderCellClass}>Bilty No.</th>
                    <th className={challanHeaderCellClass}>Vehicle</th>
                    <th className={challanHeaderCellClass}>Clearing Agent</th>
                    <th className={challanHeaderCellClass}>Transporter</th>
                    <th className={challanHeaderCellClass}>Carrier No.</th>
                    <th className={`${challanHeaderCellClass} text-right`}>Bilty Rent</th>
                    <th className={`${challanHeaderCellClass} text-right`}>Carrier Rent</th>
                    <th className={`${challanHeaderCellClass} text-right`}>Received</th>
                    <th className={`${challanHeaderCellClass} text-right`}>Receivable</th>
                    <th className={`${challanHeaderCellClass} text-right`}>Payable</th>
                    <th className={challanHeaderCellClass}>Receivable/Payable Parties</th>
                    <th className={challanHeaderCellClass}>Details</th>
                    <th className={challanHeaderCellClass}>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredChallans.map((challan) => {
                    const status = compactStatus(challan);
                    const fin = safeFinancials(challan);
                    const partyNet = challan.settlementSummary?.partyNet || [];
                    const receivableParties = partyNet.filter((p) => p.direction === "RECEIVABLE").map((p) => ({ partyId: p.partyId, partyName: p.partyName }));
                    const payableParties = partyNet.filter((p) => p.direction === "PAYABLE").map((p) => ({ partyId: p.partyId, partyName: p.partyName }));
                    const clearingAgentId = clearingAgentPartyId(challan);

                    return (
                      <tr key={challan.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          {new Date(challan.loadingDate).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <Link href={`/challan/${challan.id}`} className="font-medium text-blue-600 hover:underline">
                            {challan.challanNo}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <BiltyLinks challan={challan} />
                        </td>
                        <td className="px-4 py-3">{vehicleSummary(challan)}</td>
                        <td className="px-4 py-3">
                          {clearingAgentId ? (
                            <Link href={`/parties/${clearingAgentId}/ledger`} className="text-blue-600 hover:underline">
                              {clearingAgentSummary(challan)}
                            </Link>
                          ) : (
                            clearingAgentSummary(challan)
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {challan.transporterParty ? (
                            <Link href={`/parties/${challan.transporterParty.id}/ledger`} className="text-blue-600 hover:underline">
                              {challan.transporterParty.partyName}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3">{challan.carrierNumber || "—"}</td>
                        <td className="px-4 py-3 text-right">
                          Rs. {biltyRentTotal(challan).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          Rs. {Number(challan.carrierRent || 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right">Rs. {fin.received.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right">
                          {fin.remainingReceivable > 0.009 ? `Rs. ${fin.remainingReceivable.toLocaleString()}` : "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {fin.remainingPayable > 0.009 ? `Rs. ${fin.remainingPayable.toLocaleString()}` : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="space-y-0.5">
                            {receivableParties.length > 0 && (
                              <div className="text-blue-700">
                                Receivable: <PartyLinks parties={receivableParties} />
                              </div>
                            )}
                            {payableParties.length > 0 && (
                              <div className="text-purple-700">
                                Payable: <PartyLinks parties={payableParties} />
                              </div>
                            )}
                            {receivableParties.length === 0 && payableParties.length === 0 && (
                              <span className="text-gray-400">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={`/challan/${challan.id}`}
                              className="border rounded-lg px-3 py-1 text-xs hover:bg-gray-50"
                            >
                              View
                            </Link>
                            {challan.status === "IN_TRANSIT" && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => deliverChallan(challan)}
                                  disabled={actionLoading === challan.id}
                                  className="border rounded-lg px-3 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                                >
                                  Deliver
                                </button>
                                <button
                                  type="button"
                                  onClick={() => cancelChallan(challan)}
                                  disabled={actionLoading === challan.id}
                                  className="border border-red-300 text-red-600 rounded-lg px-3 py-1 text-xs hover:bg-red-50 disabled:opacity-50"
                                >
                                  Cancel
                                </button>
                              </>
                            )}
                            {challan.status === "DELIVERED" && !challan.isSettled && (
                              <Link
                                href={`/challan/${challan.id}`}
                                className="bg-green-600 text-white rounded-lg px-3 py-1 text-xs hover:bg-green-700"
                              >
                                Settle
                              </Link>
                            )}
                            {capabilities.canBin && (
                              <button
                                type="button"
                                disabled={actionLoading === challan.id}
                                onClick={() => deleteChallan(challan)}
                                className="border border-red-300 text-red-600 rounded-lg px-3 py-1 text-xs hover:bg-red-50 disabled:opacity-50"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${compactStatusStyles[status]}`}
                          >
                            {status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
