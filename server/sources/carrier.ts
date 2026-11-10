// Simulated carrier ("KeptPost"). OWNER: watcher agent. Stores events in db.carrierEvents.
// Every event is timestamped with the simulated clock (now()), so the demo can fast-forward.
import { randomInt } from "node:crypto";
import { carrierEvents, newId, now } from "../db.ts";
import type { CarrierEvent } from "../types.ts";

export const CARRIER_NAME = "OTHER"; // PayPal carrier code for non-listed carriers
export const CARRIER_DISPLAY_NAME = "KeptPost";
const ORIGIN = "Portland, ME";

function newTrackingNumber(): string {
  let digits = "";
  for (let i = 0; i < 10; i++) digits += String(randomInt(10));
  return `KP${digits}`;
}

/** Create a shipment for an order: generate tracking number, write label_created event. */
export function createShipment(orderId: string): string {
  void orderId; // carrier events are keyed by tracking number; the order holds the link
  let tracking = newTrackingNumber();
  while (carrierEvents.all().some((e) => e.tracking_number === tracking)) tracking = newTrackingNumber();
  pushCarrierEvent(tracking, "label_created", "Label created", ORIGIN);
  return tracking;
}

// status "exception" covers attempted / returned / held-at-depot scans. It never counts as delivered.
export function pushCarrierEvent(trackingNumber: string, status: CarrierEvent["status"], description: string, location: string): CarrierEvent {
  return carrierEvents.put({ id: newId("cev"), tracking_number: trackingNumber, status, description, location, at: now().toISOString() });
}

/** All scans for a tracking number, oldest first. */
export function getCarrierEvents(trackingNumber: string): CarrierEvent[] {
  return carrierEvents
    .all()
    .filter((e) => e.tracking_number === trackingNumber)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); // Array.prototype.sort is stable: insertion order breaks ties
}
