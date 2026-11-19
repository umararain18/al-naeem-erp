// ============================================================
// ROUTE GROSS MARGIN + EMPTY-RETURN DETECTION - pure functions
//
// "Gross margin per route" needs to combine two documents that don't
// share a 1:1 relationship: a Bilty's own booking amount (its own
// route, via fromLocation/toLocation) and a Challan's own Carrier
// Rent (one Challan can carry several Bilties, possibly spanning
// different routes in theory). Since CarrierRent has no per-Bilty
// breakdown anywhere in the schema, a Challan's own Carrier Rent is
// allocated across its own Bilties' routes PROPORTIONALLY by each
// route's own share of that Challan's total booking - the same
// "split a shared cost by each contributor's own share" principle
// used elsewhere in this codebase's own batch cost-allocation code,
// never a new accounting rule (this never writes anything, it's a
// read-only report grouping).
//
// "Empty-return" is a heuristic, not a ledger fact: a destination
// city this period's Bilties shipped TO, with little/no cargo
// shipped back FROM it (the reverse direction) in the same period -
// flagged so ops can go look for return-leg business, not a claim
// that a specific truck is known to have returned empty.
// ============================================================

export type RouteBiltyInput = {
  biltyId: string;
  challanId: string | null; // which Challan (if any) this Bilty's rent was carried on
  fromLocation: string;
  toLocation: string;
  total: number; // this Bilty's own booking amount
};

export type RouteChallanInput = {
  challanId: string;
  carrierRent: number;
};

export type RouteMarginRow = {
  route: string; // "<from> -> <to>"
  biltyCount: number;
  booking: number;
  carrierRent: number;
  margin: number; // profit Rs = booking - carrierRent
  marginPct: number; // margin / booking * 100, 0 when booking is 0
};

function routeKey(from: string, to: string): string {
  return `${from} -> ${to}`;
}

/**
 * Per-route gross margin for the period. Each Challan's own Carrier
 * Rent is split across the routes of ITS OWN linked Bilties,
 * proportional to each route's own share of that Challan's total
 * booking (a Bilty with no Challan link yet contributes booking with
 * zero attributed Carrier Rent - it hasn't been carried, so there is
 * none to allocate).
 */
export function computeRouteMargins(bilties: RouteBiltyInput[], challans: RouteChallanInput[]): RouteMarginRow[] {
  const rentByChallanId = new Map(challans.map((c) => [c.challanId, c.carrierRent]));
  const rows = new Map<string, RouteMarginRow>();

  const bookingByChallanId = new Map<string, number>();
  for (const b of bilties) {
    if (!b.challanId) continue;
    bookingByChallanId.set(b.challanId, (bookingByChallanId.get(b.challanId) ?? 0) + b.total);
  }

  for (const b of bilties) {
    const key = routeKey(b.fromLocation, b.toLocation);
    const row = rows.get(key) ?? { route: key, biltyCount: 0, booking: 0, carrierRent: 0, margin: 0, marginPct: 0 };
    row.biltyCount += 1;
    row.booking += b.total;

    if (b.challanId) {
      const challanRent = rentByChallanId.get(b.challanId) ?? 0;
      const challanBooking = bookingByChallanId.get(b.challanId) ?? 0;
      const share = challanBooking > 0 ? b.total / challanBooking : 0;
      row.carrierRent += challanRent * share;
    }

    rows.set(key, row);
  }

  for (const row of rows.values()) {
    row.margin = Math.round((row.booking - row.carrierRent) * 100) / 100;
    row.marginPct = row.booking > 0 ? Math.round((row.margin / row.booking) * 1000) / 10 : 0;
  }

  return [...rows.values()].sort((a, b) => b.margin - a.margin);
}

export type EmptyReturnCity = {
  city: string; // a destination with little/no reverse cargo
  inbound: number; // bilty count shipped TO this city this period
  outbound: number; // bilty count shipped FROM this city this period
};

/**
 * Flags destinations with meaningfully more cargo arriving than
 * leaving - candidates for "empty return" follow-up. A city with no
 * outbound Bilties at all (outbound === 0) always qualifies once it
 * has any inbound volume; otherwise it qualifies when outbound is
 * less than `thresholdRatio` of inbound (default: outbound under 20%
 * of inbound).
 */
export function detectEmptyReturnCities(bilties: RouteBiltyInput[], thresholdRatio = 0.2): EmptyReturnCity[] {
  const inboundByCity = new Map<string, number>();
  const outboundByCity = new Map<string, number>();

  for (const b of bilties) {
    inboundByCity.set(b.toLocation, (inboundByCity.get(b.toLocation) ?? 0) + 1);
    outboundByCity.set(b.fromLocation, (outboundByCity.get(b.fromLocation) ?? 0) + 1);
  }

  const results: EmptyReturnCity[] = [];
  for (const [city, inbound] of inboundByCity) {
    const outbound = outboundByCity.get(city) ?? 0;
    if (outbound === 0 || outbound / inbound < thresholdRatio) {
      results.push({ city, inbound, outbound });
    }
  }

  return results.sort((a, b) => b.inbound - a.inbound);
}
