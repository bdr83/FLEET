import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'crypto';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { v } from '../common/validate';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { FAIL_REASONS, isDelivery, needsProof, PIN_MAX_ATTEMPTS, STAGE_ALLOWED, STAGES } from '../sectors/delivery/delivery';
import * as concrete from '../sectors/concrete/concrete';
import * as staffing from '../sectors/staffing/staffing';
import { haversineKm } from '../sectors/delivery/delivery';
import * as internal from '../sectors/internal/internal';
import { vehicleBack, vehicleOut } from '../sectors/internal/internal.controller';
import * as dist from '../sectors/distribution/distribution';
import * as freight from '../sectors/freight/freight';
import * as shuttle from '../sectors/shuttle/shuttle';
import * as equipment from '../sectors/equipment/equipment';
import { equipStage } from '../sectors/equipment/equipment.controller';
import * as rental from '../sectors/rental/rental';
import * as service from '../sectors/service/service';
import { serviceStage } from '../sectors/service/service.controller';
import { rentalStage } from '../sectors/rental/rental.controller';
import * as moving from '../sectors/moving/moving';
import { movingStage } from '../sectors/moving/moving.controller';
import { markRider } from '../sectors/shuttle/shuttle.controller';
import { addReading, parseProof, ProofIn, routeOut, routeStage, stopProof } from '../sectors/distribution/distribution.controller';

