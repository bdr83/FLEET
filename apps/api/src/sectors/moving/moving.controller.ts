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
import { BOOK_DUE_DAYS, CLAIM_DAYS, HOME_SIZES, MOVING, moveState, parseItems, PLAN_BY_SIZE, QUOTE_DUE_HOURS, SERVICES, Stage } from './moving';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const KW = `AT TIME ZONE 'Asia/Kuwait'`;

const JOB_SQL = `
  SELECT j.id, j.ref, j.legal_entity_id, j.customer_id, cu.name AS customer_name, cu.phone AS customer_phone, j.from_site, j.to_site, j.home_size, j.services,
         j.move_at, j.hours, j.crew_size, j.notes, j.survey_at, j.surveyed_at, j.volume_m3::float AS volume_m3, j.quote_amount::text, j.quoted_at,
         j.deposit_amount::text, j.deposit_paid_at, j.accepted_at, j.loaded_at, j.unloaded_at, j.received_by, j.delivery_note, j.extra_amount::text,
         (COALESCE(j.quote_amount, 0) + COALESCE(j.extra_amount, 0))::text AS total, j.rating, j.rating_note,
         j.closed_at, j.canceled_at, j.cancel_reason, j.created_at, j.version,
         lt.task_id AS lead_task_id, lt.status AS lead_status
    FROM ops.move_job j JOIN crm.customer cu ON cu.id = j.customer_id
    LEFT JOIN LATERAL (SELECT m.task_id, t.status FROM ops.move_task m JOIN ops.task t ON t.id = m.task_id
                        WHERE m.job_id = j.id AND m.role = 'lead' ORDER BY t.created_at DESC LIMIT 1) lt ON true`;

const CREW_SQL = `
  SELECT m.task_id, m.job_id, m.role, t.ref, t.status, lower(t.service_window) AS starts_at, upper(t.service_window) AS ends_at,
         asg.worker_id, w.display_name AS worker_name, asg.asset_id, fa.plate_no
    FROM ops.move_task m JOIN ops.task t ON t.id = m.task_id
    LEFT JOIN LATERAL (SELECT a.worker_id, a.asset_id FROM ops.assignment a WHERE a.task_id = t.id ORDER BY a.active DESC, a.created_at DESC LIMIT 1) asg ON true
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset fa ON fa.id = asg.asset_id`;

const siteLine = (s: Record<string, unknown>) =>
  [s.name, s.area, s.block ? `ق ${s.block}` : null, s.street, s.house ? `منزل ${s.house}` : null, s.floor ? `الدور ${s.floor}` : null, s.apartment ? `شقة ${s.apartment}` : null].filter((x) => typeof x === 'string' && x).join('، ') || null;

function parseSite(val: unknown, field: string) {
  const raw = v.obj(val, field) ?? (() => { throw new BadRequestException(`${field} required`); })();
  const { lift, ...rest } = raw;
  if (typeof rest.floor === 'number') rest.floor = String(rest.floor);
  const site = normalizeAttributes({ dropoff: rest })!.dropoff as Record<string, unknown>;
  if (!site.area && !site.name) throw new BadRequestException(`${field} needs an area or a name`);
  if (lift !== undefined) site.lift = lift === true;
  return site;
}

function parseServices(val: unknown): string[] {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val) || val.some((x) => !(SERVICES as readonly string[]).includes(x as string))) throw new BadRequestException(`services must be a list of ${SERVICES.join(', ')}`);
  return SERVICES.filter((s) => val.includes(s));
}

async function event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
    [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
}

/**
 * The end of loading and of unloading from the driver's app. Unloading needs the receiver's name. Returns a reject code
 * instead of throwing so the driver's sync reports it per op.
 */
