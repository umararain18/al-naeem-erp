import type { MarketingContactRole } from "@prisma/client";

// ============================================================
// MARKETING SEGMENTS - pure classification logic
//
// Every segment except "SAVED" (a user-defined MarketingSavedSegment
// filter) and the Broker/Party tags is a pure function of a Contact's own
// already-refreshed fields plus the MarketingSettings thresholds - no DB
// access here, fully unit-testable. The caller (API routes / campaign
// recipient resolution) is responsible for fetching the Contact rows and
// MarketingSettings first.
// ============================================================

export type ContactForSegments = {
  id: string;
  roles: MarketingContactRole[];
  lastDate: Date;
  firstDate: Date;
  biltyCount: number;
  revenue: number;
  isBroker: boolean;
  optedOut: boolean;
  sourceless: boolean;
};

export type MarketingSettingsLike = {
  activeDays: number;
  sleepingMinDays: number;
  sleepingMaxDays: number;
  lostDays: number;
  vipPercentile: number;
};

export type BuiltInSegment = "ACTIVE" | "SLEEPING" | "LOST" | "ONE_TIME" | "VIP";

function daysSince(date: Date, now: Date): number {
  const ms = now.getTime() - date.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * A contact excluded from every "customer" segment (Active/Sleeping/Lost/
 * One-time/VIP/Route/Saved/All) regardless of its own activity numbers -
 * opted-out, sourceless (no document left supporting it), a tagged
 * Broker, or holding the PARTY role all exclude by default. Only the
 * dedicated BROKER/PARTY segment types ever surface these contacts (and
 * even there, opted-out/sourceless still exclude).
 */
export function isExcludedByDefault(contact: ContactForSegments): boolean {
  return contact.optedOut || contact.sourceless || contact.isBroker || contact.roles.includes("PARTY");
}

/**
 * Which of the day-based built-in segments (Active/Sleeping/Lost) a
 * contact's own `lastDate` currently falls into, plus One-time (exactly
 * one Bilty, ever). A contact can be in at most one of Active/Sleeping/
 * Lost (the three day-ranges are contiguous and non-overlapping by
 * construction: Active is `<= activeDays`, Sleeping is
 * `[sleepingMinDays, sleepingMaxDays]`, Lost is `> lostDays`) but can
 * ALSO independently be One-time.
 */
export function classifyActivitySegments(
  contact: ContactForSegments,
  settings: MarketingSettingsLike,
  now: Date
): BuiltInSegment[] {
  const segments: BuiltInSegment[] = [];
  const age = daysSince(contact.lastDate, now);

  if (age <= settings.activeDays) segments.push("ACTIVE");
  else if (age >= settings.sleepingMinDays && age <= settings.sleepingMaxDays) segments.push("SLEEPING");
  else if (age > settings.lostDays) segments.push("LOST");

  if (contact.biltyCount === 1) segments.push("ONE_TIME");

  return segments;
}

/**
 * VIP = top `vipPercentile`% of revenue among the given contact pool
 * (only contacts with revenue > 0 are eligible - a zero-revenue contact
 * never qualifies no matter how small the pool). `allContacts` should
 * already have opted-out/sourceless/broker/party contacts filtered out by
 * the caller, matching every other default-segment's own exclusion.
 */
export function computeVipContactIds(allContacts: ContactForSegments[], vipPercentile: number): Set<string> {
  const eligible = allContacts.filter((c) => c.revenue > 0);
  if (eligible.length === 0) return new Set();

  const sorted = [...eligible].sort((a, b) => b.revenue - a.revenue);
  const cutoffCount = Math.max(1, Math.ceil((vipPercentile / 100) * sorted.length));
  return new Set(sorted.slice(0, cutoffCount).map((c) => c.id));
}

export type SavedSegmentFilter = {
  roles?: MarketingContactRole[]; // any-of
  city?: string;
  route?: string; // exact match against Contact.route ("<from> -> <to>")
  lastActivityWithinDays?: number;
  minRevenue?: number;
  includeBrokers?: boolean;
  includeParty?: boolean;
};

export type ContactForSavedFilter = ContactForSegments & {
  city: string | null;
  route: string | null;
};

export function matchesSavedSegmentFilter(contact: ContactForSavedFilter, filter: SavedSegmentFilter, now: Date): boolean {
  if (contact.optedOut || contact.sourceless) return false;
  if (contact.isBroker && !filter.includeBrokers) return false;
  if (contact.roles.includes("PARTY") && !filter.includeParty) return false;

  if (filter.roles && filter.roles.length > 0 && !filter.roles.some((r) => contact.roles.includes(r))) return false;
  if (filter.city && contact.city !== filter.city) return false;
  if (filter.route && contact.route !== filter.route) return false;
  if (filter.lastActivityWithinDays !== undefined && daysSince(contact.lastDate, now) > filter.lastActivityWithinDays) return false;
  if (filter.minRevenue !== undefined && contact.revenue < filter.minRevenue) return false;

  return true;
}
