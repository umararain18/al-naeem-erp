import type { Prisma, PrismaClient, MarketingContactRole } from "@prisma/client";
import { toLocalMobile } from "../phone";

// ============================================================
// MARKETING CONTACT REFRESH ENGINE
//
// Mirrors lib/party-payment-fifo.ts's own "one shared rebuild function,
// full recompute from source documents every time, never incremental"
// philosophy - a Contact's own derived fields (role, revenue, bilty
// count, last vehicle, etc.) are NEVER incrementally patched, always
// fully recomputed from its current Bilty/Bill/Party rows.
//
// UNLIKE PaymentAllocation rows, a MarketingContact row is NEVER deleted
// by this engine (MarketingCampaignRecipient/MarketingLead cascade from
// it, and deleting would silently wipe real campaign/lead history) - a
// phone with zero remaining source documents keeps its row with
// `sourceless: true` instead (see aggregateContactFromDocuments below).
//
// Stored phone columns are never normalized at write time anywhere in
// this app (confirmed in lib/search-helpers.ts's own doc comment), so
// every phone-bearing column is normalized here, in memory, every time -
// never trusted as already-clean.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type BiltyDocForContact = {
  date: Date;
  roles: ("SENDER" | "RECEIVER")[]; // 1 or 2 - which side(s) THIS phone played on this one Bilty
  name: string;
  total: number;
  vehicle: string | null;
  city: string | null; // the location relevant to this phone's role (fromLocation if SENDER, toLocation if RECEIVER - fromLocation wins if both)
  route: string; // "<from> -> <to>"
};

export type BillDocForContact = {
  date: Date;
  name: string;
  total: number;
};

export type MatchedPartyForContact = {
  id: string;
  partyName: string;
  isBusinessRoleParty: boolean; // partyTypes includes TRANSPORTER or CLEARING_AGENT - this is what sets the PARTY role (and its default-exclusion), not a plain Customer/Vendor match
  isClearingAgent: boolean; // drives the CLEARING_AGENT_MATCH broker reason specifically
};

export interface ContactAggregateInput {
  bilties: BiltyDocForContact[];
  bills: BillDocForContact[];
  matchedParty: MatchedPartyForContact | null;
  /** Fallback "existed since" date when there are no documents at all, only a matched Party (e.g. the Party's own createdAt). */
  partyOnlyFallbackDate: Date | null;
}

export interface ContactAggregateResult {
  name: string;
  roles: MarketingContactRole[];
  aliases: string[];
  city: string | null;
  route: string | null;
  firstDate: Date;
  lastDate: Date;
  biltyCount: number;
  revenue: number;
  lastVehicle: string | null;
  linkedPartyId: string | null;
  isBroker: boolean;
  brokerReason: string | null;
  sourceless: boolean;
}

const EPOCH_FALLBACK = new Date(0);

/**
 * Pure aggregation core - given every document currently attributable to
 * one phone (or a merge-group of phones, already unioned by the caller),
 * returns the full set of derived Contact fields. No DB access.
 */
