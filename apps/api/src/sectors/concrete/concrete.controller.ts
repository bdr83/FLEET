import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm, Pack } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { ageMinutes, CONCRETE, ConcreteSettings, m3, normalizeSite, planLoads, SETTINGS_COLS, settingsOf, Site, siteLine } from './concrete';

/** Load statuses that can still be changed or canceled by the office (the driver has not batched yet). */
const UNSTARTED = ['ready', 'assigned', 'accepted'];
const DONE = ['completed', 'reviewed', 'invoiced'];

const POUR_COLS = `p.id, p.ref, p.legal_entity_id, p.customer_id, cu.name AS customer_name, p.site_id, p.site, p.mix_code, p.volume_m3::float,
  p.pour_rate_m3h::float, p.pump_required, p.pump_asset_id, pa.plate_no AS pump_plate, p.scheduled_at, p.site_ready, p.notes,
  p.canceled_at, p.cancel_reason, p.version, p.created_at,
  CASE WHEN p.canceled_at IS NOT NULL THEN 'canceled'
       WHEN EXISTS (SELECT 1 FROM ops.load_ticket l JOIN ops.task t ON t.id = l.task_id WHERE l.pour_order_id = p.id AND t.status IN ('completed','reviewed','invoiced'))
        AND NOT EXISTS (SELECT 1 FROM ops.load_ticket l JOIN ops.task t ON t.id = l.task_id WHERE l.pour_order_id = p.id AND t.status NOT IN ('completed','reviewed','invoiced','canceled','failed'))
         THEN 'completed'
       WHEN EXISTS (SELECT 1 FROM ops.load_ticket l JOIN ops.task t ON t.id = l.task_id WHERE l.pour_order_id = p.id AND (t.status IN ('in_progress','completed','reviewed','invoiced','failed') OR l.batched_at IS NOT NULL))
         THEN 'in_progress'
       ELSE 'scheduled' END AS state`;
const POUR_FROM = `ops.pour_order p LEFT JOIN crm.customer cu ON cu.id = p.customer_id LEFT JOIN fleet.asset pa ON pa.id = p.pump_asset_id`;

/** One row per load with its task, driver, mixer and the stage times read from the driver's milestones. */
const LOAD_SQL = `
  SELECT l.task_id, l.pour_order_id, l.seq, l.ticket_no, l.volume_m3::float, l.planned_arrival, l.batched_at, l.poured_m3::float, l.returned_m3::float,
         l.signed_by, l.signed_at, l.file_key, l.wait_minutes, t.status, t.version, t.ref,
         lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
         asg.worker_id, w.display_name AS worker_name, asg.asset_id, a.plate_no,
         ms.at_site, ms.pour_start, ms.pour_end,
         (SELECT m.code FROM ops.task_milestone m WHERE m.task_id = t.id ORDER BY m.occurred_at DESC LIMIT 1) AS stage
    FROM ops.load_ticket l JOIN ops.task t ON t.id = l.task_id
    LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id
    LEFT JOIN fleet.asset a ON a.id = asg.asset_id
    LEFT JOIN LATERAL (
      SELECT min(m.occurred_at) FILTER (WHERE m.code = 'at_site') AS at_site, min(m.occurred_at) FILTER (WHERE m.code = 'pour_start') AS pour_start,
             min(m.occurred_at) FILTER (WHERE m.code = 'pour_end') AS pour_end
        FROM ops.task_milestone m WHERE m.task_id = t.id) ms ON true`;

function flag(val: unknown, field: string): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new BadRequestException(`${field} must be true/false`);
  return val;
}
const version = (b: Record<string, unknown>) => v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();

/**
 * Office side of the ready-mix pack: plant settings, pour orders and their loads, the mixers board, exceptions and the
 * waiting-time report. The driver side (stages and the signed ticket) is in /v1/driver/sync.
 */
