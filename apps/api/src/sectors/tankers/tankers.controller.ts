import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { normalizeAttributes } from '../delivery/delivery';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { amount, CLASSES, classOf, loss, orderState, Product, PRODUCTS, SHORT_PCT, Stage, TANKERS, WINDOW_MIN } from './tankers';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const KW = `AT TIME ZONE 'Asia/Kuwait'`;

const ORDER_SQL = `
  SELECT o.id, o.ref, o.legal_entity_id, o.customer_id, cu.name AS customer_name, cu.phone AS customer_phone, o.site, o.product, o.qty_l, lower(o.wanted) AS wanted_from, upper(o.wanted) AS wanted_to,
         o.unit_price::text, o.schedule_id, o.task_id, o.attempts, o.source, o.loaded_l, o.loaded_at, o.delivered_l, o.delivered_at, o.received_by, o.notes, o.canceled_at, o.cancel_reason,
         o.created_at, o.version, t.status AS task_status, asg.worker_id AS driver_id, w.display_name AS driver_name, asg.asset_id, fa.plate_no
    FROM ops.tnk_order o JOIN crm.customer cu ON cu.id = o.customer_id
    LEFT JOIN ops.task t ON t.id = o.task_id
    LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id`;

type Row = Record<string, unknown> & { product: Product; qty_l: number; loaded_l: number | null; delivered_l: number | null; unit_price: string | null; canceled_at: unknown; delivered_at: unknown; task_status: string | null };
const shape = <T extends Row>(o: T) => {
  const lo = loss(o.product, o.loaded_l, o.delivered_l);
  return { ...o, state: orderState(o, o.task_status), loss_l: lo?.litres ?? null, loss_pct: lo?.pct ?? null, loss_flag: lo?.flagged ?? false,
    short: o.delivered_l !== null && o.delivered_l < o.qty_l * (1 - SHORT_PCT / 100), amount: amount(o.unit_price, o.delivered_l) };
};

const siteLine = (s: Record<string, unknown>) =>
  [s.name, s.area, s.block ? `ق ${s.block}` : null, s.street, s.house ? `منزل ${s.house}` : null].filter((x) => typeof x === 'string' && x).join('، ') || null;

function parseSite(val: unknown) {
  const raw = v.obj(val, 'site') ?? (() => { throw new BadRequestException('site required'); })();
  const site = normalizeAttributes({ dropoff: raw })!.dropoff as Record<string, unknown>;
  if (!site.area && !site.name) throw new BadRequestException('site needs an area or a name');
  return site;
}
const litres = (val: unknown, field: string, required = false) => {
  const n = v.int(val, field, 100, 60000);
  if (required && n === null) throw new BadRequestException(`${field} required`);
  return n;
};

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

/**
 * Filling and discharging from the driver's app. Filling needs the litres (not above the tanker's capacity) and takes the
 * source; discharging needs the litres (not above what was filled) and the receiver. Returns a reject code.
 */
export async function tankerStage(c: PoolClient, taskId: string, code: Stage, x: { at: Date; litres: number | null; receivedBy: string | null; note: string | null }): Promise<string | null> {
  const o = (await c.query(`SELECT o.id, o.loaded_l, tv.capacity_l FROM ops.tnk_order o
                              LEFT JOIN LATERAL (SELECT a.asset_id FROM ops.assignment a WHERE a.task_id = o.task_id AND a.active LIMIT 1) asg ON true
                              LEFT JOIN ops.tnk_vehicle tv ON tv.asset_id = asg.asset_id
                             WHERE o.task_id = $1 FOR UPDATE OF o`, [taskId])).rows[0];
  if (!o) return 'not_supported';
  if (x.litres === null) return 'litres_required';
  if (code === 'tank_filled') {
    if (o.capacity_l && x.litres > o.capacity_l) return 'over_capacity';
    await c.query('UPDATE ops.tnk_order SET loaded_l = $2, loaded_at = $3, source = COALESCE($4, source), version = version + 1 WHERE id = $1', [o.id, x.litres, x.at.toISOString(), x.note]);
    return null;
  }
  if (o.loaded_l !== null && x.litres > o.loaded_l) return 'more_than_loaded';
  if (!x.receivedBy) return 'receiver_required';
  await c.query('UPDATE ops.tnk_order SET delivered_l = $2, delivered_at = $3, received_by = $4, version = version + 1 WHERE id = $1', [o.id, x.litres, x.at.toISOString(), x.receivedBy]);
  return null;
}

