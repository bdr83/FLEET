import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { v } from '../../common/validate';
import {
  CERT_WARN_DAYS, ChartRow, CRANE_DOC, isCritical, LIFT_EVENTS, LiftEvent, liftRule, OPERATOR_DOC, parseChart, parseWind, ratedAt, RIGGER_DOC, utilization,
} from './cranes';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;

const LIFT_SQL = `
  SELECT l.id, l.ref, l.hire_id, h.ref AS hire_ref, h.customer_id, cu.name AS customer_name, h.site, h.asset_id, fa.plate_no, l.task_id, t.status AS day_status,
         l.lift_date::text AS lift_date, l.lift_time::text, l.description, l.load_t::float, l.radius_m::float, l.rated_t::float, l.utilization::float, l.tandem, l.over_people, l.critical,
         l.rigger_worker_id, rw.display_name AS rigger_name, h.operator_worker_id, ow.display_name AS operator_name, l.approved_by, coalesce(ap.display_name, ap.email, ap.phone) AS approved_by_name,
         l.approved_at, l.status, l.done_at, l.wind_ms::float, l.abort_reason, cs.wind_limit_ms::float, l.created_at, l.version
    FROM ops.crane_lift l JOIN ops.equip_hire h ON h.id = l.hire_id JOIN crm.customer cu ON cu.id = h.customer_id JOIN fleet.asset fa ON fa.id = h.asset_id
    JOIN ops.task t ON t.id = l.task_id LEFT JOIN ops.crane_spec cs ON cs.asset_id = h.asset_id
    LEFT JOIN workforce.worker rw ON rw.id = l.rigger_worker_id LEFT JOIN workforce.worker ow ON ow.id = h.operator_worker_id
    LEFT JOIN org.app_user ap ON ap.id = l.approved_by`;

const validDoc = async (c: PoolClient, col: 'worker_id' | 'asset_id', id: string, type: string, day: string) =>
  !!(await c.query(`SELECT 1 FROM core.document WHERE ${col} = $1 AND doc_type = $2 AND archived_at IS NULL AND (expires_on IS NULL OR expires_on >= $3::date)`, [id, type, day])).rowCount;

/**
 * Records a lift done (with the wind speed) or aborted (with a reason), by the operator from the app or by the office.
 * Returns a reject code.
 */
