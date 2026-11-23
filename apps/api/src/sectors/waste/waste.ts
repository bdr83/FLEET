import { BadRequestException } from '@nestjs/common';

/**
 * Waste collection and cleaning pack (waste, sector 23). A route is a fixed collection round for a compactor truck: a
 * waste type, a start time, the days it runs, a default truck and driver, and ordered collection points (a customer's
 * bins by type and count). Each running day a run is generated per route: a core task booking the truck and driver for
 * the round. The driver marks each point collected (bins emptied) or missed (with a reason), and records each tip at the
 * landfill or sorting site with the weighbridge ticket and net weight. The run cannot end with a point unmarked, nor
 * without a ticket when anything was collected.
 */
export const WASTE = 'waste@1';
export const isWaste = (pack: string | null | undefined) => pack === WASTE;

export const WASTE_TYPES = ['general', 'recyclable', 'construction', 'green', 'organic'] as const;
export const BIN_TYPES = ['bin_120', 'bin_240', 'bin_660', 'bin_1100', 'skip_6', 'skip_12', 'compactor', 'bag'] as const;
export const VISIT_EVENTS = ['collected', 'missed'] as const;
export type VisitEvent = (typeof VISIT_EVENTS)[number];
export const MISS_REASONS = ['no_access', 'bins_not_out', 'blocked', 'contaminated', 'other'] as const;
export type MissReason = (typeof MISS_REASONS)[number];
/** Reasons a driver can give for a run that did not happen. [تخمين] */
export const FAIL_REASONS = ['vehicle_breakdown', 'accident', 'road_closed', 'facility_closed', 'other'] as const;

/** A run not under way this many minutes after its start is late. [تخمين] */
export const LATE_START_MIN = 30;
/** A point missed on this many runs in a row is flagged to the customer. [تخمين] */
export const MISS_STREAK = 2;

export interface Bin { type: string; count: number }

/** The bins at a collection point: 1-10 types, each 1-50 bins. */
export function parseBins(val: unknown): Bin[] {
  if (!Array.isArray(val) || val.length === 0 || val.length > 10) throw new BadRequestException('bins must be 1-10 entries of {type, count}');
  const seen = new Set<string>();
  return val.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const type = String(o.type ?? '');
    if (!(BIN_TYPES as readonly string[]).includes(type)) throw new BadRequestException(`bins[${i}].type must be one of ${BIN_TYPES.join(', ')}`);
    if (seen.has(type)) throw new BadRequestException(`bins[${i}].type repeated`);
    seen.add(type);
    const count = Number(o.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new BadRequestException(`bins[${i}].count must be 1-50`);
    return { type, count };
  });
}

export const binCount = (bins: Bin[]) => bins.reduce((n, b) => n + b.count, 0);

/** Net weight on a weighbridge ticket, kg with one decimal, up to 40 t. */
export function parseNetKg(val: unknown, field: string, required = false): number | null {
  if (val === undefined || val === null || val === '') {
    if (required) throw new BadRequestException(`${field} required (kg)`);
    return null;
  }
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n) || n <= 0 || n > 40000) throw new BadRequestException(`${field} must be kg 0-40000`);
  return Math.round(n * 10) / 10;
}

/** Whether a visit may be recorded. Returns a reject code or null. */
export function visitRule(event: VisitEvent, bins: number | null, reason: string | null, planned: number): string | null {
  if (event === 'missed') return reason ? null : 'miss_reason_required';
  if (bins === null) return 'bins_required';
  if (bins > planned * 2) return 'bins_invalid'; // a few extra bags are fine, not a different site's bins
  return null;
}

export interface Mark { point_id: string; event: VisitEvent }
/** Why a run cannot end yet: a point unmarked, or something collected without a weighbridge ticket. */
export function finishBlock(points: string[], marks: Mark[], dumps: number): string | null {
  const by = new Map(marks.map((m) => [m.point_id, m.event]));
  if (points.some((p) => !by.has(p))) return 'points_open';
  if (dumps === 0 && [...by.values()].includes('collected')) return 'dump_required';
  return null;
}
