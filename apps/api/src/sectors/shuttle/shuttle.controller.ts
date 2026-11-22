import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { normalizePhone } from '../../common/phone';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { addMinutes, BOARD_EVENTS, BoardEvent, DIRECTIONS, isoDow, LATE_START_MIN, NO_SHOW_STREAK, parseDays, parseStops, SHUTTLE, Stop } from './shuttle';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const hm = (x: unknown, f: string) => {
  if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new BadRequestException(`${f} must be HH:MM`);
  return x;
};
const DONE = ['completed', 'reviewed', 'invoiced'];

const ROUTE_SQL = `
  SELECT r.id, r.legal_entity_id, r.customer_id, cu.name AS customer_name, r.code, r.name, r.direction, to_char(r.depart_time, 'HH24:MI') AS depart_time,
         r.duration_min, r.days, r.stops, r.capacity, r.asset_id, a.plate_no, r.driver_worker_id, w.display_name AS driver_name, r.active, r.version,
         (SELECT count(*)::int FROM ops.shuttle_rider x WHERE x.route_id = r.id AND x.active) AS riders
    FROM ops.shuttle_route r LEFT JOIN crm.customer cu ON cu.id = r.customer_id
    LEFT JOIN fleet.asset a ON a.id = r.asset_id LEFT JOIN workforce.worker w ON w.id = r.driver_worker_id`;

// each rider's standing mark on a trip is the latest one
const MARKS = `SELECT DISTINCT ON (b.trip_id, b.rider_id) b.trip_id, b.rider_id, b.event, b.occurred_at, b.source FROM ops.shuttle_board b`;

const TRIP_SQL = `
  SELECT st.id, st.route_id, r.code AS route_code, r.name AS route_name, r.direction, r.customer_id, cu.name AS customer_name, st.trip_date::text AS trip_date,
         st.task_id, t.status, t.version AS task_version, lower(t.service_window) AS depart_at, upper(t.service_window) AS arrive_by,
         st.asset_id, a.plate_no, st.driver_worker_id, w.display_name AS driver_name, st.riders_planned, st.capacity,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'in_progress') AS started_at,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') AS ended_at,
         (SELECT count(*)::int FROM (${MARKS} WHERE b.trip_id = st.id ORDER BY b.trip_id, b.rider_id, b.occurred_at DESC) m WHERE m.event = 'boarded') AS boarded,
         (SELECT count(*)::int FROM (${MARKS} WHERE b.trip_id = st.id ORDER BY b.trip_id, b.rider_id, b.occurred_at DESC) m WHERE m.event = 'no_show') AS no_show
    FROM ops.shuttle_trip st JOIN ops.shuttle_route r ON r.id = st.route_id JOIN ops.task t ON t.id = st.task_id
    LEFT JOIN crm.customer cu ON cu.id = r.customer_id JOIN fleet.asset a ON a.id = st.asset_id JOIN workforce.worker w ON w.id = st.driver_worker_id`;

interface RouteRow { id: string; legal_entity_id: string; customer_id: string | null; customer_name: string | null; code: string; name: string; direction: string; depart_time: string; duration_min: number; days: number[]; stops: Stop[]; capacity: number | null; asset_id: string | null; driver_worker_id: string | null; active: boolean }

/** The riders of a trip with their stop and standing mark: the manifest the driver and the office see. */
export async function manifest(c: PoolClient, tripId: string) {
  return (await c.query(
    `SELECT x.id, x.name, x.staff_no, x.phone, x.stop_seq, m.event, m.occurred_at AS marked_at, m.source
       FROM ops.shuttle_trip st JOIN ops.shuttle_rider x ON x.route_id = st.route_id
       LEFT JOIN (${MARKS} WHERE b.trip_id = $1 ORDER BY b.trip_id, b.rider_id, b.occurred_at DESC) m ON m.rider_id = x.id
      WHERE st.id = $1 AND (x.active OR m.event IS NOT NULL) ORDER BY x.stop_seq, x.name`, [tripId])).rows;
}

/**
 * Marks a rider boarded or absent on a trip (the driver from the app, or the office correcting). Returns a reject code
 * instead of throwing so the driver's offline sync can report it per op.
 */
