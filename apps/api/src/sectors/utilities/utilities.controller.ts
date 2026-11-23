import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import {
  dueFrom, JOB_TYPES, jobState, minutes, NETWORKS, permitBlock, PERMIT_WARN_DAYS, Priority, PRIORITIES, REINSTATE_DAYS, safetyCheck, Stage, UTILITIES,
} from './utilities';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const kwDate = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;

const JOB_SQL = `
  SELECT j.id, j.ref, j.legal_entity_id, j.customer_id, cu.name AS customer_name, j.network, j.job_type, j.priority, j.reported_at, j.due_at, j.duration_min,
         j.area, j.address, j.lat, j.lng, j.asset_ref, j.description, j.affected, j.needs_permit, j.permit_no, j.permit_expires::text AS permit_expires, j.task_id, j.attempts,
         j.arrived_at, j.isolated_at, j.restored_at, j.reinstated_at, j.result, j.result_note, j.checks, j.canceled_at, j.cancel_reason, j.created_at, j.version,
         t.status AS task_status, asg.worker_id AS lead_id, w.display_name AS lead_name, asg.asset_id, fa.plate_no, lower(asg.period) AS booked_from,
         (SELECT e.reason_code FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed' ORDER BY e.occurred_at DESC LIMIT 1) AS fail_reason
    FROM ops.ut_job j LEFT JOIN crm.customer cu ON cu.id = j.customer_id LEFT JOIN ops.task t ON t.id = j.task_id
    LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id, a.period FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id`;

