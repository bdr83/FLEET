import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm, Pack } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { hasPermission } from '../../common/permissions';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { ASSET_TYPES, INTERNAL, InternalSettings, needsApproval, outsideHours, SETTINGS_COLS, settingsOf, tripCost } from './internal';

/** A request as the office and the requester see it. */
export const REQ_SQL = `
  SELECT r.id, r.ref, r.legal_entity_id, r.requester_user_id, u.display_name AS requester_name, u.phone AS requester_phone,
         r.department_id, d.name AS department_name, d.cost_center, r.purpose, r.destination, r.passengers, r.with_driver, r.asset_type,
         r.starts_at, r.ends_at, r.notes, r.status, r.decided_by, du.display_name AS decided_by_name, r.decided_at, r.decision_note,
         r.task_id, r.asset_id, a.plate_no, a.asset_type AS allocated_type, r.driver_worker_id, w.display_name AS driver_name,
         r.out_at, r.out_odometer_km, r.out_fuel, r.back_at, r.back_odometer_km, r.back_fuel, r.condition_note,
         (r.back_odometer_km - r.out_odometer_km) AS km, r.version, r.created_at, le.timezone
    FROM ops.vehicle_request r
    JOIN ops.department d ON d.id = r.department_id
    JOIN org.app_user u ON u.id = r.requester_user_id
    JOIN org.legal_entity le ON le.id = r.legal_entity_id
    LEFT JOIN org.app_user du ON du.id = r.decided_by
    LEFT JOIN fleet.asset a ON a.id = r.asset_id
    LEFT JOIN workforce.worker w ON w.id = r.driver_worker_id`;

const version = (b: Record<string, unknown>) => v.int(b?.version, 'version', 1, 2_147_483_647) ?? (() => { throw new BadRequestException('version required'); })();
const fuel = (val: unknown, f: string) => v.int(val, f, 0, 8);
const odo = (val: unknown, f: string) => v.int(val, f, 0, 9_999_999) ?? (() => { throw new BadRequestException(`${f} required`); })();

@Controller('v1/internal')
@UseGuards(AuthGuard)
@Pack('internal')
export class InternalController {
  constructor(private readonly db: DbService) {}

  // ---- settings and departments (the office) ----

  @Get('settings')
  @Perm('tasks:read')
  settings(@Auth() a: AuthContext, @Query('legal_entity_id') le?: string) {
    const id = v.uuid(le, 'legal_entity_id', { required: true })!;
    return this.db.withTenant(a, async (c) => ({ legal_entity_id: id, ...(await settingsOf(c, id)) }));
  }

