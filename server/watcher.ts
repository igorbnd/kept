// The promise-keeping agent loop. OWNER: watcher agent.
// Deterministic: code evaluates rules and computes payouts; Claude only writes the message.
// Every decision is logged to agent_events with its evidence. Refunds are idempotent
// (PayPal-Request-Id = order id) and a module-level lock prevents overlapping ticks.
import { assessBreach } from "./ai/assessor.ts";
import { writeRefundMessage } from "./ai/narrator.ts";
import { agentEvents, logEvent, now, orders, products } from "./db.ts";
import { MERCHANT } from "./merchant.ts";
import { refundCapture } from "./paypal.ts";
import { getCarrierEvents } from "./sources/carrier.ts";
import { getWeather } from "./sources/weather.ts";
import type { CarrierEvent, Condition, Deadline, Evidence, Order, OrderReview, PromiseRule, Verdict } from "./types.ts";

// ---------- Timezone math (Intl only, no deps) ----------

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const dtfCache = new Map<string, Intl.DateTimeFormat>();

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

export function localParts(date: Date, timeZone: string): LocalParts {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(timeZone, dtf);
  }
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
  };
}

/** Offset of `timeZone` from UTC at instant `date`, in ms (e.g. -4h for EDT). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads the given local time. Fields may overflow (hour 24 = next day). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2; // crossed a DST transition
  return new Date(t);
}

/** "Thu 3:12 pm" in the given timezone. */
export function fmtLocal(date: Date, timeZone: string = MERCHANT.timezone): string {
  const p = localParts(date, timeZone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.weekday];
  return `${day} ${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "am" : "pm"}`;
}

const localDayNumber = (date: Date, tz: string) => {
  const p = localParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
};

// ---------- Deadlines & payouts ----------

/** Deadline instant for delivery/ship promises, from purchase time, in the merchant timezone. */
export function computeDeadline(deadline: Deadline, purchasedAt: Date, timezone: string): Date {
  if (deadline.kind === "hours_after_purchase") return new Date(purchasedAt.getTime() + deadline.hours * 3600_000);

  const p = localParts(purchasedAt, timezone);
  // Calendar arithmetic on the local date, using a UTC Date purely as a date counter.
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (deadline.kind === "weekday_after_purchase") {
    const target = WEEKDAYS.indexOf(deadline.weekday);
    d.setUTCDate(d.getUTCDate() + ((target - p.weekday + 7) % 7));
  } else {
    let left = deadline.days;
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) left--;
    }
  }
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 23, 59, 59, timezone);
}

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Payout in USD, rounded to cents, never more than the amount captured. */
export function computePayout(rule: PromiseRule, order: Order): number {
  let raw: number;
  switch (rule.payout.kind) {
    case "percent_of_total":
      raw = (order.amount_total * rule.payout.percent) / 100;
      break;
    case "fixed":
      raw = rule.payout.amount;
      break;
    case "shipping_cost":
      raw = order.amount_shipping;
      break;
  }
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return cents(Math.min(Math.max(raw, 0), Math.max(order.amount_total, 0)));
}

// ---------- Evaluation ----------

const OP_SYMBOL = { ">": ">", ">=": "≥", "<": "<", "<=": "≤" } as const;
const METRIC = {
  precipitation_mm: { label: (v: number) => `${v} mm rain`, unit: "mm" },
  max_temp_c: { label: (v: number) => `high of ${v} °C`, unit: "°C" },
  min_temp_c: { label: (v: number) => `low of ${v} °C`, unit: "°C" },
  max_wind_kmh: { label: (v: number) => `wind up to ${v} km/h`, unit: "km/h" },
} as const;

function compare(value: number, op: keyof typeof OP_SYMBOL, threshold: number): boolean {
  switch (op) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
  }
}

function fmtHour(h: number): string {
  const hh = h % 24;
  if (hh === 0) return "midnight";
  if (hh === 12) return "noon";
  return `${hh % 12} ${hh < 12 ? "am" : "pm"}`;
}
export function fmtHours(hours: { start: number; end: number }): string {
  if (hours.start === 0 && hours.end === 24) return "all day";
  const samePeriod = hours.start > 0 && hours.start !== 12 && hours.end % 24 !== 0 && hours.end !== 12 && (hours.start < 12) === (hours.end < 12);
  if (samePeriod) return `${hours.start % 12}–${fmtHour(hours.end)}`;
  return `${fmtHour(hours.start)}–${fmtHour(hours.end)}`;
}

