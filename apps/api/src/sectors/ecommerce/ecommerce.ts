import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * E-commerce shipping pack (ecommerce, sector 9). Online stores (customers) send their orders by API key or file; each
 * order becomes a courier parcel (courier pack), a delivery task (delivery pack), or an outbound order from our warehouse
 * when the store keeps its stock with us (warehouse pack). Stores read their orders' status through the API; returns from
 * the buyer to the store are reverse delivery tasks. Money stays in the core books (COD collection, invoices, offsets, payouts).
 */

/** "fpk_<10 lowercase letters/digits>_<32 base64url>": the prefix finds the key, the secret is checked by its hash. */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(10).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(10, '0').slice(0, 10);
  const secret = randomBytes(24).toString('base64url');
  return { key: `fpk_${prefix}_${secret}`, prefix, hash: sha256(secret) };
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export function parseApiKey(header: unknown): { prefix: string; secret: string } | null {
  if (typeof header !== 'string') return null;
  const m = /^fpk_([a-z0-9]{10})_([A-Za-z0-9_-]{32})$/.exec(header.trim());
  return m ? { prefix: m[1], secret: m[2] } : null;
}
export function secretMatches(secret: string, hash: string): boolean {
  const a = Buffer.from(sha256(secret), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const EXTERNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.#-]{0,59}$/;

export type EcomStatus = 'received' | 'processing' | 'ready_to_ship' | 'confirmed' | 'out_for_delivery' | 'delivered' | 'failed' | 'returning_to_store' | 'returned_to_store' | 'canceled';
/**
 * The store-facing status of an order, from its warehouse order, delivery task and courier return state:
 * processing (being picked) → ready_to_ship → confirmed (waiting for a driver) → out_for_delivery → delivered,
 * or failed → returning_to_store → returned_to_store; canceled at any point before dispatch.
 */
export function ecomStatus(o: { canceled_at: unknown; wh_status: string | null; task_status: string | null; rto_at: unknown; rto_done_at: unknown }): EcomStatus {
  if (o.canceled_at || o.task_status === 'canceled' || o.wh_status === 'canceled') return 'canceled';
  if (o.rto_done_at) return 'returned_to_store';
  if (o.rto_at) return 'returning_to_store';
  if (!o.task_status) return o.wh_status === 'picked' ? 'ready_to_ship' : o.wh_status === 'shipped' ? 'confirmed' : 'processing';
  if (['completed', 'reviewed', 'invoiced'].includes(o.task_status)) return 'delivered';
  if (o.task_status === 'failed') return 'failed';
  if (o.task_status === 'in_progress') return 'out_for_delivery';
  return o.task_status === 'draft' ? 'received' : 'confirmed';
}

export interface OrderLine { sku?: string; name: string; qty: number }
/** Order lines from a store: a name (or SKU), a whole or 2-decimal quantity; at most 100. */
export function parseItems(val: unknown): OrderLine[] | string {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val) || val.length > 100) return 'items: up to 100 lines';
  const out: OrderLine[] = [];
  for (const [i, x] of val.entries()) {
    if (!x || typeof x !== 'object') return `items[${i}] must be an object`;
    const o = x as Record<string, unknown>;
    const sku = typeof o.sku === 'string' && o.sku.trim() ? o.sku.trim() : undefined;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : sku;
    const qty = typeof o.qty === 'number' ? o.qty : Number(o.qty);
    if (!name) return `items[${i}] needs a name or sku`;
    if (sku && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(sku)) return `items[${i}].sku invalid`;
    if (!Number.isFinite(qty) || qty <= 0 || qty >= 100_000 || Math.abs(Math.round(qty * 100) - qty * 100) > 1e-6) return `items[${i}].qty invalid`;
    out.push({ ...(sku ? { sku } : {}), name, qty });
  }
  return out;
}
