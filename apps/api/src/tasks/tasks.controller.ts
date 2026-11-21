import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthGuard, AuthContext, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { pgToHttp, v } from '../common/validate';
import { canStaff, EDITABLE, STAFF_FLOW, StaffAction, TASK_STATUSES } from './task-flow';
import { createLink, isDelivery, needsProof, normalizeAttributes } from '../sectors/delivery/delivery';

const COLUMNS = `t.id, t.ref, t.legal_entity_id, t.branch_id, t.sector_pack, t.status,
  lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
  t.customer_id, cu.name AS customer_name, t.site_id, t.contract_id, t.version, t.attributes, t.created_at, t.updated_at,
  asg.worker_id, w.display_name AS worker_name, asg.asset_id, ast.plate_no`;
const FROM = `ops.task t
  LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
  LEFT JOIN workforce.worker w ON w.id = asg.worker_id
  LEFT JOIN fleet.asset ast ON ast.id = asg.asset_id
  LEFT JOIN crm.customer cu ON cu.id = t.customer_id`;
/** Default booking length when a task has no service window. [تخمين] tune per sector. */
const DEFAULT_ASSIGN_HOURS = 4;

function parseWindow(b: Record<string, unknown>): { from: string; to: string } | null | undefined {
  if (b.window === undefined) return undefined;
  if (b.window === null) return null;
  const w = b.window as { from?: unknown; to?: unknown };
  const from = typeof w?.from === 'string' ? new Date(w.from) : null;
  const to = typeof w?.to === 'string' ? new Date(w.to) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('window must be {from, to} timestamps');
  if (to <= from) throw new BadRequestException('window.to must be after window.from');
  if (to.getTime() - from.getTime() > 31 * 86_400_000) throw new BadRequestException('window longer than 31 days');
  return { from: from.toISOString(), to: to.toISOString() };
}
const version = (b: Record<string, unknown>) => v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();

