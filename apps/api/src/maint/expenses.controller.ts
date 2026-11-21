import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { pgToHttp, v } from '../common/validate';
import { CsvResponse, parseRange, respond } from '../reports/report-utils';
import { MAX_AGE_MS, MAX_AHEAD_MS } from '../driver/driver.controller';
import { postExpense } from '../billing/ledger';

export const EXPENSE_CATEGORIES = ['fuel', 'maintenance', 'tires', 'insurance', 'registration', 'fines', 'tolls', 'parking', 'washing', 'other'] as const;
/** What a driver may claim from the app. Fines, insurance and the like are entered by the office. */
export const DRIVER_CATEGORIES = ['fuel', 'tolls', 'parking', 'washing', 'other'] as const;
const COLS = `e.id, e.legal_entity_id, e.category, e.amount::text, e.currency, e.spent_at, e.asset_id, a.plate_no, e.worker_id, w.display_name AS worker_name,
  e.work_order_id, e.shift_id, e.liters::float, e.odometer_km, e.vendor, e.note, e.status, e.reject_reason, e.created_at`;
const FROM = `maint.expense e LEFT JOIN fleet.asset a ON a.id = e.asset_id LEFT JOIN workforce.worker w ON w.id = e.worker_id`;

function litersOf(val: unknown): number | null {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0 || val > 5000) throw new BadRequestException('liters must be 0-5000');
  return val;
}

/** Expenses: entered by the office (approved at once) or claimed by drivers from the app (approved by a supervisor). */
@Controller('v1')
@UseGuards(AuthGuard)
export class ExpensesController {
  constructor(private readonly db: DbService) {}

  @Get('expenses')
  @Perm('fleet:read')
  list(@Auth() a: AuthContext, @Query() q: Record<string, string | undefined>) {
    const st = v.oneOf(q.status, 'status', ['submitted', 'approved', 'rejected'] as const);
    const cat = v.oneOf(q.category, 'category', EXPENSE_CATEGORIES);
    const asset = v.uuid(q.asset_id, 'asset_id');
    const worker = v.uuid(q.worker_id, 'worker_id');
    const from = v.ts(q.from, 'from');
    const to = v.ts(q.to, 'to');
    return this.db.withTenant(a, async (c) => {
      const where = `($1::text IS NULL OR e.status = $1) AND ($2::text IS NULL OR e.category = $2) AND ($3::uuid IS NULL OR e.asset_id = $3)
        AND ($4::uuid IS NULL OR e.worker_id = $4) AND ($5::timestamptz IS NULL OR e.spent_at >= $5) AND ($6::timestamptz IS NULL OR e.spent_at < $6)`;
      const params = [st, cat, asset, worker, from, to];
      const data = (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE ${where} ORDER BY e.spent_at DESC LIMIT 500`, params)).rows;
      const totals = (await c.query(`SELECT e.currency, sum(e.amount)::text AS total FROM maint.expense e WHERE ${where} GROUP BY e.currency`, params)).rows;
      return { totals, data };
    });
  }

  @Post('expenses')
  @Perm('fleet:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const cat = v.oneOf(b?.category, 'category', EXPENSE_CATEGORIES, { required: true })!;
    const amount = v.money(b?.amount, 'amount', { required: true, positive: true });
    const spent = v.ts(b?.spent_at, 'spent_at') ?? new Date();
    const assetId = v.uuid(b?.asset_id, 'asset_id');
    const workerId = v.uuid(b?.worker_id, 'worker_id');
    let le = v.uuid(b?.legal_entity_id, 'legal_entity_id');
    const liters = litersOf(b?.liters);
    if (liters !== null && cat !== 'fuel') throw new BadRequestException('liters only for fuel');
    const odo = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000);
    const vendor = v.str(b?.vendor, 'vendor', { max: 200 });
    const note = v.str(b?.note, 'note', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      // the legal entity follows the vehicle, else the worker, else must be given
      for (const [id, table] of [[assetId, 'fleet.asset'], [workerId, 'workforce.worker']] as const) {
        if (!id) continue;
        const row = (await c.query(`SELECT legal_entity_id FROM ${table} WHERE id = $1`, [id])).rows[0];
        if (!row) throw new BadRequestException(`unknown ${table === 'fleet.asset' ? 'asset_id' : 'worker_id'}`);
        if (le && le !== row.legal_entity_id) throw new BadRequestException('vehicle, worker and legal entity do not match');
        le = row.legal_entity_id;
      }
      if (!le) throw new BadRequestException('legal_entity_id required when no vehicle or worker is given');
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO maint.expense (id, tenant_id, legal_entity_id, category, amount, currency, spent_at, asset_id, worker_id, liters, odometer_km, vendor, note,
                                      status, submitted_by, decided_by, decided_at)
           SELECT $1,$2,$3,$4,$5, le.currency, $6,$7,$8,$9,$10,$11,$12,'approved',$13,$13,now() FROM org.legal_entity le WHERE le.id = $3`,
          [id, a.tenantId, le, cat, amount, spent, assetId, workerId, liters, odo, vendor, note, a.userId]);
      } catch (e) { return pgToHttp(e); }
      if (!(await c.query('SELECT 1 FROM maint.expense WHERE id = $1', [id])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      if (assetId && odo !== null) await c.query('UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2) WHERE id = $1', [assetId, odo]);
      await postExpense(c, a.tenantId, id);
      const row = await this.load(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'expense.created', targetType: 'expense', targetId: id, after: row });
      return row;
    });
  }

