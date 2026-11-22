import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { v } from '../common/validate';
import { createTask, parseWindow } from '../tasks/tasks.controller';
import { approveShifts, SHIFT_SQL } from '../sectors/staffing/staffing.controller';
import { firstName } from '../sectors/staffing/staffing';
import { audit } from '../common/audit';

/** What a customer sees of a task: no internal ids of staff, and the driver only once the job is underway. */
const COLS = `t.id, t.ref, t.status, t.sector_pack, lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
  t.site_id, t.attributes, t.created_at,
  CASE WHEN t.status IN ('accepted','in_progress') THEN w.display_name END AS driver_name,
  CASE WHEN t.status IN ('accepted','in_progress') THEN ast.plate_no END AS plate_no`;
const FROM = `ops.task t
  LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
  LEFT JOIN workforce.worker w ON w.id = asg.worker_id
  LEFT JOIN fleet.asset ast ON ast.id = asg.asset_id`;

/**
 * Customer portal. Every query is pinned to the caller's own customer (from their membership),
 * on top of tenant and legal-entity isolation in the database.
 */
@Controller('v1/portal')
@UseGuards(AuthGuard)
export class PortalController {
  constructor(private readonly db: DbService) {}

  private customer(a: AuthContext): string {
    if (!a.customerId) throw new ForbiddenException('not a customer account');
    return a.customerId;
  }

