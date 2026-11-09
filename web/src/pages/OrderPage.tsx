import { useEffect, useRef, useState } from "react";
import { api, type AgentEvent, type CarrierEvent, type OrderDetail } from "../api.ts";
import { countdown, fmtDateTime, fmtEventDate, money, ruleChips, SOURCE_LABEL, useClock, usePoll, useServerNow } from "../lib.tsx";
import { Empty, ErrorNote, PromisePill, ShieldCheck, Skeleton, Spinner } from "../components/ui.tsx";

export function OrderPage({ id }: { id: string }) {
  const { data, error, loading } = usePoll((signal) => api<OrderDetail>(`/api/orders/${id}`, { signal }), 2000, [id]);

  if (loading && !data) return <OrderSkeleton />;
  if (!data)
    return (
      <div className="page narrow">
        <Empty icon="🔎" title="We couldn't find that order" action={<a className="btn" href="#/">Back to the shop</a>}>
          {error ?? "It may have been cleared by a demo reset."}
        </Empty>
      </div>
    );

  const { order, product } = data;
  const promise = order.promise_snapshot;
  return (
    <div className="page order-page">
      <a href="#/" className="backlink">
        ← Harbor &amp; Clay
      </a>
      {error && <ErrorNote>Live updates paused: {error}</ErrorNote>}
      <div className="order-grid">
        <div className="order-main">
          <StatusCard data={data} />
          <section className="card order-summary">
            <div className="order-summary-head">
              <span className="order-emoji">{product?.image ?? "📦"}</span>
              <div>
                <h3 className="serif">{product?.name ?? "Your order"}</h3>
                <div className="muted small">
                  Order <code>{order.id}</code> · {fmtDateTime(order.created_at)}
                </div>
              </div>
              <div className="order-paid">
                <span className="muted small">Paid</span>
                <strong>{money(order.amount_total)}</strong>
              </div>
            </div>
            {promise ? (
              <div className="order-promise">
                <PromisePill text={promise.badge} />
                <p>{promise.plain_english}</p>
                {promise.rule && <RuleRow rule={promise.rule} />}
                <div className="order-meta">
                  <span>
                    <b>Evidence</b> {SOURCE_LABEL[promise.data_source]}
                  </span>
                  {order.tracking_number && (
                    <span>
                      <b>Tracking</b> <code>{order.tracking_number}</code>
                    </span>
                  )}
                  {order.event_date && (
                    <span>
                      <b>Tour</b> {fmtEventDate(order.event_date)}
                      {order.event_location ? ` · ${order.event_location.name}` : ""}
                    </span>
                  )}
                  {order.buyer_name && (
                    <span>
                      <b>Buyer</b> {order.buyer_name}
                    </span>
                  )}
                </div>
                <p className="frozen">
                  <ShieldCheck size={12} /> This promise was frozen at purchase. The shop can't change it on you.
                </p>
              </div>
            ) : (
              <p className="muted">No promise was attached to this order.</p>
            )}
          </section>
        </div>
        <Timeline data={data} />
      </div>
    </div>
  );
}

