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
import { billableDay, billableHours, EQUIPMENT, HEAVY_TYPES, hoursBetween, LATE_START_MIN, meter, RATE_UNITS, Stage } from './equipment';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const hm = (x: unknown, f: string) => {
  if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new BadRequestException(`${f} must be HH:MM`);
  return x;
};
const DONE = ['completed', 'reviewed', 'invoiced'];

const HIRE_SQL = `
  SELECT h.id, h.ref, h.legal_entity_id, h.customer_id, cu.name AS customer_name, h.asset_id, a.plate_no, a.asset_type, a.make, a.model,
         h.operator_worker_id, w.display_name AS operator_name, h.site, h.starts_on::text AS starts_on, h.ends_on::text AS ends_on, h.off_hired_on::text AS off_hired_on,
         to_char(h.shift_start, 'HH24:MI') AS shift_start, to_char(h.shift_end, 'HH24:MI') AS shift_end, h.work_days, h.rate_unit, h.min_hours::float AS min_hours,
         h.notes, h.canceled_at, h.cancel_reason, h.version,
         CASE WHEN h.canceled_at IS NOT NULL THEN 'canceled' WHEN COALESCE(h.off_hired_on, h.ends_on) < $T::date THEN 'ended'
              WHEN h.starts_on > $T::date THEN 'booked' ELSE 'on_hire' END AS state,
         (SELECT count(*)::int FROM ops.equip_day d WHERE d.hire_id = h.id) AS days,
         (SELECT COALESCE(sum(d.approved_hours), 0)::float FROM ops.equip_day d WHERE d.hire_id = h.id) AS approved_hours,
         (SELECT COALESCE(sum(d.meter_end - d.meter_start), 0)::float FROM ops.equip_day d WHERE d.hire_id = h.id AND d.meter_end IS NOT NULL) AS worked_hours
    FROM ops.equip_hire h JOIN crm.customer cu ON cu.id = h.customer_id JOIN fleet.asset a ON a.id = h.asset_id
    LEFT JOIN workforce.worker w ON w.id = h.operator_worker_id`;
const hireSql = (where: string) => HIRE_SQL.replaceAll('$T', `'${kwToday()}'`) + ` ${where}`;

const DAY_SQL = `
  SELECT d.task_id, d.hire_id, h.ref AS hire_ref, d.work_date::text AS work_date, t.status, lower(t.service_window) AS shift_from, upper(t.service_window) AS shift_to,
         cu.name AS customer_name, h.site, a.plate_no, a.asset_type, h.operator_worker_id IS NOT NULL AS wet, ow.display_name AS operator_name, asg.worker_id IS NOT NULL AS covered,
         d.meter_start::float, d.meter_end::float, (d.meter_end - d.meter_start)::float AS worked_hours, d.downtime_hours::float, d.signed_by,
         d.approved_hours::float, d.approved_at, d.note, h.rate_unit, h.min_hours::float AS min_hours,
         (SELECT min(m.occurred_at) FROM ops.task_milestone m WHERE m.task_id = t.id AND m.code = 'work_start') AS started_at
    FROM ops.equip_day d JOIN ops.equip_hire h ON h.id = d.hire_id JOIN ops.task t ON t.id = d.task_id
    JOIN crm.customer cu ON cu.id = h.customer_id JOIN fleet.asset a ON a.id = h.asset_id
    LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active LEFT JOIN workforce.worker ow ON ow.id = asg.worker_id`;

const siteLine = (s: Record<string, unknown>) => [s.name, s.area].filter((x) => typeof x === 'string' && x).join('، ') || null;

/**
 * The operator's start and end of a working day from the app (or the office's record): hour meter readings, downtime
 * and the supervisor who confirmed. Returns a reject code instead of throwing so the driver's sync reports it per op.
 */
