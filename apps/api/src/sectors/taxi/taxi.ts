import { BadRequestException } from '@nestjs/common';

/**
 * Taxi and limousine (taxi pack, sector 12). Call-taxi and limousine companies take bookings by phone or from a
 * corporate account: a passenger, a pickup (now or at a time, an airport flight), a drop-off and a car class. Each booking
 * is a core task booking a car of the class and its driver. The driver arrives, picks the passenger up, then drops them
 * with the trip's kilometres and how it was paid. The fare is the office's fixed price, or the tariff of the class
 * (base, per km, per waiting minute, minimum). Account trips are invoiced to the customer monthly; drivers hand the cash in.
 */
export const TAXI = 'taxi@1';
export const isTaxi = (pack: string | null | undefined) => pack === TAXI;

export const STAGES = ['tx_arrived', 'tx_picked', 'tx_dropped'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { tx_arrived: ['in_progress'], tx_picked: ['in_progress'], tx_dropped: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { tx_picked: 'tx_arrived', tx_dropped: 'tx_picked' };
export const FAIL_REASONS = ['passenger_no_show', 'passenger_canceled', 'vehicle_breakdown', 'other'] as const;

export const CLASSES = ['sedan', 'suv', 'van', 'luxury'] as const;
export type CarClass = (typeof CLASSES)[number];
export const PAYMENTS = ['cash', 'card', 'account'] as const;
export type Payment = (typeof PAYMENTS)[number];

/** A booking holds the car and driver this long from the pickup time unless the office says otherwise. [تخمين] */
export const TRIP_MIN = 60;
/** Waiting minutes at the pickup that are free before the tariff's waiting charge. [تخمين] */
export const FREE_WAIT_MIN = 5;
/** A passenger can be marked absent only after the driver has waited this long at the pickup. [تخمين] */
export const NO_SHOW_WAIT_MIN = 10;
/** A driver not at the pickup this many minutes after the pickup time is late. [تخمين] */
export const LATE_ARRIVAL_MIN = 10;
/** A booking still without a car this close to its pickup is flagged. [تخمين] */
export const UNASSIGNED_WARN_MIN = 30;

/** A car of a higher class may serve a sedan booking; otherwise the class must match. */
export const servesClass = (car: CarClass | string, wanted: CarClass | string) => car === wanted || (wanted === 'sedan' && (car === 'suv' || car === 'luxury'));

export interface Tariff { base: string; per_km: string; per_wait_min: string; min_fare: string }

const fils = (s: string | number) => Math.round(Number(s) * 1000);

/** The metered fare from the class tariff: base + km + waiting beyond the free minutes, at least the minimum. KWD text. */
export function meterFare(t: Tariff, km: number, waitMin: number): string {
  const f = fils(t.base) + Math.round(fils(t.per_km) * km) + fils(t.per_wait_min) * Math.max(0, Math.ceil(waitMin) - FREE_WAIT_MIN);
  return (Math.max(f, fils(t.min_fare)) / 1000).toFixed(3);
}

/** Minutes the driver waited at the pickup, from arrival to pick-up (0 if the passenger came out before the pickup time counted). */
export function waitMinutes(pickupAt: Date, arrivedAt: Date | null, pickedAt: Date | null): number {
  if (!arrivedAt || !pickedAt) return 0;
  const from = Math.max(arrivedAt.getTime(), pickupAt.getTime());
  return Math.max(0, Math.round((pickedAt.getTime() - from) / 60_000));
}

/** Trip kilometres from the driver: 0-1000 with one decimal. */
export function parseKm(val: unknown, field = 'km'): number | null {
  if (val === undefined || val === null) return null;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n) || n < 0 || n > 1000 || Math.round(n * 10) !== n * 10) throw new BadRequestException(`${field} must be 0-1000 km, one decimal`);
  return n;
}

/** Where a booking stands from its task and stages: new, assigned, on_way, waiting, on_trip, done, failed, canceled. */
export function bookingState(b: { canceled_at: unknown; arrived_at: unknown; picked_at: unknown; dropped_at: unknown }, taskStatus: string | null): string {
  if (b.canceled_at) return 'canceled';
  if (b.dropped_at) return 'done';
  if (!taskStatus || taskStatus === 'canceled') return 'new';
  if (taskStatus === 'failed') return 'failed';
  if (['completed', 'reviewed', 'invoiced'].includes(taskStatus)) return 'done';
  if (b.picked_at) return 'on_trip';
  if (b.arrived_at) return 'waiting';
  if (taskStatus === 'in_progress') return 'on_way';
  return 'assigned';
}
