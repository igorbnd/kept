// Promise ideas. OWNER: ai agent. Given a product and the moment (season, holidays, local time,
// the real forecast), the Kept agent (Claude) proposes promises worth offering right now.
// Ideas are only text: each one still goes through the compiler, the merchant's approval and the
// same payout caps. Pricing is computed by code (server/pricing.ts), never by the model.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { ClimateSummary, MomentContext } from "../sources/context.ts";
import type { Product } from "../types.ts";

const MODEL = "claude-opus-5-5";

export const FACTORS = ["product", "season", "holiday", "weekday", "time_of_day", "forecast", "history", "location"] as const;
export type Factor = (typeof FACTORS)[number];

const Ideas4 = z.object({
  ideas: z.array(
    z.object({
      title: z.string(), // 2-5 words
      promise_text: z.string(), // in the merchant's voice, ready to compile
      why: z.string(), // why now, citing the factors
      factors: z.array(z.enum(FACTORS)),
    }),
  ),
});
export type PromiseIdea = z.infer<typeof Ideas4>["ideas"][number];

export const SUGGESTER_SYSTEM = `You are the Kept agent's promise designer. Kept lets a small merchant attach a guarantee to a product; code then checks real evidence and refunds the buyer through PayPal automatically when the promise breaks.

Your job: propose exactly 3 promises this merchant could offer on this product RIGHT NOW, each one shaped by the intersection of the product and the moment: the season, upcoming holidays, the day of the week and time of day, the real weather forecast at the shop, and the location. The best ideas feel specific to this week, at this place, for this product; something a buyer would smile at and remember. A generic "arrives in 3 days" is a weak idea unless the moment makes it matter.

# What Kept can enforce (ideas MUST fit one of these, or they can't go live)
- Physical products (shipped by carrier): "delivered by" or "shipped by" a deadline. Deadlines can be a weekday ("by Friday"), N business days, N hours, or a fixed calendar date ("before Thanksgiving", "by Dec 23"), optionally with an order-by cutoff date ("order by Nov 20").
- Experiences (a date and place the buyer picks): bad weather during the experience, measured by Open-Meteo: rain (mm), high or low temperature (°C), or wind (km/h), optionally within hours of the day.
- Payout: the shipping cost, a percent of the total (1–100), or a fixed dollar amount.

# Rules
- Every promise is about the service the buyer actually gets: delivery timing for things that ship, the conditions of the experience for experiences. Never tie a payout to chance unrelated to what was bought (no "if it snows on your delivery day, 20% off" for a mug; no lottery or contest mechanics). That would make it a bet, not a guarantee.
- Each promise_text is in the merchant's own warm, plain voice, one sentence, under 140 characters, with a concrete condition and a concrete payout. Keep payouts modest and plausible for a small shop: shipping back, 10–25% back, or 50% back for a ruined experience. Use 100% only for something the buyer truly can't enjoy.
- Holiday dates must be dates from the context, and only holidays within reach of shipping (for a fixed-date delivery promise, include an order-by cutoff that leaves at least 3 business days).
- For experiences you also get the weather HISTORY of these same weeks over past years. Use it to set thresholds: a good weather promise pays out on roughly 5–25% of days, rare enough for a small shop to afford, common enough to mean something. A threshold that the history says is crossed on most days is a discount, not a guarantee; avoid it. Mention the history in "why" when it shaped the threshold.
- A weather promise covers every booking; it cannot be limited to certain booking dates or weeks ("book Thanksgiving week and…"). Don't write conditions the rule can't check.
- Use the forecast honestly. If it shows a windy or wet spell, an experience promise about that is timely; say so in "why" with the actual numbers. Never invent weather or facts not in the context.
- Make the 3 ideas different from each other (different factor, different mechanic), and different from the product's current live promise if it has one.
- title: 2–5 words, catchy but clear, e.g. "Thanksgiving table guarantee", "Gale-day refund".
- why: one sentence, under 160 characters, naming the specific factors (e.g. "Thanksgiving is 16 days out and mugs are a top host gift; a dated cutoff keeps the risk to 3 business days.").
- factors: the context factors the idea actually uses.
- No emojis. No hype words like "amazing" or "ultimate".`;

