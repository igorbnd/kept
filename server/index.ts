import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import { compilePromise } from "./ai/compiler.ts";
import { suggestPromises } from "./ai/suggester.ts";
import { expectedCost } from "./pricing.ts";
import { advanceClock, agentEvents, clockOffsetMs, logEvent, newId, now, orders, products, promises, pruneData, resetAll, resetClock } from "./db.ts";
import { MERCHANT } from "./merchant.ts";
import { addTracking, captureOrder, createOrder, SANDBOX_TEST_CARD } from "./paypal.ts";
import { rateLimit, redact } from "./safety.ts";
import { seedProducts, seedPromises } from "./seed.ts";
import { CARRIER_NAME, createShipment, getCarrierEvents, pushCarrierEvent } from "./sources/carrier.ts";
import { climateSummary, momentContext, sameWindowHistory } from "./sources/context.ts";
import { clearWeatherOverrides, setWeatherOverride } from "./sources/weather.ts";
import type { Order } from "./types.ts";
import { computeDeadline, computePayout, decideHeld, localDate, promiseOpen, ReviewError, startWatcher, tick } from "./watcher.ts";

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof ZodError) {
    const i = err.issues[0];
    return c.json({ error: `Invalid request: ${i ? `${i.path.join(".") || "body"} ${i.message.toLowerCase()}` : "bad input"}` }, 400);
  }
  if (err instanceof SyntaxError) return c.json({ error: "Invalid request: body must be JSON" }, 400);
  console.error(redact(String(err?.stack ?? err)));
  return c.json({ error: redact(err.message || "Something went wrong") }, 500);
});

// ---------- Public-deploy guard rails ----------

const TEN_MIN = 10 * 60_000;
app.use("/api/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request body too large (16 KB max)." }, 413) }));
const writeLimit = rateLimit("api", 300, TEN_MIN, "changes");
app.use("/api/*", (c, next) => (c.req.method === "GET" ? next() : writeLimit(c, next)));
app.post("/api/promises/compile", rateLimit("compile", 10, TEN_MIN, "promise compiles", 60));
app.post("/api/promises/suggest", rateLimit("suggest", 6, TEN_MIN, "promise idea requests", 30));
app.post("/api/orders", rateLimit("orders", 30, TEN_MIN, "orders", 150));
app.post("/api/orders/:id/capture", rateLimit("capture", 40, TEN_MIN, "payment captures", 200));
app.post("/api/orders/:id/review", rateLimit("review", 30, TEN_MIN, "merchant decisions", 150));
app.post("/api/demo/reset", rateLimit("reset", 3, TEN_MIN, "demo resets"));
app.post("/api/demo/sample", rateLimit("sample", 3, TEN_MIN, "sample-history loads", 12));
app.post("/api/demo/*", rateLimit("demo", 120, TEN_MIN, "demo actions"));

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
  c.json(
    products.all().map((p) => {
      const promise = p.promise_id ? promises.get(p.promise_id) : null;
      return { ...p, promise, promise_open: promiseOpen(promise?.compiled ?? null, now(), MERCHANT.timezone) };
    }),
  ),
);

// ---------- Promise studio ----------

app.get("/api/promises", (c) => c.json(promises.all().reverse()));

app.post("/api/promises/compile", async (c) => {
  const body = z.object({ product_id: z.string().max(64), text: z.string().trim().min(3).max(500) }).parse(await c.req.json());
  const product = products.get(body.product_id);
  if (!product) return c.json({ error: "product not found" }, 404);
  const compiled = await compilePromise(body.text, product, MERCHANT.timezone, { today: localDate(now(), MERCHANT.timezone) });
  const rec = promises.put({ id: newId("prm"), product_id: product.id, source_text: body.text, compiled, status: "draft", created_at: now().toISOString() });
  pruneData();
  logEvent("compiled", `Compiled “${body.text}” → ${compiled.checkable ? compiled.badge : "not checkable"}`, null, { promise_id: rec.id, compiled });
  return c.json(rec);
});

