import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { Doc, eligibility, GENERATE_DAYS, hhmm, normalizeSite, SETTINGS_COLS, settingsOf, siteLine, STAFFING, StaffingSettings } from './staffing';

const REQ_COLS = `r.id, r.ref, r.legal_entity_id, r.customer_id, cu.name AS customer_name, r.site_id, r.site, r.worker_kind, r.with_vehicle, r.headcount,
  r.starts_on::text, r.ends_on::text, to_char(r.shift_start, 'HH24:MI') AS shift_start, to_char(r.shift_end, 'HH24:MI') AS shift_end, r.work_days, r.bill_unit,
  r.notes, r.canceled_at, r.cancel_reason, r.version, r.created_at,
  CASE WHEN r.canceled_at IS NOT NULL THEN 'canceled'
       WHEN r.ends_on < (now() AT TIME ZONE le.timezone)::date THEN 'ended'
       WHEN r.starts_on > (now() AT TIME ZONE le.timezone)::date THEN 'upcoming'
       ELSE 'active' END AS state,
  (SELECT count(*) FROM ops.placement p WHERE p.request_id = r.id AND p.active AND p.ends_on >= (now() AT TIME ZONE le.timezone)::date
     AND p.starts_on <= GREATEST(r.starts_on, (now() AT TIME ZONE le.timezone)::date))::int AS placed_now`;
const REQ_FROM = `ops.supply_request r JOIN crm.customer cu ON cu.id = r.customer_id JOIN org.legal_entity le ON le.id = r.legal_entity_id`;

/** One row per day-shift: who worked, when they checked in and out, hours, approval and dispute. */
export const SHIFT_SQL = `
  SELECT s.task_id, s.placement_id, s.work_date::text, t.status, t.version, t.ref, lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
         asg.worker_id, w.display_name AS worker_name, asg.asset_id, a.plate_no, s.checkin_distance_m, s.absent_at, s.replaced_at, s.replaced_worker_id,
         ms.check_in, ms.check_out, (t.attributes #>> '{quantities,hour}')::float AS hours, (t.attributes #>> '{quantities,day}')::float AS days,
         d.id AS dispute_id, d.reason AS dispute_reason, r.id AS request_id, r.ref AS request_ref, r.customer_id
    FROM ops.staffing_shift s JOIN ops.task t ON t.id = s.task_id
    JOIN ops.placement p ON p.id = s.placement_id JOIN ops.supply_request r ON r.id = p.request_id
    LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id
    LEFT JOIN fleet.asset a ON a.id = asg.asset_id
    LEFT JOIN ops.staffing_dispute d ON d.task_id = t.id AND d.resolved_at IS NULL
    LEFT JOIN LATERAL (SELECT min(m.occurred_at) FILTER (WHERE m.code = 'check_in') AS check_in, min(m.occurred_at) FILTER (WHERE m.code = 'check_out') AS check_out
                         FROM ops.task_milestone m WHERE m.task_id = t.id) ms ON true`;

