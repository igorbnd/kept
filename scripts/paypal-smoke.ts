// PayPal sandbox smoke test for server/paypal.ts. Never prints credentials or tokens.
//   npx tsx --env-file=.env scripts/paypal-smoke.ts
// 1) creates a wallet order (needs buyer approval -> prints the approve link)
// 2) creates a sandbox card order (no approval), captures it, partially refunds $6.40, attaches tracking.
import type { Product } from "../server/types.ts";
import { addTracking, captureOrder, createOrder, getAccessToken, refundCapture, SANDBOX_TEST_CARD } from "../server/paypal.ts";

const product: Product = {
  id: "prod_smoke",
  name: "Smoke-fired stoneware mug",
  description: "Hand-thrown, 12 oz.",
  price: 38,
  shipping: 6.4,
  image: "☕",
  kind: "physical",
  promise_id: null,
};

const ref = `smoke_${Date.now()}`;
const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    const r = await fn();
    console.log(`OK   ${label}`, r === undefined ? "" : JSON.stringify(r));
    return r;
  } catch (e) {
    console.log(`FAIL ${label}: ${(e as Error).message}`);
    process.exitCode = 1;
    return undefined;
  }
};

await step("auth", async () => ((await getAccessToken()) ? "token acquired" : "no token"));
await step("createOrder (PayPal wallet, physical)", () => createOrder(product, { orderRef: `${ref}_w`, description: "Smoke mug — Arrives by Friday or shipping's on us" }));
await step("createOrder (PayPal wallet, experience)", () => createOrder({ ...product, id: "prod_tour", kind: "experience", shipping: 0, name: "Harbor kayak tour" }, { orderRef: `${ref}_x` }));

const card = await step("createOrder (sandbox card)", () => createOrder(product, { orderRef: `${ref}_c`, card: SANDBOX_TEST_CARD }));
if (card) {
  // Card orders are usually COMPLETED at create; captureOrder then reads back the existing capture.
  const cap = await step("captureOrder", () => captureOrder(card.id));
  if (cap?.capture_id) {
    await step("refundCapture $6.40 (partial)", () => refundCapture(cap.capture_id, 6.4, "Your parcel missed Friday, so shipping is on us.", `refund-${ref}`, `${ref}-r1`));
    await step("refundCapture replay (same key → same refund)", () => refundCapture(cap.capture_id, 6.4, "replay", `refund-${ref}`, `${ref}-r1`));
    await step("addTracking", () => addTracking(card.id, cap.capture_id, `KP${Date.now().toString().slice(-10)}`, "KeptPost"));
  }
}