/** Tasks and dispatch: create, edit, assign to a driver and vehicle, cancel, review. */
@Controller('v1/tasks')
@UseGuards(AuthGuard)
export class TasksController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Perm('tasks:read')
  list(@Auth() a: AuthContext, @Query() q: Record<string, string | undefined>) {
    const status = q.status?.split(',').map((s) => v.oneOf(s, 'status', TASK_STATUSES)) ?? null;
    const worker = v.uuid(q.worker_id, 'worker_id');
    const branch = v.uuid(q.branch_id, 'branch_id');
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw new BadRequestException('from/to must be timestamps');
    const unassigned = q.unassigned === 'true';
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${COLUMNS} FROM ${FROM}
          WHERE ($1::text[] IS NULL OR t.status = ANY($1)) AND ($2::uuid IS NULL OR asg.worker_id = $2)
            AND ($3::uuid IS NULL OR t.branch_id = $3)
            AND ($4::timestamptz IS NULL OR t.service_window IS NULL OR upper(t.service_window) > $4)
            AND ($5::timestamptz IS NULL OR t.service_window IS NULL OR lower(t.service_window) < $5)
            AND (NOT $6 OR asg.id IS NULL)
            AND (cardinality($7::uuid[]) = 0 OR t.branch_id IS NULL OR t.branch_id = ANY($7::uuid[]))
          ORDER BY lower(t.service_window) NULLS LAST, t.created_at LIMIT 500`,
        [status, worker, branch, from, to, unassigned, a.branchIds])).rows,
    }));
  }

  @Get(':id')
  @Perm('tasks:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(a, async (c) => {
      const t = (await c.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0];
      if (!t) return null;
      t.events = (await c.query(
        `SELECT from_status, to_status, occurred_at, received_at, actor_type, actor_id, note FROM ops.task_event
          WHERE task_id = $1 ORDER BY occurred_at, received_at`, [id])).rows;
      return t;
    });
    // 404, not 403: a caller must not learn that another company's task exists.
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @Perm('tasks:write')
  async create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true });
    const pack = v.str(b?.sector_pack, 'sector_pack', { required: true, max: 40 });
    const branch = v.uuid(b?.branch_id, 'branch_id');
    const ref = v.str(b?.ref, 'ref', { max: 60 });
    const attrs = v.obj(b?.attributes, 'attributes');
    const win = parseWindow(b ?? {});
    const status = b?.draft === true ? 'draft' : 'ready';
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const site = v.uuid(b?.site_id, 'site_id');
    return this.db.withTenant(a, (c) => createTask(c, a, { le: le!, pack: pack!, branch, ref, attrs, win, status, customer, site }));
  }

  @Patch(':id')
  @Perm('tasks:write')
  update(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    let attrs = v.obj(b?.attributes, 'attributes');
    const branch = v.uuid(b?.branch_id, 'branch_id');
    const win = parseWindow(b ?? {});
    return this.db.withTenant(a, async (c) => {
      const t = await this.lock(c, id, ver);
      if (!(EDITABLE as string[]).includes(t.status)) throw new ConflictException(`cannot edit a task that is ${t.status}`);
      if (attrs && isDelivery(t.sector_pack)) attrs = normalizeAttributes(attrs);
      try {
        await c.query(
          `UPDATE ops.task SET attributes = COALESCE($2::jsonb, attributes), branch_id = COALESCE($3, branch_id),
             service_window = CASE WHEN $4 THEN (CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE tstzrange($5,$6) END) ELSE service_window END,
             version = version + 1, updated_at = now() WHERE id = $1`,
          [id, attrs && JSON.stringify(attrs), branch, win !== undefined, win?.from ?? null, win?.to ?? null]);
        if (win) {
          await c.query('UPDATE ops.assignment SET period = tstzrange($2,$3) WHERE task_id = $1 AND active', [id, win.from, win.to]);
        }
      } catch (e) { return this.conflict(e); }
      const row = (await c.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'task.updated', targetType: 'task', targetId: id, before: t, after: row });
      return row;
    });
  }

  /** Assign (or reassign) to a driver, optionally with a vehicle. exclusive=true blocks overlapping bookings of the same driver/vehicle. */
  @Post(':id/assign')
  @HttpCode(200)
  @Perm('tasks:assign')
  assign(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const workerId = v.uuid(b?.worker_id, 'worker_id', { required: true });
    const assetId = v.uuid(b?.asset_id, 'asset_id');
    const exclusive = b?.exclusive === true;
    return this.db.withTenant(a, async (c) => {
      const t = await this.lock(c, id, ver);
      if (!canStaff('assign', t.status)) throw new ConflictException(`cannot assign a task that is ${t.status}`);
      const w = (await c.query('SELECT legal_entity_id, status FROM workforce.worker WHERE id = $1', [workerId])).rows[0];
      if (!w) throw new BadRequestException('unknown worker_id');
      if (w.status !== 'active') throw new ConflictException(`worker is ${w.status}`);
      if (w.legal_entity_id !== t.legal_entity_id) throw new BadRequestException('worker belongs to another legal entity');
      if (assetId) {
        const asset = (await c.query('SELECT legal_entity_id, status FROM fleet.asset WHERE id = $1', [assetId])).rows[0];
        if (!asset) throw new BadRequestException('unknown asset_id');
        if (asset.status === 'out_of_service' || asset.status === 'retired') throw new ConflictException(`vehicle is ${asset.status}`);
        if (asset.legal_entity_id !== t.legal_entity_id) throw new BadRequestException('vehicle belongs to another legal entity');
      }
      await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [id]);
      try {
        await c.query(
          `INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE((SELECT service_window FROM ops.task WHERE id = $3), tstzrange(now(), now() + make_interval(hours => $7))), $8)`,
          [randomUUID(), a.tenantId, id, workerId, assetId, exclusive, DEFAULT_ASSIGN_HOURS, a.userId]);
      } catch (e) { return this.conflict(e); }
      return this.transition(c, a, id, t.status, 'assign', null);
    });
  }

  @Post(':id/unassign')
  @HttpCode(200)
  @Perm('tasks:assign')
  unassign(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.simple(a, id, b, 'unassign', { endAssignment: true });
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Perm('tasks:write')
  publish(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.simple(a, id, b, 'publish');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Perm('tasks:write')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.simple(a, id, b, 'cancel', { endAssignment: true, reason: true });
  }

  @Post(':id/review')
  @HttpCode(200)
  @Perm('tasks:write')
  review(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.simple(a, id, b, 'review');
  }

  /** A failed task goes back to the queue to be assigned again. */
  @Post(':id/reopen')
  @HttpCode(200)
  @Perm('tasks:write')
  reopen(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.simple(a, id, b, 'reopen', { endAssignment: true });
  }

  private simple(a: AuthContext, id: string, b: Record<string, unknown>, action: StaffAction, o: { endAssignment?: boolean; reason?: boolean } = {}) {
    const ver = version(b);
    const note = v.str(b?.reason, 'reason', { required: !!o.reason, max: 500 });
    return this.db.withTenant(a, async (c) => {
      const t = await this.lock(c, id, ver);
      if (!canStaff(action, t.status)) throw new ConflictException(`cannot ${action} a task that is ${t.status}`);
      if (action === 'review' && isDelivery(t.sector_pack)) {
        const pod = (await c.query('SELECT verified FROM ops.delivery_pod WHERE task_id = $1', [id])).rows[0];
        if (pod && !pod.verified) throw new ConflictException('approve the proof of delivery first');
        if (!pod && (await needsProof(c, t))) throw new ConflictException('proof of delivery missing');
      }
      if (o.endAssignment) await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [id]);
      return this.transition(c, a, id, t.status, action, note);
    });
  }

  /** Locks the task row and checks the caller saw the latest version (optimistic lock, QA 4.x). */
  private async lock(c: PoolClient, id: string, ver: number) {
    const t = (await c.query('SELECT id, status, version, legal_entity_id, sector_pack, attributes FROM ops.task WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!t) throw new NotFoundException();
    if (t.version !== ver) throw new ConflictException({ message: 'task changed since you loaded it', current_version: t.version, status: t.status });
    return t;
  }

  private async transition(c: PoolClient, a: AuthContext, id: string, from: string, action: StaffAction, note: string | null) {
    const to = STAFF_FLOW[action].to;
    await c.query('UPDATE ops.task SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, to]);
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
       VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, id, from, to, a.userId, randomUUID(), note]);
    return (await c.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0];
  }

  private conflict(e: unknown): never {
    const k = (e as { constraint?: string }).constraint;
    if (k === 'no_worker_overlap') throw new ConflictException('driver already has an exclusive booking in this window');
    if (k === 'no_asset_overlap') throw new ConflictException('vehicle is already booked in this window');
    return pgToHttp(e);
  }
}

export interface NewTask {
  le: string; pack: string; branch: string | null; ref: string | null; attrs: Record<string, unknown> | null;
  win: { from: string; to: string } | null | undefined; status: 'draft' | 'ready'; customer: string | null; site: string | null;
}

/**
 * Creates a task inside the caller's transaction. Shared by staff (/tasks) and the customer portal.
 * Links the customer's active contract for the task date, so it is priced by the prices agreed at the time.
 */
export async function createTask(c: PoolClient, a: AuthContext, t: NewTask) {
  // The legal entity must belong to the caller's tenant and scope (RLS hides others).
  if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [t.le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
  if (t.ref) {
    const prior = (await c.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.ref = $1`, [t.ref])).rows[0];
    if (prior) return prior; // same order sent twice: return the existing task
  }
  let contract: string | null = null;
  if (t.customer) {
    const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [t.customer])).rows[0];
    if (!cu) throw new BadRequestException('unknown customer_id');
    if (cu.legal_entity_id !== t.le) throw new BadRequestException('customer belongs to another legal entity');
    if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
    contract = (await c.query(
      `SELECT k.id FROM crm.contract k JOIN org.legal_entity le ON le.id = k.legal_entity_id
        WHERE k.customer_id = $1 AND k.status = 'active'
          AND k.starts_on <= ($2::timestamptz AT TIME ZONE le.timezone)::date
          AND (k.ends_on IS NULL OR k.ends_on >= ($2::timestamptz AT TIME ZONE le.timezone)::date)`,
      [t.customer, t.win?.from ?? new Date().toISOString()])).rows[0]?.id ?? null;
  }
  if (t.site) {
    if (!t.customer) throw new BadRequestException('site_id needs customer_id');
    if (!(await c.query('SELECT 1 FROM crm.site WHERE id = $1 AND customer_id = $2 AND active', [t.site, t.customer])).rowCount) throw new BadRequestException('unknown site_id for this customer');
  }
  const delivery = isDelivery(t.pack);
  if (delivery) t = { ...t, attrs: normalizeAttributes(t.attrs) };
  const id = randomUUID();
  try {
    await c.query(
      `INSERT INTO ops.task (id, tenant_id, legal_entity_id, branch_id, sector_pack, status, service_window, ref, attributes, created_by, customer_id, site_id, contract_id)
       VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE tstzrange($7,$8) END,$9,COALESCE($10::jsonb,'{}'),$11,$12,$13,$14)`,
      [id, a.tenantId, t.le, t.branch, t.pack, t.status, t.win?.from ?? null, t.win?.to ?? null, t.ref, t.attrs && JSON.stringify(t.attrs), a.userId, t.customer, t.site, contract]);
  } catch (e) { return pgToHttp(e); }
  if (delivery) await createLink(c, a.tenantId, id);
  const row = (await c.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0];
  await audit(c, { tenantId: a.tenantId, actorId: a.userId, actorType: a.customerId ? 'customer' : 'user', action: 'task.created', targetType: 'task', targetId: id, after: row });
  return row;
}

export { parseWindow };
