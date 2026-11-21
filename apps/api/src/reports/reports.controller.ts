import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { CsvResponse, parseRange, respond } from './report-utils';

/** Points with worse accuracy than this are left out of distance, so GPS jitter does not inflate kilometres. [تخمين] */
const MAX_ACCURACY_M = 100;
const DONE = `('completed','reviewed','invoiced')`;
const OPEN = `('draft','ready','assigned','accepted','in_progress')`;

/**
 * Operational reports. Each accepts from, to (timestamps), tz (default Asia/Kuwait)
 * and format=json|csv. Branch-scoped members only see their branches.
 */
@Controller('v1/reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private readonly db: DbService) {}

  /** Tasks by day, driver or branch: totals, outcomes, on-time rate and average handling time. */
  @Get('tasks')
  @Perm('reports:read')
  tasks(@Auth() a: AuthContext, @Query() q: Record<string, string | undefined>, @Res({ passthrough: true }) res: CsvResponse) {
    const group = q.group ?? 'day';
    const keys: Record<string, [string, string]> = {
      day: [`to_char(planned_at AT TIME ZONE $3, 'YYYY-MM-DD')`, `to_char(planned_at AT TIME ZONE $3, 'YYYY-MM-DD')`],
      worker: ['worker_id::text', 'worker_name'],
      branch: ['branch_id::text', 'branch_name'],
    };
    if (!keys[group]) throw new BadRequestException('group must be day, worker or branch');
    return this.db.withTenant(a, async (c) => {
      const r = await parseRange(c, q);
      const rows = (await c.query(
        `WITH t AS (
           SELECT t.status, t.branch_id, b.name AS branch_name, asg.worker_id, w.display_name AS worker_name,
                  COALESCE(lower(t.service_window), t.created_at) AS planned_at, upper(t.service_window) AS due_at,
                  (SELECT max(occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') AS done_at,
                  (SELECT max(occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'in_progress') AS started_at
             FROM ops.task t
             LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
             LEFT JOIN workforce.worker w ON w.id = asg.worker_id
             LEFT JOIN org.branch b ON b.id = t.branch_id
            WHERE COALESCE(lower(t.service_window), t.created_at) >= $1 AND COALESCE(lower(t.service_window), t.created_at) < $2
              AND (cardinality($4::uuid[]) = 0 OR t.branch_id IS NULL OR t.branch_id = ANY($4::uuid[]))
              AND $3::text IS NOT NULL -- tz is used only by group=day; typed here for the other groups
         )
         SELECT ${keys[group][0]} AS key, ${keys[group][1]} AS label,
                count(*)::int AS total,
                count(*) FILTER (WHERE status IN ${DONE})::int AS completed,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'canceled')::int AS canceled,
                count(*) FILTER (WHERE status IN ${OPEN})::int AS open,
                round(100.0 * count(*) FILTER (WHERE done_at <= due_at) / NULLIF(count(*) FILTER (WHERE done_at IS NOT NULL AND due_at IS NOT NULL), 0), 1)::float AS on_time_pct,
                round((avg(extract(epoch FROM done_at - started_at)) FILTER (WHERE done_at >= started_at) / 60)::numeric, 1)::float AS avg_minutes
           FROM t GROUP BY 1, 2 ORDER BY 1 NULLS LAST`,
        [r.from, r.to, r.tz, a.branchIds])).rows;
      return respond(res, q.format, `tasks-by-${group}`, rows,
        ['key', 'label', 'total', 'completed', 'failed', 'canceled', 'open', 'on_time_pct', 'avg_minutes'], { group, from: r.from, to: r.to, tz: r.tz });
    });
  }

  /** Per driver: tasks done and failed, on-time rate, hours on shift and kilometres driven (from GPS). */
  @Get('drivers')
  @Perm('reports:read')
  drivers(@Auth() a: AuthContext, @Query() q: Record<string, string | undefined>, @Res({ passthrough: true }) res: CsvResponse) {
    return this.db.withTenant(a, async (c) => {
      const r = await parseRange(c, q);
      const rows = (await c.query(
        `WITH tk AS (
           SELECT asg.worker_id, t.status, upper(t.service_window) AS due_at,
                  (SELECT max(occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') AS done_at
             FROM ops.task t JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
            WHERE COALESCE(lower(t.service_window), t.created_at) >= $1 AND COALESCE(lower(t.service_window), t.created_at) < $2
         ), sh AS (
           SELECT worker_id, sum(extract(epoch FROM LEAST(COALESCE(ended_at, now()), $2) - GREATEST(started_at, $1))) / 3600 AS hours
             FROM shift.shift WHERE started_at < $2 AND COALESCE(ended_at, now()) > $1 GROUP BY worker_id
         ), km AS (
           SELECT worker_id, sum(km) AS km FROM (
             SELECT worker_id, ST_Length(ST_MakeLine(position::geometry ORDER BY recorded_at)::geography) / 1000 AS km
               FROM geo.location_point
              WHERE recorded_at >= $1 AND recorded_at < $2 AND (accuracy_m IS NULL OR accuracy_m <= $3)
              GROUP BY worker_id, shift_id HAVING count(*) >= 2) x
            GROUP BY worker_id
         )
         SELECT w.id AS worker_id, w.display_name AS name,
                count(tk.*) FILTER (WHERE tk.status IN ${DONE})::int AS completed,
                count(tk.*) FILTER (WHERE tk.status = 'failed')::int AS failed,
                round(100.0 * count(tk.*) FILTER (WHERE tk.done_at <= tk.due_at) / NULLIF(count(tk.*) FILTER (WHERE tk.done_at IS NOT NULL AND tk.due_at IS NOT NULL), 0), 1)::float AS on_time_pct,
                round(COALESCE(max(sh.hours), 0)::numeric, 2)::float AS shift_hours,
                round(COALESCE(max(km.km), 0)::numeric, 2)::float AS km
           FROM workforce.worker w
           LEFT JOIN tk ON tk.worker_id = w.id
           LEFT JOIN sh ON sh.worker_id = w.id
           LEFT JOIN km ON km.worker_id = w.id
          WHERE (cardinality($4::uuid[]) = 0 OR w.branch_id IS NULL OR w.branch_id = ANY($4::uuid[]))
          GROUP BY w.id, w.display_name
         HAVING count(tk.*) > 0 OR max(sh.hours) > 0
          ORDER BY completed DESC, name`,
        [r.from, r.to, MAX_ACCURACY_M, a.branchIds])).rows;
      return respond(res, q.format, 'drivers', rows, ['worker_id', 'name', 'completed', 'failed', 'on_time_pct', 'shift_hours', 'km'], { from: r.from, to: r.to });
    });
  }

  /** Per vehicle: shifts, hours in use, utilisation of the period and kilometres by odometer. */
  @Get('fleet')
  @Perm('reports:read')
  fleet(@Auth() a: AuthContext, @Query() q: Record<string, string | undefined>, @Res({ passthrough: true }) res: CsvResponse) {
    return this.db.withTenant(a, async (c) => {
      const r = await parseRange(c, q);
      const rows = (await c.query(
        `SELECT ast.id AS asset_id, ast.plate_no, ast.asset_type, ast.status,
                count(s.id)::int AS shifts,
                round(COALESCE(sum(extract(epoch FROM LEAST(COALESCE(s.ended_at, now()), $2) - GREATEST(s.started_at, $1))) / 3600, 0)::numeric, 2)::float AS hours,
                round((100 * COALESCE(sum(extract(epoch FROM LEAST(COALESCE(s.ended_at, now()), $2) - GREATEST(s.started_at, $1))), 0)
                       / extract(epoch FROM ($2::timestamptz - $1::timestamptz)))::numeric, 1)::float AS utilization_pct,
                COALESCE(sum(s.end_odometer_km - s.start_odometer_km) FILTER (WHERE s.end_odometer_km IS NOT NULL AND s.start_odometer_km IS NOT NULL), 0)::int AS km
           FROM fleet.asset ast
           LEFT JOIN shift.shift s ON s.asset_id = ast.id AND s.started_at < $2 AND COALESCE(s.ended_at, now()) > $1
          WHERE ast.status <> 'retired' AND (cardinality($3::uuid[]) = 0 OR ast.branch_id IS NULL OR ast.branch_id = ANY($3::uuid[]))
          GROUP BY ast.id ORDER BY hours DESC, ast.plate_no NULLS LAST`,
        [r.from, r.to, a.branchIds])).rows;
      return respond(res, q.format, 'fleet', rows, ['asset_id', 'plate_no', 'asset_type', 'status', 'shifts', 'hours', 'utilization_pct', 'km'], { from: r.from, to: r.to });
    });
  }
}
