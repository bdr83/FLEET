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
import { CATEGORIES, coverage, finishBlock, LATE_START_MIN, parseTag, parseTimes, scanRule, ScanEvent, SCAN_EVENTS, SECURITY, SEVERITIES, SKIP_REASONS, SKIP_STREAK } from './security';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const DAY = 86_400_000;

const SITE_SQL = `
  SELECT s.id, s.legal_entity_id, s.code, s.name, s.customer_id, cu.name AS customer_name, s.area, s.address, s.lat, s.lng, s.patrol_times, s.duration_min, s.days,
         s.guard_worker_id, w.display_name AS guard_name, s.asset_id, a.plate_no, s.instructions, s.active, s.version,
         (SELECT count(*)::int FROM ops.sec_checkpoint k WHERE k.site_id = s.id AND k.active) AS checkpoints,
         (SELECT count(*)::int FROM ops.sec_incident i WHERE i.site_id = s.id AND i.closed_at IS NULL) AS open_incidents
    FROM ops.sec_site s LEFT JOIN crm.customer cu ON cu.id = s.customer_id LEFT JOIN workforce.worker w ON w.id = s.guard_worker_id LEFT JOIN fleet.asset a ON a.id = s.asset_id`;

const CP_COLS = `k.id, k.site_id, k.seq, k.name, k.tag, k.note, k.active`;

// each checkpoint's standing mark on a patrol is the latest one
const MARKS = `SELECT DISTINCT ON (x.patrol_id, x.checkpoint_id) x.patrol_id, x.checkpoint_id, x.event, x.reason, x.note, x.occurred_at, x.source FROM ops.sec_scan x`;

const PATROL_SQL = `
  SELECT p.id, p.site_id, s.code AS site_code, s.name AS site_name, cu.name AS customer_name, p.patrol_date::text AS patrol_date, p.slot, p.task_id, t.status,
         lower(t.service_window) AS start_at, upper(t.service_window) AS end_by, p.guard_worker_id, w.display_name AS guard_name, p.asset_id, a.plate_no, p.checkpoints_planned,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'in_progress') AS started_at,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') AS ended_at,
         (SELECT count(*)::int FROM (${MARKS} WHERE x.patrol_id = p.id ORDER BY x.patrol_id, x.checkpoint_id, x.occurred_at DESC) m WHERE m.event = 'scanned') AS scanned,
         (SELECT count(*)::int FROM (${MARKS} WHERE x.patrol_id = p.id ORDER BY x.patrol_id, x.checkpoint_id, x.occurred_at DESC) m WHERE m.event = 'skipped') AS skipped,
         (SELECT count(*)::int FROM ops.sec_incident i WHERE i.patrol_id = p.id) AS incidents
    FROM ops.sec_patrol p JOIN ops.sec_site s ON s.id = p.site_id LEFT JOIN crm.customer cu ON cu.id = s.customer_id JOIN ops.task t ON t.id = p.task_id
    JOIN workforce.worker w ON w.id = p.guard_worker_id LEFT JOIN fleet.asset a ON a.id = p.asset_id`;

const INCIDENT_SQL = `
  SELECT i.id, i.ref, i.site_id, s.code AS site_code, s.name AS site_name, cu.name AS customer_name, i.patrol_id, p.slot, i.category, i.severity, i.description,
         i.occurred_at, i.source, coalesce(w.display_name, u.display_name) AS reported_by_name, i.closed_at, i.close_note, i.version
    FROM ops.sec_incident i JOIN ops.sec_site s ON s.id = i.site_id LEFT JOIN crm.customer cu ON cu.id = s.customer_id LEFT JOIN ops.sec_patrol p ON p.id = i.patrol_id
    LEFT JOIN workforce.worker w ON w.id = p.guard_worker_id AND i.source = 'guard' LEFT JOIN org.app_user u ON u.id = i.reported_by AND i.source = 'office'`;

