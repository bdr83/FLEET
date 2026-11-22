import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { normalizePhone } from '../../common/phone';
import { pgToHttp, v } from '../../common/validate';
import { priceTask, Rate } from '../../crm/pricing';
import { createTask } from '../../tasks/tasks.controller';
import {
  BILL_UNITS, FREIGHT, FreightSettings, kg, money, normalizeCargo, normalizePlace, placeLine, quantities, SETTINGS_COLS, settingsOf, weightMismatch,
} from './freight';

const DONE = ['completed', 'reviewed', 'invoiced'];
const OPEN = ['draft', 'ready', 'assigned', 'accepted', 'in_progress'];
/** Trip expense categories (the shared expense table). */
const TRIP_EXPENSES = ['fuel', 'tolls', 'parking', 'other'] as const;

/** One row per shipment with its task, the truck and driver (or carrier) and the stage times from the driver's milestones. */
const SHIP_SQL = `
  SELECT s.task_id, s.legal_entity_id, s.waybill_no, s.mode, s.cargo, s.pickup, s.dropoff, s.planned_km, s.bill_unit,
         s.trailer_asset_id, tr.plate_no AS trailer_plate, s.carrier_id, ca.name AS carrier_name, s.carrier_cost::float,
         s.loaded_weight_kg::float, s.seal_no, s.delivered_weight_kg::float, s.received_by, s.pod_file_key, s.delivered_at, s.detention_minutes,
         t.status, t.version, t.ref, t.customer_id, cu.name AS customer_name, t.contract_id, t.attributes,
         lower(t.service_window) AS pickup_at, upper(t.service_window) AS deliver_by,
         asg.worker_id, w.display_name AS worker_name, asg.asset_id, a.plate_no,
         ms.at_pickup, ms.loaded, ms.at_dropoff, ms.unloaded,
         (SELECT m.code FROM ops.task_milestone m WHERE m.task_id = t.id ORDER BY m.occurred_at DESC LIMIT 1) AS stage
    FROM ops.freight_shipment s JOIN ops.task t ON t.id = s.task_id
    LEFT JOIN crm.customer cu ON cu.id = t.customer_id
    LEFT JOIN ops.freight_carrier ca ON ca.id = s.carrier_id
    LEFT JOIN fleet.asset tr ON tr.id = s.trailer_asset_id
    LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id
    LEFT JOIN fleet.asset a ON a.id = asg.asset_id
    LEFT JOIN LATERAL (
      SELECT min(m.occurred_at) FILTER (WHERE m.code = 'at_pickup') AS at_pickup, min(m.occurred_at) FILTER (WHERE m.code = 'loaded') AS loaded,
             min(m.occurred_at) FILTER (WHERE m.code = 'at_dropoff') AS at_dropoff, min(m.occurred_at) FILTER (WHERE m.code = 'unloaded') AS unloaded
        FROM ops.task_milestone m WHERE m.task_id = t.id) ms ON true`;

const ref = (val: unknown, field: string, required = true) => {
  const s = v.str(val, field, { required, max: 40 });
  if (s && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s)) throw new BadRequestException(`${field}: letters, digits, - and _ only`);
  return s;
};
const version = (b: Record<string, unknown>) => v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Office side of the haulage pack: settings, subcontract carriers, transport orders, planning (our truck or a carrier),
 * trip expenses, the trip settlement and the haulage report. Driver stages are in /v1/driver/sync.
 */
