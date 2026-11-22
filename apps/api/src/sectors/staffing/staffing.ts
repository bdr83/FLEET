import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { normalizePhone } from '../../common/phone';
import { v } from '../../common/validate';

/**
 * Driver supply pack (staffing@1, sector 14, module M11). A customer's supply request is staffed by placing drivers on it
 * for a period; each working day of a placement is an ordinary core task assigned to the driver, so the driver app,
 * dispatch, review and invoicing stay in the core: check-in = start, check-out = complete, the customer's approval = review.
 */
export const STAFFING = 'staffing@1';
export const isStaffing = (pack: string | null | undefined) => pack === STAFFING;

export const STAGES = ['check_in', 'check_out'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { check_in: ['accepted'], check_out: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { check_out: 'check_in' };
/** Why a driver leaves a shift early. [تخمين] to refine with the pilot company. */
export const FAIL_REASONS = ['sick', 'vehicle_breakdown', 'sent_home_by_customer', 'other'] as const;

/** How early before the shift starts the driver may check in. [تخمين] */
export const EARLY_CHECKIN_MINUTES = 120;

/** Days generated ahead for a placement at a time; longer placements are extended by POST /staffing/generate. */
export const GENERATE_DAYS = 93;

export interface StaffingSettings { checkin_radius_m: number; late_grace_minutes: number; hour_rounding_minutes: number; doc_types: string[] }
export const DEFAULT_SETTINGS: StaffingSettings = { checkin_radius_m: 300, late_grace_minutes: 15, hour_rounding_minutes: 15, doc_types: ['driving_license', 'residency'] };
export const SETTINGS_COLS = 'checkin_radius_m, late_grace_minutes, hour_rounding_minutes, doc_types';

export async function settingsOf(c: PoolClient, legalEntityId: string): Promise<StaffingSettings> {
  return (await c.query(`SELECT ${SETTINGS_COLS} FROM ops.staffing_settings WHERE legal_entity_id = $1`, [legalEntityId])).rows[0] ?? DEFAULT_SETTINGS;
}

/** Worked time in hours, rounded to the nearest step (15 min by default) [تخمين]. */
export function roundHours(minutes: number, step: number): number {
  if (!(minutes > 0)) return 0;
  return Math.round((Math.round(minutes / step) * step / 60) * 100) / 100;
}

export interface Doc { doc_type: string; expires_on: string | null }
export interface Eligibility { status: 'ok' | 'warn' | 'blocked'; issues: { doc_type: string; problem: 'missing' | 'expired' | 'expires_during'; expires_on?: string | null }[] }
/**
 * Can this driver be placed for [from, to]? Each required document must exist and be valid on the first day (else blocked);
 * one that expires before the last day is a warning to renew (Phase B, journey 3). Dates are YYYY-MM-DD.
 */
export function eligibility(docs: Doc[], required: string[], from: string, to: string): Eligibility {
  const issues: Eligibility['issues'] = [];
  for (const type of required) {
    const mine = docs.filter((d) => d.doc_type === type);
    if (!mine.length) { issues.push({ doc_type: type, problem: 'missing' }); continue; }
    // the document that lasts longest (no expiry = never expires)
    const best = mine.reduce((a, b) => (a.expires_on === null ? a : b.expires_on === null ? b : a.expires_on >= b.expires_on ? a : b));
    if (best.expires_on !== null && best.expires_on < from) issues.push({ doc_type: type, problem: 'expired', expires_on: best.expires_on });
    else if (best.expires_on !== null && best.expires_on < to) issues.push({ doc_type: type, problem: 'expires_during', expires_on: best.expires_on });
  }
  return { status: issues.some((i) => i.problem !== 'expires_during') ? 'blocked' : issues.length ? 'warn' : 'ok', issues };
}

/** "08:00" → "08:00" (HH:MM, 24h). */
export function hhmm(val: unknown, field: string): string {
  if (typeof val !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) throw new BadRequestException(`${field} must be HH:MM`);
  return val;
}

/** Shift length in minutes; an end before the start runs past midnight. */
export function shiftMinutes(start: string, end: string): number {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const d = m(end) - m(start);
  return d > 0 ? d : d + 1440;
}

/** Working dates between two days (inclusive) on the given weekdays (0 = Sunday). */
export function workDates(from: string, to: string, days: number[]): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export interface Site { name?: string; area?: string; block?: string; street?: string; notes?: string; lat?: number; lng?: number; contact_name?: string; contact_phone?: string }
export function normalizeSite(val: unknown): Site {
  if (val === undefined || val === null) return {};
  if (typeof val !== 'object' || Array.isArray(val)) throw new BadRequestException('site must be an object');
  const o = val as Record<string, unknown>;
  const out: Site = {};
  for (const k of ['name', 'area', 'street', 'contact_name'] as const) { const s = v.str(o[k], `site.${k}`, { max: 120 }); if (s) out[k] = s; }
  const block = v.str(o.block, 'site.block', { max: 20 }); if (block) out.block = block;
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
  const parts = [s.name, s.area, s.block && `ق ${s.block}`, s.street && `ش ${s.street}`].filter(Boolean);
  return parts.length ? parts.join('، ') : undefined;
}

/** What the customer may see of a driver: first name only, and whether the licence is valid (Phase A data-sharing scope). */
export const firstName = (name: string | null | undefined) => (name ? name.trim().split(/\s+/)[0] : null);