// Promise ideas: the Kept agent (Claude) proposes promises for this product and this moment;
// each is compiled like a typed promise (so it arrives as a draft contract) and priced by code.
const HISTORY_DAYS = 30;
const HISTORY_YEARS = 5;
app.post("/api/promises/suggest", async (c) => {
  const body = z.object({ product_id: z.string().max(64) }).parse(await c.req.json());
  const product = products.get(body.product_id);
  if (!product) return c.json({ error: "product not found" }, 404);
  const at = now();
  const tz = MERCHANT.timezone;
  const ctx = await momentContext(at, tz, MERCHANT.home);
  const live = product.promise_id ? promises.get(product.promise_id) : null;
  const historyP =
    product.kind === "experience"
      ? sameWindowHistory(MERCHANT.home.lat, MERCHANT.home.lon, ctx.today, HISTORY_DAYS, HISTORY_YEARS)
          .then((h) => ({ data: h.data, years: HISTORY_YEARS, days: HISTORY_DAYS }))
          .catch(() => null)
      : Promise.resolve(null);
  const history = await historyP; // the agent sees the history too, to pick thresholds a shop can afford
  const climate = history ? climateSummary(history.data, HISTORY_YEARS, HISTORY_DAYS, ctx.today) : null;
  const ideas = await suggestPromises(product, live?.status === "active" ? live.source_text : null, ctx, climate);
  // The agent drafts 5; every one is compiled and priced, and code keeps the best 3: checkable first,
  // then enforceable exactly as worded, then affordable but meaningful (pays out on 3–25% of orders).
  const compiled = await Promise.allSettled(ideas.map((i) => compilePromise(i.promise_text, product, tz, { today: ctx.today })));
  const scored = ideas.map((idea, i) => {
    const r = compiled[i];
    const value = r.status === "fulfilled" ? r.value : null;
    const cost = value ? expectedCost(value, product, ctx, at, history) : null;
    // A weather rule covers every booking, so wording that limits which bookings count ("book by Nov 20…")
    // promises more than code enforces.
    const limitsBookings = value?.rule?.condition.kind === "weather" && /\b(book|order|reserve)\w*\b[^.]{0,40}\b(by|before|for)\b|\bweek\b|\bonly\b/i.test(idea.promise_text);
    const p = cost?.probability ?? 0.1;
    // Experiences are judged by weather, shipped goods by the carrier; anything else is a mismatch.
    const mismatch = !!value?.rule && (value.rule.condition.kind === "weather") !== (product.kind === "experience");
    const rank = !value?.checkable || mismatch ? 4 : limitsBookings ? 3 : p > 0.35 ? 2 : p > 0.25 || p < 0.03 ? 1 : 0;
    return { idea, value, cost, rank, i, error: r.status === "rejected" ? redact((r.reason as Error).message) : null };
  });
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
  const out = scored.slice(0, 3).map(({ idea, value, cost, error }) => {
    if (!value) return { ...idea, promise: null, cost: null, error };
    const rec = promises.put({ id: newId("prm"), product_id: product.id, source_text: idea.promise_text, compiled: value, status: "draft", created_at: at.toISOString() });
    return { ...idea, promise: rec, cost, error: null };
  });
  pruneData();
  logEvent("compiled", `Kept agent (Claude) suggested ${out.length} promises for ${product.name}: ${out.map((o) => `“${o.title}”`).join(", ")}`, null, { product_id: product.id, factors: out.map((o) => o.factors) });
  return c.json({ context: { ...ctx, climate }, ideas: out });
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
  product_id: z.string().max(64),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  event_location: z.object({ name: z.string().min(1).max(80), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).nullable().optional(),
  // Sandbox-only shortcut: pay with PayPal's test Visa so judges and scripts can skip the wallet popup.
  test_card: z.boolean().optional(),
});

type CreateOrderInput = z.infer<typeof CreateOrderBody>;

/** Create a Kept order plus its PayPal order. Returns an error string for buyer-fixable problems. */
async function placeOrder(body: CreateOrderInput): Promise<{ error: string; status: 400 | 404 } | { order_id: string; paypal_order_id: string }> {
  const product = products.get(body.product_id);
  if (!product) return { error: "product not found", status: 404 };
  const promise = product.promise_id ? promises.get(product.promise_id) : null;
  // A fixed-date promise past its order-by cutoff isn't offered, so the order carries no promise.
  const compiled = promise?.status === "active" && promiseOpen(promise.compiled, now(), MERCHANT.timezone) ? promise.compiled : null;
  if (compiled?.needs_from_buyer.includes("event_date") && !body.event_date) return { error: "Pick a tour date.", status: 400 };

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
  pruneData();
  return { order_id: id, paypal_order_id: pp.id };
}

// One capture per order at a time: the PayPal button and a double click can race, and a second
// capture call would fail with ORDER_ALREADY_CAPTURED even though the first one succeeded.
const capturing = new Map<string, Promise<Order>>();

function captureById(orderId: string): Promise<Order> {
  const inflight = capturing.get(orderId);
  if (inflight) return inflight;
  const p = doCapture(orderId).finally(() => capturing.delete(orderId));
  capturing.set(orderId, p);
  return p;
}

async function doCapture(orderId: string): Promise<Order> {
  const order = orders.get(orderId);
  if (!order) throw new HTTPException(404, { res: Response.json({ error: "not found" }, { status: 404 }) });
  if (order.status !== "created") return order;
  const cap = await captureOrder(order.paypal_order_id);
  if (cap.status !== "COMPLETED") throw new HTTPException(400, { res: Response.json({ error: `PayPal capture status ${cap.status}` }, { status: 400 }) });

  const product = products.get(order.product_id);
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
  if (product?.kind === "physical") {
    patch.tracking_number = createShipment(order.id);
    try {
      await addTracking(order.paypal_order_id, cap.capture_id, patch.tracking_number, CARRIER_NAME);
      logEvent("info", `Tracking ${patch.tracking_number} attached to PayPal order ${order.paypal_order_id}`, order.id);
    } catch (e) {
      logEvent("error", `Couldn't attach tracking in PayPal: ${(e as Error).message}`, order.id);
    }
  }
  if (!orders.get(order.id)) throw new HTTPException(409, { res: Response.json({ error: "This order was cleared by a demo reset while paying." }, { status: 409 }) });
  const updated = orders.update(order.id, patch);
  logEvent("watching", order.promise_snapshot ? `Paid $${cap.amount.toFixed(2)} — now watching “${order.promise_snapshot.badge}”` : `Paid $${cap.amount.toFixed(2)} (no promise)`, order.id);
  return updated;
}

app.post("/api/orders", async (c) => {
  const res = await placeOrder(CreateOrderBody.parse(await c.req.json()));
  if ("error" in res) return c.json({ error: res.error }, res.status);
  return c.json(res);
});

app.post("/api/orders/:id/capture", async (c) => c.json(await captureById(c.req.param("id"))));

// Merchant decision on a payout Claude paused. Claude can only pause; the merchant decides, and a
// "refund" runs the exact same payout code path as an automatic refund.
app.post("/api/orders/:id/review", async (c) => {
  const { decision } = z.object({ decision: z.enum(["refund", "decline"]) }).parse(await c.req.json());
  try {
    return c.json(await decideHeld(c.req.param("id"), decision));
  } catch (e) {
    if (e instanceof ReviewError) return c.json({ error: e.message }, e.status);
    throw e;
  }
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
    // What a merchant "Refund" would send on a held order: computed by code from the frozen rule.
    pending_payout: order.status === "held" && order.promise_snapshot?.rule ? computePayout(order.promise_snapshot.rule, order) : null,
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
    held: all.filter((o) => o.status === "held").length,
    declined: all.filter((o) => o.status === "declined").length,
    paid_out: +all.reduce((s, o) => s + (o.payout_amount ?? 0), 0).toFixed(2),
    budget: MERCHANT.monthly_guarantee_budget,
    budget_used: +refundedThisMonth.toFixed(2),
  });
});