@Controller('v1/freight')
@UseGuards(AuthGuard)
@Pack('freight')
export class FreightController {
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
    const free = v.int(b?.free_detention_minutes, 'free_detention_minutes', 0, 1440);
    const tol = b?.weight_tolerance_pct === undefined ? null : money(b.weight_tolerance_pct, 'weight_tolerance_pct', { max: 50 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const before = await settingsOf(c, le);
      const s: FreightSettings = { free_detention_minutes: free ?? before.free_detention_minutes, weight_tolerance_pct: tol ?? before.weight_tolerance_pct };
      const row = (await c.query(
        `INSERT INTO ops.freight_settings (tenant_id, legal_entity_id, free_detention_minutes, weight_tolerance_pct) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET free_detention_minutes = EXCLUDED.free_detention_minutes,
           weight_tolerance_pct = EXCLUDED.weight_tolerance_pct, updated_at = now()
         RETURNING ${SETTINGS_COLS}`, [a.tenantId, le, s.free_detention_minutes, s.weight_tolerance_pct])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'freight.settings_changed', targetType: 'legal_entity', targetId: le, before, after: row });
      return { legal_entity_id: le, ...row };
    });
  }

  @Get('carriers')
  @Perm('tasks:read')
  carriers(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ca.id, ca.legal_entity_id, ca.name, ca.phone, ca.cr_number, ca.active,
                (SELECT count(*)::int FROM ops.freight_shipment s WHERE s.carrier_id = ca.id) AS shipments
           FROM ops.freight_carrier ca ORDER BY ca.active DESC, ca.name LIMIT 500`)).rows,
    }));
  }

  @Post('carriers')
  @Perm('tasks:write')
  addCarrier(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!;
    const phone = b?.phone ? normalizePhone(b.phone) : null;
    if (b?.phone && !phone) throw new BadRequestException('phone invalid');
    const cr = v.str(b?.cr_number, 'cr_number', { max: 40 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.freight_carrier (id, tenant_id, legal_entity_id, name, phone, cr_number) VALUES ($1,$2,$3,$4,$5,$6)', [id, a.tenantId, le, name, phone, cr]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('a carrier with this name exists');
        return pgToHttp(e);
      }
      const row = (await c.query('SELECT id, legal_entity_id, name, phone, cr_number, active FROM ops.freight_carrier WHERE id = $1', [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'freight.carrier_created', targetType: 'freight_carrier', targetId: id, after: row });
      return row;
    });
  }

  @Patch('carriers/:id')
  @Perm('tasks:write')
  editCarrier(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { max: 120 });
    const phone = b?.phone ? normalizePhone(b.phone) : null;
    if (b?.phone && !phone) throw new BadRequestException('phone invalid');
    if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query('SELECT id, name, phone, cr_number, active FROM ops.freight_carrier WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new NotFoundException();
      const row = (await c.query(
        `UPDATE ops.freight_carrier SET name = COALESCE($2, name), phone = COALESCE($3, phone), active = COALESCE($4, active) WHERE id = $1
         RETURNING id, legal_entity_id, name, phone, cr_number, active`, [id, name, phone, b?.active ?? null])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'freight.carrier_updated', targetType: 'freight_carrier', targetId: id, before, after: row });
      return row;
    });
  }

  /** Shipments by pickup time in a period (default: from 2 days ago to 7 days ahead), optionally by status. */
  @Get('shipments')
  @Perm('tasks:read')
  list(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string) {
    const f = v.ts(from, 'from') ?? new Date(Date.now() - 2 * 86_400_000);
    const t = v.ts(to, 'to') ?? new Date(f.getTime() + 9 * 86_400_000);
    if (t <= f || t.getTime() - f.getTime() > 93 * 86_400_000) throw new BadRequestException('period must be up to 93 days');
    const st = v.oneOf(status, 'status', ['open', 'done', 'failed', 'canceled'] as const);
    const statuses = st === 'open' ? OPEN : st === 'done' ? DONE : st ? [st] : null;
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `${SHIP_SQL} WHERE lower(t.service_window) >= $1 AND lower(t.service_window) < $2 AND ($3::text[] IS NULL OR t.status = ANY($3))
          ORDER BY lower(t.service_window) LIMIT 500`, [f, t, statuses])).rows;
      return { from: f, to: t, data: rows.map(brief) };
    });
  }

  /**
   * New transport order: one task (freight@1) plus its waybill. The pickup and delivery times are the task window, so
   * an exclusive assignment books the truck and driver for the trip. Sending the same waybill again returns it (safe retry).
   */
  @Post('shipments')
  @Perm('tasks:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const waybill = ref(b?.waybill_no, 'waybill_no')!;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const mode = v.oneOf(b?.mode, 'mode', ['ftl', 'ltl'] as const) ?? 'ftl';
    const cargo = normalizeCargo(b?.cargo);
    const pickup = normalizePlace(b?.pickup, 'pickup', { required: true });
    const dropoff = normalizePlace(b?.dropoff, 'dropoff', { required: true });
    const from = v.ts(b?.pickup_at, 'pickup_at', { required: true })!;
    const to = v.ts(b?.deliver_by, 'deliver_by', { required: true })!;
    if (to <= from) throw new BadRequestException('deliver_by must be after pickup_at');
    if (to.getTime() - from.getTime() > 14 * 86_400_000) throw new BadRequestException('a trip is up to 14 days');
    if (from.getTime() < Date.now() - 86_400_000) throw new BadRequestException('pickup_at is in the past');
    const km = v.int(b?.planned_km, 'planned_km', 1, 20_000);
    const unit = v.oneOf(b?.bill_unit, 'bill_unit', BILL_UNITS) ?? 'trip';
    if (unit === 'km' && km === null) throw new BadRequestException('bill_unit km needs planned_km');
    if (unit === 'ton' && cargo.weight_kg === undefined) throw new BadRequestException('bill_unit ton needs cargo.weight_kg');
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const prior = (await c.query('SELECT task_id FROM ops.freight_shipment WHERE waybill_no = $1', [waybill])).rows[0];
      if (prior) return this.shipment(c, prior.task_id);
      const task = await createTask(c, a, {
        le, pack: FREIGHT, branch: null, ref: waybill, status: 'ready', customer, site: null,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { waybill_no: waybill, mode, cargo, pickup, dropoff, address: placeLine(dropoff) ?? null, pickup_address: placeLine(pickup) ?? null,
          planned_km: km, bill_unit: unit, ...(notes ? { notes } : {}) },
      });
      if ((await c.query('SELECT 1 FROM ops.freight_shipment WHERE task_id = $1', [task.id])).rowCount) throw new ConflictException(`ref ${waybill} is used by another task`);
      if (task.sector_pack !== FREIGHT) throw new ConflictException(`ref ${waybill} is used by another task`);
      try {
        await c.query(
          `INSERT INTO ops.freight_shipment (tenant_id, task_id, legal_entity_id, waybill_no, mode, cargo, pickup, dropoff, planned_km, bill_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [a.tenantId, task.id, le, waybill, mode, JSON.stringify(cargo), JSON.stringify(pickup), JSON.stringify(dropoff), km, unit]);
      } catch (e) { return pgToHttp(e); }
      const row = await this.shipment(c, task.id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'freight.shipment_created', targetType: 'task', targetId: task.id, after: { waybill_no: waybill, mode, unit, customer } });
      return row;
    });
  }

  @Get('shipments/:id')
  @Perm('tasks:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.withTenant(a, (c) => this.shipment(c, id));
    if (!r) throw new NotFoundException();
    return r;
  }

  /**
   * Planning beyond the core assignment (truck and driver): the trailer, or a subcontract carrier at an agreed cost.
   * A carrier runs the trip outside our app, so it needs the task unassigned; the office records its delivery.
   */
  @Post('shipments/:id/plan')
  @HttpCode(200)
  @Perm('tasks:assign')
  plan(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const trailer = b?.trailer_asset_id === null ? null : v.uuid(b?.trailer_asset_id, 'trailer_asset_id');
    const carrier = b?.carrier_id === null ? null : v.uuid(b?.carrier_id, 'carrier_id');
    const cost = money(b?.carrier_cost, 'carrier_cost');
    return this.db.withTenant(a, async (c) => {
      const s = await this.lock(c, id, ver);
      if (!['draft', 'ready', 'assigned', 'accepted'].includes(s.status)) throw new ConflictException(`cannot plan a shipment that is ${s.status}`);
      if (trailer) {
        const x = (await c.query('SELECT asset_type, legal_entity_id, status FROM fleet.asset WHERE id = $1', [trailer])).rows[0];
        if (!x) throw new BadRequestException('unknown trailer_asset_id');
        if (x.asset_type !== 'trailer') throw new BadRequestException('trailer_asset_id is not a trailer');
        if (x.legal_entity_id !== s.legal_entity_id) throw new BadRequestException('trailer belongs to another legal entity');
        if (x.status === 'out_of_service' || x.status === 'retired') throw new ConflictException(`trailer is ${x.status}`);
      }
      if (carrier) {
        const x = (await c.query('SELECT legal_entity_id, active FROM ops.freight_carrier WHERE id = $1', [carrier])).rows[0];
        if (!x) throw new BadRequestException('unknown carrier_id');
        if (x.legal_entity_id !== s.legal_entity_id) throw new BadRequestException('carrier belongs to another legal entity');
        if (!x.active) throw new ConflictException('carrier is inactive');
        if (cost === null && s.carrier_cost === null) throw new BadRequestException('carrier_cost required');
        if ((await c.query('SELECT 1 FROM ops.assignment WHERE task_id = $1 AND active', [id])).rowCount) throw new ConflictException('unassign our driver before giving the trip to a carrier');
      }
      const carrierSet = b?.carrier_id !== undefined;
      await c.query(
        `UPDATE ops.freight_shipment SET trailer_asset_id = CASE WHEN $2 THEN $3 ELSE trailer_asset_id END,
           carrier_id = CASE WHEN $4 THEN $5 ELSE carrier_id END,
           carrier_cost = CASE WHEN $4 AND $5::uuid IS NULL THEN NULL ELSE COALESCE($6, carrier_cost) END
         WHERE task_id = $1`,
        [id, b?.trailer_asset_id !== undefined, trailer ?? null, carrierSet, carrier ?? null, cost]);
      await c.query('UPDATE ops.task SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
      const row = await this.shipment(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'freight.planned', targetType: 'task', targetId: id,
        before: { trailer_asset_id: s.trailer_asset_id, carrier_id: s.carrier_id, carrier_cost: s.carrier_cost },
        after: { trailer_asset_id: row!.trailer_asset_id, carrier_id: row!.carrier_id, carrier_cost: row!.carrier_cost } });
      return row;
    });
  }

  /** The office records the delivery of a trip run by a subcontract carrier (receiver's name and weight from its POD). */
  @Post('shipments/:id/carrier-delivered')
  @HttpCode(200)
  @Perm('tasks:write')
  carrierDelivered(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const receivedBy = v.str(b?.received_by, 'received_by', { required: true, max: 120 })!;
    const weight = kg(b?.delivered_weight_kg, 'delivered_weight_kg', { zero: true });
    const at = v.ts(b?.delivered_at, 'delivered_at') ?? new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('delivered_at is in the future');
    const file = v.str(b?.file_key, 'file_key', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      const s = await this.lock(c, id, ver);
      if (!s.carrier_id) throw new ConflictException('not a carrier trip');
      if (!['ready', 'draft'].includes(s.status)) throw new ConflictException(`cannot deliver a shipment that is ${s.status}`);
      await c.query('UPDATE ops.freight_shipment SET received_by = $2, delivered_weight_kg = $3, delivered_at = $4, pod_file_key = $5, detention_minutes = 0 WHERE task_id = $1',
        [id, receivedBy, weight, at, file]);
      const q = quantities({ bill_unit: s.bill_unit, planned_km: s.planned_km, cargo_weight_kg: s.cargo?.weight_kg ?? null, loaded_weight_kg: s.loaded_weight_kg, delivered_weight_kg: weight });
      await c.query(`UPDATE ops.task SET status = 'completed', attributes = attributes || jsonb_build_object('quantities', $2::jsonb), version = version + 1, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(q)]);
      await c.query(
        `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
         VALUES ($1,$2,$3,$4,'completed',$5,$6,'staff',$7,$8)`, [randomUUID(), a.tenantId, id, s.status, at, a.userId, randomUUID(), `carrier delivery, received by ${receivedBy}`.slice(0, 500)]);
      const row = await this.shipment(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'freight.carrier_delivered', targetType: 'task', targetId: id, after: { received_by: receivedBy, delivered_weight_kg: weight, quantities: q } });
      return row;
    });
  }

  /** A trip expense entered by the office (fuel, tolls, parking, other: border fees, driver allowance). Counted in the settlement. */
  @Post('shipments/:id/expenses')
  @Perm('fleet:write')
  addExpense(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const category = v.oneOf(b?.category, 'category', TRIP_EXPENSES, { required: true })!;
    const amount = money(b?.amount, 'amount', { required: true, max: 100_000 })!;
    if (amount <= 0) throw new BadRequestException('amount must be more than 0');
    const note = v.str(b?.note, 'note', { max: 1000 });
    const at = v.ts(b?.spent_at, 'spent_at') ?? new Date();
    return this.db.withTenant(a, async (c) => {
      const s = (await c.query(
        `SELECT s.legal_entity_id, le.currency, asg.asset_id, asg.worker_id FROM ops.freight_shipment s JOIN org.legal_entity le ON le.id = s.legal_entity_id
           LEFT JOIN ops.assignment asg ON asg.task_id = s.task_id AND asg.active WHERE s.task_id = $1`, [id])).rows[0];
      if (!s) throw new NotFoundException();
      const eid = randomUUID();
      await c.query(
        `INSERT INTO maint.expense (id, tenant_id, legal_entity_id, category, amount, currency, spent_at, asset_id, worker_id, note, status, submitted_by, decided_by, decided_at, task_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11,$11,now(),$12)`,
        [eid, a.tenantId, s.legal_entity_id, category, amount, s.currency, at, s.asset_id, s.worker_id, note, a.userId, id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'freight.expense_added', targetType: 'task', targetId: id, after: { expense_id: eid, category, amount } });
      return { id: eid, task_id: id, category, amount, currency: s.currency, spent_at: at, note, status: 'approved' };
    });
  }

  /**
   * Trip settlement: revenue from the customer's contract (actual quantities once delivered, else an estimate from the
   * order), minus the carrier cost and the trip expenses (all but rejected ones).
   */
  @Get('shipments/:id/settlement')
  @Perm('reports:read')
  async settlement(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.withTenant(a, async (c) => {
      const s = (await c.query(`${SHIP_SQL} WHERE s.task_id = $1`, [id])).rows[0];
      if (!s) return null;
      return settle(c, s, await settingsOf(c, s.legal_entity_id));
    });
    if (!r) throw new NotFoundException();
    return r;
  }

  /** Haulage report for a period (by pickup time): per trip revenue, costs and profit, and the KPIs from Phase A. */
  @Get('report')
  @Perm('reports:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.ts(from, 'from', { required: true })!, t = v.ts(to, 'to', { required: true })!;
    if (t <= f || t.getTime() - f.getTime() > 93 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${SHIP_SQL} WHERE lower(t.service_window) >= $1 AND lower(t.service_window) < $2 AND t.status <> 'canceled' ORDER BY lower(t.service_window) LIMIT 2000`, [f, t])).rows;
      const sets = new Map<string, FreightSettings>();
      const data: Awaited<ReturnType<typeof settle>>[] = [];
      for (const s of rows) {
        if (!sets.has(s.legal_entity_id)) sets.set(s.legal_entity_id, await settingsOf(c, s.legal_entity_id));
        data.push(await settle(c, s, sets.get(s.legal_entity_id)!));
      }
      const done = data.filter((x) => DONE.includes(x.status));
      const sum = (xs: typeof data, k: 'revenue' | 'carrier_cost' | 'expenses' | 'profit') => r3(xs.reduce((n, x) => n + (x[k] ?? 0), 0));
      const km = done.reduce((n, x) => n + (x.planned_km ?? 0), 0);
      const own = done.filter((x) => !x.carrier_id);
      const cost = sum(done, 'carrier_cost') + sum(done, 'expenses');
      const weighted = done.filter((x) => x.capacity_kg && x.loaded_weight_kg !== null);
      return {
        from: f, to: t, data,
        totals: {
          trips: data.length, delivered: done.length, failed: data.filter((x) => x.status === 'failed').length,
          own_trips: own.length, carrier_trips: done.length - own.length,
          revenue: sum(done, 'revenue'), carrier_cost: sum(done, 'carrier_cost'), expenses: sum(done, 'expenses'), profit: sum(done, 'profit'),
          unpriced_trips: done.filter((x) => x.revenue === null).length,
          planned_km: km, cost_per_km: km ? r3(cost / km) : null,
          profit_per_trip: done.length ? r3(sum(done, 'profit') / done.length) : null,
          on_time_pct: done.length ? Math.round((done.filter((x) => x.on_time).length / done.length) * 100) : null,
          // load utilization needs the truck's capacity in kg on the asset (capacity.kg)
          load_utilization_pct: weighted.length ? Math.round((weighted.reduce((n, x) => n + x.loaded_weight_kg! / x.capacity_kg!, 0) / weighted.length) * 100) : null,
          detention_hours: r3(done.reduce((n, x) => n + (x.detention_hours ?? 0), 0)),
        },
      };
    });
  }

  /** What needs the dispatcher now: unplanned trips due soon, late deliveries, trucks held past the free time, weight mismatches. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `${SHIP_SQL} WHERE (t.status IN ('draft','ready','assigned','accepted','in_progress') AND lower(t.service_window) < now() + interval '1 day')
            OR (t.status IN ('completed','reviewed') AND s.delivered_at > now() - interval '7 days')
          ORDER BY lower(t.service_window) LIMIT 1000`)).rows;
      const sets = new Map<string, FreightSettings>();
      const out = { unplanned: [] as unknown[], late: [] as unknown[], detention: [] as unknown[], weight_mismatch: [] as unknown[] };
      const now = Date.now();
      for (const s of rows) {
        if (!sets.has(s.legal_entity_id)) sets.set(s.legal_entity_id, await settingsOf(c, s.legal_entity_id));
        const cfg = sets.get(s.legal_entity_id)!;
        const b = brief(s);
        const open = OPEN.includes(s.status);
        if (open && s.status === 'ready' && !s.worker_id && !s.carrier_id) out.unplanned.push(b);
        if (open && new Date(s.deliver_by).getTime() < now && !s.unloaded) out.late.push(b);
        const heldSince = s.at_dropoff && !s.unloaded ? s.at_dropoff : s.at_pickup && !s.loaded ? s.at_pickup : null;
        if (open && heldSince && now - new Date(heldSince).getTime() > cfg.free_detention_minutes * 60_000) {
          out.detention.push({ ...b, held_since: heldSince, held_minutes: Math.round((now - new Date(heldSince).getTime()) / 60_000), free_minutes: cfg.free_detention_minutes });
        }
        if (weightMismatch(s.loaded_weight_kg, s.delivered_weight_kg, cfg.weight_tolerance_pct)) out.weight_mismatch.push({ ...b, tolerance_pct: cfg.weight_tolerance_pct });
      }
      return out;
    });
  }

  private async shipment(c: PoolClient, id: string): Promise<Record<string, any> | null> {
    const s = (await c.query(`${SHIP_SQL} WHERE s.task_id = $1`, [id])).rows[0];
    if (!s) return null;
    const cfg = await settingsOf(c, s.legal_entity_id);
    const expenses = (await c.query(
      `SELECT id, category, amount::float, currency, spent_at, note, status FROM maint.expense WHERE task_id = $1 ORDER BY spent_at`, [id])).rows;
    const failure = s.status === 'failed'
      ? (await c.query(`SELECT reason_code, note, occurred_at FROM ops.task_event WHERE task_id = $1 AND to_status = 'failed' ORDER BY occurred_at DESC LIMIT 1`, [id])).rows[0] ?? null
      : null;
    return { ...brief(s), settings: cfg, weight_mismatch: weightMismatch(s.loaded_weight_kg, s.delivered_weight_kg, cfg.weight_tolerance_pct), expenses, failure };
  }

  private async lock(c: PoolClient, id: string, ver: number) {
    const s = (await c.query(
      `SELECT s.*, s.carrier_cost::float, s.loaded_weight_kg::float, t.status, t.version FROM ops.freight_shipment s JOIN ops.task t ON t.id = s.task_id
        WHERE s.task_id = $1 FOR UPDATE OF t`, [id])).rows[0];
    if (!s) throw new NotFoundException();
    if (s.version !== ver) throw new ConflictException({ message: 'shipment changed since you loaded it', current_version: s.version });
    return s;
  }
}

function brief(s: Record<string, any>): Record<string, any> {
  const { attributes, ...rest } = s;
  return { ...rest, quantities: attributes?.quantities ?? null, notes: attributes?.notes ?? null, run_by: s.carrier_id ? 'carrier' : s.worker_id ? 'own' : null };
}

/** Revenue, costs and profit of one trip. Revenue is null when the contract has no price for the units (or no contract). */
async function settle(c: PoolClient, s: Record<string, any>, cfg: FreightSettings) {
  const delivered = DONE.includes(s.status);
  const est = quantities({ bill_unit: s.bill_unit, planned_km: s.planned_km, cargo_weight_kg: s.cargo?.weight_kg ?? null, loaded_weight_kg: s.loaded_weight_kg, delivered_weight_kg: s.delivered_weight_kg });
  const qty: Record<string, number> = delivered && s.attributes?.quantities ? s.attributes.quantities : est;
  let revenue: number | null = null, lines: unknown[] = [], unpriced: string[] = [];
  if (s.contract_id) {
    const rates: Rate[] = (await c.query('SELECT id, sector_pack, unit, price::text, included_qty::text, min_charge::text, description FROM crm.rate WHERE contract_id = $1', [s.contract_id])).rows;
    const q = priceTask(rates, FREIGHT, qty);
    lines = q.lines; unpriced = q.unpriced;
    revenue = q.unpriced.length || !q.lines.length ? null : Number(q.total);
  }
  const expenses = r3(Number((await c.query(`SELECT coalesce(sum(amount), 0) AS n FROM maint.expense WHERE task_id = $1 AND status <> 'rejected'`, [s.task_id])).rows[0].n));
  const carrier = s.carrier_cost ?? 0;
  const capacity = s.asset_id ? (await c.query(`SELECT (capacity->>'kg')::float AS kg FROM fleet.asset WHERE id = $1`, [s.asset_id])).rows[0]?.kg ?? null : null;
  const doneAt = s.unloaded ?? s.delivered_at;
  return {
    task_id: s.task_id, waybill_no: s.waybill_no, status: s.status, customer_name: s.customer_name, pickup_at: s.pickup_at, deliver_by: s.deliver_by,
    carrier_id: s.carrier_id, carrier_name: s.carrier_name, plate_no: s.plate_no, worker_name: s.worker_name, planned_km: s.planned_km, bill_unit: s.bill_unit,
    loaded_weight_kg: s.loaded_weight_kg, capacity_kg: capacity, detention_minutes: s.detention_minutes, detention_hours: qty.hour ?? 0,
    quantities: qty, estimated: !delivered, revenue, lines, unpriced,
    carrier_cost: r3(carrier), expenses, profit: revenue === null ? null : r3(revenue - carrier - expenses),
    on_time: doneAt ? new Date(doneAt).getTime() <= new Date(s.deliver_by).getTime() : null,
    free_detention_minutes: cfg.free_detention_minutes,
  };
}
