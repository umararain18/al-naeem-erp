import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRouteMargins, detectEmptyReturnCities, type RouteBiltyInput } from "./route-margins";

test("computeRouteMargins - single route, single challan, exact rent allocation", () => {
  const bilties: RouteBiltyInput[] = [{ biltyId: "b1", challanId: "c1", fromLocation: "Karachi", toLocation: "Lahore", total: 10000 }];
  const rows = computeRouteMargins(bilties, [{ challanId: "c1", carrierRent: 6000 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route, "Karachi -> Lahore");
  assert.equal(rows[0].booking, 10000);
  assert.equal(rows[0].carrierRent, 6000);
  assert.equal(rows[0].margin, 4000);
});

test("computeRouteMargins - one challan's rent splits proportionally across 2 routes", () => {
  const bilties: RouteBiltyInput[] = [
    { biltyId: "b1", challanId: "c1", fromLocation: "Karachi", toLocation: "Lahore", total: 7500 },
    { biltyId: "b2", challanId: "c1", fromLocation: "Karachi", toLocation: "Multan", total: 2500 },
  ];
  const rows = computeRouteMargins(bilties, [{ challanId: "c1", carrierRent: 4000 }]);
  const lahore = rows.find((r) => r.route === "Karachi -> Lahore")!;
  const multan = rows.find((r) => r.route === "Karachi -> Multan")!;
  assert.equal(lahore.carrierRent, 3000); // 75% share
  assert.equal(multan.carrierRent, 1000); // 25% share
});

test("computeRouteMargins - a Bilty with no Challan link is excluded from margin, tracked as pending", () => {
  const bilties: RouteBiltyInput[] = [{ biltyId: "b1", challanId: null, fromLocation: "Karachi", toLocation: "Lahore", total: 5000 }];
  const rows = computeRouteMargins(bilties, []);
  assert.equal(rows[0].biltyCount, 0);
  assert.equal(rows[0].booking, 0);
  assert.equal(rows[0].carrierRent, 0);
  assert.equal(rows[0].margin, 0);
  assert.equal(rows[0].pendingBiltyCount, 1);
  assert.equal(rows[0].pendingBooking, 5000);
});

test("computeRouteMargins - sorted by margin descending", () => {
  const bilties: RouteBiltyInput[] = [
    { biltyId: "b1", challanId: "c1", fromLocation: "A", toLocation: "B", total: 1000 },
    { biltyId: "b2", challanId: "c2", fromLocation: "C", toLocation: "D", total: 5000 },
  ];
  const rows = computeRouteMargins(bilties, [
    { challanId: "c1", carrierRent: 0 },
    { challanId: "c2", carrierRent: 0 },
  ]);
  assert.equal(rows[0].route, "C -> D");
  assert.equal(rows[1].route, "A -> B");
});

test("detectEmptyReturnCities - a destination with zero reverse cargo qualifies", () => {
  const bilties: RouteBiltyInput[] = [
    { biltyId: "b1", challanId: null, fromLocation: "Karachi", toLocation: "D.I.Khan", total: 100 },
    { biltyId: "b2", challanId: null, fromLocation: "Karachi", toLocation: "D.I.Khan", total: 100 },
  ];
  const cities = detectEmptyReturnCities(bilties);
  assert.equal(cities.length, 1);
  assert.equal(cities[0].city, "D.I.Khan");
  assert.equal(cities[0].outbound, 0);
});

test("detectEmptyReturnCities - balanced two-way traffic does not qualify", () => {
  const bilties: RouteBiltyInput[] = [
    { biltyId: "b1", challanId: null, fromLocation: "Karachi", toLocation: "Lahore", total: 100 },
    { biltyId: "b2", challanId: null, fromLocation: "Lahore", toLocation: "Karachi", total: 100 },
  ];
  const cities = detectEmptyReturnCities(bilties);
  assert.equal(cities.length, 0);
});

test("detectEmptyReturnCities - below the ratio threshold still qualifies", () => {
  const bilties: RouteBiltyInput[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ biltyId: `in${i}`, challanId: null, fromLocation: "Karachi", toLocation: "Multan", total: 10 })),
    { biltyId: "out1", challanId: null, fromLocation: "Multan", toLocation: "Karachi", total: 10 },
  ];
  const cities = detectEmptyReturnCities(bilties, 0.2);
  assert.equal(cities.length, 1);
  assert.equal(cities[0].city, "Multan");
});
