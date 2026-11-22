import { BadRequestException } from '@nestjs/common';

/**
 * Staff transport pack (shuttle, sector 11). A route carries a customer's employees (or the company's own) between
 * housing and work: a direction, a departure time, the days it runs, ordered stops, a default bus and driver and its
 * riders. Each running day a trip is generated per route: a core task booking the bus and driver for the trip window,
 * so neither is double-booked across sectors. The driver marks each rider boarded or absent; the last mark counts.
 */
export const SHUTTLE = 'shuttle@1';
export const isShuttle = (pack: string | null | undefined) => pack === SHUTTLE;

export const DIRECTIONS = ['to_work', 'from_work'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const BOARD_EVENTS = ['boarded', 'no_show'] as const;
export type BoardEvent = (typeof BOARD_EVENTS)[number];
/** Reasons a driver can give for a trip that did not run. [تخمين] to refine with the first customer. */
export const FAIL_REASONS = ['vehicle_breakdown', 'accident', 'road_closed', 'trip_canceled', 'other'] as const;

/** Kuwait's working week, Sunday to Thursday, as ISO days (1 Monday … 7 Sunday). */
export const WORK_WEEK = [7, 1, 2, 3, 4];
/** A trip not under way this many minutes after its departure time is late. [تخمين] */
export const LATE_START_MIN = 10;
/** A rider absent on this many trips in a row is flagged to the customer. [تخمين] */
export const NO_SHOW_STREAK = 3;

export interface Stop { name: string; area?: string; lat?: number; lng?: number; offset_min: number }

/** Ordered stops with minutes after departure, rising, within the trip's duration. */
export function parseStops(val: unknown, durationMin: number): Stop[] {
  if (!Array.isArray(val) || val.length === 0 || val.length > 40) throw new BadRequestException('stops must be a list of 1-40');
  let last = -1;
  return val.map((x, i) => {
    if (!x || typeof x !== 'object') throw new BadRequestException(`stops[${i}] invalid`);
    const o = x as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name || name.length > 120) throw new BadRequestException(`stops[${i}].name required (up to 120)`);
    const off = o.offset_min === undefined || o.offset_min === null || o.offset_min === '' ? (i === 0 ? 0 : NaN) : Number(o.offset_min);
    if (!Number.isInteger(off) || off < 0 || off > durationMin) throw new BadRequestException(`stops[${i}].offset_min must be whole minutes within the trip (0-${durationMin})`);
    if (off < last) throw new BadRequestException(`stops[${i}].offset_min must not be before the previous stop`);
    last = off;
    const area = typeof o.area === 'string' && o.area.trim() ? o.area.trim().slice(0, 80) : undefined;
    const lat = o.lat === undefined || o.lat === null ? undefined : Number(o.lat);
    const lng = o.lng === undefined || o.lng === null ? undefined : Number(o.lng);
    if ((lat !== undefined) !== (lng !== undefined) || (lat !== undefined && (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng!) || Math.abs(lng!) > 180))) {
      throw new BadRequestException(`stops[${i}] lat/lng invalid`);
    }
    return { name, offset_min: off, ...(area ? { area } : {}), ...(lat !== undefined ? { lat, lng } : {}) };
  });
}

/** Days the route runs, as ISO weekdays; defaults to Sunday-Thursday. */
export function parseDays(val: unknown): number[] {
  if (val === undefined || val === null) return WORK_WEEK;
  if (!Array.isArray(val) || val.length === 0 || val.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new BadRequestException('days must be ISO weekdays 1-7');
  return [...new Set(val as number[])].sort((a, b) => a - b);
}

/** ISO weekday (1 Monday … 7 Sunday) of a calendar date "YYYY-MM-DD". */
export function isoDow(day: string): number {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** "HH:MM" plus minutes, wrapping past midnight. */
export function addMinutes(hm: string, min: number): string {
  const [h, m] = hm.split(':').map(Number);
  const t = (((h * 60 + m + min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export interface Mark { rider_id: string; event: BoardEvent; occurred_at: Date | string }
/** The standing mark for each rider on a trip: the latest one. */
export function latestMarks(marks: Mark[]): Map<string, Mark> {
  const out = new Map<string, Mark>();
  for (const m of marks) {
    const prev = out.get(m.rider_id);
    if (!prev || new Date(m.occurred_at).getTime() >= new Date(prev.occurred_at).getTime()) out.set(m.rider_id, m);
  }
  return out;
}

/** Did the trip leave on time? Under way within the grace after the departure time. */
export function onTime(departAt: Date, startedAt: Date | null, graceMin = LATE_START_MIN): boolean | null {
  if (!startedAt) return null;
  return startedAt.getTime() <= departAt.getTime() + graceMin * 60_000;
}
