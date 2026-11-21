import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { pgToHttp, v } from '../common/validate';

const PLAN_COLS = `p.id, p.asset_id, a.plate_no, p.name, p.interval_km, p.interval_days, p.last_done_km, p.last_done_on::text, p.active`;
const WO_COLS = `w.id, w.number, w.asset_id, a.plate_no, w.plan_id, w.kind, w.status, w.out_of_service, w.description, w.vendor,
  w.odometer_km, w.opened_at, w.closed_at,
  (SELECT COALESCE(sum(amount), 0)::text FROM maint.work_order_line l WHERE l.work_order_id = w.id) AS total_cost`;
const WO_KINDS = ['preventive', 'corrective', 'inspection', 'accident'] as const;

/** Preventive maintenance plans, due alerts and work orders (with cost lines). */
@Controller('v1')
@UseGuards(AuthGuard)
export class MaintenanceController {
  constructor(private readonly db: DbService) {}

  @Get('maintenance/plans')
  @Perm('fleet:read')
  plans(@Auth() a: AuthContext, @Query('asset_id') asset?: string) {
    const as = v.uuid(asset, 'asset_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT ${PLAN_COLS} FROM maint.plan p JOIN fleet.asset a ON a.id = p.asset_id
        WHERE ($1::uuid IS NULL OR p.asset_id = $1) ORDER BY a.plate_no, p.name`, [as])).rows,
    }));
  }

  /** A plan starts counting from the vehicle's current odometer and today, unless told otherwise. */
  @Post('maintenance/plans')
  @Perm('fleet:write')
  createPlan(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const assetId = v.uuid(b?.asset_id, 'asset_id', { required: true });
    const name = v.str(b?.name, 'name', { required: true, max: 120 });
    const km = v.int(b?.interval_km, 'interval_km', 1, 1_000_000);
    const days = v.int(b?.interval_days, 'interval_days', 1, 3650);
    if (km === null && days === null) throw new BadRequestException('interval_km or interval_days required');
    const lastKm = v.int(b?.last_done_km, 'last_done_km', 0, 10_000_000);
    const lastOn = v.date(b?.last_done_on, 'last_done_on');
    return this.db.withTenant(a, async (c) => {
      const asset = (await c.query('SELECT legal_entity_id, odometer_km FROM fleet.asset WHERE id = $1', [assetId])).rows[0];
      if (!asset) throw new BadRequestException('unknown asset_id');
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO maint.plan (id, tenant_id, legal_entity_id, asset_id, name, interval_km, interval_days, last_done_km, last_done_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, current_date))`,
          [id, a.tenantId, asset.legal_entity_id, assetId, name, km, days, lastKm ?? asset.odometer_km ?? 0, lastOn]);
      } catch (e) { return pgToHttp(e); }
      return (await c.query(`SELECT ${PLAN_COLS} FROM maint.plan p JOIN fleet.asset a ON a.id = p.asset_id WHERE p.id = $1`, [id])).rows[0];
    });
  }

  @Patch('maintenance/plans/:id')
  @Perm('fleet:write')
  updatePlan(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { max: 120 });
    const km = v.int(b?.interval_km, 'interval_km', 1, 1_000_000);
    const days = v.int(b?.interval_days, 'interval_days', 1, 3650);
    if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true or false');
    return this.db.withTenant(a, async (c) => {
      const r = await c.query(
        `UPDATE maint.plan SET name = COALESCE($2, name), interval_km = COALESCE($3, interval_km), interval_days = COALESCE($4, interval_days),
           active = COALESCE($5, active) WHERE id = $1 RETURNING id`, [id, name, km, days, b?.active ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      return (await c.query(`SELECT ${PLAN_COLS} FROM maint.plan p JOIN fleet.asset a ON a.id = p.asset_id WHERE p.id = $1`, [id])).rows[0];
    });
  }

  /** Plans due within N km or N days (default 500 km / 14 days), and overdue ones. Feeds the alerts screen. */
  @Get('maintenance/due')
  @Perm('fleet:read')
  due(@Auth() a: AuthContext, @Query('within_km') wk?: string, @Query('within_days') wd?: string) {
    const withinKm = wk === undefined ? 500 : Number(wk);
    const withinDays = wd === undefined ? 14 : Number(wd);
    if (!Number.isInteger(withinKm) || withinKm < 0 || withinKm > 100_000) throw new BadRequestException('within_km must be 0-100000');
    if (!Number.isInteger(withinDays) || withinDays < 0 || withinDays > 365) throw new BadRequestException('within_days must be 0-365');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT *, CASE WHEN km_left <= 0 OR days_left < 0 THEN 'overdue' ELSE 'due_soon' END AS state FROM (
           SELECT p.id AS plan_id, p.name, p.asset_id, a.plate_no, a.odometer_km,
                  p.last_done_km + p.interval_km AS due_km, (p.last_done_km + p.interval_km) - a.odometer_km AS km_left,
                  (p.last_done_on + p.interval_days)::text AS due_on, (p.last_done_on + p.interval_days) - current_date AS days_left,
                  EXISTS (SELECT 1 FROM maint.work_order w WHERE w.plan_id = p.id AND w.status IN ('open','in_progress')) AS has_open_work_order
             FROM maint.plan p JOIN fleet.asset a ON a.id = p.asset_id
            WHERE p.active AND a.status <> 'retired'
              AND (cardinality($3::uuid[]) = 0 OR a.branch_id IS NULL OR a.branch_id = ANY($3::uuid[]))) x
          WHERE km_left <= $1 OR days_left <= $2
          ORDER BY LEAST(COALESCE(km_left::float / 100, 1e9), COALESCE(days_left, 1e9)), plate_no`,
        [withinKm, withinDays, a.branchIds])).rows,
    }));
  }

  @Get('work-orders')
  @Perm('fleet:read')
  workOrders(@Auth() a: AuthContext, @Query('asset_id') asset?: string, @Query('status') status?: string) {
    const as = v.uuid(asset, 'asset_id');
    const st = v.oneOf(status, 'status', ['open', 'in_progress', 'done', 'canceled'] as const);
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT ${WO_COLS} FROM maint.work_order w JOIN fleet.asset a ON a.id = w.asset_id
        WHERE ($1::uuid IS NULL OR w.asset_id = $1) AND ($2::text IS NULL OR w.status = $2) ORDER BY w.opened_at DESC LIMIT 500`, [as, st])).rows,
    }));
  }

  @Get('work-orders/:id')
  @Perm('fleet:read')
  async workOrder(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(a, (c) => this.loadWo(c, id));
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Opens a work order. out_of_service=true takes the vehicle off the road until the order is closed. */
  @Post('work-orders')
  @Perm('fleet:write')
  createWo(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const assetId = v.uuid(b?.asset_id, 'asset_id', { required: true });
    const kind = v.oneOf(b?.kind, 'kind', WO_KINDS, { required: true });
    const planId = v.uuid(b?.plan_id, 'plan_id');
    const desc = v.str(b?.description, 'description', { max: 2000 });
    const vendor = v.str(b?.vendor, 'vendor', { max: 200 });
    const odo = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000);
    const oos = b?.out_of_service === true;
    return this.db.withTenant(a, async (c) => {
      const asset = (await c.query('SELECT legal_entity_id, status FROM fleet.asset WHERE id = $1 FOR UPDATE', [assetId])).rows[0];
      if (!asset) throw new BadRequestException('unknown asset_id');
      if (asset.status === 'retired') throw new ConflictException('vehicle is retired');
      if (planId && !(await c.query('SELECT 1 FROM maint.plan WHERE id = $1 AND asset_id = $2', [planId, assetId])).rowCount) throw new BadRequestException('plan is for another vehicle');
      // numbered per legal entity and year; the lock serialises concurrent openings
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':work_order'))", [asset.legal_entity_id]);
      const seq = (await c.query("SELECT count(*)::int + 1 AS n FROM maint.work_order WHERE legal_entity_id = $1 AND opened_at >= date_trunc('year', now())", [asset.legal_entity_id])).rows[0].n;
      const id = randomUUID();
      const number = `WO-${new Date().getUTCFullYear()}-${String(seq).padStart(5, '0')}`;
      try {
        await c.query(
          `INSERT INTO maint.work_order (id, tenant_id, legal_entity_id, asset_id, plan_id, number, kind, out_of_service, description, vendor, odometer_km, opened_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, a.tenantId, asset.legal_entity_id, assetId, planId, number, kind, oos, desc, vendor, odo, a.userId]);
      } catch (e) { return pgToHttp(e); }
      if (oos) await c.query(`UPDATE fleet.asset SET status = 'out_of_service' WHERE id = $1`, [assetId]);
      const row = await this.loadWo(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'work_order.opened', targetType: 'work_order', targetId: id, after: row });
      return row;
    });
  }

  @Post('work-orders/:id/lines')
  @Perm('fleet:write')
  addLine(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const kind = v.oneOf(b?.kind, 'kind', ['part', 'labor', 'other'] as const, { required: true });
    const desc = v.str(b?.description, 'description', { required: true, max: 200 });
    const qty = typeof b?.qty === 'number' && b.qty > 0 && b.qty <= 1e6 ? b.qty : b?.qty === undefined ? 1 : (() => { throw new BadRequestException('qty must be more than 0'); })();
    const cost = v.money(b?.unit_cost, 'unit_cost', { required: true });
    return this.db.withTenant(a, async (c) => {
      const w = (await c.query('SELECT status FROM maint.work_order WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!w) throw new NotFoundException();
      if (!['open', 'in_progress'].includes(w.status)) throw new ConflictException(`work order is ${w.status}`);
      await c.query(`INSERT INTO maint.work_order_line (id, tenant_id, work_order_id, kind, description, qty, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), a.tenantId, id, kind, desc, qty, cost]);
      return this.loadWo(c, id);
    });
  }

  @Post('work-orders/:id/start')
  @HttpCode(200)
  @Perm('fleet:write')
  start(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const r = await c.query(`UPDATE maint.work_order SET status = 'in_progress' WHERE id = $1 AND status = 'open' RETURNING id`, [id]);
      if (!r.rowCount) await this.explain(c, id, 'start');
      return this.loadWo(c, id);
    });
  }

  /**
   * Closes a work order: records the odometer, resets the plan counter, puts the vehicle back on the road
   * (unless another open order keeps it off) and books the total cost as an approved maintenance expense.
   */
  @Post('work-orders/:id/complete')
  @HttpCode(200)
  @Perm('fleet:write')
  complete(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const odo = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000);
    return this.db.withTenant(a, async (c) => {
      const w = (await c.query('SELECT * FROM maint.work_order WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!w) throw new NotFoundException();
      if (!['open', 'in_progress'].includes(w.status)) throw new ConflictException(`work order is ${w.status}`);
      const asset = (await c.query('SELECT odometer_km FROM fleet.asset WHERE id = $1 FOR UPDATE', [w.asset_id])).rows[0];
      const km = odo ?? w.odometer_km ?? asset.odometer_km;
      if (km !== null && asset.odometer_km !== null && km < asset.odometer_km) throw new BadRequestException('odometer is below the last reading');
      await c.query(`UPDATE maint.work_order SET status = 'done', closed_at = now(), closed_by = $2, odometer_km = $3 WHERE id = $1`, [id, a.userId, km]);
      if (km !== null) await c.query('UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2) WHERE id = $1', [w.asset_id, km]);
      if (w.plan_id) await c.query('UPDATE maint.plan SET last_done_km = COALESCE($2, last_done_km), last_done_on = current_date WHERE id = $1', [w.plan_id, km]);
      await this.release(c, w);
      const total = (await c.query('SELECT COALESCE(sum(amount), 0) AS t FROM maint.work_order_line WHERE work_order_id = $1', [id])).rows[0].t;
      if (Number(total) > 0) {
        await c.query(
          `INSERT INTO maint.expense (id, tenant_id, legal_entity_id, category, amount, currency, spent_at, asset_id, work_order_id, odometer_km, vendor, note,
                                      status, submitted_by, decided_by, decided_at)
           SELECT $1, $2, w.legal_entity_id, 'maintenance', $3, le.currency, now(), w.asset_id, w.id, $4, w.vendor, w.number, 'approved', $5, $5, now()
             FROM maint.work_order w JOIN org.legal_entity le ON le.id = w.legal_entity_id WHERE w.id = $6`,
          [randomUUID(), a.tenantId, total, km, a.userId, id]);
      }
      const row = await this.loadWo(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'work_order.completed', targetType: 'work_order', targetId: id, after: row });
      return row;
    });
  }

  @Post('work-orders/:id/cancel')
  @HttpCode(200)
  @Perm('fleet:write')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const w = (await c.query('SELECT * FROM maint.work_order WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!w) throw new NotFoundException();
      if (!['open', 'in_progress'].includes(w.status)) throw new ConflictException(`work order is ${w.status}`);
      await c.query(`UPDATE maint.work_order SET status = 'canceled', closed_at = now(), closed_by = $2 WHERE id = $1`, [id, a.userId]);
      await this.release(c, w);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'work_order.canceled', targetType: 'work_order', targetId: id });
      return this.loadWo(c, id);
    });
  }

  /** Back on the road if no other open order holds the vehicle. */
  private async release(c: PoolClient, w: { id: string; asset_id: string; out_of_service: boolean }) {
    if (!w.out_of_service) return;
    await c.query(
      `UPDATE fleet.asset SET status = 'available' WHERE id = $1 AND status = 'out_of_service'
          AND NOT EXISTS (SELECT 1 FROM maint.work_order x WHERE x.asset_id = $1 AND x.id <> $2 AND x.out_of_service AND x.status IN ('open','in_progress'))`,
      [w.asset_id, w.id]);
  }

  private async explain(c: PoolClient, id: string, action: string): Promise<never> {
    const w = (await c.query('SELECT status FROM maint.work_order WHERE id = $1', [id])).rows[0];
    if (!w) throw new NotFoundException();
    throw new ConflictException(`cannot ${action} a work order that is ${w.status}`);
  }

  private async loadWo(c: PoolClient, id: string) {
    const w = (await c.query(`SELECT ${WO_COLS} FROM maint.work_order w JOIN fleet.asset a ON a.id = w.asset_id WHERE w.id = $1`, [id])).rows[0];
    if (!w) return null;
    w.lines = (await c.query('SELECT id, kind, description, qty::float, unit_cost::text, amount::text FROM maint.work_order_line WHERE work_order_id = $1 ORDER BY kind, description', [id])).rows;
    return w;
  }
}
