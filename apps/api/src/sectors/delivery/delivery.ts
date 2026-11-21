import { BadRequestException } from '@nestjs/common';
import { randomBytes, randomInt } from 'crypto';
import type { PoolClient } from 'pg';
import { normalizePhone } from '../../common/phone';
import { v } from '../../common/validate';

/**
 * Delivery sector pack (delivery@1). The core keeps the task life cycle; this pack adds:
 * a structured Kuwaiti address, recipient, COD and fees in task attributes; stages inside "in progress";
 * proof of delivery by the recipient's PIN (or a photo the office approves); a public tracking link;
 * failure reasons; auto-assignment and driver commissions.
 */
export const DELIVERY = 'delivery@1';
export const isDelivery = (pack: string | null | undefined) => pack === DELIVERY;

/** Stages the driver records while the task is accepted / in progress. returned_to_sender follows a failure. */
export const STAGES = ['at_pickup', 'picked_up', 'at_dropoff', 'returned_to_sender'] as const;
export type Stage = (typeof STAGES)[number];
/** Which task statuses each stage may be recorded in. */
export const STAGE_ALLOWED: Record<Stage, string[]> = {
  at_pickup: ['accepted', 'in_progress'],
  picked_up: ['accepted', 'in_progress'],
  at_dropoff: ['in_progress'],
  returned_to_sender: ['failed'],
};

/** Failure reasons, grouped in reports. [تخمين] to refine with the pilot company. */
export const FAIL_REASONS = ['recipient_absent', 'wrong_address', 'recipient_refused', 'unreachable', 'damaged', 'cod_not_paid', 'customer_canceled', 'other'] as const;

export const PIN_MAX_ATTEMPTS = 5;
export const LINK_DAYS = 14;

interface Address { area?: string; block?: string; street?: string; avenue?: string; house?: string; floor?: string; apartment?: string; notes?: string; lat?: number; lng?: number; name?: string; phone?: string }

function address(val: unknown, field: string): Address | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'object' || Array.isArray(val)) throw new BadRequestException(`${field} must be an object`);
  const o = val as Record<string, unknown>;
  const out: Address = {};
  for (const k of ['area', 'block', 'street', 'avenue', 'house', 'floor', 'apartment', 'name'] as const) {
    const s = v.str(o[k], `${field}.${k}`, { max: k === 'area' || k === 'street' || k === 'name' ? 80 : 20 });
    if (s) out[k] = s;
  }
  const notes = v.str(o.notes, `${field}.notes`, { max: 300 });
  if (notes) out.notes = notes;
  if (o.phone !== undefined && o.phone !== null && o.phone !== '') {
    const p = normalizePhone(o.phone);
    if (!p) throw new BadRequestException(`${field}.phone invalid`);
    out.phone = p;
  }
  if (o.lat !== undefined || o.lng !== undefined) {
    const lat = o.lat, lng = o.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestException(`${field}.lat/lng invalid`);
    out.lat = lat; out.lng = lng;
  }
  return out;
}

/** One readable line: "السالمية، ق 5، ش 10، م 12". */
export function addressLine(a: Address | undefined): string | undefined {
  if (!a) return undefined;
  const parts = [a.area, a.block && `ق ${a.block}`, a.street && `ش ${a.street}`, a.avenue && `ج ${a.avenue}`, a.house && `م ${a.house}`].filter(Boolean);
  return parts.length ? parts.join('، ') : undefined;
}

/**
 * Validates and normalises a delivery task's attributes. Known keys are checked; other keys are kept
 * (sector extensions, integrations) within the 4 KB attribute limit. Nothing here is mandatory so that
 * older clients keep working; the dashboard and the import require recipient phone and area.
 */
export function normalizeAttributes(attrs: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!attrs) return attrs;
  const out: Record<string, unknown> = { ...attrs };
  const pickup = address(attrs.pickup, 'attributes.pickup');
  const dropoff = address(attrs.dropoff, 'attributes.dropoff');
  if (pickup) out.pickup = pickup;
  if (dropoff) {
    out.dropoff = dropoff;
    if (!attrs.address) out.address = addressLine(dropoff);
  }
  if (attrs.recipient !== undefined && attrs.recipient !== null) {
    if (typeof attrs.recipient !== 'object' || Array.isArray(attrs.recipient)) throw new BadRequestException('attributes.recipient must be an object');
    const r = attrs.recipient as Record<string, unknown>;
    const name = v.str(r.name, 'attributes.recipient.name', { max: 120 });
    const phone = r.phone === undefined || r.phone === null || r.phone === '' ? null : normalizePhone(r.phone);
    if (r.phone && !phone) throw new BadRequestException('attributes.recipient.phone invalid');
    out.recipient = { ...(name ? { name } : {}), ...(phone ? { phone } : {}) };
  }
  for (const k of ['cod_amount', 'delivery_fee', 'tip'] as const) {
    if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== '') out[k] = v.money(attrs[k], `attributes.${k}`);
    else delete out[k];
  }
  const ext = v.str(attrs.external_order_id, 'attributes.external_order_id', { max: 60 });
  if (ext) out.external_order_id = ext;
  const items = v.int(attrs.items_count, 'attributes.items_count', 1, 1000);
  if (items !== null) out.items_count = items;
  return out;
}