interface SiteRow { id: string; legal_entity_id: string; code: string; name: string; customer_id: string | null; area: string | null; address: string | null; lat: number | null; lng: number | null;
  patrol_times: string[]; duration_min: number; days: number[]; guard_worker_id: string | null; asset_id: string | null; instructions: string | null; active: boolean; version: number; checkpoints: number }

/** The checkpoints of a patrol with their standing mark: the sheet the guard and the office see. */
export async function patrolSheet(c: PoolClient, patrolId: string) {
  return (await c.query(
    `SELECT ${CP_COLS}, m.event, m.reason, m.note AS mark_note, m.occurred_at AS marked_at, m.source
       FROM ops.sec_patrol p JOIN ops.sec_checkpoint k ON k.site_id = p.site_id
       LEFT JOIN (${MARKS} WHERE x.patrol_id = $1 ORDER BY x.patrol_id, x.checkpoint_id, x.occurred_at DESC) m ON m.checkpoint_id = k.id
      WHERE p.id = $1 AND (k.active OR m.event IS NOT NULL) ORDER BY k.seq, k.name`, [patrolId])).rows;
}

const patrolOf = async (c: PoolClient, taskId: string) =>
  (await c.query('SELECT p.id, p.site_id, t.status FROM ops.sec_patrol p JOIN ops.task t ON t.id = p.task_id WHERE p.task_id = $1', [taskId])).rows[0] as { id: string; site_id: string; status: string } | undefined;

const allowed = (source: 'guard' | 'office') => (source === 'guard' ? ['in_progress'] : ['assigned', 'accepted', 'in_progress', 'completed', 'reviewed']);

/** Marks a checkpoint scanned (the guard must give its tag) or skipped (with a reason). Returns a reject code. */
export async function markScan(c: PoolClient, a: AuthContext, x: { taskId: string; checkpointId: string; event: ScanEvent; tag: string | null; reason: string | null; note: string | null;
  at: Date; lat?: number | null; lng?: number | null; source: 'guard' | 'office'; clientOpId: string }): Promise<string | null> {
  const p = await patrolOf(c, x.taskId);
  if (!p) return 'not_supported';
  if (!allowed(x.source).includes(p.status)) return 'invalid_transition';
  const k = (await c.query('SELECT tag FROM ops.sec_checkpoint WHERE id = $1 AND site_id = $2', [x.checkpointId, p.site_id])).rows[0];
  if (!k) return 'unknown_checkpoint';
  const bad = scanRule(x.event, x.tag, k.tag, x.reason, x.source);
  if (bad) return bad;
  await c.query(`INSERT INTO ops.sec_scan (id, tenant_id, patrol_id, checkpoint_id, event, reason, note, occurred_at, lat, lng, source, actor_id, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), a.tenantId, p.id, x.checkpointId, x.event, x.event === 'skipped' ? x.reason : null, x.note, x.at, x.lat ?? null, x.lng ?? null, x.source, a.userId || null, x.clientOpId]);
  return null;
}

async function insertIncident(c: PoolClient, a: AuthContext, x: { siteId: string; patrolId: string | null; category: string; severity: string; description: string; at: Date;
  lat?: number | null; lng?: number | null; source: 'guard' | 'office'; clientOpId: string }) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('sec_incident:' || $1))`, [a.tenantId]);
  const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.sec_incident`)).rows[0].n;
  const id = randomUUID();
  await c.query(`INSERT INTO ops.sec_incident (id, tenant_id, site_id, patrol_id, ref, category, severity, description, occurred_at, lat, lng, source, reported_by, client_op_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, a.tenantId, x.siteId, x.patrolId, `IN-${n}`, x.category, x.severity, x.description, x.at, x.lat ?? null, x.lng ?? null, x.source, a.userId || null, x.clientOpId]);
  return id;
}

