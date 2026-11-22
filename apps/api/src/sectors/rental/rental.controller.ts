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
import { charges, FINE_STATUSES, LATE_PICKUP_MIN, MOVE_MIN, RATE_UNITS, RateUnit, RENTAL, RENTAL_TYPES, Stage, STAGE_OF } from './rental';

const kwDate = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
const kwToday = () => kwDate(new Date());

const AGR_SQL = `
  SELECT r.id, r.ref, r.legal_entity_id, r.branch_id, r.customer_id, cu.name AS customer_name, cu.kind AS customer_kind, r.asset_id, a.plate_no, a.asset_type, a.make, a.model,
         r.task_id, r.drivers, r.drivers->0->>'name' AS renter_name, r.drivers->0->>'phone' AS renter_phone,
         r.pickup_at, r.return_due, r.rate_unit, r.rate::text, r.km_per_day, r.extra_km_rate::text, r.fuel_rate::text, r.deposit::text, r.notes,
         r.out_at, r.out_odometer_km, r.out_fuel, r.out_damage, r.out_by, r.in_at, r.in_odometer_km, r.in_fuel, r.in_damage, r.in_by,
         r.days, r.rental_amount::text, r.extra_km, r.km_amount::text, r.fuel_amount::text, r.damage_amount::text, r.total::text,
         CASE WHEN r.total IS NULL THEN NULL ELSE (r.total - r.deposit)::text END AS balance,
         r.closed_at, r.canceled_at, r.cancel_reason, r.version,
         CASE WHEN r.canceled_at IS NOT NULL THEN 'canceled' WHEN r.in_at IS NOT NULL THEN 'returned'
              WHEN r.out_at IS NOT NULL AND r.return_due < now() THEN 'overdue' WHEN r.out_at IS NOT NULL THEN 'out' ELSE 'reserved' END AS state,
         (SELECT COALESCE(sum(f.amount), 0)::text FROM ops.rental_fine f WHERE f.agreement_id = r.id AND f.status IN ('open','charged')) AS fines_amount
    FROM ops.rental_agreement r JOIN crm.customer cu ON cu.id = r.customer_id JOIN fleet.asset a ON a.id = r.asset_id`;

const MOVE_SQL = `
  SELECT m.task_id, m.agreement_id, r.ref AS rental_ref, m.kind, m.address, t.status, lower(t.service_window) AS at, w.display_name AS driver_name, asg.worker_id AS driver_worker_id
    FROM ops.rental_move m JOIN ops.rental_agreement r ON r.id = m.agreement_id JOIN ops.task t ON t.id = m.task_id
    LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active LEFT JOIN workforce.worker w ON w.id = asg.worker_id`;

const FINE_SQL = `
  SELECT f.id, f.asset_id, a.plate_no, f.occurred_at, f.amount::text, f.fine_no, f.description, f.agreement_id, r.ref AS rental_ref, cu.name AS customer_name,
         r.drivers->0->>'name' AS renter_name, f.status, f.created_at
    FROM ops.rental_fine f JOIN fleet.asset a ON a.id = f.asset_id
    LEFT JOIN ops.rental_agreement r ON r.id = f.agreement_id LEFT JOIN crm.customer cu ON cu.id = r.customer_id`;

const addrLine = (s: Record<string, unknown>) => [s.name, s.area, s.block ? `ق ${s.block}` : null, s.street].filter((x) => typeof x === 'string' && x).join('، ') || null;

type Driver = { name: string; phone: string | null; civil_id: string | null; licence_no: string; licence_expiry: string };

/** The renter and up to three more drivers: a name, the licence number and its expiry; the first is the renter. */
function parseDrivers(val: unknown): Driver[] {
  if (!Array.isArray(val) || val.length < 1 || val.length > 4) throw new BadRequestException('drivers must list 1-4 drivers, the renter first');
  return val.map((d, i) => {
    const o = v.obj(d, `drivers[${i}]`) ?? (() => { throw new BadRequestException(`drivers[${i}] required`); })();
    const expiry = v.date(o.licence_expiry, `drivers[${i}].licence_expiry`) ?? (() => { throw new BadRequestException(`drivers[${i}].licence_expiry required`); })();
    return {
      name: v.str(o.name, `drivers[${i}].name`, { required: true, max: 120 })!,
      phone: v.str(o.phone, `drivers[${i}].phone`, { max: 20 }),
      civil_id: v.str(o.civil_id, `drivers[${i}].civil_id`, { max: 20 }),
      licence_no: v.str(o.licence_no, `drivers[${i}].licence_no`, { required: true, max: 40 })!,
      licence_expiry: expiry,
    };
  });
}

