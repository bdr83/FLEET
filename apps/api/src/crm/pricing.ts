/**
 * Contract pricing, kept pure so it can be unit tested and reused by invoicing (P8).
 * Money is computed in the smallest unit (fils for KWD: 3 decimals) as integers to avoid float errors.
 */
export const UNITS = ['task', 'km', 'hour', 'trip', 'm3', 'ton', 'day', 'month'] as const;
export type Unit = (typeof UNITS)[number];

export interface Rate {
  id?: string;
  sector_pack: string | null;
  unit: Unit;
  price: string | number;
  included_qty?: string | number;
  min_charge?: string | number;
  description?: string | null;
}
export interface PriceLine { unit: Unit; qty: number; billable_qty: number; unit_price: string; amount: string; rate_id?: string; description?: string | null }
export interface Quote { lines: PriceLine[]; total: string; unpriced: Unit[] }

const SCALE = 1000; // 3 decimals: KWD, BHD, OMR use fils/baisa; 2-decimal currencies simply end in 0
const toMinor = (v: string | number | undefined) => Math.round(Number(v ?? 0) * SCALE);
const fmt = (minor: number) => (minor / SCALE).toFixed(3);

/** The rate for a unit: one specific to the task type wins over a general one (sector_pack NULL). */
export function pickRate(rates: Rate[], sectorPack: string, unit: Unit): Rate | undefined {
  return rates.find((r) => r.unit === unit && r.sector_pack === sectorPack) ?? rates.find((r) => r.unit === unit && r.sector_pack === null);
}

/**
 * Prices one task. quantities defaults to { task: 1 }. For each unit:
 * billable = max(0, qty - included_qty); amount = max(billable × price, min_charge) when qty > 0.
 */
export function priceTask(rates: Rate[], sectorPack: string, quantities: Partial<Record<Unit, number>> = { task: 1 }): Quote {
  const lines: PriceLine[] = [];
  const unpriced: Unit[] = [];
  for (const unit of UNITS) {
    const qty = quantities[unit];
    if (qty === undefined || qty === null) continue;
    if (!Number.isFinite(qty) || qty < 0) throw new Error(`invalid quantity for ${unit}`);
    const rate = pickRate(rates, sectorPack, unit);
    if (!rate) { if (qty > 0) unpriced.push(unit); continue; }
    const billable = Math.max(0, qty - Number(rate.included_qty ?? 0));
    let amount = Math.round(billable * toMinor(rate.price));
    if (qty > 0) amount = Math.max(amount, toMinor(rate.min_charge));
    lines.push({ unit, qty, billable_qty: Number(billable.toFixed(3)), unit_price: fmt(toMinor(rate.price)), amount: fmt(amount), rate_id: rate.id, description: rate.description ?? null });
  }
  return { lines, total: fmt(lines.reduce((s, l) => s + toMinor(l.amount), 0)), unpriced };
}
