// Smoke test for the watcher: deadline math, payouts, an end-to-end tick on a temp DB,
// and a live Open-Meteo call. Run: npx tsx scripts/watcher-smoke.ts
import assert from "node:assert/strict";

process.env.DB_PATH = `/tmp/kept-watcher-smoke-${process.pid}.db`;
const db = await import("../server/db.ts");
const W = await import("../server/watcher.ts");
const carrier = await import("../server/sources/carrier.ts");
const weather = await import("../server/sources/weather.ts");
import type { CompiledPromise, Order, PromiseRule } from "../server/types.ts";

const TZ = "America/New_York";
let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log("  ok", name); };

console.log("Deadlines");
const fri = { kind: "weekday_after_purchase", weekday: "friday" } as const;
ok("Mon 10am EST -> Fri 23:59:59 EST", () =>
  assert.equal(W.computeDeadline(fri, new Date("2026-11-09T15:00:00Z"), TZ).toISOString(), "2026-11-14T04:59:59.000Z"));
ok("Fri purchase -> same Fri", () =>
  assert.equal(W.computeDeadline(fri, new Date("2026-11-13T16:00:00Z"), TZ).toISOString(), "2026-11-14T04:59:59.000Z"));
ok("Fri 11pm local (Sat UTC) -> same local Fri", () =>
  assert.equal(W.computeDeadline(fri, new Date("2026-11-14T04:00:00Z"), TZ).toISOString(), "2026-11-14T04:59:59.000Z"));
ok("Sat purchase -> next Fri", () =>
  assert.equal(W.computeDeadline(fri, new Date("2026-11-14T16:00:00Z"), TZ).toISOString(), "2026-11-21T04:59:59.000Z"));
ok("summer (EDT) offset", () =>
  assert.equal(W.computeDeadline(fri, new Date("2026-07-06T15:00:00Z"), TZ).toISOString(), "2026-07-11T03:59:59.000Z"));
ok("across DST end (Nov 1 2026)", () =>
  assert.equal(W.computeDeadline({ kind: "weekday_after_purchase", weekday: "monday" }, new Date("2026-10-30T15:00:00Z"), TZ).toISOString(), "2026-11-03T04:59:59.000Z"));
ok("3 business days from Thu -> Tue", () =>
  assert.equal(W.computeDeadline({ kind: "business_days_after_purchase", days: 3 }, new Date("2026-11-12T15:00:00Z"), TZ).toISOString(), "2026-11-18T04:59:59.000Z"));
ok("0 business days -> same day", () =>
  assert.equal(W.computeDeadline({ kind: "business_days_after_purchase", days: 0 }, new Date("2026-11-12T15:00:00Z"), TZ).toISOString(), "2026-11-13T04:59:59.000Z"));
ok("48 hours exact", () =>
  assert.equal(W.computeDeadline({ kind: "hours_after_purchase", hours: 48 }, new Date("2026-11-12T15:12:34Z"), TZ).toISOString(), "2026-11-14T15:12:34.000Z"));
ok("fmtLocal", () => assert.equal(W.fmtLocal(new Date("2026-11-14T04:59:59Z"), TZ), "Fri 11:59 pm"));
ok("fmtHours", () => { assert.equal(W.fmtHours({ start: 16, end: 20 }), "4–8 pm"); assert.equal(W.fmtHours({ start: 10, end: 14 }), "10 am–2 pm"); assert.equal(W.fmtHours({ start: 0, end: 24 }), "all day"); });

console.log("Fixed-date deadlines and promise ideas context");
const thanks = { kind: "by_date", date: "2026-11-25", order_by: "2026-11-20" } as const;
ok("by_date -> 23:59:59 local that day", () =>
  assert.equal(W.computeDeadline(thanks, new Date("2026-11-10T15:00:00Z"), TZ).toISOString(), "2026-11-26T04:59:59.000Z"));
