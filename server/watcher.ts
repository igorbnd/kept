// The promise-keeping agent loop. OWNER: watcher agent.
// Deterministic: code evaluates rules and computes payouts; Claude only writes the message.
import type { Deadline, Order, PromiseRule, Verdict } from "./types.ts";

/** Deadline instant for delivery/ship promises, from purchase time, in the merchant timezone. */
export function computeDeadline(deadline: Deadline, purchasedAt: Date, timezone: string): Date {
  throw new Error("not implemented");
}
/** Payout in USD, rounded to cents, never more than the amount captured. */
export function computePayout(rule: PromiseRule, order: Order): number {
  throw new Error("not implemented");
}
/** Gather evidence and evaluate one order's promise. */
export async function evaluate(order: Order): Promise<Verdict> {
  throw new Error("not implemented");
}
/** One pass over all paid orders: evaluate, and refund breached ones (idempotently). */
export async function tick(): Promise<void> {
  throw new Error("not implemented");
}
export function startWatcher(intervalMs: number): void {
  throw new Error("not implemented");
}