/** Every driver's licence must be valid until the vehicle is due back. */
function checkLicences(drivers: Driver[], due: Date) {
  const bad = drivers.find((d) => d.licence_expiry < kwDate(due));
  if (bad) throw new BadRequestException(`licence_expires: ${bad.name}'s licence expires on ${bad.licence_expiry}, before the return`);
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string, at = new Date()) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',$8,$9)`,
    [randomUUID(), a.tenantId, taskId, from, to, at.toISOString(), a.userId, randomUUID(), note]);
}

async function moveTask(c: PoolClient, a: AuthContext, taskId: string, to: string, note: string, at?: Date) {
  const t = (await c.query('SELECT status FROM ops.task WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!t || t.status === to || ['completed', 'canceled', 'failed'].includes(t.status)) return;
  await c.query('UPDATE ops.task SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [taskId, to]);
  await event(c, a, taskId, t.status, to, note, at);
}

export class RentalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/**
 * Check-out: the customer takes the vehicle (at the counter, or from our driver). Odometer and fuel, damage noted; the
 * vehicle shows as in use and the booking starts now if picked up early. Shared by the office and the driver app.
 */
export async function checkOut(c: PoolClient, a: AuthContext, id: string, x: { km: number; fuel: number | null; damage: string | null; at: Date; by: 'staff' | 'driver' }) {
  const r = (await c.query('SELECT id, task_id, asset_id, pickup_at, out_at, canceled_at FROM ops.rental_agreement WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) throw new NotFoundException();
  if (r.canceled_at) throw new RentalError('invalid_stage', 'the agreement is canceled');
  if (r.out_at) throw new RentalError('invalid_stage', 'the vehicle is already out');
  if ((await c.query('SELECT 1 FROM ops.rental_agreement WHERE asset_id = $1 AND id <> $2 AND out_at IS NOT NULL AND in_at IS NULL AND canceled_at IS NULL', [r.asset_id, id])).rowCount) {
    throw new RentalError('vehicle_still_out', 'the vehicle is still out on another agreement');
  }
  const asset = (await c.query('SELECT status, odometer_km FROM fleet.asset WHERE id = $1 FOR UPDATE', [r.asset_id])).rows[0];
  if (['out_of_service', 'retired'].includes(asset.status)) throw new RentalError('vehicle_out_of_service', `the vehicle is ${asset.status}`);
  if (asset.odometer_km !== null && x.km < asset.odometer_km) throw new RentalError('odometer_too_low', `odometer is below the last reading (${asset.odometer_km} km)`);
  if (x.at < new Date(r.pickup_at)) {
    await c.query('SAVEPOINT early');
    try {
      await c.query('UPDATE ops.assignment SET period = tstzrange($2::timestamptz, upper(period)) WHERE task_id = $1 AND active', [r.task_id, x.at.toISOString()]);
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT early');
      if ((e as { constraint?: string }).constraint === 'no_asset_overlap') throw new RentalError('vehicle_booked', 'the vehicle is booked before the pickup time');
      throw e;
    }
  }
  await c.query(`UPDATE ops.rental_agreement SET out_at = $2, out_odometer_km = $3, out_fuel = $4, out_damage = $5, out_by = $6, version = version + 1 WHERE id = $1`,
    [id, x.at.toISOString(), x.km, x.fuel, x.damage, x.by]);
  await c.query(`UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2), status = CASE WHEN status = 'available' THEN 'in_use' ELSE status END WHERE id = $1`, [r.asset_id, x.km]);
  await moveTask(c, a, r.task_id, 'in_progress', `checked out by ${x.by}`, x.at);
  await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'rental.checked_out', targetType: 'rental_agreement', targetId: id, after: { km: x.km, fuel: x.fuel, damage: x.damage, by: x.by } });
}

/** Check-in: the vehicle is back. Odometer, fuel and damage; the charges are worked out and the agreement closes. */
export async function checkIn(c: PoolClient, a: AuthContext, id: string, x: { km: number; fuel: number | null; damage: string | null; damageAmount: number; at: Date; by: 'staff' | 'driver' }) {
  const r = (await c.query(
    `SELECT id, task_id, asset_id, out_at, in_at, out_odometer_km, out_fuel, rate_unit, rate::float, km_per_day, extra_km_rate::float, fuel_rate::float
       FROM ops.rental_agreement WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!r) throw new NotFoundException();
  if (!r.out_at) throw new RentalError('invalid_stage', 'the vehicle was not checked out');
  if (r.in_at) throw new RentalError('invalid_stage', 'the vehicle is already back');
  if (x.km < r.out_odometer_km) throw new RentalError('odometer_too_low', `odometer is below the check-out reading (${r.out_odometer_km} km)`);
  const at = x.at < new Date(r.out_at) ? new Date(r.out_at) : x.at;
  const ch = charges({ outAt: new Date(r.out_at), inAt: at, outKm: r.out_odometer_km, inKm: x.km, outFuel: r.out_fuel, inFuel: x.fuel,
    unit: r.rate_unit as RateUnit, rate: r.rate, kmPerDay: r.km_per_day, extraKmRate: r.extra_km_rate, fuelRate: r.fuel_rate, damage: x.damageAmount });
  await c.query(
    `UPDATE ops.rental_agreement SET in_at = $2, in_odometer_km = $3, in_fuel = $4, in_damage = $5, in_by = $6, days = $7, rental_amount = $8, extra_km = $9, km_amount = $10,
            fuel_amount = $11, damage_amount = $12, total = $13, closed_at = now(), version = version + 1 WHERE id = $1`,
    [id, at.toISOString(), x.km, x.fuel, x.damage, x.by, ch.days, ch.rental_amount, ch.extra_km, ch.km_amount, ch.fuel_amount, ch.damage_amount, ch.total]);
  await c.query(`UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2), status = CASE WHEN status = 'in_use' THEN 'available' ELSE status END WHERE id = $1`, [r.asset_id, x.km]);
  // back early: the vehicle is free from now
  await c.query(`UPDATE ops.assignment SET period = tstzrange(lower(period), GREATEST($2::timestamptz, lower(period) + interval '1 minute'))
                  WHERE task_id = $1 AND active AND upper(period) > $2::timestamptz`, [r.task_id, at.toISOString()]);
  await moveTask(c, a, r.task_id, 'completed', `checked in by ${x.by}`, at);
  await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'rental.checked_in', targetType: 'rental_agreement', targetId: id, after: { km: x.km, fuel: x.fuel, damage: x.damage, by: x.by, ...ch } });
  return ch;
}

/**
 * The driver's hand-over (delivery) or collection from the app: the same check-out or check-in as the counter. Returns a
 * reject code instead of throwing so the driver's sync reports it per op.
 */
export async function rentalStage(c: PoolClient, a: AuthContext, taskId: string, code: Stage, x: { km: number | null; fuel: number | null; at: Date; receivedBy: string | null; note: string | null }): Promise<string | null> {
  const m = (await c.query('SELECT agreement_id, kind FROM ops.rental_move WHERE task_id = $1', [taskId])).rows[0];
  if (!m || STAGE_OF[m.kind as 'deliver' | 'collect'] !== code) return 'not_supported';
  if (x.km === null) return 'odometer_required';
  if (code === 'handover' && !x.receivedBy) return 'receiver_required';
  await c.query('SAVEPOINT rs');
  try {
    if (code === 'handover') await checkOut(c, a, m.agreement_id, { km: x.km, fuel: x.fuel, damage: x.note, at: x.at, by: 'driver' });
    else await checkIn(c, a, m.agreement_id, { km: x.km, fuel: x.fuel, damage: x.note, damageAmount: 0, at: x.at, by: 'driver' });
    await c.query('RELEASE SAVEPOINT rs');
    return null;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT rs');
    if (e instanceof RentalError) return e.code;
    throw e;
  }
}

function asHttp(e: unknown): never {
  if (e instanceof RentalError) throw e.code === 'odometer_too_low' ? new BadRequestException(e.message) : new ConflictException(`${e.code}: ${e.message}`);
  throw e;
}

@Controller('v1/rental')
@UseGuards(AuthGuard)
@Pack('rental')
export class RentalController {
  constructor(private readonly db: DbService) {}

  // ---- agreements ----

  @Get('agreements')
  @Perm('tasks:read')
  list(@Auth() a: AuthContext, @Query('state') state?: string, @Query('customer_id') customer?: string, @Query('asset_id') asset?: string) {
    const cu = v.uuid(customer, 'customer_id'), as = v.uuid(asset, 'asset_id');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${AGR_SQL} WHERE ($1::uuid IS NULL OR r.customer_id = $1) AND ($2::uuid IS NULL OR r.asset_id = $2) ORDER BY r.pickup_at DESC LIMIT 500`, [cu, as])).rows;
      return { data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** A reservation: the vehicle is booked exclusively from pickup to return; rates come from the office. */
  @Post('agreements')
  @Perm('tasks:assign')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const branch = v.uuid(b?.branch_id, 'branch_id');
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const drivers = parseDrivers(b?.drivers);
    const from = v.ts(b?.pickup_at, 'pickup_at', { required: true })!;
    const due = v.ts(b?.return_due, 'return_due', { required: true })!;
    if (due <= from || due.getTime() - from.getTime() > 366 * 86_400_000) throw new BadRequestException('return_due must be after pickup_at, within 366 days');
    if (due.getTime() < Date.now()) throw new BadRequestException('return_due is in the past');
    checkLicences(drivers, due);
    const unit = v.oneOf(b?.rate_unit, 'rate_unit', RATE_UNITS) ?? 'day';
    const rate = v.money(b?.rate, 'rate', { required: true })!;
    const kmDay = v.int(b?.km_per_day, 'km_per_day', 1, 5000);
    const extraKm = v.money(b?.extra_km_rate, 'extra_km_rate') ?? '0';
    const fuelRate = v.money(b?.fuel_rate, 'fuel_rate') ?? '0';
    const deposit = v.money(b?.deposit, 'deposit') ?? '0';
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const m = (await c.query('SELECT legal_entity_id, status, asset_type, plate_no FROM fleet.asset WHERE id = $1', [asset])).rows[0];
      if (!m || m.legal_entity_id !== le) throw new BadRequestException('unknown asset_id');
      if (!(RENTAL_TYPES as readonly string[]).includes(m.asset_type)) throw new BadRequestException(`a ${m.asset_type} is not a rental vehicle`);
      if (['out_of_service', 'retired'].includes(m.status)) throw new ConflictException(`vehicle is ${m.status}`);
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.rental_agreement`)).rows[0].n;
      const id = randomUUID(), ref = `RA-${n}`;
      const task = await createTask(c, a, {
        le, pack: RENTAL, branch, status: 'ready', customer, site: null, ref,
        win: { from: from.toISOString(), to: due.toISOString() },
        attrs: { kind: 'rental', agreement_id: id, rental_ref: ref, plate_no: m.plate_no, renter_name: drivers[0].name },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,NULL,$4,true,tstzrange($5,$6),$7)`,
          [randomUUID(), a.tenantId, task.id, asset, from.toISOString(), due.toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        if ((e as { constraint?: string }).constraint === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the vehicle is booked in this period');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `rental ${ref}`);
      await c.query(
        `INSERT INTO ops.rental_agreement (id, tenant_id, legal_entity_id, branch_id, ref, customer_id, asset_id, task_id, drivers, pickup_at, return_due, rate_unit, rate, km_per_day,
            extra_km_rate, fuel_rate, deposit, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, a.tenantId, le, branch, ref, customer, asset, task.id, JSON.stringify(drivers), from.toISOString(), due.toISOString(), unit, rate, kmDay, extraKm, fuelRate, deposit, notes, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'rental.reserved', targetType: 'rental_agreement', targetId: id,
        after: { ref, customer, asset, from: from.toISOString(), due: due.toISOString(), unit, rate, kmDay, deposit } });
      return this.one(c, id);
    });
  }

  @Get('agreements/:id')
  @Perm('tasks:read')
  get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => ({
      ...(await this.one(c, id)),
      moves: (await c.query(`${MOVE_SQL} WHERE m.agreement_id = $1 ORDER BY lower(t.service_window)`, [id])).rows,
      fines: (await c.query(`${FINE_SQL} WHERE f.agreement_id = $1 ORDER BY f.occurred_at`, [id])).rows,
    }));
  }

  @Post('agreements/:id/checkout')
  @HttpCode(200)
  @Perm('tasks:assign')
  checkout(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const km = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000) ?? (() => { throw new BadRequestException('odometer_km required'); })();
    const fuel = v.int(b?.fuel, 'fuel', 0, 8);
    const damage = v.str(b?.damage, 'damage', { max: 1000 });
    const at = v.ts(b?.at, 'at') ?? new Date();
    if (at.getTime() > Date.now() + 300_000) throw new BadRequestException('at is in the future');
    return this.db.withTenant(a, async (c) => {
      await checkOut(c, a, id, { km, fuel, damage, at, by: 'staff' }).catch(asHttp);
      return this.one(c, id);
    });
  }

  @Post('agreements/:id/checkin')
  @HttpCode(200)
  @Perm('tasks:assign')
  checkin(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const km = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000) ?? (() => { throw new BadRequestException('odometer_km required'); })();
    const fuel = v.int(b?.fuel, 'fuel', 0, 8);
    const damage = v.str(b?.damage, 'damage', { max: 1000 });
    const damageAmount = Number(v.money(b?.damage_amount, 'damage_amount') ?? 0);
    const at = v.ts(b?.at, 'at') ?? new Date();
    if (at.getTime() > Date.now() + 300_000) throw new BadRequestException('at is in the future');
    return this.db.withTenant(a, async (c) => {
      await checkIn(c, a, id, { km, fuel, damage, damageAmount, at, by: 'staff' }).catch(asHttp);
      return this.one(c, id);
    });
  }

  /** A later return: the booking grows if the vehicle is free, and every licence must still be valid. */
  @Post('agreements/:id/extend')
  @HttpCode(200)
  @Perm('tasks:assign')
  extend(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const due = v.ts(b?.return_due, 'return_due', { required: true })!;
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query('SELECT task_id, pickup_at, return_due, drivers, in_at, canceled_at FROM ops.rental_agreement WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.in_at || r.canceled_at) throw new ConflictException('the agreement is closed');
      if (due <= new Date(r.return_due) || due.getTime() - new Date(r.pickup_at).getTime() > 366 * 86_400_000) throw new BadRequestException('return_due must be later, within 366 days of the pickup');
      checkLicences(r.drivers, due);
      await c.query('SAVEPOINT x');
      try {
        await c.query('UPDATE ops.assignment SET period = tstzrange(lower(period), $2::timestamptz) WHERE task_id = $1 AND active', [r.task_id, due.toISOString()]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT x');
        if ((e as { constraint?: string }).constraint === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the vehicle is booked after the current return');
        throw e;
      }
      await c.query('UPDATE ops.task SET service_window = tstzrange(lower(service_window), $2::timestamptz), version = version + 1, updated_at = now() WHERE id = $1', [r.task_id, due.toISOString()]);
      await c.query('UPDATE ops.rental_agreement SET return_due = $2, version = version + 1 WHERE id = $1', [id, due.toISOString()]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'rental.extended', targetType: 'rental_agreement', targetId: id, before: { return_due: r.return_due }, after: { return_due: due.toISOString() } });
      return this.one(c, id);
    });
  }

  /** Cancels a reservation before the vehicle goes out; open deliveries and collections are canceled too. */
  @Post('agreements/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query('SELECT task_id, out_at, canceled_at FROM ops.rental_agreement WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.canceled_at) return this.one(c, id);
      if (r.out_at) throw new ConflictException('the vehicle is out; check it in instead');
      const tasks = [r.task_id, ...(await c.query('SELECT task_id FROM ops.rental_move WHERE agreement_id = $1', [id])).rows.map((x) => x.task_id)];
      for (const t of tasks) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t]);
        await moveTask(c, a, t, 'canceled', `rental canceled: ${reason}`);
      }
      await c.query('UPDATE ops.rental_agreement SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'rental.canceled', targetType: 'rental_agreement', targetId: id, after: { reason } });
      return this.one(c, id);
    });
  }

  /** A driver delivers the vehicle to the customer (at pickup) or collects it (at return); the driver is booked for the hour. */
  @Post('agreements/:id/moves')
  @Perm('tasks:assign')
  addMove(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const kind = v.oneOf(b?.kind, 'kind', ['deliver', 'collect'] as const, { required: true })!;
    const driver = v.uuid(b?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const address = normalizeAttributes({ dropoff: v.obj(b?.address, 'address') ?? (() => { throw new BadRequestException('address required'); })() })!.dropoff as Record<string, unknown>;
    if (!address.area && !address.name) throw new BadRequestException('address needs an area or a name');
    const at0 = v.ts(b?.at, 'at');
    return this.db.withTenant(a, async (c) => {
      const r = (await this.one(c, id));
      if (r.state === 'canceled' || r.state === 'returned') throw new ConflictException('the agreement is closed');
      if (kind === 'deliver' && r.state !== 'reserved') throw new ConflictException('the vehicle is already out');
      if ((await c.query(`SELECT 1 FROM ops.rental_move m JOIN ops.task t ON t.id = m.task_id WHERE m.agreement_id = $1 AND m.kind = $2 AND t.status NOT IN ('canceled','failed')`, [id, kind])).rowCount) {
        throw new ConflictException(`a ${kind} is already planned`);
      }
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [driver, r.legal_entity_id])).rowCount) throw new BadRequestException('unknown driver_worker_id');
      const at = at0 ?? new Date(kind === 'deliver' ? r.pickup_at : r.return_due);
      const end = new Date(at.getTime() + MOVE_MIN * 60_000);
      const task = await createTask(c, a, {
        le: r.legal_entity_id, pack: RENTAL, branch: r.branch_id, status: 'ready', customer: r.customer_id, site: null, ref: `${r.ref}-${kind === 'deliver' ? 'D' : 'C'}-${randomUUID().slice(0, 8)}`,
        win: { from: at.toISOString(), to: end.toISOString() },
        attrs: { kind, agreement_id: id, rental_ref: r.ref, plate_no: r.plate_no, vehicle: [r.make, r.model].filter(Boolean).join(' ') || null, renter_name: r.renter_name,
          renter_phone: r.renter_phone, dropoff: address, address: addrLine(address), out_odometer_km: r.out_odometer_km, out_fuel: r.out_fuel },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,NULL,true,tstzrange($5,$6),$7)`,
          [randomUUID(), a.tenantId, task.id, driver, at.toISOString(), end.toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        if ((e as { constraint?: string }).constraint === 'no_worker_overlap') throw new ConflictException('driver_booked: the driver has another booking then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${kind} ${r.ref}`);
      await c.query('INSERT INTO ops.rental_move (task_id, tenant_id, agreement_id, kind, address) VALUES ($1,$2,$3,$4,$5)', [task.id, a.tenantId, id, kind, JSON.stringify(address)]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: `rental.${kind}_planned`, targetType: 'rental_agreement', targetId: id, after: { task: task.id, driver, at: at.toISOString() } });
      return (await c.query(`${MOVE_SQL} WHERE m.task_id = $1`, [task.id])).rows[0];
    });
  }

  // ---- fleet ----

  /** Rental vehicles now: out (with whom, due when), the next reservation, or free. */
  @Get('fleet')
  @Perm('tasks:read')
  fleet(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT a.id, a.plate_no, a.asset_type, a.make, a.model, a.year, a.status, a.odometer_km,
                o.id AS out_id, o.ref AS out_ref, ocu.name AS out_customer, o.return_due AS out_due, o.return_due < now() AS overdue,
                n.id AS next_id, n.ref AS next_ref, n.pickup_at AS next_pickup
           FROM fleet.asset a
           LEFT JOIN ops.rental_agreement o ON o.asset_id = a.id AND o.out_at IS NOT NULL AND o.in_at IS NULL AND o.canceled_at IS NULL
           LEFT JOIN crm.customer ocu ON ocu.id = o.customer_id
           LEFT JOIN LATERAL (SELECT x.id, x.ref, x.pickup_at FROM ops.rental_agreement x WHERE x.asset_id = a.id AND x.out_at IS NULL AND x.canceled_at IS NULL AND x.return_due > now()
                               ORDER BY x.pickup_at LIMIT 1) n ON true
          WHERE a.asset_type = ANY ($1::text[]) AND a.status <> 'retired'
          ORDER BY (o.id IS NULL), a.plate_no`, [RENTAL_TYPES])).rows,
    }));
  }

  // ---- traffic fines ----

  @Get('fines')
  @Perm('tasks:read')
  fines(@Auth() a: AuthContext, @Query('status') status?: string) {
    const st = v.oneOf(status, 'status', FINE_STATUSES);
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`${FINE_SQL} WHERE ($1::text IS NULL OR f.status = $1) ORDER BY f.occurred_at DESC LIMIT 500`, [st])).rows }));
  }

  /** A traffic fine on a vehicle: matched to the agreement the vehicle was out on at that moment, if any. */
  @Post('fines')
  @Perm('tasks:assign')
  addFine(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const asset = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const at = v.ts(b?.occurred_at, 'occurred_at', { required: true })!;
    if (at.getTime() > Date.now() + 300_000) throw new BadRequestException('occurred_at is in the future');
    const amount = v.money(b?.amount, 'amount', { required: true, positive: true })!;
    const no = v.str(b?.fine_no, 'fine_no', { max: 60 });
    const desc = v.str(b?.description, 'description', { max: 500 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1', [asset])).rowCount) throw new BadRequestException('unknown asset_id');
      if (no && (await c.query('SELECT 1 FROM ops.rental_fine WHERE fine_no = $1', [no])).rowCount) throw new ConflictException('this fine number is already recorded');
      const agr = (await c.query(
        `SELECT id FROM ops.rental_agreement WHERE asset_id = $1 AND canceled_at IS NULL AND out_at <= $2 AND (in_at IS NULL OR in_at >= $2) ORDER BY out_at DESC LIMIT 1`,
        [asset, at.toISOString()])).rows[0]?.id ?? null;
      const id = randomUUID();
      await c.query(`INSERT INTO ops.rental_fine (id, tenant_id, asset_id, occurred_at, amount, fine_no, description, agreement_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, a.tenantId, asset, at.toISOString(), amount, no, desc, agr, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'rental.fine_recorded', targetType: 'rental_fine', targetId: id, after: { asset, at: at.toISOString(), amount, no, agreement: agr } });
      return (await c.query(`${FINE_SQL} WHERE f.id = $1`, [id])).rows[0];
    });
  }

  /** Charged to the renter, waived, or paid by the company (no renter at the time). */
  @Post('fines/:id')
  @HttpCode(200)
  @Perm('tasks:assign')
  setFine(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const status = v.oneOf(b?.status, 'status', FINE_STATUSES, { required: true })!;
    return this.db.withTenant(a, async (c) => {
      const f = (await c.query('SELECT status, agreement_id FROM ops.rental_fine WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!f) throw new NotFoundException();
      if (status === 'charged' && !f.agreement_id) throw new ConflictException('no agreement to charge: the vehicle was not rented then');
      await c.query('UPDATE ops.rental_fine SET status = $2 WHERE id = $1', [id, status]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'rental.fine_status', targetType: 'rental_fine', targetId: id, before: { status: f.status }, after: { status } });
      return (await c.query(`${FINE_SQL} WHERE f.id = $1`, [id])).rows[0];
    });
  }

  // ---- watch and report ----

  /** For a day: overdue returns, late pickups, pickups and returns due, failed deliveries or collections, open fines. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const kw = `AT TIME ZONE 'Asia/Kuwait'`;
      const overdue = (await c.query(`${AGR_SQL} WHERE r.out_at IS NOT NULL AND r.in_at IS NULL AND r.canceled_at IS NULL AND r.return_due < now() ORDER BY r.return_due`)).rows;
      const latePickups = (await c.query(`${AGR_SQL} WHERE r.out_at IS NULL AND r.canceled_at IS NULL AND r.pickup_at + make_interval(mins => $1) < now()
                                           AND r.pickup_at > now() - interval '7 days' ORDER BY r.pickup_at`, [LATE_PICKUP_MIN])).rows;
      const pickups = (await c.query(`${AGR_SQL} WHERE r.canceled_at IS NULL AND (r.pickup_at ${kw})::date = $1 ORDER BY r.pickup_at`, [day])).rows;
      const returns = (await c.query(`${AGR_SQL} WHERE r.canceled_at IS NULL AND r.in_at IS NULL AND (r.return_due ${kw})::date = $1 ORDER BY r.return_due`, [day])).rows;
      const failedMoves = (await c.query(`${MOVE_SQL} WHERE t.status = 'failed' AND (lower(t.service_window) ${kw})::date = $1`, [day])).rows;
      const openFines = (await c.query(`${FINE_SQL} WHERE f.status = 'open' ORDER BY f.occurred_at`)).rows;
      return { date: day, overdue, late_pickups: latePickups, pickups, returns, failed_moves: failedMoves, open_fines: openFines };
    });
  }

  /** For a period: closed agreements by customer, each vehicle's rented share of the period, and the totals. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const kw = `AT TIME ZONE 'Asia/Kuwait'`;
      const closed = `r.closed_at IS NOT NULL AND (r.in_at ${kw})::date BETWEEN $1 AND $2`;
      const sums = `count(*)::int AS agreements, COALESCE(sum(r.days), 0)::int AS days, COALESCE(sum(r.in_odometer_km - r.out_odometer_km), 0)::int AS km,
        COALESCE(sum(r.rental_amount), 0)::text AS rental, COALESCE(sum(r.km_amount), 0)::text AS extra_km, COALESCE(sum(r.fuel_amount), 0)::text AS fuel,
        COALESCE(sum(r.damage_amount), 0)::text AS damage, COALESCE(sum(r.total), 0)::text AS total`;
      const customers = (await c.query(`SELECT cu.name AS customer_name, ${sums} FROM ops.rental_agreement r JOIN crm.customer cu ON cu.id = r.customer_id
                                          WHERE ${closed} GROUP BY cu.name ORDER BY sum(r.total) DESC`, [f, t])).rows;
      const totals = (await c.query(`SELECT ${sums} FROM ops.rental_agreement r WHERE ${closed}`, [f, t])).rows[0];
      const fines = (await c.query(`SELECT COALESCE(sum(amount) FILTER (WHERE status = 'charged'), 0)::text AS charged, COALESCE(sum(amount) FILTER (WHERE status = 'paid_by_us'), 0)::text AS paid_by_us,
                                           count(*) FILTER (WHERE status = 'open')::int AS open FROM ops.rental_fine WHERE (occurred_at ${kw})::date BETWEEN $1 AND $2`, [f, t])).rows[0];
      // the vehicle's rented hours inside the period (out to in, or to now while still out)
      const vehicles = (await c.query(
        `WITH w AS (SELECT ($1::date::timestamp ${kw}) AS f, (($2::date + 1)::timestamp ${kw}) AS t)
         SELECT a.plate_no, a.asset_type, count(r.id)::int AS agreements,
                round(COALESCE(sum(EXTRACT(epoch FROM (LEAST(COALESCE(r.in_at, now()), w.t) - GREATEST(r.out_at, w.f))) / 3600), 0)::numeric, 1)::float AS rented_hours,
                round((EXTRACT(epoch FROM (w.t - w.f)) / 3600)::numeric, 1)::float AS period_hours
           FROM fleet.asset a CROSS JOIN w
           LEFT JOIN ops.rental_agreement r ON r.asset_id = a.id AND r.out_at IS NOT NULL AND r.canceled_at IS NULL AND r.out_at < w.t AND COALESCE(r.in_at, now()) > w.f
          WHERE a.asset_type = ANY ($3::text[]) AND a.status <> 'retired'
          GROUP BY a.plate_no, a.asset_type, w.f, w.t`, [f, t, RENTAL_TYPES])).rows
        .map((x) => ({ ...x, utilization_pct: x.period_hours ? Math.round((x.rented_hours / x.period_hours) * 1000) / 10 : null }))
        .sort((x, y) => (y.utilization_pct ?? 0) - (x.utilization_pct ?? 0));
      return { from: f, to: t, customers, vehicles, totals, fines };
    });
  }

  private async one(c: PoolClient, id: string) {
    const r = (await c.query(`${AGR_SQL} WHERE r.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }
}
