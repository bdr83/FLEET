import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { v } from '../common/validate';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';

/** Device clocks drift and the app queues data offline: accept up to 7 days back and 5 minutes ahead. */
export const MAX_AGE_MS = 7 * 86_400_000;
export const MAX_AHEAD_MS = 5 * 60_000;
const MAX_POINTS = 500;
const MAX_OPS = 200;

/** Status changes a driver may make from the app. Dispatch-side changes (assign, cancel, review) come in P4. */
export const DRIVER_FLOW: Record<string, string[]> = {
  assigned: ['accepted'],
  accepted: ['in_progress'],
  in_progress: ['completed', 'failed'],
};

interface Worker { id: string; legal_entity_id: string; branch_id: string | null; display_name: string; kind: string; status: string }

function ts(val: unknown, field: string, { required = false } = {}): Date | null {
  if (val === undefined || val === null) {
    if (required) throw new BadRequestException(`${field} required`);
    return null;
  }
  const d = typeof val === 'string' ? new Date(val) : null;
  if (!d || Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be an ISO timestamp`);
  return d;
}
const inWindow = (d: Date) => d.getTime() >= Date.now() - MAX_AGE_MS && d.getTime() <= Date.now() + MAX_AHEAD_MS;
const num = (val: unknown, field: string, min: number, max: number, required = false): number | null => {
  if (val === undefined || val === null) {
    if (required) throw new BadRequestException(`${field} required`);
    return null;
  }
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) throw new BadRequestException(`${field} must be ${min}-${max}`);
  return val;
};

const SHIFT_COLS = `s.id, s.worker_id, s.asset_id, a.plate_no, s.started_at, s.ended_at, s.tracking_enabled, s.start_odometer_km, s.end_odometer_km`;

/**
 * Endpoints for the driver app. Every call acts on the caller's own worker record
 * (looked up from the logged-in user), never on an id sent by the app.
 */
@Controller('v1/driver')
@UseGuards(AuthGuard)
export class DriverController {
  constructor(private readonly db: DbService) {}

  private async me(c: PoolClient, a: AuthContext, { active = true } = {}): Promise<Worker> {
    const w = (await c.query(
      'SELECT id, legal_entity_id, branch_id, display_name, kind, status FROM workforce.worker WHERE user_id = $1', [a.userId])).rows[0];
    if (!w) throw new ForbiddenException('not a field worker in this company');
    if (active && w.status !== 'active') throw new ForbiddenException(`worker is ${w.status}`);
    return w;
  }

  private shift(c: PoolClient, where: string, params: unknown[]) {
    return c.query(`SELECT ${SHIFT_COLS} FROM shift.shift s LEFT JOIN fleet.asset a ON a.id = s.asset_id WHERE ${where}`, params).then((r) => r.rows[0]);
  }

  @Get('me')
  @Perm('shift:own')
  meView(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const worker = await this.me(c, a, { active: false });
      const open_shift = (await this.shift(c, 's.worker_id = $1 AND s.ended_at IS NULL AND s.started_at IS NOT NULL', [worker.id])) ?? null;
      return { worker, open_shift };
    });
  }

  /** Start a shift. Idempotent on client_op_id so an offline retry never opens a second shift. */
  @Post('shifts')
  @Perm('shift:own')
  startShift(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const op = v.uuid(b?.client_op_id, 'client_op_id', { required: true });
    const assetId = v.uuid(b?.asset_id, 'asset_id');
    const odo = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000);
    const startedAt = ts(b?.started_at, 'started_at') ?? new Date();
    if (!inWindow(startedAt)) throw new BadRequestException('started_at out of range');
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a);
      const prior = await this.shift(c, 's.start_client_op_id = $1', [op]);
      if (prior) {
        if (prior.worker_id !== w.id) throw new ConflictException('client_op_id already used');
        return prior;
      }
      if (assetId) {
        const asset = (await c.query('SELECT status, odometer_km FROM fleet.asset WHERE id = $1 FOR UPDATE', [assetId])).rows[0];
        if (!asset) throw new NotFoundException('vehicle not found');
        if (asset.status === 'out_of_service' || asset.status === 'retired') throw new ConflictException(`vehicle is ${asset.status}`);
        if (odo !== null && asset.odometer_km !== null && odo < asset.odometer_km) throw new BadRequestException('odometer is below the last reading');
      }
      const id = randomUUID();
      await c.query('SAVEPOINT s');
      try {
        await c.query(
          `INSERT INTO shift.shift (id, tenant_id, worker_id, asset_id, period, started_at, tracking_enabled, start_odometer_km, start_client_op_id)
           VALUES ($1,$2,$3,$4,tstzrange($5,NULL),$5,true,$6,$7)`, [id, a.tenantId, w.id, assetId, startedAt, odo, op]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT s');
        const k = (e as { constraint?: string }).constraint;
        if (k === 'one_open_shift') throw new ConflictException('you already have an open shift');
        if (k === 'one_open_shift_per_asset') throw new ConflictException('vehicle is in another open shift');
        throw e;
      }
      if (assetId) {
        await c.query(
          `UPDATE fleet.asset SET status = CASE WHEN status = 'available' THEN 'in_use' ELSE status END,
             odometer_km = GREATEST(odometer_km, $2) WHERE id = $1`, [assetId, odo]);
      }
      const row = await this.shift(c, 's.id = $1', [id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shift.started', targetType: 'shift', targetId: id, after: row });
      return row;
    });
  }

  /** End a shift. Ending an already ended shift returns it unchanged (safe to retry). */
  @Post('shifts/:id/end')
  @HttpCode(200)
  @Perm('shift:own')
  endShift(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const odo = v.int(b?.odometer_km, 'odometer_km', 0, 10_000_000);
    const endedAt = ts(b?.ended_at, 'ended_at') ?? new Date();
    if (!inWindow(endedAt)) throw new BadRequestException('ended_at out of range');
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a, { active: false });
      const s = (await c.query('SELECT id, asset_id, started_at, ended_at, start_odometer_km FROM shift.shift WHERE id = $1 AND worker_id = $2 FOR UPDATE', [id, w.id])).rows[0];
      if (!s) throw new NotFoundException();
      if (s.ended_at) return this.shift(c, 's.id = $1', [id]);
      if (endedAt < s.started_at) throw new BadRequestException('ended_at is before the shift started');
      if (odo !== null && s.start_odometer_km !== null && odo < s.start_odometer_km) throw new BadRequestException('odometer is below the start reading');
      await c.query(
        `UPDATE shift.shift SET ended_at = $2, period = tstzrange(started_at, $2, '[]'), end_odometer_km = $3 WHERE id = $1`, [id, endedAt, odo]);
      if (s.asset_id) {
        await c.query(
          `UPDATE fleet.asset SET status = CASE WHEN status = 'in_use' THEN 'available' ELSE status END,
             odometer_km = GREATEST(odometer_km, $2) WHERE id = $1`, [s.asset_id, odo]);
      }
      const row = await this.shift(c, 's.id = $1', [id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shift.ended', targetType: 'shift', targetId: id, after: row });
      return row;
    });
  }

  /**
   * Batch upload of GPS points (the app sends them every few seconds online, or a backlog after being offline).
   * A point is stored only if it falls inside one of the caller's tracked shifts: no tracking off shift (D6).
   * Re-sending the same points is harmless (duplicates are ignored).
   */
  @Post('locations')
  @HttpCode(200)
  @Perm('shift:own')
  locations(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const raw = b?.points;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_POINTS) throw new BadRequestException(`points must be a list of 1-${MAX_POINTS}`);
    let outOfWindow = 0;
    const points = raw.flatMap((p: Record<string, unknown>, i: number) => {
      if (!p || typeof p !== 'object') throw new BadRequestException(`points[${i}] invalid`);
      const at = ts(p.recorded_at, `points[${i}].recorded_at`, { required: true })!;
      const pt = {
        recorded_at: at.toISOString(),
        lat: num(p.lat, `points[${i}].lat`, -90, 90, true),
        lng: num(p.lng, `points[${i}].lng`, -180, 180, true),
        accuracy_m: num(p.accuracy_m, `points[${i}].accuracy_m`, 0, 100_000),
        speed_mps: num(p.speed_mps, `points[${i}].speed_mps`, 0, 150),
        heading: num(p.heading, `points[${i}].heading`, 0, 360),
        battery_pct: v.int(p.battery_pct, `points[${i}].battery_pct`, 0, 100),
        source: v.oneOf(p.source, `points[${i}].source`, ['fg', 'bg', 'sync'] as const) ?? 'fg',
      };
      if (!inWindow(at)) { outOfWindow++; return []; }
      return [pt];
    });
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a, { active: false });
      if (!points.length) return { received: raw.length, stored: 0, duplicates: 0, outside_shift: 0, out_of_window: outOfWindow };
      const r = (await c.query(
        `WITH p AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(recorded_at timestamptz, lat float8, lng float8, accuracy_m real, speed_mps real, heading real, battery_pct smallint, source text)
         ), s AS (
           SELECT p.*, sh.id AS shift_id FROM p
           JOIN LATERAL (SELECT id FROM shift.shift WHERE worker_id = $2 AND tracking_enabled AND started_at <= p.recorded_at
                           AND (ended_at IS NULL OR ended_at >= p.recorded_at) ORDER BY started_at DESC LIMIT 1) sh ON true
         ), ins AS (
           INSERT INTO geo.location_point (tenant_id, worker_id, shift_id, recorded_at, position, accuracy_m, speed_mps, heading, battery_pct, source)
           SELECT $3, $2, shift_id, recorded_at, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, accuracy_m, speed_mps, heading, battery_pct, source FROM s
           ON CONFLICT DO NOTHING RETURNING 1
         ), up AS (
           INSERT INTO geo.last_position (tenant_id, worker_id, recorded_at, position, accuracy_m, battery_pct)
           SELECT $3, $2, recorded_at, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, accuracy_m, battery_pct
             FROM s ORDER BY recorded_at DESC LIMIT 1
           ON CONFLICT (tenant_id, worker_id) DO UPDATE SET recorded_at = EXCLUDED.recorded_at, position = EXCLUDED.position,
             accuracy_m = EXCLUDED.accuracy_m, battery_pct = EXCLUDED.battery_pct
             WHERE geo.last_position.recorded_at < EXCLUDED.recorded_at
           RETURNING 1
         )
         SELECT (SELECT count(*) FROM s)::int AS in_shift, (SELECT count(*) FROM ins)::int AS stored, (SELECT count(*) FROM up)::int AS moved`,
        [JSON.stringify(points), w.id, a.tenantId])).rows[0];
      return {
        received: raw.length, stored: r.stored, duplicates: r.in_shift - r.stored,
        outside_shift: points.length - r.in_shift, out_of_window: outOfWindow,
      };
    });
  }

  /** The caller's current tasks (assigned to them and not finished). */
  @Get('tasks')
  @Perm('tasks:read_own')
  tasks(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a, { active: false });
      return {
        data: (await c.query(
          `SELECT t.id, t.status, t.sector_pack, lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
                  t.attributes, t.version, asg.asset_id
             FROM ops.task t JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active AND asg.worker_id = $1
            WHERE t.status IN ('assigned','accepted','in_progress')
            ORDER BY lower(t.service_window) NULLS LAST, t.id LIMIT 200`, [w.id])).rows,
      };
    });
  }

  /**
   * Offline sync: the app queues actions with a client_op_id and sends them in order when online.
   * Each op is applied once; a re-sent op returns "duplicate". One bad op does not block the rest.
   */
  @Post('sync')
  @HttpCode(200)
  @Perm('tasks:update_own')
  sync(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const ops = b?.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) throw new BadRequestException(`ops must be a list of 1-${MAX_OPS}`);
    const parsed = ops.map((o: Record<string, unknown>, i: number) => {
      if (!o || typeof o !== 'object') throw new BadRequestException(`ops[${i}] invalid`);
      v.oneOf(o.type, `ops[${i}].type`, ['task_status'] as const, { required: true });
      return {
        client_op_id: v.uuid(o.client_op_id, `ops[${i}].client_op_id`, { required: true })!,
        task_id: v.uuid(o.task_id, `ops[${i}].task_id`, { required: true })!,
        to_status: v.str(o.to_status, `ops[${i}].to_status`, { required: true, max: 20 })!,
        occurred_at: ts(o.occurred_at, `ops[${i}].occurred_at`, { required: true })!,
        note: v.str(o.note, `ops[${i}].note`, { max: 500 }),
      };
    });
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a);
      const results: { client_op_id: string; result: 'applied' | 'duplicate' | 'rejected'; reason?: string; status?: string }[] = [];
      for (const op of parsed) {
        const done = (await c.query('SELECT to_status FROM ops.task_event WHERE client_op_id = $1', [op.client_op_id])).rows[0];
        if (done) { results.push({ client_op_id: op.client_op_id, result: 'duplicate', status: done.to_status }); continue; }
        const reject = (reason: string, status?: string) => results.push({ client_op_id: op.client_op_id, result: 'rejected', reason, ...(status ? { status } : {}) });
        if (!inWindow(op.occurred_at)) { reject('bad_time'); continue; }
        const t = (await c.query(
          `SELECT t.status FROM ops.task t
            WHERE t.id = $1 AND EXISTS (SELECT 1 FROM ops.assignment x WHERE x.task_id = t.id AND x.active AND x.worker_id = $2)
            FOR UPDATE OF t`, [op.task_id, w.id])).rows[0];
        if (!t) { reject('not_assigned_to_you'); continue; }
        if (!(DRIVER_FLOW[t.status] ?? []).includes(op.to_status)) { reject('invalid_transition', t.status); continue; }
        if (op.to_status === 'failed' && !op.note) { reject('reason_required', t.status); continue; }
        await c.query('SAVEPOINT op');
        try {
          await c.query(
            `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, client_op_id, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), a.tenantId, op.task_id, t.status, op.to_status, op.occurred_at, a.userId, op.client_op_id, op.note]);
        } catch (e) {
          // the same op arrived twice at once from two connections
          await c.query('ROLLBACK TO SAVEPOINT op');
          if ((e as { code?: string }).code === '23505') { results.push({ client_op_id: op.client_op_id, result: 'duplicate' }); continue; }
          throw e;
        }
        await c.query('UPDATE ops.task SET status = $2, version = version + 1 WHERE id = $1', [op.task_id, op.to_status]);
        results.push({ client_op_id: op.client_op_id, result: 'applied', status: op.to_status });
      }
      return { results };
    });
  }
}