type Row = Record<string, unknown> & { canceled_at: unknown; arrived_at: unknown; isolated_at: unknown; restored_at: unknown; task_status: string | null; reported_at: Date; due_at: Date };
function shape<T extends Row>(j: T) {
  const state = jobState(j, j.task_status);
  const arrivedOrNow = (j.arrived_at as Date | null) ?? (['canceled'].includes(state) ? null : new Date());
  return {
    ...j, state,
    response_min: minutes(j.reported_at, j.arrived_at as Date | null),
    restore_min: minutes(j.reported_at, j.restored_at as Date | null),
    breached: arrivedOrNow ? new Date(arrivedOrNow).getTime() > new Date(j.due_at).getTime() : false,
  };
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

/** The crew and vehicle are free again once the work on site is over. */
async function release(c: PoolClient, taskId: string, at: Date) {
  await c.query(`UPDATE ops.assignment SET period = tstzrange(lower(period), GREATEST(lower(period) + interval '1 minute', LEAST(upper(period), $2::timestamptz))) WHERE task_id = $1 AND active`,
    [taskId, at.toISOString()]);
}

/**
 * The crew's stages. Isolation needs a valid permit when digging and the safety checklist passed; the repair records its
 * result; digging ends with the road reinstated. The crew is released when the work on site is over. Returns a reject code.
 */
export async function utilitiesStage(c: PoolClient, taskId: string, code: Stage, x: { at: Date; checks: Record<string, unknown> | null; result: string | null; note: string | null }): Promise<string | null> {
  const j = (await c.query('SELECT id, needs_permit, permit_no, permit_expires::text AS permit_expires FROM ops.ut_job WHERE task_id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!j) return 'not_supported';
  if (code === 'ut_arrived') {
    await c.query('UPDATE ops.ut_job SET arrived_at = $2, version = version + 1 WHERE id = $1', [j.id, x.at]);
    return null;
  }
  if (code === 'ut_isolated') {
    const p = permitBlock(j.needs_permit, j.permit_no, j.permit_expires, kwDate(x.at));
    if (p) return p;
    if (!x.checks) return 'checks_required';
    const r = safetyCheck(x.checks, j.needs_permit);
    if (r.failed.length) return 'checks_failed';
    await c.query('UPDATE ops.ut_job SET isolated_at = $2, checks = $3, version = version + 1 WHERE id = $1', [j.id, x.at, JSON.stringify(Object.fromEntries(r.items.map((k) => [k, true])))]);
    return null;
  }
  if (code === 'ut_restored') {
    if (!x.result) return 'result_required';
    await c.query('UPDATE ops.ut_job SET restored_at = $2, result = $3, result_note = $4, version = version + 1 WHERE id = $1', [j.id, x.at, x.result, x.note]);
    if (!j.needs_permit) await release(c, taskId, x.at);
    return null;
  }
  if (!j.needs_permit) return 'not_required';
  await c.query('UPDATE ops.ut_job SET reinstated_at = $2, version = version + 1 WHERE id = $1', [j.id, x.at]);
  await release(c, taskId, x.at);
  return null;
}

/** An order ends restored and, when digging, reinstated. */
export async function utilitiesFinish(c: PoolClient, taskId: string): Promise<string | null> {
  const j = (await c.query('SELECT restored_at, needs_permit, reinstated_at FROM ops.ut_job WHERE task_id = $1', [taskId])).rows[0];
  if (!j) return null;
  if (!j.restored_at) return 'proof_required';
  if (j.needs_permit && !j.reinstated_at) return 'reinstatement_required';
  return null;
}

@Controller('v1/utilities')
@UseGuards(AuthGuard)
@Pack('utilities')
export class UtilitiesController {
  constructor(private readonly db: DbService) {}

  /** Orders reported on a day plus every order still open. */
  @Get('jobs')
  @Perm('tasks:read')
  jobs(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({
      date: day,
      data: (await c.query(
        `${JOB_SQL} WHERE (j.reported_at AT TIME ZONE 'Asia/Kuwait')::date = $1
            OR (j.canceled_at IS NULL AND (t.status IS NULL OR t.status NOT IN ('completed','reviewed','invoiced','canceled')))
          ORDER BY CASE j.priority WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, j.due_at`, [day])).rows.map(shape),
    }));
  }

  /** A work order: network, type, priority (sets the due time unless given), location, asset, affected customers, and the permit when digging. */
  @Post('jobs')
  @Perm('tasks:assign')
  addJob(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const network = v.oneOf(b?.network, 'network', NETWORKS, { required: true })!;
    const type = v.oneOf(b?.job_type, 'job_type', JOB_TYPES, { required: true })!;
    const priority = v.oneOf(b?.priority, 'priority', PRIORITIES, { required: true })! as Priority;
    const reported = b?.reported_at ? new Date(String(b.reported_at)) : new Date();
    if (Number.isNaN(reported.getTime()) || reported.getTime() > Date.now() + 60_000) throw new BadRequestException('reported_at must be a past time');
    const due = b?.due_at ? new Date(String(b.due_at)) : dueFrom(reported, priority);
    if (Number.isNaN(due.getTime()) || due < reported) throw new BadRequestException('due_at must be after reported_at');
    const duration = v.int(b?.duration_min, 'duration_min', 30, 1440) ?? 240;
    const area = v.str(b?.area, 'area', { required: true, max: 80 })!;
    const address = v.str(b?.address, 'address', { max: 200 });
    const desc = v.str(b?.description, 'description', { required: true, max: 500 })!;
    const assetRef = v.str(b?.asset_ref, 'asset_ref', { max: 60 });
    const affected = v.int(b?.affected, 'affected', 0, 1_000_000) ?? 0;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const needsPermit = b?.needs_permit === undefined ? type === 'excavation' : b.needs_permit === true;
    const permitNo = v.str(b?.permit_no, 'permit_no', { max: 40 });
    const permitExp = v.date(b?.permit_expires, 'permit_expires');
    if (!!permitNo !== !!permitExp) throw new BadRequestException('permit_no and permit_expires go together');
    const lat = b?.lat === undefined || b?.lat === null ? null : Number(b.lat), lng = b?.lng === undefined || b?.lng === null ? null : Number(b.lng);
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng!) || Math.abs(lng!) > 180))) throw new BadRequestException('lat/lng invalid');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      if (customer && !(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [customer, le])).rowCount) throw new BadRequestException('unknown customer_id');
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.ut_job`)).rows[0].n;
      const id = randomUUID(), ref = `UJ-${n}`;
      await c.query(`INSERT INTO ops.ut_job (id, tenant_id, legal_entity_id, ref, customer_id, network, job_type, priority, reported_at, due_at, duration_min, area, address, lat, lng,
                       asset_ref, description, affected, needs_permit, permit_no, permit_expires, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [id, a.tenantId, le, ref, customer, network, type, priority, reported, due, duration, area, address, lat, lng, assetRef, desc, affected, needsPermit, permitNo, permitExp, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'utilities.job_created', targetType: 'ut_job', targetId: id, after: { ref, network, type, priority } });
      return this.job(c, id);
    });
  }

  @Get('jobs/:id')
  @Perm('tasks:read')
  getJob(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.job(c, id));
  }

  /** Records or renews the excavation permit. */
  @Put('jobs/:id/permit')
  @Perm('tasks:assign')
  permit(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const no = v.str(b?.permit_no, 'permit_no', { required: true, max: 40 })!.trim();
    const exp = v.date(b?.permit_expires, 'permit_expires');
    if (!exp) throw new BadRequestException('permit_expires required');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (['done', 'canceled'].includes(j.state)) throw new ConflictException(`the order is ${j.state}`);
      await c.query('UPDATE ops.ut_job SET needs_permit = true, permit_no = $2, permit_expires = $3, version = version + 1 WHERE id = $1', [id, no, exp]);
      if (j.task_id) await c.query(`UPDATE ops.task SET attributes = attributes || jsonb_build_object('needs_permit', true, 'permit_no', $2::text, 'permit_expires', $3::text), version = version + 1 WHERE id = $1`, [j.task_id, no, exp]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'utilities.permit_set', targetType: 'ut_job', targetId: id, after: { no, exp } });
      return this.job(c, id);
    });
  }

  /** Books a crew (vehicle and lead) from start_at (default now) for the order's duration; re-assigning replaces the booking. */
  @Post('jobs/:id/assign')
  @Perm('tasks:assign')
  assign(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const lead = v.uuid(b?.worker_id, 'worker_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const start = b?.start_at ? new Date(String(b.start_at)) : null;
    if (start && Number.isNaN(start.getTime())) throw new BadRequestException('start_at invalid');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (!['open', 'assigned', 'failed'].includes(j.state)) throw new ConflictException(`the order is ${j.state}`);
      if (!(await c.query(`SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2 AND status NOT IN ('out_of_service','retired')`, [asset, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown or unavailable asset_id');
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [lead, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown worker_id');
      const from = start ?? new Date(Math.max(Date.now(), new Date(j.reported_at).getTime()));
      const to = new Date(from.getTime() + (j.duration_min as number) * 60_000);
      if (j.task_id && j.state === 'assigned') {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [j.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [j.task_id]);
        await event(c, a, j.task_id as string, j.task_status as string, 'canceled', 'crew changed');
      } else if (j.task_id) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [j.task_id]);
      }
      const n = (j.attempts as number) + 1;
      const task = await createTask(c, a, {
        le: j.legal_entity_id as string, pack: UTILITIES, branch: null, status: 'ready', customer: j.customer_id as string | null, site: null, ref: `${j.ref}-${n}`,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { kind: 'work_order', job_id: id, job_ref: j.ref, network: j.network, job_type: j.job_type, priority: j.priority, due_at: j.due_at, asset_ref: j.asset_ref,
          description: j.description, affected: j.affected, needs_permit: j.needs_permit, permit_no: j.permit_no, permit_expires: j.permit_expires, customer_name: j.customer_name,
          address: [j.address, j.area].filter(Boolean).join('، '), ...(j.lat !== null ? { dropoff: { name: j.area, lat: j.lat, lng: j.lng } } : {}) },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, lead, asset, from.toISOString(), to.toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('worker_booked: the crew lead has another job then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the vehicle is booked then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${j.ref} ${j.area}`);
      await c.query(`UPDATE ops.ut_job SET task_id = $2, attempts = $3, arrived_at = NULL, isolated_at = NULL, restored_at = NULL, reinstated_at = NULL, result = NULL, result_note = NULL,
                       checks = NULL, version = version + 1 WHERE id = $1`, [id, task.id, n]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'utilities.assigned', targetType: 'ut_job', targetId: id, after: { task: task.id, lead, asset, attempt: n } });
      return this.job(c, id);
    });
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state === 'canceled') return j;
      if (!['open', 'assigned', 'failed'].includes(j.state)) throw new ConflictException(`the order is ${j.state}`);
      if (j.task_id && j.state === 'assigned') {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [j.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [j.task_id]);
        await event(c, a, j.task_id as string, j.task_status as string, 'canceled', reason);
      }
      await c.query('UPDATE ops.ut_job SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'utilities.canceled', targetType: 'ut_job', targetId: id, after: { reason } });
      return this.job(c, id);
    });
  }

  /**
   * Now: orders past their due time without the crew on site, open orders due within two hours with no crew, digging
   * orders without a valid permit or with one expiring soon, digging not reinstated days after the repair, and temporary repairs to follow up.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const open = (await c.query(`${JOB_SQL} WHERE j.canceled_at IS NULL AND (t.status IS NULL OR t.status NOT IN ('canceled'))
                                     AND (j.restored_at IS NULL OR (j.needs_permit AND j.reinstated_at IS NULL) OR j.result = 'follow_up')
                                     AND j.reported_at > now() - interval '60 days' ORDER BY j.due_at`)).rows.map(shape);
      const now = Date.now(), today = kwToday(), warn = new Date(Date.parse(today) + PERMIT_WARN_DAYS * DAY).toISOString().slice(0, 10);
      const live = open.filter((j) => !['done', 'failed'].includes(j.state) || (j.state === 'done' && j.needs_permit && !j.reinstated_at));
      return {
        response_breach: live.filter((j) => !j.arrived_at && new Date(j.due_at).getTime() < now),
        unassigned: live.filter((j) => j.state === 'open' && new Date(j.due_at).getTime() < now + 2 * 3_600_000 && new Date(j.due_at).getTime() >= now),
        permits: live.filter((j) => j.needs_permit && !j.restored_at && (!j.permit_no || (j.permit_expires as string) <= warn)),
        not_reinstated: open.filter((j) => j.needs_permit && j.restored_at && !j.reinstated_at && new Date(j.restored_at as Date).getTime() < now - REINSTATE_DAYS * DAY),
        follow_up: open.filter((j) => j.result === 'follow_up' && ['done', 'restored'].includes(j.state)),
      };
    });
  }

  /** For a period: orders, done, response breaches, average response and restoration minutes, customer-minutes lost (outages), per customer and per network. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${JOB_SQL} WHERE (j.reported_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $1 AND $2 AND j.canceled_at IS NULL`, [f, t])).rows.map(shape);
      const avg = (l: (number | null)[]) => { const x = l.filter((n): n is number => n !== null); return x.length ? Math.round(x.reduce((s, n) => s + n, 0) / x.length) : null; };
      const sum = (l: typeof rows) => ({
        jobs: l.length, done: l.filter((j) => j.state === 'done').length, breached: l.filter((j) => j.breached).length,
        avg_response_min: avg(l.map((j) => j.response_min)), avg_restore_min: avg(l.map((j) => j.restore_min)),
        customer_minutes: l.filter((j) => j.job_type === 'outage').reduce((s, j) => s + (j.affected as number) * (j.restore_min ?? 0), 0),
        follow_up: l.filter((j) => j.result === 'follow_up').length,
      });
      const group = (key: (j: (typeof rows)[number]) => string) => {
        const by = new Map<string, typeof rows>();
        for (const j of rows) by.set(key(j), [...(by.get(key(j)) ?? []), j]);
        return [...by.entries()].map(([k, l]) => ({ key: k, ...sum(l) })).sort((x, y) => y.jobs - x.jobs);
      };
      return { from: f, to: t, totals: sum(rows), customers: group((j) => (j.customer_name as string) ?? '—'), networks: group((j) => j.network as string) };
    });
  }

  private async job(c: PoolClient, id: string, lock = false) {
    const j = (await c.query(`${JOB_SQL} WHERE j.id = $1${lock ? ' FOR UPDATE OF j' : ''}`, [id])).rows[0];
    if (!j) throw new NotFoundException();
    return shape(j);
  }
}