  @Put('settings')
  @Perm('org:write')
  saveSettings(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const money = (x: unknown, f: string) => {
      if (x === undefined) return undefined;
      if (typeof x !== 'string' && typeof x !== 'number') throw new BadRequestException(`${f} invalid`);
      const s = String(x);
      if (!/^\d{1,5}(\.\d{1,3})?$/.test(s)) throw new BadRequestException(`${f} must be an amount with up to 3 decimals`);
      return s;
    };
    const hm = (x: unknown, f: string) => {
      if (x === undefined) return undefined;
      if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new BadRequestException(`${f} must be HH:MM`);
      return x;
    };
    const patch: Partial<InternalSettings> = {
      require_approval: typeof b.require_approval === 'boolean' ? b.require_approval : undefined,
      auto_approve_max_hours: b.auto_approve_max_hours === null ? null : v.int(b.auto_approve_max_hours, 'auto_approve_max_hours', 1, 72) ?? undefined,
      cost_per_km: money(b.cost_per_km, 'cost_per_km'), driver_cost_per_hour: money(b.driver_cost_per_hour, 'driver_cost_per_hour'),
      return_grace_minutes: v.int(b.return_grace_minutes, 'return_grace_minutes', 0, 600) ?? undefined,
      work_start: hm(b.work_start, 'work_start'), work_end: hm(b.work_end, 'work_end'),
    };
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const before = await settingsOf(c, le);
      const s = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)) } as InternalSettings;
      if (s.work_end <= s.work_start) throw new BadRequestException('work_end must be after work_start');
      const row = (await c.query(
        `INSERT INTO ops.internal_settings (tenant_id, legal_entity_id, require_approval, auto_approve_max_hours, cost_per_km, driver_cost_per_hour, return_grace_minutes, work_start, work_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET require_approval = EXCLUDED.require_approval, auto_approve_max_hours = EXCLUDED.auto_approve_max_hours,
           cost_per_km = EXCLUDED.cost_per_km, driver_cost_per_hour = EXCLUDED.driver_cost_per_hour, return_grace_minutes = EXCLUDED.return_grace_minutes,
           work_start = EXCLUDED.work_start, work_end = EXCLUDED.work_end, updated_at = now()
         RETURNING ${SETTINGS_COLS}`,
        [a.tenantId, le, s.require_approval, s.auto_approve_max_hours, s.cost_per_km, s.driver_cost_per_hour, s.return_grace_minutes, s.work_start, s.work_end])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'internal.settings_changed', targetType: 'legal_entity', targetId: le, before, after: row });
      return { legal_entity_id: le, ...row };
    });
  }

  /** Departments: everyone who can request a vehicle sees them (to pick theirs); the manager's name is shown for approvals. */
  @Get('departments')
  @Perm('vehicle_requests:own')
  departments(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT d.id, d.legal_entity_id, d.name, d.cost_center, d.manager_user_id, u.display_name AS manager_name, u.phone AS manager_phone, d.active,
                (SELECT count(*)::int FROM org.membership m WHERE m.department_id = d.id AND m.revoked_at IS NULL) AS members
           FROM ops.department d LEFT JOIN org.app_user u ON u.id = d.manager_user_id ORDER BY d.active DESC, d.name`)).rows,
    }));
  }

  @Post('departments')
  @Perm('org:write')
  createDepartment(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!;
    const cc = v.str(b?.cost_center, 'cost_center', { max: 30 });
    const manager = v.uuid(b?.manager_user_id, 'manager_user_id');
    return this.db.withTenant(a, async (c) => {
      if (manager) await this.assertMember(c, manager);
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.department (id, tenant_id, legal_entity_id, name, cost_center, manager_user_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, a.tenantId, le, name, cc, manager]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('a department with this name exists');
        return pgToHttp(e);
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'department.created', targetType: 'department', targetId: id, after: { name, cost_center: cc, manager_user_id: manager } });
      return (await c.query('SELECT id, legal_entity_id, name, cost_center, manager_user_id, active FROM ops.department WHERE id = $1', [id])).rows[0];
    });
  }

  @Patch('departments/:id')
  @Perm('org:write')
  updateDepartment(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { max: 120 });
    const cc = b?.cost_center === undefined ? undefined : v.str(b.cost_center, 'cost_center', { max: 30 });
    const manager = b?.manager_user_id === undefined ? undefined : v.uuid(b.manager_user_id, 'manager_user_id');
    const active = typeof b?.active === 'boolean' ? b.active : undefined;
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query('SELECT id, name, cost_center, manager_user_id, active FROM ops.department WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new NotFoundException();
      if (manager) await this.assertMember(c, manager);
      try {
        await c.query(
          `UPDATE ops.department SET name = COALESCE($2, name), cost_center = CASE WHEN $3::boolean THEN $4 ELSE cost_center END,
             manager_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE manager_user_id END, active = COALESCE($7, active) WHERE id = $1`,
          [id, name, cc !== undefined, cc ?? null, manager !== undefined, manager ?? null, active ?? null]);
      } catch (e) { return pgToHttp(e); }
      const after = (await c.query('SELECT id, legal_entity_id, name, cost_center, manager_user_id, active FROM ops.department WHERE id = $1', [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'department.updated', targetType: 'department', targetId: id, before, after });
      return after;
    });
  }

  // ---- the employee: requests and approvals ----

  /** My requests, and the requests waiting for me if I manage a department. */
  @Get('my')
  @Perm('vehicle_requests:own')
  my(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const m = (await c.query('SELECT m.department_id, d.name FROM org.membership m LEFT JOIN ops.department d ON d.id = m.department_id WHERE m.id = $1', [a.membershipId])).rows[0];
      const managed = (await c.query('SELECT id, name FROM ops.department WHERE manager_user_id = $1 AND active ORDER BY name', [a.userId])).rows;
      const u = (await c.query('SELECT display_name, phone FROM org.app_user WHERE id = $1', [a.userId])).rows[0];
      return {
        user: { id: a.userId, display_name: u?.display_name ?? null, phone: u?.phone ?? null, role: a.roleCode, permissions: a.permissions },
        department: m?.department_id ? { id: m.department_id, name: m.name } : null,
        managed,
        requests: (await c.query(`${REQ_SQL} WHERE r.requester_user_id = $1 ORDER BY r.starts_at DESC LIMIT 200`, [a.userId])).rows,
        to_approve: managed.length ? (await c.query(`${REQ_SQL} WHERE r.status = 'pending' AND d.manager_user_id = $1 ORDER BY r.starts_at LIMIT 200`, [a.userId])).rows : [],
      };
    });
  }

  /** New request. Approved at once when policy allows (approval off, a short trip, or the department manager asking). */
  @Post('requests')
  @Perm('vehicle_requests:own')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const purpose = v.str(b?.purpose, 'purpose', { required: true, max: 300 })!;
    const destination = v.str(b?.destination, 'destination', { max: 300 });
    const passengers = v.int(b?.passengers, 'passengers', 1, 60) ?? 1;
    const withDriver = b?.with_driver === true;
    const type = v.oneOf(b?.asset_type, 'asset_type', ASSET_TYPES);
    const from = v.str(b?.starts_at, 'starts_at', { required: true, max: 40 })!, to = v.str(b?.ends_at, 'ends_at', { required: true, max: 40 })!;
    const f = new Date(from), t = new Date(to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException('starts_at and ends_at must be ISO times');
    if (t <= f) throw new BadRequestException('ends_at must be after starts_at');
    if (t.getTime() - f.getTime() > 31 * 86_400_000) throw new BadRequestException('a request is at most 31 days');
    if (t.getTime() < Date.now()) throw new BadRequestException('the period is in the past');
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    const deptIn = v.uuid(b?.department_id, 'department_id');
    return this.db.withTenant(a, async (c) => {
      const mine = (await c.query('SELECT department_id FROM org.membership WHERE id = $1', [a.membershipId])).rows[0]?.department_id ?? null;
      const deptId = deptIn ?? mine;
      if (!deptId) throw new BadRequestException('choose a department (department_id): you are not in one');
      // an employee asks for their own department; the office may ask for any
      if (deptIn && mine && deptIn !== mine && !hasPermission(a.permissions, 'tasks:write')) throw new ForbiddenException('you can only ask for your own department');
      const d = (await c.query('SELECT id, legal_entity_id, manager_user_id, active FROM ops.department WHERE id = $1', [deptId])).rows[0];
      if (!d || !d.active) throw new BadRequestException('unknown department_id');
      const s = await settingsOf(c, d.legal_entity_id);
      const approve = !needsApproval(s, (t.getTime() - f.getTime()) / 3_600_000, d.manager_user_id === a.userId);
      const n = (await c.query(`SELECT coalesce(max(substring(ref from 4)::int), 0) + 1 AS n FROM ops.vehicle_request`)).rows[0].n;
      const id = randomUUID();
      await c.query(
        `INSERT INTO ops.vehicle_request (id, tenant_id, legal_entity_id, ref, requester_user_id, department_id, purpose, destination, passengers, with_driver, asset_type, starts_at, ends_at, notes, status, decided_at, decision_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, a.tenantId, d.legal_entity_id, `VR-${n}`, a.userId, deptId, purpose, destination, passengers, withDriver, type, f.toISOString(), t.toISOString(), notes,
         approve ? 'approved' : 'pending', approve ? new Date().toISOString() : null, approve ? 'approved automatically by policy' : null]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'vehicle_request.created', targetType: 'vehicle_request', targetId: id, after: { purpose, from, to, with_driver: withDriver, auto_approved: approve } });
      return this.one(c, id);
    });
  }

  /** The department manager (or the fleet office) approves or rejects a pending request. */
  @Post('requests/:id/decide')
  @HttpCode(200)
  @Perm('vehicle_requests:own')
  decide(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    if (typeof b?.approve !== 'boolean') throw new BadRequestException('approve must be true or false');
    const note = v.str(b?.note, 'note', { max: 500 });
    if (!b.approve && !note) throw new BadRequestException('give a reason to reject');
    return this.db.withTenant(a, async (c) => {
      const r = await this.lock(c, id, ver);
      const mgr = (await c.query('SELECT manager_user_id FROM ops.department WHERE id = $1', [r.department_id])).rows[0].manager_user_id;
      if (mgr !== a.userId && !hasPermission(a.permissions, 'tasks:assign')) throw new ForbiddenException('only the department manager or the fleet office decides');
      if (r.requester_user_id === a.userId && mgr !== a.userId && !hasPermission(a.permissions, 'tasks:assign')) throw new ForbiddenException('you cannot approve your own request');
      if (r.status !== 'pending') throw new ConflictException(`the request is ${r.status}`);
      await c.query(`UPDATE ops.vehicle_request SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, b.approve ? 'approved' : 'rejected', a.userId, note]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: b.approve ? 'vehicle_request.approved' : 'vehicle_request.rejected', targetType: 'vehicle_request', targetId: id, after: { note } });
      return this.one(c, id);
    });
  }

  /** The requester (or the office) cancels before the vehicle is handed over; the booking is released. */
  @Post('requests/:id/cancel')
  @HttpCode(200)
  @Perm('vehicle_requests:own')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const reason = v.str(b?.reason, 'reason', { max: 500 }) ?? 'canceled';
    return this.db.withTenant(a, async (c) => {
      const r = await this.lock(c, id, ver);
      if (r.requester_user_id !== a.userId && !hasPermission(a.permissions, 'tasks:write')) throw new ForbiddenException();
      if (!['pending', 'approved', 'allocated'].includes(r.status)) throw new ConflictException(`cannot cancel a request that is ${r.status}`);
      if (r.task_id) await this.cancelTask(c, a, r.task_id, `request canceled: ${reason}`);
      await c.query(`UPDATE ops.vehicle_request SET status = 'canceled', decision_note = COALESCE(decision_note, $2), version = version + 1, updated_at = now() WHERE id = $1`, [id, reason]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'vehicle_request.canceled', targetType: 'vehicle_request', targetId: id, after: { reason } });
      return this.one(c, id);
    });
  }

  // ---- the fleet office ----

  @Get('requests')
  @Perm('tasks:read')
  list(@Auth() a: AuthContext, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const st = v.oneOf(status, 'status', ['pending', 'approved', 'rejected', 'allocated', 'in_use', 'returned', 'canceled', 'open'] as const);
    const f = from ? new Date(from) : new Date(Date.now() - 7 * 86_400_000), t = to ? new Date(to) : new Date(Date.now() + 31 * 86_400_000);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException('from/to must be ISO times');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `${REQ_SQL} WHERE r.starts_at < $2 AND r.ends_at > $1
           AND ($3::text IS NULL OR ($3 = 'open' AND r.status IN ('pending','approved','allocated','in_use')) OR r.status = $3)
         ORDER BY r.starts_at LIMIT 1000`, [f.toISOString(), t.toISOString(), st])).rows,
    }));
  }

  @Get('requests/:id')
  @Perm('vehicle_requests:own')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const r = await this.one(c, id);
      const mgr = (await c.query('SELECT manager_user_id FROM ops.department WHERE id = $1', [r.department_id])).rows[0].manager_user_id;
      if (r.requester_user_id !== a.userId && mgr !== a.userId && !hasPermission(a.permissions, 'tasks:read')) throw new NotFoundException();
      return r;
    });
  }

  /** Vehicles free for the whole period (best match first) and, for a trip with a driver, drivers free then. */
  @Get('requests/:id/options')
  @Perm('tasks:assign')
  options(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const r = await this.one(c, id);
      const vehicles = (await c.query(
        `SELECT * FROM (SELECT a.id, a.plate_no, a.asset_type, a.status, a.odometer_km, (a.asset_type = $4::text) AS matches,
                (SELECT jsonb_build_object('task_id', x.task_id, 'from', lower(x.period), 'to', upper(x.period)) FROM ops.assignment x
                  WHERE x.asset_id = a.id AND x.active AND x.period && tstzrange($2::timestamptz, $3::timestamptz) LIMIT 1) AS busy
           FROM fleet.asset a
          WHERE a.legal_entity_id = $1 AND a.status NOT IN ('out_of_service','retired') AND a.asset_type NOT IN ('mixer','pump','trailer')
        ) v ORDER BY busy IS NOT NULL, matches DESC NULLS LAST, plate_no`, [r.legal_entity_id, r.starts_at, r.ends_at, r.asset_type])).rows;
      const drivers = r.with_driver ? (await c.query(
        `SELECT w.id, w.display_name,
                EXISTS (SELECT 1 FROM ops.assignment x WHERE x.worker_id = w.id AND x.active AND x.exclusive AND x.period && tstzrange($2::timestamptz, $3::timestamptz)) AS busy
           FROM workforce.worker w WHERE w.legal_entity_id = $1 AND w.status = 'active' AND w.kind = 'driver' ORDER BY busy, w.display_name`,
        [r.legal_entity_id, r.starts_at, r.ends_at])).rows : [];
      return { vehicles, drivers };
    });
  }

  /** Books a vehicle (and a driver) for the period: an internal@1 task with an exclusive booking. */
  @Post('requests/:id/allocate')
  @HttpCode(200)
  @Perm('tasks:assign')
  allocate(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const assetId = v.uuid(b?.asset_id, 'asset_id', { required: true })!;
    const driverId = v.uuid(b?.driver_worker_id, 'driver_worker_id');
    return this.db.withTenant(a, async (c) => {
      const r = await this.lock(c, id, ver);
      if (r.status !== 'approved') throw new ConflictException(r.status === 'pending' ? 'the request is not approved yet' : `the request is ${r.status}`);
      if (r.with_driver && !driverId) throw new BadRequestException('the request is with a driver: send driver_worker_id');
      if (!r.with_driver && driverId) throw new BadRequestException('the requester drives: no driver needed');
      const x = (await c.query('SELECT legal_entity_id, status FROM fleet.asset WHERE id = $1', [assetId])).rows[0];
      if (!x || x.legal_entity_id !== r.legal_entity_id) throw new BadRequestException('unknown asset_id');
      if (x.status === 'out_of_service' || x.status === 'retired') throw new ConflictException(`vehicle is ${x.status}`);
      if (driverId) {
        const w = (await c.query('SELECT legal_entity_id, status, kind FROM workforce.worker WHERE id = $1', [driverId])).rows[0];
        if (!w || w.legal_entity_id !== r.legal_entity_id || w.kind !== 'driver') throw new BadRequestException('unknown driver_worker_id');
        if (w.status !== 'active') throw new ConflictException(`driver is ${w.status}`);
      }
      const full = (await c.query(`${REQ_SQL} WHERE r.id = $1`, [id])).rows[0];
      const task = await createTask(c, a, {
        le: r.legal_entity_id, pack: INTERNAL, branch: null, status: 'ready', customer: null, site: null, ref: full.ref,
        win: { from: new Date(r.starts_at).toISOString(), to: new Date(r.ends_at).toISOString() },
        attrs: { request_id: id, request_ref: full.ref, purpose: full.purpose, address: full.destination, destination: full.destination, department: full.department_name,
          requester: full.requester_name, requester_phone: full.requester_phone, passengers: full.passengers, with_driver: r.with_driver },
      });
      await c.query('SAVEPOINT asg');
      try {
        await c.query(
          `INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, asset_id, exclusive, period, assigned_by) VALUES ($1,$2,$3,$4,$5,true,tstzrange($6,$7),$8)`,
          [randomUUID(), a.tenantId, task.id, driverId, assetId, r.starts_at, r.ends_at, a.userId]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT asg');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'no_asset_overlap') throw new ConflictException('vehicle is already booked in this period');
        if (k === 'no_worker_overlap') throw new ConflictException('driver already has a booking in this period');
        throw e;
      }
      await c.query(`UPDATE ops.task SET status = 'assigned', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await this.event(c, a, task.id, 'ready', 'assigned', `allocated for ${full.ref}`);
      await c.query(`UPDATE ops.vehicle_request SET status = 'allocated', task_id = $2, asset_id = $3, driver_worker_id = $4, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, task.id, assetId, driverId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'vehicle_request.allocated', targetType: 'vehicle_request', targetId: id, after: { asset_id: assetId, driver_worker_id: driverId } });
      return this.one(c, id);
    });
  }

  /** Keys handed over at the desk: odometer and fuel out. A trip with a driver is handed over from the driver app. */
  @Post('requests/:id/handover')
  @HttpCode(200)
  @Perm('tasks:write')
  handover(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const km = odo(b?.odometer_km, 'odometer_km'), fl = fuel(b?.fuel, 'fuel');
    const note = v.str(b?.note, 'note', { max: 500 });
    return this.db.withTenant(a, async (c) => {
      await this.lock(c, id, ver);
      await vehicleOut(c, a, id, new Date(), km, fl, note, 'staff');
      return this.one(c, id);
    });
  }

  /** Vehicle back: odometer, fuel and condition; the booking ends now so the vehicle is free again. */
  @Post('requests/:id/return')
  @HttpCode(200)
  @Perm('tasks:write')
  giveBack(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ver = version(b);
    const km = odo(b?.odometer_km, 'odometer_km'), fl = fuel(b?.fuel, 'fuel');
    const note = v.str(b?.note, 'note', { max: 500 });
    return this.db.withTenant(a, async (c) => {
      await this.lock(c, id, ver);
      await vehicleBack(c, a, id, new Date(), km, fl, note, 'staff');
      return this.one(c, id);
    });
  }

  /** Vehicles and their bookings for a day (Kuwait time by default), with what each one is doing now. */
  @Get('board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('date') date?: string) {
    const d = v.date(date, 'date');
    return this.db.withTenant(a, async (c) => {
      const tz = (await c.query('SELECT timezone FROM org.legal_entity ORDER BY id LIMIT 1')).rows[0]?.timezone ?? 'Asia/Kuwait';
      const day = d ?? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      const range = (await c.query(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS f, (($1::date + 1)::timestamp AT TIME ZONE $2) AS t`, [day, tz])).rows[0];
      const vehicles = (await c.query(
        `SELECT a.id, a.plate_no, a.asset_type, a.status, a.odometer_km FROM fleet.asset a
          WHERE a.status <> 'retired' AND a.asset_type NOT IN ('mixer','pump','trailer') ORDER BY a.plate_no`)).rows;
      const bookings = (await c.query(
        `SELECT x.asset_id, lower(x.period) AS "from", upper(x.period) AS "to", t.sector_pack, t.status AS task_status, t.ref,
                r.id AS request_id, r.status, d.name AS department_name, u.display_name AS requester_name, w.display_name AS driver_name
           FROM ops.assignment x JOIN ops.task t ON t.id = x.task_id
           LEFT JOIN ops.vehicle_request r ON r.task_id = t.id LEFT JOIN ops.department d ON d.id = r.department_id
           LEFT JOIN org.app_user u ON u.id = r.requester_user_id LEFT JOIN workforce.worker w ON w.id = x.worker_id
          WHERE x.active AND x.asset_id IS NOT NULL AND (x.period && tstzrange($1, $2) OR r.status = 'in_use') ORDER BY lower(x.period)`, [range.f, range.t])).rows;
      const now = Date.now();
      const rows = vehicles.map((v) => {
        const mine = bookings.filter((b) => b.asset_id === v.id);
        const cur = mine.find((b) => b.status === 'in_use' || (Date.parse(b.from) <= now && Date.parse(b.to) > now));
        const state = v.status === 'out_of_service' ? 'out_of_service' : cur?.status === 'in_use' ? 'in_use' : cur ? 'booked' : 'free';
        return { ...v, state, bookings: mine };
      });
      const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.state]: (m[r.state] ?? 0) + 1 }), {});
      const pending = (await c.query(`SELECT count(*)::int AS n FROM ops.vehicle_request WHERE status = 'pending'`)).rows[0].n;
      const toAllocate = (await c.query(`SELECT count(*)::int AS n FROM ops.vehicle_request WHERE status = 'approved' AND ends_at > now()`)).rows[0].n;
      return { date: day, from: range.f, to: range.t, vehicles: rows, counts, pending, to_allocate: toAllocate };
    });
  }

  /** What needs the fleet office: approved and not allocated, not picked up, overdue returns, waiting approvals, trips outside working hours. */
  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const sets = `LEFT JOIN ops.internal_settings s ON s.legal_entity_id = r.legal_entity_id`;
      const q = async (where: string) => (await c.query(`SELECT x.* FROM (${REQ_SQL}) x JOIN ops.vehicle_request r ON r.id = x.id ${sets} WHERE ${where} ORDER BY x.starts_at LIMIT 200`)).rows;
      const to_allocate = await q(`x.status = 'approved' AND x.starts_at < now() + interval '24 hours' AND x.ends_at > now()`);
      const not_picked = await q(`x.status = 'allocated' AND x.starts_at + make_interval(mins => COALESCE(s.return_grace_minutes, 30)) < now()`);
      const overdue = await q(`x.status = 'in_use' AND x.ends_at + make_interval(mins => COALESCE(s.return_grace_minutes, 30)) < now()`);
      const waiting = await q(`x.status = 'pending' AND (x.created_at < now() - interval '4 hours' OR x.starts_at < now() + interval '24 hours')`);
      const upcoming = (await c.query(`SELECT x.*, COALESCE(to_char(s.work_start, 'HH24:MI'), '07:00') AS work_start, COALESCE(to_char(s.work_end, 'HH24:MI'), '17:00') AS work_end
          FROM (${REQ_SQL}) x JOIN ops.vehicle_request r ON r.id = x.id ${sets}
         WHERE x.status IN ('pending','approved','allocated') AND x.starts_at < now() + interval '7 days' AND x.ends_at > now() ORDER BY x.starts_at LIMIT 500`)).rows;
      const after_hours = upcoming.filter((r) => outsideHours(new Date(r.starts_at), new Date(r.ends_at), r.timezone, r.work_start, r.work_end));
      return { to_allocate, not_picked, overdue, waiting, after_hours };
    });
  }

  /** Who had the vehicle at that time (a traffic fine or damage): the requester and driver of the trip covering it. */
  @Get('who')
  @Perm('tasks:read')
  who(@Auth() a: AuthContext, @Query('asset_id') assetId?: string, @Query('at') at?: string) {
    const id = v.uuid(assetId, 'asset_id', { required: true })!;
    const t = at ? new Date(at) : null;
    if (!t || Number.isNaN(t.getTime())) throw new BadRequestException('at must be an ISO time');
    return this.db.withTenant(a, async (c) => {
      // the actual hand-over times win over the booked period
      const trip = (await c.query(
        `${REQ_SQL} WHERE r.asset_id = $1 AND r.status IN ('allocated','in_use','returned')
           AND tstzrange(COALESCE(r.out_at, r.starts_at), COALESCE(r.back_at, CASE WHEN r.status = 'in_use' THEN 'infinity'::timestamptz ELSE r.ends_at END)) @> $2::timestamptz
         ORDER BY r.out_at DESC NULLS LAST LIMIT 1`, [id, t.toISOString()])).rows[0] ?? null;
      const shift = trip ? null : (await c.query(
        `SELECT s.id AS shift_id, w.id AS worker_id, w.display_name AS driver_name, s.started_at, s.ended_at FROM shift.shift s JOIN workforce.worker w ON w.id = s.worker_id
          WHERE s.asset_id = $1 AND s.started_at <= $2 AND (s.ended_at IS NULL OR s.ended_at > $2) ORDER BY s.started_at DESC LIMIT 1`, [id, t.toISOString()])).rows[0] ?? null;
      return { asset_id: id, at: t.toISOString(), trip, shift };
    });
  }

  /** Charge-back per department for returned trips: km × rate, driver hours × rate, and approved expenses on the vehicle during the trip. */
  @Get('costs')
  @Perm('reports:read')
  costs(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string, @Query('legal_entity_id') le?: string) {
    const f = v.date(from, 'from') ?? (() => { throw new BadRequestException('from required'); })();
    const t = v.date(to, 'to') ?? (() => { throw new BadRequestException('to required'); })();
    if (t < f) throw new BadRequestException('to is before from');
    const leId = v.uuid(le, 'legal_entity_id');
    return this.db.withTenant(a, async (c) => {
      const trips = (await c.query(
        `SELECT r.id, r.ref, r.legal_entity_id, r.department_id, d.name AS department_name, d.cost_center, r.with_driver, r.out_at, r.back_at,
                (r.back_odometer_km - r.out_odometer_km) AS km, EXTRACT(EPOCH FROM (r.back_at - r.out_at)) / 3600 AS hours,
                (SELECT coalesce(sum(e.amount), 0)::text FROM maint.expense e WHERE e.asset_id = r.asset_id AND e.status = 'approved' AND e.spent_at >= r.out_at AND e.spent_at <= r.back_at) AS expenses
           FROM ops.vehicle_request r JOIN ops.department d ON d.id = r.department_id JOIN org.legal_entity le ON le.id = r.legal_entity_id
          WHERE r.status = 'returned' AND (r.back_at AT TIME ZONE le.timezone)::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR r.legal_entity_id = $3)`, [f, t, leId])).rows;
      const sets = new Map<string, InternalSettings>();
      const out = new Map<string, { department_id: string; department_name: string; cost_center: string | null; trips: number; km: number; hours: number; distance_cost: number; expenses: number }>();
      for (const r of trips) {
        if (!sets.has(r.legal_entity_id)) sets.set(r.legal_entity_id, await settingsOf(c, r.legal_entity_id));
        const s = sets.get(r.legal_entity_id)!;
        const hours = Number(r.hours);
        const cost = Number(tripCost(r.km ?? 0, r.with_driver ? hours : 0, s.cost_per_km, s.driver_cost_per_hour));
        const o = out.get(r.department_id) ?? { department_id: r.department_id, department_name: r.department_name, cost_center: r.cost_center, trips: 0, km: 0, hours: 0, distance_cost: 0, expenses: 0 };
        o.trips += 1; o.km += r.km ?? 0; o.hours += hours; o.distance_cost += cost; o.expenses += Number(r.expenses);
        out.set(r.department_id, o);
      }
      const data = [...out.values()].map((o) => ({ ...o, hours: Math.round(o.hours * 100) / 100, distance_cost: o.distance_cost.toFixed(3), expenses: o.expenses.toFixed(3),
        total: (o.distance_cost + o.expenses).toFixed(3) })).sort((x, y) => Number(y.total) - Number(x.total));
      return { from: f, to: t, data };
    });
  }

  // ---- helpers ----

  private async one(c: PoolClient, id: string) {
    const r = (await c.query(`${REQ_SQL} WHERE r.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  private async lock(c: PoolClient, id: string, ver: number) {
    const r = (await c.query('SELECT * FROM ops.vehicle_request WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new NotFoundException();
    if (r.version !== ver) throw new ConflictException({ message: 'request changed since you loaded it', current_version: r.version });
    return r;
  }

  private async assertMember(c: PoolClient, userId: string) {
    if (!(await c.query('SELECT 1 FROM org.membership WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rowCount) throw new BadRequestException('manager_user_id is not a member of this company');
  }

  private async cancelTask(c: PoolClient, a: AuthContext, taskId: string, note: string) {
    // the booking is released even when the trip already failed, so the vehicle is free for others
    await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [taskId]);
    const t = (await c.query('SELECT status FROM ops.task WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
    if (!t || ['completed', 'reviewed', 'invoiced', 'failed', 'canceled'].includes(t.status)) return;
    await c.query(`UPDATE ops.task SET status = 'canceled', version = version + 1, updated_at = now() WHERE id = $1`, [taskId]);
    await this.event(c, a, taskId, t.status, 'canceled', note.slice(0, 500));
  }

  private async event(c: PoolClient, a: AuthContext, taskId: string, from: string, to: string, note: string | null) {
    await c.query(
      `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,now(),$6,'staff',$7,$8)`,
      [randomUUID(), a.tenantId, taskId, from, to, a.userId, randomUUID(), note]);
  }
}

/**
 * Hand-over: the request goes in use and its task starts. Shared by the office desk and the driver app (milestone vehicle_out).
 * The task's status change is written by the caller when it comes from the app (the sync op itself).
 */
export async function vehicleOut(c: PoolClient, a: AuthContext, requestId: string, at: Date, km: number, fl: number | null, note: string | null, by: 'staff' | 'driver') {
  const r = (await c.query('SELECT id, status, task_id, asset_id FROM ops.vehicle_request WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
  if (!r) throw new NotFoundException();
  if (r.status !== 'allocated') throw new ConflictException(`the request is ${r.status}`);
  const last = (await c.query('SELECT odometer_km FROM fleet.asset WHERE id = $1', [r.asset_id])).rows[0]?.odometer_km;
  if (last !== null && last !== undefined && km < last) throw new BadRequestException(`odometer is below the last reading (${last} km)`);
  await c.query(`UPDATE ops.vehicle_request SET status = 'in_use', out_at = $2, out_odometer_km = $3, out_fuel = $4, condition_note = $5, version = version + 1, updated_at = now() WHERE id = $1`,
    [requestId, at.toISOString(), km, fl, note]);
  await c.query('UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2) WHERE id = $1', [r.asset_id, km]);
  // taken before the booked start: the booking starts now, unless another trip has the vehicle then
  await c.query('SAVEPOINT early');
  try {
    await c.query(`UPDATE ops.assignment SET period = tstzrange($2::timestamptz, upper(period)) WHERE task_id = $1 AND active AND lower(period) > $2::timestamptz`, [r.task_id, at.toISOString()]);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT early');
    if ((e as { constraint?: string }).constraint === 'no_asset_overlap') throw new ConflictException('vehicle is booked by another trip before this one starts');
    throw e;
  }
  if (by === 'staff') await staffStep(c, a, r.task_id, 'vehicle_out', ['assigned', 'accepted'], 'in_progress', at, 'vehicle handed over');
}

/** Return: odometer and fuel back, the booking ends now, the task completes. Shared by the desk and the driver app (vehicle_back). */
export async function vehicleBack(c: PoolClient, a: AuthContext, requestId: string, at: Date, km: number, fl: number | null, note: string | null, by: 'staff' | 'driver') {
  const r = (await c.query('SELECT id, status, task_id, asset_id, out_odometer_km, condition_note FROM ops.vehicle_request WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
  if (!r) throw new NotFoundException();
  if (r.status !== 'in_use') throw new ConflictException(`the request is ${r.status}`);
  if (km < r.out_odometer_km) throw new BadRequestException(`odometer is below the hand-over reading (${r.out_odometer_km} km)`);
  await c.query(`UPDATE ops.vehicle_request SET status = 'returned', back_at = $2, back_odometer_km = $3, back_fuel = $4,
      condition_note = CASE WHEN $5::text IS NULL THEN condition_note ELSE concat_ws(' | ', condition_note, $5::text) END, version = version + 1, updated_at = now() WHERE id = $1`,
    [requestId, at.toISOString(), km, fl, note]);
  await c.query('UPDATE fleet.asset SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2) WHERE id = $1', [r.asset_id, km]);
  // the vehicle is free from now, not from the end of the booked period
  await c.query(`UPDATE ops.assignment SET period = tstzrange(lower(period), GREATEST($2::timestamptz, lower(period) + interval '1 minute'))
                  WHERE task_id = $1 AND active AND upper(period) > $2::timestamptz`, [r.task_id, at.toISOString()]);
  if (by === 'staff') await staffStep(c, a, r.task_id, 'vehicle_back', ['assigned', 'accepted', 'in_progress'], 'completed', at, 'vehicle returned');
}

/**
 * The fleet office recorded the hand-over or return: write the same milestone the driver app would (so a driver still on the
 * trip can carry on), and move the task forward only from a state that leads there (a failed trip stays failed).
 */
async function staffStep(c: PoolClient, a: AuthContext, taskId: string, code: 'vehicle_out' | 'vehicle_back', from: string[], to: string, at: Date, note: string) {
  if (!(await c.query('SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = $2', [taskId, code])).rowCount) {
    await c.query(`INSERT INTO ops.task_milestone (id, tenant_id, task_id, code, occurred_at, actor_id, client_op_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,'by the fleet office')`,
      [randomUUID(), a.tenantId, taskId, code, at.toISOString(), a.userId, randomUUID()]);
  }
  const t = (await c.query('SELECT status FROM ops.task WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!t || !from.includes(t.status)) return;
  await c.query('UPDATE ops.task SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [taskId, to]);
  await c.query(
    `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',$8,$9)`,
    [randomUUID(), a.tenantId, taskId, t.status, to, at.toISOString(), a.userId, randomUUID(), note]);
}

