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
