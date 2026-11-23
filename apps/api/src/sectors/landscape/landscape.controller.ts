import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { isoDow, parseDays } from '../shuttle/shuttle';
import { completion, doneRule, FAULTS, IRRIGATION, LANDSCAPE, LATE_START_MIN, parseServices, SERVICES, Stage, UNCHECKED_STREAK, visitState } from './landscape';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;
const DONE = ['completed', 'reviewed', 'invoiced'];

const SITE_SQL = `
  SELECT s.id, s.legal_entity_id, s.code, s.name, s.customer_id, cu.name AS customer_name, s.area, s.address, s.lat, s.lng, s.contact_phone, s.area_m2, s.services, s.days,
         s.visit_time, s.duration_min, s.lead_worker_id, w.display_name AS lead_name, s.crew_size, s.asset_id, a.plate_no, s.irrigation, s.instructions, s.active, s.version,
         (SELECT count(*)::int FROM ops.ls_visit x WHERE x.site_id = s.id AND x.irrigation IN ('leak','broken','dry_area') AND x.issue_closed_at IS NULL) AS open_faults
    FROM ops.ls_site s JOIN crm.customer cu ON cu.id = s.customer_id LEFT JOIN workforce.worker w ON w.id = s.lead_worker_id LEFT JOIN fleet.asset a ON a.id = s.asset_id`;

const VISIT_SQL = `
  SELECT x.id, x.ref, x.site_id, s.code AS site_code, s.name AS site_name, cu.name AS customer_name, s.area, s.irrigation AS has_irrigation, x.visit_date::text AS visit_date, x.extra,
         x.task_id, t.status AS task_status, lower(t.service_window) AS start_at, upper(t.service_window) AS end_by, x.lead_worker_id, w.display_name AS lead_name, x.asset_id, a.plate_no,
         x.services_planned, x.arrived_at, x.done_at, x.services_done, x.irrigation, x.waste_bags, x.received_by, x.result_note, x.issue_closed_at, x.issue_close_note, x.version,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'in_progress') AS started_at,
         (SELECT e.reason_code FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed' ORDER BY e.occurred_at DESC LIMIT 1) AS fail_reason
    FROM ops.ls_visit x JOIN ops.ls_site s ON s.id = x.site_id JOIN crm.customer cu ON cu.id = s.customer_id JOIN ops.task t ON t.id = x.task_id
    JOIN workforce.worker w ON w.id = x.lead_worker_id LEFT JOIN fleet.asset a ON a.id = x.asset_id`;

interface SiteRow { id: string; legal_entity_id: string; code: string; name: string; customer_id: string; customer_name: string; area: string | null; address: string | null;
  lat: number | null; lng: number | null; contact_phone: string | null; area_m2: number | null; services: string[]; days: number[]; visit_time: string; duration_min: number;
  lead_worker_id: string | null; crew_size: number; asset_id: string | null; irrigation: boolean; instructions: string | null; active: boolean; version: number }

type VisitRow = Record<string, unknown> & { arrived_at: unknown; done_at: unknown; task_status: string };
const shape = <T extends VisitRow>(x: T) => ({ ...x, state: visitState(x, x.task_status) });

const isFault = (x: { irrigation?: unknown; issue_closed_at?: unknown }) => FAULTS.includes(String(x.irrigation)) && !x.issue_closed_at;

/**
 * The crew lead's stages: arrived, then done with the services carried out, the irrigation state, the green waste bags
 * and an optional receiver's name. Returns a reject code.
 */
