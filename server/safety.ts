// Guard rails for a public demo URL with real API keys behind it: per-IP rate limits, a global
// ceiling on the endpoints that spend money (Claude, PayPal), and secret redaction for errors.
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

const SECRET_VARS = ["PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"];

/** Replace any secret env value (and bearer/basic tokens) that might have leaked into a message. */
export function redact(text: string): string {
  let out = text;
  for (const k of SECRET_VARS) {
    const v = process.env[k];
    if (v && v.length >= 8) out = out.split(v).join("[redacted]");
  }
  return out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]").replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
}

function socketIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

function forwardedIp(c: Context): string | undefined {
  const h = (n: string) => c.req.header(n)?.split(",")[0]?.trim();
  return h("cf-connecting-ip") || h("true-client-ip") || h("x-forwarded-for") || undefined;
}

export const clientIp = (c: Context): string => forwardedIp(c) ?? socketIp(c);

/** A direct loopback connection with no proxy headers: a local script, never a Render visitor. */
const isLocal = (c: Context) => !forwardedIp(c) && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socketIp(c));

type Bucket = { hits: number[] };
const buckets = new Map<string, Bucket>();

function hit(key: string, limit: number, windowMs: number, t: number): number | null {
  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((x) => t - x < windowMs);
  if (b.hits.length >= limit) {
    buckets.set(key, b);
    return Math.ceil((b.hits[0] + windowMs - t) / 1000); // seconds until a slot frees up
  }
  b.hits.push(t);
  buckets.set(key, b);
  return null;
}

// Drop idle buckets so the map can't grow without bound.
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (!b.hits.length || t - b.hits[b.hits.length - 1] > 60 * 60_000) buckets.delete(k);
}, 5 * 60_000).unref();

/**
 * Sliding-window limit per client IP, plus an optional ceiling across all clients
 * (so a spoofed X-Forwarded-For can't run up the Claude/PayPal bill).
 * Rate limits are about real traffic, so they use wall time, not the simulated clock.
 */
export function rateLimit(name: string, perIp: number, windowMs: number, what: string, global?: number): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.RATE_LIMIT === "off") return next();
    // Local scripts (scripts/e2e*.sh) talk to the server directly over loopback; behind Render's
    // proxy every request arrives with forwarding headers, so this exemption never applies there.
    if (isLocal(c)) return next();
    const ip = clientIp(c);
    const t = Date.now();
    const wait = hit(`${name}:${ip}`, perIp, windowMs, t) ?? (global ? hit(`${name}:*`, global, windowMs, t) : null);
    if (wait !== null) {
      const mins = Math.max(1, Math.ceil(wait / 60));
      c.header("Retry-After", String(wait));
      return c.json({ error: `Easy there: this public demo allows ${perIp} ${what} per ${Math.round(windowMs / 60_000)} minutes. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.` }, 429);
    }
    await next();
  };
}