export async function movingStage(c: PoolClient, taskId: string, code: Stage, x: { at: Date; receivedBy: string | null; note: string | null }): Promise<string | null> {
  const m = (await c.query(`SELECT job_id FROM ops.move_task WHERE task_id = $1 AND role = 'lead'`, [taskId])).rows[0];
  if (!m) return 'not_supported';
  if (code === 'loaded') {
    await c.query('UPDATE ops.move_job SET loaded_at = COALESCE(loaded_at, $2) WHERE id = $1', [m.job_id, x.at.toISOString()]);
    return null;
  }
  if (!x.receivedBy) return 'receiver_required';
  await c.query('UPDATE ops.move_job SET unloaded_at = $2, received_by = $3, delivery_note = $4, version = version + 1 WHERE id = $1', [m.job_id, x.at.toISOString(), x.receivedBy, x.note]);
  return null;
}

@Controller('v1/moving')
@UseGuards(AuthGuard)
@Pack('moving')
export class MovingController {
  constructor(private readonly db: DbService) {}

  @Get('jobs')
  @Perm('tasks:read')
  jobs(@Auth() a: AuthContext, @Query('state') state?: string, @Query('customer_id') customer?: string) {
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${JOB_SQL} WHERE ($1::uuid IS NULL OR j.customer_id = $1) ORDER BY j.move_at DESC LIMIT 500`, [cu])).rows.map(withState);
      return { data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** A move request: from and to, the home size, the services and the date. Hours and crew default from the size. */
  @Post('jobs')
  @Perm('tasks:assign')
  addJob(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const from = parseSite(b?.from_site, 'from_site');
    const to = parseSite(b?.to_site, 'to_site');
    const size = v.oneOf(b?.home_size, 'home_size', HOME_SIZES, { required: true })!;
    const services = parseServices(b?.services);
    const moveAt = v.ts(b?.move_at, 'move_at', { required: true })!;
    const hours = v.int(b?.hours, 'hours', 1, 24) ?? PLAN_BY_SIZE[size].hours;
    const crew = v.int(b?.crew_size, 'crew_size', 0, 20) ?? PLAN_BY_SIZE[size].crew;
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    const survey = v.ts(b?.survey_at, 'survey_at');
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [customer])).rows[0];
      if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
      if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.move_job`)).rows[0].n;
      const id = randomUUID(), ref = `MV-${n}`;
      await c.query(`INSERT INTO ops.move_job (id, tenant_id, legal_entity_id, ref, customer_id, from_site, to_site, home_size, services, move_at, hours, crew_size, notes, survey_at, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, a.tenantId, le, ref, customer, JSON.stringify(from), JSON.stringify(to), size, services, moveAt.toISOString(), hours, crew, notes, survey?.toISOString() ?? null, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.job_opened', targetType: 'move_job', targetId: id, after: { ref, customer, size, services, move_at: moveAt.toISOString() } });
      return this.job(c, id);
    });
  }

  @Get('jobs/:id')
  @Perm('tasks:read')
  getJob(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.job(c, id));
  }

  /** The survey: the volume and the item list (replaces the list). Allowed until the move starts. */
  @Post('jobs/:id/survey')
  @HttpCode(200)
  @Perm('tasks:assign')
  survey(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const vol = b?.volume_m3 === undefined || b?.volume_m3 === null ? null : Number(b.volume_m3);
    if (vol !== null && (!Number.isFinite(vol) || vol <= 0 || vol > 500 || Math.round(vol * 10) !== vol * 10)) throw new BadRequestException('volume_m3 must be more than 0, one decimal, up to 500');
    const items = b?.items === undefined ? null : parseItems(b.items);
    const at = v.ts(b?.surveyed_at, 'surveyed_at') ?? new Date();
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (!['new', 'quoted', 'accepted', 'booked'].includes(j.state)) throw new ConflictException(`the move is ${j.state}`);
      await c.query('UPDATE ops.move_job SET surveyed_at = $2, volume_m3 = COALESCE($3, volume_m3), version = version + 1 WHERE id = $1', [id, at.toISOString(), vol]);
      if (items) {
        await c.query('DELETE FROM ops.move_item WHERE job_id = $1', [id]);
        for (const it of items) await c.query('INSERT INTO ops.move_item (id, tenant_id, job_id, room, name, qty, fragile) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), a.tenantId, id, it.room, it.name, it.qty, it.fragile]);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.surveyed', targetType: 'move_job', targetId: id, after: { volume_m3: vol, items: items?.length ?? null } });
      return this.job(c, id);
    });
  }

  /** The office's price for the move and the deposit it asks for. A new quote replaces the old one until accepted. */
  @Post('jobs/:id/quote')
  @HttpCode(200)
  @Perm('tasks:assign')
  quote(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const amount = v.money(b?.quote_amount, 'quote_amount', { required: true })!;
    const deposit = v.money(b?.deposit_amount, 'deposit_amount');
    if (deposit && Number(deposit) > Number(amount)) throw new BadRequestException('deposit_amount is more than quote_amount');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (!['new', 'quoted'].includes(j.state)) throw new ConflictException(`the move is ${j.state}`);
      await c.query('UPDATE ops.move_job SET quote_amount = $2, deposit_amount = $3, quoted_at = now(), version = version + 1 WHERE id = $1', [id, amount, deposit]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.quoted', targetType: 'move_job', targetId: id, after: { amount, deposit } });
      return this.job(c, id);
    });
  }

  /** The customer accepted the quote; the deposit is marked paid when the office received it (recorded, not held). */
  @Post('jobs/:id/accept')
  @HttpCode(200)
  @Perm('tasks:assign')
  accept(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const paid = b?.deposit_paid === true;
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state === 'new') throw new ConflictException('no quote yet');
      if (['canceled', 'closed'].includes(j.state)) throw new ConflictException(`the move is ${j.state}`);
      await c.query(`UPDATE ops.move_job SET accepted_at = COALESCE(accepted_at, now()), deposit_paid_at = CASE WHEN $2 THEN COALESCE(deposit_paid_at, now()) ELSE deposit_paid_at END,
                     version = version + 1 WHERE id = $1`, [id, paid]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.accepted', targetType: 'move_job', targetId: id, after: { deposit_paid: paid } });
      return this.job(c, id);
    });
  }

  /** Books the truck with its driver on the main task, and each helper on a crew task for the same window. */
  @Post('jobs/:id/book')
  @Perm('tasks:assign')
  book(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const driver = v.uuid(b?.driver_worker_id, 'driver_worker_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const helpers = b?.helper_worker_ids === undefined ? [] : b.helper_worker_ids;
    if (!Array.isArray(helpers) || helpers.length > 20) throw new BadRequestException('helper_worker_ids must be a list of up to 20');
    const hs = helpers.map((h, i) => v.uuid(h, `helper_worker_ids[${i}]`, { required: true })!);
    if (new Set([driver, ...hs]).size !== hs.length + 1) throw new BadRequestException('a worker is listed twice');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state !== 'accepted') throw new ConflictException(j.state === 'booked' || j.state === 'moving' ? 'the move is already booked' : `the move is ${j.state}: accept the quote first`);
      const from = v.ts(b?.starts_at, 'starts_at') ?? new Date(j.move_at);
      const end = new Date(from.getTime() + (v.int(b?.hours, 'hours', 1, 24) ?? j.hours) * 3_600_000);
      for (const w of [driver, ...hs]) {
        if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [w, j.legal_entity_id])).rowCount) throw new BadRequestException(`unknown worker ${w}`);
      }
      if (!(await c.query(`SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2 AND status NOT IN ('out_of_service','retired')`, [asset, j.legal_entity_id])).rowCount) throw new BadRequestException('unknown asset_id');
      // helpers left from an earlier booking whose truck failed are released before the new booking
      for (const t of j.crew.filter((x: { status: string }) => ['ready', 'assigned', 'accepted'].includes(x.status))) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [t.task_id]);
        await event(c, a, t.task_id, t.status, 'canceled', `rebooked ${j.ref}`);
      }
      const n = (await c.query(`SELECT count(*)::int AS n FROM ops.move_task WHERE job_id = $1 AND role = 'lead'`, [id])).rows[0].n + 1;
      const base = { kind: 'move', move_id: id, move_ref: j.ref, home_size: j.home_size, services: j.services, volume_m3: j.volume_m3, items_count: j.items.reduce((s: number, x: { qty: number }) => s + x.qty, 0),
        fragile: j.items.filter((x: { fragile: boolean }) => x.fragile).map((x: { name: string }) => x.name).slice(0, 20),
        pickup: j.from_site, dropoff: j.to_site, pickup_address: siteLine(j.from_site), address: siteLine(j.to_site), customer_name: j.customer_name,
        contact_phone: j.from_site.phone ?? j.customer_phone, notes: j.notes, crew: hs.length };
      const plan: { role: 'lead' | 'helper'; worker: string; asset: string | null; ref: string; attrs: Record<string, unknown> }[] = [
        { role: 'lead', worker: driver, asset, ref: `${j.ref}-${n}`, attrs: base },
        ...hs.map((w, i) => ({ role: 'helper' as const, worker: w, asset: null, ref: `${j.ref}-${n}-H${i + 1}`,
          attrs: { kind: 'crew', move_id: id, move_ref: j.ref, pickup: j.from_site, dropoff: j.to_site, pickup_address: siteLine(j.from_site), address: siteLine(j.to_site), customer_name: j.customer_name } })),
      ];
      await c.query('SAVEPOINT book');
      try {
        for (const p of plan) {
          const task = await createTask(c, a, { le: j.legal_entity_id, pack: MOVING, branch: null, status: 'ready', customer: j.customer_id, site: null, ref: p.ref,
            win: { from: from.toISOString(), to: end.toISOString() }, attrs: p.attrs });
          await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
            [randomUUID(), a.tenantId, task.id, p.worker, p.asset, from.toISOString(), end.toISOString(), a.userId]);
          await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
          await event(c, a, task.id, 'ready', 'assigned', `${p.role === 'lead' ? 'truck and driver' : 'helper'} for ${j.ref}`);
          await c.query('INSERT INTO ops.move_task (task_id, tenant_id, job_id, role) VALUES ($1,$2,$3,$4)', [task.id, a.tenantId, id, p.role]);
        }
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT book');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_worker_overlap') throw new ConflictException('worker_booked: a worker has another booking then');
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle_booked: the truck is booked then');
        throw e;
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.booked', targetType: 'move_job', targetId: id, after: { driver, asset, helpers: hs, from: from.toISOString(), to: end.toISOString() } });
      return this.job(c, id);
    });
  }

  /** Closes a delivered move: extra charges on the day (extra hours, floors, materials) and the customer's rating. */
  @Post('jobs/:id/close')
  @HttpCode(200)
  @Perm('tasks:assign')
  close(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const extra = v.money(b?.extra_amount, 'extra_amount');
    const rating = v.int(b?.rating, 'rating', 1, 5);
    const note = v.str(b?.rating_note, 'rating_note', { max: 500 });
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state !== 'delivered') throw new ConflictException(j.state === 'closed' ? 'the move is closed' : 'the move is not delivered yet');
      for (const t of j.crew.filter((x: { status: string }) => ['assigned', 'accepted', 'in_progress'].includes(x.status))) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t.task_id]);
        await c.query(`UPDATE ops.task SET status = 'completed', version = version + 1, updated_at = now() WHERE id = $1`, [t.task_id]);
        await event(c, a, t.task_id, t.status, 'completed', `move ${j.ref} closed`);
      }
      await c.query('UPDATE ops.move_job SET extra_amount = $2, rating = $3, rating_note = $4, closed_at = now(), closed_by = $5, version = version + 1 WHERE id = $1', [id, extra, rating, note, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.closed', targetType: 'move_job', targetId: id, after: { extra, rating } });
      return this.job(c, id);
    });
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id, true);
      if (j.state === 'canceled') return j;
      if (['moving', 'delivered', 'closed'].includes(j.state)) throw new ConflictException(`the move is ${j.state}`);
      for (const t of j.crew.filter((x: { status: string }) => ['ready', 'assigned', 'accepted'].includes(x.status))) {
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t.task_id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [t.task_id]);
        await event(c, a, t.task_id, t.status, 'canceled', `move canceled: ${reason}`);
      }
      await c.query('UPDATE ops.move_job SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.canceled', targetType: 'move_job', targetId: id, after: { reason } });
      return this.job(c, id);
    });
  }

  // ---- claims ----

  /** A damage claim from the customer, within the claim period after unloading. */
  @Post('jobs/:id/claims')
  @Perm('tasks:assign')
  addClaim(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const item = v.str(b?.item, 'item', { required: true, max: 120 })!;
    const desc = v.str(b?.description, 'description', { required: true, max: 1000 })!;
    const amount = v.money(b?.claimed_amount, 'claimed_amount');
    return this.db.withTenant(a, async (c) => {
      const j = await this.job(c, id);
      if (!['delivered', 'closed'].includes(j.state)) throw new ConflictException('the move is not delivered');
      const done = Date.parse(j.unloaded_at ?? j.closed_at);
      if (Date.now() - done > CLAIM_DAYS * 86_400_000) throw new ConflictException(`claim_period_over: claims are taken within ${CLAIM_DAYS} days`);
      const cid = randomUUID();
      await c.query('INSERT INTO ops.move_claim (id, tenant_id, job_id, item, description, claimed_amount, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [cid, a.tenantId, id, item, desc, amount, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.claim_opened', targetType: 'move_job', targetId: id, after: { claim: cid, item, amount } });
      return this.job(c, id);
    });
  }

  /** Settles a claim with the amount agreed, or rejects it with the reason. */
  @Post('claims/:id/decide')
  @HttpCode(200)
  @Perm('tasks:assign')
  decide(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const status = v.oneOf(b?.status, 'status', ['settled', 'rejected'] as const, { required: true })!;
    const amount = status === 'settled' ? v.money(b?.settled_amount, 'settled_amount', { required: true }) : null;
    const note = v.str(b?.note, 'note', { max: 500 });
    if (status === 'rejected' && !note) throw new BadRequestException('note required to reject');
    return this.db.withTenant(a, async (c) => {
      const k = (await c.query('SELECT job_id, status FROM ops.move_claim WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!k) throw new NotFoundException();
      if (k.status !== 'open') throw new ConflictException(`the claim is ${k.status}`);
      await c.query('UPDATE ops.move_claim SET status = $2, settled_amount = $3, decision_note = $4, decided_at = now(), decided_by = $5 WHERE id = $1', [id, status, amount, note, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'moving.claim_decided', targetType: 'move_job', targetId: k.job_id, after: { claim: id, status, amount } });
      return this.job(c, k.job_id);
    });
  }

  // ---- the day, watch and report ----

  /** A day's moves with their truck and crew, and the accepted moves of the day still without a crew. */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const jobs = (await c.query(`${JOB_SQL} WHERE (j.move_at ${KW})::date = $1 AND j.canceled_at IS NULL ORDER BY j.move_at`, [day])).rows.map(withState);
      const crew = jobs.length ? (await c.query(`${CREW_SQL} WHERE m.job_id = ANY ($1::uuid[]) AND t.status <> 'canceled' ORDER BY t.ref`, [jobs.map((j) => j.id)])).rows : [];
      return { date: day, moves: jobs.map((j) => ({ ...j, crew: crew.filter((x) => x.job_id === j.id) })) };
    });
  }

  /** Requests without a quote, quotes without an answer, accepted moves near their date without a crew, unpaid deposits, moves to close, open claims. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const open = (await c.query(`${JOB_SQL} WHERE j.closed_at IS NULL AND j.canceled_at IS NULL ORDER BY j.move_at`)).rows.map(withState);
      const now = Date.now();
      return {
        to_quote: open.filter((j) => j.state === 'new' && now - Date.parse(j.created_at) > QUOTE_DUE_HOURS * 3_600_000),
        awaiting_answer: open.filter((j) => j.state === 'quoted'),
        to_book: open.filter((j) => j.state === 'accepted' && Date.parse(j.move_at) - now < BOOK_DUE_DAYS * 86_400_000),
        deposit_unpaid: open.filter((j) => ['accepted', 'booked'].includes(j.state) && j.deposit_amount && Number(j.deposit_amount) > 0 && !j.deposit_paid_at),
        to_close: open.filter((j) => j.state === 'delivered'),
        claims: (await c.query(`SELECT k.id, k.job_id, j.ref, cu.name AS customer_name, k.item, k.description, k.claimed_amount::text, k.created_at
                                  FROM ops.move_claim k JOIN ops.move_job j ON j.id = k.job_id JOIN crm.customer cu ON cu.id = j.customer_id
                                 WHERE k.status = 'open' ORDER BY k.created_at`)).rows,
      };
    });
  }

  /** For a period of move dates: requests, quoted, accepted, moved, revenue, the rating and the claims. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const jobs = (await c.query(`${JOB_SQL} WHERE (j.move_at ${KW})::date BETWEEN $1 AND $2`, [f, t])).rows.map(withState);
      const claims = (await c.query(`SELECT k.status, k.claimed_amount::text, k.settled_amount::text FROM ops.move_claim k WHERE k.job_id = ANY ($1::uuid[])`, [jobs.map((j) => j.id)])).rows;
      const fils = (s: string | null) => Math.round(Number(s ?? 0) * 1000);
      const kwd = (n: number) => (n / 1000).toFixed(3);
      const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
      const quoted = jobs.filter((j) => j.quoted_at), accepted = jobs.filter((j) => j.accepted_at), closed = jobs.filter((j) => j.closed_at);
      const rated = closed.filter((j) => j.rating);
      const sizes = new Map<string, number>();
      for (const j of accepted) sizes.set(j.home_size, (sizes.get(j.home_size) ?? 0) + 1);
      return {
        from: f, to: t,
        totals: {
          requests: jobs.length, quoted: quoted.length, accepted: accepted.length, canceled: jobs.filter((j) => j.canceled_at).length,
          delivered: jobs.filter((j) => ['delivered', 'closed'].includes(j.state)).length, closed: closed.length,
          acceptance_pct: pct(accepted.length, quoted.length),
          revenue: kwd(closed.reduce((s, j) => s + fils(j.quote_amount) + fils(j.extra_amount), 0)),
          avg_rating: rated.length ? Math.round((rated.reduce((s, j) => s + j.rating, 0) / rated.length) * 10) / 10 : null,
          claims: claims.length, claims_open: claims.filter((k) => k.status === 'open').length,
          claims_settled: kwd(claims.reduce((s, k) => s + fils(k.settled_amount), 0)),
        },
        sizes: [...sizes.entries()].map(([home_size, n]) => ({ home_size, moves: n })).sort((x, y) => y.moves - x.moves),
      };
    });
  }

  private async job(c: PoolClient, id: string, lock = false) {
    const j = (await c.query(`${JOB_SQL} WHERE j.id = $1${lock ? ' FOR UPDATE OF j' : ''}`, [id])).rows[0];
    if (!j) throw new NotFoundException();
    const items = (await c.query('SELECT id, room, name, qty, fragile FROM ops.move_item WHERE job_id = $1 ORDER BY room NULLS LAST, created_at', [id])).rows;
    const crew = (await c.query(`${CREW_SQL} WHERE m.job_id = $1 ORDER BY t.ref`, [id])).rows;
    const claims = (await c.query(`SELECT id, item, description, claimed_amount::text, status, settled_amount::text, decision_note, decided_at, created_at FROM ops.move_claim WHERE job_id = $1 ORDER BY created_at`, [id])).rows;
    return { ...withState(j), items, crew, claims };
  }
}

function withState<T extends { canceled_at: unknown; closed_at: unknown; quoted_at: unknown; accepted_at: unknown; unloaded_at: unknown; lead_status: string | null }>(j: T) {
  return { ...j, state: moveState(j, j.lead_status ? { status: j.lead_status } : null) };
}
