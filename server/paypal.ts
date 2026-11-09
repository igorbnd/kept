// PayPal REST (sandbox) client. OWNER: paypal agent. Server-side only — the secret never reaches the browser.
import type { Product } from "./types.ts";

export const PAYPAL_BASE = process.env.PAYPAL_BASE ?? "https://api-m.sandbox.paypal.com";

/** Cached OAuth2 client-credentials token. */
export async function getAccessToken(): Promise<string> {
  throw new Error("not implemented");
}

/** Orders v2: create a CAPTURE order for one product (item + shipping breakdown). Returns the PayPal order id. */
export async function createOrder(product: Product, opts: { orderRef: string; description?: string }): Promise<{ id: string }> {
  throw new Error("not implemented");
}

/** Orders v2: capture an approved order. */
export async function captureOrder(paypalOrderId: string): Promise<{
  status: string;
  capture_id: string;
  amount: number;
  payer_name: string | null;
  payer_email: string | null;
}> {
  throw new Error("not implemented");
}

/** Payments v2: (partial) refund of a capture. Idempotent per key via PayPal-Request-Id. */
export async function refundCapture(captureId: string, amount: number, noteToPayer: string, idempotencyKey: string): Promise<{ id: string; status: string }> {
  throw new Error("not implemented");
}

/** Orders v2: attach a tracking number to the order's capture so it shows in PayPal for buyer and seller. */
export async function addTracking(paypalOrderId: string, captureId: string, trackingNumber: string, carrier: string): Promise<void> {
  throw new Error("not implemented");
}
