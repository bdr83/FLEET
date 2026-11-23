import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import {
  INFESTATION, inWarranty, jobState, LICENSE_DOC, parseApplications, PEST, PESTS, PREMISES, reentryAt, SERVICES, Stage, treatRule, UNASSIGNED_HOURS, UNITS, WARRANTY_DAYS,
} from './pest';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const kwDate = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;

const PRODUCT_COLS = `p.id, p.name, p.active_ingredient, p.registration_no, p.unit, p.reentry_hours, p.active, p.version`;

const JOB_SQL = `
  SELECT j.id, j.ref, j.legal_entity_id, j.customer_id, cu.name AS customer_name, j.premises, j.area, j.address, j.lat, j.lng, j.contact_phone, j.pests, j.service,
         j.scheduled_at, j.duration_min, j.warranty_days, j.repeat_days, j.parent_job_id, pj.ref AS parent_ref, j.in_warranty, j.notes, j.task_id,
         j.arrived_at, j.treated_at, j.infestation, j.received_by, j.result_note, j.reentry_at, j.next_job_id, nj.ref AS next_ref, j.canceled_at, j.cancel_reason, j.created_at, j.version,
         t.status AS task_status, asg.worker_id AS technician_id, w.display_name AS technician_name, asg.asset_id, fa.plate_no,
         (SELECT e.reason_code FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed' ORDER BY e.occurred_at DESC LIMIT 1) AS fail_reason
    FROM ops.pc_job j JOIN crm.customer cu ON cu.id = j.customer_id LEFT JOIN ops.pc_job pj ON pj.id = j.parent_job_id LEFT JOIN ops.pc_job nj ON nj.id = j.next_job_id
    LEFT JOIN ops.task t ON t.id = j.task_id
    LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id`;

type Row = Record<string, unknown> & { canceled_at: unknown; arrived_at: unknown; treated_at: unknown; task_status: string | null };
const shape = <T extends Row>(j: T) => ({ ...j, state: jobState(j, j.task_status) });

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

const validLicense = async (c: PoolClient, workerId: string, day: string) =>
  !!(await c.query(`SELECT 1 FROM core.document WHERE worker_id = $1 AND doc_type = $2 AND archived_at IS NULL AND (expires_on IS NULL OR expires_on >= $3::date)`, [workerId, LICENSE_DOC, day])).rowCount;

