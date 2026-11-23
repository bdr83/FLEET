import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { normalizePhone } from '../../common/phone';
import { normalizeAttributes } from '../delivery/delivery';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { bookingState, CLASSES, meterFare, parseKm, Payment, PAYMENTS, servesClass, Stage, TAXI, Tariff, TRIP_MIN, UNASSIGNED_WARN_MIN, LATE_ARRIVAL_MIN, waitMinutes } from './taxi';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const KW = `AT TIME ZONE 'Asia/Kuwait'`;

const BOOKING_SQL = `
  SELECT b.id, b.ref, b.legal_entity_id, b.customer_id, cu.name AS customer_name, b.passenger_name, b.passenger_phone, b.pickup, b.dropoff, b.pickup_at, b.hold_min, b.class, b.pax,
         b.flight_no, b.notes, b.fixed_fare::text, b.task_id, b.attempts, b.arrived_at, b.picked_at, b.dropped_at, b.km::float, b.wait_min, b.fare::text, b.payment,
         b.canceled_at, b.cancel_reason, b.created_at, b.version, t.status AS task_status, asg.worker_id AS driver_id, w.display_name AS driver_name, asg.asset_id, fa.plate_no,
         (SELECT e.reason_code FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed' ORDER BY e.occurred_at DESC LIMIT 1) AS fail_reason
    FROM ops.tx_booking b LEFT JOIN crm.customer cu ON cu.id = b.customer_id
    LEFT JOIN ops.task t ON t.id = b.task_id
    LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id`;

type Row = Record<string, unknown> & { canceled_at: unknown; arrived_at: unknown; picked_at: unknown; dropped_at: unknown; task_status: string | null };
const shape = <T extends Row>(b: T) => ({ ...b, state: bookingState(b, b.task_status) });

const placeLine = (s: Record<string, unknown> | null) =>
  !s ? null : [s.name, s.area, s.block ? `ق ${s.block}` : null, s.street, s.house ? `منزل ${s.house}` : null].filter((x) => typeof x === 'string' && x).join('، ') || null;

