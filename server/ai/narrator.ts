// Writes the buyer-facing message when a promise is broken and auto-refunded. OWNER: ai agent.
// The amount is computed by code and passed in; the model only explains it.
// The refund must never be blocked by the model: any failure falls back to a deterministic template.
import Anthropic from "@anthropic-ai/sdk";
import type { Order, Verdict } from "../types.ts";

const MODEL = "claude-opus-5-5";
const SHOP = "Harbor & Clay";
const SIGNATURE = `— ${SHOP}`;
const MAX = 255; // PayPal note_to_payer limit
const TIMEOUT_MS = 15000;

const SYSTEM = `You write the short note a buyer receives with an automatic refund from ${SHOP}, a small shop. The shop made a guarantee, the guarantee was broken, and the refund has ALREADY been sent. Write the note body only.

Rules:
- At most 200 characters. One to three short sentences. Do NOT include a signature; it is added for you.
- Address the buyer by first name if given. Warm, human, specific, a little apologetic, never groveling.
- Cite the actual evidence concretely (what tracking or the weather record showed, where and when), taken from the facts provided. Do not invent facts.
- State the exact refund amount and say plainly it's already on its way and they don't need to do anything.
- No emojis, no exclamation-mark spam, no corporate filler ("we value your business", "we apologize for any inconvenience"), no quotes around the whole message.`;

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

function firstName(order: Order): string | null {
  const n = order.buyer_name?.trim().split(/\s+/)[0];
  return n ? n : null;
}

/** Truncate to fit `max` on a word boundary, adding an ellipsis if cut. */
function clip(s: string, max: number): string {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, "") + "…";
}

/** Body + signature, guaranteed <= 255 chars. */
function sign(body: string): string {
  return `${clip(body, MAX - SIGNATURE.length - 1)} ${SIGNATURE}`;
}

export function fallbackRefundMessage(order: Order, productName: string, verdict: Verdict, amount: number): string {
  const hi = firstName(order) ? `Hi ${firstName(order)}, ` : "";
  const raw = (verdict.evidence?.summary || verdict.reason).trim();
  const why = raw.charAt(0).toLowerCase() + raw.slice(1);
  const body = `${hi}we promised more on your ${productName} and didn't deliver: ${why.replace(/\.$/, "")}. ${money(amount)} is already on its way back to you, nothing to do.`;
  if (body.length <= MAX - SIGNATURE.length - 1) return sign(body);
  // Too long with evidence: drop to a shorter evidence-free version rather than chopping the amount off.
  return sign(`${hi}your ${productName} promise wasn't kept, so ${money(amount)} is already on its way back to you. Nothing to do. ${clip(why, 90)}`);
}

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ maxRetries: 1, timeout: TIMEOUT_MS }));

/** <= 255 chars (PayPal note_to_payer limit), warm, specific, cites the evidence. */
export async function writeRefundMessage(order: Order, productName: string, verdict: Verdict, amount: number): Promise<string> {
  const facts = {
    buyer_first_name: firstName(order),
    product: productName,
    promise: order.promise_snapshot?.badge ?? null,
    how_it_was_enforced: order.promise_snapshot?.plain_english ?? null,
    what_happened: verdict.reason,
    evidence_summary: verdict.evidence?.summary ?? null,
    evidence_observed: verdict.evidence?.observed ?? null,
    event_date: order.event_date,
    event_location: order.event_location?.name ?? null,
    refund_amount: money(amount),
    order_total: money(order.amount_total),
  };
  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: `Facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\nWrite the note.` }],
      output_config: { effort: "low" },
    });
    if (res.stop_reason === "refusal") throw new Error("refusal");
    const text = res.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join(" ")
      .trim()
      .replace(/^["“]|["”]$/g, "")
      .replace(new RegExp(`\\s*[—-]+\\s*${SHOP.replace(/[&]/g, "\\&")}\\.?\\s*$`), ""); // drop a self-added signature
    if (!text) throw new Error("empty");
    return sign(text);
  } catch {
    return fallbackRefundMessage(order, productName, verdict, amount);
  }
}