export function aggregateContactFromDocuments(input: ContactAggregateInput): ContactAggregateResult {
  const { bilties, bills, matchedParty } = input;

  if (bilties.length === 0 && bills.length === 0 && !matchedParty) {
    return {
      name: "",
      roles: [],
      aliases: [],
      city: null,
      route: null,
      firstDate: EPOCH_FALLBACK,
      lastDate: EPOCH_FALLBACK,
      biltyCount: 0,
      revenue: 0,
      lastVehicle: null,
      linkedPartyId: null,
      isBroker: false,
      brokerReason: null,
      sourceless: true,
    };
  }

  type NamedEvent = { date: Date; name: string };
  const events: NamedEvent[] = [
    ...bilties.map((b) => ({ date: b.date, name: b.name })),
    ...bills.map((b) => ({ date: b.date, name: b.name })),
  ];
  if (matchedParty && bilties.length === 0 && bills.length === 0) {
    // Party-only contact (no Bilty/Bill at all) - the Party's own name
    // is the only naming signal available; dated at the fallback date
    // (the Party's own createdAt) so a later real document would still
    // correctly outrank it as `name` on a future refresh.
    events.push({ date: input.partyOnlyFallbackDate ?? EPOCH_FALLBACK, name: matchedParty.partyName });
  }

  const roles = new Set<MarketingContactRole>();
  let revenue = 0;
  let lastVehicle: string | null = null;
  let city: string | null = null;
  let route: string | null = null;
  let latestDocDate: Date | null = null;

  for (const b of bilties) {
    for (const r of b.roles) roles.add(r);
    revenue += b.total;
    if (!latestDocDate || b.date >= latestDocDate) {
      latestDocDate = b.date;
      lastVehicle = b.vehicle;
      city = b.city;
      route = b.route;
    }
  }
  for (const b of bills) {
    roles.add("BILL_CLIENT");
    revenue += b.total;
    if (!latestDocDate || b.date >= latestDocDate) {
      latestDocDate = b.date;
      // Bills carry no location/vehicle data - a Bill becoming the
      // latest document deliberately leaves city/route/lastVehicle as
      // whatever the most recent BILTY had (never clears them to null
      // just because a Bill happened more recently).
    }
  }

  if (matchedParty?.isBusinessRoleParty) roles.add("PARTY");

  // Latest-dated name wins as the canonical `name`; every other distinct
  // (case/space-insensitive) name seen becomes an alias. Ties (same
  // date) keep whichever was encountered last in the input order -
  // callers should already pass documents in a stable, date-sorted order.
  const namesByKey = new Map<string, { display: string; date: Date }>();
  for (const e of events) {
    const key = e.name.trim().toLowerCase();
    if (!key) continue;
    const existing = namesByKey.get(key);
    if (!existing || e.date >= existing.date) {
      namesByKey.set(key, { display: e.name.trim(), date: e.date });
    }
  }
  let name = "";
  let nameDate: Date | null = null;
  const aliasCandidates: string[] = [];
  for (const entry of namesByKey.values()) {
    if (!nameDate || entry.date > nameDate) {
      if (name) aliasCandidates.push(name);
      name = entry.display;
      nameDate = entry.date;
    } else {
      aliasCandidates.push(entry.display);
    }
  }
  const distinctNameCount = namesByKey.size;

  let isBroker = false;
  let brokerReason: string | null = null;
  if (matchedParty?.isClearingAgent) {
    isBroker = true;
    brokerReason = "CLEARING_AGENT_MATCH";
  } else if (distinctNameCount > 5) {
    isBroker = true;
    brokerReason = "MANY_NAMES";
  }

  const dates = [...bilties.map((b) => b.date), ...bills.map((b) => b.date)];
  const firstDate = dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : input.partyOnlyFallbackDate ?? EPOCH_FALLBACK;
  const lastDate = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : input.partyOnlyFallbackDate ?? EPOCH_FALLBACK;

  return {
    name,
    roles: [...roles],
    aliases: aliasCandidates,
    city,
    route,
    firstDate,
    lastDate,
    biltyCount: bilties.length,
    revenue,
    lastVehicle,
    linkedPartyId: matchedParty?.id ?? null,
    isBroker,
    brokerReason,
    sourceless: false,
  };
}

// ------------------------------------------------------------
// Prisma-touching orchestration
// ------------------------------------------------------------

type PhoneIndex = {
  bilties: Map<string, BiltyDocForContact[]>;
  bills: Map<string, BillDocForContact[]>;
  parties: Map<string, MatchedPartyForContact & { createdAt: Date }>;
  allPhones: Set<string>;
};