export async function markRider(c: PoolClient, a: AuthContext, x: { taskId: string; riderId: string; event: BoardEvent; at: Date; source: 'driver' | 'office'; clientOpId: string }): Promise<string | null> {
  const st = (await c.query('SELECT st.id, st.route_id, t.status FROM ops.shuttle_trip st JOIN ops.task t ON t.id = st.task_id WHERE st.task_id = $1', [x.taskId])).rows[0];
  if (!st) return 'not_supported';
  const allowed = x.source === 'driver' ? ['accepted', 'in_progress'] : ['assigned', 'accepted', 'in_progress', ...DONE];
  if (!allowed.includes(st.status)) return 'invalid_stage';
  if (!(await c.query('SELECT 1 FROM ops.shuttle_rider WHERE id = $1 AND route_id = $2', [x.riderId, st.route_id])).rowCount) return 'unknown_rider';
  await c.query('INSERT INTO ops.shuttle_board (id, tenant_id, trip_id, rider_id, event, occurred_at, source, actor_id, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [randomUUID(), a.tenantId, st.id, x.riderId, x.event, x.at, x.source, a.userId || null, x.clientOpId]);
  return null;
}

@Controller('v1/shuttle')
@UseGuards(AuthGuard)
@Pack('shuttle')
export class ShuttleController {
  constructor(private readonly db: DbService) {}

  // ---- routes ----

  @Get('routes')
  @Perm('tasks:read')
  routes(@Auth() a: AuthContext, @Query('customer_id') customer?: string) {
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`${ROUTE_SQL} WHERE ($1::uuid IS NULL OR r.customer_id = $1) ORDER BY r.active DESC, r.code`, [cu])).rows }));
  }

  @Post('routes')
  @Perm('tasks:assign')
  addRoute(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const r = this.parseRoute(b, null);
    return this.db.withTenant(a, async (c) => {
      await this.checkRefs(c, le, r);
      const id = randomUUID();
      try {
        await c.query(`INSERT INTO ops.shuttle_route (id, tenant_id, legal_entity_id, customer_id, code, name, direction, depart_time, duration_min, days, stops, capacity, asset_id, driver_worker_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, a.tenantId, le, r.customer_id, r.code, r.name, r.direction, r.depart_time, r.duration_min, r.days, JSON.stringify(r.stops), r.capacity, r.asset_id, r.driver_worker_id]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'shuttle_route_tenant_id_code_key') throw new ConflictException('route code already used');
        pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shuttle.route_created', targetType: 'shuttle_route', targetId: id, after: { code: r.code, customer_id: r.customer_id } });
      return (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0];
    });
  }

  /** Changes a route (version required). Trips already generated keep their bus, driver and time. */
  @Patch('routes/:id')
  @Perm('tasks:assign')
  editRoute(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0] as RouteRow & { version: number };
      if (!before) throw new NotFoundException();
      if (before.version !== ver) throw new ConflictException('route changed meanwhile; reload');
      const r = this.parseRoute(b, before);
      await this.checkRefs(c, before.legal_entity_id, r);
      const active = b?.active === undefined ? before.active : b.active === true;
      await c.query(`UPDATE ops.shuttle_route SET customer_id = $2, name = $3, direction = $4, depart_time = $5, duration_min = $6, days = $7, stops = $8, capacity = $9,
          asset_id = $10, driver_worker_id = $11, active = $12, version = version + 1 WHERE id = $1`,
        [id, r.customer_id, r.name, r.direction, r.depart_time, r.duration_min, r.days, JSON.stringify(r.stops), r.capacity, r.asset_id, r.driver_worker_id, active]);
      const after = (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shuttle.route_changed', targetType: 'shuttle_route', targetId: id, before, after });
      return after;
    });
  }

  // ---- riders ----

  @Get('routes/:id/riders')
  @Perm('tasks:read')
  riders(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT x.id, x.name, x.staff_no, x.phone, x.stop_seq, x.active,
                (SELECT count(*)::int FROM (${MARKS} WHERE b.rider_id = x.id ORDER BY b.trip_id, b.rider_id, b.occurred_at DESC) m WHERE m.event = 'no_show' AND m.occurred_at > now() - interval '30 days') AS no_shows_30d
           FROM ops.shuttle_rider x WHERE x.route_id = $1 ORDER BY x.active DESC, x.stop_seq, x.name`, [id])).rows,
    }));
  }

  /** Adds riders to a route (up to 200 at once, e.g. pasted from the customer's list); a staff number already on the route is skipped. */
  @Post('routes/:id/riders')
  @Perm('tasks:assign')
  addRiders(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const list = Array.isArray(b?.riders) ? (b.riders as Record<string, unknown>[]) : [b];
    if (!list.length || list.length > 200) throw new BadRequestException('riders: 1-200');
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query('SELECT stops FROM ops.shuttle_route WHERE id = $1', [id])).rows[0];
      if (!r) throw new NotFoundException();
      const nStops = (r.stops as Stop[]).length;
      const rows = list.map((x, i) => {
        const seq = v.int(x?.stop_seq, `riders[${i}].stop_seq`, 1, nStops) ?? (() => { throw new BadRequestException(`riders[${i}].stop_seq required (1-${nStops})`); })();
        const staff = v.str(x?.staff_no, `riders[${i}].staff_no`, { max: 30 });
        if (staff && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/.test(staff)) throw new BadRequestException(`riders[${i}].staff_no invalid`);
        const rawPhone = v.str(x?.phone, `riders[${i}].phone`, { max: 20 });
        const phone = rawPhone ? normalizePhone(rawPhone) : null;
        if (rawPhone && !phone) throw new BadRequestException(`riders[${i}].phone invalid`);
        return { name: v.str(x?.name, `riders[${i}].name`, { required: true, max: 120 })!, staff, phone, seq };
      });
      let added = 0;
      for (const x of rows) {
        const res = await c.query(`INSERT INTO ops.shuttle_rider (id, tenant_id, route_id, name, staff_no, phone, stop_seq) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (tenant_id, route_id, staff_no) DO NOTHING`, [randomUUID(), a.tenantId, id, x.name, x.staff, x.phone, x.seq]);
        added += res.rowCount ?? 0;
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shuttle.riders_added', targetType: 'shuttle_route', targetId: id, after: { added } });
      return { added, skipped: rows.length - added };
    });
  }

  @Patch('riders/:id')
  @Perm('tasks:assign')
  editRider(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query('SELECT x.*, jsonb_array_length(r.stops) AS n FROM ops.shuttle_rider x JOIN ops.shuttle_route r ON r.id = x.route_id WHERE x.id = $1', [id])).rows[0];
      if (!x) throw new NotFoundException();
      const seq = v.int(b?.stop_seq, 'stop_seq', 1, x.n) ?? x.stop_seq;
      const name = v.str(b?.name, 'name', { max: 120 }) ?? x.name;
      const rawPhone = b?.phone === undefined ? undefined : v.str(b.phone, 'phone', { max: 20 });
      const phone = rawPhone === undefined ? x.phone : rawPhone ? normalizePhone(rawPhone) : null;
      if (rawPhone && !phone) throw new BadRequestException('phone invalid');
      if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
      const row = (await c.query('UPDATE ops.shuttle_rider SET stop_seq = $2, name = $3, phone = $4, active = $5 WHERE id = $1 RETURNING id, name, staff_no, phone, stop_seq, active',
        [id, seq, name, phone, b?.active ?? x.active])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shuttle.rider_changed', targetType: 'shuttle_rider', targetId: id, before: x, after: row });
      return row;
    });
  }

  // ---- trips ----

  /**
   * Generates the trips of a day for the routes that run on it (all active routes, or the ones listed). Idempotent: a
   * route that already has its trip is reported as existing. A route without a bus or driver, or whose bus or driver is
   * booked elsewhere at that time, is skipped with the reason; the rest are created.
   */
  @Post('trips/generate')
  @Perm('tasks:assign')
  generate(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const day = v.date(b?.date, 'date') ?? kwToday();
    const only = Array.isArray(b?.route_ids) ? (b.route_ids as unknown[]).map((x, i) => v.uuid(x, `route_ids[${i}]`, { required: true })!) : null;
    const dow = isoDow(day);
    return this.db.withTenant(a, async (c) => {
      const routes = (await c.query(`${ROUTE_SQL} WHERE r.active AND $1 = ANY (r.days) AND ($2::uuid[] IS NULL OR r.id = ANY ($2)) ORDER BY to_char(r.depart_time, 'HH24:MI'), r.code`, [dow, only])).rows as RouteRow[];
      const created: string[] = [], existing: string[] = [], skipped: { code: string; reason: string }[] = [];
      for (const r of routes) {
        if ((await c.query('SELECT 1 FROM ops.shuttle_trip WHERE route_id = $1 AND trip_date = $2', [r.id, day])).rowCount) { existing.push(r.code); continue; }
        if (!r.asset_id) { skipped.push({ code: r.code, reason: 'no_vehicle' }); continue; }
        if (!r.driver_worker_id) { skipped.push({ code: r.code, reason: 'no_driver' }); continue; }
        const why = await this.tripFor(c, a, r, day);
        if (why) skipped.push({ code: r.code, reason: why }); else created.push(r.code);
      }
      return { date: day, created, existing, skipped };
    });
  }

  @Get('trips')
  @Perm('tasks:read')
  trips(@Auth() a: AuthContext, @Query('date') date?: string, @Query('customer_id') customer?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => ({
      date: day,
      data: (await c.query(`${TRIP_SQL} WHERE st.trip_date = $1 AND ($2::uuid IS NULL OR r.customer_id = $2) ORDER BY lower(t.service_window), r.code`, [day, cu])).rows,
    }));
  }

  @Get('trips/:id')
  @Perm('tasks:read')
  trip(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query(`${TRIP_SQL} WHERE st.id = $1`, [id])).rows[0];
      if (!t) throw new NotFoundException();
      const stops = (await c.query('SELECT r.stops FROM ops.shuttle_route r WHERE r.id = $1', [t.route_id])).rows[0].stops;
      return { ...t, stops, riders: await manifest(c, id) };
    });
  }

  /** The office records or corrects a rider's mark (e.g. from the supervisor's list after the trip). */
  @Post('trips/:id/board')
  @HttpCode(200)
  @Perm('tasks:assign')
  board(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const rider = v.uuid(b?.rider_id, 'rider_id', { required: true })!;
    const event = v.oneOf(b?.event, 'event', BOARD_EVENTS, { required: true })!;
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT task_id FROM ops.shuttle_trip WHERE id = $1', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const bad = await markRider(c, a, { taskId: t.task_id, riderId: rider, event, at: new Date(), source: 'office', clientOpId: randomUUID() });
      if (bad === 'unknown_rider') throw new BadRequestException('rider is not on this route');
      if (bad) throw new ConflictException('the trip is canceled or failed');
      return { riders: await manifest(c, id) };
    });
  }

  @Post('trips/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT t.id, t.status FROM ops.shuttle_trip st JOIN ops.task t ON t.id = st.task_id WHERE st.id = $1 FOR UPDATE OF t', [id])).rows[0];
      if (!t) throw new NotFoundException();
      if (t.status === 'canceled') return (await c.query(`${TRIP_SQL} WHERE st.id = $1`, [id])).rows[0];
      if (!['ready', 'assigned', 'accepted'].includes(t.status)) throw new ConflictException('the trip is under way or closed');
      await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t.id]);
      await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [t.id]);
      await this.event(c, a, t.id, t.status, 'canceled', reason);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shuttle.trip_canceled', targetType: 'shuttle_trip', targetId: id, after: { reason } });
      return (await c.query(`${TRIP_SQL} WHERE st.id = $1`, [id])).rows[0];
    });
  }

  // ---- watch and report ----

  /** For a day: trips late to leave, routes running without a bus or driver or not generated, full buses, and riders absent repeatedly. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const trips = (await c.query(`${TRIP_SQL} WHERE st.trip_date = $1 ORDER BY lower(t.service_window)`, [day])).rows;
      const late = trips.filter((t) => ['assigned', 'accepted'].includes(t.status) && new Date(t.depart_at).getTime() + LATE_START_MIN * 60_000 < Date.now());
      const over = trips.filter((t) => t.capacity && t.boarded > t.capacity);
      const missing = (await c.query(
        `${ROUTE_SQL} WHERE r.active AND $2 = ANY (r.days) AND NOT EXISTS (SELECT 1 FROM ops.shuttle_trip st WHERE st.route_id = r.id AND st.trip_date = $1) ORDER BY r.code`,
        [day, isoDow(day)])).rows.map((r) => ({ ...r, reason: !r.asset_id ? 'no_vehicle' : !r.driver_worker_id ? 'no_driver' : 'not_generated' }));
      const streak = (await c.query(
        `WITH m AS (${MARKS} ORDER BY b.trip_id, b.rider_id, b.occurred_at DESC),
              k AS (SELECT m.rider_id, m.event, row_number() OVER (PARTITION BY m.rider_id ORDER BY st.trip_date DESC, m.occurred_at DESC) AS n
                      FROM m JOIN ops.shuttle_trip st ON st.id = m.trip_id)
         SELECT x.id, x.name, x.staff_no, x.phone, r.code AS route_code, cu.name AS customer_name
           FROM k JOIN ops.shuttle_rider x ON x.id = k.rider_id JOIN ops.shuttle_route r ON r.id = x.route_id LEFT JOIN crm.customer cu ON cu.id = r.customer_id
          WHERE k.n <= $1 AND x.active GROUP BY x.id, x.name, x.staff_no, x.phone, r.code, cu.name
         HAVING count(*) = $1 AND bool_and(k.event = 'no_show') ORDER BY r.code, x.name`, [NO_SHOW_STREAK])).rows;
      return { date: day, late, missing, over_capacity: over, no_show_streak: streak };
    });
  }

  /**
   * For a period: per customer (or the company's own staff), trips run and canceled, departures on time, riders carried,
   * absences and seat use. The basis for invoicing per trip or per month under the customer's contract.
   */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${TRIP_SQL} WHERE st.trip_date BETWEEN $1 AND $2`, [f, t])).rows;
      const by = new Map<string, typeof rows>();
      for (const r of rows) by.set(r.customer_id ?? '', [...(by.get(r.customer_id ?? '') ?? []), r]);
      const sum = (list: typeof rows) => {
        const ran = list.filter((x) => DONE.includes(x.status));
        const timed = ran.filter((x) => x.started_at);
        const onTime = timed.filter((x) => new Date(x.started_at).getTime() <= new Date(x.depart_at).getTime() + LATE_START_MIN * 60_000).length;
        const seats = ran.filter((x) => x.capacity);
        return {
          trips: list.length, completed: ran.length, canceled: list.filter((x) => x.status === 'canceled').length, failed: list.filter((x) => x.status === 'failed').length,
          on_time_pct: timed.length ? Math.round((onTime / timed.length) * 1000) / 10 : null,
          boarded: ran.reduce((s, x) => s + x.boarded, 0), no_shows: ran.reduce((s, x) => s + x.no_show, 0),
          occupancy_pct: seats.length ? Math.round((seats.reduce((s, x) => s + x.boarded / x.capacity, 0) / seats.length) * 1000) / 10 : null,
        };
      };
      return {
        from: f, to: t,
        data: [...by.entries()].map(([k, list]) => ({ customer_id: k || null, customer_name: list[0].customer_name, routes: new Set(list.map((x) => x.route_id)).size, ...sum(list) }))
          .sort((x, y) => y.trips - x.trips),
        totals: sum(rows),
      };
    });
  }

  // ---- helpers ----

  private parseRoute(b: Record<string, unknown>, prev: RouteRow | null) {
    const pick = <T>(k: string, parse: (x: unknown) => T, fallback: T | undefined): T => (b?.[k] === undefined && prev ? fallback as T : parse(b?.[k]));
    const code = prev ? prev.code : (() => {
      const s = v.str(b?.code, 'code', { required: true, max: 12 })!.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(s)) throw new BadRequestException('code: letters, digits, - or _ (up to 12)');
      return s;
    })();
    const duration = pick('duration_min', (x) => v.int(x, 'duration_min', 10, 480) ?? 60, prev?.duration_min);
    return {
      code,
      name: pick('name', (x) => v.str(x, 'name', { required: true, max: 120 })!, prev?.name),
      customer_id: pick('customer_id', (x) => v.uuid(x, 'customer_id'), prev?.customer_id),
      direction: pick('direction', (x) => v.oneOf(x, 'direction', DIRECTIONS, { required: true })!, prev?.direction),
      depart_time: pick('depart_time', (x) => hm(x, 'depart_time'), prev?.depart_time),
      duration_min: duration,
      days: pick('days', parseDays, prev?.days),
      stops: b?.stops === undefined && prev ? parseStops(prev.stops, duration) : parseStops(b?.stops, duration),
      capacity: pick('capacity', (x) => v.int(x, 'capacity', 1, 120), prev?.capacity),
      asset_id: pick('asset_id', (x) => v.uuid(x, 'asset_id'), prev?.asset_id),
      driver_worker_id: pick('driver_worker_id', (x) => v.uuid(x, 'driver_worker_id'), prev?.driver_worker_id),
    };
  }

  private async checkRefs(c: PoolClient, le: string, r: { customer_id: string | null; asset_id: string | null; driver_worker_id: string | null }) {
    if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
    if (r.customer_id && !(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [r.customer_id, le])).rowCount) throw new BadRequestException('unknown customer_id');
    if (r.asset_id && !(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2', [r.asset_id, le])).rowCount) throw new BadRequestException('unknown asset_id');
    if (r.driver_worker_id && !(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND kind IN ('driver','courier')`, [r.driver_worker_id, le])).rowCount) {
      throw new BadRequestException('unknown driver_worker_id');
    }
  }

  /** One route's trip on a day: the task, the exclusive booking of bus and driver, and the trip row. Returns a skip reason or null. */
  private async tripFor(c: PoolClient, a: AuthContext, r: RouteRow, day: string): Promise<string | null> {
    const asset = (await c.query('SELECT status, capacity FROM fleet.asset WHERE id = $1', [r.asset_id])).rows[0];
    if (!asset || ['out_of_service', 'retired'].includes(asset.status)) return 'vehicle_out_of_service';
    if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND status = 'active'`, [r.driver_worker_id])).rowCount) return 'driver_inactive';
    const win = (await c.query(
      `SELECT ($1::date + $2::time) AT TIME ZONE le.timezone AS f FROM org.legal_entity le WHERE le.id = $3`, [day, r.depart_time, r.legal_entity_id])).rows[0];
    const from = new Date(win.f), to = new Date(from.getTime() + r.duration_min * 60_000);
    if (to.getTime() < Date.now()) return 'past';
    const capacity = r.capacity ?? (Number.isInteger(asset.capacity?.seats) ? asset.capacity.seats : null);
    const riders = (await c.query('SELECT count(*)::int AS n FROM ops.shuttle_rider WHERE route_id = $1 AND active', [r.id])).rows[0].n;
    const stops = r.stops.map((s) => ({ ...s, time: addMinutes(r.depart_time, s.offset_min) }));
    await c.query('SAVEPOINT trip');
    try {
      const task = await createTask(c, a, {
        le: r.legal_entity_id, pack: SHUTTLE, branch: null, status: 'ready', customer: r.customer_id, site: null, ref: `SH-${r.code}-${day.replace(/-/g, '')}`,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { kind: 'trip', route_code: r.code, route_name: r.name, direction: r.direction, depart_time: r.depart_time, stops, riders, capacity,
          customer_name: r.customer_name, address: `${stops[0].name} ← ${stops[stops.length - 1].name}`,
          dropoff: { name: stops[stops.length - 1].name, ...(stops[stops.length - 1].lat !== undefined ? { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng } : {}) } },
      });
      await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
        [randomUUID(), a.tenantId, task.id, r.driver_worker_id, r.asset_id, from.toISOString(), to.toISOString(), a.userId]);
      await c.query(`INSERT INTO ops.shuttle_trip (id, tenant_id, route_id, trip_date, task_id, asset_id, driver_worker_id, riders_planned, capacity, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), a.tenantId, r.id, day, task.id, r.asset_id, r.driver_worker_id, riders, capacity, a.userId]);
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await this.event(c, a, task.id, 'ready', 'assigned', `trip ${r.code} ${day}`);
      await c.query('RELEASE SAVEPOINT trip');
      return null;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT trip');
      const k = (e as { constraint?: string }).constraint;
      if (k === 'no_asset_overlap') return 'vehicle_booked';
      if (k === 'no_worker_overlap') return 'driver_booked';
      throw e;
    }
  }

  private async event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
  }
}
