import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { DOC_TYPES } from '../../fleet/documents.controller';
import {
  ARRIVAL_GRACE_MIN, CHECKIN_GRACE_MIN, Doc, HAZMAT_DOC, inspect, journeyState, missingDocs, nextCheckinDue, OILGAS, parseDocTypes, PURPOSES, Stage,
} from './oilgas';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const kwDate = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
const KW = `AT TIME ZONE 'Asia/Kuwait'`;
const DAY = 86_400_000;

const JOURNEY_SQL = `
  SELECT j.id, j.ref, j.legal_entity_id, j.site_id, s.code AS site_code, s.name AS site_name, s.field, s.customer_id, cu.name AS customer_name, s.h2s_zone, s.checkin_min,
         s.worker_docs, s.asset_docs, j.purpose, j.from_place, j.depart_at, j.eta_at, j.end_at, j.passengers, j.cargo, j.hazmat, j.notes, j.task_id, j.attempts,
         j.approved_by, coalesce(ap.display_name, ap.email, ap.phone) AS approved_by_name, j.approved_at, j.inspected_at, j.departed_at, j.last_checkin_at, j.checkins, j.arrived_at,
         j.canceled_at, j.cancel_reason, j.created_by, j.created_at, j.version, t.status AS task_status, asg.worker_id AS driver_id, w.display_name AS driver_name, asg.asset_id, fa.plate_no,
         (SELECT e.reason_code FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed' ORDER BY e.occurred_at DESC LIMIT 1) AS fail_reason,
         (SELECT jsonb_build_object('passed', i.passed, 'failed_items', i.failed_items, 'at', i.occurred_at) FROM ops.og_inspection i WHERE i.journey_id = j.id ORDER BY i.occurred_at DESC LIMIT 1) AS inspection
    FROM ops.og_journey j JOIN ops.og_site s ON s.id = j.site_id LEFT JOIN crm.customer cu ON cu.id = s.customer_id
    LEFT JOIN org.app_user ap ON ap.id = j.approved_by
    LEFT JOIN ops.task t ON t.id = j.task_id
    LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id`;

