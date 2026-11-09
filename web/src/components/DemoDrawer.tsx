import { useEffect, useState } from "react";
import { api, post, type OrderRow } from "../api.ts";
import { announceWorldChanged, fmtDateTime, nextSaturdayMorning, useClock, usePoll, useToast, ymdIn } from "../lib.tsx";
import { LOCATIONS } from "../pages/Shop.tsx";
import { Spinner, StatusPill } from "./ui.tsx";

type CarrierStatus = "picked_up" | "delayed" | "out_for_delivery" | "delivered";
const CARRIER_ACTIONS: { status: CarrierStatus; label: string; description: string; location: string }[] = [
  { status: "picked_up", label: "Picked up", description: "Picked up by carrier", location: "Portland, ME" },
  { status: "delayed", label: "Delayed (weather)", description: "Delayed: severe weather at regional hub", location: "Hartford, CT" },
  { status: "out_for_delivery", label: "Out for delivery", description: "Out for delivery", location: "Local delivery station" },
  { status: "delivered", label: "Delivered", description: "Delivered, left at front door", location: "Front porch" },
];

export function DemoDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { config, serverNow, refresh } = useClock();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const orders = usePoll((signal) => (open ? api<OrderRow[]>("/api/orders", { signal }) : Promise.resolve(null)), open ? 3000 : 0, [open]);
  const [wDate, setWDate] = useState(() => ymdIn(serverNow()));
  const [wLoc, setWLoc] = useState(LOCATIONS[0].name);
  const [wMm, setWMm] = useState("6");

  // Default the override date to the simulated "today" each time the drawer opens (not the browser's date).
  useEffect(() => {
    if (open) setWDate(ymdIn(serverNow()));
  }, [open, serverNow]);

  const now = serverNow();
  const offsetH = (config?.clock_offset_ms ?? 0) / 3600_000;

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, "success");
      await refresh();
      announceWorldChanged();
      orders.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  const advance = (hours: number, label: string) => run(label, () => post("/api/demo/clock", { hours }), `Clock moved ${label}`);
  const toSaturday = () => {
    const target = nextSaturdayMorning(serverNow());
    const hours = +((target.getTime() - serverNow().getTime()) / 3600_000).toFixed(4);
    return run("sat", () => post("/api/demo/clock", { hours }), `Jumped to ${fmtDateTime(target.toISOString())}`);
  };

  const rank = (s: string) => (s === "paid" ? 0 : s === "breached" ? 1 : 2);
  const shippable = (orders.data ?? []).filter((o) => o.tracking_number).sort((a, b) => rank(a.status) - rank(b.status));

  return (
    <>
      <div className={`drawer-scrim ${open ? "open" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "open" : ""}`} aria-hidden={!open} aria-label="Demo controls">
        <div className="drawer-head">
          <div>
            <div className="eyebrow">For the demo &amp; judges</div>
            <h2 className="serif">Demo controls</h2>
          </div>
          <button className="sheet-close static" onClick={onClose} aria-label="Close demo controls">
            ×
          </button>
        </div>
        <p className="muted small">This drawer plays “the world”: time, the carrier, the sky. Kept's agent only reacts to what it observes.</p>

        <section className="drawer-section">
          <h4>Simulated clock</h4>
          <div className="clock-face">
            <div className="clock-time">{config ? fmtDateTime(now.toISOString(), config.merchant.timezone) : "—"}</div>
            <div className="muted xsmall">
              {config?.merchant.timezone ?? "America/New_York"} · {offsetH === 0 ? "real time" : `+${offsetH.toFixed(1)}h ahead of real time`}
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-sm" disabled={!!busy} onClick={() => advance(24, "+1 day")}>
              {busy === "+1 day" ? <Spinner size={12} /> : null} +1 day
            </button>
            <button className="btn btn-sm" disabled={!!busy} onClick={toSaturday}>
              {busy === "sat" ? <Spinner size={12} /> : null} Jump to Saturday 00:01
            </button>
            <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => run("reset-clock", () => post("/api/demo/clock", { reset: true }), "Clock reset to real time")}>
              Reset clock
            </button>
          </div>
        </section>

        <section className="drawer-section">
          <h4>Carrier scans</h4>
          {shippable.length === 0 ? (
            <p className="muted small">No shipped orders yet. Buy a mug to get a tracking number.</p>
          ) : (
            <div className="carrier-list">
              {shippable.slice(0, 6).map((o) => (
                <div key={o.id} className="carrier-item">
                  <div className="carrier-item-head">
                    <a href={`#/order/${o.id}`} onClick={onClose}>
                      <strong>{o.product_name}</strong>
                    </a>
                    <StatusPill status={o.status} />
                  </div>
                  <div className="muted xsmall">
                    <code>{o.tracking_number}</code> · {o.buyer_name ?? "buyer"}
                  </div>
                  {(o.status === "paid" || o.status === "breached") && (
                  <div className="carrier-btns">
                    {CARRIER_ACTIONS.map((a) => (
                      <button
                        key={a.status}
                        className={`btn btn-xs ${a.status === "delayed" ? "btn-warn" : a.status === "delivered" ? "btn-ok" : ""}`}
                        disabled={!!busy}
                        onClick={() =>
                          run(`${o.id}:${a.status}`, () => post(`/api/demo/carrier/${encodeURIComponent(o.tracking_number!)}`, { status: a.status, description: a.description, location: a.location }), `${a.label} · ${o.tracking_number}`)
                        }
                      >
                        {busy === `${o.id}:${a.status}` ? <Spinner size={10} /> : null}
                        {a.label}
                      </button>
                    ))}
                  </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="drawer-section">
          <h4>Weather override</h4>
          <p className="sim-label">Simulated — real Open-Meteo data is used unless you override</p>
          <div className="field-row three">
            <label className="field">
              <span>Date</span>
              <input type="date" value={wDate} onChange={(e) => setWDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Location</span>
              <select value={wLoc} onChange={(e) => setWLoc(e.target.value)}>
                {LOCATIONS.map((l) => (
                  <option key={l.name}>{l.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Rain (mm)</span>
              <input type="number" min={0} step={0.5} value={wMm} onChange={(e) => setWMm(e.target.value)} />
            </label>
          </div>
          <div className="btn-row">
            <button
              className="btn btn-sm"
              disabled={!!busy || wMm === ""}
              onClick={() => run("weather", () => post("/api/demo/weather", { date: wDate, location: wLoc, precipitation_mm: Number(wMm) }), `Weather set: ${wMm} mm on ${wDate} in ${wLoc}`)}
            >
              {busy === "weather" ? <Spinner size={12} /> : "🌧"} Set rain
            </button>
            <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => run("weather-clear", () => post("/api/demo/weather", { date: wDate, location: wLoc, precipitation_mm: null }), "Override cleared, using real weather")}>
              Clear override
            </button>
          </div>
        </section>

        <section className="drawer-section">
          <h4>Agent</h4>
          <div className="btn-row">
            <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run("tick", () => post("/api/demo/tick"), "Agent ran a check")}>
              {busy === "tick" ? <Spinner size={12} /> : "▶"} Run agent now
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={!!busy}
              onClick={() => {
                if (window.confirm("Reset the demo? This clears every order, event and promise, and restocks the catalog.")) run("reset", () => post("/api/demo/reset"), "Demo reset");
              }}
            >
              Reset demo
            </button>
          </div>
        </section>
      </aside>
    </>
  );
}