/** The point a driver heads to first: pickup, else the customer site, else the drop-off. */
export function firstPoint(attrs: Record<string, unknown>): { lat: number; lng: number } | null {
  for (const k of ['pickup', 'dropoff']) {
    const p = attrs?.[k] as Address | undefined;
    if (p && typeof p.lat === 'number' && typeof p.lng === 'number') return { lat: p.lat, lng: p.lng };
  }
  return null;
}

export async function createLink(c: PoolClient, tenantId: string, taskId: string) {
  const token = randomBytes(24).toString('base64url');
  const pin = String(randomInt(0, 10_000)).padStart(4, '0');
  await c.query(
    `INSERT INTO ops.delivery_link (tenant_id, task_id, token, pin, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))
     ON CONFLICT DO NOTHING`, [tenantId, taskId, token, pin, LINK_DAYS]);
}

export interface DeliverySettings {
  require_pin: boolean; max_open_per_driver: number; auto_assign_radius_km: number; position_fresh_minutes: number;
  default_sla_minutes: number; commission_per_delivery: string; commission_per_failed: string; custody_alert_amount: string;
}
export const DEFAULT_SETTINGS: DeliverySettings = {
  require_pin: true, max_open_per_driver: 5, auto_assign_radius_km: 15, position_fresh_minutes: 10,
  default_sla_minutes: 90, commission_per_delivery: '0.000', commission_per_failed: '0.000', custody_alert_amount: '100.000',
};
export const SETTINGS_COLS = `require_pin, max_open_per_driver, auto_assign_radius_km::float, position_fresh_minutes, default_sla_minutes,
  commission_per_delivery::text, commission_per_failed::text, custody_alert_amount::text`;

export async function settingsOf(c: PoolClient, legalEntityId: string): Promise<DeliverySettings> {
  const r = (await c.query(`SELECT ${SETTINGS_COLS} FROM ops.delivery_settings WHERE legal_entity_id = $1`, [legalEntityId])).rows[0];
  return r ?? DEFAULT_SETTINGS;
}

/** Great-circle distance in km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface Candidate { worker_id: string; asset_id: string | null; lat: number; lng: number; open_tasks: number }
/**
 * Greedy nearest-driver choice for one task: within the radius, under the open-task cap,
 * nearest first, then the lighter load. Returns null when nobody qualifies.
 */
export function pickDriver(point: { lat: number; lng: number } | null, drivers: Candidate[], s: Pick<DeliverySettings, 'max_open_per_driver' | 'auto_assign_radius_km'>) {
  const ok = drivers.filter((d) => d.open_tasks < s.max_open_per_driver);
  if (!ok.length) return null;
  if (!point) return [...ok].sort((a, b) => a.open_tasks - b.open_tasks)[0];
  const ranked = ok.map((d) => ({ d, km: haversineKm(point, d) })).filter((x) => x.km <= s.auto_assign_radius_km)
    .sort((a, b) => a.km - b.km || a.d.open_tasks - b.d.open_tasks);
  return ranked[0]?.d ?? null;
}

/**
 * A delivery needs a proof (recipient PIN, or a photo/signature the office approves) when the company requires it
 * and the recipient can receive the PIN, i.e. the order has a recipient phone. [تخمين] confirm with the pilot company.
 */
export async function needsProof(c: PoolClient, t: { legal_entity_id: string; attributes: Record<string, unknown> | null }) {
  const s = await settingsOf(c, t.legal_entity_id);
  if (!s.require_pin) return false;
  const at = t.attributes ?? {};
  const phone = (at.recipient as { phone?: string } | undefined)?.phone ?? (at.dropoff as { phone?: string } | undefined)?.phone;
  return !!phone;
}