const fixedDate = (order_by: string | null) => ({ checkable: true, rule: { condition: { kind: "delivered_by", deadline: { kind: "by_date", date: "2026-11-25", order_by } }, payout: { kind: "percent_of_total", percent: 20 } } }) as unknown as CompiledPromise;
ok("open through the cutoff day (local), closed after", () => {
  assert.equal(W.promiseOpen(fixedDate("2026-11-20"), new Date("2026-11-21T04:30:00Z"), TZ), true); // Nov 20, 11:30 pm EST
  assert.equal(W.promiseOpen(fixedDate("2026-11-20"), new Date("2026-11-21T05:30:00Z"), TZ), false); // Nov 21, 12:30 am EST
});
ok("no cutoff -> open until the date itself", () => {
  assert.equal(W.promiseOpen(fixedDate(null), new Date("2026-11-25T20:00:00Z"), TZ), true);
  assert.equal(W.promiseOpen(fixedDate(null), new Date("2026-11-26T15:00:00Z"), TZ), false);
});
ok("relative promises never close", () =>
  assert.equal(W.promiseOpen({ checkable: true, rule: { condition: { kind: "delivered_by", deadline: fri }, payout: { kind: "shipping_cost" } } } as unknown as CompiledPromise, new Date("2030-01-01T00:00:00Z"), TZ), true));
