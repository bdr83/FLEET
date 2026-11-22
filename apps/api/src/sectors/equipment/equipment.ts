import { BadRequestException } from '@nestjs/common';

/**
 * Heavy equipment hire (equipment pack, sector 16). Cranes, excavators, loaders and the like are hired to a customer at
 * its site, with our operator (wet hire) or without (dry hire), by the hour, day or month with a daily minimum. Each
 * working day is a core task booking the machine and operator for the shift. The operator records the hour meter at the
 * start and the end, downtime from breakdowns, and the site supervisor who confirmed the hours; the office approves the
 * day and the billable hours follow. Prices come from the customer's contract.
 */
export const EQUIPMENT = 'equipment@1';
export const isEquipment = (pack: string | null | undefined) => pack === EQUIPMENT;

export const STAGES = ['work_start', 'work_end'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { work_start: ['accepted'], work_end: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { work_end: 'work_start' };
/** Reasons a working day did not happen. [تخمين] to refine with the first customer. */
export const FAIL_REASONS = ['equipment_breakdown', 'site_not_ready', 'weather', 'customer_canceled', 'other'] as const;
export const RATE_UNITS = ['hour', 'day', 'month'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];
export const HEAVY_TYPES = ['excavator', 'loader', 'crane', 'forklift', 'bulldozer', 'roller', 'grader'] as const;
/** A day not started this long after the shift start shows as late. [تخمين] */
export const LATE_START_MIN = 30;

/** An hour-meter reading: hours with one decimal. */
export function meter(val: unknown, field: string, { required = false } = {}): number | null {
  if (val === undefined || val === null || val === '') {
    if (required) throw new BadRequestException(`${field} required`);
    return null;
  }
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n) || n < 0 || n > 9_999_999 || Math.abs(Math.round(n * 10) - n * 10) > 1e-6) throw new BadRequestException(`${field} must be hours with up to one decimal`);
  return Math.round(n * 10) / 10;
}

export function hoursBetween(start: string, end: string): number {
  const [a, b] = [start, end].map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  return Math.round(((b - a) / 60) * 10) / 10;
}

/**
 * Billable hours of a day: the hours worked on the meter, but never under the daily minimum, except that downtime from
 * our breakdown comes off the minimum (the customer does not pay for our broken machine). [تخمين] confirm per contract.
 */
export function billableHours(worked: number, downtime: number, minHours: number): number {
  const floor = Math.max(0, minHours - downtime);
  return Math.round(Math.max(worked, floor) * 10) / 10;
}

/** For day and month rates: a day counts unless the machine was down for the whole shift. */
export function billableDay(downtime: number, shiftHours: number): number {
  return downtime >= shiftHours ? 0 : 1;
}
