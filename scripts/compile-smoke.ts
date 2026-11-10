// Smoke test for the promise compiler + narrator. Run: npx tsx --env-file=.env scripts/compile-smoke.ts [low|medium]
import { compilePromise } from "../server/ai/compiler.ts";
import { writeRefundMessage, fallbackRefundMessage } from "../server/ai/narrator.ts";
import type { Order, Product, Verdict } from "../server/types.ts";

const mug: Product = { id: "p1", name: "Tidepool Mug", description: "Wheel-thrown stoneware, ocean-glaze, 12 oz.", price: 38, shipping: 6.4, image: "", kind: "physical", promise_id: null };
const tour: Product = { id: "p2", name: "Sunset Kayak Tour", description: "Two hours around Casco Bay islands, guide included.", price: 65, shipping: 0, image: "", kind: "experience", promise_id: null };

const cases: [string, Product][] = [
  ["Order by Tuesday and it arrives by Friday, or your shipping's on us.", mug],
  ["If it rains on your tour day, you get half your money back.", tour],
  ["Ships within 24 hours or $5 back", mug],
  ["You'll love it or your money back", mug],
  ["If it's colder than 5°C during the tour, 20% off", tour],
  ["Arrives in 3 business days or it's free", mug],
];

const only = process.env.ONLY ? Number(process.env.ONLY) : null;
await Promise.all(
  cases.map(async ([text, product], i) => {
    if (only !== null && only !== i) return;
    const t = Date.now();
    try {
      const c = await compilePromise(text, product, "America/New_York");
      console.log(`\n### [${i}] ${text}  (${((Date.now() - t) / 1000).toFixed(1)}s, ${process.env.KEPT_MODEL ?? "haiku"})\n${JSON.stringify(c, null, 2)}`);
    } catch (e) {
      console.log(`\n### [${i}] ${text}  FAILED after ${((Date.now() - t) / 1000).toFixed(1)}s: ${(e as Error).message}`);
    }
  }),
);

if (only === null || process.env.NARRATE) {
  const order = { id: "ord_1", buyer_name: "Maya Chen", amount_total: 44.4, amount_shipping: 6.4, event_date: null, event_location: null, promise_snapshot: null } as unknown as Order;
  const verdict: Verdict = {
    breached: true, final: true, reason: "Not delivered by the Friday 11:59 pm deadline.",
    evidence: { source: "carrier_tracking", observed: { status: "delayed", location: "Worcester, MA", at: "2026-11-13T23:59:00-05:00" }, summary: "Tracking still showed 'delayed in Worcester, MA' at 11:59 pm Friday", final: true },
  };
  const t = Date.now();
  const msg = await writeRefundMessage(order, "Tidepool Mug", verdict, 6.4);
  console.log(`\n### narrator (${((Date.now() - t) / 1000).toFixed(1)}s, ${msg.length} chars)\n${msg}`);
  const fb = fallbackRefundMessage(order, "Tidepool Mug", verdict, 6.4);
  console.log(`### fallback (${fb.length} chars)\n${fb}`);
}
