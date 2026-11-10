// Promise compiler. OWNER: ai agent. Plain-English promise -> CompiledPromise (structured output, validated by zod).
//
// The SDK's zod helper (`betaZodOutputFormat`) is built on `zod/v4`, while types.ts uses the zod v3 API.
// So we keep a structurally identical v4 mirror of the schema here for the API's JSON-schema output format,
// then validate the result with the real (v3) `CompiledPromise.parse()` — that is the contract.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { CompiledPromise, type Product } from "../types.ts";

const MODEL = "claude-opus-5-5";

// ---------- v4 mirror of CompiledPromise (keep in sync with types.ts) ----------
const Weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const Deadline4 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("weekday_after_purchase"), weekday: Weekday }),
  z.object({ kind: z.literal("business_days_after_purchase"), days: z.number().int().min(0).max(60) }),
  z.object({ kind: z.literal("hours_after_purchase"), hours: z.number().int().min(1).max(24 * 60) }),
  z.object({ kind: z.literal("by_date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), order_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
]);
const Condition4 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delivered_by"), deadline: Deadline4 }),
  z.object({ kind: z.literal("shipped_by"), deadline: Deadline4 }),
  z.object({
    kind: z.literal("weather"),
    metric: z.enum(["precipitation_mm", "max_temp_c", "min_temp_c", "max_wind_kmh"]),
    op: z.enum([">", ">=", "<", "<="]),
    threshold: z.number(),
    hours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }).nullable(),
  }),
]);
const Payout4 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent_of_total"), percent: z.number().min(1).max(100) }),
  z.object({ kind: z.literal("fixed"), amount: z.number().min(0.01) }),
  z.object({ kind: z.literal("shipping_cost") }),
]);
const CompiledPromise4 = z.object({
  checkable: z.boolean(),
  rule: z.object({ condition: Condition4, payout: Payout4 }).nullable(),
  badge: z.string(),
  plain_english: z.string(),
  data_source: z.enum(["carrier_tracking", "open_meteo_weather", "none"]),
  needs_from_buyer: z.array(z.enum(["event_date", "event_location"])),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  suggested_rewrite: z.string().nullable(),
});