export async function equipStage(c: PoolClient, taskId: string, code: Stage, x: { meter: number | null; downtime: number | null; signedBy: string | null }): Promise<string | null> {
  const d = (await c.query(
    `SELECT d.meter_start::float, h.asset_id, h.shift_start, h.shift_end FROM ops.equip_day d JOIN ops.equip_hire h ON h.id = d.hire_id WHERE d.task_id = $1 FOR UPDATE OF d`, [taskId])).rows[0];
  if (!d) return 'not_supported';
  if (x.meter === null) return 'meter_required';
  if (code === 'work_start') {
    // the meter only goes up: not below the machine's last recorded reading
    const last = (await c.query(
      `SELECT max(GREATEST(e.meter_start, COALESCE(e.meter_end, 0)))::float AS m FROM ops.equip_day e JOIN ops.equip_hire h ON h.id = e.hire_id WHERE h.asset_id = $1 AND e.task_id <> $2`,
      [d.asset_id, taskId])).rows[0].m;
    if (last !== null && x.meter < last) return 'meter_too_low';
    await c.query('UPDATE ops.equip_day SET meter_start = $2 WHERE task_id = $1', [taskId, x.meter]);
    return null;
  }
  if (!x.signedBy) return 'signer_required';
  if (d.meter_start === null || x.meter < d.meter_start || x.meter - d.meter_start > 24) return 'meter_invalid';
  await c.query('UPDATE ops.equip_day SET meter_end = $2, downtime_hours = $3, signed_by = $4 WHERE task_id = $1', [taskId, x.meter, x.downtime ?? 0, x.signedBy]);
  return null;
}

@Controller('v1/equipment')
@UseGuards(AuthGuard)
@Pack('equipment')
export class EquipmentController {
  constructor(private readonly db: DbService) {}

  // ---- hires ----

