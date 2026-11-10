import type { AgentEvent, CarrierEvent, CompiledPromise, Order, OrderStatus, Product, PromiseRecord } from "../../server/types.ts";

export type { AgentEvent, CarrierEvent, CompiledPromise, Order, OrderStatus, Product, PromiseRecord };

export type Merchant = {
  name: string;
  tagline: string;
  timezone: string;
  monthly_guarantee_budget: number;
  home: { name: string; lat: number; lon: number };
};

export type Config = {
  merchant: Merchant;
  paypal_client_id?: string;
  now: string;
  clock_offset_ms: number;
};

export type ProductWithPromise = Product & { promise: PromiseRecord | null; promise_open?: boolean };
export type OrderRow = Order & { product_name: string };
export type OrderDetail = { order: Order; product: Product | undefined; carrier_events: CarrierEvent[]; agent_events: AgentEvent[]; pending_payout?: number | null };
export type Stats = {
  orders: number;
  revenue: number;
  watching: number;
  kept: number;
  refunded: number;
  held: number;
  declined: number;
  paid_out: number;
  budget: number;
  budget_used: number;
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Can't reach the Kept server. Is `npm run dev:api` running?", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const errField = data && typeof data === "object" && "error" in data ? (data as { error: unknown }).error : null;
    const msg = errField ? (typeof errField === "string" ? errField : JSON.stringify(errField)) : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });

// ---------- Promise ideas (POST /api/promises/suggest) ----------

export type ExpectedCost = {
  probability: number;
  payout: number;
  expected: number;
  method: "weather_history" | "carrier_assumption";
  basis: string;
};
export type PromiseIdea = {
  title: string;
  promise_text: string;
  why: string;
  factors: string[];
  promise: PromiseRecord | null;
  cost: ExpectedCost | null;
  error: string | null;
};
export type MomentContext = {
  today: string;
  weekday: string;
  part_of_day: string;
  season: string;
  location: string;
  upcoming_holidays: { name: string; date: string; days_away: number }[];
  forecast: { date: string; weekday: string; rain_mm: number; rain_chance_pct: number | null; high_c: number; low_c: number; wind_max_kmh: number }[];
  climate: { years: number; window: string } | null;
};
export type SuggestResponse = { context: MomentContext; ideas: PromiseIdea[] };
