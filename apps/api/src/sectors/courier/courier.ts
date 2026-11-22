import { randomInt } from 'crypto';

/**
 * Courier and express pack (courier, sector 4). Each parcel is one delivery@1 task (so dispatch, the driver's PIN or photo
 * proof, COD and tracking stay the delivery pack's) plus an air waybill number, pieces, weight, a service level with its due
 * time, and hub scans. A failed attempt comes back to a hub and goes out again until the attempts run out, then it is
 * returned to the shipper (RTO).
 */
export const SERVICES = ['express', 'same_day', 'next_day'] as const;
export type Service = (typeof SERVICES)[number];
export const SCAN_EVENTS = ['received', 'sorted', 'dispatched', 'arrived', 'returned', 'rto_out'] as const;
export type ScanEvent = (typeof SCAN_EVENTS)[number];
/** Delivery attempts before the parcel goes back to the shipper. [تخمين] */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Express: hours from booking. [تخمين] */
export const EXPRESS_HOURS = 4;
/** A parcel sitting at a hub without a scan for this long is an exception. [تخمين] */
export const STUCK_HOURS = 24;

const KW_OFFSET_MS = 3 * 3_600_000; // Kuwait has no daylight saving

/**
 * When the parcel is due: express in 4 hours, same day by 23:59 Kuwait time, next day by 23:59 the day after. [تخمين]
 */
export function dueAt(service: Service, now = new Date()): Date {
  if (service === 'express') return new Date(now.getTime() + EXPRESS_HOURS * 3_600_000);
  const kw = new Date(now.getTime() + KW_OFFSET_MS);
  const endOfDay = Date.UTC(kw.getUTCFullYear(), kw.getUTCMonth(), kw.getUTCDate(), 23, 59, 0) - KW_OFFSET_MS;
  return new Date(endOfDay + (service === 'next_day' ? 86_400_000 : 0));
}

export const AWB_RE = /^[A-Z0-9][A-Z0-9-]{3,29}$/;
/** A new waybill number when the shipper has none: KW + 10 digits. */
export const newAwb = () => `KW${String(randomInt(0, 1e9)).padStart(9, '0')}${randomInt(0, 10)}`;

export interface ParcelState { status: string; attempts: number; max_attempts: number; rto_at: Date | string | null; rto_done_at: Date | string | null }
export type ScanOutcome =
  | { error: 'closed' | 'with_driver' | 'awaiting_return' | 'not_failed' | 'not_rto' }
  | { hub: 'set' | 'clear' | 'keep'; reopen?: boolean; rto?: boolean; rtoDone?: boolean };

const DONE = ['completed', 'reviewed', 'invoiced', 'canceled'];
const OUT = ['accepted', 'in_progress'];

/**
 * What one scan does to a parcel. A delivered, canceled or returned-to-shipper parcel takes no more scans; a parcel the
 * driver has taken out cannot be scanned at a hub until it fails and comes back ("returned"). A returned parcel goes out
 * again while attempts remain (or `forceRto` says the shipper wants it back), otherwise it is marked for RTO.
 */
export function scanOutcome(event: ScanEvent, p: ParcelState, forceRto = false): ScanOutcome {
  if (DONE.includes(p.status) || p.rto_done_at) return { error: 'closed' };
  switch (event) {
    case 'returned':
      if (p.status !== 'failed') return { error: 'not_failed' };
      if (p.rto_at || forceRto || p.attempts >= p.max_attempts) return { hub: 'set', rto: !p.rto_at };
      return { hub: 'set', reopen: true };
    case 'rto_out':
      if (!p.rto_at) return { error: 'not_rto' };
      return { hub: 'clear', rtoDone: true };
    default:
      if (OUT.includes(p.status)) return { error: 'with_driver' };
      if (p.status === 'failed' && !p.rto_at) return { error: 'awaiting_return' }; // a failed attempt is scanned "returned" first
      return { hub: event === 'dispatched' ? 'clear' : event === 'sorted' ? 'keep' : 'set' };
  }
}

/** Where the parcel is, for the office: delivered, back with the shipper, with the driver, at a hub, or between hubs. */
export function whereIs(p: { status: string; current_hub_id: string | null; rto_at: unknown; rto_done_at: unknown }): 'delivered' | 'rto_done' | 'canceled' | 'with_driver' | 'at_hub' | 'in_transit' {
  if (['completed', 'reviewed', 'invoiced'].includes(p.status)) return 'delivered';
  if (p.rto_done_at) return 'rto_done';
  if (p.status === 'canceled') return 'canceled';
  if (OUT.includes(p.status) || (p.status === 'failed' && !p.rto_at)) return 'with_driver'; // failed: until scanned back at a hub
  return p.current_hub_id ? 'at_hub' : 'in_transit';
}
