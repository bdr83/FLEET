import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { normalizePhone } from '../../common/phone';
import { v } from '../../common/validate';

/**
 * Ready-mix concrete pack (concrete@1, sector 20). A pour order (طلب صب) is split into truck loads; each load is an
 * ordinary core task, so assignment, tracking, the driver app and invoicing stay in the core. This pack adds:
 * load planning for a continuous pour, the digital delivery ticket (batch time, poured and returned m³, site engineer's
 * signature), the concrete age clock, site waiting time and the mixers board.
 */
export const CONCRETE = 'concrete@1';
export const isConcrete = (pack: string | null | undefined) => pack === CONCRETE;

/** Stages a mixer driver records. loaded = batching done at the plant: starts the concrete age clock. */
export const STAGES = ['loaded', 'at_site', 'pour_start', 'pour_end'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = {
  loaded: ['accepted', 'in_progress'],
  at_site: ['in_progress'],
  pour_start: ['in_progress'],
  pour_end: ['in_progress'],
};
/** A stage needs the one before it, so the times on the ticket are in order. */
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { at_site: 'loaded', pour_start: 'at_site', pour_end: 'pour_start' };

/** Failure reasons for a load. [تخمين] to refine with the partner plant. */
export const FAIL_REASONS = ['site_not_ready', 'age_exceeded', 'rejected_by_site', 'truck_breakdown', 'pump_breakdown', 'customer_canceled', 'other'] as const;

export interface ConcreteSettings {
  truck_capacity_m3: number; max_age_minutes: number; age_warn_minutes: number; free_wait_minutes: number; lead_minutes: number; cycle_minutes: number;
}
export const DEFAULT_SETTINGS: ConcreteSettings = { truck_capacity_m3: 9, max_age_minutes: 90, age_warn_minutes: 70, free_wait_minutes: 30, lead_minutes: 30, cycle_minutes: 120 };
export const SETTINGS_COLS = 'truck_capacity_m3::float, max_age_minutes, age_warn_minutes, free_wait_minutes, lead_minutes, cycle_minutes';

export async function settingsOf(c: PoolClient, legalEntityId: string): Promise<ConcreteSettings> {
  return (await c.query(`SELECT ${SETTINGS_COLS} FROM ops.concrete_settings WHERE legal_entity_id = $1`, [legalEntityId])).rows[0] ?? DEFAULT_SETTINGS;
}

export interface PlannedLoad { seq: number; volume_m3: number; arrive_at: Date; load_at: Date; return_at: Date }
export interface Plan { loads: PlannedLoad[]; spacing_minutes: number; trucks_needed: number; pour_minutes: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Splits a pour into truck loads and times them for a continuous pour: full trucks, then the remainder.
 * Load i arrives when load i-1 is expected to be poured (its volume / pour rate). Trucks needed = how many are on the
 * road at once: cycle time / spacing, capped by the number of loads. Cycle and lead times are estimates and are shown so.
 */
export function planLoads(o: { volume_m3: number; pour_rate_m3h: number; scheduled_at: Date; capacity_m3: number; lead_minutes: number; cycle_minutes: number; startSeq?: number; already_m3?: number }): Plan {
  const loads: PlannedLoad[] = [];
  let left = r2(o.volume_m3);
  let t = o.scheduled_at.getTime() + ((o.already_m3 ?? 0) / o.pour_rate_m3h) * 3_600_000;
  let seq = o.startSeq ?? 1;
  while (left > 0.004) {
    const vol = r2(Math.min(o.capacity_m3, left));
    const arrive = new Date(t);
    loads.push({ seq, volume_m3: vol, arrive_at: arrive, load_at: new Date(t - o.lead_minutes * 60_000), return_at: new Date(t - o.lead_minutes * 60_000 + o.cycle_minutes * 60_000) });
    t += (vol / o.pour_rate_m3h) * 3_600_000;
    left = r2(left - vol);
    seq++;
  }
  const spacing = (o.capacity_m3 / o.pour_rate_m3h) * 60;
  return {
    loads,
    spacing_minutes: Math.round(spacing),
    trucks_needed: Math.max(1, Math.min(loads.length, Math.ceil(o.cycle_minutes / spacing))),
    pour_minutes: Math.round((o.volume_m3 / o.pour_rate_m3h) * 60),
  };
}

/** Minutes the truck waited on site before the pour started, and the part that is charged after the free time. */
export function waiting(atSite: Date | null, pourStart: Date | null, freeMinutes: number) {
  if (!atSite || !pourStart) return { wait_minutes: 0, billable_hours: 0 };
  const wait = Math.max(0, Math.round((pourStart.getTime() - atSite.getTime()) / 60_000));
  // charged by the quarter hour, rounded up [تخمين] confirm with the partner plant
  const billable = Math.ceil(Math.max(0, wait - freeMinutes) / 15) / 4;
  return { wait_minutes: wait, billable_hours: billable };
}

/** Concrete age in minutes from batching; null before batching. */
export const ageMinutes = (batchedAt: Date | string | null, at: Date = new Date()) =>
  batchedAt ? Math.max(0, Math.round((at.getTime() - new Date(batchedAt).getTime()) / 60_000)) : null;

export interface Site { name?: string; area?: string; block?: string; street?: string; plot?: string; notes?: string; lat?: number; lng?: number; contact_name?: string; contact_phone?: string }

/** Validates the site part of a pour order. A site needs a pinned location before loads are dispatched (Phase B, journey 4). */
export function normalizeSite(val: unknown): Site {
  if (val === undefined || val === null) return {};
  if (typeof val !== 'object' || Array.isArray(val)) throw new BadRequestException('site must be an object');
  const o = val as Record<string, unknown>;
  const out: Site = {};
  for (const k of ['name', 'area', 'street', 'contact_name'] as const) { const s = v.str(o[k], `site.${k}`, { max: 120 }); if (s) out[k] = s; }
  for (const k of ['block', 'plot'] as const) { const s = v.str(o[k], `site.${k}`, { max: 20 }); if (s) out[k] = s; }
  const notes = v.str(o.notes, 'site.notes', { max: 300 }); if (notes) out.notes = notes;
  if (o.contact_phone !== undefined && o.contact_phone !== null && o.contact_phone !== '') {
    const p = normalizePhone(o.contact_phone);
    if (!p) throw new BadRequestException('site.contact_phone invalid');
    out.contact_phone = p;
  }
  if (o.lat !== undefined || o.lng !== undefined) {
    const lat = o.lat, lng = o.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestException('site.lat/lng invalid');
    out.lat = lat; out.lng = lng;
  }
  return out;
}

export function siteLine(s: Site): string | undefined {
  const parts = [s.name, s.area, s.block && `ق ${s.block}`, s.street && `ش ${s.street}`, s.plot && `قسيمة ${s.plot}`].filter(Boolean);
  return parts.length ? parts.join('، ') : undefined;
}

/** A positive m³ amount with up to 2 decimals. */
export function m3(val: unknown, field: string, { max = 5000, required = false, zero = false } = {}): number | null {
  if (val === undefined || val === null || val === '') {
    if (required) throw new BadRequestException(`${field} required`);
    return null;
  }
  const n = typeof val === 'string' ? Number(val) : val;
  if (typeof n !== 'number' || !Number.isFinite(n) || (zero ? n < 0 : n <= 0) || n > max || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new BadRequestException(`${field} must be ${zero ? '0' : 'more than 0'} to ${max} m³ with up to 2 decimals`);
  }
  return n;
}
