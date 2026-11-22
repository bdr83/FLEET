import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { v } from '../../common/validate';
import { fils, Item, kwd, onTime, READING_GAP_MINUTES, valueFils } from '../distribution/distribution';

/**
 * Food distribution and cold chain (coldchain pack, sector 3). Routes, stops and the driver flow are the distribution
 * engine (/v1/distribution, open to this pack too) with a temperature class and range, delivery windows, damaged goods
 * and item expiry. This controller adds the cold-chain exceptions and the sector's KPIs: on-time delivery, spoilage loss,
 * return rate, vehicle productivity and temperature compliance. Temperatures come only from readings with a source
 * (driver, office, or a logger/app reference); nothing is assumed without one.
 */
@Controller('v1/coldchain')
@UseGuards(AuthGuard)
@Pack('coldchain')
export class ColdchainController {
  constructor(private readonly db: DbService) {}

  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const out_of_range = (await c.query(
        `SELECT x.id, x.route_id, r.ref AS route_ref, r.temp_class, r.temp_min::float, r.temp_max::float, x.reading_c::float, x.source, x.device_ref, x.recorded_at, s.name AS stop_name
           FROM ops.temp_reading x JOIN ops.dist_route r ON r.id = x.route_id LEFT JOIN ops.dist_stop s ON s.task_id = x.stop_task_id
          WHERE x.in_range = false AND x.recorded_at > now() - interval '7 days' ORDER BY x.recorded_at DESC LIMIT 200`)).rows;
      // cold routes on the road with no reading recently (or none at all)
      const no_reading = (await c.query(
        `SELECT r.id AS route_id, r.ref AS route_ref, r.temp_class, r.out_at, w.display_name AS driver_name, a.plate_no,
                (SELECT max(x.recorded_at) FROM ops.temp_reading x WHERE x.route_id = r.id) AS last_at
           FROM ops.dist_route r JOIN workforce.worker w ON w.id = r.driver_worker_id JOIN fleet.asset a ON a.id = r.asset_id
          WHERE r.status IN ('loaded','out') AND r.temp_class <> 'ambient'
            AND COALESCE((SELECT max(x.recorded_at) FROM ops.temp_reading x WHERE x.route_id = r.id), '-infinity') < now() - make_interval(mins => $1)
          ORDER BY r.ref LIMIT 200`, [READING_GAP_MINUTES])).rows;
      const stops = (await c.query(
        `SELECT s.task_id, s.route_id, r.ref AS route_ref, s.seq, s.name, s.window_from, s.window_to, s.done_at, s.closed_reason, s.items, s.damaged, r.route_date::text AS route_date,
                w.display_name AS driver_name
           FROM ops.dist_stop s JOIN ops.dist_route r ON r.id = s.route_id JOIN workforce.worker w ON w.id = r.driver_worker_id
          WHERE r.status <> 'canceled' AND r.route_date >= current_date - 7 AND r.route_date <= current_date + 2 ORDER BY r.route_date, r.ref, s.seq LIMIT 2000`)).rows;
      const now = Date.now();
      const late = stops.filter((s) => s.window_to && !s.closed_reason && (s.done_at ? new Date(s.done_at) > new Date(s.window_to) : new Date(s.window_to).getTime() < now))
        .map(({ items, damaged, ...s }) => ({ ...s, state: s.done_at ? 'delivered_late' : 'overdue' }));
      const expiring = stops.filter((s) => !s.done_at).flatMap((s) => (s.items as Item[])
        .filter((i) => i.expiry && i.expiry <= s.route_date)
        .map((i) => ({ task_id: s.task_id, route_id: s.route_id, route_ref: s.route_ref, seq: s.seq, name: s.name, route_date: s.route_date, sku: i.sku, item: i.name, expiry: i.expiry, qty: i.qty })));
      const damaged = stops.filter((s) => s.damaged && Object.keys(s.damaged).length)
        .map((s) => ({ task_id: s.task_id, route_id: s.route_id, route_ref: s.route_ref, seq: s.seq, name: s.name, damaged: s.damaged, value: kwd(valueFils(s.damaged, s.items)) }));
      return { out_of_range, no_reading, late, expiring, damaged };
    });
  }

  /** KPIs for a period by route day: on-time stops, spoilage loss, return rate, stops per hour on the road, readings in range. */
  @Get('report')
  @Perm('reports:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from') ?? (() => { throw new BadRequestException('from required'); })();
    const t = v.date(to, 'to') ?? (() => { throw new BadRequestException('to required'); })();
    if (t < f) throw new BadRequestException('to is before from');
    return this.db.withTenant(a, async (c) => {
      const routes = (await c.query(
        `SELECT r.id, r.ref, r.route_date::text AS route_date, r.temp_class, r.out_at, r.back_at, a.plate_no, w.display_name AS driver_name,
                (SELECT count(*)::int FROM ops.temp_reading x WHERE x.route_id = r.id) AS readings,
                (SELECT count(*)::int FROM ops.temp_reading x WHERE x.route_id = r.id AND x.in_range = false) AS readings_out
           FROM ops.dist_route r JOIN fleet.asset a ON a.id = r.asset_id JOIN workforce.worker w ON w.id = r.driver_worker_id
          WHERE r.route_date BETWEEN $1 AND $2 AND r.status <> 'canceled' ORDER BY r.route_date, r.ref`, [f, t])).rows;
      const stops = (await c.query(
        `SELECT s.route_id, s.items, s.delivered, s.returned, s.damaged, s.done_at, s.window_to, s.closed_reason FROM ops.dist_stop s JOIN ops.dist_route r ON r.id = s.route_id
          WHERE r.route_date BETWEEN $1 AND $2 AND r.status <> 'canceled'`, [f, t])).rows;
      const by = new Map<string, typeof stops>();
      for (const s of stops) by.set(s.route_id, [...(by.get(s.route_id) ?? []), s]);
      const rows = routes.map((r) => {
        const ss = by.get(r.id) ?? [];
        const done = ss.filter((s) => s.done_at && !s.closed_reason);
        const onTimeN = done.filter((s) => onTime(s.done_at, s.window_to)).length;
        const delivered = ss.reduce((x, s) => x + valueFils(s.delivered ?? {}, s.items), 0);
        const returned = ss.reduce((x, s) => x + valueFils(s.returned ?? {}, s.items), 0);
        const damaged = ss.reduce((x, s) => x + valueFils(s.damaged ?? {}, s.items), 0);
        const hours = r.out_at && r.back_at ? (new Date(r.back_at).getTime() - new Date(r.out_at).getTime()) / 3_600_000 : null;
        return { id: r.id, ref: r.ref, route_date: r.route_date, temp_class: r.temp_class, plate_no: r.plate_no, driver_name: r.driver_name,
          stops: ss.length, delivered_stops: done.length, refused_stops: ss.filter((s) => s.closed_reason).length, on_time_stops: onTimeN,
          delivered_value: kwd(delivered), returned_value: kwd(returned), damaged_value: kwd(damaged), hours: hours === null ? null : Math.round(hours * 100) / 100,
          stops_per_hour: hours && hours > 0 ? Math.round((done.length / hours) * 100) / 100 : null, readings: r.readings, readings_out: r.readings_out };
      });
      const n = (k: 'stops' | 'delivered_stops' | 'refused_stops' | 'on_time_stops' | 'readings' | 'readings_out') => rows.reduce((s, r) => s + r[k], 0);
      const m = (k: 'delivered_value' | 'returned_value' | 'damaged_value') => rows.reduce((s, r) => s + fils(r[k]), 0);
      const hours = rows.reduce((s, r) => s + (r.hours ?? 0), 0);
      const pct = (x: number, y: number) => (y ? Math.round((x / y) * 1000) / 10 : null);
      return {
        from: f, to: t, data: rows,
        totals: {
          routes: rows.length, stops: n('stops'), delivered_stops: n('delivered_stops'), refused_stops: n('refused_stops'),
          on_time_pct: pct(n('on_time_stops'), n('delivered_stops')),
          delivered_value: kwd(m('delivered_value')), returned_value: kwd(m('returned_value')), damaged_value: kwd(m('damaged_value')),
          return_rate_pct: pct(m('returned_value'), m('delivered_value')), spoilage_pct: pct(m('damaged_value'), m('delivered_value') + m('damaged_value')),
          stops_per_hour: hours > 0 ? Math.round((n('delivered_stops') / hours) * 100) / 100 : null,
          readings: n('readings'), temp_compliance_pct: pct(n('readings') - n('readings_out'), n('readings')),
        },
      };
    });
  }
}
