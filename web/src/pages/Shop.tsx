import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, post, type ProductWithPromise } from "../api.ts";
import { go, money, useClock, usePoll, useToast, ymdIn } from "../lib.tsx";
import { Empty, ErrorNote, PromisePill, ShieldCheck, Skeleton, Spinner } from "../components/ui.tsx";

export const LOCATIONS = [
  { name: "Portland, ME", lat: 43.6591, lon: -70.2568 },
  { name: "Seattle, WA", lat: 47.6062, lon: -122.3321 },
  { name: "Miami, FL", lat: 25.7617, lon: -80.1918 },
  { name: "London, UK", lat: 51.5072, lon: -0.1276 },
];

export function Shop() {
  const { config } = useClock();
  const { data: products, error, loading } = usePoll((signal) => api<ProductWithPromise[]>("/api/products", { signal }), 10000);
  const [buying, setBuying] = useState<ProductWithPromise | null>(null);

  return (
    <div className="page shop">
      <section className="shop-hero">
        <div>
          <div className="eyebrow">{config?.merchant.tagline ?? "Handmade in Portland, Maine"}</div>
          <h1 className="display">{config?.merchant.name ?? "Harbor & Clay"}</h1>
          <p className="lede">Small-batch stoneware and sunset paddles on Casco Bay. Every promise on this page is watched by Kept and refunded automatically if it breaks.</p>
        </div>
        <div className="hero-trust">
          <ShieldCheck size={22} className="hero-trust-icon" />
          <div>
            <strong>Guarantees that pay out on their own</strong>
            <span>No forms, no emails, no arguing. If the evidence says we missed, the money is already on its way back.</span>
          </div>
        </div>
      </section>

      {error && !products && <ErrorNote>Couldn't load the shop: {error}</ErrorNote>}

      <section className="product-grid">
        {loading && !products
          ? [0, 1, 2].map((i) => (
              <div className="product-card" key={i}>
                <div className="product-art skeleton-art" />
                <div className="product-body">
                  <Skeleton w="60%" h={22} />
                  <Skeleton w="90%" />
                  <Skeleton w="70%" h={28} r={99} style={{ marginTop: 10 }} />
                </div>
              </div>
            ))
          : products?.map((p) => {
              const live = p.promise?.status === "active" ? p.promise.compiled : null;
              return (
                <article className="product-card" key={p.id}>
                  <div className={`product-art art-${p.kind}`}>
                    <span className="product-emoji" aria-hidden="true">
                      {p.image}
                    </span>
                    <span className="product-kind">{p.kind === "experience" ? "Experience" : "Ships from Portland"}</span>
                  </div>
                  <div className="product-body">
                    <div className="product-title-row">
                      <h3>{p.name}</h3>
                      <span className="price">{money(p.price)}</span>
                    </div>
                    <p className="muted">{p.description}</p>
                    <div className="product-promise">
                      {live ? <PromisePill text={live.badge} /> : <span className="no-promise">No promise yet — write one in Promise Studio</span>}
                    </div>
                    <div className="product-foot">
                      <span className="muted small">{p.shipping > 0 ? `+ ${money(p.shipping)} shipping` : "No shipping"}</span>
                      <button className="btn btn-primary" onClick={() => setBuying(p)}>
                        Buy
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
      </section>

      {products && products.length === 0 && (
        <Empty icon="🏺" title="The shelves are empty">
          Open Demo controls and press “Reset demo” to restock the catalog.
        </Empty>
      )}

      <section className="how">
        <div className="how-step">
          <span className="how-num">1</span>
          <h4>The shop writes a promise</h4>
          <p>In plain English. Claude compiles it into a rule the shop reviews and approves.</p>
        </div>
        <div className="how-step">
          <span className="how-num">2</span>
          <h4>Kept watches the evidence</h4>
          <p>Carrier scans and real Open-Meteo weather, checked by code, not by a model.</p>
        </div>
        <div className="how-step">
          <span className="how-num">3</span>
          <h4>You're refunded before you ask</h4>
          <p>Through PayPal, with a short note that shows the evidence.</p>
        </div>
      </section>

      {buying && <Checkout product={buying} onClose={() => setBuying(null)} />}
    </div>
  );
}

// ---------- PayPal JS SDK ----------

type PayPalNs = { Buttons: (opts: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void>; close?: () => Promise<void>; isEligible?: () => boolean } };
declare global {
  interface Window {
    paypal?: PayPalNs;
  }
}
let sdkPromise: Promise<PayPalNs> | null = null;
function loadPayPal(clientId: string): Promise<PayPalNs> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
    s.async = true;
    s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal SDK loaded without `paypal` global")));
    s.onerror = () => {
      sdkPromise = null;
      s.remove();
      reject(new Error("Couldn't load the PayPal SDK. Check your connection or client id."));
    };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

function Checkout({ product, onClose }: { product: ProductWithPromise; onClose: () => void }) {
  const { config, serverNow } = useClock();
  const toast = useToast();
  const promise = product.promise?.status === "active" ? product.promise.compiled : null;
  const isExperience = product.kind === "experience";
  const [date, setDate] = useState(() => ymdIn(serverNow()));
  const [locIdx, setLocIdx] = useState(0);
  const [sdkState, setSdkState] = useState<"loading" | "ready" | "error">("loading");
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);
  const live = useRef({ date, locIdx, orderId: "" });
  live.current.date = date;
  live.current.locIdx = locIdx;

  useEffect(() => {
    if (!config) return;
    const clientId = config.paypal_client_id;
    if (!clientId) {
      setSdkState("error");
      setSdkError("PAYPAL_CLIENT_ID isn't set on the server, so PayPal Checkout can't load.");
      return;
    }
    let cancelled = false;
    let buttons: ReturnType<PayPalNs["Buttons"]> | null = null;
    loadPayPal(clientId)
      .then((paypal) => {
        if (cancelled || !btnRef.current) return;
        buttons = paypal.Buttons({
          style: { layout: "vertical", shape: "pill", color: "gold", label: "paypal", height: 46 },
          createOrder: async () => {
            try {
              const loc = LOCATIONS[live.current.locIdx];
              const res = await post<{ order_id: string; paypal_order_id: string }>("/api/orders", {
                product_id: product.id,
                event_date: isExperience ? live.current.date : null,
                event_location: isExperience ? loc : null,
              });
              live.current.orderId = res.order_id;
              return res.paypal_order_id;
            } catch (e) {
              toast((e as Error).message, "error");
              throw e;
            }
          },
          onApprove: async () => {
            setCapturing(true);
            try {
              await post(`/api/orders/${live.current.orderId}/capture`);
              toast("Paid. Kept is now watching your promise.", "success");
              go(`/order/${live.current.orderId}`);
            } catch (e) {
              toast(`Capture failed: ${(e as Error).message}`, "error");
              setCapturing(false);
            }
          },
          onCancel: () => toast("Checkout cancelled. Nothing was charged."),
          onError: (err: unknown) => toast(`PayPal error: ${err instanceof Error ? err.message : String(err)}`, "error"),
        });
        return buttons.render(btnRef.current).then(() => !cancelled && setSdkState("ready"));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setSdkState("error");
        setSdkError(e.message);
      });
    return () => {
      cancelled = true;
      buttons?.close?.().catch(() => {});
    };
  }, [config?.paypal_client_id, product.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = product.price + product.shipping;

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Checkout: ${product.name}`}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="eyebrow">Checkout</div>
        <div className="checkout-head">
          <span className="checkout-emoji">{product.image}</span>
          <div>
            <h2 className="serif">{product.name}</h2>
            <p className="muted small">{product.description}</p>
          </div>
        </div>

        {isExperience && (
          <div className="field-row">
            <label className="field">
              <span>Tour date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Location</span>
              <select value={locIdx} onChange={(e) => setLocIdx(Number(e.target.value))}>
                {LOCATIONS.map((l, i) => (
                  <option key={l.name} value={i}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <dl className="lines">
          <div>
            <dt>{product.name}</dt>
            <dd>{money(product.price)}</dd>
          </div>
          <div>
            <dt>Shipping</dt>
            <dd>{product.shipping > 0 ? money(product.shipping) : "—"}</dd>
          </div>
          <div className="lines-total">
            <dt>Total</dt>
            <dd>{money(total)}</dd>
          </div>
        </dl>

        {promise ? (
          <div className="checkout-promise">
            <PromisePill text={promise.badge} size="lg" />
            <p className="checkout-promise-text">{promise.plain_english}</p>
            <p className="checkout-promise-kept">
              <ShieldCheck size={14} /> Kept watches this for you. If it breaks, you're refunded automatically — no claim needed.
            </p>
          </div>
        ) : (
          <div className="checkout-promise none">This item has no guarantee attached.</div>
        )}

        <div className="paypal-wrap">
          {capturing && (
            <div className="capturing">
              <Spinner /> Capturing payment and starting the watch…
            </div>
          )}
          {sdkState === "loading" && (
            <div className="paypal-skeleton">
              <Skeleton h={46} r={99} />
              <Skeleton h={46} r={99} />
            </div>
          )}
          {sdkState === "error" && <ErrorNote>{sdkError}</ErrorNote>}
          <div ref={btnRef} className="paypal-buttons" />
        </div>
        <p className="fineprint">PayPal Sandbox. Use a sandbox buyer account; no real money moves.</p>
      </aside>
    </div>,
    document.body,
  );
}
