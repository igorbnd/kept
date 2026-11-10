// Smoke test for the breach assessor. Run: npx tsx --env-file=.env scripts/assess-smoke.ts
import { assessBreach } from "../server/ai/assessor.ts";
import type { CarrierEvent, Order, Verdict } from "../server/types.ts";

const order = {
  id: "ord_smoke", amount_total: 44.4, amount_shipping: 6.4, buyer_name: "Sam Rivera", deadline_at: "2026-11-14T04:59:59.000Z",
  promise_snapshot: { badge: "Arrives by Friday — or shipping's on us", plain_english: "If carrier tracking doesn't show the parcel delivered by 11:59 pm Friday (shop time), the buyer is refunded the shipping they paid." },
} as unknown as Order;
const scans = (last: [CarrierEvent["status"], string, string]): CarrierEvent[] => [
  { id: "1", tracking_number: "KP1", status: "label_created", description: "Label created", location: "Portland, ME", at: "2026-11-10T15:00:00Z" },
  { id: "2", tracking_number: "KP1", status: "picked_up", description: "Picked up by carrier", location: "Portland, ME", at: "2026-11-11T15:00:00Z" },
  { id: "3", tracking_number: "KP1", status: last[0], description: last[1], location: last[2], at: "2026-11-13T18:00:00Z" },
];
const cases: [string, CarrierEvent["status"], string, string][] = [
  ["attempted", "exception", "Delivery attempted — no one available to sign", "Portland, ME"],
  ["weather", "delayed", "Delayed — weather", "Worcester, MA"],
  ["returned", "exception", "Returned to sender — address incomplete", "Portland, ME"],
  ["lost", "exception", "Lost in transit", "Hartford, CT"],
];
await Promise.all(
  cases.map(async ([name, status, desc, loc]) => {
    const ev = scans([status, desc, loc]);
    const verdict: Verdict = { breached: true, final: true, reason: "Not delivered by Fri 11:59 pm", evidence: { source: "carrier_tracking", observed: {}, summary: `Last scan: '${desc}' in ${loc}. Not delivered by Fri 11:59 pm.`, final: true } };
    const r = await assessBreach(order, "Tidepool Mug", verdict, ev);
    console.log(`${name.padEnd(10)} ${(r.latency_ms / 1000).toFixed(1)}s  ${r.attribution}/${r.confidence} hold=${r.hold}  ${r.reason}${r.error ? `  [error: ${r.error}]` : ""}`);
  }),
);
