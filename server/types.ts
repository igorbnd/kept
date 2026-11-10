// Shared contracts for Kept. Every module (PayPal, AI, watcher, web) codes against these.
//
// The core idea: Claude *compiles* a merchant's plain-English promise into a PromiseRule.
// Code — never the model — evaluates the rule against evidence and computes the payout,
// and the payout is always capped. The model explains; it never decides the amount.

import { z } from "zod";

// ---------- Promise rule DSL (what Claude compiles to) ----------

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Deadline = z.discriminatedUnion("kind", [
  // "arrives by Friday" -> the first <weekday> on/after purchase (end of day, merchant tz)
  z.object({ kind: z.literal("weekday_after_purchase"), weekday: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) }),
  // "within 3 business days"
  z.object({ kind: z.literal("business_days_after_purchase"), days: z.number().int().min(0).max(60) }),
  // "within 48 hours"
  z.object({ kind: z.literal("hours_after_purchase"), hours: z.number().int().min(1).max(24 * 60) }),
  // "arrives before Thanksgiving" -> end of a fixed calendar date (merchant tz). Orders placed after
  // `order_by` (or after `date` itself) aren't covered: the promise is closed and isn't offered.
  z.object({ kind: z.literal("by_date"), date: IsoDate, order_by: IsoDate.nullable() }),
]);
export type Deadline = z.infer<typeof Deadline>;

export const Condition = z.discriminatedUnion("kind", [
  // Breached if the parcel is not DELIVERED by the deadline.
  z.object({ kind: z.literal("delivered_by"), deadline: Deadline }),
  // Breached if the parcel has no carrier scan (picked up / in transit) by the deadline.
  z.object({ kind: z.literal("shipped_by"), deadline: Deadline }),
  // Breached if the weather metric crosses the threshold at the order's location on the order's event date.
  z.object({
    kind: z.literal("weather"),
    metric: z.enum(["precipitation_mm", "max_temp_c", "min_temp_c", "max_wind_kmh"]),
    op: z.enum([">", ">=", "<", "<="]),
    threshold: z.number(),
    // Hours of the event day to look at, local time, inclusive start / exclusive end. Default whole day.
    hours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }).nullable(),
  }),
]);
export type Condition = z.infer<typeof Condition>;

export const Payout = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent_of_total"), percent: z.number().min(1).max(100) }),
  z.object({ kind: z.literal("fixed"), amount: z.number().min(0.01) }),
  z.object({ kind: z.literal("shipping_cost") }), // refund exactly what the buyer paid for shipping
]);
export type Payout = z.infer<typeof Payout>;

export const PromiseRule = z.object({
  condition: Condition,
  payout: Payout,
});
export type PromiseRule = z.infer<typeof PromiseRule>;

// What the compiler returns to the merchant for review.
export const CompiledPromise = z.object({
  checkable: z.boolean(), // false => promise is subjective/unverifiable ("you'll love it")
  rule: PromiseRule.nullable(), // null when !checkable
  badge: z.string(), // short customer-facing badge, e.g. "Arrives by Friday — or shipping's on us"
  plain_english: z.string(), // exactly how it will be enforced, one or two sentences
  data_source: z.enum(["carrier_tracking", "open_meteo_weather", "none"]),
  needs_from_buyer: z.array(z.enum(["event_date", "event_location"])), // weather promises need these at checkout
  assumptions: z.array(z.string()), // interpretations Claude made ("Friday = end of day in your timezone")
  questions: z.array(z.string()), // ambiguities the merchant should resolve
  suggested_rewrite: z.string().nullable(), // when !checkable: a checkable version of the promise
});
export type CompiledPromise = z.infer<typeof CompiledPromise>;

// ---------- Persisted entities ----------

export type Product = {
  id: string;
  name: string;
  description: string;
  price: number; // USD
  shipping: number; // USD, 0 for services
  image: string; // emoji or URL
  kind: "physical" | "experience";
  promise_id: string | null;
};

export type PromiseRecord = {
  id: string;
  product_id: string;
  source_text: string; // merchant's original words
  compiled: CompiledPromise;
  status: "draft" | "active" | "retired";
  created_at: string;
};

export type OrderStatus =
  | "created" // PayPal order created, not captured
  | "paid" // captured, promise being watched
  | "kept" // promise fulfilled, no payout needed (final)
  | "breached" // breach detected, refund in flight
  | "refunded" // payout sent (final)
  | "failed" // refund attempt failed — needs a human
  | "held" // breach found, but Claude flagged the miss as possibly buyer-caused: payout paused for the merchant
  | "declined"; // merchant reviewed a held payout and declined it (final)

// Claude's read of a broken carrier promise. Claude may only PAUSE a payout for the merchant;
// it can never create one, change an amount, or approve anything. Code still computes every dollar.
export type Attribution = "seller_side" | "buyer_caused" | "unclear";
export type BreachAssessment = {
  attribution: Attribution;
  hold: boolean; // always attribution !== "seller_side" (enforced in code)
  reason: string; // <= 200 chars, plain English, cites the scan
  confidence: "low" | "medium" | "high";
};
export type OrderReview = {
  attribution: Attribution;
  reason: string;
  confidence: BreachAssessment["confidence"];
  assessed_at: string;
  decision: "refund" | "decline" | null; // merchant's call on a held payout (null when not held / undecided)
  decided_at: string | null;
};

export type Order = {
  id: string;
  product_id: string;
  promise_id: string | null;
  promise_snapshot: CompiledPromise | null; // frozen at purchase — buyer gets the promise they saw
  paypal_order_id: string;
  paypal_capture_id: string | null;
  amount_total: number;
  amount_shipping: number;
  buyer_name: string | null;
  buyer_email: string | null;
  event_date: string | null; // YYYY-MM-DD, for experience promises
  event_location: { name: string; lat: number; lon: number } | null;
  tracking_number: string | null;
  status: OrderStatus;
  deadline_at: string | null; // ISO, computed at capture for delivery/ship promises
  payout_amount: number | null;
  paypal_refund_id: string | null;
  customer_message: string | null; // Claude-written note shown to buyer / sent as note_to_payer
  created_at: string;
  resolved_at: string | null;
  review?: OrderReview | null; // Claude's assessment of a carrier breach (absent on older rows)
};

export type CarrierEvent = {
  id: string;
  tracking_number: string;
  status: "label_created" | "picked_up" | "in_transit" | "delayed" | "exception" | "out_for_delivery" | "delivered"; // exception = attempted / returned / held; not delivered
  description: string;
  location: string;
  at: string; // ISO (simulated clock)
};

// One line in the agent's audit trail. Every decision the watcher makes is logged with its evidence.
export type AgentEvent = {
  id: string;
  order_id: string | null;
  kind: "compiled" | "watching" | "evidence" | "kept" | "breach" | "refund" | "error" | "info" | "assessment" | "hold";
  message: string;
  data: unknown;
  at: string;
};

// Evidence returned by a data source, evaluated by code.
export type Evidence = {
  source: "carrier_tracking" | "open_meteo_weather";
  observed: Record<string, unknown>; // raw observation (e.g. { precipitation_mm: 6.2 } or last carrier event)
  summary: string; // human-readable one-liner
  final: boolean; // true once the outcome can no longer change (deadline passed / day over / delivered)
};

export type Verdict = { breached: boolean; final: boolean; reason: string; evidence: Evidence };
