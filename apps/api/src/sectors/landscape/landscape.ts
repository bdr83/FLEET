import { BadRequestException } from '@nestjs/common';

/**
 * Landscaping and garden maintenance pack (landscape, sector 27). A garden (contract site) belongs to a customer and has
 * the services agreed (mowing, pruning, irrigation...), the days and time of the visit, a crew lead, the crew size, an
 * optional vehicle and whether it has an irrigation network. On each visit day a visit is generated: a core task booking
 * the crew lead (and vehicle). The lead records the arrival, then the work done: the services carried out (a planned one
 * left undone needs a note), the state of the irrigation network and the bags of green waste taken. An irrigation fault
 * stays open until the office closes it. The office can add an extra visit (planting, a clean-up after an event).
 */
export const LANDSCAPE = 'landscape@1';
export const isLandscape = (pack: string | null | undefined) => pack === LANDSCAPE;

export const SERVICES = ['mowing', 'pruning', 'irrigation', 'fertilizing', 'planting', 'weeding', 'palm_care', 'pest_spray', 'cleanup', 'other'] as const;
export const IRRIGATION = ['ok', 'leak', 'broken', 'dry_area', 'not_checked'] as const;
/** Irrigation states that open a fault for the office. */
export const FAULTS = ['leak', 'broken', 'dry_area'];

export const STAGES = ['ls_arrived', 'ls_done'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { ls_arrived: ['in_progress'], ls_done: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { ls_done: 'ls_arrived' };
/** Reasons a crew lead can give for a visit that did not happen. [تخمين] */
export const FAIL_REASONS = ['no_access', 'customer_canceled', 'weather', 'vehicle_breakdown', 'other'] as const;

/** A visit not under way this many minutes after its time is late. [تخمين] */
export const LATE_START_MIN = 30;
/** A garden whose irrigation is not checked on this many visits in a row is flagged. [تخمين] */
export const UNCHECKED_STREAK = 3;

/** The services of a site or a visit: 1-10 known codes, without repeats. */
export function parseServices(x: unknown, field = 'services', min = 1): string[] {
  if (x === undefined || x === null) {
    if (min === 0) return [];
    throw new BadRequestException(`${field} required`);
  }
  if (!Array.isArray(x) || x.length < min || x.length > 10) throw new BadRequestException(`${field} must be ${min}-10 of ${SERVICES.join(', ')}`);
  const out = [...new Set(x.map((s) => String(s)))];
  for (const s of out) if (!(SERVICES as readonly string[]).includes(s)) throw new BadRequestException(`${field}: ${s} is not one of ${SERVICES.join(', ')}`);
  return SERVICES.filter((s) => out.includes(s));
}

/**
 * Whether the work done may be recorded. Returns a reject code or null: at least one service, a planned service left
 * undone needs a note, a garden with an irrigation network needs its state, and the green waste bags are counted.
 */
export function doneRule(x: { planned: string[]; done: string[]; irrigation: string | null; hasIrrigation: boolean; bags: number | null; note: string | null }): string | null {
  if (x.done.length === 0) return 'services_required';
  if (x.planned.some((s) => !x.done.includes(s)) && !x.note?.trim()) return 'undone_note_required';
  if (x.hasIrrigation && !x.irrigation) return 'irrigation_required';
  if (x.bags === null) return 'waste_bags_required';
  return null;
}

/** The share of planned services carried out, in percent (null when nothing was planned). */
export function completion(planned: number, done: number): number | null {
  return planned ? Math.round((Math.min(done, planned) / planned) * 100) : null;
}

export type VisitState = 'assigned' | 'en_route' | 'on_site' | 'done' | 'failed' | 'canceled';

/** Where a visit stands, from its stage times and its task. */
export function visitState(v: { arrived_at: unknown; done_at: unknown }, taskStatus: string): VisitState {
  if (taskStatus === 'canceled') return 'canceled';
  if (taskStatus === 'failed') return 'failed';
  if (['completed', 'reviewed', 'invoiced'].includes(taskStatus)) return 'done';
  if (v.arrived_at) return 'on_site';
  if (taskStatus === 'in_progress') return 'en_route';
  return 'assigned';
}
