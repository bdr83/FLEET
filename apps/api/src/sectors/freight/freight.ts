import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { normalizePhone } from '../../common/phone';
import { v } from '../../common/validate';

/**
 * Freight / road haulage pack (freight@1, sector 2). A transport order (أمر نقل) is one core task: it is planned on our
 * truck, trailer and driver, or handed to a subcontract carrier at an agreed cost. The driver records arrival at the
 * pickup, loading (weight and seal), arrival at the drop-off and unloading with the receiver's name. The trip is then
 * settled: revenue from the contract minus carrier cost and trip expenses.
 */
export const FREIGHT = 'freight@1';
export const isFreight = (pack: string | null | undefined) => pack === FREIGHT;

export const STAGES = ['at_pickup', 'loaded', 'at_dropoff', 'unloaded'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = {
  at_pickup: ['accepted', 'in_progress'],
  loaded: ['accepted', 'in_progress'],
  at_dropoff: ['in_progress'],
  unloaded: ['in_progress'],
};
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { loaded: 'at_pickup', at_dropoff: 'loaded', unloaded: 'at_dropoff' };

/** Failure reasons for a shipment. [تخمين] to refine with the first haulage customer. */
export const FAIL_REASONS = ['truck_breakdown', 'refused_by_consignee', 'weight_mismatch', 'cargo_damaged', 'address_not_found', 'cargo_not_ready', 'customer_canceled', 'other'] as const;

export const BILL_UNITS = ['trip', 'km', 'ton'] as const;
export type BillUnit = (typeof BILL_UNITS)[number];

export interface FreightSettings { free_detention_minutes: number; weight_tolerance_pct: number }
export const DEFAULT_SETTINGS: FreightSettings = { free_detention_minutes: 120, weight_tolerance_pct: 2 };
export const SETTINGS_COLS = 'free_detention_minutes, weight_tolerance_pct::float';

export async function settingsOf(c: PoolClient, legalEntityId: string): Promise<FreightSettings> {
  return (await c.query(`SELECT ${SETTINGS_COLS} FROM ops.freight_settings WHERE legal_entity_id = $1`, [legalEntityId])).rows[0] ?? DEFAULT_SETTINGS;
}

/** Waiting at one end beyond the free time, charged by the quarter hour rounded up. [تخمين] confirm with the customer */
export function detention(arrived: Date | null, done: Date | null, freeMinutes: number) {
  if (!arrived || !done) return { minutes: 0, billable_hours: 0 };
  const minutes = Math.max(0, Math.round((done.getTime() - arrived.getTime()) / 60_000));
  return { minutes, billable_hours: Math.ceil(Math.max(0, minutes - freeMinutes) / 15) / 4 };
}

/**
 * What the invoice prices for a delivered shipment: one trip, the planned km, or tons (delivered weight, else loaded,
 * else the declared cargo weight), plus detention hours at pickup and drop-off after the free time at each end.
 */
export function quantities(s: { bill_unit: BillUnit; planned_km: number | null; cargo_weight_kg: number | null; loaded_weight_kg: number | null; delivered_weight_kg: number | null }, detentionHours = 0) {
  const q: Record<string, number> = {};
  if (s.bill_unit === 'trip') q.trip = 1;
  if (s.bill_unit === 'km') q.km = s.planned_km ?? 0;
  if (s.bill_unit === 'ton') q.ton = Math.round(((s.delivered_weight_kg ?? s.loaded_weight_kg ?? s.cargo_weight_kg ?? 0) / 1000) * 1000) / 1000;
  if (detentionHours > 0) q.hour = detentionHours;
  return q;
}

/** True when the delivered weight differs from the loaded weight by more than the tolerance. */
export function weightMismatch(loaded: number | null, delivered: number | null, tolerancePct: number): boolean {
  if (loaded === null || delivered === null || loaded <= 0) return false;
  return (Math.abs(loaded - delivered) / loaded) * 100 > tolerancePct + 1e-9;
}

export interface Place { name?: string; area?: string; address?: string; notes?: string; lat?: number; lng?: number; contact_name?: string; contact_phone?: string }

export function normalizePlace(val: unknown, field: string, { required = false } = {}): Place {
  if (val === undefined || val === null) {
    if (required) throw new BadRequestException(`${field} required`);
    return {};
  }
  if (typeof val !== 'object' || Array.isArray(val)) throw new BadRequestException(`${field} must be an object`);
  const o = val as Record<string, unknown>;
  const out: Place = {};
  for (const k of ['name', 'area', 'contact_name'] as const) { const s = v.str(o[k], `${field}.${k}`, { max: 120 }); if (s) out[k] = s; }
  for (const k of ['address', 'notes'] as const) { const s = v.str(o[k], `${field}.${k}`, { max: 300 }); if (s) out[k] = s; }
  if (o.contact_phone !== undefined && o.contact_phone !== null && o.contact_phone !== '') {
    const p = normalizePhone(o.contact_phone);
    if (!p) throw new BadRequestException(`${field}.contact_phone invalid`);
    out.contact_phone = p;
  }
  if (o.lat !== undefined || o.lng !== undefined) {
    const lat = o.lat, lng = o.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestException(`${field}.lat/lng invalid`);
    out.lat = lat; out.lng = lng;
  }
  if (required && !out.name && !out.address && !out.area) throw new BadRequestException(`${field} needs a name, area or address`);
  return out;
}

export const placeLine = (p: Place) => [p.name, p.area, p.address].filter(Boolean).join('، ') || undefined;

export interface Cargo { description: string; packages?: number; weight_kg?: number; volume_m3?: number }

export function normalizeCargo(val: unknown): Cargo {
  if (!val || typeof val !== 'object' || Array.isArray(val)) throw new BadRequestException('cargo must be an object');
  const o = val as Record<string, unknown>;
  const out: Cargo = { description: v.str(o.description, 'cargo.description', { required: true, max: 200 })! };
  const packages = v.int(o.packages, 'cargo.packages', 1, 100_000); if (packages !== null) out.packages = packages;
  const w = kg(o.weight_kg, 'cargo.weight_kg'); if (w !== null) out.weight_kg = w;
  const m3 = num(o.volume_m3, 'cargo.volume_m3', 0.01, 500); if (m3 !== null) out.volume_m3 = m3;
  return out;
}

/** A weight in kg, 0-100 t, one decimal. */
export function kg(val: unknown, field: string, { required = false, zero = false } = {}): number | null {
  const n = num(val, field, zero ? 0 : 0.1, 100_000, required);
  if (n !== null && Math.abs(n * 10 - Math.round(n * 10)) > 1e-6) throw new BadRequestException(`${field}: up to 1 decimal`);
  return n;
}

export function num(val: unknown, field: string, min: number, max: number, required = false): number | null {
  if (val === undefined || val === null || val === '') {
    if (required) throw new BadRequestException(`${field} required`);
    return null;
  }
  const n = typeof val === 'string' ? Number(val) : val;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new BadRequestException(`${field} must be ${min}-${max}`);
  return n;
}

/** A money amount with up to 3 decimals (KWD fils). */
export function money(val: unknown, field: string, { required = false, max = 1_000_000 } = {}): number | null {
  const n = num(val, field, 0, max, required);
  if (n !== null && Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) throw new BadRequestException(`${field}: up to 3 decimals`);
  return n;
}

/** Detention at both ends from the driver's stage times, for completion. */
export function tripDetention(ms: { at_pickup: Date | null; loaded: Date | null; at_dropoff: Date | null; unloaded: Date | null }, freeMinutes: number) {
  const p = detention(ms.at_pickup, ms.loaded, freeMinutes), d = detention(ms.at_dropoff, ms.unloaded, freeMinutes);
  return { minutes: Math.max(0, p.minutes - freeMinutes) + Math.max(0, d.minutes - freeMinutes), hours: p.billable_hours + d.billable_hours };
}
