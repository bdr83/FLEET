import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { normalizeAttributes } from '../delivery/delivery';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { CATEGORIES, dueBy, jobState, KINDS, Part, parseParts, PLAN_HORIZON_DAYS, PRIORITIES, Priority, REPEAT_DAYS, Result, RESULTS, SERVICE, Stage, VISIT_MIN } from './service';

const kwDate = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
const kwToday = () => kwDate(new Date());
const KW = `AT TIME ZONE 'Asia/Kuwait'`;

const JOB_SQL = `
  SELECT j.id, j.ref, j.legal_entity_id, j.customer_id, cu.name AS customer_name, cu.phone AS customer_phone, j.site, j.category, j.kind, j.priority, j.problem, j.unit,
         j.due_by, j.plan_id, j.outcome, j.labour_amount::text, j.parts_amount::text, (COALESCE(j.labour_amount, 0) + COALESCE(j.parts_amount, 0))::text AS total,
         j.closed_at, j.canceled_at, j.cancel_reason, j.created_at, j.version,
         (SELECT min(x.arrived_at) FROM ops.svc_visit x JOIN ops.task xt ON xt.id = x.task_id WHERE x.job_id = j.id) AS first_arrival
    FROM ops.svc_job j JOIN crm.customer cu ON cu.id = j.customer_id`;

const VISIT_SQL = `
  SELECT x.task_id, x.job_id, j.ref AS job_ref, x.seq, t.status, lower(t.service_window) AS starts_at, upper(t.service_window) AS ends_at,
         asg.worker_id AS technician_id, w.display_name AS technician_name, x.arrived_at, x.result, x.work_done, x.signed_by, x.finished_at,
         COALESCE((SELECT json_agg(json_build_object('name', p.name, 'qty', p.qty::float) ORDER BY p.created_at) FROM ops.svc_part p WHERE p.task_id = x.task_id), '[]') AS parts,
         cu.name AS customer_name, j.site, j.category, j.priority, j.problem, j.due_by
    FROM ops.svc_visit x JOIN ops.svc_job j ON j.id = x.job_id JOIN ops.task t ON t.id = x.task_id JOIN crm.customer cu ON cu.id = j.customer_id
    LEFT JOIN LATERAL (SELECT a.worker_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id`;

const siteLine = (s: Record<string, unknown>) => [s.name, s.area, s.block ? `ق ${s.block}` : null, s.street, s.building ? `مبنى ${s.building}` : null].filter((x) => typeof x === 'string' && x).join('، ') || null;

function parseSite(val: unknown, field = 'site') {
  const site = normalizeAttributes({ dropoff: v.obj(val, field) ?? (() => { throw new BadRequestException(`${field} required`); })() })!.dropoff as Record<string, unknown>;
  if (!site.area && !site.name) throw new BadRequestException(`${field} needs an area or a name`);
  return site;
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string, at = new Date()) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',$8,$9)`,
    [randomUUID(), a.tenantId, taskId, from, to, at.toISOString(), a.userId, randomUUID(), note]);
}