type Row = Record<string, unknown> & { canceled_at: unknown; approved_at: unknown; departed_at: unknown; arrived_at: unknown; task_status: string | null };
function shape<T extends Row>(j: T) {
  const state = journeyState(j, j.task_status);
  const due = state === 'en_route' ? nextCheckinDue(new Date(j.departed_at as string), j.last_checkin_at ? new Date(j.last_checkin_at as string) : null, j.checkin_min as number) : null;
  return { ...j, state, checkin_due_at: due?.toISOString() ?? null };
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

/** The vehicle and driver are free again once the journey arrives. */
async function release(c: PoolClient, taskId: string, at: Date) {
  await c.query(`UPDATE ops.assignment SET period = tstzrange(lower(period), GREATEST(lower(period) + interval '1 minute', LEAST(upper(period), $2::timestamptz))) WHERE task_id = $1 AND active`,
    [taskId, at.toISOString()]);
}

const docsOf = async (c: PoolClient, col: 'worker_id' | 'asset_id', id: string) =>
  (await c.query(`SELECT doc_type, expires_on::text FROM core.document WHERE ${col} = $1 AND archived_at IS NULL`, [id])).rows as Doc[];

/**
 * The driver's stages. The inspection records the checklist (a failed one is kept and refused); departure needs the
 * journey approved; a call-in can repeat; the arrival frees the vehicle. Returns a reject code.
 */
export async function oilgasStage(c: PoolClient, a: AuthContext, taskId: string, code: Stage, x: { at: Date; checks: Record<string, unknown> | null; clientOpId: string }): Promise<string | null> {
  const j = (await c.query(`SELECT j.id, j.approved_at, s.h2s_zone FROM ops.og_journey j JOIN ops.og_site s ON s.id = j.site_id WHERE j.task_id = $1 FOR UPDATE OF j`, [taskId])).rows[0];
  if (!j) return 'not_supported';
  if (code === 'og_inspected') {
    if (!x.checks) return 'checks_required';
    const r = inspect(x.checks, j.h2s_zone);
    const checks = Object.fromEntries(r.items.map((k) => [k, x.checks![k] === true]));
    await c.query(`INSERT INTO ops.og_inspection (id, tenant_id, journey_id, task_id, checks, passed, failed_items, occurred_at, actor_id, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                   ON CONFLICT (tenant_id, client_op_id) DO NOTHING`,
      [randomUUID(), a.tenantId, j.id, taskId, JSON.stringify(checks), r.failed.length === 0, r.failed, x.at, a.userId, x.clientOpId]);
    if (r.failed.length) return 'inspection_failed'; // kept for the office; the driver fixes it or reports the vehicle
    await c.query('UPDATE ops.og_journey SET inspected_at = $2, version = version + 1 WHERE id = $1', [j.id, x.at]);
    return null;
  }
  if (code === 'og_departed') {
    if (!j.approved_at) return 'not_approved';
    await c.query('UPDATE ops.og_journey SET departed_at = $2, version = version + 1 WHERE id = $1', [j.id, x.at]);
    return null;
  }
  if (code === 'og_checkin') {
    await c.query('UPDATE ops.og_journey SET last_checkin_at = GREATEST(coalesce(last_checkin_at, $2), $2), checkins = checkins + 1, version = version + 1 WHERE id = $1', [j.id, x.at]);
    return null;
  }
  await c.query('UPDATE ops.og_journey SET arrived_at = $2, version = version + 1 WHERE id = $1', [j.id, x.at]);
  await release(c, taskId, x.at);
  return null;
}

function docTypes(val: unknown, field: string) {
  const l = parseDocTypes(val, field);
  const bad = l?.find((x) => !(DOC_TYPES as readonly string[]).includes(x));
  if (bad) throw new BadRequestException(`${field}: unknown document type ${bad}`);
  return l;
}

function parseSite(b: Record<string, unknown>, partial: boolean) {
  const code = v.str(b?.code, 'code', { required: !partial, max: 12 })?.toUpperCase() ?? null;
  if (code && !/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(code)) throw new BadRequestException('code must be A-Z, 0-9, _ or - (up to 12)');
  const lat = b?.lat === undefined || b?.lat === null ? null : Number(b.lat), lng = b?.lng === undefined || b?.lng === null ? null : Number(b.lng);
  if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng!) > 180))) throw new BadRequestException('lat and lng together');
  return {
    code, name: v.str(b?.name, 'name', { required: !partial, max: 120 }), field: v.str(b?.field, 'field', { max: 80 }), lat, lng,
    customer_id: v.uuid(b?.customer_id, 'customer_id'), worker_docs: docTypes(b?.worker_docs, 'worker_docs'), asset_docs: docTypes(b?.asset_docs, 'asset_docs'),
    h2s_zone: typeof b?.h2s_zone === 'boolean' ? b.h2s_zone : null, checkin_min: v.int(b?.checkin_min, 'checkin_min', 15, 240), notes: v.str(b?.notes, 'notes', { max: 500 }),
    active: typeof b?.active === 'boolean' ? b.active : null,
  };
}

@Controller('v1/oilgas')
@UseGuards(AuthGuard)
@Pack('oilgas')
export class OilgasController {
  constructor(private readonly db: DbService) {}

  // ---- sites ----