export async function landscapeStage(c: PoolClient, taskId: string, code: Stage, x: { at: Date; services: unknown; irrigation: string | null; bags: number | null;
  receivedBy: string | null; note: string | null }): Promise<string | null> {
  const j = (await c.query('SELECT x.id, x.services_planned, s.irrigation AS has FROM ops.ls_visit x JOIN ops.ls_site s ON s.id = x.site_id WHERE x.task_id = $1 FOR UPDATE OF x', [taskId])).rows[0];
  if (!j) return 'not_supported';
  if (code === 'ls_arrived') {
    await c.query('UPDATE ops.ls_visit SET arrived_at = $2, version = version + 1 WHERE id = $1', [j.id, x.at]);
    return null;
  }
  let done: string[];
  try { done = parseServices(x.services, 'services', 0); } catch { return 'services_invalid'; }
  if (x.irrigation && !(IRRIGATION as readonly string[]).includes(x.irrigation)) return 'irrigation_required';
  const bad = doneRule({ planned: j.services_planned, done, irrigation: x.irrigation, hasIrrigation: j.has, bags: x.bags, note: x.note });
  if (bad) return bad;
  await c.query(`UPDATE ops.ls_visit SET done_at = $2, services_done = $3, irrigation = $4, waste_bags = $5, received_by = $6, result_note = $7, version = version + 1 WHERE id = $1`,
    [j.id, x.at, done, j.has ? x.irrigation : (x.irrigation ?? null), x.bags, x.receivedBy?.trim() || null, x.note?.trim() || null]);
  return null;
}

/** A visit ends with the work recorded. */
export async function landscapeFinish(c: PoolClient, taskId: string): Promise<string | null> {
  const j = (await c.query('SELECT done_at FROM ops.ls_visit WHERE task_id = $1', [taskId])).rows[0];
  if (!j) return null;
  return j.done_at ? null : 'proof_required';
}

@Controller('v1/landscape')
@UseGuards(AuthGuard)
@Pack('landscape')
export class LandscapeController {
  constructor(private readonly db: DbService) {}

  // ---- gardens ----

