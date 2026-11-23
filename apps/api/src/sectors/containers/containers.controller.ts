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
import { CONTAINERS, ctrState, daysLate, Direction, DIRECTIONS, ENDS_AT_CUSTOMER, LEG_MIN, LegKind, NEEDS_GATE_REF, nextLeg, normContainer, PORTS, SIZES, Stage, TYPES, WARN_DAYS } from './containers';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const KW = `AT TIME ZONE 'Asia/Kuwait'`;
const PORT_NAME: Record<string, string> = { shuwaikh: 'ميناء الشويخ', shuaiba: 'ميناء الشعيبة', doha: 'ميناء الدوحة', other: 'الميناء' };

const JOB_SQL = `
  SELECT j.id, j.ref, j.legal_entity_id, j.customer_id, cu.name AS customer_name, cu.phone AS customer_phone, j.direction, j.container_no, j.iso_size, j.ctype, j.line, j.doc_no,
         j.seal_no, j.weight_kg, j.port, j.depot, j.site, j.last_free_day::text, j.return_by::text, j.picked_at, j.at_customer_at, j.emptied_at, j.done_at,
         j.haulage_amount::text, j.extra_amount::text, (COALESCE(j.haulage_amount, 0) + COALESCE(j.extra_amount, 0))::text AS total, j.closed_at, j.canceled_at, j.cancel_reason,
         j.notes, j.created_at, j.version
    FROM ops.ctr_job j JOIN crm.customer cu ON cu.id = j.customer_id`;

const LEG_SQL = `
  SELECT l.task_id, l.job_id, j.ref AS job_ref, j.container_no, j.iso_size, l.seq, l.kind, t.ref, t.status, lower(t.service_window) AS starts_at, upper(t.service_window) AS ends_at,
         asg.worker_id AS driver_id, w.display_name AS driver_name, asg.asset_id, fa.plate_no, l.picked_at, l.dropped_at, l.seal_no, l.received_by, l.gate_ref, cu.name AS customer_name
    FROM ops.ctr_leg l JOIN ops.ctr_job j ON j.id = l.job_id JOIN ops.task t ON t.id = l.task_id JOIN crm.customer cu ON cu.id = j.customer_id
    LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id`;

const siteLine = (s: Record<string, unknown>) =>
  [s.name, s.area, s.block ? `ق ${s.block}` : null, s.street, s.house ? `منزل ${s.house}` : null].filter((x) => typeof x === 'string' && x).join('، ') || null;