// ---------- Demo controls (the "world" the agent watches) ----------

app.post("/api/demo/clock", async (c) => {
  const { hours, reset } = z.object({ hours: z.number().min(-24 * 30).max(24 * 60).optional(), reset: z.boolean().optional() }).parse(await c.req.json());
  if (reset) resetClock();
  else if (hours) advanceClock(hours * 3600_000);
  logEvent("info", reset ? "Clock reset to real time" : `Clock moved forward ${hours}h → ${now().toUTCString()}`);
  await tick();
  return c.json({ now: now().toISOString(), clock_offset_ms: clockOffsetMs() });
});

app.post("/api/demo/carrier/:tracking", async (c) => {
  const body = z
    .object({ status: z.enum(["picked_up", "in_transit", "delayed", "exception", "out_for_delivery", "delivered"]), description: z.string().min(1).max(120), location: z.string().min(1).max(80) })
    .parse(await c.req.json());
  const tracking = c.req.param("tracking");
  if (!orders.all().some((o) => o.tracking_number === tracking)) return c.json({ error: "No order has that tracking number." }, 404);
  const ev = pushCarrierEvent(tracking, body.status, body.description, body.location);
  await tick();
  return c.json(ev);
});

app.post("/api/demo/weather", async (c) => {
  const body = z
    .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), location: z.string().min(1).max(80), precipitation_mm: z.number().min(0).max(500).nullable() })
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
  resetAll(); // also resets the simulated clock (it lives in settings)
  clearWeatherOverrides();
  seedProducts();
  seedPromises();
  logEvent("info", "Demo reset: fresh catalog with two live promises");
  return c.json({ ok: true });
});