/** Stage codes and failure reasons of every pack; each op is checked against its own task's pack when applied. */
const ALL_STAGES = [...new Set<string>([...STAGES, ...concrete.STAGES, ...staffing.STAGES, ...internal.STAGES, ...dist.STAGES, ...freight.STAGES, ...equipment.STAGES, ...rental.STAGES, ...service.STAGES, ...moving.STAGES])];
const ALL_REASONS = [...new Set<string>([...FAIL_REASONS, ...concrete.FAIL_REASONS, ...staffing.FAIL_REASONS, ...internal.FAIL_REASONS, ...dist.FAIL_REASONS, ...freight.FAIL_REASONS, ...shuttle.FAIL_REASONS, ...equipment.FAIL_REASONS, ...rental.FAIL_REASONS, ...service.FAIL_REASONS, ...moving.FAIL_REASONS])];
function stageRule(pack: string, code: string): { allowed: string[]; needs?: string } | null {
  if (isDelivery(pack)) return (STAGES as readonly string[]).includes(code) ? { allowed: STAGE_ALLOWED[code as keyof typeof STAGE_ALLOWED] } : null;
  if (staffing.isStaffing(pack)) {
    const c = code as staffing.Stage;
    return (staffing.STAGES as readonly string[]).includes(code) ? { allowed: staffing.STAGE_ALLOWED[c], needs: staffing.STAGE_NEEDS[c] } : null;
  }
  if (dist.isDistribution(pack)) {
    const c = code as dist.Stage;
    return (dist.STAGES as readonly string[]).includes(code) ? { allowed: dist.STAGE_ALLOWED[c], needs: dist.STAGE_NEEDS[c] } : null;
  }
  if (internal.isInternal(pack)) {
    const c = code as internal.Stage;
    return (internal.STAGES as readonly string[]).includes(code) ? { allowed: internal.STAGE_ALLOWED[c], needs: internal.STAGE_NEEDS[c] } : null;
  }
  if (freight.isFreight(pack)) {
    const c = code as freight.Stage;
    return (freight.STAGES as readonly string[]).includes(code) ? { allowed: freight.STAGE_ALLOWED[c], needs: freight.STAGE_NEEDS[c] } : null;
  }
  if (equipment.isEquipment(pack)) {
    const c = code as equipment.Stage;
    return (equipment.STAGES as readonly string[]).includes(code) ? { allowed: equipment.STAGE_ALLOWED[c], needs: equipment.STAGE_NEEDS[c] } : null;
  }
  if (service.isService(pack)) {
    const c = code as service.Stage;
    return (service.STAGES as readonly string[]).includes(code) ? { allowed: service.STAGE_ALLOWED[c], needs: service.STAGE_NEEDS[c] } : null;
  }
  if (moving.isMoving(pack)) {
    const c = code as moving.Stage;
    return (moving.STAGES as readonly string[]).includes(code) ? { allowed: moving.STAGE_ALLOWED[c], needs: moving.STAGE_NEEDS[c] } : null;
  }
  if (rental.isRental(pack)) {
    return (rental.STAGES as readonly string[]).includes(code) ? { allowed: rental.STAGE_ALLOWED[code as rental.Stage] } : null;
  }
  if (concrete.isConcrete(pack)) {
    const c = code as concrete.Stage;
    return (concrete.STAGES as readonly string[]).includes(code) ? { allowed: concrete.STAGE_ALLOWED[c], needs: concrete.STAGE_NEEDS[c] } : null;
  }
  return null;
}
function reasonsOf(pack: string): readonly string[] | null {
  return isDelivery(pack) ? FAIL_REASONS : concrete.isConcrete(pack) ? concrete.FAIL_REASONS : staffing.isStaffing(pack) ? staffing.FAIL_REASONS
    : internal.isInternal(pack) ? internal.FAIL_REASONS : dist.isDistribution(pack) ? dist.FAIL_REASONS : freight.isFreight(pack) ? freight.FAIL_REASONS : shuttle.isShuttle(pack) ? shuttle.FAIL_REASONS : equipment.isEquipment(pack) ? equipment.FAIL_REASONS : rental.isRental(pack) ? rental.FAIL_REASONS : service.isService(pack) ? service.FAIL_REASONS : moving.isMoving(pack) ? moving.FAIL_REASONS : null;
}

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

  /** Vehicles the driver may pick when starting a shift: same company, in service, not in another open shift. */
  @Get('assets')
  @Perm('shift:own')
  assets(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a, { active: false });
      return {
        data: (await c.query(
          `SELECT a.id, a.plate_no, a.asset_type, a.make, a.model, a.odometer_km FROM fleet.asset a
            WHERE a.legal_entity_id = $1 AND a.status IN ('available','in_use')
              AND NOT EXISTS (SELECT 1 FROM shift.shift s WHERE s.asset_id = a.id AND s.ended_at IS NULL AND s.worker_id <> $2)
              AND ($3::uuid IS NULL OR a.branch_id IS NULL OR a.branch_id = $3)
            ORDER BY a.plate_no NULLS LAST LIMIT 200`, [w.legal_entity_id, w.id, w.branch_id])).rows,
      };
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
  tasks(@Auth() a: AuthContext, @Query('include') include?: string) {
    // include=returns adds failed deliveries still to be returned to the sender
    const returns = include === 'returns';
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a, { active: false });
      return {
        data: (await c.query(
          `SELECT t.id, t.ref, t.status, t.sector_pack, lower(t.service_window) AS window_from, upper(t.service_window) AS window_to,
                  t.attributes, t.version, asg.asset_id,
                  (SELECT m.code FROM ops.task_milestone m WHERE m.task_id = t.id ORDER BY m.occurred_at DESC LIMIT 1) AS stage,
                  (EXISTS (SELECT 1 FROM ops.delivery_pod p WHERE p.task_id = t.id)
                   OR EXISTS (SELECT 1 FROM ops.load_ticket l WHERE l.task_id = t.id AND l.signed_at IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM ops.freight_shipment s WHERE s.task_id = t.id AND s.delivered_at IS NOT NULL)) AS has_proof,
                  (SELECT jsonb_build_object('ticket_no', l.ticket_no, 'volume_m3', l.volume_m3, 'batched_at', l.batched_at, 'signed', l.signed_at IS NOT NULL,
                          'planned_arrival', l.planned_arrival, 'site_ready', p.site_ready, 'mix_code', p.mix_code)
                     FROM ops.load_ticket l JOIN ops.pour_order p ON p.id = l.pour_order_id WHERE l.task_id = t.id) AS ticket,
                  (SELECT jsonb_build_object('waybill_no', s.waybill_no, 'mode', s.mode, 'cargo', s.cargo, 'pickup', s.pickup, 'dropoff', s.dropoff,
                          'trailer_plate', tr.plate_no, 'loaded_weight_kg', s.loaded_weight_kg, 'seal_no', s.seal_no, 'received_by', s.received_by)
                     FROM ops.freight_shipment s LEFT JOIN fleet.asset tr ON tr.id = s.trailer_asset_id WHERE s.task_id = t.id) AS freight,
                  (SELECT jsonb_build_object('trip_id', st.id, 'riders', COALESCE((
                      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'staff_no', x.staff_no, 'phone', x.phone, 'stop_seq', x.stop_seq, 'event', m.event) ORDER BY x.stop_seq, x.name)
                        FROM ops.shuttle_rider x LEFT JOIN LATERAL (SELECT b.event FROM ops.shuttle_board b WHERE b.trip_id = st.id AND b.rider_id = x.id ORDER BY b.occurred_at DESC LIMIT 1) m ON true
                       WHERE x.route_id = st.route_id AND (x.active OR m.event IS NOT NULL)), '[]'::jsonb))
                     FROM ops.shuttle_trip st WHERE st.task_id = t.id) AS shuttle
             FROM ops.task t JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active AND asg.worker_id = $1
            WHERE (t.status IN ('assigned','accepted','in_progress')
                   -- a placement books weeks of day-shifts ahead; the driver sees only those starting within 36 hours (and not long over)
                   AND (t.sector_pack IS DISTINCT FROM 'staffing@1' OR t.status = 'in_progress' OR (lower(t.service_window) < now() + interval '36 hours' AND upper(t.service_window) > now() - interval '6 hours')))
               OR ($2 AND t.status = 'failed' AND t.sector_pack = 'delivery@1'
                   AND NOT EXISTS (SELECT 1 FROM ops.task_milestone m WHERE m.task_id = t.id AND m.code = 'returned_to_sender'))
            ORDER BY lower(t.service_window) NULLS LAST, (t.attributes->>'seq')::int NULLS FIRST, t.id LIMIT 200`, [w.id, returns])).rows,
      };
    });
  }

  /**
   * Offline sync: the app queues actions with a client_op_id and sends them in order when online.
   * Each op is applied once; a re-sent op returns "duplicate". One bad op does not block the rest.
   * Op types: task_status (core), milestone (a stage inside the task, e.g. picked_up), pod (proof of delivery)
   * and ticket (the signed concrete delivery ticket).
   */
  @Post('sync')
  @HttpCode(200)
  @Perm('tasks:update_own')
  sync(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const ops = b?.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) throw new BadRequestException(`ops must be a list of 1-${MAX_OPS}`);
    const parsed: SyncOp[] = ops.map((o: Record<string, unknown>, i: number) => {
      if (!o || typeof o !== 'object') throw new BadRequestException(`ops[${i}] invalid`);
      const type = v.oneOf(o.type, `ops[${i}].type`, ['task_status', 'milestone', 'pod', 'ticket', 'stop', 'temp', 'board'] as const, { required: true })!;
      const base = {
        type,
        client_op_id: v.uuid(o.client_op_id, `ops[${i}].client_op_id`, { required: true })!,
        task_id: v.uuid(o.task_id, `ops[${i}].task_id`, { required: true })!,
        occurred_at: ts(o.occurred_at, `ops[${i}].occurred_at`, { required: true })!,
        note: v.str(o.note, `ops[${i}].note`, { max: 500 }),
      };
      if (type === 'task_status') {
        return { ...base, type: 'task_status' as const, to_status: v.str(o.to_status, `ops[${i}].to_status`, { required: true, max: 20 })!, reason_code: v.oneOf(o.reason_code, `ops[${i}].reason_code`, ALL_REASONS) };
      }
      if (type === 'milestone') {
        return { ...base, type: 'milestone' as const, code: v.oneOf(o.code, `ops[${i}].code`, ALL_STAGES, { required: true })!,
          lat: num(o.lat, `ops[${i}].lat`, -90, 90), lng: num(o.lng, `ops[${i}].lng`, -180, 180),
          // vehicle hand-over and return (internal@1) carry the odometer and the fuel level in eighths
          odometer_km: v.int(o.odometer_km, `ops[${i}].odometer_km`, 0, 10_000_000), fuel: v.int(o.fuel, `ops[${i}].fuel`, 0, 8),
          // loading and unloading (freight@1) carry the weight, the seal and the receiver's name
          weight_kg: freight.kg(o.weight_kg, `ops[${i}].weight_kg`, { zero: true }), seal_no: v.str(o.seal_no, `ops[${i}].seal_no`, { max: 40 }),
          received_by: v.str(o.received_by, `ops[${i}].received_by`, { max: 120 }), file_key: v.str(o.file_key, `ops[${i}].file_key`, { max: 300 }),
          // the hour meter and breakdown downtime of a hired machine (equipment@1)
          meter_hours: equipment.meter(o.meter_hours, `ops[${i}].meter_hours`), downtime_hours: equipment.meter(o.downtime_hours, `ops[${i}].downtime_hours`),
          // the end of a service visit (service@1): the result and the parts used (checked by the pack)
          result: v.oneOf(o.result, `ops[${i}].result`, service.RESULTS), parts: o.parts ?? null };
      }
      if (type === 'stop') return { ...base, type: 'stop' as const, proof: parseProof(o, `ops[${i}]`) };
      // a rider boarded or absent on a staff-transport trip (shuttle pack)
      if (type === 'board') return { ...base, type: 'board' as const, rider_id: v.uuid(o.rider_id, `ops[${i}].rider_id`, { required: true })!, event: v.oneOf(o.event, `ops[${i}].event`, shuttle.BOARD_EVENTS, { required: true })! };
      // a temperature reading on a cold-chain route (coldchain pack), typed by the driver from the truck's display
      if (type === 'temp') return { ...base, type: 'temp' as const, reading_c: dist.celsius(o.reading_c, `ops[${i}].reading_c`), stop_task_id: v.uuid(o.stop_task_id, `ops[${i}].stop_task_id`) };
      if (type === 'ticket') {
        const poured = concrete.m3(o.poured_m3, `ops[${i}].poured_m3`, { required: true, max: 20, zero: true })!;
        const returned = concrete.m3(o.returned_m3, `ops[${i}].returned_m3`, { max: 20, zero: true }) ?? 0;
        return { ...base, type: 'ticket' as const, poured_m3: poured, returned_m3: returned,
          signed_by: v.str(o.signed_by, `ops[${i}].signed_by`, { required: true, max: 120 })!, file_key: v.str(o.file_key, `ops[${i}].file_key`, { max: 300 }) };
      }
      const method = v.oneOf(o.method, `ops[${i}].method`, ['pin', 'photo', 'signature'] as const, { required: true })!;
      const pin = method === 'pin' ? v.str(o.pin, `ops[${i}].pin`, { required: true, max: 4 }) : null;
      if (pin !== null && !/^[0-9]{4}$/.test(pin)) throw new BadRequestException(`ops[${i}].pin must be 4 digits`);
      const file_key = v.str(o.file_key, `ops[${i}].file_key`, { max: 300 });
      const recipient_name = v.str(o.recipient_name, `ops[${i}].recipient_name`, { max: 120 });
      if (method !== 'pin' && !file_key && !recipient_name) throw new BadRequestException(`ops[${i}] needs file_key or recipient_name`);
      return { ...base, type: 'pod' as const, method, pin, file_key, recipient_name };
    });
    return this.db.withTenant(a, async (c) => {
      const w = await this.me(c, a);
      const results: { client_op_id: string; result: 'applied' | 'duplicate' | 'rejected'; reason?: string; status?: string; verified?: boolean }[] = [];
      for (const op of parsed) {
        if (await isDuplicate(c, op)) { results.push({ client_op_id: op.client_op_id, result: 'duplicate', ...(await dupStatus(c, op)) }); continue; }
        const reject = (reason: string, status?: string) => results.push({ client_op_id: op.client_op_id, result: 'rejected', reason, ...(status ? { status } : {}) });
        if (!inWindow(op.occurred_at)) { reject('bad_time'); continue; }
        const t = (await c.query(
          `SELECT t.status, t.sector_pack, t.legal_entity_id, t.attributes, lower(t.service_window) AS win_from FROM ops.task t
            WHERE t.id = $1 AND EXISTS (SELECT 1 FROM ops.assignment x WHERE x.task_id = t.id AND x.active AND x.worker_id = $2)
            FOR UPDATE OF t`, [op.task_id, w.id])).rows[0];
        if (!t) { reject('not_assigned_to_you'); continue; }
        const delivery = isDelivery(t.sector_pack);

        if (op.type === 'milestone') {
          const rule = stageRule(t.sector_pack, op.code);
          if (!rule) { reject('not_supported'); continue; }
          if (dist.isDistribution(t.sector_pack) && t.attributes?.kind !== 'route') { reject('not_supported', t.status); continue; }
          if (moving.isMoving(t.sector_pack) && t.attributes?.kind !== 'move') { reject('not_supported', t.status); continue; }
          if (!rule.allowed.includes(t.status)) { reject('invalid_stage', t.status); continue; }
          if (rule.needs && !(await c.query('SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = $2', [op.task_id, rule.needs])).rowCount) {
            reject('stage_out_of_order', t.status); continue;
          }
          if ((concrete.isConcrete(t.sector_pack) || staffing.isStaffing(t.sector_pack) || internal.isInternal(t.sector_pack) || dist.isDistribution(t.sector_pack) || freight.isFreight(t.sector_pack) || equipment.isEquipment(t.sector_pack) || rental.isRental(t.sector_pack) || service.isService(t.sector_pack) || moving.isMoving(t.sector_pack))
            && (await c.query('SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = $2', [op.task_id, op.code])).rowCount) {
            reject('stage_already_recorded', t.status); continue;
          }
          if (staffing.isStaffing(t.sector_pack) && op.code === 'check_in' && t.win_from
            && op.occurred_at.getTime() < t.win_from.getTime() - staffing.EARLY_CHECKIN_MINUTES * 60_000) {
            reject('too_early', t.status); continue;
          }
          if (staffing.isStaffing(t.sector_pack) && op.code === 'check_in') {
            // how far from the customer's site the driver checked in; the board flags it beyond the radius (not a block: GPS can drift)
            const site = t.attributes?.dropoff;
            const dist = op.lat != null && op.lng != null && typeof site?.lat === 'number' && typeof site?.lng === 'number'
              ? Math.round(haversineKm({ lat: op.lat, lng: op.lng }, site) * 1000) : null;
            await c.query('UPDATE ops.staffing_shift SET checkin_distance_m = $2 WHERE task_id = $1', [op.task_id, dist]);
          }
          if (internal.isInternal(t.sector_pack)) {
            // the driver's hand-over and return update the vehicle request the same way the fleet office does
            if (op.odometer_km === null) { reject('odometer_required', t.status); continue; }
            const req = (await c.query('SELECT id FROM ops.vehicle_request WHERE task_id = $1', [op.task_id])).rows[0];
            if (!req) { reject('not_supported', t.status); continue; }
            await c.query('SAVEPOINT op');
            try {
              await (op.code === 'vehicle_out' ? vehicleOut : vehicleBack)(c, a, req.id, op.occurred_at, op.odometer_km, op.fuel, op.note, 'driver');
            } catch (e) {
              await c.query('ROLLBACK TO SAVEPOINT op');
              const msg = (e as Error).message ?? '';
              if (/odometer/.test(msg)) { reject('odometer_too_low', t.status); continue; }
              if (/booked/.test(msg)) { reject('vehicle_booked', t.status); continue; }
              if (e instanceof ConflictException) { reject('invalid_stage', t.status); continue; }
              throw e;
            }
          }
          if (dist.isDistribution(t.sector_pack)) {
            const bad = await routeStage(c, op.task_id, op.code as dist.Stage, op.occurred_at, op.odometer_km);
            if (bad) { reject(bad, t.status); continue; }
          }
          if (equipment.isEquipment(t.sector_pack)) {
            if (op.downtime_hours !== null && op.downtime_hours > 24) { reject('meter_invalid', t.status); continue; }
            const bad = await equipStage(c, op.task_id, op.code as equipment.Stage, { meter: op.meter_hours, downtime: op.downtime_hours, signedBy: op.received_by });
            if (bad) { reject(bad, t.status); continue; }
          }
          if (service.isService(t.sector_pack)) {
            const bad = await serviceStage(c, a, op.task_id, op.code as service.Stage, { at: op.occurred_at, result: op.result, workDone: op.note, signedBy: op.received_by, parts: op.parts });
            if (bad) { reject(bad, t.status); continue; }
          }
          if (moving.isMoving(t.sector_pack)) {
            const bad = await movingStage(c, op.task_id, op.code as moving.Stage, { at: op.occurred_at, receivedBy: op.received_by, note: op.note });
            if (bad) { reject(bad, t.status); continue; }
          }
          if (rental.isRental(t.sector_pack)) {
            // the driver's hand-over or collection is the same check-out or check-in as the counter
            const bad = await rentalStage(c, a, op.task_id, op.code as rental.Stage, { km: op.odometer_km, fuel: op.fuel, at: op.occurred_at, receivedBy: op.received_by, note: op.note });
            if (bad) { reject(bad, t.status); continue; }
          }
          if (freight.isFreight(t.sector_pack)) {
            if (op.code === 'unloaded' && !op.received_by) { reject('receiver_required', t.status); continue; }
            if (op.code === 'loaded') {
              await c.query('UPDATE ops.freight_shipment SET loaded_weight_kg = COALESCE($2, loaded_weight_kg), seal_no = COALESCE($3, seal_no) WHERE task_id = $1',
                [op.task_id, op.weight_kg, op.seal_no]);
            }
            if (op.code === 'unloaded') {
              await c.query('UPDATE ops.freight_shipment SET delivered_weight_kg = $2, received_by = $3, pod_file_key = $4, delivered_at = $5 WHERE task_id = $1',
                [op.task_id, op.weight_kg, op.received_by, op.file_key, op.occurred_at]);
            }
          }
          if (concrete.isConcrete(t.sector_pack) && op.code === 'loaded') {
            // batching starts the concrete age clock on the ticket
            await c.query('UPDATE ops.load_ticket SET batched_at = $2 WHERE task_id = $1 AND batched_at IS NULL', [op.task_id, op.occurred_at]);
          }
          if (await this.insertOnce(c, `INSERT INTO ops.task_milestone (id, tenant_id, task_id, code, occurred_at, actor_id, client_op_id, lat, lng, note)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [randomUUID(), a.tenantId, op.task_id, op.code, op.occurred_at, a.userId, op.client_op_id, op.lat, op.lng, op.note])) {
            results.push({ client_op_id: op.client_op_id, result: 'applied', status: t.status });
          } else results.push({ client_op_id: op.client_op_id, result: 'duplicate' });
          continue;
        }

        if (op.type === 'temp') {
          if (!dist.isDistribution(t.sector_pack) || t.attributes?.kind !== 'route') { reject('not_supported'); continue; }
          if (!['accepted', 'in_progress'].includes(t.status)) { reject('invalid_stage', t.status); continue; }
          const route = (await c.query('SELECT id FROM ops.dist_route WHERE task_id = $1', [op.task_id])).rows[0];
          await c.query('SAVEPOINT op');
          try {
            const bad = await addReading(c, a, { route: route.id, reading: op.reading_c, source: 'manual', device: null, at: op.occurred_at, stop: op.stop_task_id, note: op.note, clientOpId: op.client_op_id });
            if (bad) { await c.query('ROLLBACK TO SAVEPOINT op'); reject(bad === 'unknown stop_task_id' ? 'unknown_stop' : bad, t.status); continue; }
            results.push({ client_op_id: op.client_op_id, result: 'applied', status: t.status });
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT op');
            if ((e as { code?: string }).code === '23505') { results.push({ client_op_id: op.client_op_id, result: 'duplicate' }); continue; }
            throw e;
          }
          continue;
        }

        if (op.type === 'board') {
          if (!shuttle.isShuttle(t.sector_pack)) { reject('not_supported'); continue; }
          const bad = await markRider(c, a, { taskId: op.task_id, riderId: op.rider_id, event: op.event, at: op.occurred_at, source: 'driver', clientOpId: op.client_op_id });
          if (bad) { reject(bad, t.status); continue; }
          results.push({ client_op_id: op.client_op_id, result: 'applied', status: t.status });
          continue;
        }

        if (op.type === 'stop') {
          if (!dist.isDistribution(t.sector_pack) || t.attributes?.kind !== 'stop') { reject('not_supported'); continue; }
          await c.query('SAVEPOINT op');
          try {
            const res = await stopProof(c, a, op.task_id, { ...op.proof, note: op.proof.note ?? op.note }, op.occurred_at, 'driver', op.client_op_id);
            if ('reject' in res) { await c.query('ROLLBACK TO SAVEPOINT op'); reject(res.reject, res.status); continue; }
            results.push({ client_op_id: op.client_op_id, result: 'applied', status: res.status });
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT op');
            if ((e as { code?: string }).code === '23505') { results.push({ client_op_id: op.client_op_id, result: 'duplicate' }); continue; }
            throw e;
          }
          continue;
        }

        if (op.type === 'ticket') {
          if (!concrete.isConcrete(t.sector_pack)) { reject('not_supported'); continue; }
          if (t.status !== 'in_progress') { reject('invalid_transition', t.status); continue; }
          const lt = (await c.query('SELECT volume_m3::float, signed_at, pour_order_id FROM ops.load_ticket WHERE task_id = $1 FOR UPDATE', [op.task_id])).rows[0];
          if (!lt) { reject('not_supported', t.status); continue; }
          if (lt.signed_at) { reject('already_signed', t.status); continue; }
          if (op.poured_m3 + op.returned_m3 > lt.volume_m3 + 0.05) { reject('quantity_exceeds_load', t.status); continue; }
          const ms = (await c.query(
            `SELECT min(occurred_at) FILTER (WHERE code = 'at_site') AS at_site, min(occurred_at) FILTER (WHERE code = 'pour_start') AS pour_start,
                    bool_or(code = 'pour_end') AS ended FROM ops.task_milestone WHERE task_id = $1`, [op.task_id])).rows[0];
          if (!ms.ended) { reject('stage_out_of_order', t.status); continue; }
          const s = await concrete.settingsOf(c, t.legal_entity_id);
          const wait = concrete.waiting(ms.at_site, ms.pour_start, s.free_wait_minutes);
          await c.query('SAVEPOINT op');
          try {
            await c.query(
              `UPDATE ops.load_ticket SET poured_m3 = $2, returned_m3 = $3, signed_by = $4, file_key = $5, signed_at = $6, wait_minutes = $7, sign_client_op_id = $8 WHERE task_id = $1`,
              [op.task_id, op.poured_m3, op.returned_m3, op.signed_by, op.file_key, op.occurred_at, wait.wait_minutes, op.client_op_id]);
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT op');
            if ((e as { code?: string }).code === '23505') { results.push({ client_op_id: op.client_op_id, result: 'duplicate' }); continue; }
            throw e;
          }
          // what the invoice prices: poured m³ and the waiting hours charged after the free time
          const quantities = { m3: op.poured_m3, ...(wait.billable_hours > 0 ? { hour: wait.billable_hours } : {}) };
          await c.query(`UPDATE ops.task SET attributes = attributes || jsonb_build_object('quantities', $2::jsonb), version = version + 1 WHERE id = $1`, [op.task_id, JSON.stringify(quantities)]);
          results.push({ client_op_id: op.client_op_id, result: 'applied', status: t.status });
          continue;
        }

        if (op.type === 'pod') {
          if (!delivery) { reject('not_supported'); continue; }
          if (!['accepted', 'in_progress'].includes(t.status)) { reject('invalid_transition', t.status); continue; }
          const prior = (await c.query('SELECT verified FROM ops.delivery_pod WHERE task_id = $1', [op.task_id])).rows[0];
          if (prior?.verified) { reject('already_proven', t.status); continue; }
          let verified = false;
          if (op.method === 'pin') {
            const link = (await c.query('SELECT pin, pin_attempts FROM ops.delivery_link WHERE task_id = $1 FOR UPDATE', [op.task_id])).rows[0];
            if (!link) { reject('no_pin', t.status); continue; }
            if (link.pin_attempts >= PIN_MAX_ATTEMPTS) { reject('pin_locked', t.status); continue; }
            if (!safeEqual(link.pin, op.pin!)) {
              // kept even though the op is rejected: the counter is what stops guessing
              await c.query('UPDATE ops.delivery_link SET pin_attempts = pin_attempts + 1 WHERE task_id = $1', [op.task_id]);
              reject(link.pin_attempts + 1 >= PIN_MAX_ATTEMPTS ? 'pin_locked' : 'wrong_pin', t.status); continue;
            }
            verified = true;
          }
          if (prior) await c.query('DELETE FROM ops.delivery_pod WHERE task_id = $1 AND NOT verified', [op.task_id]);
          if (await this.insertOnce(c, `INSERT INTO ops.delivery_pod (tenant_id, task_id, method, recipient_name, file_key, verified, client_op_id, created_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [a.tenantId, op.task_id, op.method, op.recipient_name, op.file_key, verified, op.client_op_id, op.occurred_at])) {
            results.push({ client_op_id: op.client_op_id, result: 'applied', status: t.status, verified });
          } else results.push({ client_op_id: op.client_op_id, result: 'duplicate' });
          continue;
        }

        if (!(DRIVER_FLOW[t.status] ?? []).includes(op.to_status)) { reject('invalid_transition', t.status); continue; }
        const reasons = reasonsOf(t.sector_pack);
        if (op.reason_code && op.to_status === 'failed' && reasons && !reasons.includes(op.reason_code)) { reject('invalid_reason', t.status); continue; }
        const reasonCode = reasons ? op.reason_code : null;
        if (op.to_status === 'failed' && !op.note && !reasonCode) { reject('reason_required', t.status); continue; }
        if (op.to_status === 'completed' && concrete.isConcrete(t.sector_pack)
          && (await c.query('SELECT 1 FROM ops.load_ticket WHERE task_id = $1 AND signed_at IS NULL', [op.task_id])).rowCount) {
          reject('proof_required', t.status); continue;
        }
        if (op.to_status === 'in_progress' && staffing.isStaffing(t.sector_pack)
          && !(await c.query(`SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = 'check_in'`, [op.task_id])).rowCount) {
          reject('stage_out_of_order', t.status); continue; // the shift starts with the check-in
        }
        if (dist.isDistribution(t.sector_pack)) {
          // stops are recorded with the stop op; the route starts after the load check and ends back at the depot
          if (t.attributes?.kind !== 'route') { reject('not_supported', t.status); continue; }
          if ((op.to_status === 'in_progress' || op.to_status === 'completed')
            && !(await c.query('SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = $2', [op.task_id, op.to_status === 'in_progress' ? 'load_checked' : 'route_back'])).rowCount) {
            reject('stage_out_of_order', t.status); continue;
          }
        }
        if (internal.isInternal(t.sector_pack) && (op.to_status === 'in_progress' || op.to_status === 'completed')
          && !(await c.query('SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = $2',
                [op.task_id, op.to_status === 'in_progress' ? 'vehicle_out' : 'vehicle_back'])).rowCount) {
          reject(op.to_status === 'in_progress' ? 'stage_out_of_order' : 'proof_required', t.status); continue; // the trip starts and ends with the odometer
        }
        if (service.isService(t.sector_pack) && op.to_status === 'completed'
          && !(await c.query(`SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = 'work_done'`, [op.task_id])).rowCount) {
          reject('proof_required', t.status); continue; // the visit ends with its result
        }
        if (moving.isMoving(t.sector_pack) && t.attributes?.kind === 'move' && op.to_status === 'completed'
          && !(await c.query(`SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = 'unloaded'`, [op.task_id])).rowCount) {
          reject('proof_required', t.status); continue; // the move ends unloaded with the receiver's name
        }
        if (rental.isRental(t.sector_pack) && op.to_status === 'completed') {
          // a delivery ends with the hand-over, a collection with the vehicle taken back
          const kind = t.attributes?.kind as 'deliver' | 'collect';
          if (!rental.STAGE_OF[kind]) { reject('not_supported', t.status); continue; }
          if (!(await c.query('SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = $2', [op.task_id, rental.STAGE_OF[kind]])).rowCount) { reject('proof_required', t.status); continue; }
        }
        if (freight.isFreight(t.sector_pack) && (op.to_status === 'in_progress' || op.to_status === 'completed')
          && !(await c.query('SELECT 1 FROM ops.task_milestone WHERE task_id = $1 AND code = $2', [op.task_id, op.to_status === 'in_progress' ? 'loaded' : 'unloaded'])).rowCount) {
          reject(op.to_status === 'in_progress' ? 'stage_out_of_order' : 'proof_required', t.status); continue; // the trip starts loaded and ends unloaded
        }
        let staffQty: Record<string, number> | null = null;
        if (op.to_status === 'completed' && freight.isFreight(t.sector_pack)) {
          const ms = (await c.query(
            `SELECT min(occurred_at) FILTER (WHERE code = 'at_pickup') AS at_pickup, min(occurred_at) FILTER (WHERE code = 'loaded') AS loaded,
                    min(occurred_at) FILTER (WHERE code = 'at_dropoff') AS at_dropoff, min(occurred_at) FILTER (WHERE code = 'unloaded') AS unloaded
               FROM ops.task_milestone WHERE task_id = $1`, [op.task_id])).rows[0];
          const sh = (await c.query('SELECT bill_unit, planned_km, cargo, loaded_weight_kg::float, delivered_weight_kg::float FROM ops.freight_shipment WHERE task_id = $1', [op.task_id])).rows[0];
          if (!sh) { reject('not_supported', t.status); continue; }
          // what the invoice prices: trip, km or tons, plus detention hours after the free time at each end
          const det = freight.tripDetention(ms, (await freight.settingsOf(c, t.legal_entity_id)).free_detention_minutes);
          await c.query('UPDATE ops.freight_shipment SET detention_minutes = $2 WHERE task_id = $1', [op.task_id, det.minutes]);
          staffQty = freight.quantities({ bill_unit: sh.bill_unit, planned_km: sh.planned_km, cargo_weight_kg: sh.cargo?.weight_kg ?? null,
            loaded_weight_kg: sh.loaded_weight_kg, delivered_weight_kg: sh.delivered_weight_kg }, det.hours);
        }
        if (op.to_status === 'completed' && staffing.isStaffing(t.sector_pack)) {
          const ms = (await c.query(
            `SELECT min(occurred_at) FILTER (WHERE code = 'check_in') AS cin, min(occurred_at) FILTER (WHERE code = 'check_out') AS cout
               FROM ops.task_milestone WHERE task_id = $1`, [op.task_id])).rows[0];
          if (!ms.cin || !ms.cout) { reject('proof_required', t.status); continue; }
          // what the invoice prices: worked hours rounded to the step, or one day
          const step = (await staffing.settingsOf(c, t.legal_entity_id)).hour_rounding_minutes;
          staffQty = t.attributes?.bill_unit === 'day' ? { day: 1 } : { hour: staffing.roundHours((ms.cout.getTime() - ms.cin.getTime()) / 60_000, step) };
        }
        if (op.to_status === 'completed' && delivery && (await needsProof(c, t))
          && !(await c.query('SELECT 1 FROM ops.delivery_pod WHERE task_id = $1', [op.task_id])).rowCount) {
          reject('proof_required', t.status); continue;
        }
        if (await this.insertOnce(c,
          `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, client_op_id, note, reason_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [randomUUID(), a.tenantId, op.task_id, t.status, op.to_status, op.occurred_at, a.userId, op.client_op_id, op.note, op.to_status === 'failed' ? reasonCode : null])) {
          await c.query('UPDATE ops.task SET status = $2, version = version + 1 WHERE id = $1', [op.task_id, op.to_status]);
          if (staffQty) {
            await c.query(`UPDATE ops.task SET attributes = attributes || jsonb_build_object('quantities', $2::jsonb) WHERE id = $1`, [op.task_id, JSON.stringify(staffQty)]);
          }
          if (dist.isDistribution(t.sector_pack) && op.to_status === 'in_progress') await routeOut(c, a, op.task_id, op.occurred_at);
          if (concrete.isConcrete(t.sector_pack) && (op.to_status === 'completed' || op.to_status === 'failed')) {
            // the mixer is free once it is back at the plant: shorten its booking so it can take the next load
            const back = (await concrete.settingsOf(c, t.legal_entity_id)).lead_minutes;
            await c.query(
              `UPDATE ops.assignment SET period = tstzrange(LEAST(lower(period), $2::timestamptz), $2::timestamptz + make_interval(mins => $3))
                WHERE task_id = $1 AND active AND upper(period) > $2::timestamptz + make_interval(mins => $3)`, [op.task_id, op.occurred_at, back]);
          }
          results.push({ client_op_id: op.client_op_id, result: 'applied', status: op.to_status });
        } else results.push({ client_op_id: op.client_op_id, result: 'duplicate' });
      }
      return { results };
    });
  }

  /** Inserts once; false when the same op arrived twice at once from two connections (unique client_op_id). */
  private async insertOnce(c: PoolClient, sql: string, params: unknown[]) {
    await c.query('SAVEPOINT op');
    try {
      await c.query(sql, params);
      return true;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT op');
      if ((e as { code?: string }).code === '23505') return false;
      throw e;
    }
  }
}

type SyncOp =
  | { type: 'task_status'; client_op_id: string; task_id: string; occurred_at: Date; note: string | null; to_status: string; reason_code: string | null }
  | { type: 'milestone'; client_op_id: string; task_id: string; occurred_at: Date; note: string | null; code: string; lat: number | null; lng: number | null; odometer_km: number | null; fuel: number | null;
      weight_kg: number | null; seal_no: string | null; received_by: string | null; file_key: string | null; meter_hours: number | null; downtime_hours: number | null; result: string | null; parts: unknown }
  | { type: 'stop'; client_op_id: string; task_id: string; occurred_at: Date; note: string | null; proof: ProofIn }
  | { type: 'board'; client_op_id: string; task_id: string; occurred_at: Date; note: string | null; rider_id: string; event: 'boarded' | 'no_show' }
  | { type: 'temp'; client_op_id: string; task_id: string; occurred_at: Date; note: string | null; reading_c: number; stop_task_id: string | null }
  | { type: 'ticket'; client_op_id: string; task_id: string; occurred_at: Date; note: string | null; poured_m3: number; returned_m3: number; signed_by: string; file_key: string | null }
  | { type: 'pod'; client_op_id: string; task_id: string; occurred_at: Date; note: string | null; method: 'pin' | 'photo' | 'signature'; pin: string | null; file_key: string | null; recipient_name: string | null };

const DUP_TABLE = { task_status: 'ops.task_event', milestone: 'ops.task_milestone', pod: 'ops.delivery_pod', ticket: 'ops.load_ticket', stop: 'ops.dist_stop', temp: 'ops.temp_reading', board: 'ops.shuttle_board' } as const;
async function isDuplicate(c: PoolClient, op: SyncOp) {
  const col = op.type === 'ticket' ? 'sign_client_op_id' : 'client_op_id';
  return !!(await c.query(`SELECT 1 FROM ${DUP_TABLE[op.type]} WHERE ${col} = $1`, [op.client_op_id])).rowCount;
}
async function dupStatus(c: PoolClient, op: SyncOp) {
  if (op.type !== 'task_status') return {};
  const r = (await c.query('SELECT to_status FROM ops.task_event WHERE client_op_id = $1', [op.client_op_id])).rows[0];
  return r ? { status: r.to_status as string } : {};
}

function safeEqual(x: string, y: string) {
  const a = Buffer.from(x), b = Buffer.from(y);
  return a.length === b.length && timingSafeEqual(a, b);
}
