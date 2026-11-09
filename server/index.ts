import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import { compilePromise } from "./ai/compiler.ts";
import { advanceClock, agentEvents, clockOffsetMs, logEvent, newId, now, orders, products, promises, resetAll, resetClock } from "./db.ts";
import { MERCHANT } from "./merchant.ts";
import { addTracking, captureOrder, createOrder, SANDBOX_TEST_CARD } from "./paypal.ts";
import { seedProducts, seedPromises } from "./seed.ts";
import { CARRIER_NAME, createShipment, getCarrierEvents, pushCarrierEvent } from "./sources/carrier.ts";
import { setWeatherOverride } from "./sources/weather.ts";
import type { Order } from "./types.ts";
import { computeDeadline, startWatcher, tick } from "./watcher.ts";

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// ---------- Config / shop ----------

app.get("/api/config", (c) =>
  c.json({
    merchant: MERCHANT,
    paypal_client_id: process.env.PAYPAL_CLIENT_ID,
    now: now().toISOString(),
    clock_offset_ms: clockOffsetMs(),
  }),
);

app.get("/api/products", (c) =>
  c.json(products.all().map((p) => ({ ...p, promise: p.promise_id ? promises.get(p.promise_id) : null }))),
);

// ---------- Promise studio ----------

app.get("/api/promises", (c) => c.json(promises.all().reverse()));

app.post("/api/promises/compile", async (c) => {
  const body = z.object({ product_id: z.string(), text: z.string().min(3).max(500) }).parse(await c.req.json());
  const product = products.get(body.product_id);
  if (!product) return c.json({ error: "product not found" }, 404);
  const compiled = await compilePromise(body.text, product, MERCHANT.timezone);
  const rec = promises.put({ id: newId("prm"), product_id: product.id, source_text: body.text, compiled, status: "draft", created_at: now().toISOString() });
  logEvent("compiled", `Compiled “${body.text}” → ${compiled.checkable ? compiled.badge : "not checkable"}`, null, { promise_id: rec.id, compiled });
  return c.json(rec);
});

app.post("/api/promises/:id/activate", (c) => {
  const rec = promises.get(c.req.param("id"));
  if (!rec) return c.json({ error: "not found" }, 404);
  if (!rec.compiled.checkable || !rec.compiled.rule) return c.json({ error: "Only checkable promises can go live." }, 400);
  for (const p of promises.all()) if (p.product_id === rec.product_id && p.status === "active") promises.update(p.id, { status: "retired" });
  promises.update(rec.id, { status: "active" });
  products.update(rec.product_id, { promise_id: rec.id });
  logEvent("info", `Promise is live on ${products.get(rec.product_id)?.name}: “${rec.compiled.badge}”`);
  return c.json(promises.get(rec.id));
});

// ---------- Checkout ----------

