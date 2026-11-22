import { BadRequestException } from '@nestjs/common';

/**
 * Own-fleet distribution pack (distribution@1, sector 29, module M17). A company delivers its own goods to its branches or
 * customers: one route a day per vehicle and driver, a load list, several stops with delivered and returned quantities and
 * cash collected, then the driver's cash settled at the office. The route is a task that books the vehicle and the driver
 * for the day; each stop is a task assigned to the driver (not exclusive), so the core keeps assignment and tracking.
 */
export const DISTRIBUTION = 'distribution@1';
export const isDistribution = (pack: string | null | undefined) => pack === DISTRIBUTION;

/** Milestones on the route task: the driver checked the load (before leaving) and came back after the last stop. */
export const STAGES = ['load_checked', 'route_back'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { load_checked: ['accepted'], route_back: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { route_back: 'load_checked' };
/** Why a stop could not be served, or the route stopped. */
export const FAIL_REASONS = ['shop_closed', 'refused', 'no_cash', 'no_space', 'vehicle_breakdown', 'other'] as const;
export const UNITS = ['piece', 'carton', 'crate', 'kg', 'liter', 'bag'] as const;
export const SKU = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export interface Item { sku: string; name: string; qty: number; price: string }
export type Qty = Record<string, number>;

/** Quantities in thousandths so sums stay exact (3 decimals: kg, litres). */
const milli = (n: number) => Math.round(n * 1000);
export const addQty = (a: number, b: number) => (milli(a) + milli(b)) / 1000;

/** A quantity: a positive number with up to 3 decimals, at most 100 000. */
export function qty(v: unknown, field: string, { zero = false } = {}): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (!zero && n === 0) || n > 100_000 || Math.abs(milli(n) - n * 1000) > 1e-6) {
    throw new BadRequestException(`${field} must be a quantity with up to 3 decimals`);
  }
  return n;
}

/** An amount in KWD with up to 3 decimals, as a string. */
export function amount(v: unknown, field: string): string {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,9}(\.\d{1,3})?$/.test(s)) throw new BadRequestException(`${field} must be an amount with up to 3 decimals`);
  return s;
}
export const fils = (s: string | number | null | undefined) => (s === null || s === undefined ? 0 : Math.round(Number(s) * 1000));
export const kwd = (f: number) => (f / 1000).toFixed(3);

/** A {sku: qty} map, each sku once. */
export function qtyMap(v: unknown, field: string): Qty {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException(`${field} must be an object of sku: quantity`);
  const out: Qty = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!SKU.test(k)) throw new BadRequestException(`${field}: invalid sku ${k}`);
    const n = qty(x, `${field}.${k}`, { zero: true });
    if (n > 0) out[k] = n;
  }
  if (Object.keys(out).length > 100) throw new BadRequestException(`${field}: too many items`);
  return out;
}

/** The load list: planned quantities of all stops per sku, in sku order. */
export function loadList(stops: { items: Item[] }[]): { sku: string; name: string; qty: number }[] {
  const m = new Map<string, { sku: string; name: string; qty: number }>();
  for (const s of stops) for (const i of s.items) {
    const cur = m.get(i.sku) ?? { sku: i.sku, name: i.name, qty: 0 };
    cur.qty = addQty(cur.qty, i.qty);
    m.set(i.sku, cur);
  }
  return [...m.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Value of quantities at the stop's prices, in fils. Unknown skus (returns of other goods) are valued at 0. */
export function valueFils(q: Qty, items: Item[]): number {
  const price = new Map(items.map((i) => [i.sku, fils(i.price)]));
  return Object.entries(q).reduce((s, [sku, n]) => s + Math.round(milli(n) * (price.get(sku) ?? 0) / 1000), 0);
}

/** Delivered quantities must be planned for the stop and not more than planned; returns may be any goods. */
export function checkDelivered(items: Item[], delivered: Qty): string | null {
  const planned = new Map(items.map((i) => [i.sku, i.qty]));
  for (const [sku, n] of Object.entries(delivered)) {
    if (!planned.has(sku)) return 'item_not_planned';
    if (milli(n) > milli(planned.get(sku)!)) return 'quantity_exceeds_plan';
  }
  return null;
}

/** Per sku: loaded, delivered, returned by customers, and what should come back to the warehouse. */
export function reconcile(stops: { items: Item[]; delivered: Qty | null; returned: Qty | null }[]) {
  const rows = new Map<string, { sku: string; name: string; loaded: number; delivered: number; returned: number; back: number }>();
  const row = (sku: string, name = sku) => rows.get(sku) ?? rows.set(sku, { sku, name, loaded: 0, delivered: 0, returned: 0, back: 0 }).get(sku)!;
  for (const s of stops) {
    for (const i of s.items) { const r = row(i.sku, i.name); r.loaded = addQty(r.loaded, i.qty); }
    for (const [k, n] of Object.entries(s.delivered ?? {})) { const r = row(k); r.delivered = addQty(r.delivered, n); }
    for (const [k, n] of Object.entries(s.returned ?? {})) { const r = row(k); r.returned = addQty(r.returned, n); }
  }
  for (const r of rows.values()) r.back = (milli(r.loaded) - milli(r.delivered) + milli(r.returned)) / 1000;
  return [...rows.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}
