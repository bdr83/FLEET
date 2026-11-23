import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { isoDow, parseDays } from '../shuttle/shuttle';
import { Bin, binCount, finishBlock, LATE_START_MIN, MISS_REASONS, MISS_STREAK, parseBins, parseNetKg, VISIT_EVENTS, VisitEvent, visitRule, WASTE, WASTE_TYPES } from './waste';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;
const hm = (x: unknown, f: string) => {
  if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new BadRequestException(`${f} must be HH:MM`);
  return x;
};

const ROUTE_SQL = `
  SELECT r.id, r.legal_entity_id, r.code, r.name, r.waste_type, to_char(r.start_time, 'HH24:MI') AS start_time, r.duration_min, r.days, r.facility,
         r.asset_id, a.plate_no, r.driver_worker_id, w.display_name AS driver_name, r.active, r.version,
         (SELECT count(*)::int FROM ops.wst_point p WHERE p.route_id = r.id AND p.active) AS points
    FROM ops.wst_route r LEFT JOIN fleet.asset a ON a.id = r.asset_id LEFT JOIN workforce.worker w ON w.id = r.driver_worker_id`;

const POINT_COLS = `p.id, p.route_id, p.seq, p.customer_id, cu.name AS customer_name, p.name, p.area, p.lat, p.lng, p.bins, p.note, p.active`;

// each point's standing mark on a run is the latest one
const MARKS = `SELECT DISTINCT ON (x.run_id, x.point_id) x.run_id, x.point_id, x.event, x.bins, x.reason, x.note, x.occurred_at, x.source FROM ops.wst_visit x`;

const RUN_SQL = `
  SELECT rn.id, rn.route_id, r.code AS route_code, r.name AS route_name, r.waste_type, rn.run_date::text AS run_date, rn.task_id, t.status,
         lower(t.service_window) AS start_at, upper(t.service_window) AS end_by, rn.asset_id, a.plate_no, rn.driver_worker_id, w.display_name AS driver_name, rn.points_planned,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'in_progress') AS started_at,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') AS ended_at,
         (SELECT count(*)::int FROM (${MARKS} WHERE x.run_id = rn.id ORDER BY x.run_id, x.point_id, x.occurred_at DESC) m WHERE m.event = 'collected') AS collected,
         (SELECT count(*)::int FROM (${MARKS} WHERE x.run_id = rn.id ORDER BY x.run_id, x.point_id, x.occurred_at DESC) m WHERE m.event = 'missed') AS missed,
         (SELECT coalesce(sum(m.bins), 0)::int FROM (${MARKS} WHERE x.run_id = rn.id ORDER BY x.run_id, x.point_id, x.occurred_at DESC) m WHERE m.event = 'collected') AS bins,
         (SELECT count(*)::int FROM ops.wst_dump d WHERE d.run_id = rn.id) AS dumps,
         (SELECT coalesce(sum(d.net_kg), 0)::float FROM ops.wst_dump d WHERE d.run_id = rn.id) AS net_kg
    FROM ops.wst_run rn JOIN ops.wst_route r ON r.id = rn.route_id JOIN ops.task t ON t.id = rn.task_id
    JOIN fleet.asset a ON a.id = rn.asset_id JOIN workforce.worker w ON w.id = rn.driver_worker_id`;

interface RouteRow { id: string; legal_entity_id: string; code: string; name: string; waste_type: string; start_time: string; duration_min: number; days: number[]; facility: string | null; asset_id: string | null; driver_worker_id: string | null; active: boolean; version: number }

/** The points of a run with their bins and standing mark: the round sheet the driver and the office see. */
export async function roundSheet(c: PoolClient, runId: string) {
  return (await c.query(
    `SELECT ${POINT_COLS}, m.event, m.bins AS bins_emptied, m.reason, m.note AS mark_note, m.occurred_at AS marked_at, m.source
       FROM ops.wst_run rn JOIN ops.wst_point p ON p.route_id = rn.route_id LEFT JOIN crm.customer cu ON cu.id = p.customer_id
       LEFT JOIN (${MARKS} WHERE x.run_id = $1 ORDER BY x.run_id, x.point_id, x.occurred_at DESC) m ON m.point_id = p.id
      WHERE rn.id = $1 AND (p.active OR m.event IS NOT NULL) ORDER BY p.seq, p.name`, [runId])).rows;
}