export async function markLift(c: PoolClient, a: AuthContext, x: { taskId: string | null; liftId: string; event: LiftEvent; wind: number | null; note: string | null; at: Date; source: 'driver' | 'office'; clientOpId: string }): Promise<string | null> {
  const l = (await c.query(`SELECT l.id, l.task_id, l.status, l.critical, l.approved_at, coalesce(cs.wind_limit_ms, 9.8)::float AS wind_limit FROM ops.crane_lift l JOIN ops.equip_hire h ON h.id = l.hire_id
                             LEFT JOIN ops.crane_spec cs ON cs.asset_id = h.asset_id WHERE l.id = $1 FOR UPDATE OF l`, [x.liftId])).rows[0];
  if (!l || (x.taskId && l.task_id !== x.taskId)) return 'unknown_lift';
  const bad = liftRule(l, x.event, x.wind, x.note, l.wind_limit);
  if (bad) return bad;
  await c.query(`INSERT INTO ops.crane_lift_event (id, tenant_id, lift_id, event, wind_ms, note, occurred_at, source, actor_id, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), a.tenantId, l.id, x.event, x.wind, x.note, x.at, x.source, a.userId, x.clientOpId]);
  if (x.event === 'done') await c.query(`UPDATE ops.crane_lift SET status = 'done', done_at = $2, wind_ms = $3, version = version + 1 WHERE id = $1`, [l.id, x.at, x.wind]);
  else await c.query(`UPDATE ops.crane_lift SET status = 'aborted', wind_ms = $2, abort_reason = $3, version = version + 1 WHERE id = $1`, [l.id, x.wind, x.note]);
  return null;
}

/** A working day cannot end with a planned lift still open. */
export async function liftsOpen(c: PoolClient, taskId: string): Promise<string | null> {
  return (await c.query(`SELECT 1 FROM ops.crane_lift WHERE task_id = $1 AND status = 'planned'`, [taskId])).rowCount ? 'lifts_open' : null;
}

@Controller('v1/cranes')
@UseGuards(AuthGuard)
@Pack('cranes')
export class CranesController {
  constructor(private readonly db: DbService) {}

  // ---- cranes and load charts ----

  @Get('fleet')
  @Perm('tasks:read')
  fleet(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT fa.id AS asset_id, fa.plate_no, fa.make, fa.model, fa.status, cs.max_capacity_t::float, cs.boom_m::float, cs.wind_limit_ms::float, cs.chart,
                (SELECT max(d.expires_on)::text FROM core.document d WHERE d.asset_id = fa.id AND d.doc_type = $1 AND d.archived_at IS NULL) AS cert_expires_on
           FROM fleet.asset fa LEFT JOIN ops.crane_spec cs ON cs.asset_id = fa.id WHERE fa.asset_type = 'crane' AND fa.status <> 'retired' ORDER BY fa.plate_no`, [CRANE_DOC])).rows,
    }));
  }

  /** A crane's specification: maximum capacity, boom, wind limit (m/s) and the load chart from the manufacturer. */
  @Put('fleet/:assetId')
  @Perm('fleet:write')
  setSpec(@Auth() a: AuthContext, @Param('assetId', new ParseUUIDPipe()) assetId: string, @Body() b: Record<string, unknown>) {
    const max = Number(b?.max_capacity_t);
    if (!Number.isFinite(max) || max <= 0 || max > 3000) throw new BadRequestException('max_capacity_t required (0-3000 t)');
    const boom = b?.boom_m === undefined || b?.boom_m === null ? null : Number(b.boom_m);
    if (boom !== null && (!Number.isFinite(boom) || boom <= 0 || boom > 200)) throw new BadRequestException('boom_m must be 0-200');
    const wind = parseWind(b?.wind_limit_ms, 'wind_limit_ms') ?? 9.8;
    if (wind < 3 || wind > 30) throw new BadRequestException('wind_limit_ms must be 3-30');
    const chart = parseChart(b?.chart);
    if (chart[0].capacity_t > max) throw new BadRequestException('the chart is above the maximum capacity');
    return this.db.withTenant(a, async (c) => {
      const as = (await c.query('SELECT asset_type FROM fleet.asset WHERE id = $1', [assetId])).rows[0];
      if (!as) throw new NotFoundException();
      if (as.asset_type !== 'crane') throw new BadRequestException('not_a_crane: the asset type is not crane');
      await c.query(`INSERT INTO ops.crane_spec (asset_id, tenant_id, max_capacity_t, boom_m, wind_limit_ms, chart) VALUES ($1,$2,$3,$4,$5,$6)
                     ON CONFLICT (asset_id) DO UPDATE SET max_capacity_t = EXCLUDED.max_capacity_t, boom_m = EXCLUDED.boom_m, wind_limit_ms = EXCLUDED.wind_limit_ms, chart = EXCLUDED.chart, updated_at = now()`,
        [assetId, a.tenantId, max, boom, wind, JSON.stringify(chart)]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'cranes.spec_set', targetType: 'asset', targetId: assetId, after: { max, boom, wind, rows: chart.length } });
      return { asset_id: assetId, max_capacity_t: max, boom_m: boom, wind_limit_ms: wind, chart };
    });
  }

  // ---- lift plans ----

  @Get('lifts')
  @Perm('tasks:read')
  lifts(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({ date: day, data: (await c.query(`${LIFT_SQL} WHERE l.lift_date = $1 ORDER BY l.lift_time NULLS LAST, l.ref`, [day])).rows }));
  }

  /**
   * A lift plan on a working day of a crane hire: what is lifted, the load with rigging, the radius, the rigger; tandem or
   * over people. The rated capacity comes from the crane's chart; over 100% or beyond the chart is refused.
   */
  @Post('lifts')
  @Perm('tasks:assign')
  addLift(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const hireId = v.uuid(b?.hire_id, 'hire_id', { required: true })!;
    const day = v.date(b?.lift_date, 'lift_date');
    if (!day) throw new BadRequestException('lift_date required');
    const time = v.str(b?.lift_time, 'lift_time', { max: 5 });
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequestException('lift_time must be HH:MM');
    const desc = v.str(b?.description, 'description', { required: true, max: 300 })!;
    const load = Number(b?.load_t), radius = Number(b?.radius_m);
    if (!Number.isFinite(load) || load <= 0 || load > 3000) throw new BadRequestException('load_t required (t, with the rigging)');
    if (!Number.isFinite(radius) || radius <= 0 || radius > 200) throw new BadRequestException('radius_m required (0-200)');
    const rigger = v.uuid(b?.rigger_worker_id, 'rigger_worker_id', { required: true })!;
    const tandem = b?.tandem === true, overPeople = b?.over_people === true;
    return this.db.withTenant(a, async (c) => {
      const h = (await c.query(`SELECT h.id, h.ref, h.legal_entity_id, h.asset_id, h.operator_worker_id, h.canceled_at, fa.asset_type, cs.chart
                                  FROM ops.equip_hire h JOIN fleet.asset fa ON fa.id = h.asset_id LEFT JOIN ops.crane_spec cs ON cs.asset_id = h.asset_id WHERE h.id = $1`, [hireId])).rows[0];
      if (!h) throw new BadRequestException('unknown hire_id');
      if (h.canceled_at) throw new ConflictException('the hire is canceled');
      if (h.asset_type !== 'crane') throw new BadRequestException('not_a_crane: the hired machine is not a crane');
      if (!h.chart) throw new ConflictException('no_chart: enter the crane load chart first');
      const d = (await c.query(`SELECT d.task_id, t.status FROM ops.equip_day d JOIN ops.task t ON t.id = d.task_id WHERE d.hire_id = $1 AND d.work_date = $2`, [hireId, day])).rows[0];
      if (!d || ['canceled', 'failed'].includes(d.status)) throw new ConflictException('no_work_day: the hire has no working day on that date');
      if (['completed', 'reviewed', 'invoiced'].includes(d.status)) throw new ConflictException('the working day is over');
      const rated = ratedAt(h.chart as ChartRow[], radius);
      if (rated === null) throw new ConflictException('out_of_chart: the radius is beyond the load chart');
      const pct = utilization(load, rated);
      if (pct > 100) throw new ConflictException(`over_capacity: ${load} t at ${radius} m is ${pct}% of the rated ${rated} t`);
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [rigger, h.legal_entity_id])).rowCount) throw new BadRequestException('unknown rigger_worker_id');
      if (!(await validDoc(c, 'asset_id', h.asset_id, CRANE_DOC, day))) throw new ConflictException('crane_cert: the crane has no valid inspection certificate that day');
      if (h.operator_worker_id && !(await validDoc(c, 'worker_id', h.operator_worker_id, OPERATOR_DOC, day))) throw new ConflictException('operator_cert: the operator has no valid crane operator card that day');
      if (!(await validDoc(c, 'worker_id', rigger, RIGGER_DOC, day))) throw new ConflictException('rigger_cert: the rigger has no valid card that day');
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.crane_lift`)).rows[0].n;
      const id = randomUUID(), ref = `LP-${n}`, critical = isCritical(pct, tandem, overPeople);
      await c.query(`INSERT INTO ops.crane_lift (id, tenant_id, ref, hire_id, task_id, lift_date, lift_time, description, load_t, radius_m, rated_t, utilization, tandem, over_people, critical, rigger_worker_id, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, a.tenantId, ref, hireId, d.task_id, day, time, desc, load, radius, rated, pct, tandem, overPeople, critical, rigger, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'cranes.lift_added', targetType: 'crane_lift', targetId: id, after: { ref, hire: h.ref, load, radius, rated, pct, critical } });
      return this.lift(c, id);
    });
  }

  @Get('lifts/:id')
  @Perm('tasks:read')
  getLift(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.lift(c, id));
  }

  /** The appointed person approves a critical lift plan. */
  @Post('lifts/:id/approve')
  @HttpCode(200)
  @Perm('tasks:assign')
  approve(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const l = await this.lift(c, id, true);
      if (l.status !== 'planned') throw new ConflictException(`the lift is ${l.status}`);
      if (!l.approved_at) {
        await c.query('UPDATE ops.crane_lift SET approved_by = $2, approved_at = now(), version = version + 1 WHERE id = $1', [id, a.userId]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'cranes.lift_approved', targetType: 'crane_lift', targetId: id, after: { critical: l.critical } });
      }
      return this.lift(c, id);
    });
  }

  /** The office records a lift done or aborted (the operator called it in). */
  @Post('lifts/:id/record')
  @HttpCode(200)
  @Perm('tasks:assign')
  record(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const event = v.oneOf(b?.event, 'event', LIFT_EVENTS, { required: true })!;
    const wind = parseWind(b?.wind_ms, 'wind_ms');
    const note = v.str(b?.note, 'note', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      const bad = await markLift(c, a, { taskId: null, liftId: id, event, wind, note, at: new Date(), source: 'office', clientOpId: randomUUID() });
      if (bad === 'unknown_lift') throw new NotFoundException();
      if (bad) throw new ConflictException(bad);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'cranes.lift_recorded', targetType: 'crane_lift', targetId: id, after: { event, wind, note } });
      return this.lift(c, id);
    });
  }

  @Post('lifts/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const l = await this.lift(c, id, true);
      if (l.status === 'canceled') return l;
      if (l.status !== 'planned') throw new ConflictException(`the lift is ${l.status}`);
      await c.query(`UPDATE ops.crane_lift SET status = 'canceled', abort_reason = $2, version = version + 1 WHERE id = $1`, [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'cranes.lift_canceled', targetType: 'crane_lift', targetId: id, after: { reason } });
      return this.lift(c, id);
    });
  }

  // ---- watch and report ----

  /**
   * Now: critical lifts today or tomorrow not approved, lifts of past days still open, lifts aborted in the last day,
   * cranes without a chart, and crane certificates expired or expiring within 30 days.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const today = kwToday(), tomorrow = new Date(Date.parse(today) + DAY).toISOString().slice(0, 10);
      const near = (await c.query(`${LIFT_SQL} WHERE l.lift_date BETWEEN $1::date - 7 AND $2 AND l.status IN ('planned','aborted') ORDER BY l.lift_date, l.lift_time NULLS LAST`, [today, tomorrow])).rows;
      const cranes = (await c.query(
        `SELECT fa.id AS asset_id, fa.plate_no, cs.asset_id IS NOT NULL AS has_chart,
                (SELECT max(d.expires_on)::text FROM core.document d WHERE d.asset_id = fa.id AND d.doc_type = $1 AND d.archived_at IS NULL) AS cert_expires_on
           FROM fleet.asset fa LEFT JOIN ops.crane_spec cs ON cs.asset_id = fa.id WHERE fa.asset_type = 'crane' AND fa.status NOT IN ('retired','out_of_service') ORDER BY fa.plate_no`, [CRANE_DOC])).rows;
      const warn = new Date(Date.parse(today) + CERT_WARN_DAYS * DAY).toISOString().slice(0, 10);
      const day = (l: Record<string, unknown>) => Date.parse(l.lift_date as string);
      return {
        unapproved: near.filter((l) => l.status === 'planned' && l.critical && !l.approved_at && day(l) >= Date.parse(today)),
        open_past: near.filter((l) => l.status === 'planned' && day(l) < Date.parse(today)),
        aborted: near.filter((l) => l.status === 'aborted' && day(l) >= Date.parse(today) - DAY),
        no_chart: cranes.filter((x) => !x.has_chart),
        certificates: cranes.filter((x) => !x.cert_expires_on || x.cert_expires_on <= warn),
      };
    });
  }

  /** For a period, per customer: lifts done, aborted (and for wind), critical, the highest utilization and the heaviest load. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${LIFT_SQL} WHERE l.lift_date BETWEEN $1 AND $2`, [f, t])).rows;
      const sum = (l: typeof rows) => {
        const done = l.filter((r) => r.status === 'done');
        const aborted = l.filter((r) => r.status === 'aborted');
        return { lifts: l.length, done: done.length, aborted: aborted.length, aborted_wind: aborted.filter((r) => r.wind_ms !== null && r.wind_ms > r.wind_limit_ms).length + aborted.filter((r) => /wind|رياح/i.test(r.abort_reason ?? '') && !(r.wind_ms !== null && r.wind_ms > r.wind_limit_ms)).length,
          critical: done.filter((r) => r.critical).length, max_utilization: done.reduce((m, r) => Math.max(m, r.utilization), 0), heaviest_t: done.reduce((m, r) => Math.max(m, r.load_t), 0) };
      };
      const by = new Map<string, typeof rows>();
      for (const r of rows.filter((x) => x.status !== 'canceled')) by.set(r.customer_name, [...(by.get(r.customer_name) ?? []), r]);
      return {
        from: f, to: t, totals: { ...sum(rows.filter((x) => x.status !== 'canceled')), canceled: rows.filter((x) => x.status === 'canceled').length },
        customers: [...by.entries()].map(([name, l]) => ({ customer_name: name, ...sum(l) })).sort((x, y) => y.lifts - x.lifts),
      };
    });
  }

  private async lift(c: PoolClient, id: string, lock = false) {
    const l = (await c.query(`${LIFT_SQL} WHERE l.id = $1${lock ? ' FOR UPDATE OF l' : ''}`, [id])).rows[0];
    if (!l) throw new NotFoundException();
    return l;
  }
}