// Sample history for an empty ledger (Render's free tier wipes the disk on restart). These are
// real PayPal sandbox orders paid with the test card, run through the same code paths as a judge's
// purchase. The world events (carrier scans, one rain override) are simulated, and say so.
app.post("/api/demo/sample", async (c) => {
  const byName = (n: string) => products.all().find((p) => p.name === n && p.promise_id && promises.get(p.promise_id)?.status === "active");
  const mug = byName("Tidepool Mug");
  const tour = byName("Sunset Kayak Tour");
  if (!mug || !tour) return c.json({ error: "Sample history needs the original catalog with its two live promises. Reset the demo first." }, 409);
  const month = now().toISOString().slice(0, 7);
  const used = orders.all().filter((o) => o.status === "refunded" && (o.resolved_at ?? "").startsWith(month)).reduce((s, o) => s + (o.payout_amount ?? 0), 0);
  if (used + 100 > MERCHANT.monthly_guarantee_budget) return c.json({ error: "The monthly guarantee budget is nearly used up. Reset the demo before loading sample history." }, 409);

  const tz = MERCHANT.timezone;
  const ymd = (daysAgo: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now().getTime() - daysAgo * 86_400_000));
  const home = MERCHANT.home;
  const rainyDay = ymd(1);
  const buy = async (body: CreateOrderInput) => {
    const res = await placeOrder({ ...body, test_card: true });
    if ("error" in res) throw new Error(res.error);
    const order = await captureById(res.order_id);
    logEvent("info", "Sample history: real sandbox order paid with PayPal's test card (Demo controls → Load sample history).", order.id);
    return order;
  };

  logEvent("info", `Loading sample history: 4 real sandbox orders; carrier scans and the ${rainyDay} rain are simulated.`);
  setWeatherOverride(rainyDay, home.name, { precipitation_mm: 4 });
  // Sequential on purpose: the sandbox rejects concurrent test-card orders with PAYER_CANNOT_PAY.
  const delivered = await buy({ product_id: mug.id });
  const inTransit = await buy({ product_id: mug.id });
  const rainedOut = await buy({ product_id: tour.id, event_date: rainyDay, event_location: home });
  const realWeather = await buy({ product_id: tour.id, event_date: ymd(3), event_location: home }); // judged on real Open-Meteo data
  const scan = (o: Order, status: Parameters<typeof pushCarrierEvent>[1], description: string, location: string) => o.tracking_number && pushCarrierEvent(o.tracking_number, status, description, location);
  scan(delivered, "picked_up", "Picked up by carrier", "Portland, ME");
  scan(delivered, "delivered", "Delivered, left at front door", "Front porch");
  scan(inTransit, "picked_up", "Picked up by carrier", "Portland, ME");
  scan(inTransit, "in_transit", "In transit: departed regional hub", "Worcester, MA");
  // The agent resolves them in the background (refund notes take a few seconds each); the UI polls.
  void tick().catch((e) => console.error("[sample] tick failed:", redact(String(e))));
  return c.json({ ok: true, order_ids: [delivered, inTransit, rainedOut, realWeather].map((o) => o.id) });
});

// ---------- Static web app ----------

app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

// ---------- Boot ----------

const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"].filter((k) => !process.env[k]);
if (missing.length) console.warn(`[kept] Missing env: ${missing.join(", ")}. The app still starts; checkout/refunds need PayPal, and compiling new promises needs Anthropic.`);

if (products.all().length === 0) {
  seedProducts();
  seedPromises();
}
pruneData();
setInterval(pruneData, 60_000).unref();
startWatcher(Number(process.env.WATCH_INTERVAL_MS ?? 15_000));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Kept API on http://localhost:${port}`));
