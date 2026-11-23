import { BadRequestException } from '@nestjs/common';

/**
 * Pest control pack (pest, sector 26). The company keeps a register of its pesticides: active ingredient, registration
 * number, unit and the hours nobody may re-enter after treatment. A job (PC-n) treats a customer's premises for target
 * pests with a service type at a time, by a technician who must hold a valid pesticide licence that day. The technician
 * records the arrival, then the treatment: the products used with quantities and places, the infestation level and the
 * customer's name; the re-entry time is the treatment time plus the longest re-entry interval among the products used.
 * A callback within the warranty is a free follow-up job; a job with a repeat interval creates the next one when done.
 */
export const PEST = 'pest@1';
export const isPest = (pack: string | null | undefined) => pack === PEST;

export const PREMISES = ['home', 'restaurant', 'office', 'warehouse', 'hospital', 'school', 'other'] as const;
export const PESTS = ['cockroaches', 'ants', 'rodents', 'termites', 'bedbugs', 'mosquitoes', 'flies', 'birds', 'scorpions_snakes', 'other'] as const;
export const SERVICES = ['spray', 'gel', 'bait', 'fumigation', 'inspection'] as const;
export const UNITS = ['ml', 'l', 'g', 'kg', 'unit'] as const;
export const INFESTATION = ['none', 'low', 'medium', 'high'] as const;

export const STAGES = ['pc_arrived', 'pc_treated'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { pc_arrived: ['in_progress'], pc_treated: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { pc_treated: 'pc_arrived' };
export const FAIL_REASONS = ['customer_absent', 'no_access', 'customer_canceled', 'premises_not_ready', 'other'] as const;

/** The technician's document needed on the day of the visit. */
export const LICENSE_DOC = 'pesticide_license';
/** Warranty days when the office does not set them. [تخمين] */
export const WARRANTY_DAYS = 30;
/** Jobs due within this many hours without a technician are flagged. [تخمين] */
export const UNASSIGNED_HOURS = 24;

export interface Application { product_id: string; qty: number; location: string | null }

/** The products used on a treatment: 1-20 lines of a product, a quantity (2 decimals) and an optional place. */
export function parseApplications(val: unknown, field = 'applications'): Application[] {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val) || val.length > 20) throw new BadRequestException(`${field} must be up to 20 lines`);
  return val.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const id = String(o.product_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException(`${field}[${i}].product_id invalid`);
    const qty = Number(o.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) throw new BadRequestException(`${field}[${i}].qty must be 0-100000`);
    const loc = o.location === undefined || o.location === null || o.location === '' ? null : String(o.location).trim().slice(0, 120);
    return { product_id: id, qty: Math.round(qty * 100) / 100, location: loc };
  });
}

/** Whether the treatment may be recorded. Returns a reject code or null. */
export function treatRule(service: string, apps: number, infestation: string | null, receivedBy: string | null): string | null {
  if (!infestation) return 'infestation_required';
  if (!receivedBy) return 'receiver_required';
  if (service !== 'inspection' && apps === 0) return 'products_required';
  return null;
}

/** When the premises may be entered again: the longest interval among the products used. */
export const reentryAt = (at: Date, hours: number[]) => new Date(at.getTime() + Math.max(0, ...hours) * 3_600_000);

/** Whether a callback falls within the warranty of the job treated at a time. */
export const inWarranty = (treatedAt: Date | null, days: number, at: Date) => !!treatedAt && at.getTime() - treatedAt.getTime() <= days * 86_400_000;

export type JobState = 'open' | 'assigned' | 'en_route' | 'on_site' | 'treated' | 'done' | 'failed' | 'canceled';

/** Where a job stands, from its stage times and its task. */
export function jobState(j: { canceled_at: unknown; arrived_at: unknown; treated_at: unknown }, taskStatus: string | null): JobState {
  if (j.canceled_at) return 'canceled';
  if (taskStatus === 'failed') return 'failed';
  if (taskStatus && ['completed', 'reviewed', 'invoiced'].includes(taskStatus)) return 'done';
  if (j.treated_at) return 'treated';
  if (j.arrived_at) return 'on_site';
  if (taskStatus === 'in_progress') return 'en_route';
  if (taskStatus && taskStatus !== 'canceled') return 'assigned';
  return 'open';
}
