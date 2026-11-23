import { BadRequestException } from '@nestjs/common';

/**
 * Oil and gas services (oilgas pack, sector 18). Contractors move crews, equipment and materials to oilfield sites. A site
 * names the documents its drivers and vehicles must hold (H2S, defensive driving, the site pass, the vehicle inspection
 * sticker). Each trip is a journey plan (JM-n) approved by the journey manager before departure, booking the vehicle and
 * driver; nobody is assigned with a document missing or expiring before the journey ends. The driver inspects the vehicle
 * before leaving, calls in at the site's interval, and records the arrival; a missed call-in or a late arrival is an alarm.
 */
export const OILGAS = 'oilgas@1';
export const isOilgas = (pack: string | null | undefined) => pack === OILGAS;

export const PURPOSES = ['crew', 'equipment', 'materials', 'water', 'waste', 'other'] as const;
export const STAGES = ['og_inspected', 'og_departed', 'og_checkin', 'og_arrived'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = {
  og_inspected: ['accepted', 'in_progress'], og_departed: ['in_progress'], og_checkin: ['in_progress'], og_arrived: ['in_progress'],
};
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { og_departed: 'og_inspected', og_checkin: 'og_departed', og_arrived: 'og_departed' };
/** Stages a driver records more than once (a call-in at every interval). */
export const REPEATABLE: readonly string[] = ['og_checkin'];
export const FAIL_REASONS = ['vehicle_breakdown', 'inspection_failed', 'site_closed', 'gate_refused', 'weather', 'accident', 'other'] as const;

/** The pre-trip checklist. The H2S monitor is checked only for a site in an H2S zone. [تخمين] to align with the operator's form. */
export const CHECKS = ['tyres', 'brakes', 'lights', 'seat_belts', 'fire_extinguisher', 'first_aid', 'spill_kit', 'h2s_monitor'] as const;
/** A journey not arrived this many minutes after its ETA is overdue. [تخمين] */
export const ARRIVAL_GRACE_MIN = 30;
/** A call-in is late this many minutes after the site's interval. [تخمين] */
export const CHECKIN_GRACE_MIN = 10;
/** Driver document every hazardous-cargo journey needs, on top of the site's. [تخمين] */
export const HAZMAT_DOC = 'hazmat';

export interface Doc { doc_type: string; expires_on: string | null }

/** Required document types missing, or expiring before the given day (YYYY-MM-DD). */
export function missingDocs(docs: Doc[], required: string[], until: string): string[] {
  return required.filter((t) => !docs.some((d) => d.doc_type === t && (d.expires_on === null || d.expires_on >= until)));
}

/** The checklist items that apply, and the failed ones from the driver's answers (an unanswered item fails). */
export function inspect(checks: Record<string, unknown>, h2sZone: boolean): { items: string[]; failed: string[] } {
  const items = CHECKS.filter((c) => c !== 'h2s_monitor' || h2sZone);
  return { items, failed: items.filter((c) => checks[c] !== true) };
}

/** Parses the doc type list of a site: lower-case codes as in core.document. */
export function parseDocTypes(val: unknown, field: string): string[] | null {
  if (val === undefined || val === null) return null;
  if (!Array.isArray(val) || val.length > 12 || !val.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(x))) throw new BadRequestException(`${field} must be up to 12 document codes (a-z, 0-9, _)`);
  return [...new Set(val as string[])];
}

export type JourneyState = 'draft' | 'approved' | 'assigned' | 'ready' | 'en_route' | 'arrived' | 'done' | 'failed' | 'canceled';

/** Where a journey stands: draft (not approved), approved (no vehicle), assigned (both, not yet out), en_route, arrived, done. */
export function journeyState(j: { canceled_at: unknown; approved_at: unknown; departed_at: unknown; arrived_at: unknown }, taskStatus: string | null): JourneyState {
  if (j.canceled_at) return 'canceled';
  if (taskStatus === 'failed') return 'failed';
  if (taskStatus && ['completed', 'reviewed', 'invoiced'].includes(taskStatus)) return 'done';
  if (j.arrived_at) return 'arrived';
  if (j.departed_at) return 'en_route';
  if (!taskStatus || taskStatus === 'canceled') return j.approved_at ? 'approved' : 'draft';
  return j.approved_at ? 'ready' : 'assigned';
}

/** When the next call-in is due for a journey en route: the later of departure and the last call-in, plus the interval. */
export function nextCheckinDue(departedAt: Date, lastCheckin: Date | null, intervalMin: number): Date {
  const from = lastCheckin && lastCheckin > departedAt ? lastCheckin : departedAt;
  return new Date(from.getTime() + intervalMin * 60_000);
}