function scanLine(ev: CarrierEvent | undefined, tz: string): string {
  if (!ev) return "No carrier scans yet.";
  return `Last scan: '${ev.description}' in ${ev.location}, ${fmtLocal(new Date(ev.at), tz)}.`;
}

function daysEarlyPhrase(at: Date, deadline: Date, tz: string): string {
  const days = localDayNumber(deadline, tz) - localDayNumber(at, tz);
  if (days <= 0) return "on the deadline day";
  if (days === 1) return "a day early";
  return `${days} days early`;
}

function deadlineFor(order: Order, cond: Extract<Condition, { deadline: Deadline }>): Date {
  return order.deadline_at ? new Date(order.deadline_at) : computeDeadline(cond.deadline, new Date(order.created_at), MERCHANT.timezone);
}

function evaluateCarrier(order: Order, cond: Extract<Condition, { kind: "delivered_by" | "shipped_by" }>): Verdict {
  const tz = MERCHANT.timezone;
  const deadline = deadlineFor(order, cond);
  const t = now();
  const events = order.tracking_number ? getCarrierEvents(order.tracking_number) : [];
  const last = events[events.length - 1];
  const wantDelivered = cond.kind === "delivered_by";
  const hits = (e: CarrierEvent) => (wantDelivered ? e.status === "delivered" : e.status !== "label_created");
  const hit = events.find(hits);
  const onTime = hit && Date.parse(hit.at) <= deadline.getTime();
  const verb = wantDelivered ? "delivered" : "shipped";
  const dl = fmtLocal(deadline, tz);
  const observed = {
    tracking_number: order.tracking_number,
    deadline_at: deadline.toISOString(),
    now: t.toISOString(),
    last_event: last ?? null,
    [`${verb}_at`]: hit?.at ?? null,
    scans: events.length,
  };
  const ev = (summary: string, final: boolean): Evidence => ({ source: "carrier_tracking", observed, summary, final });

  if (onTime) {
    const at = new Date(hit.at);
    const where = wantDelivered ? `in ${hit.location}` : `('${hit.description}' in ${hit.location})`;
    const summary = `${wantDelivered ? "Delivered" : "Shipped"} ${fmtLocal(at, tz)} ${where}, before the ${dl} deadline.`;
    return { breached: false, final: true, reason: `Promise kept: ${verb} ${fmtLocal(at, tz)}, ${daysEarlyPhrase(at, deadline, tz)}`, evidence: ev(summary, true) };
  }
  if (t.getTime() > deadline.getTime() || hit) {
    const late = hit ? ` ${wantDelivered ? "Delivered" : "First scan"} late, ${fmtLocal(new Date(hit.at), tz)}.` : "";
    const summary = `${scanLine(last, tz)} Not ${verb} by ${dl}.${late}`;
    return { breached: true, final: true, reason: `Not ${verb} by ${dl}`, evidence: ev(summary, true) };
  }
  const summary = `${scanLine(last, tz)} Watching: must be ${verb} by ${dl}.`;
  return { breached: false, final: false, reason: `Waiting for ${verb} scan before ${dl}`, evidence: ev(summary, false) };
}

// Timezones for the checkout's preset locations. Anything else falls back to the shop timezone
// (or Pacific time for locations far west, so the window has surely ended before we judge it).
const LOCATION_TZ: Record<string, string> = {
  "Portland, ME": "America/New_York",
  "Seattle, WA": "America/Los_Angeles",
  "Miami, FL": "America/New_York",
  "London, UK": "Europe/London",
};
function locationTimezone(loc: { name: string; lon: number }): string {
  return LOCATION_TZ[loc.name] ?? (loc.lon < -100 ? "America/Los_Angeles" : MERCHANT.timezone);
}