const runOf = async (c: PoolClient, taskId: string) =>
  (await c.query('SELECT rn.id, rn.route_id, t.status FROM ops.wst_run rn JOIN ops.task t ON t.id = rn.task_id WHERE rn.task_id = $1', [taskId])).rows[0] as { id: string; route_id: string; status: string } | undefined;

const allowed = (source: 'driver' | 'office') => (source === 'driver' ? ['in_progress'] : ['assigned', 'accepted', 'in_progress', 'completed', 'reviewed']);

/** Marks a point collected (bins emptied) or missed (with a reason), by the driver from the app or the office. Returns a reject code. */
export async function markVisit(c: PoolClient, a: AuthContext, x: { taskId: string; pointId: string; event: VisitEvent; bins: number | null; reason: string | null; note: string | null; at: Date; source: 'driver' | 'office'; clientOpId: string }): Promise<string | null> {
  const rn = await runOf(c, x.taskId);
  if (!rn) return 'not_supported';
  if (!allowed(x.source).includes(rn.status)) return 'invalid_transition';
  const p = (await c.query('SELECT bins FROM ops.wst_point WHERE id = $1 AND route_id = $2', [x.pointId, rn.route_id])).rows[0];
  if (!p) return 'unknown_point';
  const bad = visitRule(x.event, x.bins, x.reason, binCount(p.bins as Bin[]));
  if (bad) return bad;
  await c.query(`INSERT INTO ops.wst_visit (id, tenant_id, run_id, point_id, event, bins, reason, note, occurred_at, source, actor_id, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), a.tenantId, rn.id, x.pointId, x.event, x.event === 'collected' ? x.bins : null, x.event === 'missed' ? x.reason : null, x.note, x.at, x.source, a.userId || null, x.clientOpId]);
  return null;
}

/** Records a tip at the landfill or sorting site: the weighbridge ticket and the net weight. Returns a reject code. */
export async function addDump(c: PoolClient, a: AuthContext, x: { taskId: string; ticketNo: string | null; facility: string | null; netKg: number | null; at: Date; source: 'driver' | 'office'; clientOpId: string }): Promise<string | null> {
  const rn = await runOf(c, x.taskId);
  if (!rn) return 'not_supported';
  if (!allowed(x.source).includes(rn.status)) return 'invalid_transition';
  if (!x.ticketNo) return 'ticket_required';
  if (x.netKg === null) return 'weight_required';
  if ((await c.query('SELECT 1 FROM ops.wst_dump WHERE run_id = $1 AND ticket_no = $2', [rn.id, x.ticketNo])).rowCount) return 'ticket_already_recorded';
  const facility = x.facility ?? (await c.query('SELECT r.facility FROM ops.wst_route r WHERE r.id = $1', [rn.route_id])).rows[0].facility;
  await c.query(`INSERT INTO ops.wst_dump (id, tenant_id, run_id, ticket_no, facility, net_kg, occurred_at, source, actor_id, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), a.tenantId, rn.id, x.ticketNo, facility, x.netKg, x.at, x.source, a.userId || null, x.clientOpId]);
  return null;
}

/** A run ends with every point marked and, if anything was collected, at least one weighbridge ticket. */
export async function wasteFinish(c: PoolClient, taskId: string): Promise<string | null> {
  const rn = await runOf(c, taskId);
  if (!rn) return null;
  const sheet = await roundSheet(c, rn.id);
  const dumps = (await c.query('SELECT count(*)::int AS n FROM ops.wst_dump WHERE run_id = $1', [rn.id])).rows[0].n;
  return finishBlock(sheet.filter((p) => p.active).map((p) => p.id), sheet.filter((p) => p.event).map((p) => ({ point_id: p.id, event: p.event })), dumps);
}