  @Post('expenses/:id/approve')
  @HttpCode(200)
  @Perm('fleet:write')
  approve(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.decide(a, id, 'approved', null);
  }

  @Post('expenses/:id/reject')
  @HttpCode(200)
  @Perm('fleet:write')
  reject(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.decide(a, id, 'rejected', v.str(b?.reason, 'reason', { required: true, max: 300 }));
  }

  private decide(a: AuthContext, id: string, status: 'approved' | 'rejected', reason: string | null) {
    return this.db.withTenant(a, async (c) => {
      const e = (await c.query('SELECT status, submitted_by, asset_id, odometer_km FROM maint.expense WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!e) throw new NotFoundException();
      if (e.status !== 'submitted') throw new ConflictException(`expense is already ${e.status}`);
      if (e.submitted_by === a.userId) throw new ForbiddenException('you cannot decide your own claim');
      await c.query('UPDATE maint.expense SET status = $2, decided_by = $3, decided_at = now(), reject_reason = $4 WHERE id = $1', [id, status, a.userId, reason]);
      if (status === 'approved' && e.asset_id && e.odometer_km !== null) {
        await c.query('UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2) WHERE id = $1', [e.asset_id, e.odometer_km]);
      }
      if (status === 'approved') await postExpense(c, a.tenantId, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: `expense.${status}`, targetType: 'expense', targetId: id, after: { reason } });
      return this.load(c, id);
    });
  }

  /**
   * A driver claims an expense (fuel receipt, parking) from the app. Linked to the shift and vehicle
   * in use at that time. Idempotent on client_op_id for offline retries.
   */
  @Post('driver/expenses')
  @Perm('shift:own')
  driverClaim(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const op = v.uuid(b?.client_op_id, 'client_op_id', { required: true });
    const cat = v.oneOf(b?.category, 'category', DRIVER_CATEGORIES, { required: true })!;
    const amount = v.money(b?.amount, 'amount', { required: true, positive: true });
    const spent = v.ts(b?.spent_at, 'spent_at') ?? new Date();
    if (spent.getTime() < Date.now() - MAX_AGE_MS || spent.getTime() > Date.now() + MAX_AHEAD_MS) throw new BadRequestException('spent_at out of range');
    const liters = litersOf(b?.liters);
    if (liters !== null && cat !== 'fuel') throw new BadRequestException('liters only for fuel');
    const odo = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000);
    const vendor = v.str(b?.vendor, 'vendor', { max: 200 });
    const note = v.str(b?.note, 'note', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const w = (await c.query('SELECT id, legal_entity_id, status FROM workforce.worker WHERE user_id = $1', [a.userId])).rows[0];
      if (!w) throw new ForbiddenException('not a field worker in this company');
      const prior = (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE e.client_op_id = $1`, [op])).rows[0];
      if (prior) {
        if (prior.worker_id !== w.id) throw new ConflictException('client_op_id already used');
        return prior;
      }
      if (w.status !== 'active') throw new ForbiddenException(`worker is ${w.status}`);
      const shift = (await c.query(
        `SELECT id, asset_id FROM shift.shift WHERE worker_id = $1 AND started_at <= $2 AND (ended_at IS NULL OR ended_at >= $2) ORDER BY started_at DESC LIMIT 1`,
        [w.id, spent])).rows[0];
      const id = randomUUID();
      await c.query(
        `INSERT INTO maint.expense (id, tenant_id, legal_entity_id, category, amount, currency, spent_at, asset_id, worker_id, shift_id, liters, odometer_km,
                                    vendor, note, status, submitted_by, client_op_id)
         SELECT $1,$2,$3,$4,$5, le.currency, $6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14,$15 FROM org.legal_entity le WHERE le.id = $3`,
        [id, a.tenantId, w.legal_entity_id, cat, amount, spent, shift?.asset_id ?? null, w.id, shift?.id ?? null, liters, odo, vendor, note, a.userId, op]);
      return this.load(c, id);
    });
  }

  @Get('driver/expenses')
  @Perm('shift:own')
  driverList(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const w = (await c.query('SELECT id FROM workforce.worker WHERE user_id = $1', [a.userId])).rows[0];
      if (!w) throw new ForbiddenException('not a field worker in this company');
      return { data: (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE e.worker_id = $1 ORDER BY e.spent_at DESC LIMIT 100`, [w.id])).rows };
    });
  }

  /** Approved costs by vehicle (with km from shift odometers, cost per km and fuel economy) or by category. */
  @Get('reports/costs')
  @Perm('reports:read')
  costs(@Auth() a: AuthContext, @Query() q: Record<string, string | undefined>, @Res({ passthrough: true }) res: CsvResponse) {
    const group = q.group ?? 'asset';
    if (!['asset', 'category'].includes(group)) throw new BadRequestException('group must be asset or category');
    return this.db.withTenant(a, async (c) => {
      const r = await parseRange(c, q);
      if (group === 'category') {
        const rows = (await c.query(
          `SELECT e.category, e.currency, count(*)::int AS entries, sum(e.amount)::text AS total
             FROM maint.expense e WHERE e.status = 'approved' AND e.spent_at >= $1 AND e.spent_at < $2
            GROUP BY e.category, e.currency ORDER BY sum(e.amount) DESC`, [r.from, r.to])).rows;
        return respond(res, q.format, 'costs-by-category', rows, ['category', 'currency', 'entries', 'total'], { from: r.from, to: r.to });
      }
      const rows = (await c.query(
        `WITH ex AS (
           SELECT asset_id, currency, sum(amount) AS total, sum(amount) FILTER (WHERE category = 'fuel') AS fuel_cost, sum(liters) AS liters
             FROM maint.expense WHERE status = 'approved' AND asset_id IS NOT NULL AND spent_at >= $1 AND spent_at < $2 GROUP BY asset_id, currency
         ), km AS (
           SELECT asset_id, sum(end_odometer_km - start_odometer_km) AS km FROM shift.shift
            WHERE asset_id IS NOT NULL AND started_at >= $1 AND started_at < $2 AND end_odometer_km IS NOT NULL AND start_odometer_km IS NOT NULL GROUP BY asset_id
         )
         SELECT ast.id AS asset_id, ast.plate_no, ast.asset_type, ex.currency, ex.total::text AS total, COALESCE(ex.fuel_cost, 0)::text AS fuel_cost,
                ex.liters::float AS liters, COALESCE(km.km, 0)::int AS km,
                CASE WHEN km.km > 0 THEN round(ex.total / km.km, 3)::text END AS cost_per_km,
                CASE WHEN ex.liters > 0 AND km.km > 0 THEN round(km.km / ex.liters, 2)::float END AS km_per_liter
           FROM ex JOIN fleet.asset ast ON ast.id = ex.asset_id LEFT JOIN km ON km.asset_id = ex.asset_id
          WHERE (cardinality($3::uuid[]) = 0 OR ast.branch_id IS NULL OR ast.branch_id = ANY($3::uuid[]))
          ORDER BY ex.total DESC`, [r.from, r.to, a.branchIds])).rows;
      return respond(res, q.format, 'costs-by-vehicle', rows,
        ['asset_id', 'plate_no', 'asset_type', 'currency', 'total', 'fuel_cost', 'liters', 'km', 'cost_per_km', 'km_per_liter'], { from: r.from, to: r.to });
    });
  }

  private async load(c: PoolClient, id: string) {
    return (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE e.id = $1`, [id])).rows[0];
  }
}
