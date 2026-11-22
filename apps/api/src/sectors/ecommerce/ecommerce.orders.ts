import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthContext } from '../../auth/auth.guard';
import { audit } from '../../common/audit';
import { normalizePhone } from '../../common/phone';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { bookParcel } from '../courier/courier.controller';
import { SERVICES, Service } from '../courier/courier';
import { DELIVERY } from '../delivery/delivery';
import { ecomStatus, EXTERNAL_ID_RE, OrderLine, parseItems } from './ecommerce';

/** One row per store order: its delivery (directly or from the warehouse order), courier state, tracking token and COD. */
export const ORDER_SQL = `
  SELECT eo.id, eo.customer_id, cu.name AS merchant_name, eo.external_id, eo.source, eo.items, eo.created_at, eo.canceled_at, eo.return_reason,
         eo.wh_order_id, wo.status AS wh_status, wo.ref AS wh_ref,
         COALESCE(eo.task_id, wo.delivery_task_id) AS task_id, t.status AS task_status, t.version AS task_version, t.attributes,
         cp.awb, cp.rto_at, cp.rto_done_at, l.token AS track_token, cod.amount::text AS cod_collected,
         eo.return_task_id, rt.status AS return_status,
         (SELECT e.reason_code FROM ops.task_event e WHERE e.task_id = COALESCE(eo.task_id, wo.delivery_task_id) AND e.to_status = 'failed' ORDER BY e.occurred_at DESC LIMIT 1) AS fail_reason,
         (SELECT max(e.occurred_at) FROM ops.task_event e WHERE e.task_id = COALESCE(eo.task_id, wo.delivery_task_id) AND e.to_status = 'completed') AS delivered_at,
         GREATEST(eo.created_at, t.updated_at, wo.shipped_at, wo.picked_at, eo.canceled_at, rt.updated_at, cp.rto_at, cp.rto_done_at) AS updated_at
    FROM ops.ecom_order eo JOIN crm.customer cu ON cu.id = eo.customer_id
    LEFT JOIN ops.wh_order wo ON wo.id = eo.wh_order_id
    LEFT JOIN ops.task t ON t.id = COALESCE(eo.task_id, wo.delivery_task_id)
    LEFT JOIN ops.courier_parcel cp ON cp.task_id = t.id
    LEFT JOIN ops.delivery_link l ON l.task_id = t.id
    LEFT JOIN billing.cod_collection cod ON cod.task_id = t.id
    LEFT JOIN ops.task rt ON rt.id = eo.return_task_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export const withStatus = (r: Row): Row & { status: ReturnType<typeof ecomStatus> } => ({ ...r, status: ecomStatus(r as Parameters<typeof ecomStatus>[0]) });

/** What a store sees through its API: no internal ids of drivers or staff. */
export function forStore(r: ReturnType<typeof withStatus>, appUrl: string) {
  const at = (r.attributes ?? {}) as Record<string, unknown>;
  return {
    external_id: r.external_id, status: r.status, awb: r.awb ?? null, created_at: r.created_at, updated_at: r.updated_at, delivered_at: r.delivered_at ?? null,
    fail_reason: r.fail_reason ?? null, attempt: at.attempt ?? null, cod_amount: at.cod_amount ?? null, cod_collected: r.cod_collected ?? null,
    tracking_url: r.track_token ? `${appUrl}/track/${r.track_token}` : null, return_status: r.return_task_id ? r.return_status : null,
  };
}

export interface Merchant { customer_id: string; legal_entity_id: string; pickup: Record<string, unknown> | null; default_service: Service; warehouse_id: string | null; max_attempts: number; active: boolean }
export async function merchantOf(c: PoolClient, customer: string): Promise<Merchant | null> {
  return (await c.query(
    `SELECT m.customer_id, cu.legal_entity_id, m.pickup, m.default_service, m.warehouse_id, m.max_attempts, m.active
       FROM ops.ecom_merchant m JOIN crm.customer cu ON cu.id = m.customer_id WHERE m.customer_id = $1`, [customer])).rows[0] ?? null;
}

function shipTo(recipient: Record<string, unknown>, dropoff: Record<string, unknown>) {
  const s = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : undefined);
  return Object.fromEntries(Object.entries({ name: s(recipient.name), phone: s(recipient.phone), area: s(dropoff.area), block: s(dropoff.block), street: s(dropoff.street), house: s(dropoff.house) }).filter(([, x]) => x));
}

/**
 * Creates a store order inside the caller's transaction. Idempotent on the store's order id: the same id again returns
 * the existing order with `duplicate: true`. Where it goes: the store's warehouse (warehouse pack and stock kept with us),
 * else a courier parcel (courier pack), else a delivery task (delivery pack).
 */
export async function createOrder(c: PoolClient, a: AuthContext, m: Merchant, b: Record<string, unknown>, source: 'api' | 'import' | 'office'): Promise<Row & { status: ReturnType<typeof ecomStatus>; duplicate: boolean }> {
  const ext = typeof b?.external_id === 'string' ? b.external_id.trim() : '';
  if (!EXTERNAL_ID_RE.test(ext)) throw new BadRequestException('external_id: 1-60 letters, digits, - _ . #');
  const prior = (await c.query(`${ORDER_SQL} WHERE eo.customer_id = $1 AND eo.external_id = $2`, [m.customer_id, ext])).rows[0];
  if (prior) return { ...withStatus(prior), duplicate: true };
  const recipient = v.obj(b?.recipient, 'recipient');
  const dropoff = v.obj(b?.dropoff, 'dropoff');
  if (!recipient?.phone || !normalizePhone(recipient.phone)) throw new BadRequestException('recipient.phone required');
  if (!dropoff?.area) throw new BadRequestException('dropoff.area required');
  const items = parseItems(b?.items);
  if (typeof items === 'string') throw new BadRequestException(items);
  const cod = v.money(b?.cod_amount, 'cod_amount');
  const service = (v.str(b?.service, 'service', { max: 20 }) ?? m.default_service) as Service;
  if (!SERVICES.includes(service)) throw new BadRequestException(`service must be one of ${SERVICES.join(', ')}`);
  const notes = v.str(b?.notes, 'notes', { max: 300 });
  const pieces = v.int(b?.pieces, 'pieces', 1, 999) ?? 1;
  const id = randomUUID();
  let task: string | null = null, wh: string | null = null;

  if (m.warehouse_id && a.packs.includes('warehouse')) {
    // the store keeps its stock with us: an outbound order, shipped later as a delivery
    if (!items.length || items.some((i) => !i.sku)) throw new BadRequestException('orders from the warehouse need items with sku');
    const skus = (await c.query('SELECT id, sku FROM ops.wh_item WHERE customer_id = $1 AND active AND sku = ANY($2::text[])', [m.customer_id, items.map((i) => i.sku)])).rows;
    const bySku = new Map<string, string>(skus.map((r) => [r.sku, r.id]));
    const missing = items.filter((i) => !bySku.has(i.sku!)).map((i) => i.sku);
    if (missing.length) throw new BadRequestException(`unknown sku for this store: ${missing.join(', ')}`);
    wh = randomUUID();
    await c.query('INSERT INTO ops.wh_order (id, tenant_id, warehouse_id, customer_id, ref, lines, ship_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [wh, a.tenantId, m.warehouse_id, m.customer_id, ext.slice(0, 40), JSON.stringify(items.map((i) => ({ item_id: bySku.get(i.sku!), qty: i.qty }))),
        JSON.stringify(shipTo(recipient, dropoff)), a.userId || null]);
  } else if (a.packs.includes('courier')) {
    task = await bookParcel(c, a, {
      le: m.legal_entity_id, customer: m.customer_id, service, pieces, weight: null, origin: null, dest: null, maxAttempts: m.max_attempts,
      recipient, dropoff, pickup: m.pickup, cod: cod && Number(cod) > 0 ? cod : null, fee: null, notes, awb: null,
      extra: { external_order_id: ext, ...(items.length ? { items_count: Math.max(1, Math.min(1000, Math.round(items.reduce((s, i) => s + i.qty, 0)))) } : {}) },
    });
  } else if (a.packs.includes('delivery')) {
    const t = await createTask(c, a, {
      le: m.legal_entity_id, pack: DELIVERY, branch: null, ref: `${m.customer_id.slice(0, 8)}:${ext}`, status: 'ready', customer: m.customer_id, site: null, win: null,
      attrs: { recipient, dropoff, ...(m.pickup ? { pickup: m.pickup } : {}), ...(cod && Number(cod) > 0 ? { cod_amount: cod } : {}), external_order_id: ext,
        ...(notes ? { notes } : {}), ...(items.length ? { items_count: Math.max(1, Math.min(1000, Math.round(items.reduce((s, i) => s + i.qty, 0)))) } : {}) },
    });
    task = t.id;
  } else {
    throw new ForbiddenException('pack_disabled');
  }
  await c.query('INSERT INTO ops.ecom_order (id, tenant_id, legal_entity_id, customer_id, external_id, source, items, task_id, wh_order_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, a.tenantId, m.legal_entity_id, m.customer_id, ext, source, JSON.stringify(items), task, wh]);
  await audit(c, { tenantId: a.tenantId, actorId: a.userId || null, actorType: source === 'api' ? 'customer' : 'user', action: 'ecommerce.order_created', targetType: 'ecom_order', targetId: id,
    after: { external_id: ext, source, via: wh ? 'warehouse' : a.packs.includes('courier') ? 'courier' : 'delivery' } });
  return { ...withStatus((await c.query(`${ORDER_SQL} WHERE eo.id = $1`, [id])).rows[0]), duplicate: false };
}

/** Cancels an order before it leaves: an open or picked warehouse order, or a delivery nobody has taken out yet. */
export async function cancelOrder(c: PoolClient, a: AuthContext, orderId: string, reason: string) {
  const o = (await c.query(`${ORDER_SQL} WHERE eo.id = $1`, [orderId])).rows[0];
  if (!o) throw new NotFoundException();
  if (o.canceled_at) return withStatus(o);
  if (o.task_id) {
    const t = (await c.query('SELECT status FROM ops.task WHERE id = $1 FOR UPDATE', [o.task_id])).rows[0];
    if (!['draft', 'ready', 'assigned'].includes(t.status)) throw new ConflictException('already with the driver or closed');
    await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [o.task_id]);
    await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [o.task_id]);
    await c.query(`INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,'canceled',now(),$5,$6,$7,$8)`,
      [randomUUID(), a.tenantId, o.task_id, t.status, a.userId || null, a.customerId ? 'customer' : 'staff', randomUUID(), reason]);
  }
  if (o.wh_order_id && ['open', 'picked'].includes(o.wh_status)) {
    if (o.wh_status === 'picked') {
      await c.query(
        `INSERT INTO ops.wh_movement (id, tenant_id, item_id, location_id, qty, lot, expiry, kind, order_id, reason, actor_id)
         SELECT gen_random_uuid(), tenant_id, item_id, location_id, -qty, lot, expiry, 'move', order_id, $2, $3 FROM ops.wh_movement WHERE order_id = $1 AND kind = 'pick'`,
        [o.wh_order_id, `order canceled: ${reason}`.slice(0, 300), a.userId || null]);
    }
    await c.query(`UPDATE ops.wh_order SET status = 'canceled', cancel_reason = $2 WHERE id = $1`, [o.wh_order_id, reason]);
  } else if (o.wh_order_id && !o.task_id) {
    throw new ConflictException('already shipped');
  }
  await c.query('UPDATE ops.ecom_order SET canceled_at = now() WHERE id = $1', [orderId]);
  await audit(c, { tenantId: a.tenantId, actorId: a.userId || null, actorType: a.customerId ? 'customer' : 'user', action: 'ecommerce.order_canceled', targetType: 'ecom_order', targetId: orderId, after: { reason } });
  return withStatus((await c.query(`${ORDER_SQL} WHERE eo.id = $1`, [orderId])).rows[0]);
}

/** A return from the buyer to the store after delivery: a reverse delivery task to the store's pickup address. */
export async function requestReturn(c: PoolClient, a: AuthContext, orderId: string, reason: string) {
  const o = (await c.query(`${ORDER_SQL} WHERE eo.id = $1 FOR UPDATE OF eo`, [orderId])).rows[0];
  if (!o) throw new NotFoundException();
  if (ecomStatus(o) !== 'delivered') throw new ConflictException('only a delivered order can be returned');
  if (o.return_task_id) throw new ConflictException('a return already exists');
  const m = await merchantOf(c, o.customer_id);
  const back = m?.pickup as Record<string, unknown> | null;
  if (!back?.area) throw new ConflictException('the store has no pickup address for returns');
  const at = (o.attributes ?? {}) as Record<string, unknown>;
  const t = await createTask(c, a, {
    le: m!.legal_entity_id, pack: DELIVERY, branch: null, ref: `${o.customer_id.slice(0, 8)}:${o.external_id}:R`.slice(0, 60), status: 'ready', customer: o.customer_id, site: null, win: null,
    attrs: { kind: 'return', pickup: { ...(at.dropoff as object), ...(at.recipient && (at.recipient as { phone?: string }).phone ? { phone: (at.recipient as { phone: string }).phone } : {}) },
      dropoff: back, recipient: { name: back.name ?? o.merchant_name, ...(back.phone ? { phone: back.phone } : {}) }, external_order_id: `${o.external_id}-R`, notes: `مرتجع: ${reason}`.slice(0, 300) },
  });
  await c.query('UPDATE ops.ecom_order SET return_task_id = $2, return_reason = $3 WHERE id = $1', [orderId, t.id, reason]);
  await audit(c, { tenantId: a.tenantId, actorId: a.userId || null, actorType: a.customerId ? 'customer' : 'user', action: 'ecommerce.return_requested', targetType: 'ecom_order', targetId: orderId, after: { reason, task_id: t.id } });
  return withStatus((await c.query(`${ORDER_SQL} WHERE eo.id = $1`, [orderId])).rows[0]);
}
