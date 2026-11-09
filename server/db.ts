// Tiny document store on Node's built-in SQLite. Data volumes are demo-sized, so each
// entity is a JSON document keyed by id; filtering happens in JS.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./safety.ts";
import type { AgentEvent, CarrierEvent, Order, Product, PromiseRecord } from "./types.ts";

const DB_PATH = process.env.DB_PATH ?? "data/kept.db";
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

let seq = Number((db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM docs").get() as { s: number }).s);

type Collections = {
  products: Product;
  promises: PromiseRecord;
  orders: Order;
  carrier_events: CarrierEvent;
  agent_events: AgentEvent;
};
type Name = keyof Collections;

function collection<N extends Name>(name: N) {
  type T = Collections[N];
  return {
    get(id: string): T | null {
      const row = db.prepare("SELECT json FROM docs WHERE collection=? AND id=?").get(name, id) as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as T) : null;
    },
    /** All docs, oldest first. */
    all(): T[] {
      const rows = db.prepare("SELECT json FROM docs WHERE collection=? ORDER BY seq").all(name) as { json: string }[];
      return rows.map((r) => JSON.parse(r.json) as T);
    },
    put(doc: T & { id: string }): T {
      const existing = db.prepare("SELECT seq FROM docs WHERE collection=? AND id=?").get(name, doc.id) as { seq: number } | undefined;
      db.prepare("INSERT OR REPLACE INTO docs (collection,id,json,seq) VALUES (?,?,?,?)").run(name, doc.id, JSON.stringify(doc), existing?.seq ?? ++seq);
      return doc;
    },
    update(id: string, patch: Partial<T>): T {
      const cur = this.get(id);
      if (!cur) throw new Error(`${name}/${id} not found`);
      return this.put({ ...cur, ...patch } as T & { id: string });
    },
    delete(id: string) {
      db.prepare("DELETE FROM docs WHERE collection=? AND id=?").run(name, id);
    },
  };
}

export const products = collection("products");
export const promises = collection("promises");
export const orders = collection("orders");
export const carrierEvents = collection("carrier_events");
export const agentEvents = collection("agent_events");

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

// ---------- Simulated clock ----------
// The demo needs to "fast-forward to Friday". All business logic reads time through now(),
// which is real time plus an offset the demo panel can move forward. Weather data stays real.

function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function setSetting(key: string, value: string) {
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(key, value);
}

export function clockOffsetMs(): number {
  return Number(getSetting("clock_offset_ms") ?? 0);
}
export function advanceClock(ms: number) {
  setSetting("clock_offset_ms", String(clockOffsetMs() + ms));
}
export function resetClock() {
  setSetting("clock_offset_ms", "0");
}
export function now(): Date {
  return new Date(Date.now() + clockOffsetMs());
}

export function logEvent(kind: AgentEvent["kind"], message: string, order_id: string | null = null, data: unknown = null): AgentEvent {
  return agentEvents.put({ id: newId("evt"), order_id, kind, message: redact(message), data, at: now().toISOString() });
}

// ---------- Retention ----------
// The demo is public, so nothing may grow without bound. Keep only the newest N docs per collection.
export const RETENTION = { orders: 200, agent_events: 1000, carrier_events: 2000, promises: 100 } as const;

/** Delete all but the newest `keep` docs of a collection (never touching ids in `protect`). */
function trim(name: Name, keep: number, protect: Set<string> = new Set()) {
  const rows = db.prepare("SELECT id FROM docs WHERE collection=? ORDER BY seq DESC").all(name) as { id: string }[];
  const del = db.prepare("DELETE FROM docs WHERE collection=? AND id=?");
  for (const r of rows.slice(keep)) if (!protect.has(r.id)) del.run(name, r.id);
}

export function pruneData() {
  trim("orders", RETENTION.orders);
  trim("agent_events", RETENTION.agent_events);
  trim("carrier_events", RETENTION.carrier_events);
  // Never drop a promise a product points at, or one live orders still reference.
  const used = new Set<string>([...products.all().map((p) => p.promise_id ?? ""), ...promises.all().filter((p) => p.status === "active").map((p) => p.id)]);
  trim("promises", RETENTION.promises, used);
}

export function resetAll() {
  db.exec("DELETE FROM docs; DELETE FROM settings;");
}
