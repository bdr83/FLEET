import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { v } from '../common/validate';

const SHIFT_COLS = `s.id, s.worker_id, w.display_name AS worker_name, s.asset_id, a.plate_no, s.started_at, s.ended_at,
  s.start_odometer_km, s.end_odometer_km, s.end_reason`;

/** Supervisor side: the day's dispatch board and the shifts list. */
@Controller('v1')
@UseGuards(AuthGuard)
export class DispatchController {
  constructor(private readonly db: DbService) {}

  /**
   * One call for the dispatch screen: task counts for the day, the unassigned queue,
   * and every active driver with shift state, workload and last known position.
   */
  @Get('dispatch/board')
  @Perm('tasks:read')
  board(@Auth() a: AuthContext, @Query('date') date?: string, @Query('tz') tz?: string) {
    const day = v.date(date, 'date') ?? null;
    const zone = tz ?? 'Asia/Kuwait';
    if (!/^[A-Za-z_]+(\/[A-Za-z_]+){0,2}$/.test(zone)) throw new BadRequestException('invalid tz');
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [zone])).rowCount) throw new BadRequestException('unknown tz');
      const range = (await c.query(
        `SELECT (d::timestamp AT TIME ZONE $2) AS from, ((d + 1)::timestamp AT TIME ZONE $2) AS to
           FROM (SELECT COALESCE($1::date, (now() AT TIME ZONE $2)::date) AS d) x`, [day, zone])).rows[0];
      const scope = `(cardinality($3::uuid[]) = 0 OR t.branch_id IS NULL OR t.branch_id = ANY($3::uuid[]))`;
      const inDay = `(t.service_window && tstzrange($1, $2) OR (t.service_window IS NULL AND t.status IN ('ready','assigned','accepted','in_progress')))`;
      const counts = (await c.query(
        `SELECT t.status, count(*)::int AS n FROM ops.task t WHERE ${inDay} AND ${scope} GROUP BY t.status`, [range.from, range.to, a.branchIds])).rows;
      const queue = (await c.query(
        `SELECT t.id, t.ref, t.sector_pack, lower(t.service_window) AS window_from, upper(t.service_window) AS window_to, t.attributes, t.version
           FROM ops.task t WHERE t.status = 'ready' AND ${inDay} AND ${scope}
          ORDER BY lower(t.service_window) NULLS LAST, t.created_at LIMIT 200`, [range.from, range.to, a.branchIds])).rows;
      const drivers = (await c.query(
        `SELECT w.id, w.display_name, w.kind, w.branch_id,
                s.id AS shift_id, s.started_at, s.asset_id, ast.plate_no,
                (SELECT count(*)::int FROM ops.assignment x JOIN ops.task t ON t.id = x.task_id
                  WHERE x.worker_id = w.id AND x.active AND t.status IN ('assigned','accepted','in_progress')) AS open_tasks,
                lp.recorded_at AS last_seen_at,
                CASE WHEN s.id IS NULL THEN NULL ELSE ST_Y(lp.position::geometry) END AS lat,
                CASE WHEN s.id IS NULL THEN NULL ELSE ST_X(lp.position::geometry) END AS lng,
                lp.battery_pct
           FROM workforce.worker w
           LEFT JOIN shift.shift s ON s.worker_id = w.id AND s.started_at IS NOT NULL AND s.ended_at IS NULL
           LEFT JOIN fleet.asset ast ON ast.id = s.asset_id
           LEFT JOIN geo.last_position lp ON lp.worker_id = w.id
          WHERE w.status = 'active' AND (cardinality($1::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($1::uuid[]))
          ORDER BY (s.id IS NULL), w.display_name LIMIT 500`, [a.branchIds])).rows;
      return { date: day, tz: zone, from: range.from, to: range.to, counts: Object.fromEntries(counts.map((r) => [r.status, r.n])), queue, drivers };
    });
  }

  @Get('shifts')
  @Perm('fleet:read')
  shifts(@Auth() a: AuthContext, @Query('open') open?: string, @Query('worker_id') worker?: string) {
    const wk = v.uuid(worker, 'worker_id');
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${SHIFT_COLS} FROM shift.shift s JOIN workforce.worker w ON w.id = s.worker_id LEFT JOIN fleet.asset a ON a.id = s.asset_id
          WHERE s.started_at IS NOT NULL AND ($1::boolean IS NULL OR (s.ended_at IS NULL) = $1) AND ($2::uuid IS NULL OR s.worker_id = $2)
            AND (cardinality($3::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($3::uuid[]))
          ORDER BY s.started_at DESC LIMIT 200`,
        [open === undefined ? null : open === 'true', wk, a.branchIds])).rows,
    }));
  }

  /** A supervisor closes a shift the driver forgot to end. Tracking stops at that moment. */
  @Post('shifts/:id/end')
  @HttpCode(200)
  @Perm('fleet:write')
  endShift(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 });
    return this.db.withTenant(a, async (c) => {
      const s = (await c.query('SELECT id, asset_id, ended_at FROM shift.shift WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!s) throw new NotFoundException();
      if (!s.ended_at) {
        await c.query(
          `UPDATE shift.shift SET ended_at = now(), period = tstzrange(started_at, now(), '[]'), ended_by = $2, end_reason = $3 WHERE id = $1`,
          [id, a.userId, reason]);
        if (s.asset_id) await c.query(`UPDATE fleet.asset SET status = 'available' WHERE id = $1 AND status = 'in_use'`, [s.asset_id]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'shift.ended_by_staff', targetType: 'shift', targetId: id, after: { reason } });
      }
      return (await c.query(
        `SELECT ${SHIFT_COLS} FROM shift.shift s JOIN workforce.worker w ON w.id = s.worker_id LEFT JOIN fleet.asset a ON a.id = s.asset_id WHERE s.id = $1`, [id])).rows[0];
    });
  }
}