@Controller('v1/tankers')
@UseGuards(AuthGuard)
@Pack('tankers')
export class TankersController {
  constructor(private readonly db: DbService) {}

  // ---- tankers ----

  @Get('vehicles')
  @Perm('tasks:read')
  vehicles(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT fa.id AS asset_id, fa.plate_no, fa.asset_type, fa.status, tv.product_class, tv.capacity_l FROM fleet.asset fa LEFT JOIN ops.tnk_vehicle tv ON tv.asset_id = fa.id
                             WHERE fa.status <> 'retired' ORDER BY tv.capacity_l IS NULL, fa.plate_no`)).rows,
    }));
  }

  /** Registers a vehicle as a water or fuel tanker with its capacity. */
  @Put('vehicles/:assetId')
  @Perm('fleet:write')
  setVehicle(@Auth() a: AuthContext, @Param('assetId', new ParseUUIDPipe()) assetId: string, @Body() b: Record<string, unknown>) {
    const cls = v.oneOf(b?.product_class, 'product_class', CLASSES, { required: true })!;
    const cap = v.int(b?.capacity_l, 'capacity_l', 500, 60000) ?? (() => { throw new BadRequestException('capacity_l required'); })();
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1', [assetId])).rowCount) throw new NotFoundException();
      await c.query(`INSERT INTO ops.tnk_vehicle (asset_id, tenant_id, product_class, capacity_l) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (asset_id) DO UPDATE SET product_class = EXCLUDED.product_class, capacity_l = EXCLUDED.capacity_l`, [assetId, a.tenantId, cls, cap]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tankers.vehicle_set', targetType: 'asset', targetId: assetId, after: { cls, cap } });
      return { asset_id: assetId, product_class: cls, capacity_l: cap };
    });
  }

  // ---- orders ----

  @Get('orders')
  @Perm('tasks:read')
  orders(@Auth() a: AuthContext, @Query('date') date?: string, @Query('state') state?: string) {
    const day = v.date(date, 'date');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${ORDER_SQL} WHERE ($1::date IS NULL OR (lower(o.wanted) ${KW})::date = $1) ORDER BY lower(o.wanted) DESC LIMIT 500`, [day])).rows.map(shape);
      return { data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** An order: the product and litres to the customer's site within a window (default two hours from `from`). */
  @Post('orders')
  @Perm('tasks:assign')
  addOrder(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const site = parseSite(b?.site);
    const product = v.oneOf(b?.product, 'product', PRODUCTS, { required: true })!;
    const qty = litres(b?.qty_l, 'qty_l', true)!;
    const from = v.ts(b?.from, 'from') ?? new Date();
    const to = v.ts(b?.to, 'to') ?? new Date(from.getTime() + WINDOW_MIN * 60_000);
    if (to <= from) throw new BadRequestException('to must be after from');
    const price = v.money(b?.unit_price, 'unit_price');
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const id = await this.insertOrder(c, a, { le, customer, site, product, qty, from, to, price, notes, schedule: null, day: null });
      return this.order(c, id);
    });
  }

  @Get('orders/:id')
  @Perm('tasks:read')
  getOrder(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.order(c, id));
  }

  /** Books a tanker (registered for the product's class, big enough) and its driver for the order's window. Again after a failed trip. */
  @Post('orders/:id/assign')
  @Perm('tasks:assign')
  assign(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const driver = v.uuid(b?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    return this.db.withTenant(a, async (c) => {
      const o = await this.order(c, id, true);
      if (!['new', 'failed'].includes(o.state)) throw new ConflictException(`the order is ${o.state}`);
      const tv = (await c.query(`SELECT tv.product_class, tv.capacity_l FROM ops.tnk_vehicle tv JOIN fleet.asset fa ON fa.id = tv.asset_id
                                  WHERE tv.asset_id = $1 AND fa.legal_entity_id = $2 AND fa.status NOT IN ('out_of_service','retired')`, [asset, o.legal_entity_id])).rows[0];
      if (!tv) throw new BadRequestException('not_a_tanker: register the vehicle as a tanker first');
      if (tv.product_class !== classOf(o.product)) throw new ConflictException(`wrong_tanker: a ${tv.product_class} tanker cannot carry ${o.product}`);
      if (tv.capacity_l < o.qty_l) throw new ConflictException(`too_small: the tanker holds ${tv.capacity_l} L`);
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [driver, o.legal_entity_id])).rowCount) throw new BadRequestException('unknown driver_worker_id');
      // the failed trip's booking is released before the new one
      if (o.task_id) await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [o.task_id]);
      const n = o.attempts + 1;
      const task = await createTask(c, a, {
        le: o.legal_entity_id, pack: TANKERS, branch: null, status: 'ready', customer: o.customer_id, site: null, ref: `${o.ref}-${n}`,
        win: { from: new Date(o.wanted_from).toISOString(), to: new Date(o.wanted_to).toISOString() },
        attrs: { kind: 'tank', order_id: id, order_ref: o.ref, product: o.product, qty_l: o.qty_l, capacity_l: tv.capacity_l, dropoff: o.site, address: siteLine(o.site),
          customer_name: o.customer_name, contact_phone: (o.site as Record<string, unknown>).phone ?? o.customer_phone, notes: o.notes },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, driver, asset, new Date(o.wanted_from).toISOString(), new Date(o.wanted_to).toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('driver_booked: the driver has another booking then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the tanker is booked then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${o.qty_l} L ${o.product} for ${o.ref}`);
      await c.query('UPDATE ops.tnk_order SET task_id = $2, attempts = $3, loaded_l = NULL, loaded_at = NULL, version = version + 1 WHERE id = $1', [id, task.id, n]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tankers.assigned', targetType: 'tnk_order', targetId: id, after: { task: task.id, driver, asset, attempt: n } });
      return this.order(c, id);
    });
  }

  /** The office records a delivery from the paper ticket (a driver without the app); the trip task completes. */
  @Post('orders/:id/record')
  @HttpCode(200)
  @Perm('tasks:assign')
  record(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const delivered = v.int(b?.delivered_l, 'delivered_l', 0, 60000) ?? (() => { throw new BadRequestException('delivered_l required'); })();
    const loaded = v.int(b?.loaded_l, 'loaded_l', 0, 60000);
    if (loaded !== null && delivered > loaded) throw new BadRequestException('delivered_l is more than loaded_l');
    const who = v.str(b?.received_by, 'received_by', { required: true, max: 120 })!;
    return this.db.withTenant(a, async (c) => {
      const o = await this.order(c, id, true);
      if (!['assigned', 'on_way'].includes(o.state)) throw new ConflictException(`the order is ${o.state}`);
      await c.query('UPDATE ops.tnk_order SET loaded_l = COALESCE($2, loaded_l), loaded_at = COALESCE(loaded_at, now()), delivered_l = $3, delivered_at = now(), received_by = $4, version = version + 1 WHERE id = $1',
        [id, loaded, delivered, who]);
      await c.query(`UPDATE ops.task SET status = 'completed', version = version + 1, updated_at = now() WHERE id = $1`, [o.task_id]);
      await event(c, a, o.task_id, o.task_status, 'completed', 'delivery recorded by the office');
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tankers.recorded', targetType: 'tnk_order', targetId: id, after: { loaded, delivered, who } });
      return this.order(c, id);
    });
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const o = await this.order(c, id, true);
      if (o.state === 'canceled') return o;
      if (['on_way', 'delivered'].includes(o.state)) throw new ConflictException(`the order is ${o.state}`);
      if (o.state === 'assigned') {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [o.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [o.task_id]);
        await event(c, a, o.task_id, o.task_status, 'canceled', `order canceled: ${reason}`);
      }
      await c.query('UPDATE ops.tnk_order SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tankers.canceled', targetType: 'tnk_order', targetId: id, after: { reason } });
      return this.order(c, id);
    });
  }

  // ---- standing orders ----

  @Get('schedules')
  @Perm('tasks:read')
  schedules(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT s.id, s.customer_id, cu.name AS customer_name, s.site, s.product, s.qty_l, s.days, to_char(s.at_time, 'HH24:MI') AS at_time, s.window_min, s.unit_price::text, s.active,
                                   (SELECT count(*)::int FROM ops.tnk_order o WHERE o.schedule_id = s.id) AS orders
                              FROM ops.tnk_schedule s JOIN crm.customer cu ON cu.id = s.customer_id ORDER BY s.active DESC, cu.name`)).rows,
    }));
  }

  /** A standing order: litres of a product on given weekdays (0 Sunday … 6 Saturday) at a time. */
  @Post('schedules')
  @Perm('tasks:assign')
  addSchedule(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const site = parseSite(b?.site);
    const product = v.oneOf(b?.product, 'product', PRODUCTS, { required: true })!;
    const qty = litres(b?.qty_l, 'qty_l', true)!;
    const days = b?.days;
    if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException('days must be a list of weekdays 0-6');
    const at = v.str(b?.at_time, 'at_time', { required: true, max: 5 })!;
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(at)) throw new BadRequestException('at_time must be HH:MM');
    const win = v.int(b?.window_min, 'window_min', 30, 720) ?? WINDOW_MIN;
    const price = v.money(b?.unit_price, 'unit_price');
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT legal_entity_id FROM crm.customer WHERE id = $1', [customer])).rows[0];
      if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
      const id = randomUUID();
      await c.query(`INSERT INTO ops.tnk_schedule (id, tenant_id, legal_entity_id, customer_id, site, product, qty_l, days, at_time, window_min, unit_price, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, a.tenantId, le, customer, JSON.stringify(site), product, qty, [...new Set(days)].sort(), at, win, price, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tankers.schedule_added', targetType: 'tnk_schedule', targetId: id, after: { customer, product, qty, days, at } });
      return { id, active: true };
    });
  }

  @Post('schedules/:id/stop')
  @HttpCode(200)
  @Perm('tasks:assign')
  stop(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const r = await c.query('UPDATE ops.tnk_schedule SET active = false WHERE id = $1 RETURNING id, active', [id]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tankers.schedule_stopped', targetType: 'tnk_schedule', targetId: id });
      return r.rows[0];
    });
  }

  /** Creates a date's orders from the standing orders for its weekday (once per standing order and date). */
  @Post('schedules/generate')
  @HttpCode(200)
  @Perm('tasks:assign')
  generate(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const day = v.date(b?.date, 'date') ?? kwToday();
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    return this.db.withTenant(a, async (c) => {
      const list = (await c.query(`SELECT s.*, to_char(s.at_time, 'HH24:MI') AS hhmm, s.unit_price::text AS price FROM ops.tnk_schedule s
                                    WHERE s.active AND $1::smallint = ANY (s.days) AND NOT EXISTS (SELECT 1 FROM ops.tnk_order o WHERE o.schedule_id = s.id AND o.sched_day = $2)`, [dow, day])).rows;
      const created: string[] = [];
      for (const s of list) {
        const from = new Date(`${day}T${s.hhmm}:00+03:00`);
        const id = await this.insertOrder(c, a, { le: s.legal_entity_id, customer: s.customer_id, site: s.site, product: s.product, qty: s.qty_l, from, to: new Date(from.getTime() + s.window_min * 60_000),
          price: s.price, notes: null, schedule: s.id, day });
        created.push((await c.query('SELECT ref FROM ops.tnk_order WHERE id = $1', [id])).rows[0].ref);
      }
      return { date: day, created };
    });
  }

  // ---- the day, watch and report ----

  /** A day's orders by tanker, and those without one. */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${ORDER_SQL} WHERE (lower(o.wanted) ${KW})::date = $1 AND o.canceled_at IS NULL ORDER BY lower(o.wanted)`, [day])).rows.map(shape);
      return { date: day, orders: rows };
    });
  }

  /** Orders without a tanker today or tomorrow, late, failed, short deliveries and losses above the allowance (last 7 days). */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${ORDER_SQL} WHERE o.canceled_at IS NULL AND lower(o.wanted) BETWEEN now() - interval '7 days' AND now() + interval '2 days' ORDER BY lower(o.wanted)`)).rows.map(shape);
      const now = Date.now();
      return {
        unassigned: rows.filter((o) => o.state === 'new'),
        late: rows.filter((o) => ['assigned', 'on_way'].includes(o.state) && Date.parse(o.wanted_to as string) < now),
        failed: rows.filter((o) => o.state === 'failed'),
        short: rows.filter((o) => o.short),
        losses: rows.filter((o) => o.loss_flag),
      };
    });
  }

  /** For a period: litres ordered and delivered by product, trips, losses, the amount; and per tanker. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${ORDER_SQL} WHERE (lower(o.wanted) ${KW})::date BETWEEN $1 AND $2 AND o.canceled_at IS NULL`, [f, t])).rows.map(shape);
      const done = rows.filter((o) => o.delivered_l !== null);
      const fils = (s: string | null) => Math.round(Number(s ?? 0) * 1000);
      const by = <K extends string>(key: (o: (typeof rows)[number]) => K | null) => {
        const m = new Map<K, typeof rows>();
        for (const o of rows) { const k = key(o); if (k) m.set(k, [...(m.get(k) ?? []), o]); }
        return m;
      };
      const sum = (l: typeof rows, f: (o: (typeof rows)[number]) => number | null) => l.reduce((s, o) => s + (f(o) ?? 0), 0);
      return {
        from: f, to: t,
        totals: { orders: rows.length, delivered: done.length, failed: rows.filter((o) => o.state === 'failed').length, ordered_l: sum(rows, (o) => o.qty_l), delivered_l: sum(done, (o) => o.delivered_l),
          loss_l: sum(done, (o) => o.loss_l), amount: (done.reduce((s, o) => s + fils(o.amount), 0) / 1000).toFixed(3) },
        products: [...by((o) => o.product).entries()].map(([product, l]) => ({ product, orders: l.length, ordered_l: sum(l, (o) => o.qty_l), delivered_l: sum(l, (o) => o.delivered_l), loss_l: sum(l, (o) => o.loss_l),
          amount: (l.reduce((s, o) => s + fils(o.amount), 0) / 1000).toFixed(3) })),
        tankers: [...by((o) => (o.plate_no as string | null)).entries()].map(([plate_no, l]) => ({ plate_no, trips: l.filter((o) => o.delivered_l !== null).length, delivered_l: sum(l, (o) => o.delivered_l),
          loss_l: sum(l, (o) => o.loss_l) })).sort((x, y) => y.delivered_l - x.delivered_l),
      };
    });
  }

  private async insertOrder(c: PoolClient, a: AuthContext, x: { le: string; customer: string; site: Record<string, unknown>; product: string; qty: number; from: Date; to: Date; price: string | null;
    notes: string | null; schedule: string | null; day: string | null }) {
    const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [x.customer])).rows[0];
    if (!cu || cu.legal_entity_id !== x.le) throw new BadRequestException('unknown customer_id');
    if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
    const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.tnk_order`)).rows[0].n;
    const id = randomUUID(), ref = `TK-${n}`;
    await c.query(`INSERT INTO ops.tnk_order (id, tenant_id, legal_entity_id, ref, customer_id, site, product, qty_l, wanted, unit_price, schedule_id, sched_day, notes, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,tstzrange($9,$10),$11,$12,$13,$14,$15)`,
      [id, a.tenantId, x.le, ref, x.customer, JSON.stringify(x.site), x.product, x.qty, x.from.toISOString(), x.to.toISOString(), x.price, x.schedule, x.day, x.notes, a.userId]);
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tankers.order_added', targetType: 'tnk_order', targetId: id, after: { ref, customer: x.customer, product: x.product, qty: x.qty, schedule: x.schedule } });
    return id;
  }

  private async order(c: PoolClient, id: string, lock = false) {
    const o = (await c.query(`${ORDER_SQL} WHERE o.id = $1${lock ? ' FOR UPDATE OF o' : ''}`, [id])).rows[0];
    if (!o) throw new NotFoundException();
    return shape(o);
  }
}