function parsePlace(val: unknown, field: string, required: boolean) {
  const raw = v.obj(val, field);
  if (!raw) { if (required) throw new BadRequestException(`${field} required`); return null; }
  const p = normalizeAttributes({ dropoff: raw })!.dropoff as Record<string, unknown>;
  if (!p.area && !p.name) throw new BadRequestException(`${field} needs an area or a name`);
  return p;
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

/** The car and driver are free again once the ride is over: the booking ends at the drop (or the no-show), not at the end of the held window. */
async function release(c: PoolClient, taskId: string, at: Date) {
  await c.query(`UPDATE ops.assignment SET period = tstzrange(lower(period), GREATEST(lower(period) + interval '1 minute', LEAST(upper(period), $2::timestamptz))) WHERE task_id = $1 AND active`,
    [taskId, at.toISOString()]);
}

async function tariffOf(c: PoolClient, le: string, cls: string): Promise<Tariff | null> {
  return (await c.query('SELECT base::text, per_km::text, per_wait_min::text, min_fare::text FROM ops.tx_tariff WHERE legal_entity_id = $1 AND class = $2', [le, cls])).rows[0] ?? null;
}

/** The fare of a dropped booking: the fixed price, or the tariff with the km and the waiting; null when neither is known. */
async function fareOf(c: PoolClient, b: { legal_entity_id: string; class: string; fixed_fare: string | null; pickup_at: Date | string }, km: number | null, arrived: Date | null, picked: Date | null) {
  const wait = waitMinutes(new Date(b.pickup_at), arrived, picked);
  if (b.fixed_fare !== null) return { fare: b.fixed_fare, wait };
  const t = await tariffOf(c, b.legal_entity_id, b.class);
  return { fare: t && km !== null ? meterFare(t, km, wait) : null, wait };
}

/**
 * The driver's stages. Arrival and pick-up record the time; the drop needs the trip km (unless the fare is fixed) and the
 * payment (account only for an account booking), and sets the fare. Returns a reject code.
 */
export async function taxiStage(c: PoolClient, taskId: string, code: Stage, x: { at: Date; km: number | null; payment: string | null }): Promise<string | null> {
  const b = (await c.query('SELECT id, legal_entity_id, class, fixed_fare::text, customer_id, pickup_at, arrived_at, picked_at FROM ops.tx_booking WHERE task_id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!b) return 'not_supported';
  if (code === 'tx_arrived') { await c.query('UPDATE ops.tx_booking SET arrived_at = $2, version = version + 1 WHERE id = $1', [b.id, x.at]); return null; }
  if (code === 'tx_picked') { await c.query('UPDATE ops.tx_booking SET picked_at = $2, version = version + 1 WHERE id = $1', [b.id, x.at]); return null; }
  if (!x.payment || !(PAYMENTS as readonly string[]).includes(x.payment)) return 'payment_required';
  if (x.payment === 'account' && !b.customer_id) return 'no_account';
  if (x.km === null && b.fixed_fare === null) return 'km_required';
  const f = await fareOf(c, b, x.km, b.arrived_at, b.picked_at);
  await c.query('UPDATE ops.tx_booking SET dropped_at = $2, km = $3, wait_min = $4, fare = $5, payment = $6, version = version + 1 WHERE id = $1',
    [b.id, x.at, x.km, f.wait, f.fare, x.payment]);
  await release(c, taskId, x.at);
  return null;
}

/** When a driver marks the passenger absent: only after arriving and waiting long enough. Returns a reject code. */
export async function taxiNoShow(c: PoolClient, taskId: string, at: Date, waitMin: number): Promise<string | null> {
  const b = (await c.query('SELECT pickup_at, arrived_at FROM ops.tx_booking WHERE task_id = $1', [taskId])).rows[0];
  if (!b) return 'not_supported';
  if (!b.arrived_at) return 'not_arrived';
  const from = Math.max(new Date(b.arrived_at).getTime(), new Date(b.pickup_at).getTime());
  if (at.getTime() - from < waitMin * 60_000) return 'wait_more';
  await release(c, taskId, at);
  return null;
}

@Controller('v1/taxi')
@UseGuards(AuthGuard)
@Pack('taxi')
export class TaxiController {
  constructor(private readonly db: DbService) {}

  // ---- cars and tariffs ----

  @Get('cars')
  @Perm('tasks:read')
  cars(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT fa.id AS asset_id, fa.plate_no, fa.asset_type, fa.status, tc.class FROM fleet.asset fa LEFT JOIN ops.tx_car tc ON tc.asset_id = fa.id
                             WHERE fa.status <> 'retired' AND fa.asset_type IN ('car','van','bus','pickup') ORDER BY tc.class IS NULL, tc.class, fa.plate_no`)).rows,
    }));
  }

  /** Registers a car in the taxi fleet with its class. */
  @Put('cars/:assetId')
  @Perm('fleet:write')
  setCar(@Auth() a: AuthContext, @Param('assetId', new ParseUUIDPipe()) assetId: string, @Body() b: Record<string, unknown>) {
    const cls = v.oneOf(b?.class, 'class', CLASSES, { required: true })!;
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1', [assetId])).rowCount) throw new NotFoundException();
      await c.query(`INSERT INTO ops.tx_car (asset_id, tenant_id, class) VALUES ($1,$2,$3) ON CONFLICT (asset_id) DO UPDATE SET class = EXCLUDED.class`, [assetId, a.tenantId, cls]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'taxi.car_set', targetType: 'asset', targetId: assetId, after: { cls } });
      return { asset_id: assetId, class: cls };
    });
  }

  @Get('tariffs')
  @Perm('tasks:read')
  tariffs(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query('SELECT legal_entity_id, class, base::text, per_km::text, per_wait_min::text, min_fare::text, updated_at FROM ops.tx_tariff ORDER BY class')).rows,
    }));
  }

  /** The tariff of a class: base fare, per km, per waiting minute after the free minutes, and the minimum fare. */
  @Put('tariffs')
  @Perm('billing:write')
  setTariff(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const cls = v.oneOf(b?.class, 'class', CLASSES, { required: true })!;
    const t = { base: v.money(b?.base, 'base', { required: true })!, per_km: v.money(b?.per_km, 'per_km', { required: true })!,
      per_wait_min: v.money(b?.per_wait_min, 'per_wait_min') ?? '0', min_fare: v.money(b?.min_fare, 'min_fare') ?? '0' };
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      await c.query(`INSERT INTO ops.tx_tariff (id, tenant_id, legal_entity_id, class, base, per_km, per_wait_min, min_fare, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                     ON CONFLICT (tenant_id, legal_entity_id, class) DO UPDATE SET base = EXCLUDED.base, per_km = EXCLUDED.per_km, per_wait_min = EXCLUDED.per_wait_min,
                       min_fare = EXCLUDED.min_fare, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [randomUUID(), a.tenantId, le, cls, t.base, t.per_km, t.per_wait_min, t.min_fare, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'taxi.tariff_set', targetType: 'legal_entity', targetId: le, after: { cls, ...t } });
      return { legal_entity_id: le, class: cls, ...t };
    });
  }

  // ---- bookings ----

  @Get('bookings')
  @Perm('tasks:read')
  bookings(@Auth() a: AuthContext, @Query('date') date?: string, @Query('state') state?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${BOOKING_SQL} WHERE (b.pickup_at ${KW})::date = $1 ORDER BY b.pickup_at`, [day])).rows.map(shape);
      return { date: day, data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** A booking: the passenger, the pickup (now when no time is given), the drop-off, the class; a fixed fare when agreed. */
  @Post('bookings')
  @Perm('tasks:assign')
  addBooking(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const name = v.str(b?.passenger_name, 'passenger_name', { required: true, max: 120 })!;
    const phone = normalizePhone(v.str(b?.passenger_phone, 'passenger_phone', { required: true, max: 20 })!);
    if (!phone) throw new BadRequestException('passenger_phone invalid');
    const pickup = parsePlace(b?.pickup, 'pickup', true)!;
    const dropoff = parsePlace(b?.dropoff, 'dropoff', false);
    const at = v.ts(b?.pickup_at, 'pickup_at') ?? new Date();
    if (at.getTime() < Date.now() - 15 * 60_000) throw new BadRequestException('pickup_at is in the past');
    const hold = v.int(b?.hold_min, 'hold_min', 15, 720) ?? TRIP_MIN;
    const cls = v.oneOf(b?.class, 'class', CLASSES) ?? 'sedan';
    const pax = v.int(b?.pax, 'pax', 1, 14) ?? 1;
    const flight = v.str(b?.flight_no, 'flight_no', { max: 8 })?.replace(/\s/g, '').toUpperCase() || null;
    if (flight && !/^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/.test(flight)) throw new BadRequestException('flight_no invalid (e.g. KU118)');
    const fixed = v.money(b?.fixed_fare, 'fixed_fare');
    const notes = v.str(b?.notes, 'notes', { max: 500 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      if (customer) {
        const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [customer])).rows[0];
        if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
        if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
      }
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.tx_booking`)).rows[0].n;
      const id = randomUUID(), ref = `TX-${n}`;
      await c.query(`INSERT INTO ops.tx_booking (id, tenant_id, legal_entity_id, ref, customer_id, passenger_name, passenger_phone, pickup, dropoff, pickup_at, hold_min, class, pax, flight_no, notes, fixed_fare, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, a.tenantId, le, ref, customer, name, phone, JSON.stringify(pickup), dropoff ? JSON.stringify(dropoff) : null, at.toISOString(), hold, cls, pax, flight, notes, fixed, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'taxi.booking_added', targetType: 'tx_booking', targetId: id, after: { ref, customer, cls, at } });
      return this.booking(c, id);
    });
  }

  @Get('bookings/:id')
  @Perm('tasks:read')
  getBooking(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.booking(c, id));
  }

  /** Cars that can serve the booking's class and drivers, each free for its window: the dispatcher's short list. */
  @Get('bookings/:id/candidates')
  @Perm('tasks:read')
  candidates(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const b = await this.booking(c, id);
      const from = new Date(b.pickup_at as string), to = new Date(from.getTime() + (b.hold_min as number) * 60_000);
      const busy = `EXISTS (SELECT 1 FROM ops.assignment x WHERE x.active AND x.exclusive AND x.period && tstzrange($2, $3) AND x.%s = %s)`;
      const cars = (await c.query(
        `SELECT fa.id AS asset_id, fa.plate_no, tc.class FROM ops.tx_car tc JOIN fleet.asset fa ON fa.id = tc.asset_id
          WHERE fa.legal_entity_id = $1 AND fa.status NOT IN ('out_of_service','retired') AND NOT ${busy.replace('%s', 'asset_id').replace('%s', 'fa.id')} ORDER BY tc.class, fa.plate_no`,
        [b.legal_entity_id, from.toISOString(), to.toISOString()])).rows.filter((x) => servesClass(x.class, b.class as string));
      const drivers = (await c.query(
        `SELECT w.id, w.display_name FROM workforce.worker w WHERE w.legal_entity_id = $1 AND w.status = 'active' AND w.kind IN ('driver','courier')
            AND NOT ${busy.replace('%s', 'worker_id').replace('%s', 'w.id')} ORDER BY w.display_name`, [b.legal_entity_id, from.toISOString(), to.toISOString()])).rows;
      return { cars, drivers };
    });
  }

  /** Books a car of the class (or a higher one for a sedan) and its driver from the pickup time. Again after a failed trip. */
  @Post('bookings/:id/assign')
  @Perm('tasks:assign')
  assign(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const driver = v.uuid(body?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const asset = v.uuid(body?.asset_id, 'asset_id', { required: true })!;
    return this.db.withTenant(a, async (c) => {
      const b = await this.booking(c, id, true);
      if (!['new', 'failed'].includes(b.state)) throw new ConflictException(`the booking is ${b.state}`);
      const car = (await c.query(`SELECT tc.class FROM ops.tx_car tc JOIN fleet.asset fa ON fa.id = tc.asset_id WHERE tc.asset_id = $1 AND fa.legal_entity_id = $2 AND fa.status NOT IN ('out_of_service','retired')`,
        [asset, b.legal_entity_id])).rows[0];
      if (!car) throw new BadRequestException('not_a_taxi: register the car in the taxi fleet first');
      if (!servesClass(car.class, b.class as string)) throw new ConflictException(`wrong_class: a ${car.class} cannot serve a ${b.class} booking`);
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [driver, b.legal_entity_id])).rowCount) throw new BadRequestException('unknown driver_worker_id');
      if (b.task_id) await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [b.task_id]);
      const n = (b.attempts as number) + 1;
      const from = new Date(b.pickup_at as string), to = new Date(from.getTime() + (b.hold_min as number) * 60_000);
      const tariff = b.fixed_fare === null ? await tariffOf(c, b.legal_entity_id as string, b.class as string) : null;
      const pickup = b.pickup as Record<string, unknown>, dropoff = b.dropoff as Record<string, unknown> | null;
      const task = await createTask(c, a, {
        le: b.legal_entity_id as string, pack: TAXI, branch: null, status: 'ready', customer: b.customer_id as string | null, site: null, ref: `${b.ref}-${n}`,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { kind: 'ride', booking_id: id, booking_ref: b.ref, passenger_name: b.passenger_name, passenger_phone: b.passenger_phone, pax: b.pax, class: b.class, flight_no: b.flight_no,
          pickup, pickup_line: placeLine(pickup), dropoff: dropoff ?? pickup, dropoff_line: placeLine(dropoff), address: placeLine(pickup), account: !!b.customer_id,
          customer_name: b.customer_name, fixed_fare: b.fixed_fare, tariff, notes: b.notes },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, driver, asset, from.toISOString(), to.toISOString(), a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('driver_booked: the driver has another booking then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the car is booked then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${b.ref} ${b.passenger_name}`);
      await c.query('UPDATE ops.tx_booking SET task_id = $2, attempts = $3, arrived_at = NULL, picked_at = NULL, version = version + 1 WHERE id = $1', [id, task.id, n]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'taxi.assigned', targetType: 'tx_booking', targetId: id, after: { task: task.id, driver, asset, attempt: n } });
      return this.booking(c, id);
    });
  }

  /** The office records a finished ride (the driver called it in): km, waiting and payment; the fare follows the tariff or is given. */
  @Post('bookings/:id/record')
  @HttpCode(200)
  @Perm('tasks:assign')
  record(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const km = parseKm(body?.km);
    const wait = v.int(body?.wait_min, 'wait_min', 0, 720) ?? 0;
    const payment = v.oneOf(body?.payment, 'payment', PAYMENTS, { required: true })! as Payment;
    const given = v.money(body?.fare, 'fare');
    return this.db.withTenant(a, async (c) => {
      const b = await this.booking(c, id, true);
      if (!['assigned', 'on_way', 'waiting', 'on_trip'].includes(b.state)) throw new ConflictException(`the booking is ${b.state}`);
      if (payment === 'account' && !b.customer_id) throw new BadRequestException('no_account: the booking has no customer account');
      const at = new Date(b.pickup_at as string);
      const f = given ? { fare: given } : await fareOf(c, b as never, km, at, new Date(at.getTime() + wait * 60_000));
      await c.query(`UPDATE ops.tx_booking SET arrived_at = COALESCE(arrived_at, now()), picked_at = COALESCE(picked_at, now()), dropped_at = now(), km = $2, wait_min = $3, fare = $4, payment = $5,
                       version = version + 1 WHERE id = $1`, [id, km, wait, f.fare, payment]);
      await c.query(`UPDATE ops.task SET status = 'completed', version = version + 1, updated_at = now() WHERE id = $1`, [b.task_id]);
      await release(c, b.task_id as string, new Date());
      await event(c, a, b.task_id as string, b.task_status as string, 'completed', 'ride recorded by the office');
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'taxi.recorded', targetType: 'tx_booking', targetId: id, after: { km, wait, payment, fare: f.fare } });
      return this.booking(c, id);
    });
  }

  /** The office sets or corrects the fare of a finished ride (no tariff for the class, an agreed discount). */
  @Post('bookings/:id/fare')
  @HttpCode(200)
  @Perm('billing:write')
  setFare(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const fare = v.money(body?.fare, 'fare', { required: true })!;
    return this.db.withTenant(a, async (c) => {
      const b = await this.booking(c, id, true);
      if (b.state !== 'done') throw new ConflictException('the ride is not finished');
      await c.query('UPDATE ops.tx_booking SET fare = $2, version = version + 1 WHERE id = $1', [id, fare]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'taxi.fare_set', targetType: 'tx_booking', targetId: id, before: { fare: b.fare }, after: { fare } });
      return this.booking(c, id);
    });
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const reason = v.str(body?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const b = await this.booking(c, id, true);
      if (b.state === 'canceled') return b;
      if (['waiting', 'on_trip', 'done'].includes(b.state)) throw new ConflictException(`the booking is ${b.state}`);
      if (['assigned', 'on_way'].includes(b.state)) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [b.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [b.task_id]);
        await event(c, a, b.task_id as string, b.task_status as string, 'canceled', `booking canceled: ${reason}`);
      }
      await c.query('UPDATE ops.tx_booking SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'taxi.canceled', targetType: 'tx_booking', targetId: id, after: { reason } });
      return this.booking(c, id);
    });
  }

  // ---- watch and report ----

  /** Now: bookings without a car close to pickup, drivers late to the pickup, passengers waiting long, no-shows today, rides without a fare. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${BOOKING_SQL} WHERE b.canceled_at IS NULL AND b.pickup_at BETWEEN now() - interval '1 day' AND now() + interval '1 day' ORDER BY b.pickup_at`)).rows.map(shape);
      const now = Date.now();
      const at = (r: (typeof rows)[number]) => new Date(r.pickup_at as string).getTime();
      return {
        unassigned: rows.filter((r) => r.state === 'new' && at(r) < now + UNASSIGNED_WARN_MIN * 60_000),
        late: rows.filter((r) => ['assigned', 'on_way'].includes(r.state) && at(r) + LATE_ARRIVAL_MIN * 60_000 < now),
        failed: rows.filter((r) => r.state === 'failed' && at(r) > now - 86_400_000),
        no_fare: rows.filter((r) => r.state === 'done' && r.fare === null),
      };
    });
  }

  /**
   * For a period: rides and fares by payment, per driver (km, cash to hand in), per corporate account (the monthly invoice)
   * and per class; no-shows and cancellations.
   */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${BOOKING_SQL} WHERE (b.pickup_at ${KW})::date BETWEEN $1 AND $2`, [f, t])).rows.map(shape);
      const done = rows.filter((r) => r.state === 'done');
      const fils = (s: unknown) => Math.round(Number(s ?? 0) * 1000);
      const kwd = (n: number) => (n / 1000).toFixed(3);
      const sumFare = (l: typeof rows, p?: string) => kwd(l.filter((r) => !p || r.payment === p).reduce((s, r) => s + fils(r.fare), 0));
      const group = (key: (r: (typeof rows)[number]) => string | null) => {
        const m = new Map<string, typeof rows>();
        for (const r of done) { const k = key(r); if (k) m.set(k, [...(m.get(k) ?? []), r]); }
        return [...m.entries()];
      };
      return {
        from: f, to: t,
        totals: { bookings: rows.length, done: done.length, canceled: rows.filter((r) => r.state === 'canceled').length,
          no_shows: rows.filter((r) => r.state === 'failed' && r.fail_reason === 'passenger_no_show').length, failed: rows.filter((r) => r.state === 'failed').length,
          km: Math.round(done.reduce((s, r) => s + Number(r.km ?? 0), 0) * 10) / 10, fare: sumFare(done), cash: sumFare(done, 'cash'), card: sumFare(done, 'card'), account: sumFare(done, 'account'),
          no_fare: done.filter((r) => r.fare === null).length },
        drivers: group((r) => r.driver_name as string | null).map(([name, l]) => ({ driver_name: name, rides: l.length, km: Math.round(l.reduce((s, r) => s + Number(r.km ?? 0), 0) * 10) / 10,
          fare: sumFare(l), cash: sumFare(l, 'cash'), card: sumFare(l, 'card') })).sort((x, y) => y.rides - x.rides),
        accounts: group((r) => r.customer_name as string | null).map(([name, l]) => ({ customer_name: name, rides: l.length, account: sumFare(l, 'account'), fare: sumFare(l) })).sort((x, y) => y.rides - x.rides),
        classes: group((r) => r.class as string).map(([cls, l]) => ({ class: cls, rides: l.length, fare: sumFare(l) })),
      };
    });
  }

  private async booking(c: PoolClient, id: string, lock = false) {
    const b = (await c.query(`${BOOKING_SQL} WHERE b.id = $1${lock ? ' FOR UPDATE OF b' : ''}`, [id])).rows[0];
    if (!b) throw new NotFoundException();
    return shape(b);
  }
}