async function nextRef(c: PoolClient, a: AuthContext) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('pc_job:' || $1))`, [a.tenantId]);
  return `PC-${(await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.pc_job`)).rows[0].n}`;
}

/** A copy of a job for a later visit (the next one of a contract, or a callback). */
async function copyJob(c: PoolClient, a: AuthContext, src: Record<string, unknown>, x: { at: Date; parent: string | null; inWarranty: boolean; notes: string | null }) {
  const id = randomUUID(), ref = await nextRef(c, a);
  await c.query(`INSERT INTO ops.pc_job (id, tenant_id, legal_entity_id, ref, customer_id, premises, area, address, lat, lng, contact_phone, pests, service, scheduled_at, duration_min,
                   warranty_days, repeat_days, parent_job_id, in_warranty, notes, created_by)
                 SELECT $1, tenant_id, legal_entity_id, $2, customer_id, premises, area, address, lat, lng, contact_phone, pests, service, $3, duration_min,
                   warranty_days, CASE WHEN $4::uuid IS NULL THEN repeat_days END, $4, $5, coalesce($6, notes), $7 FROM ops.pc_job WHERE id = $8`,
    [id, ref, x.at, x.parent, x.inWarranty, x.notes, a.userId, src.id]);
  return { id, ref };
}

/**
 * The technician's stages: arrived, then treated with the products used, the infestation level and the customer's name.
 * The re-entry time comes from the products used. Returns a reject code.
 */
export async function pestStage(c: PoolClient, a: AuthContext, taskId: string, code: Stage, x: { at: Date; applications: unknown; infestation: string | null; receivedBy: string | null; note: string | null }): Promise<string | null> {
  const j = (await c.query('SELECT id, service FROM ops.pc_job WHERE task_id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!j) return 'not_supported';
  if (code === 'pc_arrived') {
    await c.query('UPDATE ops.pc_job SET arrived_at = $2, version = version + 1 WHERE id = $1', [j.id, x.at]);
    return null;
  }
  let apps;
  try { apps = parseApplications(x.applications); } catch { return 'products_invalid'; }
  if (x.infestation && !(INFESTATION as readonly string[]).includes(x.infestation)) return 'infestation_required';
  const bad = treatRule(j.service, apps.length, x.infestation, x.receivedBy?.trim() || null);
  if (bad) return bad;
  const ids = [...new Set(apps.map((p) => p.product_id))];
  const products = (await c.query('SELECT id, reentry_hours FROM ops.pc_product WHERE id = ANY($1::uuid[]) AND active', [ids])).rows as { id: string; reentry_hours: number }[];
  if (products.length !== ids.length) return 'unknown_product';
  for (const p of apps) {
    await c.query(`INSERT INTO ops.pc_application (id, tenant_id, job_id, product_id, qty, location, applied_at, source, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'technician',$8)`,
      [randomUUID(), a.tenantId, j.id, p.product_id, p.qty, p.location, x.at, a.userId || null]);
  }
  const reentry = reentryAt(x.at, products.map((p) => p.reentry_hours));
  await c.query('UPDATE ops.pc_job SET treated_at = $2, infestation = $3, received_by = $4, result_note = $5, reentry_at = $6, version = version + 1 WHERE id = $1',
    [j.id, x.at, x.infestation, x.receivedBy!.trim(), x.note, reentry]);
  return null;
}

/** A job ends treated; a contract job creates its next visit. */
export async function pestFinish(c: PoolClient, a: AuthContext, taskId: string): Promise<string | null> {
  const j = (await c.query('SELECT * FROM ops.pc_job WHERE task_id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!j) return null;
  if (!j.treated_at) return 'proof_required';
  if (j.repeat_days && !j.next_job_id) {
    const n = await copyJob(c, a, j, { at: new Date(new Date(j.scheduled_at).getTime() + j.repeat_days * DAY), parent: null, inWarranty: false, notes: null });
    await c.query('UPDATE ops.pc_job SET next_job_id = $2 WHERE id = $1', [j.id, n.id]);
  }
  return null;
}

@Controller('v1/pest')
@UseGuards(AuthGuard)
@Pack('pest')
export class PestController {
  constructor(private readonly db: DbService) {}

  // ---- pesticide register ----

  @Get('products')
  @Perm('tasks:read')
  products(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`SELECT ${PRODUCT_COLS} FROM ops.pc_product p ORDER BY p.active DESC, p.name`)).rows }));
  }

  @Post('products')
  @Perm('tasks:assign')
  addProduct(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const x = this.parseProduct(b, null);
    return this.db.withTenant(a, async (c) => {
      const id = randomUUID();
      try {
        await c.query(`INSERT INTO ops.pc_product (id, tenant_id, name, active_ingredient, registration_no, unit, reentry_hours) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, a.tenantId, x.name, x.active_ingredient, x.registration_no, x.unit, x.reentry_hours]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'pc_product_name') throw new ConflictException('a product with this name exists');
        throw e;
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pest.product_added', targetType: 'pc_product', targetId: id, after: x });
      return (await c.query(`SELECT ${PRODUCT_COLS} FROM ops.pc_product p WHERE p.id = $1`, [id])).rows[0];
    });
  }

  /** Changes a product (version required); active false takes it off the technicians' list. */
  @Patch('products/:id')
  @Perm('tasks:assign')
  editProduct(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`SELECT ${PRODUCT_COLS} FROM ops.pc_product p WHERE p.id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException();
      if (before.version !== ver) throw new ConflictException('product changed meanwhile; reload');
      const x = this.parseProduct(b, before);
      if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
      const active = b?.active ?? before.active;
      await c.query(`UPDATE ops.pc_product SET name = $2, active_ingredient = $3, registration_no = $4, unit = $5, reentry_hours = $6, active = $7, version = version + 1 WHERE id = $1`,
        [id, x.name, x.active_ingredient, x.registration_no, x.unit, x.reentry_hours, active]);
      const after = (await c.query(`SELECT ${PRODUCT_COLS} FROM ops.pc_product p WHERE p.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pest.product_changed', targetType: 'pc_product', targetId: id, before, after });
      return after;
    });
  }

  // ---- jobs ----

  /** Jobs scheduled on a day plus every job still open from before. */
  @Get('jobs')
  @Perm('tasks:read')
  jobs(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({
      date: day,
      data: (await c.query(
        `${JOB_SQL} WHERE (j.scheduled_at AT TIME ZONE 'Asia/Kuwait')::date = $1
            OR ((j.scheduled_at AT TIME ZONE 'Asia/Kuwait')::date < $1 AND j.canceled_at IS NULL AND (t.status IS NULL OR t.status NOT IN ('completed','reviewed','invoiced','canceled')))
          ORDER BY j.scheduled_at, j.ref`, [day])).rows.map(shape),
    }));
  }

  @Post('jobs')
  @Perm('tasks:assign')
  addJob(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const premises = v.oneOf(b?.premises, 'premises', PREMISES, { required: true })!;
    const service = v.oneOf(b?.service, 'service', SERVICES, { required: true })!;
    if (!Array.isArray(b?.pests) || b.pests.length === 0 || b.pests.length > 10) throw new BadRequestException('pests must be 1-10 of ' + PESTS.join(', '));
    const pests = [...new Set(b.pests.map((p, i) => v.oneOf(p, `pests[${i}]`, PESTS, { required: true })!))];
    const at = b?.scheduled_at ? new Date(String(b.scheduled_at)) : null;
    if (!at || Number.isNaN(at.getTime())) throw new BadRequestException('scheduled_at required');
    const duration = v.int(b?.duration_min, 'duration_min', 15, 600) ?? 90;
    const warranty = v.int(b?.warranty_days, 'warranty_days', 0, 365) ?? WARRANTY_DAYS;
    const repeat = v.int(b?.repeat_days, 'repeat_days', 7, 365);
    const area = v.str(b?.area, 'area', { required: true, max: 80 })!;
    const address = v.str(b?.address, 'address', { max: 200 });
    const phone = v.str(b?.contact_phone, 'contact_phone', { max: 20 });
    const notes = v.str(b?.notes, 'notes', { max: 500 });
    const lat = b?.lat === undefined || b?.lat === null ? null : Number(b.lat), lng = b?.lng === undefined || b?.lng === null ? null : Number(b.lng);
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng!) || Math.abs(lng!) > 180))) throw new BadRequestException('lat/lng invalid');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [customer, le])).rowCount) throw new BadRequestException('unknown customer_id');
      const id = randomUUID(), ref = await nextRef(c, a);
      await c.query(`INSERT INTO ops.pc_job (id, tenant_id, legal_entity_id, ref, customer_id, premises, area, address, lat, lng, contact_phone, pests, service, scheduled_at, duration_min,
                       warranty_days, repeat_days, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, a.tenantId, le, ref, customer, premises, area, address, lat, lng, phone, pests, service, at, duration, warranty, repeat, notes, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pest.job_created', targetType: 'pc_job', targetId: id, after: { ref, premises, service, pests } });
      return this.job(c, id);
    });
  }

  @Get('jobs/:id')
  @Perm('tasks:read')
  getJob(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.job(c, id));
  }

  /** Books a technician (with a valid pesticide licence that day) and optionally a vehicle; re-assigning replaces the booking. */
  @Post('jobs/:id/assign')
  @Perm('tasks:assign')
  assign(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const tech = v.uuid(b?.worker_id, 'worker_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id');
    const start = b?.start_at ? new Date(String(b.start_at)) : null;
    if (start && Number.isNaN(start.getTime())) throw new BadRequestException('start_at invalid');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (!['open', 'assigned', 'failed'].includes(j.state)) throw new ConflictException(`the job is ${j.state}`);
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [tech, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown worker_id');
      if (asset && !(await c.query(`SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2 AND status NOT IN ('out_of_service','retired')`, [asset, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown or unavailable asset_id');
      const from = start ?? new Date(j.scheduled_at as Date);
      if (!(await validLicense(c, tech, kwDate(from)))) throw new ConflictException('license_required: the technician has no valid pesticide licence that day');
      const to = new Date(from.getTime() + (j.duration_min as number) * 60_000);
      if (j.task_id) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [j.task_id]);
        if (j.state === 'assigned') {
          await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [j.task_id]);
          await event(c, a, j.task_id as string, j.task_status as string, 'canceled', 'technician changed');
        }
      }
      const products = (await c.query('SELECT id, name, unit, reentry_hours FROM ops.pc_product WHERE active ORDER BY name')).rows;
      const parent = j.parent_job_id ? (await c.query('SELECT ref, infestation, result_note FROM ops.pc_job WHERE id = $1', [j.parent_job_id])).rows[0] : null;
      const n = (await c.query('SELECT count(*)::int AS n FROM ops.task WHERE ref LIKE $1', [`${j.ref}-%`])).rows[0].n + 1;
      const task = await createTask(c, a, {
        le: j.legal_entity_id as string, pack: PEST, branch: null, status: 'ready', customer: j.customer_id as string, site: null, ref: `${j.ref}-${n}`,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { kind: 'pest_job', job_id: id, job_ref: j.ref, premises: j.premises, pests: j.pests, service: j.service, notes: j.notes, customer_name: j.customer_name,
          contact_phone: j.contact_phone, address: [j.address, j.area].filter(Boolean).join('، '), in_warranty: j.in_warranty, products,
          ...(parent ? { previous: `${parent.ref}: ${parent.infestation ?? ''}${parent.result_note ? ` · ${parent.result_note}` : ''}` } : {}),
          ...(j.lat !== null ? { dropoff: { name: j.area, lat: j.lat, lng: j.lng } } : {}) },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, tech, asset, from.toISOString(), to.toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('technician_booked: the technician has another booking then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the vehicle is booked then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${j.ref} ${j.area}`);
      await c.query('UPDATE ops.pc_job SET task_id = $2, arrived_at = NULL, version = version + 1 WHERE id = $1', [id, task.id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pest.assigned', targetType: 'pc_job', targetId: id, after: { task: task.id, tech, asset } });
      return this.job(c, id);
    });
  }

  /** The customer calls back after a treatment: a follow-up job, free when within the warranty. */
  @Post('jobs/:id/callback')
  @Perm('tasks:assign')
  callback(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    const at = b?.scheduled_at ? new Date(String(b.scheduled_at)) : null;
    if (!at || Number.isNaN(at.getTime())) throw new BadRequestException('scheduled_at required');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state !== 'done') throw new ConflictException('only a treated job can be called back');
      const w = inWarranty(j.treated_at as Date, j.warranty_days as number, new Date());
      const n = await copyJob(c, a, j, { at, parent: id, inWarranty: w, notes: reason });
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pest.callback', targetType: 'pc_job', targetId: n.id, after: { parent: j.ref, in_warranty: w, reason } });
      return this.job(c, n.id);
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
      if (!['open', 'assigned', 'failed'].includes(j.state)) throw new ConflictException(`the job is ${j.state}`);
      if (j.task_id) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [j.task_id]);
        if (j.state === 'assigned') {
          await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [j.task_id]);
          await event(c, a, j.task_id as string, j.task_status as string, 'canceled', reason);
        }
      }
      await c.query('UPDATE ops.pc_job SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pest.canceled', targetType: 'pc_job', targetId: id, after: { reason } });
      return this.job(c, id);
    });
  }

  // ---- watch and report ----

  /**
   * Now: jobs due within a day without a technician, jobs past their time not treated, open warranty callbacks, heavy
   * infestations found in the last 30 days, technicians booked in the next 7 days whose licence is missing or ends
   * before the visit, and products without a registration number.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const now = Date.now();
      const open = (await c.query(`${JOB_SQL} WHERE j.canceled_at IS NULL AND j.treated_at IS NULL AND j.scheduled_at < now() + interval '7 days'
                                     AND (t.status IS NULL OR t.status NOT IN ('completed','reviewed','invoiced','canceled')) ORDER BY j.scheduled_at`)).rows.map(shape);
      const licence = [];
      for (const j of open.filter((x) => x.technician_id && x.state !== 'failed')) {
        if (!(await validLicense(c, j.technician_id as string, kwDate(j.scheduled_at as Date)))) licence.push(j);
      }
      return {
        unassigned: open.filter((j) => ['open', 'failed'].includes(j.state) && new Date(j.scheduled_at as Date).getTime() < now + UNASSIGNED_HOURS * 3_600_000),
        overdue: open.filter((j) => !['open', 'failed'].includes(j.state) && new Date(j.scheduled_at as Date).getTime() + (j.duration_min as number) * 60_000 < now),
        callbacks: open.filter((j) => j.parent_job_id),
        high_infestation: (await c.query(`${JOB_SQL} WHERE j.infestation = 'high' AND j.treated_at > now() - interval '30 days' ORDER BY j.treated_at DESC`)).rows.map(shape),
        license_missing: licence,
        unregistered_products: (await c.query(`SELECT ${PRODUCT_COLS} FROM ops.pc_product p WHERE p.active AND p.registration_no IS NULL ORDER BY p.name`)).rows,
      };
    });
  }

  /** For a period (by the visit day): jobs, done, callbacks and the callback rate, by pest and premises, and the pesticide used per product. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const jobs = (await c.query(`${JOB_SQL} WHERE (j.scheduled_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $1 AND $2 AND j.canceled_at IS NULL`, [f, t])).rows.map(shape);
      const done = jobs.filter((j) => j.state === 'done');
      const callbacks = jobs.filter((j) => j.parent_job_id);
      const count = (keys: string[]) => {
        const m = new Map<string, { jobs: number; done: number; high: number }>();
        return { add(k: string, j: (typeof jobs)[number]) { const x = m.get(k) ?? { jobs: 0, done: 0, high: 0 }; x.jobs++; if (j.state === 'done') x.done++; if (j.infestation === 'high') x.high++; m.set(k, x); },
          rows: () => keys.filter((k) => m.has(k)).map((k) => ({ key: k, ...m.get(k)! })) };
      };
      const byPest = count([...PESTS]), byPremises = count([...PREMISES]);
      for (const j of jobs) { for (const p of j.pests as string[]) byPest.add(p, j); byPremises.add(j.premises as string, j); }
      const products = (await c.query(
        `SELECT p.name, p.unit, p.registration_no, sum(x.qty)::float AS qty, count(DISTINCT x.job_id)::int AS jobs
           FROM ops.pc_application x JOIN ops.pc_product p ON p.id = x.product_id JOIN ops.pc_job j ON j.id = x.job_id
          WHERE (j.scheduled_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $1 AND $2 GROUP BY p.name, p.unit, p.registration_no ORDER BY p.name`, [f, t])).rows;
      return {
        from: f, to: t,
        totals: { jobs: jobs.length, done: done.length, callbacks: callbacks.length, in_warranty: callbacks.filter((j) => j.in_warranty).length,
          callback_rate: done.length ? Math.round((callbacks.length / done.length) * 100) : null, high: done.filter((j) => j.infestation === 'high').length },
        pests: byPest.rows(), premises: byPremises.rows(), products,
      };
    });
  }

  // ---- helpers ----

  private async job(c: PoolClient, id: string, lock = false) {
    if (lock) await c.query('SELECT 1 FROM ops.pc_job WHERE id = $1 FOR UPDATE', [id]);
    const j = (await c.query(`${JOB_SQL} WHERE j.id = $1`, [id])).rows[0];
    if (!j) throw new NotFoundException();
    const applications = (await c.query(
      `SELECT x.id, p.name AS product_name, p.unit, p.registration_no, x.qty::float AS qty, x.location, x.applied_at, x.source
         FROM ops.pc_application x JOIN ops.pc_product p ON p.id = x.product_id WHERE x.job_id = $1 ORDER BY x.applied_at, p.name`, [id])).rows;
    const callbacks = (await c.query('SELECT id, ref, scheduled_at, in_warranty FROM ops.pc_job WHERE parent_job_id = $1 ORDER BY scheduled_at', [id])).rows;
    return { ...shape(j), applications, callbacks };
  }

  private parseProduct(b: Record<string, unknown>, prev: Record<string, unknown> | null) {
    const pick = <T>(k: string, f: (x: unknown) => T): T => (b?.[k] === undefined && prev ? (prev[k] as T) : f(b?.[k]));
    return {
      name: pick('name', (x) => v.str(x, 'name', { required: true, max: 120 })!.trim()),
      active_ingredient: pick('active_ingredient', (x) => v.str(x, 'active_ingredient', { max: 120 })),
      registration_no: pick('registration_no', (x) => v.str(x, 'registration_no', { max: 60 })),
      unit: pick('unit', (x) => v.oneOf(x, 'unit', UNITS, { required: true })!),
      reentry_hours: pick('reentry_hours', (x) => v.int(x, 'reentry_hours', 0, 72) ?? 0),
    };
  }
}
