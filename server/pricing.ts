// What a promise is likely to cost the merchant per order. Deterministic: weather promises are priced
// from Open-Meteo's history of the same weeks in past years; delivery promises from stated
// carrier on-time assumptions (the demo carrier is simulated, so there's no real history to use).
import { MERCHANT } from "./merchant.ts";
import type { HourlyHistory, MomentContext } from "./sources/context.ts";
import type { CompiledPromise, Order, Product } from "./types.ts";
import { computeDeadline, computePayout, localDate } from "./watcher.ts";

export type ExpectedCost = {
  probability: number; // 0..1 chance the promise breaks on a typical order
  payout: number; // USD paid when it breaks
  expected: number; // USD per order, probability × payout
  method: "weather_history" | "carrier_assumption";
  basis: string; // one line a merchant can check
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function payoutFor(compiled: CompiledPromise, product: Product): number {
  const amount_total = +(product.price + product.shipping).toFixed(2);
  return computePayout(compiled.rule!, { amount_total, amount_shipping: product.shipping } as Order);
}

/** Business days (Mon–Fri) strictly after `from` up to and including `to`, both YYYY-MM-DD. */
function businessDaysBetween(from: string, to: string): number {
  let n = 0;
  const d = new Date(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  while (d.getTime() < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// Assumed share of ground parcels that miss a deadline, by business days of slack. Stated as an
// assumption in the UI; replace with the merchant's real carrier history in production.
const DELIVERY_MISS = [0.6, 0.35, 0.2, 0.1, 0.06, 0.03]; // index = business days available (5+ = last)
const SHIP_MISS = [0.25, 0.08, 0.03];

function isPeak(date: string): boolean {
  const md = date.slice(5);
  return md >= "11-20" && md <= "12-24";
}

function carrierCost(compiled: CompiledPromise, product: Product, ctx: MomentContext, at: Date): ExpectedCost {
  const cond = compiled.rule!.condition;
  if (cond.kind === "weather") throw new Error("carrierCost needs a delivery or shipping promise");
  const deadlineDay = localDate(computeDeadline(cond.deadline, at, MERCHANT.timezone), MERCHANT.timezone);
  // Fixed-date promises are priced for the worst covered order: one placed on the order-by cutoff.
  const orderDay = cond.deadline.kind === "by_date" ? [ctx.today, cond.deadline.order_by ?? deadlineDay].sort()[1] : ctx.today;
  const slack = businessDaysBetween(orderDay, deadlineDay);
  const table = cond.kind === "delivered_by" ? DELIVERY_MISS : SHIP_MISS;
  let p = table[Math.min(slack, table.length - 1)];
  const peak = cond.kind === "delivered_by" && isPeak(deadlineDay);
  if (peak) p = Math.min(0.9, p * 1.5);
  const payout = payoutFor(compiled, product);
  const verb = cond.kind === "delivered_by" ? "delivery" : "shipping";
  return {
    probability: r2(p),
    payout,
    expected: r2(p * payout),
    method: "carrier_assumption",
    basis: `Assumes ${Math.round(p * 100)}% of ground parcels miss a ${verb} deadline ${slack} business day${slack === 1 ? "" : "s"} out${orderDay !== ctx.today ? " (an order on the cutoff day)" : ""}${peak ? ", ×1.5 for peak season" : ""}. Swap in your carrier's real on-time rate.`,
  };
}

function weatherCost(compiled: CompiledPromise, product: Product, history: { data: HourlyHistory; years: number; days: number }): ExpectedCost | null {
  const cond = compiled.rule!.condition;
  if (cond.kind !== "weather") return null;
  const win = cond.hours ?? { start: 0, end: 24 };
  const byDay = new Map<string, { rain: number; temps: number[]; wind: number[] }>();
  const h = history.data;
  h.time.forEach((t, i) => {
    const hour = Number(t.slice(11, 13));
    if (hour < win.start || hour >= win.end) return;
    const day = t.slice(0, 10);
    const e = byDay.get(day) ?? { rain: 0, temps: [], wind: [] };
    if (typeof h.precipitation[i] === "number") e.rain += h.precipitation[i]!;
    if (typeof h.temperature_2m[i] === "number") e.temps.push(h.temperature_2m[i]!);
    if (typeof h.wind_speed_10m[i] === "number") e.wind.push(h.wind_speed_10m[i]!);
    byDay.set(day, e);
  });
  let hits = 0;
  let days = 0;
  for (const e of byDay.values()) {
    const value = { precipitation_mm: e.rain, max_temp_c: e.temps.length ? Math.max(...e.temps) : NaN, min_temp_c: e.temps.length ? Math.min(...e.temps) : NaN, max_wind_kmh: e.wind.length ? Math.max(...e.wind) : NaN }[cond.metric];
    if (!Number.isFinite(value)) continue;
    days++;
    const v = Math.round(value * 100) / 100;
    if (cond.op === ">" ? v > cond.threshold : cond.op === ">=" ? v >= cond.threshold : cond.op === "<" ? v < cond.threshold : v <= cond.threshold) hits++;
  }
  if (!days) return null;
  const p = hits / days;
  const payout = payoutFor(compiled, product);
  return {
    probability: r2(p),
    payout,
    expected: r2(p * payout),
    method: "weather_history",
    basis: `Would have paid out on ${hits} of ${days} days in these same ${history.days} days over the last ${history.years} years at ${MERCHANT.home.name} (Open-Meteo history).`,
  };
}

export function expectedCost(compiled: CompiledPromise, product: Product, ctx: MomentContext, at: Date, history: { data: HourlyHistory; years: number; days: number } | null): ExpectedCost | null {
  if (!compiled.checkable || !compiled.rule) return null;
  if (compiled.rule.condition.kind === "weather") return history ? weatherCost(compiled, product, history) : null;
  return carrierCost(compiled, product, ctx, at);
}