async function evaluateWeather(order: Order, cond: Extract<Condition, { kind: "weather" }>): Promise<Verdict> {
  const loc = order.event_location ?? MERCHANT.home;
  const hours = cond.hours ?? { start: 0, end: 24 };
  const metric = METRIC[cond.metric];
  const thresholdText = `threshold ${OP_SYMBOL[cond.op]} ${cond.threshold} ${metric.unit}`;
  if (!order.event_date) {
    return {
      breached: false,
      final: false,
      reason: "No event date on order",
      evidence: { source: "open_meteo_weather", observed: { event_date: null }, summary: "Order has no event date; can't check the weather yet.", final: false },
    };
  }
  // Open-Meteo reports hours in the location's local time (timezone=auto), so the window must end
  // in that timezone too; otherwise a Seattle tour would be judged on forecast, not observed, data.
  const [y, m, d] = order.event_date.split("-").map(Number);
  const windowEnd = zonedTimeToUtc(y, m, d, hours.end, 0, 0, locationTimezone(loc));
  const where = `${loc.name}, ${order.event_date}`;
  if (now().getTime() < windowEnd.getTime()) {
    return {
      breached: false,
      final: false,
      reason: "Event window hasn't ended",
      evidence: {
        source: "open_meteo_weather",
        observed: { event_date: order.event_date, window_end: windowEnd.toISOString(), location: loc },
        summary: `Watching: ${fmtHours(hours)}, ${where}. Checked once the window ends (${thresholdText}).`,
        final: false,
      },
    };
  }
  const obs = await getWeather(loc.lat, loc.lon, loc.name, order.event_date, hours);
  const value = obs[cond.metric];
  if (!Number.isFinite(value)) throw new Error(`Open-Meteo returned no ${cond.metric} for ${where}`);
  const breached = compare(value, cond.op, cond.threshold);
  // The demo clock can run ahead of reality. If the window hasn't actually happened yet, Open-Meteo
  // only has a forecast for it, so say so (real wall time on purpose: this is about the real sky).
  const forecastOnly = !obs.simulated && windowEnd.getTime() > Date.now();
  const src = obs.simulated ? "Simulated weather (demo override)" : forecastOnly ? "Open-Meteo forecast (the demo clock is ahead of real time)" : "Open-Meteo";
  const summary = `${src}: ${metric.label(value)}, ${fmtHours(hours)}, ${where} (${thresholdText})`;
  return {
    breached,
    final: true,
    reason: breached ? `${metric.label(value)} crossed the ${thresholdText}` : `Promise kept: ${metric.label(value)}, ${thresholdText} not met`,
    evidence: { source: "open_meteo_weather", observed: { ...obs, forecast_only: forecastOnly, metric: cond.metric, value, op: cond.op, threshold: cond.threshold }, summary, final: true },
  };
}

/** Gather evidence and evaluate one order's promise. */
export async function evaluate(order: Order): Promise<Verdict> {
  const rule = order.promise_snapshot?.rule;
  if (!rule) throw new Error(`Order ${order.id} has no promise rule`);
  const cond = rule.condition;
  if (cond.kind === "weather") return evaluateWeather(order, cond);
  return evaluateCarrier(order, cond);
}

// ---------- The loop ----------

function refundedThisMonth(): number {
  const month = now().toISOString().slice(0, 7); // same definition as /api/stats
  return cents(
    orders
      .all()
      .filter((o) => o.status === "refunded" && (o.resolved_at ?? "").startsWith(month))
      .reduce((s, o) => s + (o.payout_amount ?? 0), 0),
  );
}

function fallbackMessage(order: Order, productName: string, verdict: Verdict, amount: number): string {
  const name = order.buyer_name ? `Hi ${order.buyer_name.split(" ")[0]}, ` : "";
  const msg = `${name}we promised "${order.promise_snapshot?.badge ?? productName}" and missed it. We've refunded $${amount.toFixed(2)} automatically. ${verdict.reason}. Sorry, ${MERCHANT.name}`;
  return msg.length <= 255 ? msg : `${msg.slice(0, 252)}...`;
}

