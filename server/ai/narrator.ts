// Writes the buyer-facing message when a promise is broken and auto-refunded. OWNER: ai agent.
// The amount is computed by code and passed in; the model only explains it.
import type { Order, Verdict } from "../types.ts";

/** <= 255 chars (PayPal note_to_payer limit), warm, specific, cites the evidence. */
export async function writeRefundMessage(order: Order, productName: string, verdict: Verdict, amount: number): Promise<string> {
  throw new Error("not implemented");
}
