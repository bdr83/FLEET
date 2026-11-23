import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { normalizePhone } from '../../common/phone';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { LATE_START_MIN, parseItinerary, returnRule, seatsOf, Stage, TOUR, tripState, WARN_DAYS } from './tour';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const KW = `AT TIME ZONE 'Asia/Kuwait'`;
const DAY = 86_400_000;

const TRIP_SQL = `
  SELECT tr.id, tr.ref, tr.legal_entity_id, tr.customer_id, cu.name AS customer_name, tr.group_name, tr.contact_name, tr.contact_phone, tr.pax, tr.start_at, tr.end_at,
         tr.pickup, tr.destination, tr.itinerary, tr.cross_border, tr.price::text, tr.deposit::text, tr.notes, tr.canceled_at, tr.cancel_reason, tr.created_at, tr.version,
         (SELECT count(*)::int FROM ops.tour_pax p WHERE p.trip_id = tr.id) AS listed
    FROM ops.tour_trip tr JOIN crm.customer cu ON cu.id = tr.customer_id`;

const BUS_SQL = `
  SELECT tb.task_id, tb.trip_id, tb.seq, tb.asset_id, fa.plate_no, tb.seats, tb.boarded, tb.odometer_out, tb.departed_at, tb.returned, tb.odometer_in, tb.returned_at, tb.return_note,
         t.status, t.ref AS task_ref, asg.worker_id AS driver_id, w.display_name AS driver_name,
         (SELECT e.reason_code FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed' ORDER BY e.occurred_at DESC LIMIT 1) AS fail_reason
    FROM ops.tour_bus tb JOIN ops.task t ON t.id = tb.task_id JOIN fleet.asset fa ON fa.id = tb.asset_id
    LEFT JOIN LATERAL (SELECT a.worker_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id`;

type Bus = Record<string, unknown> & { status: string; seats: number | null; returned_at: unknown; boarded: number | null; returned: number | null; odometer_out: number | null; odometer_in: number | null };
type Trip = Record<string, unknown> & { canceled_at: unknown; pax: number; listed: number; cross_border: boolean; start_at: Date; end_at: Date };

const LIVE = (b: Bus) => !['canceled', 'failed'].includes(b.status);

function shape<T extends Trip>(t: T, buses: Bus[]) {
  const live = buses.filter(LIVE);
  return { ...t, buses, seats: live.reduce((s, b) => s + (b.seats ?? 0), 0), state: tripState(t, buses),
    km: live.reduce((s, b) => s + (b.odometer_in !== null && b.odometer_out !== null ? b.odometer_in - b.odometer_out : 0), 0) };
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

/** Lets a bus go before the trip starts: its booking ends and its task is canceled. */
async function dropBus(c: PoolClient, a: AuthContext, b: Bus, why: string) {
  await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [b.task_id]);
  await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [b.task_id]);
  await event(c, a, b.task_id as string, b.status, 'canceled', why);
}

/**
 * The driver's stages. Boarding needs the head count (not above the seats) and the odometer; the return needs the head
 * count, an odometer not below the outbound one, and a note when fewer came back. The bus is free again once back.
 * Returns a reject code.
 */
