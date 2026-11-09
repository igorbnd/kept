// PayPal REST (sandbox) client. OWNER: paypal agent. Server-side only — the secret never reaches the browser.
// Plain fetch against the REST API: OAuth2 client credentials -> Orders v2 / Payments v2 / Shipping trackers.
import { randomUUID } from "node:crypto";
import type { Product } from "./types.ts";

export const PAYPAL_BASE = process.env.PAYPAL_BASE ?? "https://api-m.sandbox.paypal.com";
const BRAND_NAME = "Harbor & Clay";
const CURRENCY = "USD";

// ---------- auth ----------

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Cached OAuth2 client-credentials token (refreshed 60s before expiry). */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  // Token TTL is wall-clock (not the simulated demo clock), so Date.now() is correct here.
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PayPal credentials missing: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !body.access_token) {
    // Never include the credentials; PayPal's error/error_description are safe.
    throw new Error(`PayPal auth failed (${res.status}): ${body.error ?? "unknown"}${body.error_description ? ` — ${body.error_description}` : ""}`);
  }
  const ttlMs = Number(body.expires_in ?? 0) * 1000;
  cachedToken = { token: body.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - 60_000) };
  return cachedToken.token;
}

// ---------- fetch helper ----------

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly ppName?: string,
    readonly issue?: string,
    readonly debugId?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ppFetch<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, opts: { requestId?: string } = {}): Promise<T> {
  let refreshed = false;
  let retried = false;
  for (;;) {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
      ...init.headers,
    };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    let res: Response;
    try {
      res = await fetch(`${PAYPAL_BASE}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (e) {
      if (!retried) {
        retried = true;
        await sleep(400);
        continue;
      }
      throw new Error(`PayPal network error on ${path}: ${(e as Error).message}`);
    }

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      cachedToken = null; // next getAccessToken() fetches a fresh one
      continue;
    }
    if ((res.status >= 500 || res.status === 429) && !retried) {
      retried = true;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : 600);
      continue;
    }

    const text = await res.text();
    const body = text ? safeJson(text) : {};
    if (res.ok) return body as T;

    const name: string | undefined = body?.name ?? body?.error;
    const message: string | undefined = body?.message ?? body?.error_description;
    const issue: string | undefined = body?.details?.[0]?.issue;
    const desc: string | undefined = body?.details?.[0]?.description;
    const debugId: string | undefined = body?.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined;
    const parts = [`PayPal ${res.status} ${name ?? "ERROR"}`, message, issue && `issue=${issue}${desc ? ` (${desc})` : ""}`, debugId && `debug_id=${debugId}`].filter(Boolean);
    throw new PayPalError(parts.join(" — "), res.status, name, issue, debugId);
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const truncate = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

/** Buyer-facing approval page for an order id (sandbox or live depending on PAYPAL_BASE). */
export function paypalOrderUrl(id: string): string {
  const web = PAYPAL_BASE.includes("sandbox") ? "https://www.sandbox.paypal.com" : "https://www.paypal.com";
  return `${web}/checkoutnow?token=${encodeURIComponent(id)}`;
}

// ---------- Orders v2 ----------

export type TestCard = { number: string; expiry: string; security_code: string; name?: string };
/** PayPal sandbox Visa test card. Only for automated tests / demo scripts against the sandbox. */
export const SANDBOX_TEST_CARD: TestCard = { number: "4111111111111111", expiry: "2030-01", security_code: "123", name: "Test Buyer" };

/**
 * Orders v2: create a CAPTURE order for one product (item + shipping breakdown). Returns the PayPal order id.
 * `card` (sandbox only) pays with a card directly instead of the PayPal wallet, so no buyer approval is needed.
 */
export async function createOrder(
  product: Product,
  opts: { orderRef: string; description?: string; card?: TestCard },
): Promise<{ id: string; status: string; approve_url: string | null }> {
  const isExperience = product.kind === "experience";
  const itemCents = Math.round(product.price * 100);
  const shipCents = Math.round(product.shipping * 100);
  const item = money(itemCents / 100);
  const ship = money(shipCents / 100);
  const total = money((itemCents + shipCents) / 100);

  const paymentSource = opts.card
    ? {
        card: {
          number: opts.card.number,
          expiry: opts.card.expiry,
          security_code: opts.card.security_code,
          name: opts.card.name,
          experience_context: { brand_name: BRAND_NAME, shipping_preference: "NO_SHIPPING" },
        },
      }
    : {
        paypal: {
          experience_context: {
            brand_name: BRAND_NAME,
            shipping_preference: isExperience ? "NO_SHIPPING" : "GET_FROM_FILE",
            user_action: "PAY_NOW",
          },
        },
      };

  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: opts.orderRef,
        custom_id: opts.orderRef,
        description: truncate(opts.description ?? product.name, 127),
        amount: {
          currency_code: CURRENCY,
          value: total,
          breakdown: {
            item_total: { currency_code: CURRENCY, value: item },
            shipping: { currency_code: CURRENCY, value: ship },
          },
        },
        items: [
          {
            name: truncate(product.name, 127),
            description: product.description ? truncate(product.description, 127) : undefined,
            sku: product.id.slice(0, 127),
            unit_amount: { currency_code: CURRENCY, value: item },
            quantity: "1",
            category: isExperience ? "DIGITAL_GOODS" : "PHYSICAL_GOODS",
          },
        ],
      },
    ],
    payment_source: paymentSource,
  };
  const res = await ppFetch<any>("/v2/checkout/orders", { method: "POST", body }, { requestId: `create-${opts.orderRef}` });
  const links: { rel: string; href: string }[] = res.links ?? [];
  const approve = links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return { id: res.id, status: res.status, approve_url: approve };
}

/** Orders v2: capture an approved order. Idempotent: retries reuse the same PayPal-Request-Id. */
export async function captureOrder(paypalOrderId: string): Promise<{
  status: string;
  capture_id: string;
  amount: number;
  payer_name: string | null;
  payer_email: string | null;
}> {
  const path = `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`;
  let res: any;
  try {
    res = await ppFetch<any>(`${path}/capture`, { method: "POST", body: {} }, { requestId: `capture-${paypalOrderId}` });
  } catch (e) {
    // Card orders (and double-clicks) may already be captured: read the order and report its capture.
    if (!(e instanceof PayPalError) || e.issue !== "ORDER_ALREADY_CAPTURED") throw e;
    res = await ppFetch<any>(path);
  }
  return summarizeCapture(res);
}

function summarizeCapture(res: any): { status: string; capture_id: string; amount: number; payer_name: string | null; payer_email: string | null } {
  const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
  const name = res.payer?.name ?? res.payment_source?.paypal?.name;
  const payerName = name ? [name.given_name, name.surname].filter(Boolean).join(" ") || null : (res.payment_source?.card?.name ?? null);
  return {
    status: res.status,
    capture_id: cap?.id ?? "",
    amount: Number(cap?.amount?.value ?? 0),
    payer_name: payerName,
    payer_email: res.payer?.email_address ?? res.payment_source?.paypal?.email_address ?? null,
  };
}

/** Payments v2: (partial) refund of a capture. Idempotent per key via PayPal-Request-Id. */
export async function refundCapture(captureId: string, amount: number, noteToPayer: string, idempotencyKey: string, invoiceId?: string): Promise<{ id: string; status: string }> {
  const body: Record<string, unknown> = {
    amount: { value: money(amount), currency_code: CURRENCY },
    note_to_payer: truncate(noteToPayer, 255),
  };
  if (invoiceId) body.invoice_id = invoiceId;
  const res = await ppFetch<any>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { method: "POST", body }, { requestId: idempotencyKey });
  return { id: res.id, status: res.status };
}

/** Attach a tracking number to the order's capture so it shows in PayPal. Tries Orders v2 /track, then v1 trackers-batch. */
export async function addTracking(paypalOrderId: string, captureId: string, trackingNumber: string, carrier: string): Promise<void> {
  const carrierName = carrier || "KeptPost";
  let firstErr: Error;
  try {
    await ppFetch(
      `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/track`,
      { method: "POST", body: { capture_id: captureId, tracking_number: trackingNumber, carrier: "OTHER", carrier_name_other: carrierName, notify_payer: false } },
      { requestId: `track-${captureId}-${trackingNumber}` },
    );
    return;
  } catch (e) {
    firstErr = e as Error;
  }
  try {
    const res = await ppFetch<any>("/v1/shipping/trackers-batch", {
      method: "POST",
      body: { trackers: [{ transaction_id: captureId, tracking_number: trackingNumber, status: "SHIPPED", carrier: "OTHER", carrier_name_other: carrierName }] },
    });
    if (res?.errors?.length) throw new Error(`trackers-batch: ${JSON.stringify(res.errors[0]).slice(0, 300)}`);
  } catch (e) {
    throw new Error(`addTracking failed. orders/track: ${firstErr.message}; trackers-batch: ${(e as Error).message}`);
  }
}

// Not exported elsewhere but handy for scripts.
export const _internal = { ppFetch, newRequestId: () => randomUUID() };
