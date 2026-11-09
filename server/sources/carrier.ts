// Simulated carrier ("KeptPost"). OWNER: watcher agent. Stores events in db.carrierEvents.
import type { CarrierEvent } from "../types.ts";

export const CARRIER_NAME = "OTHER"; // PayPal carrier code for non-listed carriers

/** Create a shipment for an order: generate tracking number, write label_created event. */
export function createShipment(orderId: string): string {
  throw new Error("not implemented");
}
export function pushCarrierEvent(trackingNumber: string, status: CarrierEvent["status"], description: string, location: string): CarrierEvent {
  throw new Error("not implemented");
}
export function getCarrierEvents(trackingNumber: string): CarrierEvent[] {
  throw new Error("not implemented");
}