  @Get('sites')
  @Perm('tasks:read')
  sites(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`${SITE_SQL} ORDER BY s.active DESC, s.code`)).rows }));
  }

  @Post('sites')
  @Perm('tasks:assign')
  addSite(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const code = String(b?.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(code)) throw new BadRequestException('code: 1-12 letters, digits, - or _');
    const s = this.parseSite(b, null);
    return this.db.withTenant(a, async (c) => {
      await this.checkRefs(c, le, s);
      const id = randomUUID();
      try {
        await c.query(`INSERT INTO ops.ls_site (id, tenant_id, legal_entity_id, code, name, customer_id, area, address, lat, lng, contact_phone, area_m2, services, days, visit_time, duration_min,
                         lead_worker_id, crew_size, asset_id, irrigation, instructions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [id, a.tenantId, le, code, s.name, s.customer_id, s.area, s.address, s.lat, s.lng, s.contact_phone, s.area_m2, s.services, s.days, s.visit_time, s.duration_min,
            s.lead_worker_id, s.crew_size, s.asset_id, s.irrigation, s.instructions]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'ls_site_tenant_id_code_key') throw new ConflictException('site code already used');
        pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'landscape.site_created', targetType: 'ls_site', targetId: id, after: { code, services: s.services } });
      return (await c.query(`${SITE_SQL} WHERE s.id = $1`, [id])).rows[0];
    });
  }

  /** Changes a garden (version required). Visits already generated keep their crew, vehicle, time and services. */
  @Patch('sites/:id')
  @Perm('tasks:assign')
  editSite(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`${SITE_SQL} WHERE s.id = $1`, [id])).rows[0] as SiteRow;
      if (!before) throw new NotFoundException();
      if (before.version !== ver) throw new ConflictException('site changed meanwhile; reload');
      const s = this.parseSite(b, before);
      await this.checkRefs(c, before.legal_entity_id, s);
      if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
      const active = (b?.active as boolean | undefined) ?? before.active;
      await c.query(`UPDATE ops.ls_site SET name = $2, customer_id = $3, area = $4, address = $5, lat = $6, lng = $7, contact_phone = $8, area_m2 = $9, services = $10, days = $11,
                       visit_time = $12, duration_min = $13, lead_worker_id = $14, crew_size = $15, asset_id = $16, irrigation = $17, instructions = $18, active = $19, version = version + 1 WHERE id = $1`,
        [id, s.name, s.customer_id, s.area, s.address, s.lat, s.lng, s.contact_phone, s.area_m2, s.services, s.days, s.visit_time, s.duration_min, s.lead_worker_id, s.crew_size,
          s.asset_id, s.irrigation, s.instructions, active]);
      const after = (await c.query(`${SITE_SQL} WHERE s.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'landscape.site_changed', targetType: 'ls_site', targetId: id, before, after });
      return after;
    });
  }

  // ---- visits ----

  /**
   * Generates the visits of a day: one per garden visited that day. Idempotent: a garden that already has its visit is
   * reported as existing. A garden without a crew lead, a visit already over, or a lead or vehicle booked elsewhere is
   * skipped with the reason.
   */
  @Post('visits/generate')
  @Perm('tasks:assign')
  generate(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const day = v.date(b?.date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const sites = (await c.query(`${SITE_SQL} WHERE s.active AND $1 = ANY (s.days) ORDER BY s.visit_time, s.code`, [isoDow(day)])).rows as SiteRow[];
      const created: string[] = [], existing: string[] = [], skipped: { site: string; reason: string }[] = [];
      for (const s of sites) {
        if ((await c.query('SELECT 1 FROM ops.ls_visit WHERE site_id = $1 AND visit_date = $2 AND NOT extra', [s.id, day])).rowCount) { existing.push(s.code); continue; }
        if (!s.lead_worker_id) { skipped.push({ site: s.code, reason: 'no_lead' }); continue; }
        const r = await this.visitFor(c, a, s, { day, time: s.visit_time, services: s.services, extra: false, lead: s.lead_worker_id, asset: s.asset_id, note: null });
        if (typeof r === 'string') skipped.push({ site: s.code, reason: r }); else created.push(r.ref);
      }
      return { date: day, created, existing, skipped };
    });
  }

  /** An extra visit outside the schedule (planting, a clean-up after an event), with its own services and crew. */
  @Post('visits')
  @Perm('tasks:assign')
  addVisit(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const site = v.uuid(b?.site_id, 'site_id', { required: true })!;
    const day = v.date(b?.date, 'date') ?? (() => { throw new BadRequestException('date required'); })();
    const time = b?.time === undefined || b?.time === null ? null : String(b.time);
    if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequestException('time must be HH:MM');
    const lead = v.uuid(b?.lead_worker_id, 'lead_worker_id');
    const asset = v.uuid(b?.asset_id, 'asset_id');
    const note = v.str(b?.note, 'note', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      const s = (await c.query(`${SITE_SQL} WHERE s.id = $1`, [site])).rows[0] as SiteRow | undefined;
      if (!s) throw new BadRequestException('unknown site_id');
      if (!s.active) throw new ConflictException('the garden is not active');
      const services = b?.services === undefined ? s.services : parseServices(b.services);
      const who = lead ?? s.lead_worker_id;
      if (!who) throw new BadRequestException('lead_worker_id required: the garden has no crew lead');
      await this.checkRefs(c, s.legal_entity_id, { customer_id: s.customer_id, lead_worker_id: who, asset_id: asset ?? s.asset_id });
      const r = await this.visitFor(c, a, s, { day, time: time ?? s.visit_time, services, extra: true, lead: who, asset: asset ?? s.asset_id, note });
      if (typeof r === 'string') throw new ConflictException(r);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'landscape.extra_visit', targetType: 'ls_visit', targetId: r.id, after: { ref: r.ref, services } });
      return this.visit(c, r.id);
    });
  }

  @Get('visits')
  @Perm('tasks:read')
  visits(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({ date: day, data: (await c.query(`${VISIT_SQL} WHERE x.visit_date = $1 ORDER BY lower(t.service_window), s.code`, [day])).rows.map(shape) }));
  }

  @Get('visits/:id')
  @Perm('tasks:read')
  getVisit(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.visit(c, id));
  }

  @Post('visits/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT t.id, t.status FROM ops.ls_visit x JOIN ops.task t ON t.id = x.task_id WHERE x.id = $1 FOR UPDATE OF t', [id])).rows[0];
      if (!t) throw new NotFoundException();
      if (t.status !== 'canceled') {
        if (!['ready', 'assigned', 'accepted'].includes(t.status)) throw new ConflictException('the visit is under way or closed');
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t.id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [t.id]);
        await this.event(c, a, t.id, t.status, 'canceled', reason);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'landscape.visit_canceled', targetType: 'ls_visit', targetId: id, after: { reason } });
      }
      return this.visit(c, id);
    });
  }

  /** Closes an irrigation fault found on a visit, with what was done (repaired, parts ordered, customer informed...). */
  @Post('visits/:id/close-fault')
  @HttpCode(200)
  @Perm('tasks:assign')
  closeFault(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const note = v.str(b?.note, 'note', { required: true, max: 500 })!.trim();
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query('SELECT irrigation, issue_closed_at FROM ops.ls_visit WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!x) throw new NotFoundException();
      if (!FAULTS.includes(x.irrigation)) throw new ConflictException('no irrigation fault on this visit');
      if (x.issue_closed_at) throw new ConflictException('fault already closed');
      await c.query('UPDATE ops.ls_visit SET issue_closed_at = now(), issue_close_note = $2, issue_closed_by = $3, version = version + 1 WHERE id = $1', [id, note, a.userId || null]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'landscape.fault_closed', targetType: 'ls_visit', targetId: id, after: { note } });
      return this.visit(c, id);
    });
  }

  // ---- watch and report ----

  /**
   * For a day: visits late to start, gardens due that day without a crew lead, planned services left undone in the last
   * 7 days, open irrigation faults, and gardens whose irrigation was not checked on the last visits in a row.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const today = (await c.query(`${VISIT_SQL} WHERE x.visit_date = $1`, [day])).rows.map(shape);
      const due = (await c.query(`${SITE_SQL} WHERE s.active AND $1 = ANY (s.days) AND s.lead_worker_id IS NULL ORDER BY s.code`, [isoDow(day)])).rows;
      const undone = (await c.query(`${VISIT_SQL} WHERE x.visit_date BETWEEN $1::date - 6 AND $1 AND x.done_at IS NOT NULL AND NOT (x.services_planned <@ x.services_done)
                                       ORDER BY x.visit_date DESC, s.code`, [day])).rows.map((x) => ({ ...shape(x), missing: (x.services_planned as string[]).filter((s) => !(x.services_done as string[]).includes(s)) }));
      const faults = (await c.query(`${VISIT_SQL} WHERE x.irrigation IN ('leak','broken','dry_area') AND x.issue_closed_at IS NULL ORDER BY x.visit_date, s.code LIMIT 100`)).rows.map(shape);
      const streak = (await c.query(
        `WITH last AS (SELECT x.site_id, x.irrigation, row_number() OVER (PARTITION BY x.site_id ORDER BY x.visit_date DESC, x.created_at DESC) AS k
                         FROM ops.ls_visit x WHERE x.visit_date <= $1 AND x.done_at IS NOT NULL)
         SELECT s.id AS site_id, s.code AS site_code, s.name AS site_name, cu.name AS customer_name, count(*)::int AS visits
           FROM last l JOIN ops.ls_site s ON s.id = l.site_id JOIN crm.customer cu ON cu.id = s.customer_id
          WHERE l.k <= $2 AND s.irrigation AND s.active AND l.irrigation = 'not_checked'
          GROUP BY s.id, s.code, s.name, cu.name HAVING count(*) >= $2 ORDER BY s.code`, [day, UNCHECKED_STREAK])).rows;
      return {
        date: day,
        late_start: today.filter((x) => x.state === 'assigned' && new Date(x.start_at as string).getTime() + LATE_START_MIN * 60_000 < Date.now()),
        no_lead: due,
        services_undone: undone,
        open_faults: faults,
        irrigation_unchecked: streak,
      };
    });
  }

  /** For a period: visits, done, services carried out against planned, green waste and irrigation faults, in total, per garden and per service. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const visits = (await c.query(`${VISIT_SQL} WHERE x.visit_date BETWEEN $1 AND $2 AND t.status <> 'canceled'`, [f, t])).rows.map(shape);
      const sum = (l: typeof visits) => {
        const done = l.filter((x) => x.state === 'done');
        const planned = done.reduce((n, x) => n + (x.services_planned as string[]).length, 0);
        const carried = done.reduce((n, x) => n + (x.services_planned as string[]).filter((s) => (x.services_done as string[]).includes(s)).length, 0);
        return { visits: l.length, done: done.length, failed: l.filter((x) => x.state === 'failed').length, extra: l.filter((x) => x.extra).length,
          late: l.filter((x) => x.started_at && new Date(x.started_at as string).getTime() - new Date(x.start_at as string).getTime() > LATE_START_MIN * 60_000).length,
          services_planned: planned, services_done: carried, completion: completion(planned, carried),
          waste_bags: done.reduce((n, x) => n + ((x.waste_bags as number) ?? 0), 0), faults: l.filter((x) => FAULTS.includes(String(x.irrigation))).length, open_faults: l.filter(isFault).length };
      };
      const codes = [...new Set(visits.map((x) => x.site_code as string))].sort();
      const svc = new Map<string, { planned: number; done: number }>();
      for (const x of visits.filter((y) => y.state === 'done')) {
        for (const s of x.services_planned as string[]) { const m = svc.get(s) ?? { planned: 0, done: 0 }; m.planned++; svc.set(s, m); }
        for (const s of x.services_done as string[]) { const m = svc.get(s) ?? { planned: 0, done: 0 }; m.done++; svc.set(s, m); }
      }
      return {
        from: f, to: t, totals: sum(visits),
        sites: codes.map((code) => {
          const l = visits.filter((x) => x.site_code === code);
          return { site_code: code, site_name: l[0].site_name, customer_name: l[0].customer_name, ...sum(l) };
        }),
        services: SERVICES.filter((s) => svc.has(s)).map((s) => ({ key: s, ...svc.get(s)! })),
      };
    });
  }

  // ---- helpers ----

  private async visit(c: PoolClient, id: string) {
    const x = (await c.query(`${VISIT_SQL} WHERE x.id = $1`, [id])).rows[0];
    if (!x) throw new NotFoundException();
    return shape(x);
  }

  private parseSite(b: Record<string, unknown>, prev: SiteRow | null) {
    const pick = <T>(k: string, f: (x: unknown) => T, old: T | undefined): T => (b?.[k] === undefined && prev ? (old as T) : f(b?.[k]));
    const lat = pick('lat', (x) => (x === undefined || x === null ? null : Number(x)), prev?.lat ?? null);
    const lng = pick('lng', (x) => (x === undefined || x === null ? null : Number(x)), prev?.lng ?? null);
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng!) || Math.abs(lng!) > 180))) throw new BadRequestException('lat/lng invalid');
    const time = pick('visit_time', (x) => (x === undefined || x === null ? '07:00' : String(x)), prev?.visit_time);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequestException('visit_time must be HH:MM');
    const irrigation = pick('irrigation', (x) => (x === undefined || x === null ? true : x), prev?.irrigation);
    if (typeof irrigation !== 'boolean') throw new BadRequestException('irrigation must be true/false');
    return {
      name: pick('name', (x) => v.str(x, 'name', { required: true, max: 120 })!.trim(), prev?.name),
      customer_id: pick('customer_id', (x) => v.uuid(x, 'customer_id', { required: true })!, prev?.customer_id),
      area: pick('area', (x) => v.str(x, 'area', { max: 80 }), prev?.area),
      address: pick('address', (x) => v.str(x, 'address', { max: 200 }), prev?.address),
      lat, lng,
      contact_phone: pick('contact_phone', (x) => v.str(x, 'contact_phone', { max: 20 }), prev?.contact_phone),
      area_m2: pick('area_m2', (x) => v.int(x, 'area_m2', 1, 10_000_000), prev?.area_m2),
      services: pick('services', (x) => parseServices(x), prev?.services),
      days: pick('days', (x) => (x === undefined || x === null ? [1, 4] : parseDays(x)), prev?.days),
      visit_time: time,
      duration_min: pick('duration_min', (x) => v.int(x, 'duration_min', 15, 720) ?? 120, prev?.duration_min),
      lead_worker_id: pick('lead_worker_id', (x) => v.uuid(x, 'lead_worker_id'), prev?.lead_worker_id),
      crew_size: pick('crew_size', (x) => v.int(x, 'crew_size', 1, 50) ?? 2, prev?.crew_size),
      asset_id: pick('asset_id', (x) => v.uuid(x, 'asset_id'), prev?.asset_id),
      irrigation,
      instructions: pick('instructions', (x) => v.str(x, 'instructions', { max: 500 }), prev?.instructions),
    };
  }

  private async checkRefs(c: PoolClient, le: string, s: { customer_id: string; asset_id: string | null; lead_worker_id: string | null }) {
    if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
    if (!(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [s.customer_id, le])).rowCount) throw new BadRequestException('unknown customer_id');
    if (s.asset_id && !(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2', [s.asset_id, le])).rowCount) throw new BadRequestException('unknown asset_id');
    if (s.lead_worker_id && !(await c.query('SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2', [s.lead_worker_id, le])).rowCount) throw new BadRequestException('unknown lead_worker_id');
  }

  /** One visit: the task, the exclusive booking of the crew lead (and vehicle), and the visit row. Returns a skip reason or the visit. */
  private async visitFor(c: PoolClient, a: AuthContext, s: SiteRow, x: { day: string; time: string; services: string[]; extra: boolean; lead: string; asset: string | null; note: string | null }):
    Promise<string | { id: string; ref: string }> {
    if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND status = 'active'`, [x.lead])).rowCount) return 'lead_inactive';
    if (x.asset) {
      const asset = (await c.query('SELECT status FROM fleet.asset WHERE id = $1', [x.asset])).rows[0];
      if (!asset || ['out_of_service', 'retired'].includes(asset.status)) return 'vehicle_out_of_service';
    }
    const win = (await c.query(`SELECT ($1::date + $2::time) AT TIME ZONE le.timezone AS f FROM org.legal_entity le WHERE le.id = $3`, [x.day, x.time, s.legal_entity_id])).rows[0];
    const from = new Date(win.f), to = new Date(from.getTime() + s.duration_min * 60_000);
    if (to.getTime() < Date.now()) return 'past';
    let ref = `LV-${s.code}-${x.day.replace(/-/g, '')}`;
    if (x.extra) {
      const n = (await c.query('SELECT count(*)::int AS n FROM ops.ls_visit WHERE site_id = $1 AND visit_date = $2 AND extra', [s.id, x.day])).rows[0].n;
      ref = `${ref}-${n + 1}`;
    }
    await c.query('SAVEPOINT visit');
    try {
      const task = await createTask(c, a, {
        le: s.legal_entity_id, pack: LANDSCAPE, branch: null, status: 'ready', customer: s.customer_id, site: null, ref,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { kind: 'garden_visit', site_code: s.code, site_name: s.name, customer_name: s.customer_name, contact_phone: s.contact_phone, services: x.services,
          irrigation: s.irrigation, crew_size: s.crew_size, area_m2: s.area_m2, extra: x.extra, instructions: [s.instructions, x.note].filter(Boolean).join(' · ') || null,
          address: [s.address, s.area].filter(Boolean).join('، ') || s.name, ...(s.lat !== null ? { dropoff: { name: s.name, lat: s.lat, lng: s.lng } } : {}) },
      });
      await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
        [randomUUID(), a.tenantId, task.id, x.lead, x.asset, from.toISOString(), to.toISOString(), a.userId]);
      const id = randomUUID();
      await c.query(`INSERT INTO ops.ls_visit (id, tenant_id, site_id, ref, visit_date, extra, task_id, lead_worker_id, asset_id, services_planned, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, a.tenantId, s.id, ref, x.day, x.extra, task.id, x.lead, x.asset, x.services, a.userId]);
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await this.event(c, a, task.id, 'ready', 'assigned', `${ref} ${s.name}`);
      await c.query('RELEASE SAVEPOINT visit');
      return { id, ref };
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT visit');
      const k = (e as { constraint?: string }).constraint;
      if (k === 'no_asset_overlap') return 'vehicle_booked';
      if (k === 'no_worker_overlap') return 'lead_booked';
      throw e;
    }
  }

  private async event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
  }
}