  @Get('hires')
  @Perm('tasks:read')
  hires(@Auth() a: AuthContext, @Query('customer_id') customer?: string, @Query('state') state?: string) {
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(hireSql(`WHERE ($1::uuid IS NULL OR h.customer_id = $1) ORDER BY h.starts_on DESC, h.ref DESC LIMIT 500`), [cu])).rows;
      return { data: state ? rows.filter((r) => r.state === state) : rows };
    });
  }

  /** A hire: the machine (and operator) for a period at the customer's site; every working day becomes a task, booked exclusively. */
  @Post('hires')
  @Perm('tasks:assign')
  addHire(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const asset = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const operator = v.uuid(b?.operator_worker_id, 'operator_worker_id');
    const site = normalizeAttributes({ dropoff: v.obj(b?.site, 'site') ?? (() => { throw new BadRequestException('site required'); })() })!.dropoff as Record<string, unknown>;
    if (!site.area && !site.name) throw new BadRequestException('site needs a name or area');
    const from = v.date(b?.starts_on, 'starts_on') ?? (() => { throw new BadRequestException('starts_on required'); })();
    const to = v.date(b?.ends_on, 'ends_on') ?? from;
    if (to < from || Date.parse(to) - Date.parse(from) > 186 * 86_400_000) throw new BadRequestException('the hire runs 1-187 days');
    const s1 = b?.shift_start === undefined ? '07:00' : hm(b.shift_start, 'shift_start'), s2 = b?.shift_end === undefined ? '17:00' : hm(b.shift_end, 'shift_end');
    if (s2 <= s1) throw new BadRequestException('shift_end must be after shift_start');
    const days = b?.work_days === undefined ? [7, 1, 2, 3, 4, 6] : (Array.isArray(b.work_days) && b.work_days.length && b.work_days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)
      ? [...new Set(b.work_days as number[])] : (() => { throw new BadRequestException('work_days must be ISO weekdays 1-7'); })());
    const unit = v.oneOf(b?.rate_unit, 'rate_unit', RATE_UNITS) ?? 'hour';
    const min = b?.min_hours === undefined ? 8 : meter(b.min_hours, 'min_hours')!;
    if (min > 24) throw new BadRequestException('min_hours up to 24');
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query(`SELECT legal_entity_id, status FROM crm.customer WHERE id = $1`, [customer])).rows[0];
      if (!cu || cu.legal_entity_id !== le) throw new BadRequestException('unknown customer_id');
      const m = (await c.query('SELECT legal_entity_id, status FROM fleet.asset WHERE id = $1', [asset])).rows[0];
      if (!m || m.legal_entity_id !== le) throw new BadRequestException('unknown asset_id');
      if (['out_of_service', 'retired'].includes(m.status)) throw new ConflictException(`machine is ${m.status}`);
      if (operator && !(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND status = 'active'`, [operator, le])).rowCount) throw new BadRequestException('unknown operator_worker_id');
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.equip_hire`)).rows[0].n;
      const id = randomUUID(), ref = `EH-${n}`;
      await c.query('SAVEPOINT h');
      try {
        await c.query(`INSERT INTO ops.equip_hire (id, tenant_id, legal_entity_id, customer_id, ref, asset_id, operator_worker_id, site, starts_on, ends_on, shift_start, shift_end, work_days, rate_unit, min_hours, notes, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, a.tenantId, le, customer, ref, asset, operator, JSON.stringify(site), from, to, s1, s2, days, unit, min, notes, a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT h');
        if ((e as { constraint?: string }).constraint === 'no_equip_hire_overlap') throw new ConflictException('the machine is already hired in this period');
        throw e;
      }
      const made = await this.makeDays(c, a, id, from, to);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'equipment.hired', targetType: 'equip_hire', targetId: id, after: { ref, customer, asset, operator, from, to, unit, min, days: made.days } });
      return { ...(await this.hire(c, id)), uncovered: made.uncovered };
    });
  }

  @Get('hires/:id')
  @Perm('tasks:read')
  getHire(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => ({ ...(await this.hire(c, id)), work_days_list: (await c.query(`${DAY_SQL} WHERE d.hire_id = $1 ORDER BY d.work_date`, [id])).rows }));
  }

  /** Extends the hire to a later end date; the new working days are created and booked. */
  @Post('hires/:id/extend')
  @HttpCode(200)
  @Perm('tasks:assign')
  extend(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const to = v.date(b?.ends_on, 'ends_on') ?? (() => { throw new BadRequestException('ends_on required'); })();
    return this.db.withTenant(a, async (c) => {
      const h = (await c.query('SELECT ends_on::text, starts_on::text, off_hired_on, canceled_at FROM ops.equip_hire WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!h) throw new NotFoundException();
      if (h.canceled_at || h.off_hired_on) throw new ConflictException('the hire is closed');
      if (to <= h.ends_on || Date.parse(to) - Date.parse(h.starts_on) > 186 * 86_400_000) throw new BadRequestException('ends_on must be later, within 187 days of the start');
      await c.query('SAVEPOINT x');
      try {
        await c.query('UPDATE ops.equip_hire SET ends_on = $2, version = version + 1 WHERE id = $1', [id, to]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT x');
        if ((e as { constraint?: string }).constraint === 'no_equip_hire_overlap') throw new ConflictException('the machine is hired to someone else in the added days');
        throw e;
      }
      const next = new Date(Date.parse(h.ends_on) + 86_400_000).toISOString().slice(0, 10);
      const made = await this.makeDays(c, a, id, next, to);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'equipment.extended', targetType: 'equip_hire', targetId: id, before: { ends_on: h.ends_on }, after: { ends_on: to } });
      return { ...(await this.hire(c, id)), uncovered: made.uncovered };
    });
  }

  /** Ends the hire early: the last working day is `on`; later days are canceled and the machine is free. */
  @Post('hires/:id/off-hire')
  @HttpCode(200)
  @Perm('tasks:assign')
  offHire(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const on = v.date(b?.on, 'on') ?? kwToday();
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const h = (await c.query('SELECT starts_on::text, ends_on::text, off_hired_on, canceled_at FROM ops.equip_hire WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!h) throw new NotFoundException();
      if (h.canceled_at || h.off_hired_on) throw new ConflictException('the hire is closed');
      if (on < h.starts_on || on >= h.ends_on) throw new BadRequestException('off-hire date must be within the hire, before its end');
      const later = (await c.query(`SELECT d.task_id, t.status FROM ops.equip_day d JOIN ops.task t ON t.id = d.task_id WHERE d.hire_id = $1 AND d.work_date > $2 FOR UPDATE OF t`, [id, on])).rows;
      if (later.some((d) => !['draft', 'ready', 'assigned', 'accepted'].includes(d.status))) throw new ConflictException('a later day has already started');
      for (const d of later) await this.cancelDay(c, a, d.task_id, d.status, `off-hire: ${reason}`);
      await c.query('UPDATE ops.equip_hire SET off_hired_on = $2, version = version + 1 WHERE id = $1', [id, on]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'equipment.off_hired', targetType: 'equip_hire', targetId: id, after: { on, reason, canceled_days: later.length } });
      return this.hire(c, id);
    });
  }

  /** Cancels a hire that has not started work yet. */
  @Post('hires/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 500 })!;
    return this.db.withTenant(a, async (c) => {
      const h = (await c.query('SELECT canceled_at FROM ops.equip_hire WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!h) throw new NotFoundException();
      if (h.canceled_at) return this.hire(c, id);
      const days = (await c.query(`SELECT d.task_id, t.status FROM ops.equip_day d JOIN ops.task t ON t.id = d.task_id WHERE d.hire_id = $1 FOR UPDATE OF t`, [id])).rows;
      if (days.some((d) => !['draft', 'ready', 'assigned', 'accepted', 'canceled'].includes(d.status))) throw new ConflictException('work has started; off-hire instead');
      for (const d of days.filter((x) => x.status !== 'canceled')) await this.cancelDay(c, a, d.task_id, d.status, `hire canceled: ${reason}`);
      await c.query('UPDATE ops.equip_hire SET canceled_at = now(), cancel_reason = $2, version = version + 1 WHERE id = $1', [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'equipment.hire_canceled', targetType: 'equip_hire', targetId: id, after: { reason } });
      return this.hire(c, id);
    });
  }

  // ---- working days ----

  @Get('days')
  @Perm('tasks:read')
  days(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({ date: day, data: (await c.query(`${DAY_SQL} WHERE d.work_date = $1 AND t.status <> 'canceled' ORDER BY lower(t.service_window), h.ref`, [day])).rows }));
  }

  /** The office records or corrects a day's readings (a dry hire, or the operator's paper timesheet). */
  @Post('days/:taskId/record')
  @HttpCode(200)
  @Perm('tasks:assign')
  record(@Auth() a: AuthContext, @Param('taskId', new ParseUUIDPipe()) taskId: string, @Body() b: Record<string, unknown>) {
    const start = meter(b?.meter_start, 'meter_start', { required: true })!;
    const end = meter(b?.meter_end, 'meter_end');
    const down = meter(b?.downtime_hours, 'downtime_hours') ?? 0;
    if (down > 24) throw new BadRequestException('downtime_hours up to 24');
    const signed = v.str(b?.signed_by, 'signed_by', { max: 120 });
    const note = v.str(b?.note, 'note', { max: 500 });
    if (end !== null && (end < start || end - start > 24)) throw new BadRequestException('meter_end must be 0-24 hours after meter_start');
    return this.db.withTenant(a, async (c) => {
      const d = (await c.query('SELECT d.approved_at, t.status FROM ops.equip_day d JOIN ops.task t ON t.id = d.task_id WHERE d.task_id = $1 FOR UPDATE OF d', [taskId])).rows[0];
      if (!d) throw new NotFoundException();
      if (d.approved_at) throw new ConflictException('the day is approved');
      if (d.status === 'canceled') throw new ConflictException('the day is canceled');
      const before = (await c.query(`${DAY_SQL} WHERE d.task_id = $1`, [taskId])).rows[0];
      await c.query('UPDATE ops.equip_day SET meter_start = $2, meter_end = $3, downtime_hours = $4, signed_by = COALESCE($5, signed_by), note = COALESCE($6, note) WHERE task_id = $1',
        [taskId, start, end, down, signed, note]);
      const after = (await c.query(`${DAY_SQL} WHERE d.task_id = $1`, [taskId])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'equipment.day_recorded', targetType: 'task', targetId: taskId, before, after });
      return after;
    });
  }

  /**
   * Approves a day for billing: by default the billable hours from the meter, the daily minimum and our downtime (for
   * day and month rates, 1 or 0 days). The office can set the hours. Closes the task if it was still open (dry hire).
   */
  @Post('days/:taskId/approve')
  @HttpCode(200)
  @Perm('tasks:assign')
  approve(@Auth() a: AuthContext, @Param('taskId', new ParseUUIDPipe()) taskId: string, @Body() b: Record<string, unknown>) {
    const set = meter(b?.hours, 'hours');
    if (set !== null && set > 24) throw new BadRequestException('hours up to 24');
    return this.db.withTenant(a, async (c) => {
      const d = (await c.query(`${DAY_SQL} WHERE d.task_id = $1 FOR UPDATE OF d`, [taskId])).rows[0];
      if (!d) throw new NotFoundException();
      if (d.approved_at) throw new ConflictException('already approved');
      if (d.status === 'canceled') throw new ConflictException('the day is canceled');
      const shift = (new Date(d.shift_to).getTime() - new Date(d.shift_from).getTime()) / 3_600_000;
      if (d.meter_end === null && d.status !== 'failed' && d.downtime_hours < shift) throw new ConflictException('record the end reading first');
      const worked = d.worked_hours ?? 0;
      const hours = set ?? (d.rate_unit === 'hour' ? billableHours(worked, d.downtime_hours, d.min_hours) : billableDay(d.downtime_hours, shift) * Math.min(shift, 24));
      await c.query('UPDATE ops.equip_day SET approved_hours = $2, approved_by = $3, approved_at = now() WHERE task_id = $1', [taskId, Math.round(hours * 10) / 10, a.userId]);
      if (!DONE.includes(d.status) && d.status !== 'failed') {
        await c.query(`UPDATE ops.task SET status = 'completed', version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
        await this.event(c, a, taskId, d.status, 'completed', 'day approved by the office');
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'equipment.day_approved', targetType: 'task', targetId: taskId, after: { hours, worked, downtime: d.downtime_hours } });
      return (await c.query(`${DAY_SQL} WHERE d.task_id = $1`, [taskId])).rows[0];
    });
  }

  // ---- watch and report ----

  /** Today's machines: on hire (where and for whom) or idle in the yard. */
  @Get('fleet')
  @Perm('tasks:read')
  fleet(@Auth() a: AuthContext) {
    const day = kwToday();
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT a.id, a.plate_no, a.asset_type, a.make, a.model, a.status, h.id AS hire_id, h.ref AS hire_ref, cu.name AS customer_name, h.site,
                COALESCE(h.off_hired_on, h.ends_on)::text AS hire_ends_on
           FROM fleet.asset a
           LEFT JOIN ops.equip_hire h ON h.asset_id = a.id AND h.canceled_at IS NULL AND $1::date BETWEEN h.starts_on AND COALESCE(h.off_hired_on, h.ends_on)
           LEFT JOIN crm.customer cu ON cu.id = h.customer_id
          WHERE a.asset_type = ANY ($2::text[]) OR h.id IS NOT NULL ORDER BY (h.id IS NULL), a.asset_type, a.plate_no`, [day, HEAVY_TYPES])).rows,
    }));
  }

  /** For a day: not started after the shift start, wet-hire days without the operator booked, unsigned or unapproved days, hires ending soon. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const today = (await c.query(`${DAY_SQL} WHERE d.work_date = $1 AND t.status <> 'canceled' ORDER BY lower(t.service_window)`, [day])).rows;
      const late = today.filter((d) => d.wet && ['assigned', 'accepted'].includes(d.status) && new Date(d.shift_from).getTime() + LATE_START_MIN * 60_000 < Date.now());
      const uncovered = today.filter((d) => d.wet && !d.covered && !DONE.includes(d.status) && d.status !== 'failed');
      const toApprove = (await c.query(`${DAY_SQL} WHERE d.approved_at IS NULL AND t.status <> 'canceled' AND d.work_date <= $1 AND (d.meter_end IS NOT NULL OR t.status = 'failed') ORDER BY d.work_date`, [day])).rows;
      const unsigned = toApprove.filter((d) => d.meter_end !== null && !d.signed_by);
      const ending = (await c.query(hireSql(`WHERE h.canceled_at IS NULL AND COALESCE(h.off_hired_on, h.ends_on) BETWEEN $1::date AND $1::date + 3 ORDER BY COALESCE(h.off_hired_on, h.ends_on)`), [day])).rows;
      return { date: day, late, uncovered, to_approve: toApprove, unsigned, ending };
    });
  }

  /** For a period: per customer the days, hours worked, downtime and approved billable hours; per machine its use of the scheduled shifts. */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${DAY_SQL} WHERE d.work_date BETWEEN $1 AND $2 AND t.status <> 'canceled'`, [f, t])).rows;
      const shiftH = (d: (typeof rows)[number]) => (new Date(d.shift_to).getTime() - new Date(d.shift_from).getTime()) / 3_600_000;
      const r1 = (n: number) => Math.round(n * 10) / 10;
      const group = (key: (d: (typeof rows)[number]) => string) => {
        const m = new Map<string, typeof rows>();
        for (const d of rows) m.set(key(d), [...(m.get(key(d)) ?? []), d]);
        return [...m.values()];
      };
      const sum = (list: typeof rows) => ({
        days: list.length, approved_days: list.filter((d) => d.approved_at).length,
        worked_hours: r1(list.reduce((s, d) => s + (d.worked_hours ?? 0), 0)), downtime_hours: r1(list.reduce((s, d) => s + d.downtime_hours, 0)),
        billable_hours: r1(list.reduce((s, d) => s + (d.approved_hours ?? 0), 0)),
      });
      return {
        from: f, to: t,
        customers: group((d) => d.customer_name).map((l) => ({ customer_name: l[0].customer_name, ...sum(l) })).sort((x, y) => y.billable_hours - x.billable_hours),
        machines: group((d) => d.plate_no).map((l) => {
          const sched = l.reduce((s, d) => s + shiftH(d), 0);
          const s = sum(l);
          return { plate_no: l[0].plate_no, asset_type: l[0].asset_type, ...s, scheduled_hours: r1(sched), utilization_pct: sched ? Math.round((s.worked_hours / sched) * 1000) / 10 : null };
        }).sort((x, y) => (y.utilization_pct ?? 0) - (x.utilization_pct ?? 0)),
        totals: sum(rows),
      };
    });
  }

  // ---- helpers ----

  private async hire(c: PoolClient, id: string) {
    const h = (await c.query(hireSql('WHERE h.id = $1'), [id])).rows[0];
    if (!h) throw new NotFoundException();
    return h;
  }

  /** Creates the working days between two dates (on the hire's weekdays, not already past) and books machine and operator. */
  private async makeDays(c: PoolClient, a: AuthContext, hireId: string, from: string, to: string) {
    const rows = (await c.query(
      `SELECT g.day::date::text AS work_date, h.ref, h.legal_entity_id, h.customer_id, h.asset_id, h.operator_worker_id, h.site, h.rate_unit, h.min_hours::float AS min_hours,
              to_char(h.shift_start, 'HH24:MI') AS s1, to_char(h.shift_end, 'HH24:MI') AS s2, ast.plate_no, ast.asset_type,
              ((g.day::date + h.shift_start) AT TIME ZONE le.timezone) AS win_from, ((g.day::date + h.shift_end) AT TIME ZONE le.timezone) AS win_to
         FROM ops.equip_hire h JOIN org.legal_entity le ON le.id = h.legal_entity_id JOIN fleet.asset ast ON ast.id = h.asset_id
         CROSS JOIN LATERAL generate_series($2::date, $3::date, interval '1 day') g(day)
        WHERE h.id = $1 AND extract(isodow FROM g.day)::int = ANY (h.work_days) AND ((g.day::date + h.shift_end) AT TIME ZONE le.timezone) > now()
          AND NOT EXISTS (SELECT 1 FROM ops.equip_day d WHERE d.hire_id = h.id AND d.work_date = g.day::date)
        ORDER BY g.day`, [hireId, from, to])).rows;
    let uncovered = 0;
    for (const d of rows) {
      const task = await createTask(c, a, {
        le: d.legal_entity_id, pack: EQUIPMENT, branch: null, status: 'ready', customer: d.customer_id, site: null, ref: `${d.ref}-${d.work_date.replaceAll('-', '')}`,
        win: { from: new Date(d.win_from).toISOString(), to: new Date(d.win_to).toISOString() },
        attrs: { kind: 'hire_day', hire_id: hireId, hire_ref: d.ref, work_date: d.work_date, shift: `${d.s1}–${d.s2}`, machine: d.plate_no, machine_type: d.asset_type,
          rate_unit: d.rate_unit, min_hours: d.min_hours, dropoff: d.site, address: siteLine(d.site), shift_hours: hoursBetween(d.s1, d.s2) },
      });
      await c.query('INSERT INTO ops.equip_day (task_id, tenant_id, hire_id, work_date) VALUES ($1,$2,$3,$4)', [task.id, a.tenantId, hireId, d.work_date]);
      if (!d.operator_worker_id) continue; // dry hire: the office records the readings
      await c.query('SAVEPOINT asg');
      try {
        await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, d.operator_worker_id, d.asset_id, new Date(d.win_from).toISOString(), new Date(d.win_to).toISOString(), a.userId]);
        await c.query('RELEASE SAVEPOINT asg');
        await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
        await this.event(c, a, task.id, 'ready', 'assigned', `hire ${d.ref}`);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k !== 'no_worker_overlap' && k !== 'no_asset_overlap') throw e;
        uncovered++; // booked elsewhere at that time: the day shows as uncovered
      }
    }
    return { days: rows.length, uncovered };
  }

  private async cancelDay(c: PoolClient, a: AuthContext, taskId: string, from: string, note: string) {
    await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [taskId]);
    await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
    await this.event(c, a, taskId, from, 'canceled', note);
  }

  private async event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
  }
}
