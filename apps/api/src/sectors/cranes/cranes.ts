import { BadRequestException } from '@nestjs/common';

/**
 * Cranes (cranes pack, sector 19), on top of equipment hire. Each crane has its load chart (the rated capacity at each
 * radius) and a wind limit. Every lift is a lift plan (LP-n) on a working day of a hire: the load, the radius, the rated
 * capacity from the chart and the utilization. Over 100% is refused; a critical lift (75% or more, a tandem lift, or over
 * people) needs the appointed person's approval. A lift is not planned with a crane whose inspection certificate, or an
 * operator or rigger whose card, is not valid that day. The operator records the lift done with the wind speed (above the
 * crane's limit refused) or aborted with a reason; a working day does not end with a lift still open.
 */
export const CRANES = 'cranes';
export const LIFT_EVENTS = ['done', 'aborted'] as const;
export type LiftEvent = (typeof LIFT_EVENTS)[number];

/** Utilization from which a lift is critical. [تخمين] to align with the customer's lifting procedure. */
export const CRITICAL_PCT = 75;
/** Documents: the crane's third-party inspection, the operator's and the rigger's cards. [تخمين] */
export const CRANE_DOC = 'tpi_certificate';
export const OPERATOR_DOC = 'crane_operator';
export const RIGGER_DOC = 'rigger_cert';
/** A crane certificate expiring within this many days is flagged. [تخمين] */
export const CERT_WARN_DAYS = 30;

export interface ChartRow { radius_m: number; capacity_t: number }

/** Parses a load chart: 1-60 rows of radius and capacity, radius increasing and capacity not increasing. */
export function parseChart(val: unknown): ChartRow[] {
  if (!Array.isArray(val) || val.length < 1 || val.length > 60) throw new BadRequestException('chart must be 1-60 rows of {radius_m, capacity_t}');
  const rows = val.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const r = Number(o.radius_m), c = Number(o.capacity_t);
    if (!Number.isFinite(r) || r <= 0 || r > 200 || !Number.isFinite(c) || c <= 0 || c > 3000) throw new BadRequestException(`chart[${i}] needs radius_m (0-200) and capacity_t (0-3000)`);
    return { radius_m: Math.round(r * 10) / 10, capacity_t: Math.round(c * 100) / 100 };
  });
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].radius_m <= rows[i - 1].radius_m) throw new BadRequestException('chart radii must increase');
    if (rows[i].capacity_t > rows[i - 1].capacity_t) throw new BadRequestException('chart capacity must not increase with the radius');
  }
  return rows;
}

/** The rated capacity at a radius: the chart row at that radius or the next larger one (never interpolated up); null beyond the chart. */
export function ratedAt(chart: ChartRow[], radius: number): number | null {
  const row = chart.find((r) => r.radius_m >= radius);
  return row ? row.capacity_t : null;
}

export const utilization = (load: number, rated: number) => Math.round((load / rated) * 1000) / 10;

export const isCritical = (pct: number, tandem: boolean, overPeople: boolean) => pct >= CRITICAL_PCT || tandem || overPeople;

/** Wind speed typed by the operator: m/s with one decimal, 0-60. */
export function parseWind(val: unknown, field: string): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n) || n < 0 || n > 60) throw new BadRequestException(`${field} must be m/s 0-60`);
  return Math.round(n * 10) / 10;
}

/** Whether a lift may be recorded done or aborted now. Returns a reject code or null. */
export function liftRule(l: { status: string; critical: boolean; approved_at: unknown }, event: LiftEvent, wind: number | null, note: string | null, limit: number): string | null {
  if (l.status !== 'planned') return 'lift_closed';
  if (event === 'aborted') return note ? null : 'abort_reason_required';
  if (l.critical && !l.approved_at) return 'lift_not_approved';
  if (wind === null) return 'wind_required';
  if (wind > limit) return 'wind_too_high';
  return null;
}