const CreateOrderBody = z.object({
  product_id: z.string(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  event_location: z.object({ name: z.string(), lat: z.number(), lon: z.number() }).nullable().optional(),
  // Sandbox-only shortcut: pay with PayPal's test Visa so judges and scripts can skip the wallet popup.
  test_card: z.boolean().optional(),
});

app.post("/api/orders", async (c) => {
  const body = CreateOrderBody.parse(await c.req.json());
  const product = products.get(body.product_id);
  if (!product) return c.json({ error: "product not found" }, 404);
  const promise = product.promise_id ? promises.get(product.promise_id) : null;
  const compiled = promise?.status === "active" ? promise.compiled : null;
  if (compiled?.needs_from_buyer.includes("event_date") && !body.event_date) return c.json({ error: "Pick a tour date." }, 400);

  const id = newId("ord");
  const pp = await createOrder(product, { orderRef: id, description: compiled ? `${product.name} — ${compiled.badge}` : product.name, card: body.test_card ? SANDBOX_TEST_CARD : undefined });
  const order: Order = {
    id,
    product_id: product.id,
    promise_id: compiled ? promise!.id : null,
    promise_snapshot: compiled,
    paypal_order_id: pp.id,
    paypal_capture_id: null,
    amount_total: +(product.price + product.shipping).toFixed(2),
    amount_shipping: product.shipping,
    buyer_name: null,
    buyer_email: null,
    event_date: body.event_date ?? null,
    event_location: body.event_location ?? (compiled?.needs_from_buyer.includes("event_location") ? MERCHANT.home : null),
    tracking_number: null,
    status: "created",
    deadline_at: null,
    payout_amount: null,
    paypal_refund_id: null,
    customer_message: null,
    created_at: now().toISOString(),
    resolved_at: null,
  };
  orders.put(order);
  return c.json({ order_id: id, paypal_order_id: pp.id });
});

app.post("/api/orders/:id/capture", async (c) => {
  const order = orders.get(c.req.param("id"));
  if (!order) return c.json({ error: "not found" }, 404);
  if (order.status !== "created") return c.json(order);
  const cap = await captureOrder(order.paypal_order_id);
  if (cap.status !== "COMPLETED") return c.json({ error: `PayPal capture status ${cap.status}` }, 400);

  const product = products.get(order.product_id)!;
  const purchasedAt = now();
  const patch: Partial<Order> = {
    status: "paid",
    paypal_capture_id: cap.capture_id,
    amount_total: cap.amount,
    buyer_name: cap.payer_name,
    buyer_email: cap.payer_email,
  };
  const cond = order.promise_snapshot?.rule?.condition;
  if (cond && (cond.kind === "delivered_by" || cond.kind === "shipped_by")) {
    patch.deadline_at = computeDeadline(cond.deadline, purchasedAt, MERCHANT.timezone).toISOString();
  }
  if (product.kind === "physical") {
    patch.tracking_number = createShipment(order.id);
    try {
      await addTracking(order.paypal_order_id, cap.capture_id, patch.tracking_number, CARRIER_NAME);
      logEvent("info", `Tracking ${patch.tracking_number} attached to PayPal order ${order.paypal_order_id}`, order.id);
    } catch (e) {
      logEvent("error", `Couldn't attach tracking in PayPal: ${(e as Error).message}`, order.id);
    }
  }
  const updated = orders.update(order.id, patch);
  logEvent("watching", order.promise_snapshot ? `Paid $${cap.amount.toFixed(2)} — now watching “${order.promise_snapshot.badge}”` : `Paid $${cap.amount.toFixed(2)} (no promise)`, order.id);
  return c.json(updated);
});

// ---------- Ledger ----------

app.get("/api/orders", (c) => {
  const prods = new Map(products.all().map((p) => [p.id, p]));
  const latest = new Map<string, string>();
  for (const e of agentEvents.all()) if (e.order_id) latest.set(e.order_id, e.message);
  return c.json(orders.all().reverse().map((o) => ({ ...o, product_name: prods.get(o.product_id)?.name ?? "?", latest_evidence: latest.get(o.id) ?? null })));
});

app.get("/api/orders/:id", (c) => {
  const order = orders.get(c.req.param("id"));
  if (!order) return c.json({ error: "not found" }, 404);
  return c.json({
    order,
    product: products.get(order.product_id),
    carrier_events: order.tracking_number ? getCarrierEvents(order.tracking_number) : [],
    agent_events: agentEvents.all().filter((e) => e.order_id === order.id),
  });
});

app.get("/api/events", (c) => c.json(agentEvents.all().slice(-200).reverse()));

app.get("/api/stats", (c) => {
  const all = orders.all().filter((o) => o.status !== "created");
  const month = now().toISOString().slice(0, 7);
  const refundedThisMonth = all.filter((o) => o.status === "refunded" && (o.resolved_at ?? "").startsWith(month)).reduce((s, o) => s + (o.payout_amount ?? 0), 0);
  return c.json({
    orders: all.length,
    revenue: +all.reduce((s, o) => s + o.amount_total, 0).toFixed(2),
    watching: all.filter((o) => o.status === "paid").length,
    kept: all.filter((o) => o.status === "kept").length,
    refunded: all.filter((o) => o.status === "refunded").length,
    paid_out: +all.reduce((s, o) => s + (o.payout_amount ?? 0), 0).toFixed(2),
    budget: MERCHANT.monthly_guarantee_budget,
    budget_used: +refundedThisMonth.toFixed(2),
  });
});

// ---------- Demo controls (the "world" the agent watches) ----------

app.post("/api/demo/clock", async (c) => {
  const { hours, reset } = z.object({ hours: z.number().optional(), reset: z.boolean().optional() }).parse(await c.req.json());
  if (reset) resetClock();
  else if (hours) advanceClock(hours * 3600_000);
  logEvent("info", reset ? "Clock reset to real time" : `Clock moved forward ${hours}h → ${now().toUTCString()}`);
  await tick();
  return c.json({ now: now().toISOString(), clock_offset_ms: clockOffsetMs() });
});

app.post("/api/demo/carrier/:tracking", async (c) => {
  const body = z
    .object({ status: z.enum(["picked_up", "in_transit", "delayed", "out_for_delivery", "delivered"]), description: z.string(), location: z.string() })
    .parse(await c.req.json());
  const ev = pushCarrierEvent(c.req.param("tracking"), body.status, body.description, body.location);
  await tick();
  return c.json(ev);
});

app.post("/api/demo/weather", async (c) => {
  const body = z
    .object({ date: z.string(), location: z.string(), precipitation_mm: z.number().nullable() })
    .parse(await c.req.json());
  setWeatherOverride(body.date, body.location, body.precipitation_mm === null ? null : { precipitation_mm: body.precipitation_mm });
  await tick();
  return c.json({ ok: true });
});

app.post("/api/demo/tick", async (c) => {
  await tick();
  return c.json({ ok: true });
});

app.post("/api/demo/reset", (c) => {
  resetAll();
  seedProducts();
  seedPromises();
  logEvent("info", "Demo reset: fresh catalog with two live promises");
  return c.json({ ok: true });
});

// ---------- Static web app ----------

app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

// ---------- Boot ----------

if (products.all().length === 0) {
  seedProducts();
  seedPromises();
}
startWatcher(Number(process.env.WATCH_INTERVAL_MS ?? 15_000));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Kept API on http://localhost:${port}`));