  @Get('me')
  @Perm('portal:own')
  me(@Auth() a: AuthContext) {
    const id = this.customer(a);
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT id, name, phone, email FROM crm.customer WHERE id = $1', [id])).rows[0];
      cu.sites = (await c.query('SELECT id, name, address FROM crm.site WHERE customer_id = $1 AND active ORDER BY name', [id])).rows;
      return cu;
    });
  }

  /** Driver-supply day-shifts are left out: they are listed under GET /portal/staffing. */
  @Get('tasks')
  @Perm('portal:own')
  list(@Auth() a: AuthContext) {
    const id = this.customer(a);
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE t.customer_id = $1 AND t.sector_pack IS DISTINCT FROM 'staffing@1' ORDER BY t.created_at DESC LIMIT 500`, [id])).rows,
    }));
  }

  @Get('tasks/:id')
  @Perm('portal:own')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const cid = this.customer(a);
    const row = await this.db.withTenant(a, async (c) => {
      const t = (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE t.id = $1 AND t.customer_id = $2`, [id, cid])).rows[0];
      if (!t) return null;
      t.events = (await c.query(
        `SELECT to_status, occurred_at, CASE WHEN to_status IN ('failed','canceled') THEN note END AS note
           FROM ops.task_event WHERE task_id = $1 ORDER BY occurred_at, received_at`, [id])).rows;
      return t;
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** A customer request arrives as a draft; the operator reviews and publishes it for dispatch. */
  @Post('tasks')
  @Perm('portal:own')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const cid = this.customer(a);
    const pack = v.str(b?.sector_pack, 'sector_pack', { required: true, max: 40 })!;
    const site = v.uuid(b?.site_id, 'site_id');
    const ref = v.str(b?.ref, 'ref', { max: 60 });
    const attrs = v.obj(b?.attributes, 'attributes');
    const win = parseWindow(b ?? {});
    return this.db.withTenant(a, async (c) => {
      const le = (await c.query('SELECT legal_entity_id FROM crm.customer WHERE id = $1', [cid])).rows[0].legal_entity_id;
      const t = await createTask(c, a, { le, pack, branch: null, ref: ref && `${cid.slice(0, 8)}:${ref}`, attrs, win, status: 'draft', customer: cid, site });
      return (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE t.id = $1`, [t.id])).rows[0];
    });
  }

  /** The customer may cancel only before a driver is assigned. */
  @Post('tasks/:id/cancel')
  @HttpCode(200)
  @Perm('portal:own')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const cid = this.customer(a);
    const reason = v.str(b?.reason, 'reason', { max: 500 }) ?? 'canceled by customer';
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT status FROM ops.task WHERE id = $1 AND customer_id = $2 FOR UPDATE', [id, cid])).rows[0];
      if (!t) throw new NotFoundException();
      if (!['draft', 'ready'].includes(t.status)) throw new ConflictException('already assigned: please contact the operator');
      await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await c.query(
        `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
         VALUES ($1,$2,$3,$4,'canceled',now(),$5,'customer',$6,$7)`,
        [randomUUID(), a.tenantId, id, t.status, a.userId, randomUUID(), reason]);
      return (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0];
    });
  }

  /**
   * Driver supply (staffing@1): the customer's requests, who is placed on them (first name and whether the licence is valid,
   * nothing more) and the last 31 days of shifts with hours, to approve or dispute.
   */
  @Get('staffing')
  @Perm('portal:own')
  staffing(@Auth() a: AuthContext) {
    const cid = this.customer(a);
    return this.db.withTenant(a, async (c) => {
      const requests = (await c.query(
        `SELECT r.id, r.ref, r.site, r.worker_kind, r.with_vehicle, r.headcount, r.starts_on::text, r.ends_on::text,
                to_char(r.shift_start, 'HH24:MI') AS shift_start, to_char(r.shift_end, 'HH24:MI') AS shift_end, r.work_days, r.bill_unit,
                CASE WHEN r.canceled_at IS NOT NULL THEN 'canceled' WHEN r.ends_on < (now() AT TIME ZONE le.timezone)::date THEN 'ended'
                     WHEN r.starts_on > (now() AT TIME ZONE le.timezone)::date THEN 'upcoming' ELSE 'active' END AS state,
                (SELECT coalesce(jsonb_agg(jsonb_build_object('placement_id', p.id, 'worker_name', w.display_name, 'starts_on', p.starts_on::text, 'ends_on', p.ends_on::text,
                        'licence_valid', EXISTS (SELECT 1 FROM core.document d WHERE d.worker_id = w.id AND d.archived_at IS NULL AND d.doc_type = 'driving_license'
                                                   AND (d.expires_on IS NULL OR d.expires_on >= (now() AT TIME ZONE le.timezone)::date))) ORDER BY p.seq), '[]')
                   FROM ops.placement p JOIN workforce.worker w ON w.id = p.worker_id
                  WHERE p.request_id = r.id AND p.active AND p.ends_on >= (now() AT TIME ZONE le.timezone)::date) AS placements
           FROM ops.supply_request r JOIN org.legal_entity le ON le.id = r.legal_entity_id
          WHERE r.customer_id = $1 ORDER BY r.starts_on DESC LIMIT 100`, [cid])).rows;
      for (const r of requests) for (const p of r.placements) p.worker_name = firstName(p.worker_name);
      const shifts = (await c.query(
        `${SHIFT_SQL} WHERE r.customer_id = $1 AND s.work_date >= current_date - 31 AND t.status IN ('in_progress','completed','reviewed','invoiced','failed')
          ORDER BY s.work_date DESC, r.ref LIMIT 1000`, [cid])).rows
        .map((x) => ({ task_id: x.task_id, request_id: x.request_id, request_ref: x.request_ref, work_date: x.work_date, status: x.status, worker_name: firstName(x.worker_name),
          check_in: x.check_in, check_out: x.check_out, hours: x.hours, days: x.days, disputed: !!x.dispute_id, dispute_reason: x.dispute_reason }));
      return { requests, shifts };
    });
  }

  /** The customer approves worked days; approved days can be invoiced. */
  @Post('staffing/approve')
  @HttpCode(200)
  @Perm('portal:own')
  approveStaffing(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const cid = this.customer(a);
    const ids = b?.task_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new BadRequestException('task_ids must be a list of 1-500');
    const taskIds = ids.map((x, i) => v.uuid(x, `task_ids[${i}]`, { required: true })!);
    return this.db.withTenant(a, (c) => approveShifts(c, a, taskIds, 'customer', cid));
  }

  /** The customer disputes the hours of a day: it stays out of the invoice until the office resolves it. */
  @Post('staffing/dispute')
  @HttpCode(200)
  @Perm('portal:own')
  disputeStaffing(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const cid = this.customer(a);
    const taskId = v.uuid(b?.task_id, 'task_id', { required: true })!;
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query(
        `SELECT t.status, (t.attributes #>> '{quantities,hour}')::numeric AS hours FROM ops.task t JOIN ops.staffing_shift s ON s.task_id = t.id
          WHERE t.id = $1 AND t.customer_id = $2 FOR UPDATE OF t`, [taskId, cid])).rows[0];
      if (!t) throw new NotFoundException();
      if (t.status !== 'completed') throw new ConflictException(t.status === 'reviewed' || t.status === 'invoiced' ? 'already approved' : 'the day is not finished');
      const id = randomUUID();
      try {
        await c.query('SAVEPOINT d');
        await c.query('INSERT INTO ops.staffing_dispute (id, tenant_id, task_id, reason, raised_by, hours_before) VALUES ($1,$2,$3,$4,$5,$6)', [id, a.tenantId, taskId, reason, a.userId, t.hours]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT d');
        if ((e as { code?: string }).code === '23505') throw new ConflictException('this day already has an open dispute');
        throw e;
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, actorType: 'customer', action: 'staffing.disputed', targetType: 'task', targetId: taskId, after: { reason } });
      return { id, task_id: taskId, reason, hours_before: t.hours === null ? null : Number(t.hours) };
    });
  }
}
