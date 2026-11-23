import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { normalizePhone } from '../../common/phone';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { addMinutes, isoDow, parseDays, parseStops, Stop } from '../shuttle/shuttle';
import { ABSENCE_SCOPES, ABSENT_STREAK, DIRECTIONS, Direction, finishRule, LATE_START_MIN, MARK_EVENTS, MarkEvent, markRule, needsHandover, REPORTED_BY, SCHOOL, studentState } from './school';

const kwToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const hm = (x: unknown, f: string) => {
  if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new BadRequestException(`${f} must be HH:MM`);
  return x;
};
const DONE = ['completed', 'reviewed', 'invoiced'];

const ROUTE_SQL = `
  SELECT r.id, r.legal_entity_id, r.customer_id, cu.name AS customer_name, r.school_name, r.code, r.name, r.direction, to_char(r.depart_time, 'HH24:MI') AS depart_time,
         r.duration_min, r.days, r.stops, r.capacity, r.asset_id, a.plate_no, r.driver_worker_id, w.display_name AS driver_name,
         r.attendant_worker_id, at.display_name AS attendant_name, r.active, r.version,
         (SELECT count(*)::int FROM ops.sch_student x WHERE x.route_id = r.id AND x.active) AS students
    FROM ops.sch_route r LEFT JOIN crm.customer cu ON cu.id = r.customer_id
    LEFT JOIN fleet.asset a ON a.id = r.asset_id LEFT JOIN workforce.worker w ON w.id = r.driver_worker_id LEFT JOIN workforce.worker at ON at.id = r.attendant_worker_id`;

// each student's standing mark on a trip is the latest one
const MARKS = `SELECT DISTINCT ON (m.trip_id, m.student_id) m.trip_id, m.student_id, m.event, m.received_by, m.occurred_at, m.source FROM ops.sch_mark m`;
const count = (ev: string) =>
  `(SELECT count(*)::int FROM (${MARKS} WHERE m.trip_id = st.id ORDER BY m.trip_id, m.student_id, m.occurred_at DESC) k WHERE k.event = '${ev}')`;

const TRIP_SQL = `
  SELECT st.id, st.route_id, r.code AS route_code, r.name AS route_name, r.school_name, r.direction, r.customer_id, cu.name AS customer_name, st.trip_date::text AS trip_date,
         st.task_id, t.status, t.version AS task_version, lower(t.service_window) AS depart_at, upper(t.service_window) AS arrive_by,
         st.asset_id, a.plate_no, st.driver_worker_id, w.display_name AS driver_name, st.attendant_task_id, st.attendant_worker_id, at.display_name AS attendant_name,
         st.students_planned, st.capacity,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'in_progress') AS started_at,
         (SELECT min(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') AS ended_at,
         ${count('boarded')} AS on_board, ${count('dropped')} AS dropped, ${count('absent')} AS absent
    FROM ops.sch_trip st JOIN ops.sch_route r ON r.id = st.route_id JOIN ops.task t ON t.id = st.task_id
    LEFT JOIN crm.customer cu ON cu.id = r.customer_id JOIN fleet.asset a ON a.id = st.asset_id JOIN workforce.worker w ON w.id = st.driver_worker_id
    LEFT JOIN workforce.worker at ON at.id = st.attendant_worker_id`;

interface RouteRow {
  id: string; legal_entity_id: string; customer_id: string | null; customer_name: string | null; school_name: string; code: string; name: string; direction: Direction;
  depart_time: string; duration_min: number; days: number[]; stops: Stop[]; capacity: number | null; asset_id: string | null; driver_worker_id: string | null;
  attendant_worker_id: string | null; active: boolean;
}

/**
 * The students of a trip with their stop, standing mark and any absence notice for the day: the list the driver, the
 * attendant and the office see. state is waiting, on_board, dropped, absent (marked) or excused (notice, not marked).
 */
export async function manifest(c: PoolClient, tripId: string) {
  const rows = (await c.query(
    `SELECT x.id, x.name, x.grade, x.stop_seq, x.guardian_name, x.guardian_phone, x.handover, x.note, k.event, k.received_by, k.occurred_at AS marked_at, k.source,
            EXISTS (SELECT 1 FROM ops.sch_absence ab WHERE ab.student_id = x.id AND ab.day = st.trip_date AND ab.scope IN ('both', r.direction)) AS excused
       FROM ops.sch_trip st JOIN ops.sch_route r ON r.id = st.route_id JOIN ops.sch_student x ON x.route_id = st.route_id
       LEFT JOIN (${MARKS} WHERE m.trip_id = $1 ORDER BY m.trip_id, m.student_id, m.occurred_at DESC) k ON k.student_id = x.id
      WHERE st.id = $1 AND (x.active OR k.event IS NOT NULL) ORDER BY x.stop_seq, x.name`, [tripId])).rows;
  return rows.map((x) => ({ ...x, state: studentState(x.event, x.excused) }));
}

