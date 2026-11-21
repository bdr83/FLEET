import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { v } from '../common/validate';
import { createTask, parseWindow } from '../tasks/tasks.controller';

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

  @Get('tasks')
  @Perm('portal:own')
  list(@Auth() a: AuthContext) {
    const id = this.customer(a);
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE t.customer_id = $1 ORDER BY t.created_at DESC LIMIT 500`, [id])).rows,
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
}