const version = (b: Record<string, unknown>) => v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
const ids = (val: unknown) => {
  if (!Array.isArray(val) || val.length === 0 || val.length > 500) throw new BadRequestException('task_ids must be a list of 1-500');
  return val.map((x, i) => v.uuid(x, `task_ids[${i}]`, { required: true })!);
};
const today = (c: PoolClient, le: string) => c.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM org.legal_entity WHERE id = $1`, [le]).then((r) => r.rows[0].d as string);

/**
 * Office side of the driver supply pack: settings, supply requests, placing eligible drivers, daily shifts with
 * replacement and absence, the coverage board, exceptions, approval of worked hours and disputes.
 */
@Controller('v1/staffing')
@UseGuards(AuthGuard)
export class StaffingController {
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
    const rounding = v.int(b.hour_rounding_minutes, 'hour_rounding_minutes', 1, 60);
    if (rounding !== null && ![1, 5, 10, 15, 30, 60].includes(rounding)) throw new BadRequestException('hour_rounding_minutes must be 1, 5, 10, 15, 30 or 60');
    let docs: string[] | undefined;
    if (b.doc_types !== undefined) {
      if (!Array.isArray(b.doc_types) || b.doc_types.length > 10 || b.doc_types.some((d) => typeof d !== 'string' || !/^[a-z_]{2,40}$/.test(d))) throw new BadRequestException('doc_types must be a list of document types');
      docs = [...new Set(b.doc_types as string[])];
    }
    const patch: Partial<StaffingSettings> = {
      checkin_radius_m: v.int(b.checkin_radius_m, 'checkin_radius_m', 50, 5000) ?? undefined,
      late_grace_minutes: v.int(b.late_grace_minutes, 'late_grace_minutes', 0, 240) ?? undefined,
      hour_rounding_minutes: rounding ?? undefined, doc_types: docs,
    };
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const before = await settingsOf(c, le);
      const s = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)) } as StaffingSettings;
      const row = (await c.query(
        `INSERT INTO ops.staffing_settings (tenant_id, legal_entity_id, checkin_radius_m, late_grace_minutes, hour_rounding_minutes, doc_types) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET checkin_radius_m = EXCLUDED.checkin_radius_m, late_grace_minutes = EXCLUDED.late_grace_minutes,
           hour_rounding_minutes = EXCLUDED.hour_rounding_minutes, doc_types = EXCLUDED.doc_types, updated_at = now()
         RETURNING ${SETTINGS_COLS}`, [a.tenantId, le, s.checkin_radius_m, s.late_grace_minutes, s.hour_rounding_minutes, s.doc_types])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'staffing.settings_changed', targetType: 'legal_entity', targetId: le, before, after: row });
      return { legal_entity_id: le, ...row };
    });
  }

  @Get('requests')
  @Perm('tasks:read')
  list(@Auth() a: AuthContext, @Query('all') all?: string) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${REQ_COLS} FROM ${REQ_FROM}
          WHERE $1 OR (r.canceled_at IS NULL AND r.ends_on >= (now() AT TIME ZONE le.timezone)::date - 7)
          ORDER BY r.starts_on, r.ref LIMIT 500`, [all === 'true'])).rows,
    }));
  }

  @Get('requests/:id')
  @Perm('tasks:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.withTenant(a, (c) => this.request(c, id));
    if (!r) throw new NotFoundException();
    return r;
  }

  /** New supply request. The same ref again returns the existing request (safe to retry). */
  @Post('requests')
  @Perm('tasks:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const ref = v.str(b?.ref, 'ref', { required: true, max: 30 })!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/.test(ref)) throw new BadRequestException('ref: letters, digits, - and _ only');
    const siteId = v.uuid(b?.site_id, 'site_id');
    const site = normalizeSite(b?.site);
    const kind = v.oneOf(b?.worker_kind, 'worker_kind', ['driver', 'courier'] as const) ?? 'driver';
    const withVehicle = b?.with_vehicle === true;
    const headcount = v.int(b?.headcount, 'headcount', 1, 500) ?? (() => { throw new BadRequestException('headcount required'); })();
    const from = v.date(b?.starts_on, 'starts_on') ?? (() => { throw new BadRequestException('starts_on required'); })();
    const to = v.date(b?.ends_on, 'ends_on') ?? (() => { throw new BadRequestException('ends_on required'); })();
    if (to < from) throw new BadRequestException('ends_on is before starts_on');
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new BadRequestException('a request is at most one year; renew it after');
    const start = hhmm(b?.shift_start, 'shift_start'), end = hhmm(b?.shift_end, 'shift_end');
    if (start === end) throw new BadRequestException('shift_end must differ from shift_start');
    let days = [0, 1, 2, 3, 4];
    if (b?.work_days !== undefined) {
      if (!Array.isArray(b.work_days) || !b.work_days.length || b.work_days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException('work_days must be weekday numbers 0-6 (0 = Sunday)');
      days = [...new Set(b.work_days as number[])].sort();
    }
    const unit = v.oneOf(b?.bill_unit, 'bill_unit', ['hour', 'day'] as const) ?? 'hour';
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const prior = (await c.query('SELECT id FROM ops.supply_request WHERE ref = $1', [ref])).rows[0];
      if (prior) return this.request(c, prior.id);
      const cu = (await c.query('SELECT legal_entity_id, status FROM crm.customer WHERE id = $1', [customer])).rows[0];
      if (!cu) throw new BadRequestException('unknown customer_id');
      if (cu.legal_entity_id !== le) throw new BadRequestException('customer belongs to another legal entity');
      if (cu.status !== 'active') throw new ConflictException(`customer is ${cu.status}`);
      let s = site;
      if (siteId) {
        const x = (await c.query(`SELECT name, address, contact_name, contact_phone, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM crm.site WHERE id = $1 AND customer_id = $2 AND active`, [siteId, customer])).rows[0];
        if (!x) throw new BadRequestException('unknown site_id for this customer');
        s = { name: x.name, ...(x.address ? { notes: x.address } : {}), ...(x.contact_name ? { contact_name: x.contact_name } : {}), ...(x.contact_phone ? { contact_phone: x.contact_phone } : {}),
          ...(x.lat !== null ? { lat: x.lat, lng: x.lng } : {}), ...site };
      }
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO ops.supply_request (id, tenant_id, legal_entity_id, customer_id, ref, site_id, site, worker_kind, with_vehicle, headcount, starts_on, ends_on, shift_start, shift_end, work_days, bill_unit, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [id, a.tenantId, le, customer, ref, siteId, JSON.stringify(s), kind, withVehicle, headcount, from, to, start, end, days, unit, notes, a.userId]);
      } catch (e) { return pgToHttp(e); }
      const row = await this.request(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'supply_request.created', targetType: 'supply_request', targetId: id, after: { ...row, placements: undefined, shifts: undefined } });
      return row;
    });
  }

  /** Cancels the request: future shifts not started are canceled and placements end today. */
  @Post('requests/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:write')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const r = await this.lock(c, id, ver);
      if (r.canceled_at) return this.request(c, id);
      const d = await today(c, r.legal_entity_id);
      for (const p of (await c.query('SELECT id FROM ops.placement WHERE request_id = $1 AND active', [id])).rows) await this.endPlacement(c, a, p.id, d, `request canceled: ${reason}`);
      await c.query('UPDATE ops.supply_request SET canceled_at = now(), cancel_reason = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'supply_request.canceled', targetType: 'supply_request', targetId: id, after: { reason } });
      return this.request(c, id);
    });
  }

  /** Drivers who could fill the request: right kind and legal entity, active, with their document check and any overlapping placement. */
  @Get('requests/:id/candidates')
  @Perm('tasks:read')
  candidates(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query('SELECT id, legal_entity_id, worker_kind, starts_on::text, ends_on::text FROM ops.supply_request WHERE id = $1', [id])).rows[0];
      if (!r) throw new NotFoundException();
      const s = await settingsOf(c, r.legal_entity_id);
      const from = r.starts_on > (await today(c, r.legal_entity_id)) ? r.starts_on : await today(c, r.legal_entity_id);
      const workers = (await c.query(
        `SELECT w.id, w.display_name, w.kind,
                (SELECT coalesce(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'expires_on', d.expires_on::text)), '[]') FROM core.document d WHERE d.worker_id = w.id AND d.archived_at IS NULL) AS docs,
                (SELECT jsonb_build_object('request_ref', rr.ref, 'starts_on', p.starts_on::text, 'ends_on', p.ends_on::text) FROM ops.placement p JOIN ops.supply_request rr ON rr.id = p.request_id
                  WHERE p.worker_id = w.id AND p.active AND daterange(p.starts_on, p.ends_on, '[]') && daterange($3::date, $4::date, '[]') LIMIT 1) AS busy
           FROM workforce.worker w WHERE w.legal_entity_id = $1 AND w.status = 'active' AND w.kind = $2 ORDER BY w.display_name`,
        [r.legal_entity_id, r.worker_kind, from, r.ends_on])).rows;
      const data = workers.map((w) => ({ id: w.id, display_name: w.display_name, busy: w.busy, eligibility: eligibility(w.docs as Doc[], s.doc_types, from, r.ends_on) }))
        .sort((x, y) => Number(!!x.busy) - Number(!!y.busy) || ['ok', 'warn', 'blocked'].indexOf(x.eligibility.status) - ['ok', 'warn', 'blocked'].indexOf(y.eligibility.status));
      return { from, to: r.ends_on, data };
    });
  }

  /** Places an eligible driver on the request for a period and creates their day-shifts. */
  @Post('requests/:id/placements')
  @Perm('tasks:assign')
  place(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const workerId = v.uuid(b?.worker_id, 'worker_id', { required: true })!;
    const assetId = v.uuid(b?.asset_id, 'asset_id');
    const fromIn = v.date(b?.starts_on, 'starts_on'), toIn = v.date(b?.ends_on, 'ends_on');
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query('SELECT id, legal_entity_id, worker_kind, with_vehicle, headcount, starts_on::text, ends_on::text, canceled_at FROM ops.supply_request WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.canceled_at) throw new ConflictException('request is canceled');
      const d = await today(c, r.legal_entity_id);
      const from = fromIn ?? (r.starts_on > d ? r.starts_on : d), to = toIn ?? r.ends_on;
      if (from < r.starts_on || to > r.ends_on || to < from) throw new BadRequestException('placement must be within the request period');
      if (to < d) throw new BadRequestException('placement is in the past');
      const w = (await c.query('SELECT legal_entity_id, status, kind FROM workforce.worker WHERE id = $1', [workerId])).rows[0];
      if (!w) throw new BadRequestException('unknown worker_id');
      if (w.legal_entity_id !== r.legal_entity_id) throw new BadRequestException('worker belongs to another legal entity');
      if (w.status !== 'active') throw new ConflictException(`worker is ${w.status}`);
      if (w.kind !== r.worker_kind) throw new BadRequestException(`the request needs a ${r.worker_kind}`);
      if (r.with_vehicle && !assetId) throw new BadRequestException('the request needs a vehicle: send asset_id');
      if (assetId) {
        const x = (await c.query('SELECT legal_entity_id, status FROM fleet.asset WHERE id = $1', [assetId])).rows[0];
        if (!x) throw new BadRequestException('unknown asset_id');
        if (x.legal_entity_id !== r.legal_entity_id) throw new BadRequestException('vehicle belongs to another legal entity');
        if (x.status === 'out_of_service' || x.status === 'retired') throw new ConflictException(`vehicle is ${x.status}`);
      }
      const s = await settingsOf(c, r.legal_entity_id);
      const docs = (await c.query('SELECT doc_type, expires_on::text FROM core.document WHERE worker_id = $1 AND archived_at IS NULL', [workerId])).rows as Doc[];
      const el = eligibility(docs, s.doc_types, from, to);
      if (el.status === 'blocked') throw new ConflictException({ message: 'driver is not eligible: documents missing or expired', eligibility: el });
      const full = (await c.query(
        `SELECT max(n)::int AS n FROM (SELECT count(*) AS n FROM generate_series($2::date, $3::date, '1 day') g(day)
           JOIN ops.placement p ON p.request_id = $1 AND p.active AND g.day BETWEEN p.starts_on AND p.ends_on GROUP BY g.day) x`, [id, from, to])).rows[0].n ?? 0;
      if (full >= r.headcount) throw new ConflictException(`the request already has ${r.headcount} driver(s) placed on some of these days`);
      const pid = randomUUID();
      const seq = (await c.query('SELECT coalesce(max(seq), 0) + 1 AS s FROM ops.placement WHERE request_id = $1', [id])).rows[0].s;
      try {
        await c.query(`INSERT INTO ops.placement (id, tenant_id, request_id, seq, worker_id, asset_id, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [pid, a.tenantId, id, seq, workerId, assetId, from, to, a.userId]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'no_placement_overlap') throw new ConflictException('driver is already placed on another request in this period');
        return pgToHttp(e);
      }
      const made = await this.generate(c, a, pid, d);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'placement.created', targetType: 'placement', targetId: pid, after: { request_id: id, worker_id: workerId, asset_id: assetId, from, to, shifts: made, warnings: el.issues } });
      return { id: pid, request_id: id, worker_id: workerId, asset_id: assetId, starts_on: from, ends_on: to, shifts_created: made, eligibility: el };
    });
  }

  /** Ends a placement early (or removes it before it starts). Shifts after the end that have not started are canceled. */
  @Post('placements/:id/end')
  @HttpCode(200)
  @Perm('tasks:assign')
  end(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    const on = v.date(b?.end_on, 'end_on');
    return this.db.withTenant(a, async (c) => {
      const p = (await c.query('SELECT p.id, r.legal_entity_id FROM ops.placement p JOIN ops.supply_request r ON r.id = p.request_id WHERE p.id = $1 AND p.active', [id])).rows[0];
      if (!p) throw new NotFoundException();
      const r = await this.endPlacement(c, a, id, on ?? (await today(c, p.legal_entity_id)), reason);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'placement.ended', targetType: 'placement', targetId: id, after: { ...r, reason } });
      return r;
    });
  }

  /** Creates the missing day-shifts for active placements up to the horizon. Safe to call any time (a daily job in production). */
  @Post('generate')
  @HttpCode(200)
  @Perm('tasks:assign')
  generateAll(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      let made = 0;
      for (const p of (await c.query(
        `SELECT p.id, (now() AT TIME ZONE le.timezone)::date::text AS d FROM ops.placement p JOIN ops.supply_request r ON r.id = p.request_id JOIN org.legal_entity le ON le.id = r.legal_entity_id
          WHERE p.active AND r.canceled_at IS NULL AND p.ends_on >= (now() AT TIME ZONE le.timezone)::date`)).rows) made += await this.generate(c, a, p.id, p.d);
      return { shifts_created: made };
    });
  }

  /** A substitute takes the day's shift (absence of the placed driver). The substitute must be eligible and free. */
  @Post('shifts/:id/replace')
  @HttpCode(200)
  @Perm('tasks:assign')
  replace(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const workerId = v.uuid(b?.worker_id, 'worker_id', { required: true })!;
    const assetId = v.uuid(b?.asset_id, 'asset_id');
    return this.db.withTenant(a, async (c) => {
      const t = await this.shiftTask(c, id);
      if (!['ready', 'assigned', 'accepted'].includes(t.status)) throw new ConflictException(`cannot replace on a shift that is ${t.status}`);
      const w = (await c.query('SELECT legal_entity_id, status, kind FROM workforce.worker WHERE id = $1', [workerId])).rows[0];
      if (!w || w.legal_entity_id !== t.legal_entity_id) throw new BadRequestException('unknown worker_id');
      if (w.status !== 'active') throw new ConflictException(`worker is ${w.status}`);
      if (w.kind !== t.worker_kind) throw new BadRequestException(`the request needs a ${t.worker_kind}`);
      if (workerId === t.worker_id) throw new BadRequestException('this driver already has the shift');
      const s = await settingsOf(c, t.legal_entity_id);
      const docs = (await c.query('SELECT doc_type, expires_on::text FROM core.document WHERE worker_id = $1 AND archived_at IS NULL', [workerId])).rows as Doc[];
      const el = eligibility(docs, s.doc_types, t.work_date, t.work_date);
      if (el.status === 'blocked') throw new ConflictException({ message: 'driver is not eligible: documents missing or expired', eligibility: el });
      await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [id]);
      await this.assign(c, a, id, workerId, assetId ?? t.asset_id, t.status, `replacement for absent driver`);
      await c.query('UPDATE ops.staffing_shift SET replaced_at = now(), replaced_worker_id = COALESCE(replaced_worker_id, $2) WHERE task_id = $1', [id, t.worker_id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'staffing.replaced', targetType: 'task', targetId: id, before: { worker_id: t.worker_id }, after: { worker_id: workerId } });
      return (await c.query(`${SHIFT_SQL} WHERE s.task_id = $1`, [id])).rows[0];
    });
  }

  /** Marks the placed driver absent with no substitute: the shift is canceled and shows in the absence figures. */
  @Post('shifts/:id/absent')
  @HttpCode(200)
  @Perm('tasks:write')
  absent(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { max: 500 }) ?? 'absent';
    return this.db.withTenant(a, async (c) => {
      const t = await this.shiftTask(c, id);
      if (!['ready', 'assigned', 'accepted'].includes(t.status)) throw new ConflictException(`cannot mark absent a shift that is ${t.status}`);
      await cancelTask(c, a, id, t.status, `absent: ${reason}`);
      await c.query('UPDATE ops.staffing_shift SET absent_at = now() WHERE task_id = $1', [id]);
      return (await c.query(`${SHIFT_SQL} WHERE s.task_id = $1`, [id])).rows[0];
    });
  }

  /** Coverage board: one row per request, one cell per day with required, covered, checked-in and absent counts. */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('from') fromQ?: string, @Query('days') daysQ?: string) {
    const days = daysQ ? Number(daysQ) : 7;
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new BadRequestException('days must be 1-31');
    const fromIn = v.date(fromQ, 'from');
    return this.db.withTenant(a, async (c) => {
      const le = (await c.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM org.legal_entity ORDER BY id LIMIT 1`)).rows[0];
      const from = fromIn ?? le?.d ?? new Date().toISOString().slice(0, 10);
      const to = new Date(Date.parse(from) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const reqs = (await c.query(
        `SELECT ${REQ_COLS} FROM ${REQ_FROM} WHERE r.canceled_at IS NULL AND r.starts_on <= $2 AND r.ends_on >= $1 ORDER BY cu.name, r.ref`, [from, to])).rows;
      const cells = reqs.length ? (await c.query(
        `SELECT p.request_id, s.work_date::text, count(*) FILTER (WHERE t.status <> 'canceled' AND asg.id IS NOT NULL)::int AS covered,
                count(*) FILTER (WHERE t.status IN ('in_progress','completed','reviewed','invoiced'))::int AS checked_in,
                count(*) FILTER (WHERE s.absent_at IS NOT NULL)::int AS absent, count(*) FILTER (WHERE s.replaced_at IS NOT NULL)::int AS replaced
           FROM ops.staffing_shift s JOIN ops.placement p ON p.id = s.placement_id JOIN ops.task t ON t.id = s.task_id
           LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
          WHERE p.request_id = ANY($1::uuid[]) AND s.work_date BETWEEN $2 AND $3 GROUP BY p.request_id, s.work_date`, [reqs.map((r) => r.id), from, to])).rows : [];
      const dates = Array.from({ length: days }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10));
      const rows = reqs.map((r) => ({
        ...r,
        days: dates.map((d) => {
          const working = d >= r.starts_on && d <= r.ends_on && (r.work_days as number[]).includes(new Date(`${d}T00:00:00Z`).getUTCDay());
          const x = cells.find((k) => k.request_id === r.id && k.work_date === d);
          return { date: d, required: working ? r.headcount : 0, covered: x?.covered ?? 0, checked_in: x?.checked_in ?? 0, absent: x?.absent ?? 0, replaced: x?.replaced ?? 0 };
        }),
      }));
      const t0: { required: number; covered: number; checked_in: number; absent: number }[] = rows.flatMap((r) => r.days.filter((d: { date: string }) => d.date === from));
      const kpis = (await c.query(
        `SELECT (SELECT count(*) FROM ops.task t WHERE t.sector_pack = $1 AND t.status = 'completed'
                   AND NOT EXISTS (SELECT 1 FROM ops.staffing_dispute d WHERE d.task_id = t.id AND d.resolved_at IS NULL))::int AS pending_approval,
                (SELECT count(*) FROM ops.staffing_dispute WHERE resolved_at IS NULL)::int AS open_disputes`, [STAFFING])).rows[0];
      return {
        from, to, dates, rows,
        today: { active_requests: rows.filter((r) => r.state === 'active').length, required: t0.reduce((s, d) => s + d.required, 0), covered: t0.reduce((s, d) => s + d.covered, 0),
          checked_in: t0.reduce((s, d) => s + d.checked_in, 0), absent: t0.reduce((s, d) => s + d.absent, 0), ...kpis },
      };
    });
  }

  /** What needs the account manager: no-shows, check-ins far from the site, documents expiring, requests ending, disputes, uncovered days. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const sets = `LEFT JOIN ops.staffing_settings ss ON ss.legal_entity_id = r.legal_entity_id`;
      const no_show = (await c.query(
        `${SHIFT_SQL} ${sets} WHERE t.status IN ('assigned','accepted') AND lower(t.service_window) + make_interval(mins => COALESCE(ss.late_grace_minutes, 15)) < now()
            AND upper(t.service_window) > now() - interval '12 hours' ORDER BY lower(t.service_window) LIMIT 200`)).rows;
      const uncovered = (await c.query(
        `${SHIFT_SQL} WHERE t.status = 'ready' AND upper(t.service_window) > now() AND lower(t.service_window) < now() + interval '2 days' ORDER BY lower(t.service_window) LIMIT 200`)).rows;
      const far = (await c.query(
        `${SHIFT_SQL} ${sets} WHERE s.checkin_distance_m > COALESCE(ss.checkin_radius_m, 300) AND s.work_date >= current_date - 7 ORDER BY s.work_date DESC LIMIT 200`)).rows;
      const docs = (await c.query(
        `SELECT p.id AS placement_id, w.display_name AS worker_name, r.ref AS request_ref, cu.name AS customer_name, p.ends_on::text, d.doc_type, d.expires_on::text
           FROM ops.placement p JOIN ops.supply_request r ON r.id = p.request_id JOIN crm.customer cu ON cu.id = r.customer_id JOIN workforce.worker w ON w.id = p.worker_id ${sets}
           JOIN LATERAL (SELECT doc_type, max(expires_on) AS expires_on FROM core.document WHERE worker_id = p.worker_id AND archived_at IS NULL AND expires_on IS NOT NULL
                           AND doc_type = ANY(COALESCE(ss.doc_types, '{driving_license,residency}')) GROUP BY doc_type) d ON true
          WHERE p.active AND p.ends_on >= current_date AND r.canceled_at IS NULL AND (d.expires_on < p.ends_on OR d.expires_on < current_date + 30)
          ORDER BY d.expires_on LIMIT 200`)).rows;
      const ending = (await c.query(
        `SELECT ${REQ_COLS} FROM ${REQ_FROM} WHERE r.canceled_at IS NULL AND r.ends_on BETWEEN (now() AT TIME ZONE le.timezone)::date AND (now() AT TIME ZONE le.timezone)::date + 7 ORDER BY r.ends_on LIMIT 200`)).rows;
      const disputes = (await c.query(
        `SELECT d.id, d.task_id, d.reason, d.raised_at, d.hours_before::float, x.work_date, x.worker_name, x.request_ref, x.check_in, x.check_out
           FROM ops.staffing_dispute d JOIN (${SHIFT_SQL}) x ON x.task_id = d.task_id WHERE d.resolved_at IS NULL ORDER BY d.raised_at LIMIT 200`)).rows;
      return { no_show, uncovered, far, docs, ending, disputes };
    });
  }

  /** Worked days for a period (or a request): the timesheet behind the invoice. */
  @Get('timesheet')
  @Perm('tasks:read')
  timesheet(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string, @Query('request_id') requestId?: string) {
    const f = v.date(from, 'from') ?? (() => { throw new BadRequestException('from required'); })();
    const t = v.date(to, 'to') ?? (() => { throw new BadRequestException('to required'); })();
    if (t < f || Date.parse(t) - Date.parse(f) > 93 * 86_400_000) throw new BadRequestException('period must be up to 93 days');
    const rid = v.uuid(requestId, 'request_id');
    return this.db.withTenant(a, async (c) => ({
      from: f, to: t,
      data: (await c.query(`${SHIFT_SQL} WHERE s.work_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR r.id = $3) ORDER BY s.work_date, w.display_name LIMIT 3000`, [f, t, rid])).rows,
    }));
  }

  /** The office approves worked days on the customer's behalf (e.g. by email). Disputed days are skipped. */
  @Post('approve')
  @HttpCode(200)
  @Perm('tasks:write')
  approve(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const list = ids(b?.task_ids);
    return this.db.withTenant(a, (c) => approveShifts(c, a, list, 'staff', null));
  }

  /** Settles a dispute: the agreed hours replace the recorded ones; the day can then be approved. */
  @Post('disputes/:id/resolve')
  @HttpCode(200)
  @Perm('tasks:write')
  resolve(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const resolution = v.str(b?.resolution, 'resolution', { required: true, max: 500 })!;
    const hours = b?.hours === undefined || b?.hours === null ? null : Number(b.hours);
    if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 24 || Math.abs(hours * 100 - Math.round(hours * 100)) > 1e-6)) throw new BadRequestException('hours must be 0-24 with up to 2 decimals');
    return this.db.withTenant(a, async (c) => {
      const d = (await c.query(
        `SELECT d.id, d.task_id, t.attributes->>'bill_unit' AS bill_unit FROM ops.staffing_dispute d JOIN ops.task t ON t.id = d.task_id WHERE d.id = $1 AND d.resolved_at IS NULL FOR UPDATE OF d`, [id])).rows[0];
      if (!d) throw new NotFoundException();
      if (hours !== null && d.bill_unit === 'day') throw new BadRequestException('this request is billed by the day: resolve without hours');
      if (hours !== null) {
        await c.query(`UPDATE ops.task SET attributes = jsonb_set(attributes, '{quantities}', COALESCE(attributes->'quantities', '{}') || jsonb_build_object('hour', $2::numeric)), version = version + 1 WHERE id = $1`, [d.task_id, hours]);
      }
      await c.query('UPDATE ops.staffing_dispute SET resolution = $2, hours_after = $3, resolved_by = $4, resolved_at = now() WHERE id = $1', [id, resolution, hours, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'staffing.dispute_resolved', targetType: 'task', targetId: d.task_id, after: { resolution, hours } });
      return (await c.query(`${SHIFT_SQL} WHERE s.task_id = $1`, [d.task_id])).rows[0];
    });
  }

  private async request(c: PoolClient, id: string) {
    const r = (await c.query(`SELECT ${REQ_COLS} FROM ${REQ_FROM} WHERE r.id = $1`, [id])).rows[0];
    if (!r) return null;
    const s = await settingsOf(c, r.legal_entity_id);
    const placements = (await c.query(
      `SELECT p.id, p.seq, p.worker_id, w.display_name AS worker_name, p.asset_id, a.plate_no, p.starts_on::text, p.ends_on::text, p.active, p.end_reason,
              (SELECT coalesce(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'expires_on', d.expires_on::text)), '[]') FROM core.document d WHERE d.worker_id = p.worker_id AND d.archived_at IS NULL) AS docs
         FROM ops.placement p JOIN workforce.worker w ON w.id = p.worker_id LEFT JOIN fleet.asset a ON a.id = p.asset_id
        WHERE p.request_id = $1 ORDER BY p.active DESC, p.starts_on, p.seq`, [id])).rows
      .map(({ docs, ...p }) => ({ ...p, eligibility: eligibility(docs, s.doc_types, p.starts_on, p.ends_on) }));
    const shifts = (await c.query(`${SHIFT_SQL} WHERE r.id = $1 AND s.work_date BETWEEN $2::date - 7 AND $2::date + 7 ORDER BY s.work_date, w.display_name`, [id, await today(c, r.legal_entity_id)])).rows;
    return { ...r, placements, shifts };
  }

  private async lock(c: PoolClient, id: string, ver: number) {
    const r = (await c.query('SELECT id, legal_entity_id, canceled_at, version FROM ops.supply_request WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new NotFoundException();
    if (r.version !== ver) throw new ConflictException({ message: 'request changed since you loaded it', current_version: r.version });
    return r;
  }

  private async shiftTask(c: PoolClient, id: string) {
    const t = (await c.query(
      `SELECT t.id, t.status, t.legal_entity_id, s.work_date::text, r.worker_kind, asg.worker_id, asg.asset_id
         FROM ops.staffing_shift s JOIN ops.task t ON t.id = s.task_id JOIN ops.placement p ON p.id = s.placement_id JOIN ops.supply_request r ON r.id = p.request_id
         LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active WHERE s.task_id = $1 FOR UPDATE OF t`, [id])).rows[0];
    if (!t) throw new NotFoundException();
    return t;
  }

  /**
   * Day-shifts for a placement from max(start, today) up to GENERATE_DAYS ahead, on the request's working days, in the
   * legal entity's time zone. Each is a task assigned to the driver (an exclusive booking). Existing days are skipped.
   */
  private async generate(c: PoolClient, a: AuthContext, placementId: string, todayD: string) {
    const days = (await c.query(
      `SELECT g.day::date::text AS work_date, p.seq, p.worker_id, p.asset_id, r.id AS request_id, r.ref, r.legal_entity_id, r.customer_id, r.site_id, r.site, r.bill_unit,
              to_char(r.shift_start, 'HH24:MI') AS shift_start, to_char(r.shift_end, 'HH24:MI') AS shift_end,
              ((g.day::date + r.shift_start) AT TIME ZONE le.timezone) AS win_from,
              ((g.day::date + r.shift_end + CASE WHEN r.shift_end <= r.shift_start THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE le.timezone) AS win_to
         FROM ops.placement p JOIN ops.supply_request r ON r.id = p.request_id JOIN org.legal_entity le ON le.id = r.legal_entity_id
         CROSS JOIN LATERAL generate_series(GREATEST(p.starts_on, $2::date), LEAST(p.ends_on, GREATEST(p.starts_on, $2::date) + $3::int), interval '1 day') g(day)
        WHERE p.id = $1 AND p.active AND r.canceled_at IS NULL AND extract(dow FROM g.day)::int = ANY(r.work_days)
          AND NOT EXISTS (SELECT 1 FROM ops.staffing_shift s WHERE s.placement_id = p.id AND s.work_date = g.day::date)
        ORDER BY g.day`, [placementId, todayD, GENERATE_DAYS - 1])).rows;
    for (const d of days) {
      const task = await createTask(c, a, {
        le: d.legal_entity_id, pack: STAFFING, branch: null, status: 'ready', customer: d.customer_id, site: d.site_id,
        ref: `${d.ref}-${d.seq}-${d.work_date.replaceAll('-', '')}`,
        win: { from: new Date(d.win_from).toISOString(), to: new Date(d.win_to).toISOString() },
        attrs: { request_id: d.request_id, request_ref: d.ref, placement_id: placementId, work_date: d.work_date, bill_unit: d.bill_unit,
          shift: `${d.shift_start}–${d.shift_end}`, dropoff: d.site, address: siteLine(d.site) ?? null },
      });
      await c.query('INSERT INTO ops.staffing_shift (tenant_id, task_id, placement_id, work_date) VALUES ($1,$2,$3,$4)', [a.tenantId, task.id, placementId, d.work_date]);
      await this.assign(c, a, task.id, d.worker_id, d.asset_id, 'ready', null, true);
    }
    return days.length;
  }

  /** Books the driver (and vehicle) for the shift. When they are booked elsewhere the shift stays unassigned and shows as uncovered. */
  private async assign(c: PoolClient, a: AuthContext, taskId: string, workerId: string, assetId: string | null, from: string, note: string | null, soft = false) {
    await c.query('SAVEPOINT asg');
    try {
      await c.query(
        `INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by)
         VALUES ($1,$2,$3,$4,$5,true,(SELECT service_window FROM ops.task WHERE id = $3),$6)`, [randomUUID(), a.tenantId, taskId, workerId, assetId, a.userId]);
      await c.query('RELEASE SAVEPOINT asg');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT asg');
      const k = (e as { constraint?: string }).constraint;
      if (k === 'no_worker_overlap' || k === 'no_asset_overlap') {
        if (soft) return false;
        throw new ConflictException(k === 'no_worker_overlap' ? 'driver already has a booking at this time' : 'vehicle is already booked at this time');
      }
      throw e;
    }
    await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,'assigned',now(),$5,'staff',$6,$7)`,
      [randomUUID(), a.tenantId, taskId, from, a.userId, randomUUID(), note]);
    return true;
  }

  private async endPlacement(c: PoolClient, a: AuthContext, id: string, on: string, reason: string) {
    const p = (await c.query('SELECT id, starts_on::text, ends_on::text FROM ops.placement WHERE id = $1 AND active FOR UPDATE', [id])).rows[0];
    if (!p) throw new NotFoundException();
    if (on > p.ends_on) throw new BadRequestException('end_on is after the placement end');
    const future = (await c.query(
      `SELECT t.id, t.status FROM ops.staffing_shift s JOIN ops.task t ON t.id = s.task_id WHERE s.placement_id = $1 AND s.work_date > $2 AND t.status IN ('ready','assigned','accepted') FOR UPDATE OF t`,
      [id, on])).rows;
    for (const t of future) await cancelTask(c, a, t.id, t.status, `placement ended: ${reason}`);
    if (on < p.starts_on) await c.query('UPDATE ops.placement SET active = false, end_reason = $2 WHERE id = $1', [id, reason]);
    else await c.query('UPDATE ops.placement SET ends_on = $2, end_reason = $3 WHERE id = $1', [id, on, reason]);
    return { id, ends_on: on < p.starts_on ? null : on, removed: on < p.starts_on, shifts_canceled: future.length };
  }
}

async function cancelTask(c: PoolClient, a: AuthContext, taskId: string, from: string, note: string) {
  await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [taskId]);
  await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,'canceled',now(),$5,'staff',$6,$7)`,
    [randomUUID(), a.tenantId, taskId, from, a.userId, randomUUID(), note.slice(0, 500)]);
}