export async function tourStage(c: PoolClient, taskId: string, code: Stage, x: { at: Date; headcount: number | null; odometer: number | null; note: string | null }): Promise<string | null> {
  const b = (await c.query('SELECT task_id, seats, boarded, odometer_out FROM ops.tour_bus WHERE task_id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!b) return 'not_supported';
  if (x.headcount === null) return 'headcount_required';
  if (x.odometer === null) return 'odometer_required';
  if (b.seats !== null && x.headcount > b.seats) return 'over_seats';
  if (code === 'tr_boarded') {
    await c.query('UPDATE ops.tour_bus SET boarded = $2, odometer_out = $3, departed_at = $4 WHERE task_id = $1', [taskId, x.headcount, x.odometer, x.at]);
    return null;
  }
  if (b.odometer_out !== null && x.odometer < b.odometer_out) return 'odometer_too_low';
  const bad = returnRule(b.boarded, x.headcount, x.note);
  if (bad) return bad;
  await c.query('UPDATE ops.tour_bus SET returned = $2, odometer_in = $3, returned_at = $4, return_note = $5 WHERE task_id = $1', [taskId, x.headcount, x.odometer, x.at, x.note]);
  await c.query(`UPDATE ops.assignment SET period = tstzrange(lower(period), GREATEST(lower(period) + interval '1 minute', LEAST(upper(period), $2::timestamptz))) WHERE task_id = $1 AND active`,
    [taskId, x.at.toISOString()]);
  return null;
}

function parsePax(val: unknown) {
  if (!Array.isArray(val) || val.length > 2000) throw new BadRequestException('passengers must be a list of up to 2000');
  const seen = new Set<string>();
  return val.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = v.str(o.name, `passengers[${i}].name`, { required: true, max: 120 })!;
    const idNo = v.str(o.id_no, `passengers[${i}].id_no`, { max: 20 })?.replace(/\s/g, '').toUpperCase() || null;
    if (idNo && !/^[A-Z0-9]{5,20}$/.test(idNo)) throw new BadRequestException(`passengers[${i}].id_no invalid`);
    if (idNo && seen.has(idNo)) throw new BadRequestException(`passengers[${i}].id_no repeated`);
    if (idNo) seen.add(idNo);
    const rawPhone = v.str(o.phone, `passengers[${i}].phone`, { max: 20 });
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) throw new BadRequestException(`passengers[${i}].phone invalid`);
    return { name, id_no: idNo, nationality: v.str(o.nationality, `passengers[${i}].nationality`, { max: 60 }), phone, bus_seq: v.int(o.bus_seq, `passengers[${i}].bus_seq`, 1, 99) };
  });
}

@Controller('v1/tours')
@UseGuards(AuthGuard)
@Pack('tour')
export class TourController {
  constructor(private readonly db: DbService) {}