async function buildPhoneDocumentIndex(tx: Tx): Promise<PhoneIndex> {
  const bilties = new Map<string, BiltyDocForContact[]>();
  const bills = new Map<string, BillDocForContact[]>();
  const parties = new Map<string, MatchedPartyForContact & { createdAt: Date }>();
  const allPhones = new Set<string>();

  function push(map: Map<string, BiltyDocForContact[]>, phone: string, doc: BiltyDocForContact) {
    allPhones.add(phone);
    const existing = map.get(phone);
    if (existing) existing.push(doc);
    else map.set(phone, [doc]);
  }

  const biltyRows = await tx.bilty.findMany({
    where: { isDeleted: false },
    select: {
      date: true,
      total: true,
      consignorPhone: true,
      consignorName: true,
      consigneePhone: true,
      consigneeName: true,
      registrationNumber: true,
      fromLocation: { select: { name: true } },
      toLocation: { select: { name: true } },
    },
  });

  for (const b of biltyRows) {
    const routeStr = `${b.fromLocation.name} -> ${b.toLocation.name}`;
    const senderPhone = toLocalMobile(b.consignorPhone);
    const receiverPhone = toLocalMobile(b.consigneePhone);
    const total = Number(b.total);

    if (senderPhone) {
      push(bilties, senderPhone, {
        date: b.date,
        roles: ["SENDER"],
        name: b.consignorName,
        total,
        vehicle: b.registrationNumber,
        city: b.fromLocation.name,
        route: routeStr,
      });
    }
    if (receiverPhone && receiverPhone !== senderPhone) {
      push(bilties, receiverPhone, {
        date: b.date,
        roles: ["RECEIVER"],
        name: b.consigneeName,
        total,
        vehicle: b.registrationNumber,
        city: b.toLocation.name,
        route: routeStr,
      });
    } else if (receiverPhone && receiverPhone === senderPhone) {
      // Same phone plays both roles on this one Bilty - fold into a
      // single document entry so biltyCount/revenue never double-counts.
      const list = bilties.get(senderPhone)!;
      const last = list[list.length - 1];
      last.roles.push("RECEIVER");
    }
  }

  const billRows = await tx.bill.findMany({
    where: { isDeleted: false },
    select: { date: true, clientPhone: true, clientName: true, items: { select: { rent: true, delivery: true, otherExpense: true } } },
  });
  for (const bill of billRows) {
    const phone = toLocalMobile(bill.clientPhone);
    if (!phone) continue;
    const total = bill.items.reduce((sum, item) => sum + Number(item.rent) + Number(item.delivery) + Number(item.otherExpense), 0);
    const existing = bills.get(phone);
    const doc: BillDocForContact = { date: bill.date, name: bill.clientName, total };
    if (existing) existing.push(doc);
    else bills.set(phone, [doc]);
    allPhones.add(phone);
  }

  const partyRows = await tx.party.findMany({
    select: { id: true, partyName: true, phone: true, whatsapp: true, partyTypes: true, createdAt: true },
  });
  for (const p of partyRows) {
    const isBusinessRoleParty = p.partyTypes.includes("TRANSPORTER") || p.partyTypes.includes("CLEARING_AGENT");
    const isClearingAgent = p.partyTypes.includes("CLEARING_AGENT");
    for (const raw of [p.phone, p.whatsapp]) {
      const phone = toLocalMobile(raw);
      if (!phone) continue;
      allPhones.add(phone);
      // First matching Party wins if more than one Party shares a phone
      // (rare) - never overwritten by a later one.
      if (!parties.has(phone)) {
        parties.set(phone, { id: p.id, partyName: p.partyName, isBusinessRoleParty, isClearingAgent, createdAt: p.createdAt });
      }
    }
  }

  // Keep every phone's own document list sorted by date so the pure
  // aggregator's "latest wins" / "tie keeps last-in-order" logic is
  // deterministic.
  for (const list of bilties.values()) list.sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const list of bills.values()) list.sort((a, b) => a.date.getTime() - b.date.getTime());

  return { bilties, bills, parties, allPhones };
}

export interface RefreshMarketingContactsOptions {
  /** Canonical 03XXXXXXXXX phones to refresh. Omit for a full rebuild (nightly/manual). */
  phones?: string[];
}

