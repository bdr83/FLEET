/**
 * Car rental (rental pack, sector 17). An agreement rents a vehicle to a customer (a person or a company) for a period, by
 * the day, week or month. The agreement is a core task that books the vehicle exclusively for the period, so no other
 * sector can book it then. Check-out and check-in record the odometer, the fuel in eighths and the damage; the charges are
 * worked out at check-in from the rates the office entered on the agreement. A driver can deliver the vehicle to the
 * customer or collect it, from the app. Traffic fines are matched to the agreement the vehicle was on at the time.
 */
export const RENTAL = 'rental@1';
export const isRental = (pack: string | null | undefined) => pack === RENTAL;

/** The driver's hand-over to the customer (a delivery) and taking the vehicle back (a collection). */
export const STAGES = ['handover', 'collected'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { handover: ['in_progress'], collected: ['in_progress'] };
export const STAGE_OF: Record<'deliver' | 'collect', Stage> = { deliver: 'handover', collect: 'collected' };
export const FAIL_REASONS = ['customer_absent', 'customer_refused', 'licence_invalid', 'vehicle_issue', 'other'] as const;
export const RATE_UNITS = ['day', 'week', 'month'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];
export const UNIT_DAYS: Record<RateUnit, number> = { day: 1, week: 7, month: 30 };
/** Vehicles a rental company rents out (not heavy equipment). */
export const RENTAL_TYPES = ['car', 'van', 'pickup', 'motorbike', 'bus', 'truck'] as const;
/** A return this late after the last full day starts no new day. [تخمين] */
export const GRACE_MIN = 60;
/** A reservation not picked up this long after its time shows as late. [تخمين] */
export const LATE_PICKUP_MIN = 60;
/** A delivery or collection books the driver for this long. [تخمين] */
export const MOVE_MIN = 60;
export const FINE_STATUSES = ['open', 'charged', 'waived', 'paid_by_us'] as const;

/** Days charged: whole 24-hour periods, a started day counts after the grace time, at least one. */
export function rentalDays(outAt: Date, inAt: Date, graceMin = GRACE_MIN): number {
  const min = (inAt.getTime() - outAt.getTime()) / 60_000;
  const full = Math.floor(min / 1440);
  const rest = min - full * 1440;
  return Math.max(1, full + (rest > graceMin ? 1 : 0));
}

const fils = (n: number) => Math.round(n * 1000);
const kwd = (f: number) => (f / 1000).toFixed(3);

/**
 * The amount for the days at a day, week or month rate: whole units at the rate, and the days left over pro rata, never
 * more than one more unit. [تخمين] confirm per company.
 */
export function rentalAmount(days: number, unit: RateUnit, rate: number): string {
  const per = UNIT_DAYS[unit];
  const whole = Math.floor(days / per), left = days - whole * per;
  return kwd(whole * fils(rate) + Math.min(fils(rate), Math.round((left * fils(rate)) / per)));
}

export interface Charges { days: number; rental_amount: string; extra_km: number; km_amount: string; fuel_amount: string; damage_amount: string; total: string }

/** All the charges at check-in. Rates are what the office entered; nothing is priced here. */
export function charges(x: {
  outAt: Date; inAt: Date; outKm: number; inKm: number; outFuel: number | null; inFuel: number | null;
  unit: RateUnit; rate: number; kmPerDay: number | null; extraKmRate: number; fuelRate: number; damage: number;
}): Charges {
  const days = rentalDays(x.outAt, x.inAt);
  const rental = rentalAmount(days, x.unit, x.rate);
  const extraKm = x.kmPerDay === null ? 0 : Math.max(0, x.inKm - x.outKm - x.kmPerDay * days);
  const km = kwd(extraKm * fils(x.extraKmRate));
  const short = x.outFuel !== null && x.inFuel !== null ? Math.max(0, x.outFuel - x.inFuel) : 0;
  const fuel = kwd(short * fils(x.fuelRate));
  const damage = kwd(fils(x.damage));
  const total = kwd(fils(Number(rental)) + fils(Number(km)) + fils(Number(fuel)) + fils(Number(damage)));
  return { days, rental_amount: rental, extra_km: extraKm, km_amount: km, fuel_amount: fuel, damage_amount: damage, total };
}