function OrderSkeleton() {
  return (
    <div className="page order-page">
      <div className="order-grid">
        <div className="order-main">
          <div className="card status-card">
            <Skeleton w={180} h={14} />
            <Skeleton w="70%" h={38} style={{ marginTop: 16 }} />
            <Skeleton w="50%" style={{ marginTop: 14 }} />
          </div>
          <div className="card">
            <Skeleton w="40%" h={20} />
            <Skeleton w="90%" style={{ marginTop: 14 }} />
            <Skeleton w="80%" style={{ marginTop: 8 }} />
          </div>
        </div>
        <div className="card">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", gap: 12, marginBottom: 18 }}>
              <Skeleton w={28} h={28} r={99} />
              <div style={{ flex: 1 }}>
                <Skeleton w="60%" />
                <Skeleton w="35%" h={10} style={{ marginTop: 8 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RuleRow({ rule }: { rule: NonNullable<NonNullable<OrderDetail["order"]["promise_snapshot"]>["rule"]> }) {
  const { when, pay } = ruleChips(rule);
  return (
    <div className="rule-row">
      <span className="rule-kw">IF</span>
      {when.map((w) => (
        <span className="rule-chip" key={w}>
          {w}
        </span>
      ))}
      <span className="rule-arrow">→</span>
      <span className="rule-kw">PAY</span>
      <span className="rule-chip rule-chip-pay">{pay}</span>
    </div>
  );
}

function CheckDraw({ size = 76 }: { size?: number }) {
  return (
    <svg className="check-draw" width={size} height={size} viewBox="0 0 80 80" aria-hidden="true">
      <circle className="check-circle" cx="40" cy="40" r="35" fill="none" strokeWidth="4" />
      <path className="check-path" d="M24 41.5 35 52.5 57 29" fill="none" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function useCountUp(target: number, active: boolean, ms = 1100) {
  const [v, setV] = useState(active ? 0 : target);
  useEffect(() => {
    if (!active) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, active, ms]);
  return v;
}

function StatusCard({ data }: { data: OrderDetail }) {
  const { order } = data;
  const now = useServerNow(1000);
  const firstStatus = useRef(order.status);
  // Celebrate when we *watched* the flip happen (or on first view of a refunded order — still lovely).
  const flipped = firstStatus.current !== "refunded" && order.status === "refunded";
  const amount = useCountUp(order.payout_amount ?? 0, order.status === "refunded");

  const promise = order.promise_snapshot;
  const isWeather = promise?.rule?.condition.kind === "weather";

  if (order.status === "refunded") {
    return (
      <section className={`card status-card status-refunded ${flipped ? "flipped" : ""}`}>
        <div className="refund-glow" />
        <div className="refund-top">
          <CheckDraw />
          <div>
            <div className="status-eyebrow tone-green">Promise broken → refunded automatically</div>
            <div className="refund-amount">{money(amount)}</div>
            <div className="refund-sub">refunded to your PayPal — nobody had to ask.</div>
          </div>
        </div>
        {order.customer_message && (
          <blockquote className="customer-quote">
            <p>{order.customer_message}</p>
            <footer>— Harbor &amp; Clay, via Kept</footer>
          </blockquote>
        )}
        <div className="refund-meta">
          {order.paypal_refund_id && (
            <span>
              PayPal refund <code>{order.paypal_refund_id}</code>
            </span>
          )}
          {order.resolved_at && <span>{fmtDateTime(order.resolved_at)}</span>}
        </div>
      </section>
    );
  }

  if (order.status === "kept") {
    return (
      <section className="card status-card status-kept">
        <div className="refund-top">
          <CheckDraw size={60} />
          <div>
            <div className="status-eyebrow tone-green">Resolved</div>
            <h1 className="status-title">Promise kept ✓</h1>
            <p className="muted">{promise ? `“${promise.badge}” — and it was.` : "All good."} No refund needed{order.resolved_at ? `, confirmed ${fmtDateTime(order.resolved_at)}` : ""}.</p>
          </div>
        </div>
      </section>
    );
  }

  if (order.status === "breached") {
    return (
      <section className="card status-card status-breached">
        <div className="status-eyebrow tone-amber">
          <Spinner size={12} /> Promise broken
        </div>
        <h1 className="status-title">Sending your refund now…</h1>
        <p className="muted">Kept found the evidence and is paying out through PayPal. This page will update by itself.</p>
      </section>
    );
  }

  if (order.status === "failed") {
    return (
      <section className="card status-card status-failed">
        <div className="status-eyebrow tone-red">Needs a human</div>
        <h1 className="status-title">Your refund is approved, pending a quick review</h1>
        <p className="muted">Kept paused the automatic payout (the timeline says why) and alerted the shop, who will finish it by hand. You don't need to do anything.</p>
      </section>
    );
  }

  if (order.status === "created") {
    return (
      <section className="card status-card">
        <div className="status-eyebrow">Awaiting payment</div>
        <h1 className="status-title">Finish checkout to start the watch</h1>
        <p className="muted">This order hasn't been captured in PayPal yet.</p>
      </section>
    );
  }

  // paid → watching
  const deadline = order.deadline_at ? new Date(order.deadline_at) : null;
  const left = deadline ? countdown(deadline.getTime() - now.getTime()) : null;
  return (
    <section className="card status-card status-watching">
      <div className="status-eyebrow tone-teal">
        <span className="live-dot" /> Live
      </div>
      <h1 className="status-title">Watching your promise</h1>
      {promise && <p className="status-badge-line">“{promise.badge}”</p>}
      <div className="watch-strip">
        {deadline && left && (
          <div className="watch-stat">
            <span className="watch-label">{left.neg ? "Deadline passed" : "Deadline in"}</span>
            <span className="watch-value mono">{left.neg ? `${left.text} ago` : left.text}</span>
            <span className="watch-foot">{fmtDateTime(order.deadline_at)}</span>
          </div>
        )}
        {isWeather && order.event_date && (
          <div className="watch-stat">
            <span className="watch-label">Tour day</span>
            <span className="watch-value">{fmtEventDate(order.event_date)}</span>
            <span className="watch-foot">{order.event_location?.name ?? ""} · checked against Open-Meteo</span>
          </div>
        )}
        <div className="watch-stat">
          <span className="watch-label">If it breaks</span>
          <span className="watch-value">{promise?.rule ? ruleChips(promise.rule).pay : "—"}</span>
          <span className="watch-foot">refunded automatically</span>
        </div>
      </div>
    </section>
  );
}

type TItem = { key: string; at: string; icon: string; tone: string; title: string; detail?: string; future?: boolean };

const AGENT_ICON: Record<AgentEvent["kind"], { icon: string; tone: string }> = {
  compiled: { icon: "✎", tone: "teal" },
  watching: { icon: "◉", tone: "teal" },
  evidence: { icon: "⌕", tone: "ink" },
  kept: { icon: "✓", tone: "green" },
  breach: { icon: "!", tone: "amber" },
  refund: { icon: "$", tone: "green" },
  error: { icon: "×", tone: "red" },
  info: { icon: "i", tone: "muted" },
};
const CARRIER_LABEL: Record<CarrierEvent["status"], string> = {
  label_created: "Label created",
  picked_up: "Picked up",
  in_transit: "In transit",
  delayed: "Delayed",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
};

function Timeline({ data }: { data: OrderDetail }) {
  const { order, carrier_events, agent_events } = data;
  const now = useServerNow(1000);
  const { config } = useClock();
  void config;
  const items: TItem[] = [
    { key: "placed", at: order.created_at, icon: "●", tone: "ink", title: "Order placed", detail: money(order.amount_total) },
    ...carrier_events.map((e) => ({
      key: e.id,
      at: e.at,
      icon: e.status === "delivered" ? "✓" : e.status === "delayed" ? "!" : "▸",
      tone: e.status === "delivered" ? "green" : e.status === "delayed" ? "amber" : "ink",
      title: `Carrier: ${CARRIER_LABEL[e.status]}`,
      detail: [e.description, e.location].filter(Boolean).join(" · "),
    })),
    ...agent_events.map((e) => ({ key: e.id, at: e.at, ...AGENT_ICON[e.kind], title: e.message, detail: `Kept agent · ${e.kind}` })),
  ];
  if (order.deadline_at && (order.status === "paid" || order.status === "created")) {
    const left = countdown(new Date(order.deadline_at).getTime() - now.getTime());
    items.push({
      key: "deadline",
      at: order.deadline_at,
      icon: "⏱",
      tone: "teal",
      title: left.neg ? "Deadline passed" : `Deadline · ${left.text} to go`,
      future: !left.neg,
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));

  return (
    <aside className="card timeline-card">
      <div className="timeline-head">
        <h3 className="serif">Timeline</h3>
        <span className="muted small">
          <span className="live-dot small" /> updates every 2s
        </span>
      </div>
      <ol className="timeline">
        {items.map((it) => (
          <li key={it.key} className={`tl-item ${it.future ? "future" : ""}`}>
            <span className={`tl-icon tone-${it.tone}`}>{it.icon}</span>
            <div className="tl-body">
              <div className="tl-title">{it.title}</div>
              {it.detail && <div className="tl-detail">{it.detail}</div>}
              <div className="tl-at">{fmtDateTime(it.at)}</div>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