/**
 * The one Prisma-touching rebuild. Always UPSERTS by phone - never
 * deletes a MarketingContact row. A root contact's own aggregate unions
 * in every OTHER contact currently merged into it (`mergedIntoId`
 * pointing at this one); a merged-away contact's own row always reflects
 * only its own documents, so unmerging it later needs no special-case
 * recompute - the next refresh naturally "splits it back out" because
 * the root no longer unions it in.
 */
export async function refreshMarketingContacts(tx: Tx, options: RefreshMarketingContactsOptions = {}): Promise<void> {
  const index = await buildPhoneDocumentIndex(tx);

  let targetPhones: string[];
  if (options.phones && options.phones.length > 0) {
    targetPhones = [...new Set(options.phones)];
  } else {
    const existing = await tx.marketingContact.findMany({ select: { phone: true } });
    targetPhones = [...new Set([...index.allPhones, ...existing.map((c) => c.phone)])];
  }
  if (targetPhones.length === 0) return;

  // Merge links for every phone we might touch, PLUS anything merged
  // into one of them (so a root's union set is complete).
  const existingContacts = await tx.marketingContact.findMany({
    where: { OR: [{ phone: { in: targetPhones } }, { mergedIntoId: { not: null } }] },
    select: { id: true, phone: true, mergedIntoId: true },
  });
  const byPhone = new Map(existingContacts.map((c) => [c.phone, c]));
  const mergedInByRootId = new Map<string, string[]>(); // rootContactId -> merged-from phones
  for (const c of existingContacts) {
    if (c.mergedIntoId) {
      const list = mergedInByRootId.get(c.mergedIntoId) ?? [];
      list.push(c.phone);
      mergedInByRootId.set(c.mergedIntoId, list);
    }
  }

  for (const phone of targetPhones) {
    const existingRow = byPhone.get(phone);
    const isMergedAway = !!existingRow?.mergedIntoId;
    // NOTE: if `phone` is merged into a root that ISN'T itself in
    // targetPhones (only relevant on the narrow per-write fast path,
    // never on a full rebuild), that root's own row is not re-touched
    // here - the next nightly/manual full refresh always catches it,
    // matching this engine's "a missed per-write refresh is never
    // silently permanent" guarantee.

    const unionPhones = [phone];
    if (!isMergedAway && existingRow) {
      const mergedInPhones = mergedInByRootId.get(existingRow.id) ?? [];
      unionPhones.push(...mergedInPhones);
    }

    const bilties = unionPhones.flatMap((p) => index.bilties.get(p) ?? []);
    const bills = unionPhones.flatMap((p) => index.bills.get(p) ?? []);
    const matchedPartyRaw = index.parties.get(phone); // Party match is per-this-exact-phone, never unioned across a merge group
    const matchedParty = matchedPartyRaw
      ? { id: matchedPartyRaw.id, partyName: matchedPartyRaw.partyName, isBusinessRoleParty: matchedPartyRaw.isBusinessRoleParty, isClearingAgent: matchedPartyRaw.isClearingAgent }
      : null;

    const result = aggregateContactFromDocuments({
      bilties,
      bills,
      matchedParty,
      partyOnlyFallbackDate: matchedPartyRaw?.createdAt ?? null,
    });

    const data = {
      name: result.name || phone,
      roles: result.roles,
      aliases: result.aliases,
      city: result.city,
      route: result.route,
      firstDate: result.firstDate,
      lastDate: result.lastDate,
      biltyCount: result.biltyCount,
      revenue: result.revenue,
      lastVehicle: result.lastVehicle,
      linkedPartyId: result.linkedPartyId,
      isBroker: result.isBroker,
      brokerReason: result.brokerReason,
      sourceless: result.sourceless,
    };

    await tx.marketingContact.upsert({
      where: { phone },
      create: { phone, ...data },
      update: data,
    });
  }
}