/** The guard reports an incident during a patrol. Returns a reject code. */
export async function reportIncident(c: PoolClient, a: AuthContext, x: { taskId: string; category: string | null; severity: string | null; description: string | null; at: Date;
  lat?: number | null; lng?: number | null; clientOpId: string }): Promise<string | null> {
  const p = await patrolOf(c, x.taskId);
  if (!p) return 'not_supported';
  if (p.status !== 'in_progress') return 'invalid_transition';
  if (!x.category) return 'category_required';
  if (!x.description) return 'description_required';
  await insertIncident(c, a, { siteId: p.site_id, patrolId: p.id, category: x.category, severity: x.severity ?? 'medium', description: x.description, at: x.at, lat: x.lat, lng: x.lng, source: 'guard', clientOpId: x.clientOpId });
  return null;
}

/** A patrol ends with every checkpoint marked. */
export async function securityFinish(c: PoolClient, taskId: string): Promise<string | null> {
  const p = await patrolOf(c, taskId);
  if (!p) return null;
  const sheet = await patrolSheet(c, p.id);
  return finishBlock(sheet.filter((k) => k.active).map((k) => k.id), sheet.filter((k) => k.event).map((k) => k.id));
}

@Controller('v1/security')
@UseGuards(AuthGuard)
@Pack('security')
export class SecurityController {
  constructor(private readonly db: DbService) {}

