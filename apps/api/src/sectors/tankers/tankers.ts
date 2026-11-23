/**
 * Water, diesel and fuel tankers (tankers pack, sector 7). Fresh or brackish water, diesel and kerosene delivered by
 * tanker to customers' sites. Each tanker is registered as water or fuel with its capacity in litres. Each order is a core
 * task booking the tanker and its driver; the driver records the litres filled and where, then the litres discharged and
 * the receiver. The difference is watched. Standing orders create the day's orders. Prices per 1000 litres from the office.
 */
export const TANKERS = 'tankers@1';
export const isTankers = (pack: string | null | undefined) => pack === TANKERS;

export const STAGES = ['tank_filled', 'tank_discharged'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ALLOWED: Record<Stage, string[]> = { tank_filled: ['in_progress'], tank_discharged: ['in_progress'] };
export const STAGE_NEEDS: Partial<Record<Stage, Stage>> = { tank_discharged: 'tank_filled' };
export const FAIL_REASONS = ['customer_absent', 'no_access', 'tank_full', 'source_closed', 'truck_breakdown', 'customer_canceled', 'other'] as const;

export const PRODUCTS = ['water_fresh', 'water_brackish', 'diesel', 'kerosene'] as const;
export type Product = (typeof PRODUCTS)[number];
export const CLASSES = ['water', 'fuel'] as const;
export type ProductClass = (typeof CLASSES)[number];
export const classOf = (p: Product | string): ProductClass => (p === 'diesel' || p === 'kerosene' ? 'fuel' : 'water');

/** The delivery window when the office gives only a time. [تخمين] */
export const WINDOW_MIN = 120;
/** Loss between filled and discharged above this share is flagged: fuel is metered, water less so. [تخمين] */
export const LOSS_PCT: Record<ProductClass, number> = { fuel: 0.5, water: 3 };
/** A delivery short of the order by more than this share is flagged. [تخمين] */
export const SHORT_PCT = 5;

/** Litres lost between filling and discharging, and whether it is above the allowance for the product. */
export function loss(product: Product | string, loaded: number | null, delivered: number | null): { litres: number; pct: number; flagged: boolean } | null {
  if (loaded === null || delivered === null || loaded <= 0) return null;
  const litres = loaded - delivered;
  const pct = Math.round((litres / loaded) * 1000) / 10;
  return { litres, pct, flagged: pct > LOSS_PCT[classOf(product)] };
}

/** Amount for the litres delivered at a price per 1000 litres, in fils-exact KWD text. */
export function amount(unitPrice: string | null, litres: number | null): string | null {
  if (unitPrice === null || litres === null) return null;
  return (Math.round(Math.round(Number(unitPrice) * 1000) * litres / 1000) / 1000).toFixed(3);
}

/** Where an order stands from its task: new (no tanker), assigned, on_way, delivered, failed (to reassign), canceled. */
export function orderState(o: { canceled_at: unknown; delivered_at: unknown }, taskStatus: string | null): string {
  if (o.canceled_at) return 'canceled';
  if (o.delivered_at) return 'delivered';
  if (!taskStatus || taskStatus === 'canceled') return 'new';
  if (taskStatus === 'failed') return 'failed';
  if (taskStatus === 'in_progress') return 'on_way';
  if (['completed', 'reviewed', 'invoiced'].includes(taskStatus)) return 'delivered';
  return 'assigned';
}
