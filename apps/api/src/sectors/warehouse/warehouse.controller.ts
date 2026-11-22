import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { DELIVERY } from '../delivery/delivery';
import { allocate, EXPIRY_ALERT_DAYS, ITEM_UNITS, Line, LOCATION_KINDS, ORDER_LATE_HOURS, Pick, qtyOk, receiptVariance, StockRow } from './warehouse';

const code = (val: unknown, field: string, max: number) => {
  const s = v.str(val, field, { required: true, max })!.toUpperCase().trim();
  if (!new RegExp(`^[A-Z0-9][A-Z0-9_.-]{0,${max - 1}}$`).test(s)) throw new BadRequestException(`${field}: letters, digits, - . and _ only`);
  return s;
};
const ref = (val: unknown) => v.str(val, 'ref', { required: true, max: 40 })!.trim();
const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const num = (r: Record<string, unknown>, k: string) => ({ ...r, [k]: Number(r[k]) });

/** Stock rows (balance > 0) per item, location, lot and expiry. */
const STOCK_SQL = `
  SELECT m.item_id, i.sku, i.name AS item_name, i.unit, i.customer_id, cu.name AS customer_name, m.location_id, l.code AS location_code, l.kind AS location_kind,
         l.warehouse_id, w.code AS warehouse_code, m.lot, m.expiry::text AS expiry, sum(m.qty)::float AS qty
    FROM ops.wh_movement m JOIN ops.wh_item i ON i.id = m.item_id JOIN ops.wh_location l ON l.id = m.location_id JOIN ops.wh_warehouse w ON w.id = l.warehouse_id
    LEFT JOIN crm.customer cu ON cu.id = i.customer_id`;
const STOCK_GROUP = `GROUP BY m.item_id, i.sku, i.name, i.unit, i.customer_id, cu.name, m.location_id, l.code, l.kind, l.warehouse_id, w.code, m.lot, m.expiry HAVING sum(m.qty) > 0`;

const ORDER_SQL = `
  SELECT o.id, o.warehouse_id, w.code AS warehouse_code, w.legal_entity_id, o.customer_id, cu.name AS customer_name, o.ref, o.lines, o.ship_to, o.due_at, o.status,
         o.picked_at, o.shipped_at, o.delivery_task_id, dt.status AS delivery_status, o.cancel_reason, o.created_at
    FROM ops.wh_order o JOIN ops.wh_warehouse w ON w.id = o.warehouse_id LEFT JOIN crm.customer cu ON cu.id = o.customer_id
    LEFT JOIN ops.task dt ON dt.id = o.delivery_task_id`;

/**
 * Warehousing (warehouse pack, sector 8): warehouses and locations, items per owner, receipts, stock, moves and counts,
 * outbound orders picked first-expiry-first-out and shipped (optionally as a delivery task), exceptions and the report.
 */
@Controller('v1/warehouse')
@UseGuards(AuthGuard)
@Pack('warehouse')
export class WarehouseController {
  constructor(private readonly db: DbService) {}

