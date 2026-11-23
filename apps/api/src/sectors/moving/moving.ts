import { BadRequestException } from '@nestjs/common';

/**
 * Furniture moving (moving pack, sector 5). A request to move a home or an office from one address to another: a survey
 * sets the volume and the item list, the office quotes, the customer accepts and pays a deposit (recorded only). On the
 * day the truck and its driver (the crew lead) are booked on the main task and each helper on a crew task for the same
 * window. The driver records the end of loading, then unloading with the receiver's name. Then damage claims and a rating.
 */
export const MOVING = 'moving@1';
export const isMoving = (pack: string | null | undefined) => pack === MOVING;

export const STAGES = ['loaded', 'unloaded'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { loaded: ['in_progress'], unloaded: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { unloaded: 'loaded' };
export const FAIL_REASONS = ['customer_absent', 'no_access', 'customer_canceled', 'truck_breakdown', 'other'] as const;

export const HOME_SIZES = ['room', 'studio', 'apt_1', 'apt_2', 'apt_3', 'apt_4', 'villa', 'office'] as const;
export type HomeSize = (typeof HOME_SIZES)[number];
export const SERVICES = ['packing', 'assembly', 'crating', 'storage', 'cleaning'] as const;
export const CLAIM_STATUS = ['open', 'settled', 'rejected'] as const;

/** Hours to book and helpers to send by home size when the office does not say. [تخمين] to set per company. */
export const PLAN_BY_SIZE: Record<HomeSize, { hours: number; crew: number }> = {
  room: { hours: 2, crew: 1 }, studio: { hours: 3, crew: 2 }, apt_1: { hours: 4, crew: 2 }, apt_2: { hours: 5, crew: 3 },
  apt_3: { hours: 6, crew: 4 }, apt_4: { hours: 8, crew: 4 }, villa: { hours: 10, crew: 6 }, office: { hours: 8, crew: 4 },
};
/** A request without a quote this long after it was opened is flagged. [تخمين] */
export const QUOTE_DUE_HOURS = 48;
/** An accepted move without a crew this close to its date is flagged. [تخمين] */
export const BOOK_DUE_DAYS = 2;
/** Damage claims are accepted for this many days after the move. [تخمين] to set per company terms. */
export const CLAIM_DAYS = 7;

export type Item = { room: string | null; name: string; qty: number; fragile: boolean };

/** The survey's item list: up to 300 lines of a room, a name, a count and whether it is fragile. Throws with the reason. */
export function parseItems(val: unknown, field = 'items'): Item[] {
  if (!Array.isArray(val) || val.length > 300) throw new BadRequestException(`${field} must be a list of up to 300 items`);
  return val.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const room = typeof o.room === 'string' && o.room.trim() ? o.room.trim() : null;
    const qty = o.qty === undefined || o.qty === null || o.qty === '' ? 1 : Number(o.qty);
    if (!name || name.length > 120) throw new BadRequestException(`${field}[${i}].name required, up to 120`);
    if (room && room.length > 60) throw new BadRequestException(`${field}[${i}].room up to 60`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new BadRequestException(`${field}[${i}].qty must be 1-999`);
    return { room, name, qty, fragile: o.fragile === true };
  });
}

/**
 * Where a move stands: new (to survey or quote) → quoted (the customer to answer) → accepted (to book a crew) → booked →
 * moving (the lead task started) → delivered (unloaded) → closed; or canceled.
 */
export function moveState(j: { canceled_at: unknown; closed_at: unknown; quoted_at: unknown; accepted_at: unknown; unloaded_at: unknown }, lead: { status: string } | null): string {
  if (j.canceled_at) return 'canceled';
  if (j.closed_at) return 'closed';
  if (j.unloaded_at || lead?.status === 'completed') return 'delivered';
  if (lead && lead.status === 'in_progress') return 'moving';
  if (lead && !['canceled', 'failed'].includes(lead.status)) return 'booked';
  if (j.accepted_at) return 'accepted';
  if (j.quoted_at) return 'quoted';
  return 'new';
}