const ctxMod = await import("../server/sources/context.ts");
ok("US holidays 2026", () => {
  const h = Object.fromEntries(ctxMod.usHolidays(2026).map((x) => [x.name, x.date]));
  assert.equal(h["Thanksgiving"], "2026-11-26");
  assert.equal(h["Black Friday"], "2026-11-27");
  assert.equal(h["Cyber Monday"], "2026-11-30");
  assert.equal(h["Mother's Day"], "2026-05-10");
  assert.equal(h["Memorial Day"], "2026-05-25");
  assert.equal(h["Father's Day"], "2026-06-21");
  assert.equal(h["Labor Day"], "2026-09-07");
});
ok("upcoming holidays span the new year", () => {
  const names = ctxMod.upcomingHolidays("2026-12-20").map((x) => x.name);
  assert.deepEqual(names.slice(0, 3), ["Christmas Eve", "Christmas Day", "New Year's Eve"]);
  assert.ok(names.includes("New Year's Day") && names.includes("Valentine's Day"));
});
ok("seasons", () => {
  assert.equal(ctxMod.seasonOf("2026-11-10", 43.6), "late autumn");
  assert.equal(ctxMod.seasonOf("2026-01-15", 43.6), "mid winter");
  assert.equal(ctxMod.seasonOf("2026-01-15", -33.9), "mid summer");
});
const pricing = await import("../server/pricing.ts");
const mug = { id: "p", name: "Mug", description: "", price: 38, shipping: 6.4, image: "", kind: "physical", promise_id: null } as const;
const tourP = { ...mug, name: "Tour", price: 65, shipping: 0, kind: "experience" } as const;
const ctx0 = { today: "2026-11-10", weekday: "Tuesday", part_of_day: "afternoon", season: "late autumn", location: "Portland, ME", upcoming_holidays: [], forecast: [], forecast_url: null } as const;
ok("fixed-date promise priced from its cutoff day, peak-season bump", () => {
  const c = pricing.expectedCost(fixedDate("2026-11-20"), mug, ctx0, new Date("2026-11-10T15:00:00Z"), null)!;
  // Nov 20 (Fri) -> Nov 25 (Wed): 3 business days -> 10%, ×1.5 peak = 15%; payout 20% of $44.40 = $8.88
  assert.equal(c.probability, 0.15);
  assert.equal(c.payout, 8.88);
  assert.equal(c.expected, 1.33);
});
ok("weather promise priced from history (2 of 4 days)", () => {
  const rain = { checkable: true, rule: { condition: { kind: "weather", metric: "precipitation_mm", op: ">=", threshold: 1, hours: { start: 16, end: 20 } }, payout: { kind: "percent_of_total", percent: 50 } } } as unknown as CompiledPromise;
  const time: string[] = [], precipitation: number[] = [], temperature_2m: number[] = [], wind_speed_10m: number[] = [];
  ["2025-11-10", "2025-11-11", "2024-11-10", "2024-11-11"].forEach((d, i) => {
    for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, "0")}:00`);
      // day 0: 2 mm in the window (hit); day 1: 5 mm at 10 am only (miss); day 2: 0.6+0.6 mm (hit); day 3: dry
      precipitation.push(i === 0 && h === 17 ? 2 : i === 1 && h === 10 ? 5 : i === 2 && (h === 16 || h === 19) ? 0.6 : 0);
      temperature_2m.push(5);
      wind_speed_10m.push(10);
    }
  });
  const c = pricing.expectedCost(rain, tourP, ctx0, new Date(), { data: { time, precipitation, temperature_2m, wind_speed_10m }, years: 2, days: 2 })!;
  assert.equal(c.probability, 0.5);
  assert.equal(c.payout, 32.5);
  assert.equal(c.expected, 16.25);
  assert.equal(c.method, "weather_history");
});

console.log("Payouts");
const baseOrder = (over: Partial<Order> = {}): Order => ({
  id: db.newId("ord"), product_id: "prod_x", promise_id: null, promise_snapshot: null, paypal_order_id: "PP", paypal_capture_id: "CAP123",
  amount_total: 44.4, amount_shipping: 6.4, buyer_name: "Ada Lovelace", buyer_email: null, event_date: null, event_location: null,
  tracking_number: null, status: "paid", deadline_at: null, payout_amount: null, paypal_refund_id: null, customer_message: null,
  created_at: db.now().toISOString(), resolved_at: null, ...over,
});
const rule = (payout: PromiseRule["payout"]): PromiseRule => ({ condition: { kind: "delivered_by", deadline: fri }, payout });
ok("shipping_cost", () => assert.equal(W.computePayout(rule({ kind: "shipping_cost" }), baseOrder()), 6.4));
ok("shipping_cost 0 -> 0", () => assert.equal(W.computePayout(rule({ kind: "shipping_cost" }), baseOrder({ amount_shipping: 0 })), 0));
ok("50% of 65 -> 32.5", () => assert.equal(W.computePayout(rule({ kind: "percent_of_total", percent: 50 }), baseOrder({ amount_total: 65 })), 32.5));
ok("33% of 10.01 rounds to cents", () => assert.equal(W.computePayout(rule({ kind: "percent_of_total", percent: 33 }), baseOrder({ amount_total: 10.01 })), 3.3));
ok("fixed clamped to total", () => assert.equal(W.computePayout(rule({ kind: "fixed", amount: 100 }), baseOrder()), 44.4));

console.log("End-to-end tick (temp DB)");
const snap = (r: PromiseRule, badge: string): CompiledPromise => ({
  checkable: true, rule: r, badge, plain_english: "", data_source: r.condition.kind === "weather" ? "open_meteo_weather" : "carrier_tracking",
  needs_from_buyer: [], assumptions: [], questions: [], suggested_rewrite: null,
});
const product = db.products.put({ id: "prod_x", name: "Tidepool Mug", description: "", price: 38, shipping: 6.4, image: "", kind: "physical", promise_id: null });
const mugPromise = snap(rule({ kind: "shipping_cost" }), "Arrives by Friday — or shipping's on us");
const mk = (over: Partial<Order>) => {
  const o = baseOrder({ promise_snapshot: mugPromise, ...over });
  if (o.promise_snapshot?.rule?.condition.kind === "delivered_by")
    o.deadline_at = W.computeDeadline(o.promise_snapshot.rule.condition.deadline, db.now(), TZ).toISOString();
  return db.orders.put(o);
};
const kept = mk({ tracking_number: carrier.createShipment("k") });
const late = mk({ tracking_number: carrier.createShipment("l") });
const overBudget = mk({ tracking_number: carrier.createShipment("b"), promise_snapshot: snap(rule({ kind: "fixed", amount: 40 }), "big"), amount_total: 600 });
db.orders.put({ ...db.orders.get(overBudget.id)!, promise_snapshot: snap(rule({ kind: "percent_of_total", percent: 100 }), "Full refund if late") });
const noPromise = db.orders.put(baseOrder({ product_id: product.id }));
db.products.put({ ...product, id: "prod_exp", kind: "experience" });
const noPromiseExp = db.orders.put(baseOrder({ product_id: "prod_exp" }));

assert.match(kept.tracking_number!, /^KP\d{10}$/);
carrier.pushCarrierEvent(kept.tracking_number!, "picked_up", "Picked up", "Portland, ME");
carrier.pushCarrierEvent(late.tracking_number!, "picked_up", "Picked up", "Portland, ME");
await Promise.all([W.tick(), W.tick(), W.tick()]); // concurrent ticks must not double-process
const st = (o: Order) => db.orders.get(o.id)!.status;
ok("non-final while deadline in future", () => { assert.equal(st(kept), "paid"); assert.equal(st(late), "paid"); });
ok("no-promise experience closed immediately", () => assert.equal(st(noPromiseExp), "kept"));
ok("no-promise physical waits for delivery", () => assert.equal(st(noPromise), "paid"));

db.advanceClock(2 * 86400_000);
carrier.pushCarrierEvent(kept.tracking_number!, "delivered", "Delivered, front porch", "Portland, ME");
carrier.pushCarrierEvent(late.tracking_number!, "delayed", "Delayed — weather", "Worcester, MA");
await W.tick();
ok("kept path", () => assert.equal(st(kept), "kept"));
db.advanceClock(5 * 86400_000);
await W.tick();
await W.tick(); // idempotent: second pass changes nothing
const evs = (o: Order) => db.agentEvents.all().filter((e) => e.order_id === o.id);
ok("breach -> failed (paypal/narrator not ready or fake capture)", () => assert.equal(st(late), "failed"));
ok("breach logged once with evidence", () => assert.equal(evs(late).filter((e) => e.kind === "breach").length, 1));
ok("over budget held for human", () => { assert.equal(st(overBudget), "failed"); assert.match(evs(overBudget).find((e) => e.kind === "error")!.message, /human must approve/); });
ok("evidence deduped", () => { const s = evs(late).filter((e) => e.kind === "evidence").map((e) => e.message); assert.equal(new Set(s).size, s.length); });

console.log("Weather (live Open-Meteo)");
const yday = new Date(Date.now() - 86400_000).toLocaleDateString("en-CA", { timeZone: TZ });
const home = { name: "Portland, ME", lat: 43.6591, lon: -70.2568 };
const obs = await weather.getWeather(home.lat, home.lon, home.name, yday, { start: 16, end: 20 });
console.log("  ", JSON.stringify(obs));
ok("live weather numbers", () => { assert.equal(obs.simulated, false); assert.ok(Number.isFinite(obs.precipitation_mm) && Number.isFinite(obs.max_temp_c)); assert.ok(obs.source_url.includes(yday)); });
const old = await weather.getWeather(home.lat, home.lon, home.name, "2025-06-01", null);
ok("archive endpoint for old dates", () => assert.ok(old.source_url.startsWith("https://archive-api")));
const tourRule: PromiseRule = { condition: { kind: "weather", metric: "precipitation_mm", op: ">=", threshold: 1, hours: { start: 16, end: 20 } }, payout: { kind: "percent_of_total", percent: 50 } };
const tour = db.orders.put(baseOrder({ promise_snapshot: snap(tourRule, "Rained out? 50% back"), amount_total: 65, amount_shipping: 0, event_date: yday, event_location: home }));
const v = await W.evaluate(tour);
console.log("   verdict:", v.breached, v.final, "|", v.evidence.summary);
ok("weather final after window", () => assert.equal(v.final, true));
const tomorrow = db.now().toLocaleDateString("en-CA", { timeZone: TZ });
const pending = await W.evaluate({ ...tour, event_date: new Date(db.now().getTime() + 86400_000).toLocaleDateString("en-CA", { timeZone: TZ }) });
ok("weather non-final before window ends", () => assert.equal(pending.final, false));
void tomorrow;
weather.setWeatherOverride(yday, home.name, { precipitation_mm: 3.4 });
const sim = await W.evaluate(tour);
console.log("   override:", sim.evidence.summary);
ok("override -> simulated breach", () => { assert.equal(sim.breached, true); assert.equal((sim.evidence.observed as { simulated: boolean }).simulated, true); });

console.log("\nAudit trail:");
for (const e of db.agentEvents.all()) console.log(`  [${e.kind}] ${e.order_id?.slice(-4) ?? "----"} ${e.message}`);
console.log(`\n${passed} checks passed`);