/**
 * Approves completed day-shifts (the core "review"), by the office or by the customer from the portal.
 * A customer may approve only their own days. Days with an open dispute, or not completed, are skipped with a reason.
 */
export async function approveShifts(c: PoolClient, a: AuthContext, taskIds: string[], actor: 'staff' | 'customer', customerId: string | null) {
  const approved: string[] = [];
  const skipped: { task_id: string; reason: string }[] = [];
  for (const id of taskIds) {
    const t = (await c.query(
      `SELECT t.id, t.status, t.customer_id, EXISTS (SELECT 1 FROM ops.staffing_dispute d WHERE d.task_id = t.id AND d.resolved_at IS NULL) AS disputed
         FROM ops.task t JOIN ops.staffing_shift s ON s.task_id = t.id WHERE t.id = $1 FOR UPDATE OF t`, [id])).rows[0];
    if (!t || (customerId && t.customer_id !== customerId)) { skipped.push({ task_id: id, reason: 'not_found' }); continue; }
    if (t.status !== 'completed') { skipped.push({ task_id: id, reason: t.status === 'reviewed' || t.status === 'invoiced' ? 'already_approved' : `not_completed:${t.status}` }); continue; }
    if (t.disputed) { skipped.push({ task_id: id, reason: 'disputed' }); continue; }
    await c.query(`UPDATE ops.task SET status = 'reviewed', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,'completed','reviewed',now(),$4,$5,$6,$7)`,
      [randomUUID(), a.tenantId, id, a.userId, actor, randomUUID(), actor === 'customer' ? 'approved by the customer' : 'hours approved']);
    approved.push(id);
  }
  if (approved.length) await audit(c, { tenantId: a.tenantId, actorId: a.userId, actorType: actor === 'customer' ? 'customer' : 'user', action: 'staffing.approved', targetType: 'task', targetId: approved[0], after: { task_ids: approved } });
  return { approved, skipped };
}
