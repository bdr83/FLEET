/**
 * Warehousing pack (warehouse, sector 8): our own store or third-party storage (3PL). Warehouses and locations, items owned
 * by a customer, receipts into a location (lot and expiry optional), outbound orders picked first-expiry-first-out and
 * shipped (optionally as a delivery task for our fleet), moves and stock counts. Stock is never stored: it is the sum of
 * the movements, which are append-only.
 */
export const LOCATION_KINDS = ['storage', 'pick', 'dock', 'quarantine'] as const;
export const ITEM_UNITS = ['piece', 'carton', 'pallet', 'kg', 'liter', 'bag'] as const;
/** Stock expiring within this many days is an exception. [تخمين] */
export const EXPIRY_ALERT_DAYS = 30;
/** An open order not picked after this many hours (when it has no due time) is an exception. [تخمين] */
export const ORDER_LATE_HOURS = 24;

export interface StockRow { item_id: string; location_id: string; location_code: string; location_kind: string; lot: string | null; expiry: string | null; qty: number }
export interface Pick { item_id: string; location_id: string; location_code: string; lot: string | null; expiry: string | null; qty: number }
export interface Line { item_id: string; qty: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A pick plan for order lines from the stock rows: first expiry first out (no expiry last), then the smaller balance
 * first so bins empty out, then the location code. Quarantine and expired stock is never picked. Returns the picks and
 * what is short per item.
 */
export function allocate(lines: Line[], stock: StockRow[], today: string): { picks: Pick[]; short: { item_id: string; qty: number }[] } {
  const left = stock.filter((s) => s.qty > 0 && s.location_kind !== 'quarantine' && !(s.expiry && s.expiry < today)).map((s) => ({ ...s }));
  left.sort((a, b) => (a.expiry ?? '9999-12-31').localeCompare(b.expiry ?? '9999-12-31') || a.qty - b.qty || a.location_code.localeCompare(b.location_code));
  const picks: Pick[] = [];
  const short: { item_id: string; qty: number }[] = [];
  const need = new Map<string, number>();
  for (const l of lines) need.set(l.item_id, r2((need.get(l.item_id) ?? 0) + l.qty));
  for (const [item, qty] of need) {
    let want = qty;
    for (const s of left) {
      if (want <= 0) break;
      if (s.item_id !== item || s.qty <= 0) continue;
      const take = r2(Math.min(want, s.qty));
      picks.push({ item_id: item, location_id: s.location_id, location_code: s.location_code, lot: s.lot, expiry: s.expiry, qty: take });
      s.qty = r2(s.qty - take);
      want = r2(want - take);
    }
    if (want > 0) short.push({ item_id: item, qty: want });
  }
  return { picks, short };
}

/** Received against expected, per item: what came short or over. */
export function receiptVariance(expected: Line[] | null, received: Line[]): { item_id: string; expected: number; received: number; diff: number }[] {
  if (!expected?.length) return [];
  const sum = (ls: Line[]) => ls.reduce((m, l) => m.set(l.item_id, r2((m.get(l.item_id) ?? 0) + l.qty)), new Map<string, number>());
  const e = sum(expected), r = sum(received);
  return [...new Set([...e.keys(), ...r.keys()])].map((id) => ({ item_id: id, expected: e.get(id) ?? 0, received: r.get(id) ?? 0, diff: r2((r.get(id) ?? 0) - (e.get(id) ?? 0)) }))
    .filter((x) => x.diff !== 0);
}

/** A quantity: more than 0, up to 2 decimals, below a million. */
export function qtyOk(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1_000_000 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}