@Controller('v1/waste')
@UseGuards(AuthGuard)
@Pack('waste')
export class WasteController {
  constructor(private readonly db: DbService) {}

  // ---- routes and points ----

  @Get('routes')
  @Perm('tasks:read')
  routes(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`${ROUTE_SQL} ORDER BY r.active DESC, r.code`)).rows }));
  }

  @Post('routes')
  @Perm('tasks:assign')
  addRoute(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const code = String(b?.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(code)) throw new BadRequestException('code: 1-12 letters, digits, - or _');
    const r = this.parseRoute(b, null);
    return this.db.withTenant(a, async (c) => {
      await this.checkRefs(c, le, r);
      const id = randomUUID();
      try {
        await c.query(`INSERT INTO ops.wst_route (id, tenant_id, legal_entity_id, code, name, waste_type, start_time, duration_min, days, facility, asset_id, driver_worker_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, a.tenantId, le, code, r.name, r.waste_type, r.start_time, r.duration_min, r.days, r.facility, r.asset_id, r.driver_worker_id]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'wst_route_tenant_id_code_key') throw new ConflictException('route code already used');
        pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'waste.route_created', targetType: 'wst_route', targetId: id, after: { code } });
      return (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0];
    });
  }

  /** Changes a route (version required). Runs already generated keep their truck, driver and time. */
  @Patch('routes/:id')
  @Perm('tasks:assign')
  editRoute(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0] as RouteRow;
      if (!before) throw new NotFoundException();
      if (before.version !== ver) throw new ConflictException('route changed meanwhile; reload');
      const r = this.parseRoute(b, before);
      await this.checkRefs(c, before.legal_entity_id, r);
      const active = b?.active === undefined ? before.active : b.active === true;
      await c.query(`UPDATE ops.wst_route SET name = $2, waste_type = $3, start_time = $4, duration_min = $5, days = $6, facility = $7, asset_id = $8, driver_worker_id = $9, active = $10,
          version = version + 1 WHERE id = $1`, [id, r.name, r.waste_type, r.start_time, r.duration_min, r.days, r.facility, r.asset_id, r.driver_worker_id, active]);
      const after = (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'waste.route_changed', targetType: 'wst_route', targetId: id, before, after });
      return after;
    });
  }

  @Get('routes/:id/points')
  @Perm('tasks:read')
  points(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT ${POINT_COLS} FROM ops.wst_point p LEFT JOIN crm.customer cu ON cu.id = p.customer_id WHERE p.route_id = $1 ORDER BY p.active DESC, p.seq, p.name`, [id])).rows,
    }));
  }

  /** Adds a collection point at the end of the route (or at seq, moving the later ones down). */
  @Post('routes/:id/points')
  @Perm('tasks:assign')
  addPoint(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const p = this.parsePoint(b);
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query('SELECT legal_entity_id FROM ops.wst_route WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundException();
      if (p.customer_id && !(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [p.customer_id, r.legal_entity_id])).rowCount) throw new BadRequestException('unknown customer_id');
      const n = (await c.query('SELECT count(*)::int AS n FROM ops.wst_point WHERE route_id = $1 AND active', [id])).rows[0].n;
      if (n >= 200) throw new ConflictException('a route holds up to 200 points');
      const seq = Math.min(v.int(b?.seq, 'seq', 1, 200) ?? n + 1, n + 1);
      await c.query('UPDATE ops.wst_point SET seq = seq + 1 WHERE route_id = $1 AND active AND seq >= $2', [id, seq]);
      const pid = randomUUID();
      await c.query(`INSERT INTO ops.wst_point (id, tenant_id, route_id, seq, customer_id, name, area, lat, lng, bins, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [pid, a.tenantId, id, seq, p.customer_id, p.name, p.area, p.lat, p.lng, JSON.stringify(p.bins), p.note]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'waste.point_added', targetType: 'wst_point', targetId: pid, after: { route: id, seq, name: p.name } });
      return (await c.query(`SELECT ${POINT_COLS} FROM ops.wst_point p LEFT JOIN crm.customer cu ON cu.id = p.customer_id WHERE p.id = $1`, [pid])).rows[0];
    });
  }

  /** Changes a point's bins, name or note, or takes it off the route (active false). */
  @Patch('points/:id')
  @Perm('tasks:assign')
  editPoint(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query('SELECT * FROM ops.wst_point WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!x) throw new NotFoundException();
      const bins = b?.bins === undefined ? x.bins : parseBins(b.bins);
      const name = v.str(b?.name, 'name', { max: 120 }) ?? x.name;
      const note = b?.note === undefined ? x.note : v.str(b.note, 'note', { max: 300 });
      if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
      const active = b?.active ?? x.active;
      if (x.active && !active) await c.query('UPDATE ops.wst_point SET seq = seq - 1 WHERE route_id = $1 AND active AND seq > $2', [x.route_id, x.seq]);
      await c.query('UPDATE ops.wst_point SET bins = $2, name = $3, note = $4, active = $5 WHERE id = $1', [id, JSON.stringify(bins), name, note, active]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'waste.point_changed', targetType: 'wst_point', targetId: id, before: x, after: { bins, name, note, active } });
      return (await c.query(`SELECT ${POINT_COLS} FROM ops.wst_point p LEFT JOIN crm.customer cu ON cu.id = p.customer_id WHERE p.id = $1`, [id])).rows[0];
    });
  }

  // ---- runs ----

  /**
   * Generates the runs of a day for the routes that run on it. Idempotent: a route that already has its run is reported
   * as existing. A route without a truck, driver or points, or whose truck or driver is booked elsewhere, is skipped with
   * the reason.
   */
  @Post('runs/generate')
  @Perm('tasks:assign')
  generate(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const day = v.date(b?.date, 'date') ?? kwToday();
    const dow = isoDow(day);
    return this.db.withTenant(a, async (c) => {
      const routes = (await c.query(`${ROUTE_SQL} WHERE r.active AND $1 = ANY (r.days) ORDER BY to_char(r.start_time, 'HH24:MI'), r.code`, [dow])).rows as (RouteRow & { points: number })[];
      const created: string[] = [], existing: string[] = [], skipped: { code: string; reason: string }[] = [];
      for (const r of routes) {
        if ((await c.query('SELECT 1 FROM ops.wst_run WHERE route_id = $1 AND run_date = $2', [r.id, day])).rowCount) { existing.push(r.code); continue; }
        if (!r.asset_id) { skipped.push({ code: r.code, reason: 'no_vehicle' }); continue; }
        if (!r.driver_worker_id) { skipped.push({ code: r.code, reason: 'no_driver' }); continue; }
        if (!r.points) { skipped.push({ code: r.code, reason: 'no_points' }); continue; }
        const why = await this.runFor(c, a, r, day);
        if (why) skipped.push({ code: r.code, reason: why }); else created.push(r.code);
      }
      return { date: day, created, existing, skipped };
    });
  }

  @Get('runs')
  @Perm('tasks:read')
  runs(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({ date: day, data: (await c.query(`${RUN_SQL} WHERE rn.run_date = $1 ORDER BY lower(t.service_window), r.code`, [day])).rows }));
  }

  @Get('runs/:id')
  @Perm('tasks:read')
  run(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.runDetail(c, id));
  }

  /** The office records or corrects a point (e.g. the driver called it in). */
  @Post('runs/:id/visit')
  @HttpCode(200)
  @Perm('tasks:assign')
  visit(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const point = v.uuid(b?.point_id, 'point_id', { required: true })!;
    const event = v.oneOf(b?.event, 'event', VISIT_EVENTS, { required: true })!;
    const bins = v.int(b?.bins, 'bins', 0, 200);
    const reason = v.oneOf(b?.reason, 'reason', MISS_REASONS);
    const note = v.str(b?.note, 'note', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT task_id FROM ops.wst_run WHERE id = $1', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const bad = await markVisit(c, a, { taskId: t.task_id, pointId: point, event, bins, reason, note, at: new Date(), source: 'office', clientOpId: randomUUID() });
      if (bad === 'unknown_point') throw new BadRequestException('point is not on this route');
      if (bad) throw new ConflictException(bad);
      return this.runDetail(c, id);
    });
  }

  /** The office records a weighbridge ticket (e.g. from the landfill's daily statement). */
  @Post('runs/:id/dump')
  @HttpCode(200)
  @Perm('tasks:assign')
  dump(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ticket = v.str(b?.ticket_no, 'ticket_no', { required: true, max: 40 })!.trim();
    const facility = v.str(b?.facility, 'facility', { max: 120 });
    const net = parseNetKg(b?.net_kg, 'net_kg', true);
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT task_id FROM ops.wst_run WHERE id = $1', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const bad = await addDump(c, a, { taskId: t.task_id, ticketNo: ticket, facility, netKg: net, at: new Date(), source: 'office', clientOpId: randomUUID() });
      if (bad) throw new ConflictException(bad);
      return this.runDetail(c, id);
    });
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT t.id, t.status FROM ops.wst_run rn JOIN ops.task t ON t.id = rn.task_id WHERE rn.id = $1 FOR UPDATE OF t', [id])).rows[0];
      if (!t) throw new NotFoundException();
      if (t.status !== 'canceled') {
        if (!['ready', 'assigned', 'accepted'].includes(t.status)) throw new ConflictException('the run is under way or closed');
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t.id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [t.id]);
        await this.event(c, a, t.id, t.status, 'canceled', reason);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'waste.run_canceled', targetType: 'wst_run', targetId: id, after: { reason } });
      }
      return this.runDetail(c, id);
    });
  }

  // ---- watch and report ----

  /**
   * For a day: runs late to start, routes due without a run (or a truck or driver), points missed that day, points missed
   * on the last runs in a row, and points without a customer.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const runs = (await c.query(`${RUN_SQL} WHERE rn.run_date = $1`, [day])).rows;
      const late = runs.filter((r) => ['assigned', 'accepted'].includes(r.status) && new Date(r.start_at).getTime() + LATE_START_MIN * 60_000 < Date.now());
      const due = (await c.query(`${ROUTE_SQL} WHERE r.active AND $1 = ANY (r.days) AND NOT EXISTS (SELECT 1 FROM ops.wst_run x WHERE x.route_id = r.id AND x.run_date = $2) ORDER BY r.code`, [isoDow(day), day])).rows;
      const missed = (await c.query(
        `SELECT m.point_id, p.name, p.area, cu.name AS customer_name, r.code AS route_code, m.reason, m.note, m.occurred_at
           FROM (${MARKS} JOIN ops.wst_run rn ON rn.id = x.run_id WHERE rn.run_date = $1 ORDER BY x.run_id, x.point_id, x.occurred_at DESC) m
           JOIN ops.wst_point p ON p.id = m.point_id JOIN ops.wst_route r ON r.id = p.route_id LEFT JOIN crm.customer cu ON cu.id = p.customer_id
          WHERE m.event = 'missed' ORDER BY r.code, p.seq`, [day])).rows;
      // the last MISS_STREAK runs of each point's route up to the day, all missed
      const streak = (await c.query(
        `WITH last AS (SELECT rn.id, rn.route_id, row_number() OVER (PARTITION BY rn.route_id ORDER BY rn.run_date DESC) AS k
                         FROM ops.wst_run rn JOIN ops.task t ON t.id = rn.task_id WHERE rn.run_date <= $1 AND t.status NOT IN ('canceled','failed'))
         SELECT p.id AS point_id, p.name, cu.name AS customer_name, r.code AS route_code, count(*)::int AS runs
           FROM ops.wst_point p JOIN ops.wst_route r ON r.id = p.route_id LEFT JOIN crm.customer cu ON cu.id = p.customer_id
           JOIN last l ON l.route_id = p.route_id AND l.k <= $2
           JOIN LATERAL (SELECT x.event FROM ops.wst_visit x WHERE x.run_id = l.id AND x.point_id = p.id ORDER BY x.occurred_at DESC LIMIT 1) m ON m.event = 'missed'
          WHERE p.active GROUP BY p.id, p.name, cu.name, r.code HAVING count(*) >= $2 ORDER BY r.code, p.name`, [day, MISS_STREAK])).rows;
      return {
        date: day,
        late_start: late,
        not_generated: due.filter((r) => r.asset_id && r.driver_worker_id),
        no_vehicle_or_driver: due.filter((r) => !r.asset_id || !r.driver_worker_id),
        missed,
        repeat_missed: streak,
      };
    });
  }

  /** For a period: runs, points collected and missed, bins emptied and tonnage, in total and per customer (tonnage per route). */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const runs = (await c.query(`${RUN_SQL} WHERE rn.run_date BETWEEN $1 AND $2 AND t.status <> 'canceled'`, [f, t])).rows;
      const customers = (await c.query(
        `SELECT coalesce(cu.name, '—') AS customer_name, count(*) FILTER (WHERE m.event = 'collected')::int AS collected, count(*) FILTER (WHERE m.event = 'missed')::int AS missed,
                coalesce(sum(m.bins) FILTER (WHERE m.event = 'collected'), 0)::int AS bins
           FROM (${MARKS} JOIN ops.wst_run rn ON rn.id = x.run_id WHERE rn.run_date BETWEEN $1 AND $2 ORDER BY x.run_id, x.point_id, x.occurred_at DESC) m
           JOIN ops.wst_point p ON p.id = m.point_id LEFT JOIN crm.customer cu ON cu.id = p.customer_id
          GROUP BY cu.name ORDER BY collected DESC, customer_name`, [f, t])).rows;
      const by = new Map<string, typeof runs>();
      for (const r of runs) by.set(r.route_code, [...(by.get(r.route_code) ?? []), r]);
      const sum = (l: typeof runs) => ({ runs: l.length, completed: l.filter((r) => ['completed', 'reviewed', 'invoiced'].includes(r.status)).length,
        collected: l.reduce((n, r) => n + r.collected, 0), missed: l.reduce((n, r) => n + r.missed, 0), bins: l.reduce((n, r) => n + r.bins, 0),
        dumps: l.reduce((n, r) => n + r.dumps, 0), tonnes: Math.round(l.reduce((n, r) => n + r.net_kg, 0) / 100) / 10 });
      return {
        from: f, to: t, totals: sum(runs),
        routes: [...by.entries()].map(([code, l]) => ({ route_code: code, route_name: l[0].route_name, waste_type: l[0].waste_type, ...sum(l) })).sort((x, y) => x.route_code.localeCompare(y.route_code)),
        customers,
      };
    });
  }

  // ---- helpers ----

  private async runDetail(c: PoolClient, id: string) {
    const r = (await c.query(`${RUN_SQL} WHERE rn.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    const tickets = (await c.query('SELECT ticket_no, facility, net_kg::float, occurred_at, source FROM ops.wst_dump WHERE run_id = $1 ORDER BY occurred_at', [id])).rows;
    return { ...r, points: await roundSheet(c, id), tickets };
  }

  private parseRoute(b: Record<string, unknown>, prev: RouteRow | null) {
    const pick = <T>(k: string, f: (x: unknown) => T, old: T | undefined): T => (b?.[k] === undefined && prev ? (old as T) : f(b?.[k]));
    return {
      name: pick('name', (x) => v.str(x, 'name', { required: true, max: 120 })!, prev?.name),
      waste_type: pick('waste_type', (x) => v.oneOf(x, 'waste_type', WASTE_TYPES) ?? 'general', prev?.waste_type),
      start_time: pick('start_time', (x) => hm(x, 'start_time'), prev?.start_time),
      duration_min: pick('duration_min', (x) => v.int(x, 'duration_min', 30, 960) ?? 480, prev?.duration_min),
      days: pick('days', (x) => (x === undefined || x === null ? [1, 2, 3, 4, 5, 6, 7] : parseDays(x)), prev?.days),
      facility: pick('facility', (x) => v.str(x, 'facility', { max: 120 }), prev?.facility),
      asset_id: pick('asset_id', (x) => v.uuid(x, 'asset_id'), prev?.asset_id),
      driver_worker_id: pick('driver_worker_id', (x) => v.uuid(x, 'driver_worker_id'), prev?.driver_worker_id),
    };
  }

  private parsePoint(b: Record<string, unknown>) {
    const lat = b?.lat === undefined || b?.lat === null ? null : Number(b.lat);
    const lng = b?.lng === undefined || b?.lng === null ? null : Number(b.lng);
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng!) || Math.abs(lng!) > 180))) throw new BadRequestException('lat/lng invalid');
    return {
      name: v.str(b?.name, 'name', { required: true, max: 120 })!.trim(), area: v.str(b?.area, 'area', { max: 80 }), customer_id: v.uuid(b?.customer_id, 'customer_id'),
      bins: parseBins(b?.bins), note: v.str(b?.note, 'note', { max: 300 }), lat, lng,
    };
  }

  private async checkRefs(c: PoolClient, le: string, r: { asset_id: string | null; driver_worker_id: string | null }) {
    if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
    if (r.asset_id && !(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2', [r.asset_id, le])).rowCount) throw new BadRequestException('unknown asset_id');
    if (r.driver_worker_id && !(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND kind IN ('driver','courier')`, [r.driver_worker_id, le])).rowCount) {
      throw new BadRequestException('unknown driver_worker_id');
    }
  }

  /** One route's run on a day: the task, the exclusive booking of truck and driver, and the run row. Returns a skip reason or null. */
  private async runFor(c: PoolClient, a: AuthContext, r: RouteRow & { points: number }, day: string): Promise<string | null> {
    const asset = (await c.query('SELECT status FROM fleet.asset WHERE id = $1', [r.asset_id])).rows[0];
    if (!asset || ['out_of_service', 'retired'].includes(asset.status)) return 'vehicle_out_of_service';
    if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND status = 'active'`, [r.driver_worker_id])).rowCount) return 'driver_inactive';
    const win = (await c.query(`SELECT ($1::date + $2::time) AT TIME ZONE le.timezone AS f FROM org.legal_entity le WHERE le.id = $3`, [day, r.start_time, r.legal_entity_id])).rows[0];
    const from = new Date(win.f), to = new Date(from.getTime() + r.duration_min * 60_000);
    if (to.getTime() < Date.now()) return 'past';
    const first = (await c.query('SELECT name, area FROM ops.wst_point WHERE route_id = $1 AND active ORDER BY seq LIMIT 1', [r.id])).rows[0];
    await c.query('SAVEPOINT run');
    try {
      const task = await createTask(c, a, {
        le: r.legal_entity_id, pack: WASTE, branch: null, status: 'ready', customer: null, site: null, ref: `WR-${r.code}-${day.replace(/-/g, '')}`,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { kind: 'round', route_code: r.code, route_name: r.name, waste_type: r.waste_type, start_time: r.start_time, facility: r.facility, points: r.points,
          address: [first?.name, first?.area].filter(Boolean).join('، ') },
      });
      await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
        [randomUUID(), a.tenantId, task.id, r.driver_worker_id, r.asset_id, from.toISOString(), to.toISOString(), a.userId]);
      await c.query(`INSERT INTO ops.wst_run (id, tenant_id, route_id, run_date, task_id, asset_id, driver_worker_id, points_planned, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), a.tenantId, r.id, day, task.id, r.asset_id, r.driver_worker_id, r.points, a.userId]);
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await this.event(c, a, task.id, 'ready', 'assigned', `round ${r.code} ${day}`);
      await c.query('RELEASE SAVEPOINT run');
      return null;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT run');
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