function parseSite(val: unknown) {
  const raw = v.obj(val, 'site') ?? (() => { throw new BadRequestException('site required'); })();
  const site = normalizeAttributes({ dropoff: raw })!.dropoff as Record<string, unknown>;
  if (!site.area && !site.name) throw new BadRequestException('site needs an area or a name');
  return site;
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

/**
 * Pickup and drop of a container leg from the driver's app. Pickup checks the container number the driver typed (and
 * takes the seal); drop needs the receiver at a customer, or the gate receipt at a port or depot. Returns a reject code.
 */
export async function containerStage(c: PoolClient, taskId: string, code: Stage,
  x: { at: Date; containerNo: string | null; sealNo: string | null; receivedBy: string | null; gateRef: string | null }): Promise<string | null> {
  const l = (await c.query(`SELECT l.job_id, l.seq, l.kind, j.container_no, j.direction FROM ops.ctr_leg l JOIN ops.ctr_job j ON j.id = l.job_id WHERE l.task_id = $1 FOR UPDATE OF l`, [taskId])).rows[0];
  if (!l) return 'not_supported';
  const kind = l.kind as LegKind;
  if (code === 'ctr_picked') {
    if (!x.containerNo) return 'container_required';
    if (normContainer(x.containerNo) !== l.container_no) return 'container_mismatch';
    if (l.seq > 1 && (await c.query(`SELECT 1 FROM ops.ctr_leg p JOIN ops.task t ON t.id = p.task_id WHERE p.job_id = $1 AND p.seq < $2 AND p.dropped_at IS NULL AND t.status NOT IN ('canceled','failed')`, [l.job_id, l.seq])).rowCount) {
      return 'previous_leg_open';
    }
    await c.query('UPDATE ops.ctr_leg SET picked_at = $2, seal_no = COALESCE($3, seal_no) WHERE task_id = $1', [taskId, x.at.toISOString(), x.sealNo]);
    await c.query('UPDATE ops.ctr_job SET picked_at = COALESCE(picked_at, $2), seal_no = COALESCE($3, seal_no), version = version + 1 WHERE id = $1', [l.job_id, x.at.toISOString(), x.sealNo]);
    return null;
  }
  if (NEEDS_GATE_REF.includes(kind) ? !x.gateRef : !x.receivedBy) return NEEDS_GATE_REF.includes(kind) ? 'gate_ref_required' : 'receiver_required';
  await c.query('UPDATE ops.ctr_leg SET dropped_at = $2, received_by = $3, gate_ref = $4 WHERE task_id = $1', [taskId, x.at.toISOString(), x.receivedBy, x.gateRef]);
  const col = ENDS_AT_CUSTOMER.includes(kind) ? 'at_customer_at' : 'done_at';
  await c.query(`UPDATE ops.ctr_job SET ${col} = $2, version = version + 1 WHERE id = $1`, [l.job_id, x.at.toISOString()]);
  return null;
}

@Controller('v1/containers')
@UseGuards(AuthGuard)
@Pack('containers')
export class ContainersController {
  constructor(private readonly db: DbService) {}

  @Get('jobs')
  @Perm('tasks:read')
  jobs(@Auth() a: AuthContext, @Query('state') state?: string, @Query('q') q?: string) {
    const term = v.str(q, 'q', { max: 40 });
    return this.db.withTenant(a, async (c) => {
      const rows = await this.withState(c, (await c.query(`${JOB_SQL} WHERE ($1::text IS NULL OR j.container_no LIKE '%' || upper($1) || '%' OR j.doc_no ILIKE '%' || $1 || '%' OR j.ref = upper($1))
                                                           ORDER BY j.created_at DESC LIMIT 500`, [term])).rows);
      return { data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** A container to move: the number (ISO 6346, check digit), size and type, the line and document, the port, the customer's site and the free dates. */
  @Post('jobs')
  @Perm('tasks:assign')
  addJob(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const direction = v.oneOf(b?.direction, 'direction', DIRECTIONS, { required: true })!;
    const no = normContainer(b?.container_no);
    if (!no) throw new BadRequestException('container_no must be a valid ISO 6346 number (e.g. MSCU1234565)');
    const size = v.oneOf(b?.iso_size, 'iso_size', SIZES, { required: true })!;
    const ctype = v.oneOf(b?.ctype, 'ctype', TYPES) ?? 'dry';
    const port = v.oneOf(b?.port, 'port', PORTS, { required: true })!;
    const site = parseSite(b?.site);
    const line = v.str(b?.line, 'line', { max: 60 }), doc = v.str(b?.doc_no, 'doc_no', { max: 40 }), seal = v.str(b?.seal_no, 'seal_no', { max: 40 });
    const depot = v.str(b?.depot, 'depot', { max: 120 }), notes = v.str(b?.notes, 'notes', { max: 1000 });
    const weight = v.int(b?.weight_kg, 'weight_kg', 0, 40000);
    const free = v.date(b?.last_free_day, 'last_free_day'), ret = v.date(b?.return_by, 'return_by');
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [customer])).rows[0];
      if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
      if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.ctr_job`)).rows[0].n;
      const id = randomUUID(), ref = `CT-${n}`;
      await c.query('SAVEPOINT job');
      try {
        await c.query(`INSERT INTO ops.ctr_job (id, tenant_id, legal_entity_id, ref, customer_id, direction, container_no, iso_size, ctype, line, doc_no, seal_no, weight_kg, port, depot, site,
                         last_free_day, return_by, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [id, a.tenantId, le, ref, customer, direction, no, size, ctype, line, doc, seal, weight, port, depot, JSON.stringify(site), free, ret, notes, a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT job');
        if ((e as { constraint?: string }).constraint === 'ctr_job_one_open') throw new ConflictException('container_open: this container already has an open job');
        throw e;
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'containers.job_opened', targetType: 'ctr_job', targetId: id, after: { ref, container_no: no, direction, port } });
      return this.job(c, id);
    });
  }

  @Get('jobs/:id')
  @Perm('tasks:read')
  getJob(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.job(c, id));
  }

  /** Books the next leg of the job (by its direction) with a truck and its driver. A leg can be booked before the last one ends. */
  @Post('jobs/:id/legs')
  @Perm('tasks:assign')
  addLeg(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const driver = v.uuid(b?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const at = v.ts(b?.starts_at, 'starts_at') ?? new Date();
    const dur = v.int(b?.duration_min, 'duration_min', 30, 720) ?? LEG_MIN;
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (['closed', 'canceled', 'done'].includes(j.state)) throw new ConflictException(`the job is ${j.state}`);
      const live = j.legs.filter((l: { status: string }) => !['canceled', 'failed'].includes(l.status));
      const kind = nextLeg(j.direction as Direction, live);
      if (!kind) throw new ConflictException('all legs are booked');
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [driver, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown driver_worker_id');
      if (!(await c.query(`SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2 AND status NOT IN ('out_of_service','retired')`, [asset, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown asset_id');
      const seq = j.legs.length + 1;
      const end = new Date(at.getTime() + dur * 60_000);
      const port = PORT_NAME[j.port], depot = j.depot ?? 'ساحة الحاويات الفارغة', cust = siteLine(j.site);
      const [fromLine, toLine] = ({ port_to_customer: [port, cust], empty_to_depot: [cust, depot], empty_to_customer: [depot, cust], full_to_port: [cust, port], transfer: [port, cust] } as Record<LegKind, (string | null)[]>)[kind];
      const task = await createTask(c, a, {
        le: j.legal_entity_id, pack: CONTAINERS, branch: null, status: 'ready', customer: j.customer_id, site: null, ref: `${j.ref}-${seq}`,
        win: { from: at.toISOString(), to: end.toISOString() },
        attrs: { kind: 'leg', leg: kind, job_id: id, job_ref: j.ref, seq, container_no: j.container_no, iso_size: j.iso_size, ctype: j.ctype, line: j.line, doc_no: j.doc_no, seal_no: j.seal_no,
          weight_kg: j.weight_kg, pickup_address: fromLine, address: toLine, dropoff: ENDS_AT_CUSTOMER.includes(kind) || kind === 'transfer' ? j.site : null,
          customer_name: j.customer_name, contact_phone: j.site.phone ?? j.customer_phone, gate: NEEDS_GATE_REF.includes(kind) },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, driver, asset, at.toISOString(), end.toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('driver_booked: the driver has another booking then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the truck is booked then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${kind} for ${j.ref} ${j.container_no}`);
      await c.query('INSERT INTO ops.ctr_leg (task_id, tenant_id, job_id, seq, kind) VALUES ($1,$2,$3,$4,$5)', [task.id, a.tenantId, id, seq, kind]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'containers.leg_booked', targetType: 'ctr_job', targetId: id, after: { task: task.id, seq, kind, driver, asset, at: at.toISOString() } });
      return this.job(c, id);
    });
  }

  /** The customer finished unloading (import) or stuffing (export): the box is ready to collect. */
  @Post('jobs/:id/ready')
  @HttpCode(200)
  @Perm('tasks:assign')
  ready(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const at = v.ts(b?.at, 'at') ?? new Date();
    const seal = v.str(b?.seal_no, 'seal_no', { max: 40 });
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state !== 'at_customer') throw new ConflictException('the container is not at the customer');
      await c.query('UPDATE ops.ctr_job SET emptied_at = $2, seal_no = COALESCE($3, seal_no), version = version + 1 WHERE id = $1', [id, at.toISOString(), seal]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'containers.ready', targetType: 'ctr_job', targetId: id, after: { at: at.toISOString(), seal } });
      return this.job(c, id);
    });
  }

  /** The line extended the free days or the return date. */
  @Post('jobs/:id/dates')
  @HttpCode(200)
  @Perm('tasks:assign')
  dates(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const free = v.date(b?.last_free_day, 'last_free_day'), ret = v.date(b?.return_by, 'return_by');
    if (!free && !ret) throw new BadRequestException('last_free_day or return_by required');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (['closed', 'canceled'].includes(j.state)) throw new ConflictException(`the job is ${j.state}`);
      await c.query('UPDATE ops.ctr_job SET last_free_day = COALESCE($2, last_free_day), return_by = COALESCE($3, return_by), version = version + 1 WHERE id = $1', [id, free, ret]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'containers.dates', targetType: 'ctr_job', targetId: id, before: { last_free_day: j.last_free_day, return_by: j.return_by }, after: { last_free_day: free, return_by: ret } });
      return this.job(c, id);
    });
  }

  /** Closes a job whose container is back at the depot or gated in: the haulage and any storage or detention charged on. */
  @Post('jobs/:id/close')
  @HttpCode(200)
  @Perm('tasks:assign')
  close(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const haul = v.money(b?.haulage_amount, 'haulage_amount'), extra = v.money(b?.extra_amount, 'extra_amount');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state !== 'done') throw new ConflictException(j.state === 'closed' ? 'the job is closed' : 'the container is not back yet');
      await c.query('UPDATE ops.ctr_job SET haulage_amount = $2, extra_amount = $3, closed_at = now(), closed_by = $4, version = version + 1 WHERE id = $1', [id, haul, extra, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'containers.closed', targetType: 'ctr_job', targetId: id, after: { haul, extra } });
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
      if (j.state !== 'waiting' || j.picked_at) throw new ConflictException(`the container has moved: ${j.state}`);
      for (const l of j.legs.filter((x: { status: string }) => ['ready', 'assigned', 'accepted'].includes(x.status))) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [l.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [l.task_id]);
        await event(c, a, l.task_id, l.status, 'canceled', `job canceled: ${reason}`);
      }
      await c.query('UPDATE ops.ctr_job SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'containers.canceled', targetType: 'ctr_job', targetId: id, after: { reason } });
      return this.job(c, id);
    });
  }

  // ---- the day, the yard, watch and report ----

  /** A day's legs by truck. */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({
      date: day,
      legs: (await c.query(`${LEG_SQL} WHERE (lower(t.service_window) ${KW})::date = $1 AND t.status <> 'canceled' ORDER BY fa.plate_no NULLS LAST, lower(t.service_window)`, [day])).rows,
    }));
  }

  /** Where the open containers are: waiting at the port or depot, and at customers, with the days used against the free dates. */
  @Get('yard')
  @Perm('tasks:read')
  yard(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const open = await this.withState(c, (await c.query(`${JOB_SQL} WHERE j.closed_at IS NULL AND j.canceled_at IS NULL AND j.done_at IS NULL ORDER BY j.created_at`)).rows);
      const now = Date.now();
      return {
        waiting: open.filter((j) => j.state === 'waiting'),
        at_customer: open.filter((j) => j.state === 'at_customer').map((j) => ({ ...j, days_at_customer: Math.floor((now - Date.parse(j.at_customer_at)) / 86_400_000) })),
        in_transit: open.filter((j) => j.state === 'in_transit'),
      };
    });
  }

  /** Storage risk at the port, detention risk on the empty or full return, boxes ready to collect, jobs without a booked leg, jobs to close. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const open = await this.withState(c, (await c.query(`${JOB_SQL} WHERE j.closed_at IS NULL AND j.canceled_at IS NULL ORDER BY j.created_at`)).rows);
      const warn = plusDays(kwToday(), WARN_DAYS);
      return {
        storage_risk: open.filter((j) => j.direction === 'import' && !j.picked_at && j.last_free_day && j.last_free_day <= warn),
        detention_risk: open.filter((j) => !j.done_at && j.return_by && j.return_by <= warn),
        ready_to_collect: open.filter((j) => j.state === 'at_customer' && j.emptied_at && !j.next_booked),
        unbooked: open.filter((j) => j.state === 'waiting' && !j.next_booked),
        to_close: open.filter((j) => j.state === 'done'),
      };
    });
  }

  /** For a period of job dates: containers by direction, moves, TEU, storage and detention days by line, and the amounts. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const jobs = (await c.query(`${JOB_SQL} WHERE (j.created_at ${KW})::date BETWEEN $1 AND $2 AND j.canceled_at IS NULL`, [f, t])).rows;
      const legs = (await c.query(`SELECT l.job_id FROM ops.ctr_leg l WHERE l.job_id = ANY ($1::uuid[]) AND l.dropped_at IS NOT NULL`, [jobs.map((j) => j.id)])).rows;
      const fils = (s: string | null) => Math.round(Number(s ?? 0) * 1000);
      const kwd = (n: number) => (n / 1000).toFixed(3);
      const storage = (j: { direction: string; last_free_day: string | null; picked_at: string | null }) => (j.direction === 'import' ? daysLate(j.last_free_day, j.picked_at) : 0);
      const detention = (j: { return_by: string | null; done_at: string | null }) => daysLate(j.return_by, j.done_at);
      const teu = (j: { iso_size: string }) => (j.iso_size === '20' ? 1 : 2);
      const lines = new Map<string, typeof jobs>();
      for (const j of jobs) lines.set(j.line ?? '—', [...(lines.get(j.line ?? '—') ?? []), j]);
      const closed = jobs.filter((j) => j.closed_at);
      return {
        from: f, to: t,
        totals: {
          containers: jobs.length, teu: jobs.reduce((s, j) => s + teu(j), 0), import: jobs.filter((j) => j.direction === 'import').length, export: jobs.filter((j) => j.direction === 'export').length,
          moves: legs.length, done: jobs.filter((j) => j.done_at).length, closed: closed.length,
          storage_days: jobs.reduce((s, j) => s + storage(j), 0), detention_days: jobs.reduce((s, j) => s + detention(j), 0),
          haulage: kwd(closed.reduce((s, j) => s + fils(j.haulage_amount), 0)), extra: kwd(closed.reduce((s, j) => s + fils(j.extra_amount), 0)),
        },
        lines: [...lines.entries()].map(([line, l]) => ({ line, containers: l.length, teu: l.reduce((s, j) => s + teu(j), 0), storage_days: l.reduce((s, j) => s + storage(j), 0),
          detention_days: l.reduce((s, j) => s + detention(j), 0) })).sort((x, y) => y.containers - x.containers),
      };
    });
  }

  private async job(c: PoolClient, id: string, lock = false) {
    const j = (await c.query(`${JOB_SQL} WHERE j.id = $1${lock ? ' FOR UPDATE OF j' : ''}`, [id])).rows[0];
    if (!j) throw new NotFoundException();
    const legs = (await c.query(`${LEG_SQL} WHERE l.job_id = $1 ORDER BY l.seq`, [id])).rows;
    return { ...j, ...extras(j, legs), legs };
  }

  private async withState<T extends { id: string }>(c: PoolClient, rows: T[]) {
    if (!rows.length) return [] as (T & ReturnType<typeof extras>)[];
    const ls = (await c.query(`SELECT l.job_id, l.seq, l.kind, t.status FROM ops.ctr_leg l JOIN ops.task t ON t.id = l.task_id WHERE l.job_id = ANY ($1::uuid[]) ORDER BY l.seq`, [rows.map((r) => r.id)])).rows;
    return rows.map((r) => ({ ...r, ...extras(r as never, ls.filter((l) => l.job_id === r.id)) }));
  }
}

/** The state, the next leg to book (and whether it is booked), and the storage and detention days so far. */
function extras(j: { direction: Direction; canceled_at: unknown; closed_at: unknown; at_customer_at: unknown; done_at: string | null; last_free_day: string | null; return_by: string | null; picked_at: string | null },
  legs: { kind: string; status: string }[]) {
  const live = legs.filter((l) => !['canceled', 'failed'].includes(l.status));
  const pending = live.filter((l) => !['completed', 'reviewed', 'invoiced'].includes(l.status));
  return {
    state: ctrState(j, legs), next_leg: nextLeg(j.direction, live), next_booked: pending.length > 0,
    storage_days: j.direction === 'import' ? daysLate(j.last_free_day, j.picked_at) : 0, detention_days: daysLate(j.return_by, j.done_at),
  };
}