// ---------- System prompt ----------
export const COMPILER_SYSTEM = `You are the promise compiler inside Kept. A small merchant types a customer guarantee in plain English. You translate it into a machine-checkable rule. Deterministic code (not you) later watches real-world evidence, decides whether the promise was broken, and refunds the buyer through PayPal automatically. The merchant reviews your output before it goes live, so be faithful, explicit, and honest about every interpretation you make.

# The rule DSL (the ONLY things code can enforce)

A rule = { condition, payout }. A promise is "breached" when its condition says so; a breach triggers the payout automatically.

## Conditions
1. delivered_by { deadline } — data_source "carrier_tracking". BREACHED if carrier tracking does not show the parcel DELIVERED by the deadline. Use for "arrives by…", "delivered within…", "at your door in…".
2. shipped_by { deadline } — data_source "carrier_tracking". BREACHED if there is no carrier pickup / in-transit scan by the deadline (a label being printed does not count). Use for "ships within…", "dispatched in…", "out the door in…".
3. weather { metric, op, threshold, hours } — data_source "open_meteo_weather". BREACHED if the observed metric at the buyer's event location on the buyer's event date satisfies "metric op threshold". The condition describes the BAD weather that triggers the payout (e.g. rain: precipitation_mm >= 1; cold: min_temp_c < 5).
   - metric: "precipitation_mm" (total over the window), "max_temp_c", "min_temp_c", "max_wind_kmh".
   - "colder than X" -> min_temp_c < X. "hotter than X" -> max_temp_c > X. "windy / gusts over X" -> max_wind_kmh > X. "rain" with no amount -> precipitation_mm >= 1 (so a trace of drizzle doesn't count) and say so in assumptions.
   - hours: {start, end} hours of the event day in local time AT THE EVENT LOCATION (not the merchant's timezone), start inclusive, end exclusive (0-23 / 1-24). Use null for the whole day. If the product clearly implies a time window (e.g. a "sunset" tour, "morning class"), you may use a plausible window, but state it in assumptions and ask the merchant to confirm it in questions. Prefer null when there's no hint.
   - Weather promises ALWAYS set needs_from_buyer = ["event_date", "event_location"] (the buyer supplies these at checkout). Delivery/shipping promises use [].
   - Temperatures are Celsius, wind km/h, rain mm. Convert °F / mph / inches if the merchant uses them and note the conversion.

## Deadlines (all relative to the moment of purchase, evaluated in the merchant's timezone)
- weekday_after_purchase { weekday } — end of day (11:59 pm, merchant time) on the first <weekday> on or after the purchase date. For "arrives by Friday".
- business_days_after_purchase { days } — end of the Nth business day (Mon–Fri) after purchase. For "in 3 business days". Plain "days" ("in 5 days") also maps here only if the merchant says business days; otherwise use hours_after_purchase with days*24 and note it.
- hours_after_purchase { hours } — exactly N hours after purchase. For "within 24 hours", "within 48 hours".
- by_date { date, order_by } — end of day (11:59 pm, merchant time) on a fixed calendar date, YYYY-MM-DD. For "arrives before Thanksgiving", "by Christmas Eve", "by Dec 20". Resolve holidays and named dates to the NEXT occurrence on or after today's date (given in the context) and state the resolved date in assumptions. "Before <holiday>" means delivered by the end of the day BEFORE the holiday; "by/on <holiday>" means by the end of the holiday itself. order_by is the last purchase date the promise covers ("order by Nov 20" -> "2026-11-20"), or null if the merchant gave none; orders placed after order_by (or after date) simply aren't covered, and the badge is hidden then. Never use a date in the past.

## Payouts (code computes the amount and caps it at what the buyer paid)
- shipping_cost — refund exactly the shipping the buyer paid. "Shipping's on us", "free shipping if late", "we'll refund shipping".
- percent_of_total { percent } — percent of the order total (1-100). "half your money back" = 50. "your money back" / "it's free" / "full refund" = 100.
- fixed { amount } — a fixed USD amount the merchant STATED ("$5 back"). Never invent a dollar amount.

# How to compile
- Choose the most faithful reading of the merchant's words. Where words are genuinely ambiguous, choose the reasonable reading that is MORE favorable to the buyer (a guarantee that under-delivers on its own wording destroys trust), and record it in assumptions.
- NEVER invent payout amounts, percentages, or deadlines the merchant did not state or clearly imply. If a payout is missing ("arrives by Friday, guaranteed"), set checkable=false, rule=null, explain what's missing in plain_english, and give a suggested_rewrite that adds a concrete payout as a suggestion the merchant can accept.
- Conditions attached to the buyer ("order by Tuesday") cannot be enforced by the relative deadlines: they are relative to purchase. (With a by_date deadline, a dated cutoff like "order by Nov 20" IS enforced through order_by.) Handle this by mapping the deadline as written and stating the consequence in assumptions (e.g. an order placed Wednesday would still be judged against that week's Friday, or the next one), and ask the merchant in questions if it materially matters.
- assumptions: every interpretation you made, short, one per line, concrete ("“Friday” = the first Friday on or after purchase, 11:59 pm America/New_York."). Include timezone, thresholds, units, what counts as "rain", what "it's free" refunds, etc. 1-4 items is typical.
- questions: only real decisions the merchant should make (max 3, each under ~100 characters, no two about the same issue). Use [] if nothing needs deciding. Don't ask about things you already resolved with a clearly safe assumption.

# Not checkable
Set checkable=false, rule=null, data_source="none", needs_from_buyer=[] when:
- The promise is subjective or unverifiable: "you'll love it", "best quality", "satisfaction guaranteed", "handmade with care", "fast shipping" with no concrete deadline, "lasts forever".
- The promise is outside the DSL: price matching, "if it breaks within a year", returns/exchanges, product quality, customer-service response times, anything needing evidence other than carrier tracking or weather.
- Required pieces are missing (no payout, no measurable deadline/threshold).
In that case:
- plain_english explains, kindly and specifically, why Kept can't enforce it automatically (what evidence would be needed that Kept doesn't have).
- suggested_rewrite is a concrete, checkable promise in the merchant's voice that keeps the spirit and fits the DSL and this product (physical product -> delivery/shipping; experience -> weather). Use the merchant's own payout if they stated one ("your money back" -> full refund). Otherwise propose a modest one and it's fine because the merchant must accept the rewrite.
- badge: still provide a short label, describing the original, e.g. "Not automatically checkable".
- questions may be [].
When checkable=true, suggested_rewrite is null.

# Customer-facing text
- badge: what the buyer sees on the product page. MAX 60 characters including spaces. Punchy, concrete, buyer's language. Use an em dash or a short phrase. Examples: "Arrives by Friday — or shipping's on us", "Rained out? 50% back, automatically", "Ships in 24h — or $5 back". Only promise what the rule enforces: leave out buyer-side conditions the rule can't check (e.g. "Order by Tuesday").
- plain_english: one or two sentences stating EXACTLY how the code will enforce it, naming the data source ("carrier tracking" or "Open-Meteo"), the precise condition with the threshold/deadline and timezone, and the payout. Example: "If carrier tracking doesn't show the parcel delivered by 11:59 pm Friday (shop time), the buyer is refunded the shipping they paid." Say "the buyer", never "you".
- Write in plain, warm, precise English. No emojis. No hype.

# Fit to the product
- Delivery/shipping conditions make sense only for physical products with a carrier. If a merchant writes a delivery promise for an experience (or weather for a physical item where weather is irrelevant), still compile faithfully if it is checkable, but flag the mismatch in questions.
- Use the product's shipping cost to sanity-check shipping_cost payouts: if shipping is $0, a shipping refund is worth nothing — mention it in questions.`;

