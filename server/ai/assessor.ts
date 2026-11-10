// Breach assessor. Asked once, when a carrier promise is finally broken, before any refund:
// "does the carrier evidence suggest the BUYER caused the miss?"
//
// Asymmetric power: Claude may only PAUSE a payout for the merchant to decide. It can never create a
// payout, change an amount, or approve anything; code still computes every dollar. Any failure
// (no key, timeout, refusal, bad output) returns seller_side / no hold, so the model being down never
// blocks a refund.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import type { BreachAssessment, CarrierEvent, Order, Verdict } from "../types.ts";
import { logUsage, MODEL } from "./model.ts";

const TIMEOUT_MS = 15_000;
const MAX_REASON = 200;

const Assessment4 = z.object({
  attribution: z.enum(["seller_side", "buyer_caused", "unclear"]),
  reason: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export const ASSESSOR_SYSTEM = `You review broken delivery promises for Kept, which refunds buyers automatically when a small shop's guarantee is missed. A carrier promise (e.g. "Arrives by Friday — or shipping's on us") has just been judged BROKEN by deterministic code. Before the refund goes out, you answer one narrow question: does the carrier evidence show that the BUYER's own action or inaction plausibly caused the miss?

Your power is deliberately one-sided. If you flag the case, the refund is only PAUSED and the merchant decides. You can never create a payout, change an amount, or deny one yourself. The default is to pay.

# Attribution
- seller_side: the merchant made the promise and carries ordinary carrier, weather and operational risk. Delays, weather, hub backlogs, missed connections, mis-sorts, damaged or lost parcels, late pickup, label created but never scanned, slow transit, "out for delivery" that never arrived, no scans at all — all seller_side. This is the default.
- buyer_caused: the scans specifically show the buyer's own action or inaction caused the miss. Examples: delivery attempted but no one available to sign for a signature-required parcel; address incomplete, wrong or undeliverable as supplied by the buyer; buyer refused delivery; held or redirected at the buyer's request; buyer did not collect from a pickup point.
- unclear: a genuine delivery exception whose cause could reasonably be either side (e.g. "Returned to sender" with no reason, "Delivery exception" with no detail, "Access to delivery location restricted").
When torn between seller_side and unclear, choose seller_side. Only choose buyer_caused when a scan says so concretely. Never speculate beyond the scans. Judge what the scans SAY, not their timestamps: scan times may be clustered or simulated, so don't comment on timing.

# Output
- reason: at most ${MAX_REASON} characters, plain English for the merchant, quoting or naming the decisive scan (what it said, where). No emojis.
- confidence: how clearly the scans support your attribution.`;

/** Default when the model can't be asked: pay, exactly as if Claude had said seller_side. */
export const UNAVAILABLE: BreachAssessment = { attribution: "seller_side", hold: false, reason: "Assessment unavailable — paying by default", confidence: "low" };

export type AssessResult = BreachAssessment & { error?: string; latency_ms: number };

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ maxRetries: 1, timeout: TIMEOUT_MS }));

function clip(s: string, max: number): string {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, "") + "…";
}

export async function assessBreach(order: Order, productName: string, verdict: Verdict, carrierEvents: CarrierEvent[]): Promise<AssessResult> {
  const t0 = Date.now();
  const fail = (error: string): AssessResult => ({ ...UNAVAILABLE, error, latency_ms: Date.now() - t0 });
  if (!process.env.ANTHROPIC_API_KEY) return fail("ANTHROPIC_API_KEY isn't set");

  const facts = {
    product: productName,
    promise: order.promise_snapshot?.badge ?? null,
    how_it_is_enforced: order.promise_snapshot?.plain_english ?? null,
    deadline: order.deadline_at,
    why_code_judged_it_broken: verdict.reason,
    evidence_summary: verdict.evidence.summary,
    carrier_scans_oldest_first: carrierEvents.map((e) => ({ status: e.status, description: e.description, location: e.location, at: e.at })),
  };
  const req = {
    model: MODEL,
    max_tokens: 4000,
    system: ASSESSOR_SYSTEM,
    messages: [{ role: "user" as const, content: `Facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\nAssess the breach.` }],
    output_config: { format: betaZodOutputFormat(Assessment4) },
  };

  try {
    const res = await getClient().beta.messages.parse(req);
    logUsage("assessor", res.usage);
    if (res.stop_reason === "refusal") return fail("Claude declined to assess");
    const out = res.parsed_output;
    if (!out) return fail(`unparseable output (stop_reason ${res.stop_reason})`);
    const parsed = Assessment4.parse(out);
    const reason = clip(parsed.reason, MAX_REASON) || "No reason given.";
    // The hold is derived in code from the attribution: the model doesn't get a separate "hold" lever.
    return { attribution: parsed.attribution, hold: parsed.attribution !== "seller_side", reason, confidence: parsed.confidence, latency_ms: Date.now() - t0 };
  } catch (e) {
    return fail((e as Error).message || "request failed");
  }
}
