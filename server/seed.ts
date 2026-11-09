// Demo catalog. Promises start uncompiled so the video can show the merchant writing one live;
// `seedPromises` pre-compiles a known-good set for judges who just want to buy something.
import { newId, products, promises } from "./db.ts";
import type { CompiledPromise, Product } from "./types.ts";

export function seedProducts(): Product[] {
  const items: Omit<Product, "id">[] = [
    { name: "Tidepool Mug", description: "Wheel-thrown stoneware, ocean-glaze, 12 oz.", price: 38, shipping: 6.4, image: "☕", kind: "physical", promise_id: null },
    { name: "Driftwood Serving Bowl", description: "Wide, shallow, speckled sand glaze.", price: 72, shipping: 9.5, image: "🥣", kind: "physical", promise_id: null },
    { name: "Sunset Kayak Tour", description: "Two hours around Casco Bay islands, guide included.", price: 65, shipping: 0, image: "🛶", kind: "experience", promise_id: null },
  ];
  return items.map((p) => products.put({ ...p, id: newId("prod") }));
}

// Pre-compiled promises (exactly what the compiler produced during development), so the shop
// works out of the box even before anyone writes a promise.
const PRESETS: Record<string, { text: string; compiled: CompiledPromise }> = {
  "Tidepool Mug": {
    text: "Order by Tuesday and it arrives by Friday, or your shipping's on us.",
    compiled: {
      checkable: true,
      rule: { condition: { kind: "delivered_by", deadline: { kind: "weekday_after_purchase", weekday: "friday" } }, payout: { kind: "shipping_cost" } },
      badge: "Arrives by Friday — or shipping's on us",
      plain_english: "If carrier tracking doesn't show the parcel delivered by 11:59 pm Friday (shop time), the buyer is refunded the shipping they paid.",
      data_source: "carrier_tracking",
      needs_from_buyer: [],
      assumptions: ["“Friday” means the first Friday on or after purchase, end of day, America/New_York.", "“Shipping's on us” means refunding the shipping charge, not the item."],
      questions: [],
      suggested_rewrite: null,
    },
  },
  "Sunset Kayak Tour": {
    text: "If it rains on your tour day, you get half your money back. No arguing.",
    compiled: {
      checkable: true,
      rule: { condition: { kind: "weather", metric: "precipitation_mm", op: ">=", threshold: 1, hours: { start: 16, end: 20 } }, payout: { kind: "percent_of_total", percent: 50 } },
      badge: "Rained out? 50% back, automatically",
      plain_english: "If Open-Meteo records 1 mm or more of rain at the tour location between 4 pm and 8 pm on the tour date, the buyer gets 50% of the price back.",
      data_source: "open_meteo_weather",
      needs_from_buyer: ["event_date", "event_location"],
      assumptions: ["“Rains” means at least 1 mm of measured precipitation — drizzle under that doesn't count.", "Only the tour window (4–8 pm) is checked, not the whole day."],
      questions: ["Should a cancelled tour (e.g. thunderstorm) be a full refund instead of 50%?"],
      suggested_rewrite: null,
    },
  },
};

export function seedPromises() {
  for (const p of products.all()) {
    const preset = PRESETS[p.name];
    if (!preset || p.promise_id) continue;
    const rec = promises.put({ id: newId("prm"), product_id: p.id, source_text: preset.text, compiled: preset.compiled, status: "active", created_at: new Date().toISOString() });
    products.update(p.id, { promise_id: rec.id });
  }
}
