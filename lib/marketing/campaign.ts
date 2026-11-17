import type { Prisma, PrismaClient, MarketingContactRole, MarketingSegmentType } from "@prisma/client";
import { toLocalMobile } from "../phone";
import { getMarketingSettings } from "./settings";
import { classifyActivitySegments, computeVipContactIds, isExcludedByDefault, matchesSavedSegmentFilter, type ContactForSavedFilter, type ContactForSegments, type SavedSegmentFilter } from "./segments";

type Tx = PrismaClient | Prisma.TransactionClient;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateForTemplate(date: Date | null): string {
  if (!date) return "";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function describeRoles(roles: MarketingContactRole[]): string {
  const hasSender = roles.includes("SENDER");
  const hasReceiver = roles.includes("RECEIVER");
  if (hasSender && hasReceiver) return "Sender/Receiver";
  if (hasSender) return "Sender";
  if (hasReceiver) return "Receiver";
  if (roles.includes("BILL_CLIENT")) return "Client";
  if (roles.includes("PARTY")) return "Transporter/Agent";
  return "";
}

export type TemplateContact = {
  name: string;
  city: string | null;
  lastVehicle: string | null;
  lastDate: Date | null;
  roles: MarketingContactRole[];
  route: string | null;
};

/**
 * Replaces {name} {city} {vehicle} {lastDate} {role} {direction} with the
 * contact's own data. A placeholder with no data on this contact renders
 * as an empty string rather than leaving the literal token in the text.
 */
export function renderTemplate(templateText: string, contact: TemplateContact): string {
  const values: Record<string, string> = {
    name: contact.name || "",
    city: contact.city || "",
    vehicle: contact.lastVehicle || "",
    lastDate: formatDateForTemplate(contact.lastDate),
    role: describeRoles(contact.roles),
    direction: contact.route || "",
  };
  return templateText.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key] : match));
}

/**
 * `03XXXXXXXXX` -> a `wa.me` deep link with the message pre-filled and
 * URL-encoded. Pakistan's country code (92) replaces the leading 0.
 */
export function buildWaLink(localMobile: string, message: string): string {
  const international = `92${localMobile.slice(1)}`;
  return `https://wa.me/${international}?text=${encodeURIComponent(message)}`;
}

export type SegmentResolutionParams = { route?: string; savedSegmentId?: string } | null;

async function loadContactsForSegments(tx: Tx): Promise<(ContactForSegments & ContactForSavedFilter & { phone: string })[]> {
  const rows = await tx.marketingContact.findMany({ where: { mergedIntoId: null } });
  return rows.map((c) => ({
    id: c.id,
    phone: c.phone,
    roles: c.roles,
    lastDate: c.lastDate,
    firstDate: c.firstDate,
    biltyCount: c.biltyCount,
    revenue: Number(c.revenue),
    isBroker: c.isBroker,
    optedOut: c.optedOut,
    sourceless: c.sourceless,
    city: c.city,
    route: c.route,
  }));
}

/**
 * Resolves a campaign's chosen segment to the concrete set of Contact ids
 * it should target, AT campaign-create time only - the result is
 * snapshotted into MarketingCampaignRecipient rows and never re-resolved,
 * so a campaign's own recipient list never shifts under it later.
 */
export async function resolveSegmentContactIds(tx: Tx, segmentType: MarketingSegmentType, segmentParams: SegmentResolutionParams, now: Date): Promise<string[]> {
  const settings = await getMarketingSettings(tx);
  const contacts = await loadContactsForSegments(tx);

  if (segmentType === "BROKER") {
    return contacts.filter((c) => !c.optedOut && !c.sourceless && c.isBroker).map((c) => c.id);
  }
  if (segmentType === "PARTY") {
    return contacts.filter((c) => !c.optedOut && !c.sourceless && c.roles.includes("PARTY")).map((c) => c.id);
  }

  const defaultEligible = contacts.filter((c) => !isExcludedByDefault(c));

  if (segmentType === "ALL") {
    return defaultEligible.map((c) => c.id);
  }

  if (segmentType === "ROUTE") {
    const route = segmentParams?.route;
    if (!route) return [];
    return defaultEligible.filter((c) => c.route === route).map((c) => c.id);
  }

  if (segmentType === "SAVED") {
    if (!segmentParams?.savedSegmentId) return [];
    const saved = await tx.marketingSavedSegment.findUnique({ where: { id: segmentParams.savedSegmentId } });
    if (!saved) return [];
    const filter = saved.filterJson as SavedSegmentFilter;
    return contacts.filter((c) => matchesSavedSegmentFilter(c, filter, now)).map((c) => c.id);
  }

  if (segmentType === "VIP") {
    const vipIds = computeVipContactIds(defaultEligible, settings.vipPercentile);
    return defaultEligible.filter((c) => vipIds.has(c.id)).map((c) => c.id);
  }

  // ACTIVE | SLEEPING | LOST | ONE_TIME
  return defaultEligible.filter((c) => classifyActivitySegments(c, settings, now).includes(segmentType as "ACTIVE" | "SLEEPING" | "LOST" | "ONE_TIME")).map((c) => c.id);
}

export { toLocalMobile };