  /** Trips starting in a period (by default today and the next 30 days). */
  @Get('trips')
  @Perm('tasks:read')
  trips(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from') ?? kwToday();
    const t = v.date(to, 'to') ?? new Date(Date.parse(f) + 30 * DAY).toISOString().slice(0, 10);
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const trips = (await c.query(`${TRIP_SQL} WHERE (tr.end_at ${KW})::date >= $1 AND (tr.start_at ${KW})::date <= $2 ORDER BY tr.start_at`, [f, t])).rows as Trip[];
      const buses = await this.busesOf(c, trips.map((x) => x.id as string));
      return { from: f, to: t, data: trips.map((x) => shape(x, buses.filter((b) => b.trip_id === x.id))) };
    });
  }

  /** A trip: the customer (agency, school, company), the group, the passengers, start and end, pickup, destination, itinerary and price. */
  @Post('trips')
  @Perm('tasks:assign')
  addTrip(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const group = v.str(b?.group_name, 'group_name', { required: true, max: 120 })!;
    const contact = v.str(b?.contact_name, 'contact_name', { max: 120 });
    const rawPhone = v.str(b?.contact_phone, 'contact_phone', { max: 20 });
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) throw new BadRequestException('contact_phone invalid');
    const pax = v.int(b?.pax, 'pax', 1, 2000);
    if (pax === null) throw new BadRequestException('pax required');
    const start = v.ts(b?.start_at, 'start_at', { required: true })!, end = v.ts(b?.end_at, 'end_at', { required: true })!;
    if (end <= start) throw new BadRequestException('end_at must be after start_at');
    if (end.getTime() - start.getTime() > 31 * DAY) throw new BadRequestException('a trip is at most 31 days');
    if (end.getTime() < Date.now()) throw new BadRequestException('the trip is over');
    const pickup = v.str(b?.pickup, 'pickup', { required: true })!, destination = v.str(b?.destination, 'destination', { required: true })!;
    const itinerary = parseItinerary(b?.itinerary, start, end);
    const cross = b?.cross_border === true;
    const price = v.money(b?.price, 'price'), deposit = v.money(b?.deposit, 'deposit');
    if (price && deposit && Number(deposit) > Number(price)) throw new BadRequestException('deposit is more than the price');
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [customer])).rows[0];
      if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
      if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.tour_trip`)).rows[0].n;
      const id = randomUUID(), ref = `TR-${n}`;
      await c.query(`INSERT INTO ops.tour_trip (id, tenant_id, legal_entity_id, ref, customer_id, group_name, contact_name, contact_phone, pax, start_at, end_at, pickup, destination, itinerary,
                       cross_border, price, deposit, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, a.tenantId, le, ref, customer, group, contact, phone, pax, start.toISOString(), end.toISOString(), pickup, destination, JSON.stringify(itinerary), cross, price, deposit, notes, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tour.trip_added', targetType: 'tour_trip', targetId: id, after: { ref, customer, pax, start, end, cross } });
      return this.trip(c, id);
    });
  }

  @Get('trips/:id')
  @Perm('tasks:read')
  getTrip(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.trip(c, id));
  }

  /** Cancels a trip that has not left: buses booked for it are let go. */
  @Post('trips/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const reason = v.str(body?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const t = await this.trip(c, id, true);
      if (t.state === 'canceled') return t;
      if (t.buses.some((b) => ['in_progress', 'completed', 'reviewed', 'invoiced'].includes(b.status))) throw new ConflictException('a bus of the trip has already left');
      for (const b of t.buses.filter(LIVE)) await dropBus(c, a, b, `trip canceled: ${reason}`);
      await c.query('UPDATE ops.tour_trip SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tour.canceled', targetType: 'tour_trip', targetId: id, after: { reason } });
      return this.trip(c, id);
    });
  }

  /** Buses and drivers free for the whole trip, with their seats: the office's short list. */
  @Get('trips/:id/candidates')
  @Perm('tasks:read')
  candidates(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const t = await this.trip(c, id);
      const p = [t.legal_entity_id, new Date(t.start_at).toISOString(), new Date(t.end_at).toISOString()];
      const busy = (col: string, ref: string) => `EXISTS (SELECT 1 FROM ops.assignment x WHERE x.active AND x.exclusive AND x.period && tstzrange($2, $3) AND x.${col} = ${ref})`;
      const buses = (await c.query(`SELECT fa.id AS asset_id, fa.plate_no, fa.capacity FROM fleet.asset fa WHERE fa.legal_entity_id = $1 AND fa.asset_type IN ('bus','van')
                                      AND fa.status NOT IN ('out_of_service','retired') AND NOT ${busy('asset_id', 'fa.id')} ORDER BY fa.plate_no`, p)).rows
        .map((x) => ({ asset_id: x.asset_id, plate_no: x.plate_no, seats: seatsOf(x.capacity) }));
      const drivers = (await c.query(`SELECT w.id, w.display_name FROM workforce.worker w WHERE w.legal_entity_id = $1 AND w.status = 'active' AND w.kind = 'driver'
                                        AND NOT ${busy('worker_id', 'w.id')} ORDER BY w.display_name`, p)).rows;
      return { buses, drivers, seats_needed: Math.max(0, t.pax - t.seats) };
    });
  }

  /** Adds a bus with its driver: a task booking both for the whole trip. Seats come from the bus record unless given. */
  @Post('trips/:id/buses')
  @Perm('tasks:assign')
  addBus(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const asset = v.uuid(body?.asset_id, 'asset_id', { required: true })!;
    const driver = v.uuid(body?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const given = v.int(body?.seats, 'seats', 1, 120);
    return this.db.withTenant(a, async (c) => {
      const t = await this.trip(c, id, true);
      if (!['planned', 'ready'].includes(t.state)) throw new ConflictException(`the trip is ${t.state}`);
      const bus = (await c.query(`SELECT plate_no, capacity FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2 AND asset_type IN ('bus','van') AND status NOT IN ('out_of_service','retired')`,
        [asset, t.legal_entity_id])).rows[0];
      if (!bus) throw new BadRequestException('not_a_bus: unknown or unavailable bus');
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [driver, t.legal_entity_id])).rowCount) throw new BadRequestException('unknown driver_worker_id');
      const seats = given ?? seatsOf(bus.capacity);
      const seq = (await c.query('SELECT coalesce(max(seq), 0) + 1 AS n FROM ops.tour_bus WHERE trip_id = $1', [id])).rows[0].n as number;
      const from = new Date(t.start_at).toISOString(), to = new Date(t.end_at).toISOString();
      const task = await createTask(c, a, {
        le: t.legal_entity_id as string, pack: TOUR, branch: null, status: 'ready', customer: t.customer_id as string, site: null, ref: `${t.ref}-B${seq}`,
        win: { from, to },
        attrs: { kind: 'tour', trip_id: id, trip_ref: t.ref, bus_seq: seq, group_name: t.group_name, customer_name: t.customer_name, contact_name: t.contact_name, contact_phone: t.contact_phone,
          pax: t.pax, seats, pickup: t.pickup, destination: t.destination, address: t.pickup, itinerary: t.itinerary, cross_border: t.cross_border, notes: t.notes },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, driver, asset, from, to, a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('driver_booked: the driver has another job during the trip');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the bus is booked during the trip');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${t.ref} ${t.group_name} bus ${seq}`);
      await c.query('INSERT INTO ops.tour_bus (task_id, tenant_id, trip_id, seq, asset_id, seats) VALUES ($1,$2,$3,$4,$5,$6)', [task.id, a.tenantId, id, seq, asset, seats]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tour.bus_added', targetType: 'tour_trip', targetId: id, after: { task: task.id, asset, driver, seats } });
      return this.trip(c, id);
    });
  }

  /** Lets a bus go before it leaves (the group got smaller, or another bus replaces it). */
  @Post('trips/:id/buses/:taskId/release')
  @HttpCode(200)
  @Perm('tasks:assign')
  releaseBus(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('taskId', new ParseUUIDPipe()) taskId: string, @Body() body: Record<string, unknown>) {
    const reason = v.str(body?.reason, 'reason', { max: 500 }) ?? 'bus released';
    return this.db.withTenant(a, async (c) => {
      const t = await this.trip(c, id, true);
      const b = t.buses.find((x) => x.task_id === taskId);
      if (!b) throw new NotFoundException();
      if (!['assigned', 'ready', 'failed'].includes(b.status)) throw new ConflictException(`the bus is ${b.status}`);
      if (b.status === 'failed') await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [taskId]);
      else await dropBus(c, a, b, reason);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tour.bus_released', targetType: 'tour_trip', targetId: id, after: { task: taskId, reason } });
      return this.trip(c, id);
    });
  }

  // ---- passenger list ----

  @Get('trips/:id/manifest')
  @Perm('tasks:read')
  manifest(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const t = await this.trip(c, id);
      const rows = (await c.query('SELECT id, name, id_no, nationality, phone, bus_seq FROM ops.tour_pax WHERE trip_id = $1 ORDER BY bus_seq NULLS LAST, name', [id])).rows;
      return { trip_id: id, ref: t.ref, pax: t.pax, cross_border: t.cross_border, data: rows };
    });
  }

  /** Replaces the passenger list (name, ID or passport, nationality, phone, bus). Required in full for a cross-border trip. */
  @Post('trips/:id/manifest')
  @HttpCode(200)
  @Perm('tasks:assign')
  setManifest(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const list = parsePax(body?.passengers);
    return this.db.withTenant(a, async (c) => {
      const t = await this.trip(c, id, true);
      if (['canceled', 'back'].includes(t.state)) throw new ConflictException(`the trip is ${t.state}`);
      if (list.length > t.pax) throw new BadRequestException(`over_pax: the trip is for ${t.pax} passengers`);
      if (t.cross_border && list.some((p) => !p.id_no)) throw new BadRequestException('id_required: a cross-border trip needs an ID or passport number for each passenger');
      const seqs = new Set(t.buses.filter(LIVE).map((b) => b.seq));
      const bad = list.find((p) => p.bus_seq !== null && !seqs.has(p.bus_seq));
      if (bad) throw new BadRequestException(`unknown bus ${bad.bus_seq}`);
      await c.query('DELETE FROM ops.tour_pax WHERE trip_id = $1', [id]);
      for (const p of list) {
        await c.query('INSERT INTO ops.tour_pax (id, tenant_id, trip_id, name, id_no, nationality, phone, bus_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [randomUUID(), a.tenantId, id, p.name, p.id_no, p.nationality, p.phone, p.bus_seq]);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tour.manifest_set', targetType: 'tour_trip', targetId: id, after: { count: list.length } });
      return { trip_id: id, count: list.length };
    });
  }

  // ---- watch and report ----

  /**
   * Now: trips starting soon without enough seats, cross-border trips starting soon without a full passenger list, buses
   * late to leave, buses back with fewer people than left, and buses not back after the trip's end.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const trips = (await c.query(`${TRIP_SQL} WHERE tr.canceled_at IS NULL AND tr.end_at > now() - interval '7 days' AND tr.start_at < now() + make_interval(days => $1) ORDER BY tr.start_at`,
        [WARN_DAYS])).rows as Trip[];
      const buses = await this.busesOf(c, trips.map((x) => x.id as string));
      const all = trips.map((x) => shape(x, buses.filter((b) => b.trip_id === x.id)));
      const now = Date.now();
      const soon = all.filter((t) => new Date(t.start_at).getTime() > now - DAY && ['planned', 'ready'].includes(t.state));
      const ofBus = (pick: (t: (typeof all)[number], b: Bus) => boolean) =>
        all.flatMap((t) => t.buses.filter((b) => pick(t, b)).map((b) => ({ ...b, trip_ref: t.ref, group_name: t.group_name, customer_name: t.customer_name, start_at: t.start_at, end_at: t.end_at })));
      return {
        short_seats: soon.filter((t) => t.seats < t.pax),
        manifest_missing: soon.filter((t) => t.cross_border && t.listed < t.pax),
        late_start: ofBus((t, b) => b.status === 'assigned' && new Date(t.start_at).getTime() + LATE_START_MIN * 60_000 < now),
        left_behind: ofBus((_t, b) => b.returned !== null && b.boarded !== null && b.returned < b.boarded),
        not_back: ofBus((t, b) => b.status === 'in_progress' && !b.returned_at && new Date(t.end_at).getTime() < now),
      };
    });
  }

  /** For a period: trips, passengers, buses, bus-days, km and amounts per customer (the invoice), with cancellations. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const trips = (await c.query(`${TRIP_SQL} WHERE (tr.start_at ${KW})::date BETWEEN $1 AND $2 ORDER BY tr.start_at`, [f, t])).rows as Trip[];
      const buses = await this.busesOf(c, trips.map((x) => x.id as string));
      const all = trips.map((x) => shape(x, buses.filter((b) => b.trip_id === x.id)));
      const run = all.filter((x) => x.state !== 'canceled');
      const fils = (s: unknown) => Math.round(Number(s ?? 0) * 1000);
      const kwd = (n: number) => (n / 1000).toFixed(3);
      const days = (x: (typeof all)[number]) => Math.max(1, Math.ceil((new Date(x.end_at).getTime() - new Date(x.start_at).getTime()) / DAY));
      const sum = (l: typeof all) => ({
        trips: l.length, pax: l.reduce((s, x) => s + x.pax, 0), buses: l.reduce((s, x) => s + x.buses.filter(LIVE).length, 0),
        bus_days: l.reduce((s, x) => s + x.buses.filter(LIVE).length * days(x), 0), km: l.reduce((s, x) => s + x.km, 0),
        amount: kwd(l.reduce((s, x) => s + fils(x.price), 0)), deposits: kwd(l.reduce((s, x) => s + fils(x.deposit), 0)), no_price: l.filter((x) => x.price === null).length,
      });
      const byCustomer = new Map<string, typeof all>();
      for (const x of run) byCustomer.set(x.customer_name as string, [...(byCustomer.get(x.customer_name as string) ?? []), x]);
      return {
        from: f, to: t,
        totals: { ...sum(run), canceled: all.length - run.length, cross_border: run.filter((x) => x.cross_border).length },
        customers: [...byCustomer.entries()].map(([name, l]) => ({ customer_name: name, ...sum(l) })).sort((x, y) => y.trips - x.trips),
      };
    });
  }

  private async busesOf(c: PoolClient, ids: string[]) {
    if (!ids.length) return [] as Bus[];
    return (await c.query(`${BUS_SQL} WHERE tb.trip_id = ANY($1::uuid[]) ORDER BY tb.seq`, [ids])).rows as Bus[];
  }

  private async trip(c: PoolClient, id: string, lock = false) {
    const t = (await c.query(`${TRIP_SQL} WHERE tr.id = $1${lock ? ' FOR UPDATE OF tr' : ''}`, [id])).rows[0] as Trip | undefined;
    if (!t) throw new NotFoundException();
    return shape(t, await this.busesOf(c, [id]));
  }
}
