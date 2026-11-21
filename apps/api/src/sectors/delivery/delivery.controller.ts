import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { v } from '../../common/validate';
import { ACCOUNTS } from '../../billing/ledger';
import { createTask, parseWindow } from '../../tasks/tasks.controller';
import { Candidate, DELIVERY, firstPoint, haversineKm, pickDriver, SETTINGS_COLS, settingsOf } from './delivery';

const MAX_IMPORT = 500;
const MAX_AUTO = 200;
/** Booking length for an auto-assigned task with no window. Same default as manual assignment. [تخمين] */
const DEFAULT_ASSIGN_HOURS = 4;

/**
 * Office side of the delivery pack: settings, order import, auto-assignment, proof approval,
 * the exceptions board and driver earnings. The driver side is in /v1/driver/sync (milestone and pod ops).
 */
@Controller('v1/delivery')
@UseGuards(AuthGuard)
export class DeliveryController {
  constructor(private readonly db: DbService) {}

  @Get('settings')
  @Perm('tasks:read')
  settings(@Auth() a: AuthContext, @Query('legal_entity_id') le?: string) {
    const id = v.uuid(le, 'legal_entity_id', { required: true })!;
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [id])).rowCount) throw new NotFoundException();
      return { legal_entity_id: id, ...(await settingsOf(c, id)) };
    });
  }

  @Put('settings')
  @Perm('org:write')
  saveSettings(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    if (b.require_pin !== undefined && typeof b.require_pin !== 'boolean') throw new BadRequestException('require_pin must be true/false');
    const radius = b.auto_assign_radius_km;
    if (radius !== undefined && (typeof radius !== 'number' || !(radius > 0 && radius <= 200))) throw new BadRequestException('auto_assign_radius_km must be 0-200');
    const patch = {
      require_pin: b.require_pin as boolean | undefined,
      max_open_per_driver: v.int(b.max_open_per_driver, 'max_open_per_driver', 1, 50),
      auto_assign_radius_km: radius as number | undefined,
      position_fresh_minutes: v.int(b.position_fresh_minutes, 'position_fresh_minutes', 1, 120),
      default_sla_minutes: v.int(b.default_sla_minutes, 'default_sla_minutes', 10, 1440),
      commission_per_delivery: v.money(b.commission_per_delivery, 'commission_per_delivery'),
      commission_per_failed: v.money(b.commission_per_failed, 'commission_per_failed'),
      custody_alert_amount: v.money(b.custody_alert_amount, 'custody_alert_amount'),
    };
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const before = await settingsOf(c, le);
      const s = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined && x !== null)) };
      const row = (await c.query(
        `INSERT INTO ops.delivery_settings (tenant_id, legal_entity_id, require_pin, max_open_per_driver, auto_assign_radius_km, position_fresh_minutes,
           default_sla_minutes, commission_per_delivery, commission_per_failed, custody_alert_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET require_pin = EXCLUDED.require_pin, max_open_per_driver = EXCLUDED.max_open_per_driver,
           auto_assign_radius_km = EXCLUDED.auto_assign_radius_km, position_fresh_minutes = EXCLUDED.position_fresh_minutes,
           default_sla_minutes = EXCLUDED.default_sla_minutes, commission_per_delivery = EXCLUDED.commission_per_delivery,
           commission_per_failed = EXCLUDED.commission_per_failed, custody_alert_amount = EXCLUDED.custody_alert_amount, updated_at = now()
         RETURNING ${SETTINGS_COLS}`,
        [a.tenantId, le, s.require_pin, s.max_open_per_driver, s.auto_assign_radius_km, s.position_fresh_minutes, s.default_sla_minutes,
          s.commission_per_delivery, s.commission_per_failed, s.custody_alert_amount])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'delivery.settings_changed', targetType: 'legal_entity', targetId: le, before, after: row });
      return { legal_entity_id: le, ...row };
    });
  }

  /** The delivery side of one task: recipient PIN and tracking token (office only), stages, proof and failure reason. */
  @Get('tasks/:id')
  @Perm('tasks:read')
  async task(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.task WHERE id = $1 AND sector_pack = $2', [id, DELIVERY])).rowCount) return null;
      const link = (await c.query('SELECT token, pin, pin_attempts, expires_at FROM ops.delivery_link WHERE task_id = $1', [id])).rows[0] ?? null;
      const milestones = (await c.query(
        `SELECT m.code, m.occurred_at, m.lat, m.lng, m.note, u.display_name AS actor_name FROM ops.task_milestone m
           LEFT JOIN workforce.worker u ON u.user_id = m.actor_id WHERE m.task_id = $1 ORDER BY m.occurred_at`, [id])).rows;
      const pod = (await c.query('SELECT method, recipient_name, file_key, verified, approved_at, created_at FROM ops.delivery_pod WHERE task_id = $1', [id])).rows[0] ?? null;
      const failure = (await c.query(
        `SELECT reason_code, note, occurred_at FROM ops.task_event WHERE task_id = $1 AND to_status = 'failed' ORDER BY occurred_at DESC LIMIT 1`, [id])).rows[0] ?? null;
      return { link, milestones, pod, failure };
    });
    if (!r) throw new NotFoundException();
    return r;
  }

  /** The office accepts a photo or signature as proof (PIN proofs are verified on entry). */
  @Post('tasks/:id/pod/approve')
  @HttpCode(200)
  @Perm('tasks:write')
  approve(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const pod = (await c.query('SELECT verified FROM ops.delivery_pod WHERE task_id = $1 FOR UPDATE', [id])).rows[0];
      if (!pod) throw new NotFoundException('no proof of delivery for this task');
      if (pod.verified) throw new ConflictException('proof already verified');
      await c.query('UPDATE ops.delivery_pod SET verified = true, approved_by = $2, approved_at = now() WHERE task_id = $1', [id, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'delivery.pod_approved', targetType: 'task', targetId: id });
      return (await c.query('SELECT method, recipient_name, file_key, verified, approved_at, created_at FROM ops.delivery_pod WHERE task_id = $1', [id])).rows[0];
    });
  }

  /** The office rejects a photo or signature; the task cannot be reviewed until a valid proof exists. */
  @Post('tasks/:id/pod/reject')
  @HttpCode(200)
  @Perm('tasks:write')
  reject(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 });
    return this.db.withTenant(a, async (c) => {
      const pod = (await c.query('SELECT method, recipient_name, file_key, verified FROM ops.delivery_pod WHERE task_id = $1 FOR UPDATE', [id])).rows[0];
      if (!pod) throw new NotFoundException('no proof of delivery for this task');
      if (pod.verified) throw new ConflictException('proof already verified');
      await c.query('DELETE FROM ops.delivery_pod WHERE task_id = $1', [id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'delivery.pod_rejected', targetType: 'task', targetId: id, before: pod, after: { reason } });
      return { rejected: true };
    });
  }

  /**
   * Bulk import of delivery orders (from a sheet or a platform). external_order_id is the dedupe key:
   * an order already in the system is reported as duplicate and left unchanged. One bad row does not stop the rest.
   */
  @Post('import')
  @HttpCode(200)
  @Perm('tasks:write')
  import(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const branch = v.uuid(b?.branch_id, 'branch_id');
    const orders = b?.orders;
    if (!Array.isArray(orders) || !orders.length || orders.length > MAX_IMPORT) throw new BadRequestException(`orders must be a list of 1-${MAX_IMPORT}`);
    return this.db.withTenant(a, async (c) => {
      const out = { created: 0, duplicates: 0, errors: [] as { row: number; external_order_id: string | null; error: string }[], tasks: [] as { row: number; id: string; status: 'created' | 'duplicate' }[] };
      for (let i = 0; i < orders.length; i++) {
        const o = orders[i] as Record<string, unknown>;
        let ext: string | null = null;
        await c.query('SAVEPOINT row');
        try {
          if (!o || typeof o !== 'object' || Array.isArray(o)) throw new BadRequestException('row must be an object');
          ext = v.str(o.external_order_id, 'external_order_id', { required: true, max: 60 });
          const recipient = (o.recipient ?? {}) as Record<string, unknown>;
          const dropoff = (o.dropoff ?? {}) as Record<string, unknown>;
          if (!recipient.phone) throw new BadRequestException('recipient.phone required');
          if (!dropoff.area) throw new BadRequestException('dropoff.area required');
          const prior = (await c.query('SELECT id FROM ops.task WHERE ref = $1', [ext])).rows[0];
          if (prior) { out.duplicates++; out.tasks.push({ row: i, id: prior.id, status: 'duplicate' }); await c.query('RELEASE SAVEPOINT row'); continue; }
          const { window: _w, ...rest } = o;
          const attrs = v.obj(rest, 'order');
          const t = await createTask(c, a, { le, pack: DELIVERY, branch, ref: ext, attrs, win: parseWindow(o), status: 'ready', customer, site: null });
          out.created++; out.tasks.push({ row: i, id: t.id, status: 'created' });
          await c.query('RELEASE SAVEPOINT row');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT row');
          const err = e as { response?: { message?: string }; message?: string };
          if (!err.response) throw e; // a real failure, not a bad row
          out.errors.push({ row: i, external_order_id: ext, error: String(err.response.message ?? err.message) });
        }
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'delivery.imported', targetType: 'legal_entity', targetId: le, after: { created: out.created, duplicates: out.duplicates, errors: out.errors.length } });
      return out;
    });
  }

  /**
   * Assigns ready delivery tasks to the nearest available driver: on an open shift, seen recently,
   * in the same company, under the open-task cap and within the radius (settings per company).
   * Greedy and in window order; a task nobody qualifies for stays in the queue.
   */
  @Post('auto-assign')
  @HttpCode(200)
  @Perm('tasks:assign')
  autoAssign(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const ids = b?.task_ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_AUTO || ids.some((x) => !v.uuid(x, 'task_ids[]')))) throw new BadRequestException(`task_ids must be a list of up to ${MAX_AUTO} ids`);
    return this.db.withTenant(a, async (c) => {
      const tasks = (await c.query(
        `SELECT t.id, t.legal_entity_id, t.attributes FROM ops.task t
          WHERE t.status = 'ready' AND t.sector_pack = $1 AND ($2::uuid[] IS NULL OR t.id = ANY($2))
            AND (cardinality($3::uuid[]) = 0 OR t.branch_id IS NULL OR t.branch_id = ANY($3::uuid[]))
          ORDER BY lower(t.service_window) NULLS LAST, t.created_at LIMIT $4 FOR UPDATE OF t SKIP LOCKED`,
        [DELIVERY, ids ?? null, a.branchIds, MAX_AUTO])).rows;
      const pools = new Map<string, { s: Awaited<ReturnType<typeof settingsOf>>; drivers: Candidate[] }>();
      const assigned: { task_id: string; worker_id: string; km: number | null }[] = [];
      const skipped: string[] = [];
      for (const t of tasks) {
        if (!pools.has(t.legal_entity_id)) pools.set(t.legal_entity_id, await this.candidates(c, a, t.legal_entity_id));
        const pool = pools.get(t.legal_entity_id)!;
        const point = firstPoint(t.attributes ?? {});
        const d = pickDriver(point, pool.drivers, pool.s);
        if (!d) { skipped.push(t.id); continue; }
        await c.query(
          `INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by)
           VALUES ($1,$2,$3,$4,$5,false, COALESCE((SELECT service_window FROM ops.task WHERE id = $3), tstzrange(now(), now() + make_interval(hours => $6))), $7)`,
          [randomUUID(), a.tenantId, t.id, d.worker_id, d.asset_id, DEFAULT_ASSIGN_HOURS, a.userId]);
        await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [t.id]);
        await c.query(
          `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
           VALUES ($1,$2,$3,'ready','assigned',now(),$4,'system',$5,'إسناد تلقائي')`,
          [randomUUID(), a.tenantId, t.id, a.userId, randomUUID()]);
        d.open_tasks++;
        assigned.push({ task_id: t.id, worker_id: d.worker_id, km: point ? Math.round(haversineKm(point, d) * 10) / 10 : null });
      }
      if (assigned.length) await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'delivery.auto_assigned', targetType: 'task', targetId: assigned[0].task_id, after: { assigned } });
      return { assigned, skipped };
    });
  }

  private async candidates(c: PoolClient, a: AuthContext, le: string) {
    const s = await settingsOf(c, le);
    const drivers = (await c.query(
      `SELECT w.id AS worker_id, sh.asset_id, ST_Y(lp.position::geometry) AS lat, ST_X(lp.position::geometry) AS lng,
              (SELECT count(*)::int FROM ops.assignment x JOIN ops.task t ON t.id = x.task_id
                WHERE x.worker_id = w.id AND x.active AND t.status IN ('assigned','accepted','in_progress')) AS open_tasks
         FROM workforce.worker w
         JOIN shift.shift sh ON sh.worker_id = w.id AND sh.started_at IS NOT NULL AND sh.ended_at IS NULL
         JOIN geo.last_position lp ON lp.worker_id = w.id AND lp.recorded_at > now() - make_interval(mins => $2)
        WHERE w.status = 'active' AND w.legal_entity_id = $1 AND w.kind IN ('driver','courier')
          AND (cardinality($3::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($3::uuid[]))`,
      [le, s.position_fresh_minutes, a.branchIds])).rows as Candidate[];
    return { s, drivers };
  }

  /**
   * What needs the office's attention now: late orders (past the window, or past the SLA when there is no window),
   * proofs waiting for approval, failed orders not yet returned, locked PINs and drivers holding too much cash.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const scope = `(cardinality($1::uuid[]) = 0 OR t.branch_id IS NULL OR t.branch_id = ANY($1::uuid[]))`;
      const base = `t.id, t.ref, t.status, t.attributes, t.version, lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
                    asg.worker_id, w.display_name AS worker_name`;
      const join = `ops.task t LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active LEFT JOIN workforce.worker w ON w.id = asg.worker_id`;
      const late = (await c.query(
        `SELECT ${base}, COALESCE(upper(t.service_window), t.created_at + make_interval(mins => COALESCE(ds.default_sla_minutes, 90))) AS due_at
           FROM ${join} LEFT JOIN ops.delivery_settings ds ON ds.legal_entity_id = t.legal_entity_id
          WHERE t.sector_pack = '${DELIVERY}' AND t.status IN ('ready','assigned','accepted','in_progress') AND ${scope}
            AND COALESCE(upper(t.service_window), t.created_at + make_interval(mins => COALESCE(ds.default_sla_minutes, 90))) < now()
          ORDER BY due_at LIMIT 200`, [a.branchIds])).rows;
      const proofs = (await c.query(
        `SELECT ${base}, p.method, p.recipient_name, p.file_key, p.created_at AS proof_at
           FROM ${join} JOIN ops.delivery_pod p ON p.task_id = t.id AND NOT p.verified
          WHERE ${scope} ORDER BY p.created_at LIMIT 200`, [a.branchIds])).rows;
      const returns = (await c.query(
        `SELECT ${base}, e.reason_code, e.note, e.occurred_at AS failed_at
           FROM ${join} JOIN LATERAL (SELECT reason_code, note, occurred_at FROM ops.task_event WHERE task_id = t.id AND to_status = 'failed' ORDER BY occurred_at DESC LIMIT 1) e ON true
          WHERE t.sector_pack = '${DELIVERY}' AND t.status = 'failed' AND ${scope}
            AND NOT EXISTS (SELECT 1 FROM ops.task_milestone m WHERE m.task_id = t.id AND m.code = 'returned_to_sender')
          ORDER BY e.occurred_at LIMIT 200`, [a.branchIds])).rows;
      const pins = (await c.query(
        `SELECT ${base}, l.pin_attempts FROM ${join} JOIN ops.delivery_link l ON l.task_id = t.id
          WHERE l.pin_attempts >= 5 AND t.status IN ('assigned','accepted','in_progress') AND ${scope} LIMIT 200`, [a.branchIds])).rows;
      const custody = (await c.query(
        `SELECT l.worker_id, w.display_name, l.currency, sum(l.amount)::text AS held, COALESCE(ds.custody_alert_amount, 100)::text AS alert_at
           FROM billing.ledger_entry l JOIN workforce.worker w ON w.id = l.worker_id
           LEFT JOIN ops.delivery_settings ds ON ds.legal_entity_id = w.legal_entity_id
          WHERE l.account_code = $1 GROUP BY l.worker_id, w.display_name, l.currency, ds.custody_alert_amount
         HAVING sum(l.amount) >= COALESCE(ds.custody_alert_amount, 100) ORDER BY sum(l.amount) DESC`, [ACCOUNTS.COD_CUSTODY])).rows;
      return { late, proofs, returns, pins, custody };
    });
  }

  /**
   * Driver earnings for a period: deliveries and failed attempts (by the driver who closed them) times the
   * company's commission, plus COD cash collected. A report only: nothing is posted to the ledger. [تخمين]
   */
  @Get('earnings')
  @Perm('reports:read')
  earnings(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.ts(from, 'from', { required: true })!, t = v.ts(to, 'to', { required: true })!;
    if (t <= f || t.getTime() - f.getTime() > 93 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => ({
      from: f, to: t,
      data: (await c.query(
        `WITH ev AS (
           SELECT w.id AS worker_id, e.to_status FROM ops.task_event e
             JOIN ops.task tk ON tk.id = e.task_id AND tk.sector_pack = $3
             JOIN workforce.worker w ON w.user_id = e.actor_id
            WHERE e.actor_type = 'driver' AND e.to_status IN ('completed','failed') AND e.occurred_at >= $1 AND e.occurred_at < $2
         ), cnt AS (
           SELECT worker_id, count(*) FILTER (WHERE to_status = 'completed')::int AS delivered, count(*) FILTER (WHERE to_status = 'failed')::int AS failed
             FROM ev GROUP BY worker_id
         ), cod AS (
           SELECT worker_id, sum(amount) AS collected FROM billing.cod_collection WHERE collected_at >= $1 AND collected_at < $2 GROUP BY worker_id
         )
         SELECT w.id AS worker_id, w.display_name, COALESCE(cnt.delivered, 0) AS delivered, COALESCE(cnt.failed, 0) AS failed,
                (COALESCE(cnt.delivered, 0) * COALESCE(ds.commission_per_delivery, 0) + COALESCE(cnt.failed, 0) * COALESCE(ds.commission_per_failed, 0))::numeric(18,3)::text AS commission,
                COALESCE(cod.collected, 0)::numeric(18,3)::text AS cod_collected
           FROM workforce.worker w
           LEFT JOIN cnt ON cnt.worker_id = w.id LEFT JOIN cod ON cod.worker_id = w.id
           LEFT JOIN ops.delivery_settings ds ON ds.legal_entity_id = w.legal_entity_id
          WHERE (cnt.worker_id IS NOT NULL OR cod.worker_id IS NOT NULL)
            AND (cardinality($4::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($4::uuid[]))
          ORDER BY delivered DESC, w.display_name`, [f, t, DELIVERY, a.branchIds])).rows,
    }));
  }
}

