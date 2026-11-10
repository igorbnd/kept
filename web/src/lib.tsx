import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type CompiledPromise, type Config, type OrderStatus } from "./api.ts";

// ---------- formatting ----------

export const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export const TZ = "America/New_York";

export function fmtDateTime(iso: string | null | undefined, tz = TZ) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function fmtTime(iso: string, tz = TZ) {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}
export function fmtDay(iso: string, tz = TZ) {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
}
export function fmtEventDate(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

/** YYYY-MM-DD of an instant in a timezone. */
export function ymdIn(date: Date, tz = TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Offset (ms) of a timezone vs UTC at an instant: local wall time minus UTC. */
function tzOffsetMs(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(date);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The next Saturday 00:01 (merchant tz) strictly after `now`. */
export function nextSaturdayMorning(now: Date, tz = TZ): Date {
  const local = new Date(now.getTime() + tzOffsetMs(now, tz)); // wall-clock as UTC fields
  const dow = local.getUTCDay();
  let days = (6 - dow + 7) % 7;
  const candidate = (d: number) => {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, 0, 1);
    const guess = new Date(wall - tzOffsetMs(new Date(wall), tz));
    return new Date(wall - tzOffsetMs(guess, tz));
  };
  let target = candidate(days);
  if (target.getTime() <= now.getTime()) target = candidate(days + 7);
  return target;
}

export function countdown(ms: number) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = d > 0 ? [`${d}d`, `${h}h`, `${m}m`] : h > 0 ? [`${h}h`, `${m}m`, `${s}s`] : [`${m}m`, `${s}s`];
  return { text: parts.join(" "), neg };
}

export function timeAgo(iso: string, nowMs: number) {
  const s = Math.round((nowMs - new Date(iso).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------- promise rule → readable parts ----------

type Rule = NonNullable<CompiledPromise["rule"]>;
type Deadline = Extract<Rule["condition"], { kind: "delivered_by" }>["deadline"];

const fmtYmd = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function describeDeadline(d: Deadline) {
  switch (d.kind) {
    case "weekday_after_purchase":
      return `by ${cap(d.weekday)}`;
    case "business_days_after_purchase":
      return `within ${d.days} business day${d.days === 1 ? "" : "s"}`;
    case "hours_after_purchase":
      return `within ${d.hours} hours`;
    case "by_date":
      return `by ${fmtYmd(d.date)}${d.order_by ? ` (orders by ${fmtYmd(d.order_by)})` : ""}`;
  }
}

const METRIC: Record<string, { label: string; unit: string }> = {
  precipitation_mm: { label: "Rain", unit: "mm" },
  max_temp_c: { label: "High temp", unit: "°C" },
  min_temp_c: { label: "Low temp", unit: "°C" },
  max_wind_kmh: { label: "Wind", unit: "km/h" },
};
const OP: Record<string, string> = { ">": ">", ">=": "≥", "<": "<", "<=": "≤" };

const hour12 = (h: number) => (h === 0 || h === 24 ? "12 am" : h === 12 ? "12 pm" : h < 12 ? `${h} am` : `${h - 12} pm`);

export function ruleChips(rule: Rule): { when: string[]; pay: string } {
  const c = rule.condition;
  let when: string[];
  if (c.kind === "delivered_by") when = ["not delivered", describeDeadline(c.deadline)];
  else if (c.kind === "shipped_by") when = ["not shipped", describeDeadline(c.deadline)];
  else {
    const m = METRIC[c.metric] ?? { label: c.metric, unit: "" };
    when = [m.label, `${OP[c.op] ?? c.op} ${c.threshold} ${m.unit}`, c.hours ? `${hour12(c.hours.start)}–${hour12(c.hours.end)} on event day` : "on event day"];
  }
  const p = rule.payout;
  const pay = p.kind === "shipping_cost" ? "shipping cost" : p.kind === "fixed" ? money(p.amount) : `${p.percent}% of total`;
  return { when, pay };
}

export const SOURCE_LABEL: Record<CompiledPromise["data_source"], string> = {
  carrier_tracking: "Carrier tracking",
  open_meteo_weather: "Open-Meteo weather",
  none: "No data source",
};

export const STATUS_META: Record<OrderStatus, { label: string; tone: string }> = {
  created: { label: "Unpaid", tone: "muted" },
  paid: { label: "Watching", tone: "teal" },
  kept: { label: "Kept", tone: "green" },
  breached: { label: "Refunding", tone: "amber" },
  refunded: { label: "Refunded", tone: "green-strong" },
  failed: { label: "Needs review", tone: "red" },
  held: { label: "Held", tone: "amber" },
  declined: { label: "Declined", tone: "muted" },
};

// ---------- toasts ----------

type Toast = { id: number; text: string; tone: "info" | "error" | "success" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const push = useCallback((text: string, tone: Toast["tone"] = "info") => {
    // De-dupe identical messages from polling loops.
    const nowMs = Date.now();
    if (lastRef.current.text === text && nowMs - lastRef.current.at < 8000) return;
    lastRef.current = { text, at: nowMs };
    const id = nowMs + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6500 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span className="toast-icon">{t.tone === "error" ? "!" : t.tone === "success" ? "✓" : "i"}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- server clock ----------

type ClockCtxValue = { config: Config | null; serverNow: () => Date; refresh: () => Promise<void>; error: string | null };
const ClockCtx = createContext<ClockCtxValue>({ config: null, serverNow: () => new Date(), refresh: async () => {}, error: null });
export const useClock = () => useContext(ClockCtx);

export function ClockProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const skew = useRef(0);
  const refresh = useCallback(async () => {
    try {
      const t0 = Date.now();
      const c = await api<Config>("/api/config");
      const t1 = Date.now();
      skew.current = new Date(c.now).getTime() - (t0 + t1) / 2;
      setConfig(c);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    const onClock = () => refresh();
    window.addEventListener("kept:clock", onClock);
    return () => {
      clearInterval(id);
      window.removeEventListener("kept:clock", onClock);
    };
  }, [refresh]);
  const serverNow = useCallback(() => new Date(Date.now() + skew.current), []);
  return <ClockCtx.Provider value={{ config, serverNow, refresh, error }}>{children}</ClockCtx.Provider>;
}

/** Re-renders every `ms` and returns the current simulated server time. */
export function useServerNow(ms = 1000) {
  const { serverNow, config } = useClock();
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  void config;
  return serverNow();
}

/** Tell everything polling the server that the world changed (demo controls). */
export const announceWorldChanged = () => {
  window.dispatchEvent(new Event("kept:clock"));
  window.dispatchEvent(new Event("kept:refresh"));
};

// ---------- polling ----------

export function usePoll<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [bump, setBump] = useState(0);
  const reload = useCallback(() => setBump((b) => b + 1), []);
  useEffect(() => {
    let alive = true;
    let seq = 0; // newest request wins: a slow older poll must not overwrite fresher data
    let inflight = 0;
    const ctrl = new AbortController();
    const run = async (fromTimer = false) => {
      if (fromTimer && inflight > 0) return; // don't pile up requests behind a slow server
      const mine = ++seq;
      inflight++;
      try {
        const d = await fnRef.current(ctrl.signal);
        if (!alive || mine !== seq) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (!alive || mine !== seq || (e as Error).name === "AbortError") return;
        setError((e as Error).message);
      } finally {
        inflight--;
        if (alive) setLoading(false);
      }
    };
    run();
    const id = ms > 0 ? setInterval(() => run(true), ms) : undefined;
    const onRefresh = () => setTimeout(() => run(), 150);
    window.addEventListener("kept:refresh", onRefresh);
    return () => {
      alive = false;
      ctrl.abort();
      if (id) clearInterval(id);
      window.removeEventListener("kept:refresh", onRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, bump, ...deps]);
  return { data, error, loading, reload, setData };
}

// ---------- hash routing ----------

export function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const path = hash.replace(/^#/, "") || "/";
  return path;
}

export const go = (path: string) => {
  window.location.hash = path;
};
