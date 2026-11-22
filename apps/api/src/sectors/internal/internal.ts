import type { PoolClient } from 'pg';

/**
 * In-house corporate fleet pack (internal@1, sector 21, module M17). An employee asks for a vehicle (with or without a
 * driver), the department manager approves, the fleet office allocates a vehicle; the allocated request is an ordinary
 * core task booked on the vehicle for the period, so a vehicle is never double-booked across sectors. Handover and return
 * record the odometer and fuel; trips and expenses are charged back to departments.
 */
export const INTERNAL = 'internal@1';
export const isInternal = (pack: string | null | undefined) => pack === INTERNAL;

export const STAGES = ['vehicle_out', 'vehicle_back'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { vehicle_out: ['accepted'], vehicle_back: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { vehicle_back: 'vehicle_out' };
export const FAIL_REASONS = ['vehicle_breakdown', 'accident', 'trip_canceled', 'other'] as const;

export const ASSET_TYPES = ['car', 'van', 'pickup', 'truck', 'bus', 'motorbike', 'other'] as const;
export const OPEN = ['pending', 'approved', 'allocated', 'in_use'] as const;

export interface InternalSettings {
  require_approval: boolean; auto_approve_max_hours: number | null; cost_per_km: string; driver_cost_per_hour: string;
  return_grace_minutes: number; work_start: string; work_end: string;
}
export const DEFAULT_SETTINGS: InternalSettings = {
  require_approval: true, auto_approve_max_hours: null, cost_per_km: '0.100', driver_cost_per_hour: '0.000', return_grace_minutes: 30, work_start: '07:00', work_end: '17:00',
};
export const SETTINGS_COLS = `require_approval, auto_approve_max_hours, cost_per_km::text, driver_cost_per_hour::text, return_grace_minutes,
  to_char(work_start, 'HH24:MI') AS work_start, to_char(work_end, 'HH24:MI') AS work_end`;

export async function settingsOf(c: PoolClient, le: string): Promise<InternalSettings> {
  return (await c.query(`SELECT ${SETTINGS_COLS} FROM ops.internal_settings WHERE legal_entity_id = $1`, [le])).rows[0] ?? DEFAULT_SETTINGS;
}

/** Does the request need a manager's decision? Off by policy, short trips under the auto-approve limit, and a manager's own request do not. */
export function needsApproval(s: Pick<InternalSettings, 'require_approval' | 'auto_approve_max_hours'>, hours: number, requesterIsManager: boolean): boolean {
  if (!s.require_approval || requesterIsManager) return false;
  return !(s.auto_approve_max_hours !== null && hours <= s.auto_approve_max_hours);
}

/** "HH:MM" of a time in a time zone. */
export function localHhmm(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

/** True when any part of [from, to) falls outside working hours on a local day, or the trip spans more than one day. */
export function outsideHours(from: Date, to: Date, tz: string, start: string, end: string): boolean {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  if (day(from) !== day(new Date(to.getTime() - 1))) return true;
  return localHhmm(from, tz) < start || localHhmm(new Date(to.getTime() - 1), tz) >= end;
}

/** Cost charged to the department: distance × rate, plus driver hours × rate (3 decimals, KWD). */
export function tripCost(km: number, driverHours: number, perKm: string, perHour: string): string {
  const fils = Math.round(km * Number(perKm) * 1000) + Math.round(driverHours * Number(perHour) * 1000);
  return (fils / 1000).toFixed(3);
}