  @Get('warehouses')
  @Perm('tasks:read')
  warehouses(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT w.id, w.legal_entity_id, w.code, w.name, w.area, w.active,
                (SELECT json_agg(json_build_object('id', l.id, 'code', l.code, 'kind', l.kind, 'active', l.active) ORDER BY l.code) FROM ops.wh_location l WHERE l.warehouse_id = w.id) AS locations
           FROM ops.wh_warehouse w ORDER BY w.active DESC, w.code`)).rows.map((w) => ({ ...w, locations: w.locations ?? [] })),
    }));
  }

  @Post('warehouses')
  @Perm('org:write')
  addWarehouse(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const c0 = code(b?.code, 'code', 12);
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!;
    const area = v.str(b?.area, 'area', { max: 80 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.wh_warehouse (id, tenant_id, legal_entity_id, code, name, area) VALUES ($1,$2,$3,$4,$5,$6)', [id, a.tenantId, le, c0, name, area]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('a warehouse with this code exists');
        return pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.created', targetType: 'wh_warehouse', targetId: id, after: { code: c0, name } });
      return { id, legal_entity_id: le, code: c0, name, area, active: true, locations: [] };
    });
  }

  /** Adds locations in bulk: `codes` like ["A-01-01", "A-01-02"], all of one kind. Existing codes are skipped. */
  @Post('warehouses/:id/locations')
  @Perm('tasks:write')
  addLocations(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const kind = (v.str(b?.kind, 'kind', { max: 20 }) ?? 'storage') as (typeof LOCATION_KINDS)[number];
    if (!LOCATION_KINDS.includes(kind)) throw new BadRequestException(`kind must be one of ${LOCATION_KINDS.join(', ')}`);
    if (!Array.isArray(b?.codes) || b.codes.length === 0 || b.codes.length > 500) throw new BadRequestException('codes: 1-500 location codes');
    const codes = [...new Set((b.codes as unknown[]).map((x, i) => code(x, `codes[${i}]`, 20)))];
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.wh_warehouse WHERE id = $1', [id])).rowCount) throw new NotFoundException();
      let added = 0;
      for (const k of codes) {
        added += (await c.query(
          'INSERT INTO ops.wh_location (id, tenant_id, warehouse_id, code, kind) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, warehouse_id, code) DO NOTHING',
          [randomUUID(), a.tenantId, id, k, kind])).rowCount ?? 0;
      }
      return { added, skipped: codes.length - added, locations: (await c.query('SELECT id, code, kind, active FROM ops.wh_location WHERE warehouse_id = $1 ORDER BY code', [id])).rows };
    });
  }

  @Get('items')
  @Perm('tasks:read')
  items(@Auth() a: AuthContext, @Query('customer_id') customer?: string) {
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT i.id, i.legal_entity_id, i.customer_id, cu.name AS customer_name, i.sku, i.name, i.unit, i.min_qty::float, i.track_expiry, i.active,
                COALESCE((SELECT sum(m.qty) FROM ops.wh_movement m WHERE m.item_id = i.id), 0)::float AS on_hand
           FROM ops.wh_item i LEFT JOIN crm.customer cu ON cu.id = i.customer_id
          WHERE ($1::uuid IS NULL OR i.customer_id = $1) ORDER BY cu.name NULLS FIRST, i.sku LIMIT 2000`, [cu])).rows,
    }));
  }

  @Post('items')
  @Perm('tasks:write')
  addItem(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const sku = v.str(b?.sku, 'sku', { required: true, max: 40 })!.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(sku)) throw new BadRequestException('sku: letters, digits, - . and _ only');
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!;
    const unit = (v.str(b?.unit, 'unit', { max: 20 }) ?? 'piece') as (typeof ITEM_UNITS)[number];
    if (!ITEM_UNITS.includes(unit)) throw new BadRequestException(`unit must be one of ${ITEM_UNITS.join(', ')}`);
    const min = b?.min_qty === undefined || b?.min_qty === null || b?.min_qty === '' ? null : Number(b.min_qty);
    if (min !== null && !(min === 0 || qtyOk(min))) throw new BadRequestException('min_qty must be 0 or more, 2 decimals');
    if (b?.track_expiry !== undefined && typeof b.track_expiry !== 'boolean') throw new BadRequestException('track_expiry must be true/false');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      if (customer && !(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [customer, le])).rowCount) throw new BadRequestException('unknown customer_id');
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.wh_item (id, tenant_id, legal_entity_id, customer_id, sku, name, unit, min_qty, track_expiry) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, a.tenantId, le, customer, sku, name, unit, min, b?.track_expiry === true]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('this owner already has an item with this SKU');
        return pgToHttp(e);
      }
      return (await c.query('SELECT id, legal_entity_id, customer_id, sku, name, unit, min_qty::float, track_expiry, active FROM ops.wh_item WHERE id = $1', [id])).rows[0];
    });
  }

  @Patch('items/:id')
  @Perm('tasks:write')
  editItem(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { max: 120 });
    const min = b?.min_qty === undefined ? undefined : b.min_qty === null ? null : Number(b.min_qty);
    if (min !== undefined && min !== null && !(min === 0 || qtyOk(min))) throw new BadRequestException('min_qty must be 0 or more, 2 decimals');
    if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query('SELECT id, name, min_qty::float, active FROM ops.wh_item WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new NotFoundException();
      const row = (await c.query(
        `UPDATE ops.wh_item SET name = COALESCE($2, name), min_qty = CASE WHEN $3 THEN $4::numeric ELSE min_qty END, active = COALESCE($5, active) WHERE id = $1
         RETURNING id, legal_entity_id, customer_id, sku, name, unit, min_qty::float, track_expiry, active`, [id, name, min !== undefined, min ?? null, b?.active ?? null])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.item_updated', targetType: 'wh_item', targetId: id, before, after: row });
      return row;
    });
  }

  /** Goods in: each line into a location, with lot and expiry (expiry required for items that track it). */
  @Post('receipts')
  @Perm('tasks:write')
  receive(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const wh = v.uuid(b?.warehouse_id, 'warehouse_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const r = ref(b?.ref);
    const note = v.str(b?.note, 'note', { max: 300 });
    const lines = this.lines(b?.lines, true) as (Line & { location_id: string; lot: string | null; expiry: string | null })[];
    const expected = b?.expected === undefined || b?.expected === null ? null : this.lines(b.expected, false);
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.wh_warehouse WHERE id = $1 AND active', [wh])).rowCount) throw new BadRequestException('unknown warehouse_id');
      await this.checkItems(c, [...lines, ...(expected ?? [])], customer);
      for (const l of lines) {
        const loc = (await c.query('SELECT warehouse_id, active FROM ops.wh_location WHERE id = $1', [l.location_id])).rows[0];
        if (!loc || loc.warehouse_id !== wh || !loc.active) throw new BadRequestException('location not in this warehouse');
        const it = (await c.query('SELECT track_expiry FROM ops.wh_item WHERE id = $1', [l.item_id])).rows[0];
        if (it.track_expiry && !l.expiry) throw new BadRequestException('expiry required for this item');
      }
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.wh_receipt (id, tenant_id, warehouse_id, customer_id, ref, expected, note, received_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, a.tenantId, wh, customer, r, expected && JSON.stringify(expected), note, a.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('a receipt with this reference exists in this warehouse');
        return pgToHttp(e);
      }
      for (const l of lines) {
        await c.query(
          `INSERT INTO ops.wh_movement (id, tenant_id, item_id, location_id, qty, lot, expiry, kind, receipt_id, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'receipt',$8,$9)`,
          [randomUUID(), a.tenantId, l.item_id, l.location_id, l.qty, l.lot, l.expiry, id, a.userId]);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.received', targetType: 'wh_receipt', targetId: id, after: { ref: r, lines: lines.length } });
      return { id, warehouse_id: wh, customer_id: customer, ref: r, lines, variance: receiptVariance(expected, lines) };
    });
  }

  @Get('receipts')
  @Perm('tasks:read')
  receipts(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT r.id, r.warehouse_id, w.code AS warehouse_code, r.customer_id, cu.name AS customer_name, r.ref, r.expected, r.note, r.received_at,
                (SELECT json_agg(json_build_object('item_id', m.item_id, 'sku', i.sku, 'qty', m.qty::float, 'location_code', l.code, 'lot', m.lot, 'expiry', m.expiry) ORDER BY i.sku)
                   FROM ops.wh_movement m JOIN ops.wh_item i ON i.id = m.item_id JOIN ops.wh_location l ON l.id = m.location_id WHERE m.receipt_id = r.id) AS lines
           FROM ops.wh_receipt r JOIN ops.wh_warehouse w ON w.id = r.warehouse_id LEFT JOIN crm.customer cu ON cu.id = r.customer_id
          ORDER BY r.received_at DESC LIMIT 200`)).rows.map((r) => ({ ...r, variance: receiptVariance(r.expected, r.lines ?? []) })),
    }));
  }

  @Get('stock')
  @Perm('tasks:read')
  stock(@Auth() a: AuthContext, @Query('warehouse_id') wh?: string, @Query('customer_id') customer?: string, @Query('item_id') item?: string) {
    const w = v.uuid(wh, 'warehouse_id'), cu = v.uuid(customer, 'customer_id'), it = v.uuid(item, 'item_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `${STOCK_SQL} WHERE ($1::uuid IS NULL OR l.warehouse_id = $1) AND ($2::uuid IS NULL OR i.customer_id = $2) AND ($3::uuid IS NULL OR m.item_id = $3)
         ${STOCK_GROUP} ORDER BY i.sku, m.expiry NULLS LAST, l.code LIMIT 3000`, [w, cu, it])).rows,
    }));
  }

  /** Moves stock from one location to another in the same warehouse. */
  @Post('moves')
  @Perm('tasks:write')
  move(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const item = v.uuid(b?.item_id, 'item_id', { required: true })!;
    const from = v.uuid(b?.from_location_id, 'from_location_id', { required: true })!;
    const to = v.uuid(b?.to_location_id, 'to_location_id', { required: true })!;
    if (from === to) throw new BadRequestException('from and to are the same location');
    if (!qtyOk(b?.qty)) throw new BadRequestException('qty must be more than 0, 2 decimals');
    const qty = b.qty as number;
    const lot = v.str(b?.lot, 'lot', { max: 40 });
    return this.db.withTenant(a, async (c) => {
      const locs = (await c.query('SELECT id, warehouse_id, active FROM ops.wh_location WHERE id = ANY($1::uuid[])', [[from, to]])).rows;
      if (locs.length !== 2 || locs[0].warehouse_id !== locs[1].warehouse_id || locs.some((l) => !l.active)) throw new BadRequestException('both locations must be active and in one warehouse');
      await this.lockItem(c, item);
      // move from the batches at the source, first expiry first
      const rows = (await c.query(
        `SELECT m.lot, m.expiry::text AS expiry, sum(m.qty)::float AS qty FROM ops.wh_movement m
          WHERE m.item_id = $1 AND m.location_id = $2 AND ($3::text IS NULL OR m.lot = $3) GROUP BY m.lot, m.expiry HAVING sum(m.qty) > 0
          ORDER BY m.expiry NULLS LAST`, [item, from, lot])).rows as { lot: string | null; expiry: string | null; qty: number }[];
      if (rows.reduce((s, r) => s + r.qty, 0) + 1e-9 < qty) throw new ConflictException('not enough stock at the source location');
      let left = qty;
      for (const r of rows) {
        if (left <= 0) break;
        const take = Math.min(left, r.qty);
        for (const [loc, q] of [[from, -take], [to, take]] as const) {
          await c.query(`INSERT INTO ops.wh_movement (id, tenant_id, item_id, location_id, qty, lot, expiry, kind, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'move',$8)`,
            [randomUUID(), a.tenantId, item, loc, q, r.lot, r.expiry, a.userId]);
        }
        left = Math.round((left - take) * 100) / 100;
      }
      return { item_id: item, from_location_id: from, to_location_id: to, qty };
    });
  }

  /** A stock count at one location: the difference from the system balance is booked with the reason. */
  @Post('counts')
  @Perm('tasks:write')
  count(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const item = v.uuid(b?.item_id, 'item_id', { required: true })!;
    const loc = v.uuid(b?.location_id, 'location_id', { required: true })!;
    const counted = Number(b?.counted_qty);
    if (b?.counted_qty === undefined || !(counted === 0 || qtyOk(counted))) throw new BadRequestException('counted_qty must be 0 or more, 2 decimals');
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    const lot = v.str(b?.lot, 'lot', { max: 40 });
    const expiry = v.date(b?.expiry, 'expiry');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.wh_location WHERE id = $1', [loc])).rowCount) throw new BadRequestException('unknown location_id');
      if (!(await c.query('SELECT 1 FROM ops.wh_item WHERE id = $1', [item])).rowCount) throw new BadRequestException('unknown item_id');
      await this.lockItem(c, item);
      const system = Number((await c.query(
        `SELECT COALESCE(sum(qty), 0) AS q FROM ops.wh_movement WHERE item_id = $1 AND location_id = $2 AND lot IS NOT DISTINCT FROM $3`, [item, loc, lot])).rows[0].q);
      const diff = Math.round((counted - system) * 100) / 100;
      if (diff !== 0) {
        const exp = expiry ?? (await c.query(`SELECT max(expiry)::text AS e FROM ops.wh_movement WHERE item_id = $1 AND location_id = $2 AND lot IS NOT DISTINCT FROM $3`, [item, loc, lot])).rows[0].e;
        await c.query(`INSERT INTO ops.wh_movement (id, tenant_id, item_id, location_id, qty, lot, expiry, kind, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'count',$8,$9)`,
          [randomUUID(), a.tenantId, item, loc, diff, lot, exp, reason, a.userId]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.count_adjusted', targetType: 'wh_item', targetId: item, after: { location_id: loc, system, counted, diff, reason } });
      }
      return { item_id: item, location_id: loc, system, counted, diff };
    });
  }

  @Post('orders')
  @Perm('tasks:write')
  addOrder(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const wh = v.uuid(b?.warehouse_id, 'warehouse_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const r = ref(b?.ref);
    const lines = this.lines(b?.lines, false);
    const shipTo = b?.ship_to === undefined || b?.ship_to === null ? null : v.obj(b.ship_to, 'ship_to');
    if (shipTo) for (const [k, val] of Object.entries(shipTo)) if (typeof val !== 'string' || val.length > 120) throw new BadRequestException(`ship_to.${k} must be text`);
    const due = v.ts(b?.due_at, 'due_at');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.wh_warehouse WHERE id = $1 AND active', [wh])).rowCount) throw new BadRequestException('unknown warehouse_id');
      await this.checkItems(c, lines, customer);
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.wh_order (id, tenant_id, warehouse_id, customer_id, ref, lines, ship_to, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, a.tenantId, wh, customer, r, JSON.stringify(lines), shipTo && JSON.stringify(shipTo), due, a.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('an order with this reference exists in this warehouse');
        return pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.order_created', targetType: 'wh_order', targetId: id, after: { ref: r, lines: lines.length } });
      return this.orderOf(c, id);
    });
  }

  @Get('orders')
  @Perm('tasks:read')
  orders(@Auth() a: AuthContext, @Query('status') status?: string) {
    const s = v.str(status, 'status', { max: 20 });
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `${ORDER_SQL} WHERE ($1::text IS NULL OR o.status = $1 OR ($1 = 'active' AND o.status IN ('open','picked'))) ORDER BY o.created_at DESC LIMIT 300`, [s])).rows,
    }));
  }

  /** An order with its lines (SKU and name), the suggested pick plan while open, or the picks made. */
  @Get('orders/:id')
  @Perm('tasks:read')
  order(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, (c) => this.orderOf(c, id));
  }

  /** Picks the order: the first-expiry-first-out plan, all or nothing (409 with what is short). */
  @Post('orders/:id/pick')
  @HttpCode(200)
  @Perm('tasks:write')
  pick(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const o = (await c.query('SELECT id, warehouse_id, status, lines FROM ops.wh_order WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (o.status !== 'open') throw new ConflictException(`order is ${o.status}`);
      const items = [...new Set((o.lines as Line[]).map((l) => l.item_id))].sort();
      for (const it of items) await this.lockItem(c, it);
      const plan = await this.plan(c, o.warehouse_id, o.lines);
      if (plan.short.length) throw new ConflictException({ message: 'not enough stock', short: plan.short });
      for (const p of plan.picks) {
        await c.query(`INSERT INTO ops.wh_movement (id, tenant_id, item_id, location_id, qty, lot, expiry, kind, order_id, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'pick',$8,$9)`,
          [randomUUID(), a.tenantId, p.item_id, p.location_id, -p.qty, p.lot, p.expiry, id, a.userId]);
      }
      await c.query(`UPDATE ops.wh_order SET status = 'picked', picked_at = now() WHERE id = $1`, [id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.order_picked', targetType: 'wh_order', targetId: id, after: { picks: plan.picks.length } });
      return this.orderOf(c, id);
    });
  }

  /**
   * Ships a picked order. With `delivery: true` it becomes a delivery task for our fleet (needs the delivery or courier
   * pack, and a ship-to phone and area); otherwise the customer collects or a carrier takes it.
   */
  @Post('orders/:id/ship')
  @HttpCode(200)
  @Perm('tasks:write')
  ship(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    if (b?.delivery !== undefined && typeof b.delivery !== 'boolean') throw new BadRequestException('delivery must be true/false');
    return this.db.withTenant(a, async (c) => {
      const o = (await c.query(`${ORDER_SQL} WHERE o.id = $1 FOR UPDATE OF o`, [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (o.status !== 'picked') throw new ConflictException(`order is ${o.status}`);
      let task: string | null = null;
      if (b?.delivery === true) {
        if (!a.packs.includes('delivery') && !a.packs.includes('courier')) throw new ForbiddenException('pack_disabled');
        const to = (o.ship_to ?? {}) as Record<string, string>;
        if (!to.phone || !to.area) throw new BadRequestException('ship_to phone and area are needed for a delivery');
        const units = (o.lines as Line[]).reduce((s, l) => s + l.qty, 0);
        const t = await createTask(c, a, {
          le: o.legal_entity_id, pack: DELIVERY, branch: null, ref: `WH-${o.warehouse_code}-${o.ref}`.slice(0, 60), status: 'ready', customer: o.customer_id, site: null,
          win: o.due_at ? { from: new Date().toISOString(), to: new Date(Math.max(new Date(o.due_at).getTime(), Date.now() + 3_600_000)).toISOString() } : null,
          attrs: { recipient: { name: to.name, phone: to.phone }, dropoff: { area: to.area, block: to.block, street: to.street, house: to.house }, external_order_id: o.ref, items_count: Math.max(1, Math.min(1000, Math.round(units))) },
        });
        task = t.id;
      }
      await c.query(`UPDATE ops.wh_order SET status = 'shipped', shipped_at = now(), delivery_task_id = $2 WHERE id = $1`, [id, task]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.order_shipped', targetType: 'wh_order', targetId: id, after: { delivery_task_id: task } });
      return this.orderOf(c, id);
    });
  }

  /** Cancels an open or picked order; picked goods go back to the locations they came from. */
  @Post('orders/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:write')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const o = (await c.query('SELECT status FROM ops.wh_order WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (!['open', 'picked'].includes(o.status)) throw new ConflictException(`order is ${o.status}`);
      if (o.status === 'picked') {
        await c.query(
          `INSERT INTO ops.wh_movement (id, tenant_id, item_id, location_id, qty, lot, expiry, kind, order_id, reason, actor_id)
           SELECT gen_random_uuid(), tenant_id, item_id, location_id, -qty, lot, expiry, 'move', order_id, $2, $3 FROM ops.wh_movement WHERE order_id = $1 AND kind = 'pick'`,
          [id, `order canceled: ${reason}`.slice(0, 300), a.userId]);
      }
      await c.query(`UPDATE ops.wh_order SET status = 'canceled', cancel_reason = $2 WHERE id = $1`, [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'warehouse.order_canceled', targetType: 'wh_order', targetId: id, after: { reason } });
      return this.orderOf(c, id);
    });
  }

  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const today = kwToday();
      const low = (await c.query(
        `SELECT i.id, i.sku, i.name, i.unit, i.customer_id, cu.name AS customer_name, i.min_qty::float, COALESCE(s.q, 0)::float AS on_hand
           FROM ops.wh_item i LEFT JOIN crm.customer cu ON cu.id = i.customer_id
           LEFT JOIN (SELECT item_id, sum(qty) AS q FROM ops.wh_movement GROUP BY item_id) s ON s.item_id = i.id
          WHERE i.active AND i.min_qty IS NOT NULL AND COALESCE(s.q, 0) < i.min_qty ORDER BY i.sku LIMIT 300`)).rows;
      const expiring = (await c.query(
        `${STOCK_SQL} WHERE m.expiry IS NOT NULL AND m.expiry <= $1::date + $2::int ${STOCK_GROUP} ORDER BY m.expiry, i.sku LIMIT 300`, [today, EXPIRY_ALERT_DAYS])).rows
        .map((r) => ({ ...r, expired: r.expiry < today }));
      const late = (await c.query(
        `${ORDER_SQL} WHERE o.status IN ('open','picked') AND COALESCE(o.due_at, o.created_at + make_interval(hours => $1)) < now() ORDER BY COALESCE(o.due_at, o.created_at) LIMIT 300`,
        [ORDER_LATE_HOURS])).rows;
      const receipts = (await c.query(
        `SELECT r.id, r.ref, w.code AS warehouse_code, cu.name AS customer_name, r.received_at, r.expected,
                (SELECT json_agg(json_build_object('item_id', m.item_id, 'qty', m.qty::float)) FROM ops.wh_movement m WHERE m.receipt_id = r.id) AS lines
           FROM ops.wh_receipt r JOIN ops.wh_warehouse w ON w.id = r.warehouse_id LEFT JOIN crm.customer cu ON cu.id = r.customer_id
          WHERE r.expected IS NOT NULL AND r.received_at > now() - interval '7 days' ORDER BY r.received_at DESC LIMIT 300`)).rows;
      const skus = new Map<string, string>((await c.query('SELECT id, sku FROM ops.wh_item')).rows.map((x) => [x.id, x.sku]));
      const variance = receipts.map(({ expected, lines, ...r }) => ({ ...r, variance: receiptVariance(expected, lines ?? []).map((x) => ({ ...x, sku: skus.get(x.item_id) })) }))
        .filter((r) => r.variance.length);
      return { low, expiring, late, variance };
    });
  }

  /** Activity per owner for a period (Kuwait dates), with the stock on hand now. */
  @Get('report')
  @Perm('reports:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `WITH mv AS (
           SELECT i.customer_id, m.kind, m.qty, m.order_id, m.receipt_id FROM ops.wh_movement m JOIN ops.wh_item i ON i.id = m.item_id
            WHERE (m.occurred_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $1 AND $2
         ), act AS (
           SELECT customer_id, count(DISTINCT receipt_id) FILTER (WHERE kind = 'receipt')::int AS receipts,
                  COALESCE(sum(qty) FILTER (WHERE kind = 'receipt'), 0)::float AS units_in,
                  COALESCE(-sum(qty) FILTER (WHERE kind = 'pick'), 0)::float AS units_picked,
                  COALESCE(sum(qty) FILTER (WHERE kind = 'count'), 0)::float AS count_diff
             FROM mv GROUP BY customer_id
         ), ord AS (
           SELECT o.customer_id, count(*)::int AS orders_shipped,
                  count(*) FILTER (WHERE o.due_at IS NOT NULL)::int AS with_due, count(*) FILTER (WHERE o.due_at IS NOT NULL AND o.shipped_at <= o.due_at)::int AS on_time,
                  avg(extract(epoch FROM o.shipped_at - o.created_at) / 3600)::float AS avg_hours
             FROM ops.wh_order o WHERE o.status = 'shipped' AND (o.shipped_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $1 AND $2 GROUP BY o.customer_id
         ), stock AS (
           SELECT i.customer_id, sum(m.qty)::float AS on_hand
             FROM ops.wh_movement m JOIN ops.wh_item i ON i.id = m.item_id
            GROUP BY i.customer_id
         ), occ AS (
           SELECT customer_id, count(*)::int AS locations FROM (
             SELECT i.customer_id, m.location_id FROM ops.wh_movement m JOIN ops.wh_item i ON i.id = m.item_id GROUP BY i.customer_id, m.location_id, m.item_id HAVING sum(m.qty) > 0
           ) x GROUP BY customer_id
         ), keys AS (SELECT customer_id FROM act UNION SELECT customer_id FROM ord UNION SELECT customer_id FROM stock WHERE on_hand > 0)
         SELECT k.customer_id, cu.name AS customer_name, COALESCE(act.receipts, 0) AS receipts, COALESCE(act.units_in, 0) AS units_in, COALESCE(act.units_picked, 0) AS units_picked,
                COALESCE(act.count_diff, 0) AS count_diff, COALESCE(ord.orders_shipped, 0) AS orders_shipped, ord.with_due, ord.on_time, ord.avg_hours,
                COALESCE(stock.on_hand, 0) AS on_hand, COALESCE(occ.locations, 0) AS locations
           FROM keys k LEFT JOIN crm.customer cu ON cu.id = k.customer_id LEFT JOIN act ON act.customer_id IS NOT DISTINCT FROM k.customer_id
           LEFT JOIN ord ON ord.customer_id IS NOT DISTINCT FROM k.customer_id LEFT JOIN stock ON stock.customer_id IS NOT DISTINCT FROM k.customer_id
           LEFT JOIN occ ON occ.customer_id IS NOT DISTINCT FROM k.customer_id
          ORDER BY cu.name NULLS FIRST`, [f, t])).rows;
      const pct = (x: number, y: number) => (y ? Math.round((x / y) * 1000) / 10 : null);
      const data = rows.map(({ with_due, on_time, avg_hours, ...r }) => ({ ...r, on_time_pct: pct(on_time ?? 0, with_due ?? 0), avg_hours_to_ship: avg_hours === null ? null : Math.round(avg_hours * 10) / 10 }));
      const sum = (k: 'receipts' | 'units_in' | 'units_picked' | 'orders_shipped' | 'on_hand' | 'locations') => Math.round(data.reduce((s, r) => s + Number(r[k]), 0) * 100) / 100;
      return { from: f, to: t, data, totals: { receipts: sum('receipts'), units_in: sum('units_in'), units_picked: sum('units_picked'), orders_shipped: sum('orders_shipped'), on_hand: sum('on_hand'), locations: sum('locations') } };
    });
  }

  // helpers

  private lines(val: unknown, receipt: boolean) {
    if (!Array.isArray(val) || val.length === 0 || val.length > 200) throw new BadRequestException('lines: 1-200 lines');
    return val.map((l, i) => {
      if (!l || typeof l !== 'object') throw new BadRequestException(`lines[${i}] must be an object`);
      const o = l as Record<string, unknown>;
      const item_id = v.uuid(o.item_id, `lines[${i}].item_id`, { required: true })!;
      if (!qtyOk(o.qty)) throw new BadRequestException(`lines[${i}].qty must be more than 0, 2 decimals`);
      if (!receipt) return { item_id, qty: o.qty as number };
      return { item_id, qty: o.qty as number, location_id: v.uuid(o.location_id, `lines[${i}].location_id`, { required: true })!,
        lot: v.str(o.lot, `lines[${i}].lot`, { max: 40 }), expiry: v.date(o.expiry, `lines[${i}].expiry`) };
    });
  }

  /** Every item exists, is active and belongs to the owner of the document. */
  private async checkItems(c: PoolClient, lines: Line[], customer: string | null) {
    const ids = [...new Set(lines.map((l) => l.item_id))];
    const rows = (await c.query('SELECT id, customer_id, active FROM ops.wh_item WHERE id = ANY($1::uuid[])', [ids])).rows;
    if (rows.length !== ids.length || rows.some((r) => !r.active)) throw new BadRequestException('unknown or inactive item');
    if (rows.some((r) => r.customer_id !== customer)) throw new BadRequestException('an item belongs to another owner');
  }

  /** Serialises stock changes for one item so two pickers cannot take the same units. */
  private async lockItem(c: PoolClient, item: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8))', [item]);
  }

  private async plan(c: PoolClient, warehouse: string, lines: Line[]) {
    const stock = (await c.query(
      `${STOCK_SQL} WHERE l.warehouse_id = $1 AND m.item_id = ANY($2::uuid[]) AND l.active ${STOCK_GROUP}`, [warehouse, [...new Set(lines.map((l) => l.item_id))]])).rows as StockRow[];
    return allocate(lines, stock, kwToday());
  }

  private async orderOf(c: PoolClient, id: string) {
    const o = (await c.query(`${ORDER_SQL} WHERE o.id = $1`, [id])).rows[0];
    if (!o) throw new NotFoundException();
    const items = new Map<string, { sku: string; name: string; unit: string }>((await c.query(
      'SELECT id, sku, name, unit FROM ops.wh_item WHERE id = ANY($1::uuid[])', [(o.lines as Line[]).map((l) => l.item_id)])).rows.map((r) => [r.id, r]));
    const lines = (o.lines as Line[]).map((l) => ({ ...l, ...items.get(l.item_id) }));
    let plan: { picks: Pick[]; short: { item_id: string; qty: number }[] } | null = null;
    let picks: Record<string, unknown>[] = [];
    if (o.status === 'open') plan = await this.plan(c, o.warehouse_id, o.lines);
    else {
      picks = (await c.query(
        `SELECT m.item_id, i.sku, l.code AS location_code, m.lot, m.expiry::text AS expiry, (-m.qty)::float AS qty FROM ops.wh_movement m
           JOIN ops.wh_item i ON i.id = m.item_id JOIN ops.wh_location l ON l.id = m.location_id WHERE m.order_id = $1 AND m.kind = 'pick' ORDER BY l.code`, [id])).rows.map((r) => num(r, 'qty'));
    }
    return { ...o, lines, plan, picks };
  }
}