async function payOut(order: Order, verdict: Verdict): Promise<void> {
  const rule = order.promise_snapshot!.rule!;
  const amount = computePayout(rule, order);
  const productName = products.get(order.product_id)?.name ?? "your order";
  if (amount <= 0) {
    orders.update(order.id, { payout_amount: 0, resolved_at: now().toISOString() });
    logEvent("info", "Payout under this promise is $0.00 (nothing was charged for it), so there's nothing to refund.", order.id);
    return;
  }
  const used = refundedThisMonth();
  const budget = MERCHANT.monthly_guarantee_budget;
  if (used + amount > budget) {
    orders.update(order.id, { status: "failed", resolved_at: null });
    logEvent(
      "error",
      `Refund of $${amount.toFixed(2)} held: it would exceed the $${budget} monthly guarantee budget ($${used.toFixed(2)} already paid out). A human must approve it.`,
      order.id,
      { amount, budget, used },
    );
    return;
  }
  if (!order.paypal_capture_id) {
    orders.update(order.id, { status: "failed" });
    logEvent("error", `Can't refund $${amount.toFixed(2)}: order has no PayPal capture id. A human must review it.`, order.id, { amount });
    return;
  }

  let message: string;
  try {
    message = await writeRefundMessage(order, productName, verdict, amount);
  } catch (e) {
    message = fallbackMessage(order, productName, verdict, amount);
    logEvent("info", `Narrator unavailable (${(e as Error).message}); using the standard refund note.`, order.id);
  }

  try {
    const refund = await refundCapture(order.paypal_capture_id, amount, message, order.id);
    orders.update(order.id, { status: "refunded", payout_amount: amount, paypal_refund_id: refund.id, customer_message: message, resolved_at: now().toISOString() });
    logEvent("refund", `Refunded $${amount.toFixed(2)} to ${order.buyer_name ?? "buyer"} via PayPal (refund id ${refund.id}, ${refund.status})`, order.id, { amount, refund, message });
  } catch (e) {
    orders.update(order.id, { status: "failed", customer_message: message });
    logEvent("error", `PayPal refund of $${amount.toFixed(2)} failed: ${(e as Error).message}. A human must review it.`, order.id, { amount, error: (e as Error).message });
  }
}

function lastEvidenceByOrder(): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of agentEvents.all()) if (e.kind === "evidence" && e.order_id) m.set(e.order_id, e.message);
  return m;
}
const lastErrorByOrder = new Map<string, string>();

const ATTRIBUTION_LABEL: Record<OrderReview["attribution"], string> = {
  seller_side: "carrier/shop-side miss",
  buyer_caused: "possibly buyer-caused",
  unclear: "cause unclear",
};

/**
 * For carrier promises, ask Claude whether the buyer plausibly caused the miss. Stores the review on
 * the order BEFORE any refund, so a crash/retry reuses it instead of asking again. Returns true if
 * the payout is now held for the merchant. Claude can only pause a payout here, never create one.
 */
async function assessIfCarrier(order: Order, verdict: Verdict): Promise<boolean> {
  const kind = order.promise_snapshot?.rule?.condition.kind;
  if (kind !== "delivered_by" && kind !== "shipped_by") return false; // weather is measured data: no buyer fault possible
  if (order.review) return false; // already assessed (and not held, or we wouldn't be here)
  const productName = products.get(order.product_id)?.name ?? "the order";
  const events = order.tracking_number ? getCarrierEvents(order.tracking_number) : [];
  const a = await assessBreach(order, productName, verdict, events);
  if (!orders.get(order.id)) return true; // cleared by a demo reset while we waited
  const review: OrderReview = { attribution: a.attribution, reason: a.reason, confidence: a.confidence, assessed_at: now().toISOString(), decision: null, decided_at: null };
  const data = { ...review, hold: a.hold, latency_ms: a.latency_ms, error: a.error ?? null };
  if (a.error) {
    logEvent("assessment", `The Kept agent's review was unavailable (${a.error}), so Kept is paying by default.`, order.id, data);
  } else {
    const then = a.hold ? "pausing the refund for the merchant" : "paying automatically";
    logEvent("assessment", `Kept agent (Claude) reviewed the evidence: ${ATTRIBUTION_LABEL[a.attribution]} → ${then}. ${a.reason}`, order.id, data);
  }
  if (!a.hold) {
    orders.update(order.id, { review });
    return false;
  }
  orders.update(order.id, { status: "held", review });
  logEvent("hold", `Refund paused for ${MERCHANT.name} to review. The Kept agent can pause a payout, never create one.`, order.id, data);
  return true;
}

// Orders whose payout is running outside the tick (a merchant approving a held refund). The tick
// skips them so the same order is never paid out by two callers at once.
const payingOutsideTick = new Set<string>();

/**
 * The single refund path, shared by the watcher and the merchant's "Refund" decision on a held order:
 * computePayout, budget check, narrator note, PayPal refund with the same idempotency key (order id).
 */
export async function payOutOrder(orderId: string): Promise<Order | null> {
  const order = orders.get(orderId);
  if (!order) return null;
  const verdict = await evaluate(order);
  await payOut(order, verdict);
  return orders.get(orderId);
}

export class ReviewError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