@Controller('v1/concrete')
@UseGuards(AuthGuard)
@Pack('concrete')
export class ConcreteController {
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
    const patch: Partial<ConcreteSettings> = {
      truck_capacity_m3: m3(b.truck_capacity_m3, 'truck_capacity_m3', { max: 20 }) ?? undefined,
      max_age_minutes: v.int(b.max_age_minutes, 'max_age_minutes', 15, 360) ?? undefined,
      age_warn_minutes: v.int(b.age_warn_minutes, 'age_warn_minutes', 5, 360) ?? undefined,
      free_wait_minutes: v.int(b.free_wait_minutes, 'free_wait_minutes', 0, 240) ?? undefined,
      lead_minutes: v.int(b.lead_minutes, 'lead_minutes', 5, 240) ?? undefined,
      cycle_minutes: v.int(b.cycle_minutes, 'cycle_minutes', 20, 600) ?? undefined,
    };
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const before = await settingsOf(c, le);
      const s = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)) } as ConcreteSettings;
      if (s.age_warn_minutes >= s.max_age_minutes) throw new BadRequestException('age_warn_minutes must be less than max_age_minutes');
      const row = (await c.query(
        `INSERT INTO ops.concrete_settings (tenant_id, legal_entity_id, truck_capacity_m3, max_age_minutes, age_warn_minutes, free_wait_minutes, lead_minutes, cycle_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET truck_capacity_m3 = EXCLUDED.truck_capacity_m3, max_age_minutes = EXCLUDED.max_age_minutes,
           age_warn_minutes = EXCLUDED.age_warn_minutes, free_wait_minutes = EXCLUDED.free_wait_minutes, lead_minutes = EXCLUDED.lead_minutes,
           cycle_minutes = EXCLUDED.cycle_minutes, updated_at = now()
         RETURNING ${SETTINGS_COLS}`,
        [a.tenantId, le, s.truck_capacity_m3, s.max_age_minutes, s.age_warn_minutes, s.free_wait_minutes, s.lead_minutes, s.cycle_minutes])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'concrete.settings_changed', targetType: 'legal_entity', targetId: le, before, after: row });
      return { legal_entity_id: le, ...row };
    });
  }

  /** Pours scheduled in a period (default: today and tomorrow), with load counts and delivered volumes. */
  @Get('pours')
  @Perm('tasks:read')
  list(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.ts(from, 'from') ?? new Date(new Date().setHours(0, 0, 0, 0));
    const t = v.ts(to, 'to') ?? new Date(f.getTime() + 2 * 86_400_000);
    if (t <= f || t.getTime() - f.getTime() > 31 * 86_400_000) throw new BadRequestException('period must be up to 31 days');
    return this.db.withTenant(a, async (c) => {
      const pours = (await c.query(
        `SELECT ${POUR_COLS} FROM ${POUR_FROM} WHERE p.scheduled_at >= $1 AND p.scheduled_at < $2 ORDER BY p.scheduled_at LIMIT 300`, [f, t])).rows;
      const loads = pours.length ? (await c.query(`${LOAD_SQL} WHERE l.pour_order_id = ANY($1::uuid[]) ORDER BY l.seq`, [pours.map((p) => p.id)])).rows : [];
      return { from: f, to: t, data: pours.map((p) => summarize(p, loads.filter((l) => l.pour_order_id === p.id))) };
    });
  }

  /** A pour order and its loads, with the plan (spacing, trucks needed) and totals. */
  @Get('pours/:id')
  @Perm('tasks:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.withTenant(a, (c) => this.pour(c, id));
    if (!r) throw new NotFoundException();
    return r;
  }

  /**
   * New pour order: splits it into loads for a continuous pour and creates one task per load, ready to assign to a mixer.
   * Sending the same ref again returns the existing order (safe to retry).
   */
  @Post('pours')
  @Perm('tasks:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const ref = v.str(b?.ref, 'ref', { required: true, max: 40 })!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(ref)) throw new BadRequestException('ref: letters, digits, - and _ only');
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const siteId = v.uuid(b?.site_id, 'site_id');
    let site = normalizeSite(b?.site);
    const mix = v.str(b?.mix_code, 'mix_code', { required: true, max: 40 })!;
    const volume = m3(b?.volume_m3, 'volume_m3', { required: true })!;
    const rate = m3(b?.pour_rate_m3h, 'pour_rate_m3h', { required: true, max: 300 })!;
    const pump = flag(b?.pump_required, 'pump_required') ?? false;
    const pumpAsset = v.uuid(b?.pump_asset_id, 'pump_asset_id');
    const at = v.ts(b?.scheduled_at, 'scheduled_at', { required: true })!;
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    if (at.getTime() < Date.now() - 86_400_000) throw new BadRequestException('scheduled_at is in the past');
    return this.db.withTenant(a, async (c) => {
      const prior = (await c.query('SELECT id FROM ops.pour_order WHERE ref = $1', [ref])).rows[0];
      if (prior) return this.pour(c, prior.id);
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      if (siteId) {
        // a saved customer site: its pinned location and contact fill what the order did not give
        const s = (await c.query(
          `SELECT name, address, contact_name, contact_phone, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM crm.site WHERE id = $1 AND customer_id = $2`,
          [siteId, customer])).rows[0];
        if (!s) throw new BadRequestException('unknown site_id for this customer');
        site = { name: s.name, ...(s.address ? { notes: s.address } : {}), ...(s.contact_name ? { contact_name: s.contact_name } : {}),
          ...(s.contact_phone ? { contact_phone: s.contact_phone } : {}), ...(s.lat !== null ? { lat: s.lat, lng: s.lng } : {}), ...site };
      }
      if (pumpAsset) await this.checkPump(c, pumpAsset, le);
      const s = await settingsOf(c, le);
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO ops.pour_order (id, tenant_id, legal_entity_id, ref, customer_id, site_id, site, mix_code, volume_m3, pour_rate_m3h, pump_required, pump_asset_id, scheduled_at, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [id, a.tenantId, le, ref, customer, siteId, JSON.stringify(site), mix, volume, rate, pump || !!pumpAsset, pumpAsset, at, notes, a.userId]);
      } catch (e) { return pgToHttp(e); }
      const plan = planLoads({ volume_m3: volume, pour_rate_m3h: rate, scheduled_at: at, capacity_m3: s.truck_capacity_m3, lead_minutes: s.lead_minutes, cycle_minutes: s.cycle_minutes });
      const order = { id, ref, le, customer, siteId, site, mix, pump: pump || !!pumpAsset };
      for (const l of plan.loads) await this.addLoad(c, a, order, l);
      const row = await this.pour(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pour.created', targetType: 'pour_order', targetId: id, after: { ...row, loads: undefined } });
      return row;
    });
  }

  /** Office edits that do not change the volume: site ready or on hold, pump, notes, site details, and the start time (re-times loads not yet loaded). */
  @Patch('pours/:id')
  @Perm('tasks:write')
  update(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const ready = flag(b?.site_ready, 'site_ready');
    const pumpAsset = b?.pump_asset_id === null ? null : v.uuid(b?.pump_asset_id, 'pump_asset_id');
    const notes = b?.notes === undefined ? undefined : v.str(b.notes, 'notes', { max: 1000 });
    const site = b?.site === undefined ? undefined : normalizeSite(b.site);
    const at = v.ts(b?.scheduled_at, 'scheduled_at');
    return this.db.withTenant(a, async (c) => {
      const p = await this.lock(c, id, ver);
      if (pumpAsset) await this.checkPump(c, pumpAsset, p.legal_entity_id);
      await c.query(
        `UPDATE ops.pour_order SET site_ready = COALESCE($2, site_ready), pump_asset_id = CASE WHEN $3 THEN $4 ELSE pump_asset_id END,
           pump_required = pump_required OR $4 IS NOT NULL, notes = CASE WHEN $5 THEN $6 ELSE notes END, site = COALESCE($7::jsonb, site),
           scheduled_at = COALESCE($8, scheduled_at), version = version + 1, updated_at = now() WHERE id = $1`,
        [id, ready ?? null, b?.pump_asset_id !== undefined, pumpAsset ?? null, notes !== undefined, notes ?? null, site ? JSON.stringify({ ...p.site, ...site }) : null, at]);
      if (site) {
        const merged = { ...p.site, ...site } as Site;
        await c.query(
          `UPDATE ops.task t SET attributes = t.attributes || jsonb_build_object('dropoff', $2::jsonb, 'address', $3::text), version = version + 1, updated_at = now()
             FROM ops.load_ticket l WHERE l.task_id = t.id AND l.pour_order_id = $1 AND t.status = ANY($4)`,
          [id, JSON.stringify(merged), siteLine(merged) ?? null, UNSTARTED]);
      }
      if (at) await this.retime(c, id);
      const row = await this.pour(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pour.updated', targetType: 'pour_order', targetId: id, before: { ...p }, after: { ...row, loads: undefined } });
      return row;
    });
  }

  /**
   * Change of quantity during the pour, approved by the customer (Phase B, journey 4): loads not yet batched are resized,
   * added or canceled to reach the new total. Volume already loaded cannot be taken back.
   */
  @Post('pours/:id/adjust')
  @HttpCode(200)
  @Perm('tasks:write')
  adjust(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const volume = m3(b?.volume_m3, 'volume_m3', { required: true })!;
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const p = await this.lock(c, id, ver);
      if (p.canceled_at) throw new ConflictException('pour is canceled');
      const s = await settingsOf(c, p.legal_entity_id);
      const loads = (await c.query(`${LOAD_SQL} WHERE l.pour_order_id = $1 AND t.status <> 'canceled' AND t.status <> 'failed' ORDER BY l.seq`, [id])).rows;
      const fixed = loads.filter((l) => !UNSTARTED.includes(l.status) || l.batched_at);
      const open = loads.filter((l) => !fixed.includes(l));
      const fixedM3 = fixed.reduce((x, l) => x + l.volume_m3, 0);
      if (volume < fixedM3 - 0.004) throw new ConflictException(`already loaded ${fixedM3.toFixed(2)} m³; the new total cannot be less`);
      const maxSeq = (await c.query('SELECT coalesce(max(seq), 0) AS m FROM ops.load_ticket WHERE pour_order_id = $1', [id])).rows[0].m;
      const plan = planLoads({ volume_m3: Math.max(0, volume - fixedM3), pour_rate_m3h: p.pour_rate_m3h, scheduled_at: new Date(p.scheduled_at), capacity_m3: s.truck_capacity_m3,
        lead_minutes: s.lead_minutes, cycle_minutes: s.cycle_minutes, already_m3: fixedM3, startSeq: maxSeq + 1 });
      // reuse the open loads in order (they keep their mixer), cancel the ones left over, add new ones if needed
      for (let i = 0; i < Math.max(open.length, plan.loads.length); i++) {
        const want = plan.loads[i], have = open[i];
        if (have && want) {
          await c.query('UPDATE ops.load_ticket SET volume_m3 = $2 WHERE task_id = $1', [have.task_id, want.volume_m3]);
          await c.query(`UPDATE ops.task SET attributes = attributes || jsonb_build_object('volume_m3', $2::numeric), version = version + 1, updated_at = now() WHERE id = $1`, [have.task_id, want.volume_m3]);
        } else if (have) {
          await cancelLoad(c, a, have.task_id, have.status, `pour adjusted: ${reason}`);
        } else if (want) {
          await this.addLoad(c, a, { id, ref: p.ref, le: p.legal_entity_id, customer: p.customer_id, siteId: p.site_id, site: p.site, mix: p.mix_code, pump: p.pump_required }, want);
        }
      }
      await c.query('UPDATE ops.pour_order SET volume_m3 = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, volume]);
      await this.retime(c, id);
      const row = await this.pour(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pour.adjusted', targetType: 'pour_order', targetId: id, before: { volume_m3: p.volume_m3 }, after: { volume_m3: volume, reason } });
      return row;
    });
  }

  /** Cancels the pour and its loads not yet batched. Loads already loaded stay with their drivers for the dispatcher to decide. */
  @Post('pours/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:write')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const p = await this.lock(c, id, ver);
      if (p.canceled_at) return this.pour(c, id);
      const open = (await c.query(
        `SELECT t.id, t.status FROM ops.load_ticket l JOIN ops.task t ON t.id = l.task_id WHERE l.pour_order_id = $1 AND t.status = ANY($2) AND l.batched_at IS NULL FOR UPDATE OF t`,
        [id, UNSTARTED])).rows;
      for (const t of open) await cancelLoad(c, a, t.id, t.status, `pour canceled: ${reason}`);
      await c.query('UPDATE ops.pour_order SET canceled_at = now(), cancel_reason = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, reason]);
      const row = await this.pour(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'pour.canceled', targetType: 'pour_order', targetId: id, after: { reason, canceled_loads: open.length } });
      return row;
    });
  }

  /**
   * The mixers board: every mixer with its state now, from the open shift and the driver's stages:
   * off (no shift), loading, on_road, waiting (on site), pouring, returning, available. Plus today's figures.
   */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const mixers = (await c.query(
        `SELECT ast.id AS asset_id, ast.plate_no, ast.legal_entity_id, (ast.capacity->>'m3')::float AS capacity_m3, ast.status AS asset_status,
                sh.worker_id, w.display_name AS worker_name, cur.task_id, cur.status AS task_status, cur.ticket_no, cur.pour_ref, cur.batched_at,
                cur.stage, cur.volume_m3, last.done_at,
                COALESCE(cs.lead_minutes, 30) AS lead_minutes, COALESCE(cs.max_age_minutes, 90) AS max_age_minutes, COALESCE(cs.age_warn_minutes, 70) AS age_warn_minutes
           FROM fleet.asset ast
           LEFT JOIN ops.concrete_settings cs ON cs.legal_entity_id = ast.legal_entity_id
           LEFT JOIN shift.shift sh ON sh.asset_id = ast.id AND sh.ended_at IS NULL
           LEFT JOIN workforce.worker w ON w.id = sh.worker_id
           LEFT JOIN LATERAL (
             SELECT t.id AS task_id, t.status, l.ticket_no, p.ref AS pour_ref, l.batched_at, l.volume_m3::float,
                    (SELECT m.code FROM ops.task_milestone m WHERE m.task_id = t.id ORDER BY m.occurred_at DESC LIMIT 1) AS stage
               FROM ops.assignment x JOIN ops.task t ON t.id = x.task_id JOIN ops.load_ticket l ON l.task_id = t.id JOIN ops.pour_order p ON p.id = l.pour_order_id
              WHERE x.active AND x.worker_id = sh.worker_id AND t.status IN ('accepted','in_progress')
              ORDER BY t.status DESC, l.planned_arrival LIMIT 1) cur ON true
           LEFT JOIN LATERAL (
             SELECT max(e.occurred_at) AS done_at FROM ops.task_event e JOIN ops.load_ticket l ON l.task_id = e.task_id
              WHERE e.actor_id = w.user_id AND e.to_status IN ('completed','failed') AND e.occurred_at > now() - interval '1 day') last ON true
          WHERE ast.asset_type = 'mixer' AND ast.status <> 'retired'
          ORDER BY ast.plate_no`)).rows.map((m) => {
        const age = ageMinutes(m.batched_at);
        return { ...m, age_minutes: age, age_level: age === null ? null : age >= m.max_age_minutes ? 'over' : age >= m.age_warn_minutes ? 'warn' : 'ok', state: mixerState(m) };
      });
      // "today" in each legal entity's own time zone (Kuwait first, GCC later)
      const today = (await c.query(
        `WITH d AS (
           SELECT le.id, (date_trunc('day', now() AT TIME ZONE le.timezone) AT TIME ZONE le.timezone) AS d0 FROM org.legal_entity le
         ), tk AS (
           SELECT l.* FROM ops.load_ticket l JOIN ops.pour_order p ON p.id = l.pour_order_id JOIN d ON d.id = p.legal_entity_id
            WHERE l.signed_at >= d.d0 AND l.signed_at < d.d0 + interval '1 day'
         )
         SELECT coalesce(sum(p.volume_m3) FILTER (WHERE p.canceled_at IS NULL), 0)::float AS scheduled_m3,
                (SELECT coalesce(sum(poured_m3), 0)::float FROM tk) AS poured_m3,
                (SELECT coalesce(sum(returned_m3), 0)::float FROM tk) AS returned_m3,
                (SELECT round(avg(wait_minutes))::int FROM tk) AS avg_wait_minutes,
                count(*) FILTER (WHERE p.canceled_at IS NULL)::int AS pours
           FROM ops.pour_order p JOIN d ON d.id = p.legal_entity_id
          WHERE p.scheduled_at >= d.d0 AND p.scheduled_at < d.d0 + interval '1 day'`)).rows[0];
      const counts: Record<string, number> = {};
      for (const m of mixers) counts[m.state] = (counts[m.state] ?? 0) + 1;
      return { today, counts, mixers };
    });
  }

  /**
   * What needs the dispatcher now: concrete close to or over its age limit, trucks waiting on site past the free time,
   * loads due soon with no mixer, sites on hold, and sites with no pinned location.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const sets = `LEFT JOIN ops.concrete_settings cs ON cs.legal_entity_id = t.legal_entity_id`;
      const base = `l.task_id, l.ticket_no, l.volume_m3::float, p.id AS pour_id, p.ref AS pour_ref, p.site, t.status, w.display_name AS worker_name, a.plate_no`;
      const join = `ops.load_ticket l JOIN ops.task t ON t.id = l.task_id JOIN ops.pour_order p ON p.id = l.pour_order_id
        LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active LEFT JOIN workforce.worker w ON w.id = asg.worker_id LEFT JOIN fleet.asset a ON a.id = asg.asset_id ${sets}`;
      const age = (await c.query(
        `SELECT ${base}, l.batched_at, round(extract(epoch FROM now() - l.batched_at) / 60)::int AS age_minutes,
                COALESCE(cs.max_age_minutes, 90) AS max_age_minutes, COALESCE(cs.age_warn_minutes, 70) AS age_warn_minutes
           FROM ${join}
          WHERE l.batched_at IS NOT NULL AND t.status IN ('accepted','in_progress')
            AND NOT EXISTS (SELECT 1 FROM ops.task_milestone m WHERE m.task_id = t.id AND m.code = 'pour_end')
            AND now() - l.batched_at >= make_interval(mins => COALESCE(cs.age_warn_minutes, 70))
          ORDER BY l.batched_at LIMIT 200`)).rows;
      const waiting = (await c.query(
        `SELECT ${base}, m.occurred_at AS at_site, round(extract(epoch FROM now() - m.occurred_at) / 60)::int AS wait_minutes, COALESCE(cs.free_wait_minutes, 30) AS free_wait_minutes
           FROM ${join} JOIN ops.task_milestone m ON m.task_id = t.id AND m.code = 'at_site'
          WHERE t.status = 'in_progress' AND NOT EXISTS (SELECT 1 FROM ops.task_milestone x WHERE x.task_id = t.id AND x.code = 'pour_start')
            AND now() - m.occurred_at > make_interval(mins => COALESCE(cs.free_wait_minutes, 30))
          ORDER BY m.occurred_at LIMIT 200`)).rows;
      const unassigned = (await c.query(
        `SELECT ${base}, l.planned_arrival FROM ${join}
          WHERE t.status = 'ready' AND p.canceled_at IS NULL
            AND l.planned_arrival < now() + make_interval(mins => COALESCE(cs.lead_minutes, 30) + 60)
          ORDER BY l.planned_arrival LIMIT 200`)).rows;
      const holds = (await c.query(
        `SELECT p.id AS pour_id, p.ref AS pour_ref, p.site, p.scheduled_at, p.updated_at FROM ops.pour_order p
          WHERE NOT p.site_ready AND p.canceled_at IS NULL AND p.scheduled_at > now() - interval '1 day' ORDER BY p.scheduled_at LIMIT 200`)).rows;
      const no_location = (await c.query(
        `SELECT p.id AS pour_id, p.ref AS pour_ref, p.site, p.scheduled_at FROM ops.pour_order p
          WHERE p.canceled_at IS NULL AND p.scheduled_at > now() - interval '12 hours' AND NOT (p.site ? 'lat')
          ORDER BY p.scheduled_at LIMIT 200`)).rows;
      return { age, waiting, unassigned, holds, no_location };
    });
  }

  /** Site waiting time per signed load in a period, with the hours charged after the free time. */
  @Get('waiting')
  @Perm('reports:read')
  waitingReport(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.ts(from, 'from', { required: true })!, t = v.ts(to, 'to', { required: true })!;
    if (t <= f || t.getTime() - f.getTime() > 93 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `SELECT l.task_id, l.ticket_no, p.ref AS pour_ref, p.customer_id, cu.name AS customer_name, p.site, l.signed_at, l.wait_minutes,
                l.poured_m3::float, l.returned_m3::float, COALESCE((tk.attributes #>> '{quantities,hour}')::float, 0) AS billable_hours
           FROM ops.load_ticket l JOIN ops.pour_order p ON p.id = l.pour_order_id JOIN ops.task tk ON tk.id = l.task_id
           LEFT JOIN crm.customer cu ON cu.id = p.customer_id
          WHERE l.signed_at >= $1 AND l.signed_at < $2 ORDER BY l.signed_at LIMIT 2000`, [f, t])).rows;
      const byCustomer = new Map<string, { customer_id: string | null; customer_name: string | null; loads: number; wait_minutes: number; billable_hours: number; poured_m3: number; returned_m3: number }>();
      for (const r of rows) {
        const k = r.customer_id ?? '-';
        const s = byCustomer.get(k) ?? { customer_id: r.customer_id, customer_name: r.customer_name, loads: 0, wait_minutes: 0, billable_hours: 0, poured_m3: 0, returned_m3: 0 };
        s.loads++; s.wait_minutes += r.wait_minutes ?? 0; s.billable_hours += r.billable_hours; s.poured_m3 += r.poured_m3 ?? 0; s.returned_m3 += r.returned_m3 ?? 0;
        byCustomer.set(k, s);
      }
      return { from: f, to: t, data: rows, customers: [...byCustomer.values()].map((s) => ({ ...s, avg_wait_minutes: Math.round(s.wait_minutes / s.loads), poured_m3: +s.poured_m3.toFixed(2), returned_m3: +s.returned_m3.toFixed(2) })) };
    });
  }

  /** The concrete side of one load task: ticket, pour, stage times, age and waiting. */
  @Get('tasks/:id')
  @Perm('tasks:read')
  async task(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.withTenant(a, async (c) => {
      const l = (await c.query(`${LOAD_SQL} WHERE l.task_id = $1`, [id])).rows[0];
      if (!l) return null;
      const p = (await c.query(`SELECT ${POUR_COLS} FROM ${POUR_FROM} JOIN ops.load_ticket lt ON lt.pour_order_id = p.id WHERE lt.task_id = $1`, [id])).rows[0];
      const s = await settingsOf(c, p.legal_entity_id);
      const end = l.pour_end ? new Date(l.pour_end) : new Date();
      const failure = (await c.query(`SELECT reason_code, note, occurred_at FROM ops.task_event WHERE task_id = $1 AND to_status = 'failed' ORDER BY occurred_at DESC LIMIT 1`, [id])).rows[0] ?? null;
      return {
        ticket: { ...l, age_minutes: l.batched_at ? ageMinutes(l.batched_at, end) : null },
        pour: { id: p.id, ref: p.ref, mix_code: p.mix_code, site: p.site, customer_name: p.customer_name, state: p.state, pump_required: p.pump_required, pump_plate: p.pump_plate },
        limits: { max_age_minutes: s.max_age_minutes, age_warn_minutes: s.age_warn_minutes, free_wait_minutes: s.free_wait_minutes },
        failure: l.status === 'failed' ? failure : null,
      };
    });
    if (!r) throw new NotFoundException();
    return r;
  }

  private async pour(c: PoolClient, id: string) {
    const p = (await c.query(`SELECT ${POUR_COLS} FROM ${POUR_FROM} WHERE p.id = $1`, [id])).rows[0];
    if (!p) return null;
    const loads = (await c.query(`${LOAD_SQL} WHERE l.pour_order_id = $1 ORDER BY l.seq`, [id])).rows;
    const s = await settingsOf(c, p.legal_entity_id);
    const plan = planLoads({ volume_m3: p.volume_m3, pour_rate_m3h: p.pour_rate_m3h, scheduled_at: new Date(p.scheduled_at), capacity_m3: s.truck_capacity_m3, lead_minutes: s.lead_minutes, cycle_minutes: s.cycle_minutes });
    return { ...summarize(p, loads), plan: { spacing_minutes: plan.spacing_minutes, trucks_needed: plan.trucks_needed, pour_minutes: plan.pour_minutes, estimated: true }, limits: s, loads: loads.map((l) => ({ ...l, age_minutes: l.batched_at ? ageMinutes(l.batched_at, l.pour_end ? new Date(l.pour_end) : new Date()) : null })) };
  }

  private async lock(c: PoolClient, id: string, ver: number) {
    const p = (await c.query('SELECT id, ref, legal_entity_id, customer_id, site_id, site, mix_code, volume_m3::float, pour_rate_m3h::float, pump_required, scheduled_at, canceled_at, version FROM ops.pour_order WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw new NotFoundException();
    if (p.version !== ver) throw new ConflictException({ message: 'pour changed since you loaded it', current_version: p.version });
    return p;
  }

  private async checkPump(c: PoolClient, assetId: string, le: string) {
    const x = (await c.query('SELECT asset_type, legal_entity_id, status FROM fleet.asset WHERE id = $1', [assetId])).rows[0];
    if (!x) throw new BadRequestException('unknown pump_asset_id');
    if (x.asset_type !== 'pump') throw new BadRequestException('pump_asset_id is not a pump');
    if (x.legal_entity_id !== le) throw new BadRequestException('pump belongs to another legal entity');
    if (x.status === 'out_of_service' || x.status === 'retired') throw new ConflictException(`pump is ${x.status}`);
  }

  /** Creates the task and the ticket for one planned load. The task window runs from loading at the plant to the truck's return. */
  private async addLoad(c: PoolClient, a: AuthContext, o: { id: string; ref: string; le: string; customer: string | null; siteId: string | null; site: Site; mix: string; pump: boolean },
    l: { seq: number; volume_m3: number; arrive_at: Date; load_at: Date; return_at: Date }) {
    const ticket = `${o.ref}-${l.seq}`;
    const task = await createTask(c, a, {
      le: o.le, pack: CONCRETE, branch: null, ref: ticket, status: 'ready', customer: o.customer, site: o.siteId,
      win: { from: l.load_at.toISOString(), to: l.return_at.toISOString() },
      attrs: { pour_order_id: o.id, pour_ref: o.ref, seq: l.seq, ticket_no: ticket, mix_code: o.mix, volume_m3: l.volume_m3, pump_required: o.pump,
        dropoff: o.site, address: siteLine(o.site) ?? null, planned_arrival: l.arrive_at.toISOString() },
    });
    if ((await c.query('SELECT 1 FROM ops.load_ticket WHERE task_id = $1', [task.id])).rowCount) throw new ConflictException(`ticket ${ticket} already exists`);
    await c.query(
      `INSERT INTO ops.load_ticket (tenant_id, task_id, pour_order_id, seq, ticket_no, volume_m3, planned_arrival) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a.tenantId, task.id, o.id, l.seq, ticket, l.volume_m3, l.arrive_at]);
  }

  /** Re-times the loads not yet batched after a change of start time or volume: each arrives when the volume before it is poured. */
  private async retime(c: PoolClient, id: string) {
    const p = (await c.query('SELECT legal_entity_id, scheduled_at, pour_rate_m3h::float FROM ops.pour_order WHERE id = $1', [id])).rows[0];
    const s = await settingsOf(c, p.legal_entity_id);
    const loads = (await c.query(
      `SELECT l.task_id, l.volume_m3::float, l.batched_at, t.status FROM ops.load_ticket l JOIN ops.task t ON t.id = l.task_id
        WHERE l.pour_order_id = $1 AND t.status NOT IN ('canceled','failed') ORDER BY l.seq`, [id])).rows;
    let before = 0;
    for (const l of loads) {
      if (UNSTARTED.includes(l.status) && !l.batched_at) {
        const arrive = new Date(new Date(p.scheduled_at).getTime() + (before / p.pour_rate_m3h) * 3_600_000);
        const from = new Date(arrive.getTime() - s.lead_minutes * 60_000), to = new Date(from.getTime() + s.cycle_minutes * 60_000);
        await c.query('UPDATE ops.load_ticket SET planned_arrival = $2 WHERE task_id = $1', [l.task_id, arrive]);
        await c.query(`UPDATE ops.task SET service_window = tstzrange($2,$3), attributes = attributes || jsonb_build_object('planned_arrival', $4::text), version = version + 1, updated_at = now() WHERE id = $1`,
          [l.task_id, from, to, arrive.toISOString()]);
        await c.query('SAVEPOINT rt');
        try { await c.query('UPDATE ops.assignment SET period = tstzrange($2,$3) WHERE task_id = $1 AND active', [l.task_id, from, to]); await c.query('RELEASE SAVEPOINT rt'); }
        catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT rt');
          if ((e as { constraint?: string }).constraint === 'no_asset_overlap' || (e as { constraint?: string }).constraint === 'no_worker_overlap') throw new ConflictException('the new time overlaps another booking of the assigned mixer or driver');
          throw e;
        }
      }
      before += l.volume_m3;
    }
  }
}

/** Mixer state from its shift, current load and last finished load. */
export function mixerState(m: { worker_id: string | null; task_id: string | null; task_status: string | null; stage: string | null; done_at: Date | string | null; lead_minutes: number; asset_status?: string }): string {
  if (m.asset_status === 'out_of_service') return 'off';
  if (!m.worker_id) return 'off';
  if (m.task_id) {
    if (m.stage === 'pour_end') return 'returning';
    if (m.stage === 'pour_start') return 'pouring';
    if (m.stage === 'at_site') return 'waiting';
    if (m.stage === 'loaded' || m.task_status === 'in_progress') return 'on_road';
    return 'loading';
  }
  // the way back is assumed as long as the way out [تخمين]
  if (m.done_at && Date.now() - new Date(m.done_at).getTime() < m.lead_minutes * 60_000) return 'returning';
  return 'available';
}

/** Pour totals from its loads. Canceled and failed loads do not count toward the planned volume. */
function summarize(p: Record<string, any>, loads: Record<string, any>[]) {
  const live = loads.filter((l) => l.status !== 'canceled' && l.status !== 'failed');
  const sum = (xs: Record<string, any>[], k: string) => +xs.reduce((s, l) => s + (l[k] ?? 0), 0).toFixed(2);
  return {
    ...p,
    totals: {
      loads: live.length,
      assigned: live.filter((l) => l.worker_id).length,
      dispatched_m3: sum(live.filter((l) => l.batched_at), 'volume_m3'),
      delivered_loads: live.filter((l) => DONE.includes(l.status)).length,
      poured_m3: sum(live, 'poured_m3'),
      returned_m3: sum(live, 'returned_m3'),
      wait_minutes: live.reduce((s, l) => s + (l.wait_minutes ?? 0), 0),
    },
    loads_brief: loads.map((l) => ({ task_id: l.task_id, seq: l.seq, status: l.status, stage: l.stage, volume_m3: l.volume_m3, planned_arrival: l.planned_arrival,
      window_from: l.window_from, window_to: l.window_to, batched_at: l.batched_at, pour_end: l.pour_end, worker_name: l.worker_name, plate_no: l.plate_no })),
  };
}

async function cancelLoad(c: PoolClient, a: AuthContext, taskId: string, from: string, note: string) {
  await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [taskId]);
  await c.query('UPDATE ops.task SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [taskId, 'canceled']);
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
     VALUES ($1,$2,$3,$4,'canceled',now(),$5,'staff',$6,$7)`, [randomUUID(), a.tenantId, taskId, from, a.userId, randomUUID(), note.slice(0, 500)]);
}