function climateLines(c: ClimateSummary): string {
  return `- Weather history at the shop, ${c.window} in each of the last ${c.years} years (${c.days} days, Open-Meteo archive):
  - Days with rain ≥ 1 mm: ${c.rain_days_pct.at_least_1mm}%; ≥ 5 mm: ${c.rain_days_pct.at_least_5mm}%; rain ≥ 1 mm between 4 and 8 pm: ${c.rain_days_pct.evening_at_least_1mm}%
  - Daily low °C: 10th pct ${c.low_c.p10}, median ${c.low_c.p50}, 90th pct ${c.low_c.p90}
  - Daily high °C: 10th pct ${c.high_c.p10}, median ${c.high_c.p50}, 90th pct ${c.high_c.p90}
  - Low between 4 and 8 pm °C: 10th pct ${c.evening_low_c.p10}, median ${c.evening_low_c.p50}, 90th pct ${c.evening_low_c.p90}
  - Daily max wind km/h: median ${c.max_wind_kmh.p50}, 90th pct ${c.max_wind_kmh.p90}; days over 25: ${c.max_wind_kmh.days_over_25_pct}%; over 30: ${c.max_wind_kmh.days_over_30_pct}%`;
}

function userMessage(product: Product, livePromise: string | null, ctx: MomentContext, climate: ClimateSummary | null): string {
  const fc = ctx.forecast.length
    ? ctx.forecast.map((d) => `  - ${d.weekday} ${d.date}: rain ${d.rain_mm} mm${d.rain_chance_pct != null ? ` (${d.rain_chance_pct}% chance)` : ""}, high ${d.high_c} °C, low ${d.low_c} °C, wind up to ${d.wind_max_kmh} km/h`).join("\n")
    : "  (forecast unavailable; don't mention specific weather)";
  const hol = ctx.upcoming_holidays.length ? ctx.upcoming_holidays.map((h) => `  - ${h.name}: ${h.date} (${h.days_away} days away)`).join("\n") : "  (none in the next 60 days)";
  return `Product:
- Name: ${product.name}
- Description: ${product.description}
- Kind: ${product.kind === "physical" ? "physical, shipped by carrier" : "experience on a date the buyer picks, at the shop's location"}
- Price: $${product.price.toFixed(2)}; shipping charged: $${product.shipping.toFixed(2)}
- Current live promise: ${livePromise ? `"${livePromise}"` : "none"}

The moment (shop time):
- Today: ${ctx.weekday} ${ctx.today}, ${ctx.part_of_day}
- Season: ${ctx.season}
- Shop location: ${ctx.location}
- Upcoming holidays:
${hol}
- 7-day forecast at the shop (Open-Meteo):
${fc}
${climate ? climateLines(climate) + "\n" : ""}
Propose 3 promises.`;
}

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

export async function suggestPromises(product: Product, livePromise: string | null, ctx: MomentContext, climate: ClimateSummary | null = null): Promise<PromiseIdea[]> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Promise ideas are offline: ANTHROPIC_API_KEY isn't set on the server.");
  const req = {
    model: MODEL,
    max_tokens: 16000,
    system: SUGGESTER_SYSTEM,
    messages: [{ role: "user" as const, content: userMessage(product, livePromise, ctx, climate) }],
    output_config: { format: betaZodOutputFormat(Ideas4), effort: "low" as const },
  };
  let res;
  try {
    res = await getClient().beta.messages.parse({ ...req, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw new Error(`Couldn't reach Claude for promise ideas: ${(err as Error).message}`);
    res = await getClient().beta.messages.parse(req);
  }
  if (res.stop_reason === "refusal") throw new Error("Claude declined to suggest promises for this product.");
  if (!res.parsed_output) throw new Error("The idea generator returned output in the wrong shape. Please try again.");
  return res.parsed_output.ideas
    .slice(0, 3)
    .map((i) => ({ ...i, title: i.title.trim().slice(0, 48), promise_text: i.promise_text.trim().slice(0, 200), why: i.why.trim().slice(0, 220), factors: [...new Set(i.factors)] }));
}