/** Merchant decision on a held payout. Only valid while the order is `held`. */
export async function decideHeld(orderId: string, decision: "refund" | "decline"): Promise<Order> {
  const order = orders.get(orderId);
  if (!order) throw new ReviewError("not found", 404);
  if (order.status !== "held" || !order.review) throw new ReviewError(`Only held orders can be reviewed (this one is ${order.status}).`, 409);
  const t = now().toISOString();
  const review: OrderReview = { ...order.review, decision, decided_at: t };
  if (decision === "decline") {
    const updated = orders.update(orderId, { status: "declined", review, resolved_at: t });
    logEvent("info", `Merchant declined payout: reviewed the Kept agent's flag (“${order.review.reason}”) and kept the charge.`, orderId, { review });
    return updated;
  }
  // Flip to "breached" synchronously (no await in between), so a double click sees a non-held order.
  // If the process dies mid-refund, the tick's recovery path resumes it with the stored review.
  orders.update(orderId, { status: "breached", review });
  logEvent("info", `Merchant approved the refund after reviewing the Kept agent's flag.`, orderId, { review });
  payingOutsideTick.add(orderId);
  try {
    return (await payOutOrder(orderId)) ?? orders.get(orderId)!;
  } finally {
    payingOutsideTick.delete(orderId);
  }
}

async function processOrder(order: Order, lastEvidence: Map<string, string>): Promise<void> {
  // Resume a refund that was in flight when the process stopped (same idempotency key, safe to retry).
  // An order that was already assessed keeps its stored review; it is never re-assessed.
  if (order.status === "breached") {
    const verdict = await evaluate(order);
    if (await assessIfCarrier(order, verdict)) return;
    return payOut(orders.get(order.id) ?? order, verdict);
  }

  const rule = order.promise_snapshot?.rule;
  if (!rule) {
    const product = products.get(order.product_id);
    const delivered = order.tracking_number && getCarrierEvents(order.tracking_number).some((e) => e.status === "delivered");
    if (product?.kind === "experience" || delivered) {
      orders.update(order.id, { status: "kept", resolved_at: now().toISOString() });
      logEvent("info", product?.kind === "experience" ? "No promise on this order; closed." : "Delivered; no promise on this order, closed.", order.id);
    }
    return;
  }

  const verdict = await evaluate(order);
  if (lastEvidence.get(order.id) !== verdict.evidence.summary) {
    logEvent("evidence", verdict.evidence.summary, order.id, verdict.evidence);
    lastEvidence.set(order.id, verdict.evidence.summary);
  }
  if (!verdict.final) return;

  if (!verdict.breached) {
    orders.update(order.id, { status: "kept", resolved_at: now().toISOString() });
    logEvent("kept", verdict.reason, order.id, verdict.evidence);
    return;
  }
  const breached = orders.update(order.id, { status: "breached" });
  logEvent("breach", `Promise broken: ${verdict.evidence.summary}`, order.id, verdict.evidence);
  if (await assessIfCarrier(breached, verdict)) return; // held for the merchant: no refund, not counted toward the budget
  await payOut(orders.get(order.id) ?? breached, verdict);
}

async function runTick(): Promise<void> {
  const lastEvidence = lastEvidenceByOrder();
  // Held orders wait for the merchant and are never re-evaluated here.
  const todo = orders.all().filter((o) => (o.status === "paid" || (o.status === "breached" && !o.resolved_at)) && !payingOutsideTick.has(o.id));
  for (const order of todo) {
    if (!orders.get(order.id)) continue; // cleared by a demo reset mid-tick
    try {
      await processOrder(order, lastEvidence);
      lastErrorByOrder.delete(order.id);
    } catch (e) {
      if (!orders.get(order.id)) continue; // reset while we were checking it; nothing to report
      const msg = `Couldn't check this order: ${(e as Error).message}`;
      if (lastErrorByOrder.get(order.id) !== msg) logEvent("error", msg, order.id); // don't spam the log every interval
      lastErrorByOrder.set(order.id, msg);
    }
  }
}

// Module-level lock. A tick requested while one is running coalesces into a single follow-up
// tick, so demo endpoints that `await tick()` always see a pass that started after their change.
let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

/** One pass over all paid orders: evaluate, and refund breached ones (idempotently). */
export function tick(): Promise<void> {
  if (!running) {
    running = runTick().finally(() => {
      running = null;
    });
    return running;
  }
  if (!queued) {
    queued = running
      .catch(() => {})
      .then(() => {
        queued = null;
        return tick();
      });
  }
  return queued;
}

export function startWatcher(intervalMs: number): void {
  const run = () => tick().catch((e) => console.error("[watcher] tick failed:", e));
  setInterval(run, intervalMs);
  void run();
}