async function savePart(c: PoolClient, a: AuthContext, taskId: string, parts: Part[]) {
  for (const p of parts) await c.query('INSERT INTO ops.svc_part (id, tenant_id, task_id, name, qty) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), a.tenantId, taskId, p.name, p.qty]);
}

/**
 * The technician's arrival and the end of the visit from the app (or the office's record). Returns a reject code instead
 * of throwing so the driver's sync reports it per op.
 */
export async function serviceStage(c: PoolClient, a: AuthContext, taskId: string, code: Stage,
  x: { at: Date; result: string | null; workDone: string | null; signedBy: string | null; parts: unknown }): Promise<string | null> {
  const vis = (await c.query('SELECT task_id, arrived_at, result FROM ops.svc_visit WHERE task_id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!vis) return 'not_supported';
  if (code === 'arrived') {
    await c.query('UPDATE ops.svc_visit SET arrived_at = COALESCE(arrived_at, $2) WHERE task_id = $1', [taskId, x.at.toISOString()]);
    return null;
  }
  if (!x.result || !(RESULTS as readonly string[]).includes(x.result)) return 'result_required';
  if (!x.workDone) return 'work_required';
  if (!x.signedBy) return 'signer_required';
  let parts: Part[];
  try { parts = parseParts(x.parts); } catch { return 'parts_invalid'; }
  await c.query('UPDATE ops.svc_visit SET result = $2, work_done = $3, signed_by = $4, finished_at = $5 WHERE task_id = $1', [taskId, x.result, x.workDone, x.signedBy, x.at.toISOString()]);
  await savePart(c, a, taskId, parts);
  return null;
}

@Controller('v1/service')
@UseGuards(AuthGuard)
@Pack('service')
export class ServiceController {
  constructor(private readonly db: DbService) {}

  // ---- jobs ----

  @Get('jobs')
  @Perm('tasks:read')
  jobs(@Auth() a: AuthContext, @Query('state') state?: string, @Query('customer_id') customer?: string) {
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => {
      const rows = await this.withState(c, (await c.query(`${JOB_SQL} WHERE ($1::uuid IS NULL OR j.customer_id = $1) ORDER BY j.created_at DESC LIMIT 500`, [cu])).rows);
      return { data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** A job: the customer's site, what is wrong, the priority (sets the response time). */
  @Post('jobs')
  @Perm('tasks:assign')
  addJob(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const site = parseSite(b?.site);
    const category = v.oneOf(b?.category, 'category', CATEGORIES, { required: true })!;
    const kind = v.oneOf(b?.kind, 'kind', KINDS) ?? 'repair';
    const priority = v.oneOf(b?.priority, 'priority', PRIORITIES) ?? 'normal';
    const problem = v.str(b?.problem, 'problem', { required: true, max: 1000 })!;
    const unit = v.obj(b?.unit, 'unit');
    const due = v.ts(b?.due_by, 'due_by') ?? dueBy(new Date(), priority);
    return this.db.withTenant(a, async (c) => {
      const id = await this.insertJob(c, a, { le, customer, site, category, kind, priority, problem, unit, due, plan: null });
      return this.job(c, id);
    });
  }

  @Get('jobs/:id')
  @Perm('tasks:read')
  getJob(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.job(c, id));
  }

  /** Books a technician (and optionally a van) for a visit; one open visit at a time. */
  @Post('jobs/:id/visits')
  @Perm('tasks:assign')
  addVisit(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const tech = v.uuid(b?.technician_worker_id, 'technician_worker_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id');
    const at = v.ts(b?.starts_at, 'starts_at') ?? new Date();
    const dur = v.int(b?.duration_min, 'duration_min', 15, 720) ?? VISIT_MIN;
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id);
      if (['closed', 'canceled'].includes(j.state)) throw new ConflictException('the job is closed');
      if (['scheduled', 'on_site'].includes(j.state)) throw new ConflictException('a visit is already open');
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [tech, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown technician_worker_id');
      if (asset && !(await c.query(`SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2 AND status NOT IN ('out_of_service','retired')`, [asset, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown asset_id');
      // a failed visit's booking is released so the technician can be booked again for the same time
      for (const x of j.visits.filter((y: { status: string }) => y.status === 'failed')) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [x.task_id]);
      }
      const seq = j.visits.length + 1;
      const end = new Date(at.getTime() + dur * 60_000);
      const task = await createTask(c, a, {
        le: j.legal_entity_id, pack: SERVICE, branch: null, status: 'ready', customer: j.customer_id, site: null, ref: `${j.ref}-${seq}`,
        win: { from: at.toISOString(), to: end.toISOString() },
        attrs: { kind: 'visit', job_id: id, job_ref: j.ref, seq, category: j.category, job_kind: j.kind, priority: j.priority, problem: j.problem, unit: j.unit,
          dropoff: j.site, address: siteLine(j.site), customer_name: j.customer_name, contact_phone: j.site.phone ?? j.customer_phone, due_by: j.due_by,
          previous: j.visits.filter((x: { work_done: string | null }) => x.work_done).map((x: { seq: number; work_done: string }) => `${x.seq}: ${x.work_done}`).slice(-3) },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, tech, asset, at.toISOString(), end.toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('technician_booked: the technician has another booking then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the vehicle is booked then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `visit ${seq} of ${j.ref}`);
      await c.query('INSERT INTO ops.svc_visit (task_id, tenant_id, job_id, seq) VALUES ($1,$2,$3,$4)', [task.id, a.tenantId, id, seq]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'service.visit_booked', targetType: 'svc_job', targetId: id, after: { task: task.id, seq, tech, at: at.toISOString(), dur } });
      return this.job(c, id);
    });
  }

  /** The office records a visit (a technician without the app, or a paper job card); the visit task completes. */
  @Post('visits/:taskId/record')
  @HttpCode(200)
  @Perm('tasks:assign')
  record(@Auth() a: AuthContext, @Param('taskId', new ParseUUIDPipe()) taskId: string, @Body() b: Record<string, unknown>) {
    const result = v.oneOf(b?.result, 'result', RESULTS, { required: true })!;
    const work = v.str(b?.work_done, 'work_done', { required: true, max: 1000 })!;
    const signed = v.str(b?.signed_by, 'signed_by', { max: 120 });
    const parts = parseParts(b?.parts);
    const arrived = v.ts(b?.arrived_at, 'arrived_at');
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query(`SELECT x.job_id, x.result, t.status FROM ops.svc_visit x JOIN ops.task t ON t.id = x.task_id WHERE x.task_id = $1 FOR UPDATE OF x`, [taskId])).rows[0];
      if (!x) throw new NotFoundException();
      if (x.result) throw new ConflictException('the visit is already recorded');
      if (['canceled', 'failed'].includes(x.status)) throw new ConflictException(`the visit is ${x.status}`);
      const now = new Date();
      await c.query('UPDATE ops.svc_visit SET arrived_at = COALESCE(arrived_at, $2), result = $3, work_done = $4, signed_by = $5, finished_at = $6 WHERE task_id = $1',
        [taskId, (arrived ?? now).toISOString(), result, work, signed, now.toISOString()]);
      await savePart(c, a, taskId, parts);
      if (!['completed', 'reviewed', 'invoiced'].includes(x.status)) {
        await c.query(`UPDATE ops.task SET status = 'completed', version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
        await event(c, a, taskId, x.status, 'completed', 'visit recorded by the office');
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'service.visit_recorded', targetType: 'task', targetId: taskId, after: { result, work, signed, parts } });
      return this.job(c, x.job_id);
    });
  }

  /** Closes the job after the last visit: the outcome, and the labour and parts amounts the office charges. */
  @Post('jobs/:id/close')
  @HttpCode(200)
  @Perm('tasks:assign')
  close(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const labour = v.money(b?.labour_amount, 'labour_amount');
    const parts = v.money(b?.parts_amount, 'parts_amount');
    const outcome = v.oneOf(b?.outcome, 'outcome', ['fixed', 'not_fixed'] as const);
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (['closed', 'canceled'].includes(j.state)) throw new ConflictException(`the job is ${j.state}`);
      if (['scheduled', 'on_site'].includes(j.state)) throw new ConflictException('a visit is still open');
      const last = [...j.visits].reverse().find((x: { result: Result | null }) => x.result);
      const out = outcome ?? (last?.result === 'fixed' ? 'fixed' : last ? 'not_fixed' : null);
      if (!out) throw new BadRequestException('outcome required: no visit recorded');
      await c.query('UPDATE ops.svc_job SET outcome = $2, labour_amount = $3, parts_amount = $4, closed_at = now(), closed_by = $5, version = version + 1 WHERE id = $1', [id, out, labour, parts, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'service.job_closed', targetType: 'svc_job', targetId: id, after: { outcome: out, labour, parts } });
      return this.job(c, id);
    });
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state === 'canceled') return j;
      if (j.state === 'closed') throw new ConflictException('the job is closed');
      if (j.state === 'on_site') throw new ConflictException('the technician is on site');
      for (const x of j.visits.filter((y: { status: string; result: Result | null }) => !y.result && ['ready', 'assigned', 'accepted'].includes(y.status))) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [x.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [x.task_id]);
        await event(c, a, x.task_id, x.status, 'canceled', `job canceled: ${reason}`);
      }
      await c.query('UPDATE ops.svc_job SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'service.job_canceled', targetType: 'svc_job', targetId: id, after: { reason } });
      return this.job(c, id);
    });
  }

  // ---- the day ----

  /** A day's visits by technician, and the open jobs waiting for one. */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const visits = (await c.query(`${VISIT_SQL} WHERE (lower(t.service_window) ${KW})::date = $1 AND t.status <> 'canceled' ORDER BY lower(t.service_window)`, [day])).rows;
      const open = (await this.withState(c, (await c.query(`${JOB_SQL} WHERE j.closed_at IS NULL AND j.canceled_at IS NULL ORDER BY j.due_by`)).rows))
        .filter((j) => ['new', 'follow_up'].includes(j.state));
      return { date: day, visits, waiting: open };
    });
  }

  // ---- preventive plans ----

  @Get('plans')
  @Perm('tasks:read')
  plans(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT p.id, p.customer_id, cu.name AS customer_name, p.name, p.site, p.category, p.every_days, p.next_due::text, p.ends_on::text, p.tasks_note, p.active,
                                   (SELECT count(*)::int FROM ops.svc_job j WHERE j.plan_id = p.id) AS jobs
                              FROM ops.svc_plan p JOIN crm.customer cu ON cu.id = p.customer_id ORDER BY p.active DESC, p.next_due`)).rows,
    }));
  }

  /** A preventive maintenance plan: a job at the site every N days from the first due date. */
  @Post('plans')
  @Perm('tasks:assign')
  addPlan(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!;
    const site = parseSite(b?.site);
    const category = v.oneOf(b?.category, 'category', CATEGORIES, { required: true })!;
    const every = v.int(b?.every_days, 'every_days', 7, 366) ?? (() => { throw new BadRequestException('every_days required'); })();
    const first = v.date(b?.first_due, 'first_due') ?? kwToday();
    const ends = v.date(b?.ends_on, 'ends_on');
    if (ends && ends < first) throw new BadRequestException('ends_on is before first_due');
    const note = v.str(b?.tasks_note, 'tasks_note', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT legal_entity_id FROM crm.customer WHERE id = $1', [customer])).rows[0];
      if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
      const id = randomUUID();
      await c.query(`INSERT INTO ops.svc_plan (id, tenant_id, legal_entity_id, customer_id, name, site, category, every_days, next_due, ends_on, tasks_note, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, a.tenantId, le, customer, name, JSON.stringify(site), category, every, first, ends, note, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'service.plan_added', targetType: 'svc_plan', targetId: id, after: { customer, name, category, every, first, ends } });
      return (await c.query(`SELECT id, name, every_days, next_due::text, ends_on::text, active FROM ops.svc_plan WHERE id = $1`, [id])).rows[0];
    });
  }

  @Post('plans/:id/stop')
  @HttpCode(200)
  @Perm('tasks:assign')
  stopPlan(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const r = await c.query('UPDATE ops.svc_plan SET active = false WHERE id = $1 RETURNING id, active', [id]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'service.plan_stopped', targetType: 'svc_plan', targetId: id });
      return r.rows[0];
    });
  }

  /** Creates the preventive jobs falling due within the horizon of a date, and moves each plan to its next date. */
  @Post('plans/generate')
  @HttpCode(200)
  @Perm('tasks:assign')
  generate(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const day = v.date(b?.date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const plans = (await c.query(
        `SELECT id, legal_entity_id, customer_id, name, site, category, every_days, next_due::text, ends_on::text, tasks_note FROM ops.svc_plan
          WHERE active AND next_due <= $1::date + $2::int AND (ends_on IS NULL OR next_due <= ends_on) FOR UPDATE`, [day, PLAN_HORIZON_DAYS])).rows;
      const created: string[] = [];
      for (const p of plans) {
        let due = p.next_due as string;
        const until = new Date(Date.parse(day) + PLAN_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
        while (due <= until && (!p.ends_on || due <= p.ends_on)) {
          const id = await this.insertJob(c, a, { le: p.legal_entity_id, customer: p.customer_id, site: p.site, category: p.category, kind: 'preventive', priority: 'low',
            problem: `صيانة دورية: ${p.name}${p.tasks_note ? ` — ${p.tasks_note}` : ''}`.slice(0, 1000), unit: null, due: new Date(`${due}T23:59:00+03:00`), plan: p.id });
          created.push((await c.query('SELECT ref FROM ops.svc_job WHERE id = $1', [id])).rows[0].ref);
          due = new Date(Date.parse(due) + p.every_days * 86_400_000).toISOString().slice(0, 10);
        }
        await c.query('UPDATE ops.svc_plan SET next_due = $2 WHERE id = $1', [p.id, due]);
      }
      return { date: day, created };
    });
  }

  // ---- watch and report ----

  /** Late arrivals against the response time, jobs nobody is booked for, follow-ups, jobs to close, repeat faults. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const open = await this.withState(c, (await c.query(`${JOB_SQL} WHERE j.closed_at IS NULL AND j.canceled_at IS NULL ORDER BY j.due_by`)).rows);
      const now = Date.now();
      const late = open.filter((j) => !j.first_arrival && new Date(j.due_by).getTime() < now);
      const unassigned = open.filter((j) => j.state === 'new');
      const followUps = open.filter((j) => j.state === 'follow_up');
      const toClose = open.filter((j) => j.state === 'to_close');
      const repeats = (await c.query(
        `${JOB_SQL} WHERE j.kind = 'repair' AND j.created_at > now() - interval '60 days' AND EXISTS (
            SELECT 1 FROM ops.svc_job p WHERE p.customer_id = j.customer_id AND p.category = j.category AND p.id <> j.id AND p.outcome = 'fixed'
               AND p.closed_at < j.created_at AND p.closed_at > j.created_at - make_interval(days => $1)) ORDER BY j.created_at DESC`, [REPEAT_DAYS])).rows;
      return { late, unassigned, follow_ups: followUps, to_close: toClose, repeats };
    });
  }

  /** For a period: jobs, response time against the target, fixed on the first visit, per technician and category, and the amounts. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const jobs = (await c.query(`${JOB_SQL} WHERE (j.created_at ${KW})::date BETWEEN $1 AND $2 AND j.canceled_at IS NULL`, [f, t])).rows;
      const ids = jobs.map((j) => j.id);
      const visits = (await c.query(`${VISIT_SQL} WHERE x.job_id = ANY ($1::uuid[]) AND t.status <> 'canceled'`, [ids])).rows;
      const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
      const reached = jobs.filter((j) => j.first_arrival);
      const onTime = reached.filter((j) => new Date(j.first_arrival) <= new Date(j.due_by));
      const closed = jobs.filter((j) => j.closed_at);
      const firstFix = closed.filter((j) => visits.find((x) => x.job_id === j.id && x.seq === 1)?.result === 'fixed');
      const hours = (x: { arrived_at: string | null; finished_at: string | null }) => (x.arrived_at && x.finished_at ? (Date.parse(x.finished_at) - Date.parse(x.arrived_at)) / 3_600_000 : 0);
      const fils = (s: string | null) => Math.round(Number(s ?? 0) * 1000);
      const techs = new Map<string, typeof visits>();
      for (const x of visits) if (x.technician_name) techs.set(x.technician_name, [...(techs.get(x.technician_name) ?? []), x]);
      const cats = new Map<string, typeof jobs>();
      for (const j of jobs) cats.set(j.category, [...(cats.get(j.category) ?? []), j]);
      return {
        from: f, to: t,
        totals: {
          jobs: jobs.length, closed: closed.length, fixed: closed.filter((j) => j.outcome === 'fixed').length, visits: visits.length,
          on_time_pct: pct(onTime.length, reached.length), first_fix_pct: pct(firstFix.length, closed.length),
          avg_response_h: reached.length ? Math.round((reached.reduce((s, j) => s + (Date.parse(j.first_arrival) - Date.parse(j.created_at)), 0) / reached.length / 3_600_000) * 10) / 10 : null,
          labour: (closed.reduce((s, j) => s + fils(j.labour_amount), 0) / 1000).toFixed(3), parts: (closed.reduce((s, j) => s + fils(j.parts_amount), 0) / 1000).toFixed(3),
        },
        technicians: [...techs.entries()].map(([name, l]) => ({ technician_name: name, visits: l.length, fixed: l.filter((x) => x.result === 'fixed').length,
          follow_up: l.filter((x) => x.result === 'follow_up').length, onsite_hours: Math.round(l.reduce((s, x) => s + hours(x), 0) * 10) / 10 })).sort((x, y) => y.visits - x.visits),
        categories: [...cats.entries()].map(([category, l]) => ({ category, jobs: l.length, closed: l.filter((j) => j.closed_at).length, fixed: l.filter((j) => j.outcome === 'fixed').length })).sort((x, y) => y.jobs - x.jobs),
      };
    });
  }

  // ---- helpers ----

  private async insertJob(c: PoolClient, a: AuthContext, j: { le: string; customer: string; site: Record<string, unknown>; category: string; kind: string; priority: Priority | string;
    problem: string; unit: Record<string, unknown> | null; due: Date; plan: string | null }) {
    const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [j.customer])).rows[0];
    if (!cu || cu.legal_entity_id !== j.le) throw new BadRequestException('unknown customer_id');
    if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
    const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.svc_job`)).rows[0].n;
    const id = randomUUID(), ref = `WO-${n}`;
    await c.query(`INSERT INTO ops.svc_job (id, tenant_id, legal_entity_id, ref, customer_id, site, category, kind, priority, problem, unit, due_by, plan_id, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, a.tenantId, j.le, ref, j.customer, JSON.stringify(j.site), j.category, j.kind, j.priority, j.problem, j.unit ? JSON.stringify(j.unit) : null, j.due.toISOString(), j.plan, a.userId]);
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'service.job_opened', targetType: 'svc_job', targetId: id, after: { ref, customer: j.customer, category: j.category, priority: j.priority, plan: j.plan } });
    return id;
  }

  private async job(c: PoolClient, id: string, lock = false) {
    const j = (await c.query(`${JOB_SQL} WHERE j.id = $1${lock ? ' FOR UPDATE OF j' : ''}`, [id])).rows[0];
    if (!j) throw new NotFoundException();
    const visits = (await c.query(`${VISIT_SQL} WHERE x.job_id = $1 ORDER BY x.seq`, [id])).rows;
    return { ...j, state: jobState(j, visits), visits };
  }

  private async withState<T extends { id: string; canceled_at: unknown; closed_at: unknown }>(c: PoolClient, rows: T[]) {
    if (!rows.length) return [];
    const vs = (await c.query(`SELECT x.job_id, x.seq, x.result, t.status, w.display_name AS technician_name FROM ops.svc_visit x JOIN ops.task t ON t.id = x.task_id
                                 LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active LEFT JOIN workforce.worker w ON w.id = asg.worker_id
                                WHERE x.job_id = ANY ($1::uuid[]) ORDER BY x.seq`, [rows.map((r) => r.id)])).rows;
    return rows.map((r) => {
      const mine = vs.filter((x) => x.job_id === r.id);
      const live = mine.filter((x) => !x.result && !['canceled', 'failed'].includes(x.status)).at(-1);
      return { ...r, state: jobState(r, mine), visits_count: mine.length, technician_name: live?.technician_name ?? mine.at(-1)?.technician_name ?? null };
    });
  }
}
