import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';

const MAX_TRACK_POINTS = 10_000;

/** Live map and route history. Positions are shown only for drivers on an open shift (D6). */
@Controller('v1')
@UseGuards(AuthGuard)
export class TrackingController {
  constructor(private readonly db: DbService) {}

  /**
   * Drivers on shift with their last position and current task. The web map polls this;
   * pass since=<server_time from the previous reply> to get only drivers that moved.
   */
  @Get('map/live')
  @Perm('fleet:read')
  live(@Auth() a: AuthContext, @Query('since') since?: string, @Query('stale_after') staleAfter?: string) {
    const s = since ? new Date(since) : null;
    if (s && Number.isNaN(s.getTime())) throw new BadRequestException('since must be a timestamp');
    const stale = staleAfter === undefined ? 300 : Number(staleAfter);
    if (!Number.isInteger(stale) || stale < 30 || stale > 86_400) throw new BadRequestException('stale_after must be 30-86400 seconds');
    return this.db.withTenant(a, async (c) => {
      const server_time = (await c.query('SELECT now() AS t')).rows[0].t;
      const drivers = (await c.query(
        `SELECT w.id AS worker_id, w.display_name, w.branch_id, s.id AS shift_id, s.started_at, ast.plate_no,
                lp.recorded_at, ST_Y(lp.position::geometry) AS lat, ST_X(lp.position::geometry) AS lng, lp.accuracy_m, lp.battery_pct,
                (lp.recorded_at IS NULL OR lp.recorded_at < now() - make_interval(secs => $2)) AS stale,
                cur.id AS task_id, cur.status AS task_status, cur.attributes AS task_attributes
           FROM shift.shift s
           JOIN workforce.worker w ON w.id = s.worker_id
           LEFT JOIN fleet.asset ast ON ast.id = s.asset_id
           LEFT JOIN geo.last_position lp ON lp.worker_id = w.id AND lp.recorded_at >= s.started_at
           LEFT JOIN LATERAL (
             SELECT t.id, t.status, t.attributes FROM ops.assignment x JOIN ops.task t ON t.id = x.task_id
              WHERE x.worker_id = w.id AND x.active AND t.status IN ('in_progress','accepted')
              ORDER BY (t.status = 'in_progress') DESC, lower(t.service_window) NULLS LAST LIMIT 1) cur ON true
          WHERE s.started_at IS NOT NULL AND s.ended_at IS NULL
            AND ($1::timestamptz IS NULL OR lp.recorded_at > $1 OR s.started_at > $1)
            AND (cardinality($3::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($3::uuid[]))
          ORDER BY w.display_name LIMIT 2000`, [s, stale, a.branchIds])).rows;
      return { server_time, drivers };
    });
  }

  /** The route of one shift for replay on the map, with distance and duration. */
  @Get('shifts/:id/track')
  @Perm('fleet:read')
  track(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const s = (await c.query(
        `SELECT s.id, s.worker_id, w.display_name, s.started_at, s.ended_at FROM shift.shift s JOIN workforce.worker w ON w.id = s.worker_id
          WHERE s.id = $1 AND (cardinality($2::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($2::uuid[]))`, [id, a.branchIds])).rows[0];
      if (!s) throw new NotFoundException();
      const points = (await c.query(
        `SELECT recorded_at, ST_Y(position::geometry) AS lat, ST_X(position::geometry) AS lng, speed_mps, accuracy_m
           FROM geo.location_point WHERE worker_id = $1 AND shift_id = $2 ORDER BY recorded_at LIMIT $3`,
        [s.worker_id, id, MAX_TRACK_POINTS])).rows;
      const stats = (await c.query(
        `SELECT COALESCE(round((ST_Length(ST_MakeLine(position::geometry ORDER BY recorded_at)::geography) / 1000)::numeric, 3), 0)::float AS km,
                round((max(speed_mps) * 3.6)::numeric, 1)::float AS max_kmh
           FROM geo.location_point WHERE worker_id = $1 AND shift_id = $2 AND (accuracy_m IS NULL OR accuracy_m <= 100)`, [s.worker_id, id])).rows[0];
      const end = s.ended_at ?? new Date();
      return {
        shift: s, distance_km: stats.km, max_kmh: stats.max_kmh,
        duration_min: Math.round((end.getTime() - new Date(s.started_at).getTime()) / 60_000),
        truncated: points.length === MAX_TRACK_POINTS, points,
      };
    });
  }
}