  @Get('sites')
  @Perm('tasks:read')
  sites(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`SELECT s.id, s.legal_entity_id, s.code, s.name, s.field, s.lat, s.lng, s.customer_id, cu.name AS customer_name, s.worker_docs, s.asset_docs, s.h2s_zone, s.checkin_min, s.notes, s.active
                             FROM ops.og_site s LEFT JOIN crm.customer cu ON cu.id = s.customer_id ORDER BY s.active DESC, s.code`)).rows,
    }));
  }

  /** A site: code, name, field, the operator, the documents drivers and vehicles must hold, H2S zone and the call-in interval. */
  @Post('sites')
  @Perm('tasks:assign')
  addSite(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const s = parseSite(b, false);
    return this.db.withTenant(a, async (c) => {
      await this.checkCustomer(c, s.customer_id, le);
      if ((await c.query('SELECT 1 FROM ops.og_site WHERE code = $1', [s.code])).rowCount) throw new ConflictException('a site with this code exists');
      const id = randomUUID();
      await c.query(`INSERT INTO ops.og_site (id, tenant_id, legal_entity_id, customer_id, code, name, field, lat, lng, worker_docs, asset_docs, h2s_zone, checkin_min, notes)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, a.tenantId, le, s.customer_id, s.code, s.name, s.field, s.lat, s.lng, s.worker_docs ?? [], s.asset_docs ?? [], s.h2s_zone ?? false, s.checkin_min ?? 60, s.notes]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'oilgas.site_added', targetType: 'og_site', targetId: id, after: s });
      return (await c.query('SELECT * FROM ops.og_site WHERE id = $1', [id])).rows[0];
    });
  }

  @Put('sites/:id')
  @Perm('tasks:assign')
  setSite(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const s = parseSite(b, true);
    return this.db.withTenant(a, async (c) => {
      const cur = (await c.query('SELECT legal_entity_id FROM ops.og_site WHERE id = $1', [id])).rows[0];
      if (!cur) throw new NotFoundException();
      await this.checkCustomer(c, s.customer_id, cur.legal_entity_id);
      await c.query(`UPDATE ops.og_site SET name = COALESCE($2, name), field = COALESCE($3, field), customer_id = COALESCE($4, customer_id), worker_docs = COALESCE($5, worker_docs),
                       asset_docs = COALESCE($6, asset_docs), h2s_zone = COALESCE($7, h2s_zone), checkin_min = COALESCE($8, checkin_min), notes = COALESCE($9, notes), active = COALESCE($10, active),
                       lat = COALESCE($11, lat), lng = COALESCE($12, lng) WHERE id = $1`,
        [id, s.name, s.field, s.customer_id, s.worker_docs, s.asset_docs, s.h2s_zone, s.checkin_min, s.notes, s.active, s.lat, s.lng]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'oilgas.site_set', targetType: 'og_site', targetId: id, after: s });
      return (await c.query('SELECT * FROM ops.og_site WHERE id = $1', [id])).rows[0];
    });
  }

  // ---- journeys ----

  @Get('journeys')
  @Perm('tasks:read')
  journeys(@Auth() a: AuthContext, @Query('date') date?: string, @Query('state') state?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${JOURNEY_SQL} WHERE (j.depart_at ${KW})::date = $1 ORDER BY j.depart_at`, [day])).rows.map(shape);
      return { date: day, data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** A journey plan: the site, the purpose, where from, departure, ETA and end, passengers and cargo (hazardous or not). */
  @Post('journeys')
  @Perm('tasks:assign')
  addJourney(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const site = v.uuid(b?.site_id, 'site_id', { required: true })!;
    const purpose = v.oneOf(b?.purpose, 'purpose', PURPOSES, { required: true })!;
    const from = v.str(b?.from_place, 'from_place', { required: true })!;
    const depart = v.ts(b?.depart_at, 'depart_at', { required: true })!, eta = v.ts(b?.eta_at, 'eta_at', { required: true })!;
    const end = v.ts(b?.end_at, 'end_at') ?? new Date(eta.getTime() + 4 * 3_600_000);
    if (eta <= depart) throw new BadRequestException('eta_at must be after depart_at');
    if (end < eta) throw new BadRequestException('end_at must not be before eta_at');
    if (end.getTime() - depart.getTime() > 3 * DAY) throw new BadRequestException('a journey is at most 3 days');
    if (depart.getTime() < Date.now() - 3_600_000) throw new BadRequestException('depart_at is in the past');
    const passengers = v.int(b?.passengers, 'passengers', 0, 60) ?? 0;
    const cargo = v.str(b?.cargo, 'cargo', { max: 300 });
    const hazmat = b?.hazmat === true;
    if (hazmat && !cargo) throw new BadRequestException('cargo required for a hazardous load');
    const notes = v.str(b?.notes, 'notes', { max: 500 });
    return this.db.withTenant(a, async (c) => {
      const s = (await c.query('SELECT legal_entity_id, active FROM ops.og_site WHERE id = $1', [site])).rows[0];
      if (!s) throw new BadRequestException('unknown site_id');
      if (!s.active) throw new ConflictException('the site is inactive');
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.og_journey`)).rows[0].n;
      const id = randomUUID(), ref = `JM-${n}`;
      await c.query(`INSERT INTO ops.og_journey (id, tenant_id, legal_entity_id, ref, site_id, purpose, from_place, depart_at, eta_at, end_at, passengers, cargo, hazmat, notes, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, a.tenantId, s.legal_entity_id, ref, site, purpose, from, depart.toISOString(), eta.toISOString(), end.toISOString(), passengers, cargo, hazmat, notes, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'oilgas.journey_added', targetType: 'og_journey', targetId: id, after: { ref, site, purpose, depart, eta, hazmat } });
      return this.journey(c, id);
    });
  }

  @Get('journeys/:id')
  @Perm('tasks:read')
  getJourney(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.journey(c, id));
  }

  /** The journey manager approves the plan; the driver cannot leave before. */
  @Post('journeys/:id/approve')
  @HttpCode(200)
  @Perm('tasks:assign')
  approve(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const j = await this.journey(c, id, true);
      if (j.approved_at) return j;
      if (['canceled', 'done', 'failed'].includes(j.state)) throw new ConflictException(`the journey is ${j.state}`);
      await c.query('UPDATE ops.og_journey SET approved_by = $2, approved_at = now(), version = version + 1 WHERE id = $1', [id, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'oilgas.approved', targetType: 'og_journey', targetId: id, after: { self: j.created_by === a.userId } });
      return this.journey(c, id);
    });
  }

  /** Drivers and vehicles free for the journey, each with the site's documents it lacks or that expire before the end. */
  @Get('journeys/:id/candidates')
  @Perm('tasks:read')
  candidates(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const j = await this.journey(c, id);
      const until = kwDate(j.end_at as Date);
      const need = this.workerDocs(j);
      const p = [j.legal_entity_id, new Date(j.depart_at as Date).toISOString(), new Date(j.end_at as Date).toISOString()];
      const busy = (col: string, ref: string) => `EXISTS (SELECT 1 FROM ops.assignment x WHERE x.active AND x.exclusive AND x.period && tstzrange($2, $3) AND x.${col} = ${ref})`;
      const docs = `(SELECT coalesce(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'expires_on', d.expires_on::text)), '[]') FROM core.document d WHERE d.%s = %s AND d.archived_at IS NULL)`;
      const drivers = (await c.query(`SELECT w.id, w.display_name, ${docs.replace('%s', 'worker_id').replace('%s', 'w.id')} AS docs FROM workforce.worker w
                                        WHERE w.legal_entity_id = $1 AND w.status = 'active' AND w.kind = 'driver' AND NOT ${busy('worker_id', 'w.id')} ORDER BY w.display_name`, p)).rows
        .map((w) => ({ id: w.id, display_name: w.display_name, missing: missingDocs(w.docs, need, until) }));
      const vehicles = (await c.query(`SELECT fa.id AS asset_id, fa.plate_no, fa.asset_type, fa.capacity, ${docs.replace('%s', 'asset_id').replace('%s', 'fa.id')} AS docs FROM fleet.asset fa
                                         WHERE fa.legal_entity_id = $1 AND fa.status NOT IN ('out_of_service','retired') AND NOT ${busy('asset_id', 'fa.id')} ORDER BY fa.plate_no`, p)).rows
        .map((x) => ({ asset_id: x.asset_id, plate_no: x.plate_no, asset_type: x.asset_type, seats: Number.isInteger(x.capacity?.seats) ? x.capacity.seats : null, missing: missingDocs(x.docs, j.asset_docs as string[], until) }));
      const rank = <T extends { missing: string[] }>(l: T[]) => l.sort((x, y) => x.missing.length - y.missing.length);
      return { worker_docs: need, asset_docs: j.asset_docs, until, drivers: rank(drivers), vehicles: rank(vehicles) };
    });
  }

  /** Books the vehicle and driver for the journey; refused with the documents missing or expiring before the end. */
  @Post('journeys/:id/assign')
  @Perm('tasks:assign')
  assign(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const driver = v.uuid(body?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const asset = v.uuid(body?.asset_id, 'asset_id', { required: true })!;
    return this.db.withTenant(a, async (c) => {
      const j = await this.journey(c, id, true);
      if (!['draft', 'approved', 'failed'].includes(j.state)) throw new ConflictException(`the journey is ${j.state}`);
      const veh = (await c.query(`SELECT capacity FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2 AND status NOT IN ('out_of_service','retired')`, [asset, j.legal_entity_id])).rows[0];
      if (!veh) throw new BadRequestException('unknown or unavailable asset_id');
      if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [driver, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown driver_worker_id');
      const seats = Number.isInteger(veh.capacity?.seats) ? veh.capacity.seats : null;
      if (seats !== null && (j.passengers as number) > seats) throw new ConflictException(`over_seats: the vehicle has ${seats} seats`);
      const until = kwDate(j.end_at as Date);
      const dMiss = missingDocs(await docsOf(c, 'worker_id', driver), this.workerDocs(j), until);
      if (dMiss.length) throw new ConflictException(`driver_docs: missing or expiring ${dMiss.join(', ')}`);
      const vMiss = missingDocs(await docsOf(c, 'asset_id', asset), j.asset_docs as string[], until);
      if (vMiss.length) throw new ConflictException(`vehicle_docs: missing or expiring ${vMiss.join(', ')}`);
      if (j.task_id) await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [j.task_id]);
      const n = (j.attempts as number) + 1;
      const from = new Date(j.depart_at as Date).toISOString(), to = new Date(j.end_at as Date).toISOString();
      const task = await createTask(c, a, {
        le: j.legal_entity_id as string, pack: OILGAS, branch: null, status: 'ready', customer: j.customer_id as string | null, site: null, ref: `${j.ref}-${n}`,
        win: { from, to },
        attrs: { kind: 'journey', journey_id: id, journey_ref: j.ref, site_code: j.site_code, site_name: j.site_name, field: j.field, address: `${j.site_name}${j.field ? `، ${j.field}` : ''}`,
          from_place: j.from_place, purpose: j.purpose, eta_at: j.eta_at, passengers: j.passengers, cargo: j.cargo, hazmat: j.hazmat, h2s_zone: j.h2s_zone, checkin_min: j.checkin_min,
          customer_name: j.customer_name, notes: j.notes },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, driver, asset, from, to, a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('driver_booked: the driver has another job then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the vehicle is booked then');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await event(c, a, task.id, 'ready', 'assigned', `${j.ref} ${j.site_code}`);
      await c.query('UPDATE ops.og_journey SET task_id = $2, attempts = $3, inspected_at = NULL, departed_at = NULL, last_checkin_at = NULL, checkins = 0, arrived_at = NULL, version = version + 1 WHERE id = $1',
        [id, task.id, n]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'oilgas.assigned', targetType: 'og_journey', targetId: id, after: { task: task.id, driver, asset, attempt: n } });
      return this.journey(c, id);
    });
  }

  /** The journey manager logs a call-in received by radio or phone. */
  @Post('journeys/:id/checkin')
  @HttpCode(200)
  @Perm('tasks:assign')
  checkin(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const note = v.str(body?.note, 'note', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      const j = await this.journey(c, id, true);
      if (j.state !== 'en_route') throw new ConflictException(`the journey is ${j.state}`);
      await c.query('UPDATE ops.og_journey SET last_checkin_at = now(), checkins = checkins + 1, version = version + 1 WHERE id = $1', [id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'oilgas.checkin', targetType: 'og_journey', targetId: id, after: { note } });
      return this.journey(c, id);
    });
  }

  @Post('journeys/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const reason = v.str(body?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const j = await this.journey(c, id, true);
      if (j.state === 'canceled') return j;
      if (['en_route', 'arrived', 'done'].includes(j.state)) throw new ConflictException(`the journey is ${j.state}`);
      if (j.task_id && ['assigned', 'ready'].includes(j.state)) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [j.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [j.task_id]);
        await event(c, a, j.task_id as string, j.task_status as string, 'canceled', `journey canceled: ${reason}`);
      }
      await c.query('UPDATE ops.og_journey SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'oilgas.canceled', targetType: 'og_journey', targetId: id, after: { reason } });
      return this.journey(c, id);
    });
  }

  // ---- watch and report ----

  /**
   * Journey management now: plans leaving within 2 hours not approved or without a vehicle, journeys en route with a missed
   * call-in or past their ETA, and failed vehicle inspections in the last day.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${JOURNEY_SQL} WHERE j.canceled_at IS NULL AND j.depart_at BETWEEN now() - interval '3 days' AND now() + interval '2 hours' ORDER BY j.depart_at`)).rows.map(shape);
      const now = Date.now();
      const failedChecks = (await c.query(
        `SELECT i.journey_id, j.ref, i.failed_items, i.occurred_at, fa.plate_no, w.display_name AS driver_name FROM ops.og_inspection i JOIN ops.og_journey j ON j.id = i.journey_id
           LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id FROM ops.assignment a WHERE a.task_id = i.task_id ORDER BY a.created_at DESC LIMIT 1) asg ON true
           LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id
          WHERE NOT i.passed AND i.occurred_at > now() - interval '1 day' ORDER BY i.occurred_at DESC`)).rows;
      return {
        not_approved: rows.filter((r) => !r.approved_at && ['draft', 'assigned'].includes(r.state)),
        unassigned: rows.filter((r) => ['draft', 'approved', 'failed'].includes(r.state)),
        overdue_checkin: rows.filter((r) => r.checkin_due_at && new Date(r.checkin_due_at).getTime() + CHECKIN_GRACE_MIN * 60_000 < now),
        overdue_arrival: rows.filter((r) => r.state === 'en_route' && new Date(r.eta_at as Date).getTime() + ARRIVAL_GRACE_MIN * 60_000 < now),
        failed_inspections: failedChecks,
      };
    });
  }

  /** For a period, per site: journeys, done, on time, late, failed and canceled, passengers, hazardous loads, call-ins. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${JOURNEY_SQL} WHERE (j.depart_at ${KW})::date BETWEEN $1 AND $2`, [f, t])).rows.map(shape);
      const sum = (l: typeof rows) => {
        const done = l.filter((r) => ['done', 'arrived'].includes(r.state));
        const onTime = done.filter((r) => r.arrived_at && new Date(r.arrived_at as string).getTime() <= new Date(r.eta_at as Date).getTime() + ARRIVAL_GRACE_MIN * 60_000);
        return { journeys: l.length, done: done.length, on_time: onTime.length, late: done.length - onTime.length, failed: l.filter((r) => r.state === 'failed').length,
          canceled: l.filter((r) => r.state === 'canceled').length, passengers: done.reduce((s, r) => s + (r.passengers as number), 0), hazmat: done.filter((r) => r.hazmat).length,
          checkins: done.reduce((s, r) => s + (r.checkins as number), 0) };
      };
      const bySite = new Map<string, typeof rows>();
      for (const r of rows) bySite.set(r.site_code as string, [...(bySite.get(r.site_code as string) ?? []), r]);
      return {
        from: f, to: t, totals: sum(rows),
        sites: [...bySite.entries()].map(([code, l]) => ({ site_code: code, site_name: l[0].site_name, customer_name: l.find((r) => r.customer_name)?.customer_name ?? null, ...sum(l) }))
          .sort((x, y) => y.journeys - x.journeys),
      };
    });
  }

  private workerDocs(j: { worker_docs: unknown; hazmat: unknown }) {
    const need = [...(j.worker_docs as string[])];
    if (j.hazmat && !need.includes(HAZMAT_DOC)) need.push(HAZMAT_DOC);
    return need;
  }

  private async checkCustomer(c: PoolClient, customer: string | null, le: string) {
    if (!customer) return;
    const cu = (await c.query('SELECT legal_entity_id FROM crm.customer WHERE id = $1', [customer])).rows[0];
    if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
  }

  private async journey(c: PoolClient, id: string, lock = false) {
    const j = (await c.query(`${JOURNEY_SQL} WHERE j.id = $1${lock ? ' FOR UPDATE OF j' : ''}`, [id])).rows[0];
    if (!j) throw new NotFoundException();
    return shape(j);
  }
}
