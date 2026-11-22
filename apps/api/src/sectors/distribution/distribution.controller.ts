import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm, Pack } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { amount, celsius, checkDelivered, DISTRIBUTION, FAIL_REASONS, fils, inRange, Item, kwd, loadList, Qty, qty, qtyMap, reconcile, SKU, TEMP_CLASSES, TEMP_DEFAULTS, UNITS, valueFils } from './distribution';

const ROUTE_SQL = `
  SELECT r.id, r.ref, r.legal_entity_id, r.route_date::text AS route_date, r.task_id, r.asset_id, a.plate_no, r.driver_worker_id, w.display_name AS driver_name,
         r.status, t.status AS task_status, r.notes, r.loaded_at, r.out_at, r.back_at, r.start_odometer_km, r.end_odometer_km,
         (r.end_odometer_km - r.start_odometer_km) AS km, r.cash_received::text, r.settled_at, r.settle_note, r.cancel_reason, r.version,
         r.temp_class, r.temp_min::float, r.temp_max::float,
         (SELECT jsonb_build_object('reading_c', x.reading_c::float, 'recorded_at', x.recorded_at, 'in_range', x.in_range) FROM ops.temp_reading x WHERE x.route_id = r.id ORDER BY x.recorded_at DESC LIMIT 1) AS last_reading,
         lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
         (SELECT count(*)::int FROM ops.dist_stop s WHERE s.route_id = r.id) AS stops,
         (SELECT count(*)::int FROM ops.dist_stop s WHERE s.route_id = r.id AND s.done_at IS NOT NULL) AS stops_done,
         (SELECT count(*)::int FROM ops.dist_stop s WHERE s.route_id = r.id AND s.closed_reason IS NOT NULL) AS stops_failed,
         (SELECT coalesce(sum(s.cash_due), 0)::text FROM ops.dist_stop s WHERE s.route_id = r.id) AS cash_due,
         (SELECT coalesce(sum(s.cash_collected), 0)::text FROM ops.dist_stop s WHERE s.route_id = r.id) AS cash_collected
    FROM ops.dist_route r JOIN ops.task t ON t.id = r.task_id
    JOIN fleet.asset a ON a.id = r.asset_id JOIN workforce.worker w ON w.id = r.driver_worker_id`;
const STOP_SQL = `
  SELECT s.task_id, s.route_id, s.seq, s.customer_id, s.name, s.payment, s.items, s.delivered, s.returned, s.cash_due::text, s.cash_collected::text,
         s.received_by, s.closed_reason, s.done_at, s.window_from, s.window_to, s.damaged, t.status, t.attributes->>'address' AS address, t.attributes->'dropoff' AS dropoff
    FROM ops.dist_stop s JOIN ops.task t ON t.id = s.task_id`;

const version = (b: Record<string, unknown>) => v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
const hm = (x: unknown, f: string, d: string) => {
  if (x === undefined || x === null || x === '') return d;
  if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new BadRequestException(`${f} must be HH:MM`);
  return x;
};

interface StopIn { window_from: string | null; window_to: string | null; name: string; customer_id: string | null; address: string | null; phone: string | null; lat: number | null; lng: number | null; payment: 'cash' | 'credit'; items: { sku: string; qty: number; price?: string; name?: string; expiry?: string }[] }

@Controller('v1/distribution')
@UseGuards(AuthGuard)
@Pack('distribution', 'coldchain')
export class DistributionController {
  constructor(private readonly db: DbService) {}

  // ---- products ----