/** The trip a task belongs to: the bus-and-driver task or the attendant's. */
async function tripOfTask(c: PoolClient, taskId: string) {
  return (await c.query(
    `SELECT st.id, st.route_id, r.direction, t.status FROM ops.sch_trip st JOIN ops.sch_route r ON r.id = st.route_id JOIN ops.task t ON t.id = $1
      WHERE st.task_id = $1 OR st.attendant_task_id = $1`, [taskId])).rows[0] as { id: string; route_id: string; direction: Direction; status: string } | undefined;
}

/**
 * Marks a student boarded, absent or dropped (the driver or attendant from the app, or the office correcting). Returns
 * a reject code instead of throwing so the driver's offline sync can report it per op.
 */
export async function markStudent(c: PoolClient, a: AuthContext, x: { taskId: string; studentId: string; event: MarkEvent; receivedBy: string | null; at: Date; source: 'driver' | 'office'; clientOpId: string }): Promise<string | null> {
  const st = await tripOfTask(c, x.taskId);
  if (!st) return 'not_supported';
  const allowed = x.source === 'driver' ? ['accepted', 'in_progress'] : ['assigned', 'accepted', 'in_progress', 'failed', ...DONE]; // a failed trip may still have children to account for
  if (!allowed.includes(st.status)) return 'invalid_stage';
  const s = (await c.query('SELECT handover FROM ops.sch_student WHERE id = $1 AND route_id = $2', [x.studentId, st.route_id])).rows[0];
  if (!s) return 'unknown_student';
  const now = (await manifest(c, st.id)).find((m) => m.id === x.studentId);
  const bad = markRule(now?.state ?? 'waiting', x.event, { direction: st.direction, handover: s.handover, receivedBy: x.receivedBy });
  if (bad) return bad;
  await c.query(`INSERT INTO ops.sch_mark (id, tenant_id, trip_id, student_id, event, received_by, occurred_at, source, actor_id, client_op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), a.tenantId, st.id, x.studentId, x.event, x.event === 'dropped' ? x.receivedBy : null, x.at, x.source, a.userId || null, x.clientOpId]);
  return null;
}

/** Whether the task's trip can be closed: no student left on the bus and every expected student marked. */
export async function schoolFinish(c: PoolClient, taskId: string): Promise<string | null> {
  const st = await tripOfTask(c, taskId);
  if (!st) return 'not_supported';
  return finishRule((await manifest(c, st.id)).map((m) => m.state));
}

@Controller('v1/school')
@UseGuards(AuthGuard)
@Pack('school')
export class SchoolController {
  constructor(private readonly db: DbService) {}

  // ---- routes ----

  @Get('routes')
  @Perm('tasks:read')
  routes(@Auth() a: AuthContext, @Query('customer_id') customer?: string) {
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => ({ data: (await c.query(`${ROUTE_SQL} WHERE ($1::uuid IS NULL OR r.customer_id = $1) ORDER BY r.active DESC, r.school_name, r.code`, [cu])).rows }));
  }

  @Post('routes')
  @Perm('tasks:assign')
  addRoute(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const r = this.parseRoute(b, null);
    return this.db.withTenant(a, async (c) => {
      await this.checkRefs(c, le, r);
      const id = randomUUID();
      try {
        await c.query(`INSERT INTO ops.sch_route (id, tenant_id, legal_entity_id, customer_id, school_name, code, name, direction, depart_time, duration_min, days, stops, capacity, asset_id, driver_worker_id, attendant_worker_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, a.tenantId, le, r.customer_id, r.school_name, r.code, r.name, r.direction, r.depart_time, r.duration_min, r.days, JSON.stringify(r.stops), r.capacity, r.asset_id, r.driver_worker_id, r.attendant_worker_id]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'sch_route_tenant_id_code_key') throw new ConflictException('route code already used');
        pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'school.route_created', targetType: 'sch_route', targetId: id, after: { code: r.code, school: r.school_name } });
      return (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0];
    });
  }

  /** Changes a route (version required). Trips already generated keep their bus, driver, attendant and time. */
  @Patch('routes/:id')
  @Perm('tasks:assign')
  editRoute(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0] as RouteRow & { version: number };
      if (!before) throw new NotFoundException();
      if (before.version !== ver) throw new ConflictException('route changed meanwhile; reload');
      const r = this.parseRoute(b, before);
      await this.checkRefs(c, before.legal_entity_id, r);
      if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
      const active = b?.active === undefined ? before.active : b.active;
      await c.query(`UPDATE ops.sch_route SET customer_id = $2, school_name = $3, name = $4, direction = $5, depart_time = $6, duration_min = $7, days = $8, stops = $9, capacity = $10,
          asset_id = $11, driver_worker_id = $12, attendant_worker_id = $13, active = $14, version = version + 1 WHERE id = $1`,
        [id, r.customer_id, r.school_name, r.name, r.direction, r.depart_time, r.duration_min, r.days, JSON.stringify(r.stops), r.capacity, r.asset_id, r.driver_worker_id, r.attendant_worker_id, active]);
      const after = (await c.query(`${ROUTE_SQL} WHERE r.id = $1`, [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'school.route_changed', targetType: 'sch_route', targetId: id, before, after });
      return after;
    });
  }

  // ---- students ----

  @Get('routes/:id/students')
  @Perm('tasks:read')
  students(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT x.id, x.name, x.grade, x.stop_seq, x.guardian_name, x.guardian_phone, x.handover, x.note, x.active,
                (SELECT count(*)::int FROM (${MARKS} WHERE m.student_id = x.id ORDER BY m.trip_id, m.student_id, m.occurred_at DESC) k WHERE k.event = 'absent' AND k.occurred_at > now() - interval '30 days') AS absent_30d
           FROM ops.sch_student x WHERE x.route_id = $1 ORDER BY x.active DESC, x.stop_seq, x.name`, [id])).rows,
    }));
  }

  /** Adds students to a route (up to 100 at once, e.g. from the school's list). Hand-over defaults by grade. */
  @Post('routes/:id/students')
  @Perm('tasks:assign')
  addStudents(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const list = Array.isArray(b?.students) ? (b.students as Record<string, unknown>[]) : [b];
    if (!list.length || list.length > 100) throw new BadRequestException('students: 1-100');
    return this.db.withTenant(a, async (c) => {
      const r = (await c.query('SELECT stops FROM ops.sch_route WHERE id = $1', [id])).rows[0];
      if (!r) throw new NotFoundException();
      const nStops = (r.stops as Stop[]).length;
      const rows = list.map((x, i) => {
        const f = `students[${i}]`;
        const seq = v.int(x?.stop_seq, `${f}.stop_seq`, 1, nStops) ?? (() => { throw new BadRequestException(`${f}.stop_seq required (1-${nStops})`); })();
        const raw = v.str(x?.guardian_phone, `${f}.guardian_phone`, { required: true, max: 20 })!;
        const phone = normalizePhone(raw);
        if (!phone) throw new BadRequestException(`${f}.guardian_phone invalid`);
        const grade = v.str(x?.grade, `${f}.grade`, { max: 20 })?.trim().toUpperCase() || null;
        if (x?.handover !== undefined && typeof x.handover !== 'boolean') throw new BadRequestException(`${f}.handover must be true/false`);
        return {
          name: v.str(x?.name, `${f}.name`, { required: true, max: 120 })!, grade, seq, phone,
          guardian: v.str(x?.guardian_name, `${f}.guardian_name`, { max: 120 }), note: v.str(x?.note, `${f}.note`, { max: 300 }),
          handover: x?.handover === undefined ? needsHandover(grade) : (x.handover as boolean),
        };
      });
      const ids: string[] = [];
      for (const x of rows) {
        const sid = randomUUID();
        await c.query(`INSERT INTO ops.sch_student (id, tenant_id, route_id, name, grade, stop_seq, guardian_name, guardian_phone, handover, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sid, a.tenantId, id, x.name, x.grade, x.seq, x.guardian, x.phone, x.handover, x.note]);
        ids.push(sid);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'school.students_added', targetType: 'sch_route', targetId: id, after: { added: ids.length } });
      return { added: ids.length, ids };
    });
  }

  @Patch('students/:id')
  @Perm('tasks:assign')
  editStudent(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    return this.db.withTenant(a, async (c) => {
      const x = (await c.query('SELECT x.*, jsonb_array_length(r.stops) AS n FROM ops.sch_student x JOIN ops.sch_route r ON r.id = x.route_id WHERE x.id = $1', [id])).rows[0];
      if (!x) throw new NotFoundException();
      const raw = b?.guardian_phone === undefined ? undefined : v.str(b.guardian_phone, 'guardian_phone', { required: true, max: 20 });
      const phone = raw === undefined ? x.guardian_phone : normalizePhone(raw!);
      if (!phone) throw new BadRequestException('guardian_phone invalid');
      for (const k of ['handover', 'active']) if (b?.[k] !== undefined && typeof b[k] !== 'boolean') throw new BadRequestException(`${k} must be true/false`);
      const next = {
        name: v.str(b?.name, 'name', { max: 120 }) ?? x.name,
        grade: b?.grade === undefined ? x.grade : v.str(b.grade, 'grade', { max: 20 })?.trim().toUpperCase() || null,
        stop_seq: v.int(b?.stop_seq, 'stop_seq', 1, x.n) ?? x.stop_seq,
        guardian_name: b?.guardian_name === undefined ? x.guardian_name : v.str(b.guardian_name, 'guardian_name', { max: 120 }),
        note: b?.note === undefined ? x.note : v.str(b.note, 'note', { max: 300 }),
        handover: b?.handover ?? x.handover, active: b?.active ?? x.active,
      };
      const row = (await c.query(`UPDATE ops.sch_student SET name = $2, grade = $3, stop_seq = $4, guardian_name = $5, guardian_phone = $6, note = $7, handover = $8, active = $9
          WHERE id = $1 RETURNING id, name, grade, stop_seq, guardian_name, guardian_phone, handover, note, active`,
        [id, next.name, next.grade, next.stop_seq, next.guardian_name, phone, next.note, next.handover, next.active])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'school.student_changed', targetType: 'sch_student', targetId: id, before: x, after: row });
      return row;
    });
  }

  // ---- absence notices ----

  @Get('absences')
  @Perm('tasks:read')
  absences(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => ({
      date: day,
      data: (await c.query(
        `SELECT ab.id, ab.student_id, x.name AS student_name, x.grade, r.code AS route_code, r.school_name, ab.day::text AS day, ab.scope, ab.reported_by, ab.note, ab.created_at
           FROM ops.sch_absence ab JOIN ops.sch_student x ON x.id = ab.student_id JOIN ops.sch_route r ON r.id = x.route_id
          WHERE ab.day = $1 ORDER BY r.code, x.name`, [day])).rows,
    }));
  }

  /** A guardian or the school says the student will not ride: the day, and the morning, afternoon or both trips. */
  @Post('absences')
  @Perm('tasks:assign')
  addAbsence(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const student = v.uuid(b?.student_id, 'student_id', { required: true })!;
    const day = v.date(b?.date, 'date') ?? (() => { throw new BadRequestException('date required'); })();
    const scope = v.oneOf(b?.scope, 'scope', ABSENCE_SCOPES) ?? 'both';
    const by = v.oneOf(b?.reported_by, 'reported_by', REPORTED_BY) ?? 'guardian';
    const note = v.str(b?.note, 'note', { max: 300 });
    if (day < kwToday()) throw new BadRequestException('date is in the past');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.sch_student WHERE id = $1', [student])).rowCount) throw new BadRequestException('unknown student_id');
      const id = randomUUID();
      const row = (await c.query(`INSERT INTO ops.sch_absence (id, tenant_id, student_id, day, scope, reported_by, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (tenant_id, student_id, day, scope) DO NOTHING RETURNING id`, [id, a.tenantId, student, day, scope, by, note, a.userId])).rows[0];
      if (row) await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'school.absence_added', targetType: 'sch_student', targetId: student, after: { day, scope, reported_by: by } });
      return { id: row?.id ?? null, created: !!row };
    });
  }

  /** Withdraws a notice entered by mistake, while its day has not passed. */
  @Delete('absences/:id')
  @Perm('tasks:assign')
  removeAbsence(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const ab = (await c.query('SELECT student_id, day::text AS day, scope FROM ops.sch_absence WHERE id = $1', [id])).rows[0];
      if (!ab) throw new NotFoundException();
      if (ab.day < kwToday()) throw new ConflictException('the day has passed');
      await c.query('DELETE FROM ops.sch_absence WHERE id = $1', [id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'school.absence_removed', targetType: 'sch_student', targetId: ab.student_id, before: ab });
      return { removed: true };
    });
  }

  // ---- trips ----

  /**
   * Generates the trips of a day for the routes that run on it (all active routes, or the ones listed). Idempotent. A
   * route without a bus or driver, or whose bus, driver or attendant is booked elsewhere at that time, is skipped with
   * the reason. A route without an attendant still runs, and is flagged on the exceptions.
   */
  @Post('trips/generate')
  @Perm('tasks:assign')
  generate(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const day = v.date(b?.date, 'date') ?? kwToday();
    const only = Array.isArray(b?.route_ids) ? (b.route_ids as unknown[]).map((x, i) => v.uuid(x, `route_ids[${i}]`, { required: true })!) : null;
    const dow = isoDow(day);
    return this.db.withTenant(a, async (c) => {
      const routes = (await c.query(`${ROUTE_SQL} WHERE r.active AND $1 = ANY (r.days) AND ($2::uuid[] IS NULL OR r.id = ANY ($2)) ORDER BY to_char(r.depart_time, 'HH24:MI'), r.code`, [dow, only])).rows as RouteRow[];
      const created: string[] = [], existing: string[] = [], skipped: { code: string; reason: string }[] = [];
      for (const r of routes) {
        if ((await c.query('SELECT 1 FROM ops.sch_trip WHERE route_id = $1 AND trip_date = $2', [r.id, day])).rowCount) { existing.push(r.code); continue; }
        if (!r.asset_id) { skipped.push({ code: r.code, reason: 'no_vehicle' }); continue; }
        if (!r.driver_worker_id) { skipped.push({ code: r.code, reason: 'no_driver' }); continue; }
        const why = await this.tripFor(c, a, r, day);
        if (why) skipped.push({ code: r.code, reason: why }); else created.push(r.code);
      }
      return { date: day, created, existing, skipped };
    });
  }

  @Get('trips')
  @Perm('tasks:read')
  trips(@Auth() a: AuthContext, @Query('date') date?: string, @Query('customer_id') customer?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    const cu = v.uuid(customer, 'customer_id');
    return this.db.withTenant(a, async (c) => ({
      date: day,
      data: (await c.query(`${TRIP_SQL} WHERE st.trip_date = $1 AND ($2::uuid IS NULL OR r.customer_id = $2) ORDER BY lower(t.service_window), r.code`, [day, cu])).rows,
    }));
  }

  @Get('trips/:id')
  @Perm('tasks:read')
  trip(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query(`${TRIP_SQL} WHERE st.id = $1`, [id])).rows[0];
      if (!t) throw new NotFoundException();
      const stops = (await c.query('SELECT r.stops FROM ops.sch_route r WHERE r.id = $1', [t.route_id])).rows[0].stops;
      return { ...t, stops, students: await manifest(c, id) };
    });
  }

  /** The office records or corrects a student's mark (e.g. a call from the attendant whose phone is off). */
  @Post('trips/:id/mark')
  @HttpCode(200)
  @Perm('tasks:assign')
  mark(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const student = v.uuid(b?.student_id, 'student_id', { required: true })!;
    const event = v.oneOf(b?.event, 'event', MARK_EVENTS, { required: true })!;
    const receivedBy = v.str(b?.received_by, 'received_by', { max: 120 })?.trim() || null;
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT task_id FROM ops.sch_trip WHERE id = $1', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const bad = await markStudent(c, a, { taskId: t.task_id, studentId: student, event, receivedBy, at: new Date(), source: 'office', clientOpId: randomUUID() });
      if (bad === 'unknown_student') throw new BadRequestException('student is not on this route');
      if (bad === 'receiver_required') throw new BadRequestException('received_by required: this student is handed to an adult');
      if (bad === 'not_on_board') throw new ConflictException('the student has not boarded');
      if (bad === 'already_on_board') throw new ConflictException('the student is on the bus; drop them first');
      if (bad) throw new ConflictException('the trip is canceled or failed');
      return { students: await manifest(c, id) };
    });
  }

  @Post('trips/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:assign')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, async (c) => {
      const st = (await c.query('SELECT task_id, attendant_task_id FROM ops.sch_trip WHERE id = $1', [id])).rows[0];
      if (!st) throw new NotFoundException();
      const t = (await c.query('SELECT id, status FROM ops.task WHERE id = $1 FOR UPDATE', [st.task_id])).rows[0];
      if (t.status === 'canceled') return (await c.query(`${TRIP_SQL} WHERE st.id = $1`, [id])).rows[0];
      if (!['ready', 'assigned', 'accepted'].includes(t.status)) throw new ConflictException('the trip is under way or closed');
      for (const tid of [st.task_id, st.attendant_task_id].filter(Boolean)) {
        const cur = (await c.query('SELECT status FROM ops.task WHERE id = $1', [tid])).rows[0].status;
        if (!['ready', 'assigned', 'accepted'].includes(cur)) continue;
        await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [tid]);
        await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [tid]);
        await this.event(c, a, tid, cur, 'canceled', reason);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'school.trip_canceled', targetType: 'sch_trip', targetId: id, after: { reason } });
      return (await c.query(`${TRIP_SQL} WHERE st.id = $1`, [id])).rows[0];
    });
  }

  // ---- watch and report ----

  /**
   * For a day: students still on a bus whose trip is over or past its arrival time (the first thing to look at), trips
   * late to leave, routes not running or running without an attendant, full buses, and students absent without notice
   * several trips in a row.
   */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext, @Query('date') date?: string) {
    const day = v.date(date, 'date') ?? kwToday();
    return this.db.withTenant(a, async (c) => {
      const trips = (await c.query(`${TRIP_SQL} WHERE st.trip_date = $1 ORDER BY lower(t.service_window)`, [day])).rows;
      const onBoard = trips.filter((t) => t.on_board > 0 && (!['assigned', 'accepted', 'in_progress'].includes(t.status) || new Date(t.arrive_by).getTime() < Date.now()));
      const left_on_board = [];
      for (const t of onBoard) left_on_board.push({ ...t, students: (await manifest(c, t.id)).filter((m) => m.state === 'on_board') });
      const late = trips.filter((t) => ['assigned', 'accepted'].includes(t.status) && new Date(t.depart_at).getTime() + LATE_START_MIN * 60_000 < Date.now());
      const over = trips.filter((t) => t.capacity && t.on_board + t.dropped > t.capacity);
      const no_attendant = trips.filter((t) => !t.attendant_worker_id && t.status !== 'canceled');
      const missing = (await c.query(
        `${ROUTE_SQL} WHERE r.active AND $2 = ANY (r.days) AND NOT EXISTS (SELECT 1 FROM ops.sch_trip st WHERE st.route_id = r.id AND st.trip_date = $1) ORDER BY r.code`,
        [day, isoDow(day)])).rows.map((r) => ({ ...r, reason: !r.asset_id ? 'no_vehicle' : !r.driver_worker_id ? 'no_driver' : 'not_generated' }));
      // marked absent with no notice for that day and direction
      const streak = (await c.query(
        `WITH k AS (${MARKS} ORDER BY m.trip_id, m.student_id, m.occurred_at DESC),
              n AS (SELECT k.student_id, k.event, EXISTS (SELECT 1 FROM ops.sch_absence ab WHERE ab.student_id = k.student_id AND ab.day = st.trip_date AND ab.scope IN ('both', r.direction)) AS notice,
                           row_number() OVER (PARTITION BY k.student_id ORDER BY st.trip_date DESC, k.occurred_at DESC) AS i
                      FROM k JOIN ops.sch_trip st ON st.id = k.trip_id JOIN ops.sch_route r ON r.id = st.route_id)
         SELECT x.id, x.name, x.grade, x.guardian_name, x.guardian_phone, r.code AS route_code, r.school_name
           FROM n JOIN ops.sch_student x ON x.id = n.student_id JOIN ops.sch_route r ON r.id = x.route_id
          WHERE n.i <= $1 AND x.active GROUP BY x.id, x.name, x.grade, x.guardian_name, x.guardian_phone, r.code, r.school_name
         HAVING count(*) = $1 AND bool_and(n.event = 'absent' AND NOT n.notice) ORDER BY r.code, x.name`, [ABSENT_STREAK])).rows;
      return { date: day, left_on_board, late, missing, no_attendant, over_capacity: over, absent_streak: streak };
    });
  }

  /**
   * For a period: per school, trips run and canceled, departures on time, students carried, absences with and without
   * notice. The basis for the school's or the families' monthly invoice under their contract.
   */
  @Get('report')
  @Perm('tasks:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `SELECT q.*, (SELECT count(*)::int FROM ops.sch_absence ab JOIN ops.sch_student x ON x.id = ab.student_id
                       WHERE x.route_id = q.route_id AND ab.day = q.trip_date::date AND ab.scope IN ('both', q.direction)) AS notices
           FROM (${TRIP_SQL} WHERE st.trip_date BETWEEN $1 AND $2) q`, [f, t])).rows;
      const by = new Map<string, typeof rows>();
      for (const r of rows) by.set(r.school_name, [...(by.get(r.school_name) ?? []), r]);
      const sum = (list: typeof rows) => {
        const ran = list.filter((x) => DONE.includes(x.status));
        const timed = ran.filter((x) => x.started_at);
        const onTime = timed.filter((x) => new Date(x.started_at).getTime() <= new Date(x.depart_at).getTime() + LATE_START_MIN * 60_000).length;
        return {
          trips: list.length, completed: ran.length, canceled: list.filter((x) => x.status === 'canceled').length, failed: list.filter((x) => x.status === 'failed').length,
          on_time_pct: timed.length ? Math.round((onTime / timed.length) * 1000) / 10 : null,
          carried: ran.reduce((s, x) => s + x.dropped, 0), absences: ran.reduce((s, x) => s + x.absent, 0), notices: ran.reduce((s, x) => s + x.notices, 0),
        };
      };
      return {
        from: f, to: t,
        data: [...by.entries()].map(([k, list]) => ({ school_name: k, customer_name: list.find((x) => x.customer_name)?.customer_name ?? null, routes: new Set(list.map((x) => x.route_id)).size, ...sum(list) }))
          .sort((x, y) => y.trips - x.trips),
        totals: sum(rows),
      };
    });
  }

  // ---- helpers ----

  private parseRoute(b: Record<string, unknown>, prev: RouteRow | null) {
    const pick = <T>(k: string, parse: (x: unknown) => T, fallback: T | undefined): T => (b?.[k] === undefined && prev ? fallback as T : parse(b?.[k]));
    const code = prev ? prev.code : (() => {
      const s = v.str(b?.code, 'code', { required: true, max: 12 })!.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(s)) throw new BadRequestException('code: letters, digits, - or _ (up to 12)');
      return s;
    })();
    const duration = pick('duration_min', (x) => v.int(x, 'duration_min', 10, 240) ?? 60, prev?.duration_min);
    const r = {
      code,
      school_name: pick('school_name', (x) => v.str(x, 'school_name', { required: true, max: 120 })!, prev?.school_name),
      name: pick('name', (x) => v.str(x, 'name', { required: true, max: 120 })!, prev?.name),
      customer_id: pick('customer_id', (x) => v.uuid(x, 'customer_id'), prev?.customer_id),
      direction: pick('direction', (x) => v.oneOf(x, 'direction', DIRECTIONS, { required: true })!, prev?.direction),
      depart_time: pick('depart_time', (x) => hm(x, 'depart_time'), prev?.depart_time),
      duration_min: duration,
      days: pick('days', parseDays, prev?.days),
      stops: b?.stops === undefined && prev ? parseStops(prev.stops, duration) : parseStops(b?.stops, duration),
      capacity: pick('capacity', (x) => v.int(x, 'capacity', 1, 120), prev?.capacity),
      asset_id: pick('asset_id', (x) => v.uuid(x, 'asset_id'), prev?.asset_id),
      driver_worker_id: pick('driver_worker_id', (x) => v.uuid(x, 'driver_worker_id'), prev?.driver_worker_id),
      attendant_worker_id: pick('attendant_worker_id', (x) => v.uuid(x, 'attendant_worker_id'), prev?.attendant_worker_id),
    };
    if (r.attendant_worker_id && r.attendant_worker_id === r.driver_worker_id) throw new BadRequestException('the attendant must not be the driver');
    return r;
  }

  private async checkRefs(c: PoolClient, le: string, r: { customer_id: string | null; asset_id: string | null; driver_worker_id: string | null; attendant_worker_id: string | null }) {
    if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
    if (r.customer_id && !(await c.query('SELECT 1 FROM crm.customer WHERE id = $1 AND legal_entity_id = $2', [r.customer_id, le])).rowCount) throw new BadRequestException('unknown customer_id');
    if (r.asset_id && !(await c.query('SELECT 1 FROM fleet.asset WHERE id = $1 AND legal_entity_id = $2', [r.asset_id, le])).rowCount) throw new BadRequestException('unknown asset_id');
    if (r.driver_worker_id && !(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND kind IN ('driver','courier')`, [r.driver_worker_id, le])).rowCount) {
      throw new BadRequestException('unknown driver_worker_id');
    }
    if (r.attendant_worker_id && !(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND legal_entity_id = $2 AND kind IN ('supervisor','driver','courier')`, [r.attendant_worker_id, le])).rowCount) {
      throw new BadRequestException('unknown attendant_worker_id');
    }
  }

  /** One route's trip on a day: the driver's task with bus and driver booked, the attendant's task, and the trip row. Returns a skip reason or null. */
  private async tripFor(c: PoolClient, a: AuthContext, r: RouteRow, day: string): Promise<string | null> {
    const asset = (await c.query('SELECT status, capacity FROM fleet.asset WHERE id = $1', [r.asset_id])).rows[0];
    if (!asset || ['out_of_service', 'retired'].includes(asset.status)) return 'vehicle_out_of_service';
    if (!(await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND status = 'active'`, [r.driver_worker_id])).rowCount) return 'driver_inactive';
    const attendant = r.attendant_worker_id && (await c.query(`SELECT 1 FROM workforce.worker WHERE id = $1 AND status = 'active'`, [r.attendant_worker_id])).rowCount ? r.attendant_worker_id : null;
    const win = (await c.query(`SELECT ($1::date + $2::time) AT TIME ZONE le.timezone AS f FROM org.legal_entity le WHERE le.id = $3`, [day, r.depart_time, r.legal_entity_id])).rows[0];
    const from = new Date(win.f), to = new Date(from.getTime() + r.duration_min * 60_000);
    if (to.getTime() < Date.now()) return 'past';
    const capacity = r.capacity ?? (Number.isInteger(asset.capacity?.seats) ? asset.capacity.seats : null);
    const students = (await c.query('SELECT count(*)::int AS n FROM ops.sch_student WHERE route_id = $1 AND active', [r.id])).rows[0].n;
    const stops = r.stops.map((s) => ({ ...s, time: addMinutes(r.depart_time, s.offset_min) }));
    const last = stops[stops.length - 1];
    const ref = `SC-${r.code}-${day.replace(/-/g, '')}`;
    const attrs = {
      route_code: r.code, route_name: r.name, school_name: r.school_name, direction: r.direction, depart_time: r.depart_time, stops, students, capacity,
      customer_name: r.customer_name, address: `${stops[0].name} ← ${last.name}`,
      dropoff: { name: last.name, ...(last.lat !== undefined ? { lat: last.lat, lng: last.lng } : {}) },
    };
    const book = async (taskId: string, worker: string, asset: string | null) => c.query(
      `INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
      [randomUUID(), a.tenantId, taskId, worker, asset, from.toISOString(), to.toISOString(), a.userId]);
    const make = async (refx: string, kind: string) => {
      const t = await createTask(c, a, { le: r.legal_entity_id, pack: SCHOOL, branch: null, status: 'ready', customer: r.customer_id, site: null, ref: refx, win: { from: from.toISOString(), to: to.toISOString() }, attrs: { ...attrs, kind } });
      return t.id as string;
    };
    await c.query('SAVEPOINT trip');
    let step = 'driver';
    try {
      const task = await make(ref, 'trip');
      await book(task, r.driver_worker_id!, r.asset_id);
      let atTask: string | null = null;
      if (attendant) {
        step = 'attendant';
        atTask = await make(`${ref}-A`, 'attend');
        await book(atTask, attendant, null);
      }
      await c.query(`INSERT INTO ops.sch_trip (id, tenant_id, route_id, trip_date, task_id, attendant_task_id, asset_id, driver_worker_id, attendant_worker_id, students_planned, capacity, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(), a.tenantId, r.id, day, task, atTask, r.asset_id, r.driver_worker_id, attendant, students, capacity, a.userId]);
      for (const tid of [task, atTask].filter(Boolean) as string[]) {
        await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [tid]);
        await this.event(c, a, tid, 'ready', 'assigned', `school trip ${r.code} ${day}`);
      }
      await c.query('RELEASE SAVEPOINT trip');
      return null;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT trip');
      const k = (e as { constraint?: string }).constraint;
      if (k === 'no_asset_overlap') return 'vehicle_booked';
      if (k === 'no_worker_overlap') return step === 'attendant' ? 'attendant_booked' : 'driver_booked';
      throw e;
    }
  }

  private async event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string) {
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
  }
}