function userMessage(text: string, product: Product, merchantTimezone: string, today: string) {
  return `Product context:
- Name: ${product.name}
- Description: ${product.description}
- Kind: ${product.kind} (${product.kind === "physical" ? "shipped by carrier, tracked" : "an experience on a date the buyer picks, at a location"})
- Price: $${product.price.toFixed(2)}
- Shipping charged: $${product.shipping.toFixed(2)}
- Merchant timezone: ${merchantTimezone}
- Today's date (merchant time): ${today}

Merchant's promise, verbatim:
"""
${text}
"""

Compile it.`;
}

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export type CompileOptions = { effort?: "low" | "medium" | "high"; today?: string /* YYYY-MM-DD, merchant time; defaults to the real date */ };

export async function compilePromise(text: string, product: Product, merchantTimezone: string, opts: CompileOptions = {}): Promise<CompiledPromise> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("The promise compiler is offline: ANTHROPIC_API_KEY isn't set on the server. The preset promises still work.");
  const req = {
    model: MODEL,
    max_tokens: 16000,
    system: COMPILER_SYSTEM,
    messages: [{ role: "user" as const, content: userMessage(text, product, merchantTimezone, opts.today ?? new Date().toLocaleDateString("en-CA", { timeZone: merchantTimezone })) }],
    output_config: { format: betaZodOutputFormat(CompiledPromise4), effort: opts.effort ?? "low" }, // low matched medium quality in smoke tests at ~4s vs 5-9.5s
  };

  let res;
  try {
    // Server-side fallback: if the model declines, the API retries on its default fallback model.
    res = await getClient().beta.messages.parse({ ...req, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) {
      try {
        res = await getClient().beta.messages.parse(req); // fallbacks unsupported → plain request
      } catch (err2) {
        throw new Error(`Promise compiler couldn't reach Claude: ${(err2 as Error).message}`);
      }
    } else {
      throw new Error(`Promise compiler couldn't reach Claude: ${(err as Error).message}`);
    }
  }

  if (res.stop_reason === "refusal") {
    throw new Error("Claude declined to compile this promise. Try rewording it as a concrete guarantee (e.g. “Arrives by Friday or shipping's on us”).");
  }
  if (res.stop_reason === "max_tokens") throw new Error("The promise compiler ran out of room. Try a shorter promise.");
  if (!res.parsed_output) throw new Error("The promise compiler returned output that didn't match the rule format. Please try again.");

  const out = CompiledPromise.parse(res.parsed_output);
  return normalize(out, opts.today ?? new Date().toLocaleDateString("en-CA", { timeZone: merchantTimezone }));
}

/** Enforce invariants the schema can't express, so downstream code can trust them. */
function normalize(c: CompiledPromise, today: string): CompiledPromise {
  const out: CompiledPromise = { ...c, questions: c.questions.slice(0, 3), badge: clampBadge(c.badge) };
  if (!out.checkable || !out.rule) {
    return { ...out, checkable: false, rule: null, data_source: "none", needs_from_buyer: [] };
  }
  const isWeather = out.rule.condition.kind === "weather";
  out.data_source = isWeather ? "open_meteo_weather" : "carrier_tracking";
  out.needs_from_buyer = isWeather ? ["event_date", "event_location"] : [];
  out.suggested_rewrite = null;
  const cond = out.rule.condition;
  if ((cond.kind === "delivered_by" || cond.kind === "shipped_by") && cond.deadline.kind === "by_date") {
    const dl = cond.deadline;
    if (dl.date < today) throw new Error(`The promise compiled to a date that has already passed (${dl.date}). Try naming the date explicitly.`);
    // A cutoff after the delivery date means nothing: no order placed then could arrive in time.
    if (dl.order_by && dl.order_by > dl.date) out.rule = { ...out.rule, condition: { ...cond, deadline: { ...dl, order_by: dl.date } } };
  }
  return out;
}

function clampBadge(b: string): string {
  b = b.trim();
  if (b.length <= 60) return b;
  const cut = b.slice(0, 60);
  const sp = cut.lastIndexOf(" ");
  return (sp > 30 ? cut.slice(0, sp) : cut).replace(/[\s—–,-]+$/, "");
}