  @Get('products')
  @Perm('tasks:read')
  products(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query('SELECT id, legal_entity_id, sku, name, unit, price::text, active FROM ops.dist_product ORDER BY active DESC, sku')).rows,
    }));
  }

  @Post('products')
  @Perm('tasks:write')
  addProduct(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const sku = v.str(b?.sku, 'sku', { required: true, max: 40 })!;
    if (!SKU.test(sku)) throw new BadRequestException('sku: letters, digits, _ . - (up to 40)');
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!;
    const unit = v.oneOf(b?.unit, 'unit', UNITS) ?? 'piece';
    const price = b?.price === undefined ? '0' : amount(b.price, 'price');
    return this.db.withTenant(a, async (c) => {
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.dist_product (id, tenant_id, legal_entity_id, sku, name, unit, price) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, a.tenantId, le, sku, name, unit, price]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('a product with this sku exists');
        return pgToHttp(e);
      }
      return (await c.query('SELECT id, legal_entity_id, sku, name, unit, price::text, active FROM ops.dist_product WHERE id = $1', [id])).rows[0];
    });
  }

  @Patch('products/:id')
  @Perm('tasks:write')
  updateProduct(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { max: 120 });
    const price = b?.price === undefined ? null : amount(b.price, 'price');
    const active = typeof b?.active === 'boolean' ? b.active : null;
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query(`UPDATE ops.dist_product SET name = COALESCE($2, name), price = COALESCE($3::numeric, price), active = COALESCE($4, active) WHERE id = $1
          RETURNING id, legal_entity_id, sku, name, unit, price::text, active`, [id, name, price, active])).rows[0];
      if (!r) throw new NotFoundException();
      return r;
    });
  }

  // ---- routes ----

  /** Plans a day's route: the vehicle and driver are booked for the day window, each stop becomes a task in order. */
  @Post('routes')
  @Perm('tasks:assign')
  createRoute(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const day = v.date(b?.route_date, 'route_date') ?? (() => { throw new BadRequestException('route_date required'); })();
    const assetId = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const driverId = v.uuid(b?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const start = hm(b?.start_time, 'start_time', '06:00'), end = hm(b?.end_time, 'end_time', '18:00');
    if (end <= start) throw new BadRequestException('end_time must be after start_time');
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    const tempClass = v.oneOf(b?.temp_class, 'temp_class', TEMP_CLASSES) ?? 'ambient';
    const def = TEMP_DEFAULTS[tempClass];
    const tMin = b?.temp_min === undefined || b?.temp_min === null ? def?.[0] ?? null : celsius(b.temp_min, 'temp_min');
    const tMax = b?.temp_max === undefined || b?.temp_max === null ? def?.[1] ?? null : celsius(b.temp_max, 'temp_max');
    if (tMin !== null && tMax !== null && tMin > tMax) throw new BadRequestException('temp_min must not be above temp_max');
    if ((tMin === null) !== (tMax === null)) throw new BadRequestException('send both temp_min and temp_max');
    if (!Array.isArray(b?.stops) || b.stops.length === 0 || b.stops.length > 200) throw new BadRequestException('stops must be a list of 1-200');
    const stops: StopIn[] = (b.stops as Record<string, unknown>[]).map((s, i) => {
      if (!s || typeof s !== 'object') throw new BadRequestException(`stops[${i}] invalid`);
      if (!Array.isArray(s.items) || s.items.length === 0 || s.items.length > 100) throw new BadRequestException(`stops[${i}].items must be a list of 1-100`);
      const lat = s.lat === undefined || s.lat === null ? null : Number(s.lat), lng = s.lng === undefined || s.lng === null ? null : Number(s.lng);
      if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) throw new BadRequestException(`stops[${i}] lat/lng invalid`);
      const seen = new Set<string>();
      const wf = s.window_from === undefined || s.window_from === null || s.window_from === '' ? null : hm(s.window_from, `stops[${i}].window_from`, '');
      const wt = s.window_to === undefined || s.window_to === null || s.window_to === '' ? null : hm(s.window_to, `stops[${i}].window_to`, '');
      if (wf && wt && wt <= wf) throw new BadRequestException(`stops[${i}]: window_to must be after window_from`);
      return {
        window_from: wf, window_to: wt,
        name: v.str(s.name, `stops[${i}].name`, { required: true, max: 120 })!,
        customer_id: v.uuid(s.customer_id, `stops[${i}].customer_id`),
        address: v.str(s.address, `stops[${i}].address`, { max: 300 }),
        phone: v.str(s.phone, `stops[${i}].phone`, { max: 30 }),
        lat, lng,
        payment: v.oneOf(s.payment, `stops[${i}].payment`, ['cash', 'credit'] as const) ?? 'credit',
        items: (s.items as Record<string, unknown>[]).map((it, j) => {
          const sku = v.str(it?.sku, `stops[${i}].items[${j}].sku`, { required: true, max: 40 })!;
          if (!SKU.test(sku)) throw new BadRequestException(`stops[${i}].items[${j}].sku invalid`);
          if (seen.has(sku)) throw new BadRequestException(`stops[${i}]: ${sku} listed twice`);
          seen.add(sku);
          return { sku, qty: qty(it.qty, `stops[${i}].items[${j}].qty`), price: it.price === undefined ? undefined : amount(it.price, `stops[${i}].items[${j}].price`),
            name: v.str(it.name, `stops[${i}].items[${j}].name`, { max: 120 }) ?? undefined, expiry: v.date(it.expiry, `stops[${i}].items[${j}].expiry`) ?? undefined };
        }),
      };
    });
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query('SELECT legal_entity_id, status, asset_type FROM fleet.asset WHERE id = $1', [assetId])).rows[0];
      if (!x || x.legal_entity_id !== le) throw new BadRequestException('unknown asset_id');
      if (x.status === 'out_of_service' || x.status === 'retired') throw new ConflictException(`vehicle is ${x.status}`);
      const w = (await c.query('SELECT legal_entity_id, status, kind FROM workforce.worker WHERE id = $1', [driverId])).rows[0];
      if (!w || w.legal_entity_id !== le || !['driver', 'courier'].includes(w.kind)) throw new BadRequestException('unknown driver_worker_id');
      if (w.status !== 'active') throw new ConflictException(`driver is ${w.status}`);
      // names and prices from the catalogue when the planner leaves them out
      const catalogue = new Map<string, { name: string; price: string }>((await c.query(
        'SELECT sku, name, price::text FROM ops.dist_product WHERE legal_entity_id = $1 AND active', [le])).rows.map((p) => [p.sku, p]));
      const planned = stops.map((s, i) => ({
        ...s,
        items: s.items.map((it): Item => {
          const p = catalogue.get(it.sku);
          if (!p && (it.name === undefined || it.price === undefined)) throw new BadRequestException(`stops[${i}]: ${it.sku} is not in the catalogue (send name and price)`);
          return { sku: it.sku, name: it.name ?? p!.name, qty: it.qty, price: it.price ?? p!.price, ...(it.expiry ? { expiry: it.expiry } : {}) };
        }),
      }));
      for (const [i, s] of planned.entries()) {
        if (s.customer_id) {
          const cu = (await c.query('SELECT legal_entity_id FROM crm.customer WHERE id = $1', [s.customer_id])).rows[0];
          if (!cu || cu.legal_entity_id !== le) throw new BadRequestException(`stops[${i}]: unknown customer_id`);
        }
      }
      const win = (await c.query(
        `SELECT ($1::date + $2::time) AT TIME ZONE le.timezone AS f, ($1::date + $3::time) AT TIME ZONE le.timezone AS t FROM org.legal_entity le WHERE le.id = $4`,
        [day, start, end, le])).rows[0];
      if (!win) throw new BadRequestException('unknown legal_entity_id');
      if (new Date(win.t).getTime() < Date.now()) throw new BadRequestException('the route day is over');
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.dist_route`)).rows[0].n;
      const ref = `DR-${n}`;
      const load = loadList(planned);
      const window = { from: new Date(win.f).toISOString(), to: new Date(win.t).toISOString() };
      const routeTask = await createTask(c, a, { le, pack: DISTRIBUTION, branch: null, status: 'ready', customer: null, site: null, ref, win: window,
        attrs: { kind: 'route', route_ref: ref, stops: planned.length, load, address: `${planned.length} توقفات`,
          ...(tempClass !== 'ambient' ? { temp_class: tempClass, temp_min: tMin, temp_max: tMax } : {}) } });
      const id = randomUUID();
      await c.query('SAVEPOINT r');
      try {
        await c.query(`INSERT INTO ops.dist_route (id, tenant_id, legal_entity_id, ref, route_date, task_id, asset_id, driver_worker_id, notes, created_by, temp_class, temp_min, temp_max)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, a.tenantId, le, ref, day, routeTask.id, assetId, driverId, notes, a.userId, tempClass, tMin, tMax]);
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, routeTask.id, driverId, assetId, window.from, window.to, a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT r');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'dist_route_asset_day' || k === 'no_asset_overlap') throw new ConflictException('vehicle is already booked that day');
        if (k === 'dist_route_driver_day' || k === 'no_worker_overlap') throw new ConflictException('driver already has work in that period');
        throw e;
      }
      await this.status(c, a, routeTask.id, 'ready', 'assigned', `route ${ref} planned`);
      for (const [i, s] of planned.entries()) {
        const seq = i + 1;
        const t = await createTask(c, a, { le, pack: DISTRIBUTION, branch: null, status: 'ready', customer: null, site: null, ref: `${ref}-${seq}`, win: window,
          attrs: { kind: 'stop', seq, route_ref: ref, route_id: id, name: s.name, address: s.address ?? s.name, payment: s.payment, items: s.items, ...(tempClass !== 'ambient' ? { temp_class: tempClass } : {}),
            dropoff: { name: s.name, ...(s.phone ? { phone: s.phone } : {}), ...(s.lat !== null && s.lng !== null ? { lat: s.lat, lng: s.lng } : {}) } } });
        const sw = s.window_from || s.window_to ? (await c.query(
          `SELECT CASE WHEN $2::time IS NULL THEN NULL ELSE ($1::date + $2::time) AT TIME ZONE le.timezone END AS f,
                  CASE WHEN $3::time IS NULL THEN NULL ELSE ($1::date + $3::time) AT TIME ZONE le.timezone END AS t FROM org.legal_entity le WHERE le.id = $4`,
          [day, s.window_from, s.window_to, le])).rows[0] : { f: null, t: null };
        await c.query(`INSERT INTO ops.dist_stop (task_id, tenant_id, route_id, seq, customer_id, name, payment, items, window_from, window_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [t.id, a.tenantId, id, seq, s.customer_id, s.name, s.payment, JSON.stringify(s.items), sw.f, sw.t]);
        if (sw.f || sw.t) await c.query(`UPDATE ops.task SET attributes = attributes || jsonb_build_object('window', $2::text) WHERE id = $1`, [t.id, [s.window_from, s.window_to].filter(Boolean).join('–')]);
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,false,tstzrange($5,$6),$7)`,
          [randomUUID(), a.tenantId, t.id, driverId, window.from, window.to, a.userId]);
        await this.status(c, a, t.id, 'ready', 'assigned', `stop ${seq} of ${ref}`);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'dist_route.created', targetType: 'dist_route', targetId: id, after: { ref, day, asset_id: assetId, driver_worker_id: driverId, stops: planned.length } });
      return this.detail(c, id);
    });
  }

  @Get('routes')
  @Perm('tasks:read')
  routes(@Auth() a: AuthContext, @Query('date') date?: string) {
    const d = v.date(date, 'date');
    return this.db.withTenant(a, async (c) => {
      const day = d ?? (await this.today(c));
      return { date: day, data: (await c.query(`${ROUTE_SQL} WHERE r.route_date = $1 ORDER BY r.ref`, [day])).rows };
    });
  }

  @Get('routes/:id')
  @Perm('tasks:read')
  route(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, (c) => this.detail(c, id));
  }

  /** Cancel a route that has not left yet: its tasks are canceled and the vehicle and driver freed. */
  @Post('routes/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const r = await this.lock(c, id, ver);
      if (!['planned', 'loaded'].includes(r.status)) throw new ConflictException(`cannot cancel a route that is ${r.status}`);
      const tasks = [r.task_id, ...(await c.query('SELECT task_id FROM ops.dist_stop WHERE route_id = $1', [id])).rows.map((x) => x.task_id)];
      for (const t of tasks) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t]);
        const st = (await c.query('SELECT status FROM ops.task WHERE id = $1 FOR UPDATE', [t])).rows[0].status;
        if (['completed', 'failed', 'canceled'].includes(st)) continue;
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [t]);
        await this.event(c, a, t, st, 'canceled', `route canceled: ${reason}`.slice(0, 500));
      }
      await c.query(`UPDATE ops.dist_route SET status = 'canceled', cancel_reason = $2, version = version + 1 WHERE id = $1`, [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'dist_route.canceled', targetType: 'dist_route', targetId: id, after: { reason } });
      return this.detail(c, id);
    });
  }

  /** The driver hands the cash to the office: the variance against what was collected is kept on the route. */
  @Post('routes/:id/settle')
  @HttpCode(200)
  @Perm('billing:write')
  settle(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const cash = amount(b?.cash_received, 'cash_received');
    const note = v.str(b?.note, 'note', { max: 500 });
    return this.db.withTenant(a, async (c) => {
      const r = await this.lock(c, id, ver);
      if (r.status !== 'back') throw new ConflictException(r.status === 'settled' ? 'already settled' : `the route is ${r.status}: settle after it is back`);
      const collected = fils((await c.query('SELECT coalesce(sum(cash_collected), 0)::text AS s FROM ops.dist_stop WHERE route_id = $1', [id])).rows[0].s);
      const variance = fils(cash) - collected;
      if (variance !== 0 && !note) throw new BadRequestException(`the cash differs from what was collected by ${kwd(variance)} KWD: add a note`);
      await c.query(`UPDATE ops.dist_route SET status = 'settled', cash_received = $2, settled_by = $3, settled_at = now(), settle_note = $4, version = version + 1 WHERE id = $1`,
        [id, cash, a.userId, note]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'dist_route.settled', targetType: 'dist_route', targetId: id, after: { cash_received: cash, variance: kwd(variance), note } });
      return this.detail(c, id);
    });
  }

  /** The office records a stop for the driver (phone lost, paper delivery note). Same rules as the app. */
  @Post('stops/:taskId/proof')
  @HttpCode(200)
  @Perm('tasks:write')
  officeProof(@Auth() a: AuthContext, @Param('taskId', new ParseUUIDPipe()) taskId: string, @Body() b: Record<string, unknown>) {
    const input = parseProof(b, 'body');
    return this.db.withTenant(a, async (c) => {
      const res = await stopProof(c, a, taskId, input, new Date(), 'staff', randomUUID());
      if ('reject' in res) throw (res.reject === 'not_supported' ? new NotFoundException() : new ConflictException(res.reject));
      const route = (await c.query('SELECT route_id FROM ops.dist_stop WHERE task_id = $1', [taskId])).rows[0].route_id;
      return this.detail(c, route);
    });
  }

  /**
   * A temperature reading for a route (cold chain): entered by the office, or sent by a logger or another app (source
   * device / external with its reference). Checked against the route's range.
   */
  @Post('routes/:id/temps')
  @Perm('tasks:write')
  addTemp(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reading = celsius(b?.reading_c, 'reading_c');
    const source = v.oneOf(b?.source, 'source', ['manual', 'device', 'external'] as const) ?? 'manual';
    const device = v.str(b?.device_ref, 'device_ref', { max: 80 });
    if (source !== 'manual' && !device) throw new BadRequestException('device_ref required for a device or external reading');
    const at = v.ts(b?.recorded_at, 'recorded_at') ?? new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('recorded_at is in the future');
    const stop = v.uuid(b?.stop_task_id, 'stop_task_id');
    const note = v.str(b?.note, 'note', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      const res = await addReading(c, a, { route: id, reading, source, device, at, stop, note, clientOpId: randomUUID() });
      if (res) throw (res === 'not_supported' ? new NotFoundException() : new BadRequestException(res));
      return this.detail(c, id);
    });
  }

  /** The day: routes with progress and cash, and what is loaded across them. */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('date') date?: string) {
    const d = v.date(date, 'date');
    return this.db.withTenant(a, async (c) => {
      const day = d ?? (await this.today(c));
      const routes = (await c.query(`${ROUTE_SQL} WHERE r.route_date = $1 AND r.status <> 'canceled' ORDER BY r.ref`, [day])).rows;
      const sum = (k: string) => kwd(routes.reduce((s, r) => s + fils(r[k]), 0));
      return {
        date: day, routes,
        totals: { routes: routes.length, stops: routes.reduce((s, r) => s + r.stops, 0), stops_done: routes.reduce((s, r) => s + r.stops_done, 0),
          out: routes.filter((r) => r.status === 'out').length, cash_due: sum('cash_due'), cash_collected: sum('cash_collected'),
          unsettled: routes.filter((r) => r.status === 'back').length },
      };
    });
  }

  /** What needs the office: routes not loaded or not back in time, cash short at a stop, returns, unsettled cash. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const q = async (where: string) => (await c.query(`${ROUTE_SQL} WHERE r.route_date >= current_date - 7 AND ${where} ORDER BY r.route_date, r.ref LIMIT 200`)).rows;
      const not_loaded = await q(`r.status = 'planned' AND lower(t.service_window) + interval '30 minutes' < now()`);
      const late = await q(`r.status = 'out' AND upper(t.service_window) < now()`);
      const unsettled = await q(`r.status = 'back' AND r.back_at < now() - interval '2 hours'`);
      const variance = (await c.query(`SELECT x.* FROM (${ROUTE_SQL}) x WHERE x.status = 'settled' AND x.route_date::date >= current_date - 7
          AND x.cash_received::numeric <> x.cash_collected::numeric ORDER BY x.route_date DESC LIMIT 200`)).rows;
      const stops = (await c.query(`SELECT s.*, r.ref AS route_ref, r.route_date::text AS route_date, r.id AS route_id, w.display_name AS driver_name FROM (${STOP_SQL}) s
          JOIN ops.dist_route r ON r.id = s.route_id JOIN workforce.worker w ON w.id = r.driver_worker_id
         WHERE r.route_date >= current_date - 7 AND s.done_at IS NOT NULL ORDER BY r.route_date DESC, r.ref, s.seq LIMIT 1000`)).rows;
      return {
        not_loaded, late, unsettled, variance,
        short: stops.filter((s) => fils(s.cash_collected) < fils(s.cash_due)),
        failed: stops.filter((s) => s.closed_reason),
        returns: stops.filter((s) => s.returned && Object.keys(s.returned).length > 0),
      };
    });
  }

  /** Distribution report: per route day and driver, delivered and returned value, cash due, collected and handed in, distance. */
  @Get('report')
  @Perm('reports:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from') ?? (() => { throw new BadRequestException('from required'); })();
    const t = v.date(to, 'to') ?? (() => { throw new BadRequestException('to required'); })();
    if (t < f) throw new BadRequestException('to is before from');
    return this.db.withTenant(a, async (c) => {
      const routes = (await c.query(`${ROUTE_SQL} WHERE r.route_date BETWEEN $1 AND $2 AND r.status <> 'canceled' ORDER BY r.route_date, r.ref`, [f, t])).rows;
      const stops = (await c.query(`SELECT s.route_id, s.name, s.items, s.delivered, s.returned, s.cash_due::text, s.cash_collected::text, s.closed_reason, s.done_at
          FROM ops.dist_stop s JOIN ops.dist_route r ON r.id = s.route_id WHERE r.route_date BETWEEN $1 AND $2 AND r.status <> 'canceled'`, [f, t])).rows;
      const byRoute = new Map<string, typeof stops>();
      for (const s of stops) byRoute.set(s.route_id, [...(byRoute.get(s.route_id) ?? []), s]);
      const rows = routes.map((r) => {
        const ss = byRoute.get(r.id) ?? [];
        const delivered = ss.reduce((x, s) => x + valueFils(s.delivered ?? {}, s.items), 0);
        const returned = ss.reduce((x, s) => x + valueFils(s.returned ?? {}, s.items), 0);
        const planned = ss.reduce((x, s) => x + s.items.reduce((y: number, i: Item) => y + valueFils({ [i.sku]: i.qty }, [i]), 0), 0);
        return { id: r.id, ref: r.ref, route_date: r.route_date, driver_name: r.driver_name, plate_no: r.plate_no, status: r.status, stops: r.stops, stops_done: r.stops_done,
          stops_failed: r.stops_failed, km: r.km, planned_value: kwd(planned), delivered_value: kwd(delivered), returned_value: kwd(returned),
          cash_due: r.cash_due, cash_collected: r.cash_collected, cash_received: r.cash_received,
          variance: r.cash_received === null ? null : kwd(fils(r.cash_received) - fils(r.cash_collected)) };
      });
      const sum = (k: 'planned_value' | 'delivered_value' | 'returned_value' | 'cash_due' | 'cash_collected') => kwd(rows.reduce((s, r) => s + fils(r[k]), 0));
      return { from: f, to: t, data: rows, totals: { routes: rows.length, stops: rows.reduce((s, r) => s + r.stops, 0), km: rows.reduce((s, r) => s + (r.km ?? 0), 0),
        planned_value: sum('planned_value'), delivered_value: sum('delivered_value'), returned_value: sum('returned_value'), cash_due: sum('cash_due'), cash_collected: sum('cash_collected'),
        variance: kwd(rows.reduce((s, r) => s + (r.variance === null ? 0 : fils(r.variance)), 0)) } };
    });
  }

  // ---- helpers ----

  private async today(c: PoolClient) {
    const tz = (await c.query('SELECT timezone FROM org.legal_entity ORDER BY id LIMIT 1')).rows[0]?.timezone ?? 'Asia/Kuwait';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  }

  private async detail(c: PoolClient, id: string) {
    const r = (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    const stops = (await c.query(`${STOP_SQL} WHERE s.route_id = $1 ORDER BY s.seq`, [id])).rows;
    const temps = (await c.query(
      `SELECT id, stop_task_id, reading_c::float, source, device_ref, in_range, recorded_at, note FROM ops.temp_reading WHERE route_id = $1 ORDER BY recorded_at`, [id])).rows;
    return { ...r, stops, temps, load: loadList(stops), reconcile: reconcile(stops),
      variance: r.cash_received === null ? null : kwd(fils(r.cash_received) - fils(r.cash_collected)) };
  }

  private async lock(c: PoolClient, id: string, ver: number) {
    const r = (await c.query('SELECT * FROM ops.dist_route WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new NotFoundException();
    if (r.version !== ver) throw new ConflictException({ message: 'route changed since you loaded it', current_version: r.version });
    return r;
  }

  private async status(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
    await c.query('UPDATE ops.task SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [taskId, to]);
    await this.event(c, a, taskId, from, to, note);
  }

  private async event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
  }
}

export interface ProofIn { delivered: Qty; returned: Qty; damaged: Qty; cash_collected: string | null; received_by: string | null; closed_reason: string | null; note: string | null }

/** The stop proof as the app or the office sends it. A closed stop carries a reason and no quantities. */
export function parseProof(o: Record<string, unknown>, f: string): ProofIn {
  const closed = v.oneOf(o?.closed_reason, `${f}.closed_reason`, FAIL_REASONS);
  const delivered = qtyMap(o?.delivered, `${f}.delivered`);
  if (!closed && Object.keys(delivered).length === 0) throw new BadRequestException(`${f}: send delivered quantities, or closed_reason`);
  return {
    delivered, returned: qtyMap(o?.returned, `${f}.returned`), damaged: qtyMap(o?.damaged, `${f}.damaged`),
    cash_collected: o?.cash_collected === undefined || o?.cash_collected === null ? null : amount(o.cash_collected, `${f}.cash_collected`),
    received_by: v.str(o?.received_by, `${f}.received_by`, { max: 120 }), closed_reason: closed, note: v.str(o?.note, `${f}.note`, { max: 500 }),
  };
}

/**
 * Records a stop: delivered and returned quantities, the cash, who received it; or that it could not be served. The stop task
 * is completed (or failed) at once. Returns a rejection reason instead of throwing so the driver sync can report it per op.
 */
export async function stopProof(c: PoolClient, a: AuthContext, taskId: string, p: ProofIn, at: Date, by: 'driver' | 'staff', clientOpId: string)
  : Promise<{ reject: string; status?: string } | { status: string; cash_due: string; cash_collected: string }> {
  const s = (await c.query(`SELECT s.*, r.status AS route_status FROM ops.dist_stop s JOIN ops.dist_route r ON r.id = s.route_id WHERE s.task_id = $1 FOR UPDATE OF s`, [taskId])).rows[0];
  if (!s) return { reject: 'not_supported' };
  const t = (await c.query('SELECT status FROM ops.task WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
  if (s.done_at) return { reject: 'stop_already_recorded', status: t.status };
  if (s.route_status !== 'out') return { reject: 'route_not_started', status: t.status };
  if (!['accepted', 'in_progress'].includes(t.status)) return { reject: 'invalid_stage', status: t.status };
  const items: Item[] = s.items;
  let due = 0;
  if (!p.closed_reason) {
    const bad = checkDelivered(items, p.delivered);
    if (bad) return { reject: bad, status: t.status };
    due = s.payment === 'cash' ? valueFils(p.delivered, items) : 0;
    if (s.payment === 'cash' && p.cash_collected === null) return { reject: 'cash_required', status: t.status };
  }
  const collected = p.closed_reason ? 0 : fils(p.cash_collected ?? '0');
  const to = p.closed_reason ? 'failed' : 'completed';
  await c.query(`UPDATE ops.dist_stop SET delivered = $2, returned = $3, cash_due = $4, cash_collected = $5, received_by = $6, closed_reason = $7, done_at = $8, client_op_id = $9, damaged = $10 WHERE task_id = $1`,
    [taskId, p.closed_reason ? null : JSON.stringify(p.delivered), Object.keys(p.returned).length ? JSON.stringify(p.returned) : null, kwd(due), kwd(collected),
     p.received_by, p.closed_reason, at.toISOString(), clientOpId, Object.keys(p.damaged ?? {}).length ? JSON.stringify(p.damaged) : null]);
  await c.query('UPDATE ops.task SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [taskId, to]);
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note, reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), a.tenantId, taskId, t.status, to, at.toISOString(), a.userId, by, randomUUID(), p.note, p.closed_reason]);
  return { status: to, cash_due: kwd(due), cash_collected: kwd(collected) };
}

/** Route milestones from the driver app: the load checked (with the odometer) and back at the depot after the last stop. */
export async function routeStage(c: PoolClient, taskId: string, code: 'load_checked' | 'route_back', at: Date, km: number | null): Promise<string | null> {
  const r = (await c.query('SELECT id, status, asset_id, start_odometer_km FROM ops.dist_route WHERE task_id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!r) return 'not_supported';
  if (code === 'load_checked') {
    if (r.status !== 'planned') return 'invalid_stage';
    const last = (await c.query('SELECT odometer_km FROM fleet.asset WHERE id = $1', [r.asset_id])).rows[0]?.odometer_km;
    if (km !== null && last !== null && last !== undefined && km < last) return 'odometer_too_low';
    await c.query(`UPDATE ops.dist_route SET status = 'loaded', loaded_at = $2, start_odometer_km = $3, version = version + 1 WHERE id = $1`, [r.id, at.toISOString(), km]);
  } else {
    if (r.status !== 'out') return 'invalid_stage';
    if ((await c.query('SELECT 1 FROM ops.dist_stop WHERE route_id = $1 AND done_at IS NULL', [r.id])).rowCount) return 'stops_open';
    if (km !== null && r.start_odometer_km !== null && km < r.start_odometer_km) return 'odometer_too_low';
    await c.query(`UPDATE ops.dist_route SET status = 'back', back_at = $2, end_odometer_km = $3, version = version + 1 WHERE id = $1`, [r.id, at.toISOString(), km]);
  }
  if (km !== null) await c.query('UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2) WHERE id = $1', [r.asset_id, km]);
  return null;
}

/** The route left the depot (route task in progress): the route is out and its stops open for the driver. */
export async function routeOut(c: PoolClient, a: AuthContext, taskId: string, at: Date) {
  const r = (await c.query(`UPDATE ops.dist_route SET status = 'out', out_at = $2, version = version + 1 WHERE task_id = $1 AND status = 'loaded' RETURNING id`, [taskId, at.toISOString()])).rows[0];
  if (!r) return;
  const stops = (await c.query(`SELECT s.task_id FROM ops.dist_stop s JOIN ops.task t ON t.id = s.task_id WHERE s.route_id = $1 AND t.status = 'assigned' FOR UPDATE OF t`, [r.id])).rows;
  for (const s of stops) {
    await c.query(`UPDATE ops.task SET status = 'accepted', version = version + 1, updated_at = now() WHERE id = $1`, [s.task_id]);
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,'assigned','accepted',$4,$5,'system',$6,'route left the depot')`,
      [randomUUID(), a.tenantId, s.task_id, at.toISOString(), a.userId, randomUUID()]);
  }
}

/** Records a temperature reading on a route (driver app or office). Returns a rejection reason, or null when stored. */
export async function addReading(c: PoolClient, a: AuthContext, r: { route: string; reading: number; source: string; device: string | null; at: Date; stop: string | null; note: string | null; clientOpId: string })
  : Promise<string | null> {
  const route = (await c.query('SELECT id, status, temp_min::float, temp_max::float FROM ops.dist_route WHERE id = $1', [r.route])).rows[0];
  if (!route) return 'not_supported';
  if (route.status === 'canceled') return 'route_canceled';
  if (r.stop && !(await c.query('SELECT 1 FROM ops.dist_stop WHERE task_id = $1 AND route_id = $2', [r.stop, r.route])).rowCount) return 'unknown stop_task_id';
  await c.query(
    `INSERT INTO ops.temp_reading (id, tenant_id, route_id, stop_task_id, reading_c, source, device_ref, in_range, recorded_at, recorded_by, note, client_op_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), a.tenantId, r.route, r.stop, r.reading, r.source, r.device, inRange(r.reading, route.temp_min, route.temp_max), r.at.toISOString(), a.userId, r.note, r.clientOpId]);
  return null;
}