  // ---- sites and checkpoints ----

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
        await c.query(`INSERT INTO ops.sec_site (id, tenant_id, legal_entity_id, code, name, customer_id, area, address, lat, lng, patrol_times, duration_min, days, guard_worker_id, asset_id, instructions)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, a.tenantId, le, code, s.name, s.customer_id, s.area, s.address, s.lat, s.lng, s.patrol_times, s.duration_min, s.days, s.guard_worker_id, s.asset_id, s.instructions]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'sec_site_tenant_id_code_key') throw new ConflictException('site code already used');
        pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'security.site_created', targetType: 'sec_site', targetId: id, after: { code } });
      return (await c.query(`${SITE_SQL} WHERE s.id = $1`, [id])).rows[0];
    });
  }

  /** Changes a site (version required). Patrols already generated keep their guard, car and time. */
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
      const active = b?.active === undefined ? before.active : b.active === true;
      await c.query(`UPDATE ops.sec_site SET name = $2, customer_id = $3, area = $4, address = $5, lat = $6, lng = $7, patrol_times = $8, duration_min = $9, days = $10,
          guard_worker_id = $11, asset_id = $12, instructions = $13, active = $14, version = version + 1 WHERE id = $1`,
        [id, s.name, s.customer_id, s.area, s.address, s.lat, s.lng, s.patrol_times, s.duration_min, s.days, s.guard_worker_id, s.asset_id, s.instructions, active]);
      const after = (await c.query(`${SITE_SQL} WHERE s.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'security.site_changed', targetType: 'sec_site', targetId: id, before, after });
      return after;
    });
  }

  @Get('sites/:id/checkpoints')
  @Perm('tasks:read')
  checkpoints(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`SELECT ${CP_COLS} FROM ops.sec_checkpoint k WHERE k.site_id = $1 ORDER BY k.active DESC, k.seq, k.name`, [id])).rows }));
  }

  /** Adds a checkpoint at the end of the patrol (or at seq, moving the later ones down). */
  @Post('sites/:id/checkpoints')
  @Perm('tasks:assign')
  addCheckpoint(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!.trim();
    const tag = parseTag(b?.tag);
    const note = v.str(b?.note, 'note', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.sec_site WHERE id = $1 FOR UPDATE', [id])).rowCount) throw new NotFoundException();
      const n = (await c.query('SELECT count(*)::int AS n FROM ops.sec_checkpoint WHERE site_id = $1 AND active', [id])).rows[0].n;
      if (n >= 100) throw new ConflictException('a site holds up to 100 checkpoints');
      if ((await c.query('SELECT 1 FROM ops.sec_checkpoint WHERE site_id = $1 AND active AND tag = $2', [id, tag])).rowCount) throw new ConflictException('tag already used on this site');
      const seq = Math.min(v.int(b?.seq, 'seq', 1, 100) ?? n + 1, n + 1);
      await c.query('UPDATE ops.sec_checkpoint SET seq = seq + 1 WHERE site_id = $1 AND active AND seq >= $2', [id, seq]);
      const kid = randomUUID();
      await c.query(`INSERT INTO ops.sec_checkpoint (id, tenant_id, site_id, seq, name, tag, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [kid, a.tenantId, id, seq, name, tag, note]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'security.checkpoint_added', targetType: 'sec_checkpoint', targetId: kid, after: { site: id, seq, name, tag } });
      return (await c.query(`SELECT ${CP_COLS} FROM ops.sec_checkpoint k WHERE k.id = $1`, [kid])).rows[0];
    });
  }

  /** Changes a checkpoint's name, tag or note, or takes it off the patrol (active false). */
  @Patch('checkpoints/:id')
  @Perm('tasks:assign')
  editCheckpoint(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query('SELECT * FROM ops.sec_checkpoint WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!x) throw new NotFoundException();
      const name = v.str(b?.name, 'name', { max: 120 }) ?? x.name;
      const tag = b?.tag === undefined ? x.tag : parseTag(b.tag);
      const note = b?.note === undefined ? x.note : v.str(b.note, 'note', { max: 300 });
      if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
      const active = b?.active ?? x.active;
      if (active && tag !== x.tag && (await c.query('SELECT 1 FROM ops.sec_checkpoint WHERE site_id = $1 AND active AND tag = $2 AND id <> $3', [x.site_id, tag, id])).rowCount) {
        throw new ConflictException('tag already used on this site');
      }
      if (x.active && !active) await c.query('UPDATE ops.sec_checkpoint SET seq = seq - 1 WHERE site_id = $1 AND active AND seq > $2', [x.site_id, x.seq]);
      await c.query('UPDATE ops.sec_checkpoint SET name = $2, tag = $3, note = $4, active = $5 WHERE id = $1', [id, name, tag, note, active]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'security.checkpoint_changed', targetType: 'sec_checkpoint', targetId: id, before: x, after: { name, tag, note, active } });
      return (await c.query(`SELECT ${CP_COLS} FROM ops.sec_checkpoint k WHERE k.id = $1`, [id])).rows[0];
    });
  }

  // ---- patrols ----

  /**
   * Generates the patrols of a day: one per patrol time of each site running that day. Idempotent: a time that already
   * has its patrol is reported as existing. A site without a guard or checkpoints, a time already over, or a guard or car
   * booked elsewhere is skipped with the reason.
   */
  @Post('patrols/generate')
  @Perm('tasks:assign')
  generate(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const day = v.date(b?.date, 'date') ?? kwToday();
    const dow = isoDow(day);
    return this.db.withTenant(a, async (c) => {
      const sites = (await c.query(`${SITE_SQL} WHERE s.active AND $1 = ANY (s.days) AND cardinality(s.patrol_times) > 0 ORDER BY s.code`, [dow])).rows as SiteRow[];
      const created: string[] = [], existing: string[] = [], skipped: { patrol: string; reason: string }[] = [];
      for (const s of sites) {
        for (const slot of s.patrol_times) {
          const key = `${s.code} ${slot}`;
          if ((await c.query('SELECT 1 FROM ops.sec_patrol WHERE site_id = $1 AND patrol_date = $2 AND slot = $3', [s.id, day, slot])).rowCount) { existing.push(key); continue; }
          if (!s.guard_worker_id) { skipped.push({ patrol: key, reason: 'no_guard' }); continue; }
          if (!s.checkpoints) { skipped.push({ patrol: key, reason: 'no_checkpoints' }); continue; }
          const why = await this.patrolFor(c, a, s, day, slot);
          if (why) skipped.push({ patrol: key, reason: why }); else created.push(key);
        }
      }
      return { date: day, created, existing, skipped };
    });
  }

  @Get('patrols')
  @Perm('tasks:read')
  patrols(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({ date: day, data: (await c.query(`${PATROL_SQL} WHERE p.patrol_date = $1 ORDER BY lower(t.service_window), s.code`, [day])).rows }));
  }

  @Get('patrols/:id')
  @Perm('tasks:read')
  patrol(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => this.patrolDetail(c, id));
  }

  /** The office records or corrects a checkpoint (from the guard's call or the tag reader's log). */
  @Post('patrols/:id/scan')
  @HttpCode(200)
  @Perm('tasks:assign')
  scan(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const cp = v.uuid(b?.checkpoint_id, 'checkpoint_id', { required: true })!;
    const event = v.oneOf(b?.event, 'event', SCAN_EVENTS, { required: true })!;
    const reason = v.oneOf(b?.reason, 'reason', SKIP_REASONS);
    const note = v.str(b?.note, 'note', { max: 300 });
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT task_id FROM ops.sec_patrol WHERE id = $1', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const bad = await markScan(c, a, { taskId: t.task_id, checkpointId: cp, event, tag: null, reason, note, at: new Date(), source: 'office', clientOpId: randomUUID() });
      if (bad === 'unknown_checkpoint') throw new BadRequestException('checkpoint is not on this site');
      if (bad) throw new ConflictException(bad);
      return this.patrolDetail(c, id);
    });
  }

  @Post('patrols/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT t.id, t.status FROM ops.sec_patrol p JOIN ops.task t ON t.id = p.task_id WHERE p.id = $1 FOR UPDATE OF t', [id])).rows[0];
      if (!t) throw new NotFoundException();
      if (t.status !== 'canceled') {
        if (!['ready', 'assigned', 'accepted'].includes(t.status)) throw new ConflictException('the patrol is under way or closed');
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [t.id]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [t.id]);
        await this.event(c, a, t.id, t.status, 'canceled', reason);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'security.patrol_canceled', targetType: 'sec_patrol', targetId: id, after: { reason } });
      }
      return this.patrolDetail(c, id);
    });
  }

  // ---- incidents ----

  @Get('incidents')
  @Perm('tasks:read')
  incidents(@Auth() a: AuthContext, @Query('open') open?: string, @Query('site_id') site?: string) {
    const siteId = v.uuid(site, 'site_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(`${INCIDENT_SQL} WHERE ($1::boolean IS NOT TRUE OR i.closed_at IS NULL) AND ($2::uuid IS NULL OR i.site_id = $2)
        ORDER BY (i.closed_at IS NULL) DESC, array_position(ARRAY['high','medium','low'], i.severity), i.occurred_at DESC LIMIT 200`, [open === '1' || open === 'true', siteId])).rows,
    }));
  }

  /** The office records an incident (e.g. a call from the customer or the guard). */
  @Post('incidents')
  @Perm('tasks:assign')
  addIncident(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const site = v.uuid(b?.site_id, 'site_id', { required: true })!;
    const category = v.oneOf(b?.category, 'category', CATEGORIES, { required: true })!;
    const severity = v.oneOf(b?.severity, 'severity', SEVERITIES) ?? 'medium';
    const description = v.str(b?.description, 'description', { required: true, max: 1000 })!.trim();
    const at = b?.occurred_at ? new Date(String(b.occurred_at)) : new Date();
    if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000) throw new BadRequestException('occurred_at invalid or in the future');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.sec_site WHERE id = $1', [site])).rowCount) throw new BadRequestException('unknown site_id');
      const id = await insertIncident(c, a, { siteId: site, patrolId: null, category, severity, description, at, source: 'office', clientOpId: randomUUID() });
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'security.incident_reported', targetType: 'sec_incident', targetId: id, after: { category, severity } });
      return (await c.query(`${INCIDENT_SQL} WHERE i.id = $1`, [id])).rows[0];
    });
  }

  /** Closes an incident with what was done (police report number, customer informed, repaired...). */
  @Post('incidents/:id/close')
  @HttpCode(200)
  @Perm('tasks:assign')
  closeIncident(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const note = v.str(b?.note, 'note', { required: true, max: 500 })!.trim();
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query('SELECT closed_at FROM ops.sec_incident WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!x) throw new NotFoundException();
      if (x.closed_at) throw new ConflictException('incident already closed');
      await c.query('UPDATE ops.sec_incident SET closed_at = now(), close_note = $2, closed_by = $3, version = version + 1 WHERE id = $1', [id, note, a.userId || null]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'security.incident_closed', targetType: 'sec_incident', targetId: id, after: { note } });
      return (await c.query(`${INCIDENT_SQL} WHERE i.id = $1`, [id])).rows[0];
    });
  }

  // ---- watch and report ----

  /**
   * For a day: patrols late to start, sites due without a guard or checkpoints, checkpoints skipped that day, checkpoints
   * skipped on the last patrols in a row, and open incidents (high first).
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const patrols = (await c.query(`${PATROL_SQL} WHERE p.patrol_date = $1`, [day])).rows;
      const late = patrols.filter((p) => ['assigned', 'accepted'].includes(p.status) && new Date(p.start_at).getTime() + LATE_START_MIN * 60_000 < Date.now());
      const due = (await c.query(`${SITE_SQL} WHERE s.active AND $1 = ANY (s.days) AND cardinality(s.patrol_times) > 0 ORDER BY s.code`, [isoDow(day)])).rows as SiteRow[];
      const skipped = (await c.query(
        `SELECT m.checkpoint_id, k.name, k.tag, s.code AS site_code, s.name AS site_name, pa.slot, m.reason, m.note, m.occurred_at
           FROM (${MARKS} JOIN ops.sec_patrol pp ON pp.id = x.patrol_id WHERE pp.patrol_date = $1 ORDER BY x.patrol_id, x.checkpoint_id, x.occurred_at DESC) m
           JOIN ops.sec_checkpoint k ON k.id = m.checkpoint_id JOIN ops.sec_patrol pa ON pa.id = m.patrol_id JOIN ops.sec_site s ON s.id = k.site_id
          WHERE m.event = 'skipped' ORDER BY s.code, pa.slot, k.seq`, [day])).rows;
      const streak = (await c.query(
        `WITH last AS (SELECT p.id, p.site_id, row_number() OVER (PARTITION BY p.site_id ORDER BY p.patrol_date DESC, p.slot DESC) AS k
                         FROM ops.sec_patrol p JOIN ops.task t ON t.id = p.task_id WHERE p.patrol_date <= $1 AND t.status IN ('completed','reviewed','invoiced'))
         SELECT k.id AS checkpoint_id, k.name, k.tag, s.code AS site_code, s.name AS site_name, count(*)::int AS patrols
           FROM ops.sec_checkpoint k JOIN ops.sec_site s ON s.id = k.site_id JOIN last l ON l.site_id = k.site_id AND l.k <= $2
           JOIN LATERAL (SELECT x.event FROM ops.sec_scan x WHERE x.patrol_id = l.id AND x.checkpoint_id = k.id ORDER BY x.occurred_at DESC LIMIT 1) m ON m.event = 'skipped'
          WHERE k.active GROUP BY k.id, k.name, k.tag, s.code, s.name HAVING count(*) >= $2 ORDER BY s.code, k.name`, [day, SKIP_STREAK])).rows;
      const open = (await c.query(`${INCIDENT_SQL} WHERE i.closed_at IS NULL ORDER BY array_position(ARRAY['high','medium','low'], i.severity), i.occurred_at DESC LIMIT 100`)).rows;
      return {
        date: day,
        late_start: late,
        no_guard_or_checkpoints: due.filter((s) => !s.guard_worker_id || !s.checkpoints),
        skipped,
        repeat_skipped: streak,
        open_incidents: open,
      };
    });
  }

  /** For a period: patrols, completed, checkpoint coverage and incidents, in total, per site and per incident category. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * DAY) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const patrols = (await c.query(`${PATROL_SQL} WHERE p.patrol_date BETWEEN $1 AND $2 AND t.status <> 'canceled'`, [f, t])).rows;
      const incidents = (await c.query(
        `SELECT s.code AS site_code, i.category, i.severity, (i.closed_at IS NULL) AS open FROM ops.sec_incident i JOIN ops.sec_site s ON s.id = i.site_id
          WHERE (i.occurred_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $1 AND $2`, [f, t])).rows;
      const sum = (l: typeof patrols, inc: typeof incidents) => {
        const planned = l.reduce((n, p) => n + p.checkpoints_planned, 0), scanned = l.reduce((n, p) => n + p.scanned, 0);
        return { patrols: l.length, completed: l.filter((p) => ['completed', 'reviewed', 'invoiced'].includes(p.status)).length,
          late: l.filter((p) => p.started_at && new Date(p.started_at).getTime() - new Date(p.start_at).getTime() > LATE_START_MIN * 60_000).length,
          checkpoints: planned, scanned, skipped: l.reduce((n, p) => n + p.skipped, 0), coverage: coverage(scanned, planned),
          incidents: inc.length, high: inc.filter((i) => i.severity === 'high').length, open: inc.filter((i) => i.open).length };
      };
      const codes = [...new Set([...patrols.map((p) => p.site_code as string), ...incidents.map((i) => i.site_code as string)])].sort();
      const cats = new Map<string, number>();
      for (const i of incidents) cats.set(i.category, (cats.get(i.category) ?? 0) + 1);
      return {
        from: f, to: t, totals: sum(patrols, incidents),
        sites: codes.map((code) => {
          const l = patrols.filter((p) => p.site_code === code);
          return { site_code: code, site_name: l[0]?.site_name ?? null, customer_name: l[0]?.customer_name ?? null, ...sum(l, incidents.filter((i) => i.site_code === code)) };
        }),
        categories: [...cats.entries()].map(([category, n]) => ({ category, incidents: n })).sort((x, y) => y.incidents - x.incidents),
      };
    });
  }

  // ---- helpers ----

  private async patrolDetail(c: PoolClient, id: string) {
    const p = (await c.query(`${PATROL_SQL} WHERE p.id = $1`, [id])).rows[0];
    if (!p) throw new NotFoundException();
    const incidents = (await c.query(`${INCIDENT_SQL} WHERE i.patrol_id = $1 ORDER BY i.occurred_at`, [id])).rows;
    return { ...p, checkpoints: await patrolSheet(c, id), incidents };
  }

  private parseSite(b: Record<string, unknown>, prev: SiteRow | null) {
    const pick = <T>(k: string, f: (x: unknown) => T, old: T | undefined): T => (b?.[k] === undefined && prev ? (old as T) : f(b?.[k]));
    const lat = pick('lat', (x) => (x === undefined || x === null ? null : Number(x)), prev?.lat ?? null);
    const lng = pick('lng', (x) => (x === undefined || x === null ? null : Number(x)), prev?.lng ?? null);
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng!) || Math.abs(lng!) > 180))) throw new BadRequestException('lat/lng invalid');
    return {
      name: pick('name', (x) => v.str(x, 'name', { required: true, max: 120 })!, prev?.name),
      customer_id: pick('customer_id', (x) => v.uuid(x, 'customer_id'), prev?.customer_id),
      area: pick('area', (x) => v.str(x, 'area', { max: 80 }), prev?.area),
      address: pick('address', (x) => v.str(x, 'address', { max: 200 }), prev?.address),
      lat, lng,
      patrol_times: pick('patrol_times', parseTimes, prev?.patrol_times),
      duration_min: pick('duration_min', (x) => v.int(x, 'duration_min', 10, 480) ?? 60, prev?.duration_min),
      days: pick('days', (x) => (x === undefined || x === null ? [1, 2, 3, 4, 5, 6, 7] : parseDays(x)), prev?.days),
      guard_worker_id: pick('guard_worker_id', (x) => v.uuid(x, 'guard_worker_id'), prev?.guard_worker_id),
      asset_id: pick('asset_id', (x) => v.uuid(x, 'asset_id'), prev?.asset_id),
      instructions: pick('instructions', (x) => v.str(x, 'instructions', { max: 500 }), prev?.instructions),
    };
  }

  private async checkRefs(c: PoolClient, le: string, s: { customer_id: string | null; asset_id: string | null; guard_worker_id: string | null }) {
    if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
    if (s.customer_id && !(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [s.customer_id, le])).rowCount) throw new BadRequestException('unknown customer_id');
    if (s.asset_id && !(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2', [s.asset_id, le])).rowCount) throw new BadRequestException('unknown asset_id');
    if (s.guard_worker_id && !(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND kind IN ('guard','supervisor','driver')`, [s.guard_worker_id, le])).rowCount) {
      throw new BadRequestException('unknown guard_worker_id');
    }
  }

  /** One patrol: the task, the exclusive booking of the guard (and car), and the patrol row. Returns a skip reason or null. */
  private async patrolFor(c: PoolClient, a: AuthContext, s: SiteRow, day: string, slot: string): Promise<string | null> {
    if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND status = 'active'`, [s.guard_worker_id])).rowCount) return 'guard_inactive';
    if (s.asset_id) {
      const asset = (await c.query('SELECT status FROM fleet.asset WHERE id = $1', [s.asset_id])).rows[0];
      if (!asset || ['out_of_service', 'retired'].includes(asset.status)) return 'vehicle_out_of_service';
    }
    const win = (await c.query(`SELECT ($1::date + $2::time) AT TIME ZONE le.timezone AS f FROM org.legal_entity le WHERE le.id = $3`, [day, slot, s.legal_entity_id])).rows[0];
    const from = new Date(win.f), to = new Date(from.getTime() + s.duration_min * 60_000);
    if (to.getTime() < Date.now()) return 'past';
    await c.query('SAVEPOINT patrol');
    try {
      const task = await createTask(c, a, {
        le: s.legal_entity_id, pack: SECURITY, branch: null, status: 'ready', customer: s.customer_id, site: null, ref: `PT-${s.code}-${day.replace(/-/g, '')}-${slot.replace(':', '')}`,
        win: { from: from.toISOString(), to: to.toISOString() },
        attrs: { kind: 'patrol', site_code: s.code, site_name: s.name, slot, checkpoints: s.checkpoints, instructions: s.instructions,
          address: [s.address, s.area].filter(Boolean).join('، ') || s.name, ...(s.lat !== null ? { dropoff: { name: s.name, lat: s.lat, lng: s.lng } } : {}) },
      });
      await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
        [randomUUID(), a.tenantId, task.id, s.guard_worker_id, s.asset_id, from.toISOString(), to.toISOString(), a.userId]);
      await c.query(`INSERT INTO ops.sec_patrol (id, tenant_id, site_id, patrol_date, slot, task_id, guard_worker_id, asset_id, checkpoints_planned, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), a.tenantId, s.id, day, slot, task.id, s.guard_worker_id, s.asset_id, s.checkpoints, a.userId]);
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await this.event(c, a, task.id, 'ready', 'assigned', `patrol ${s.code} ${day} ${slot}`);
      await c.query('RELEASE SAVEPOINT patrol');
      return null;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT patrol');
      const k = (e as { constraint?: string }).constraint;
      if (k === 'no_asset_overlap') return 'vehicle_booked';
      if (k === 'no_worker_overlap') return 'guard_booked';
      throw e;
    }
  }

  private async event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
  }
}
