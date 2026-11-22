import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { pgToHttp, v } from '../../common/validate';
import { createTask } from '../../tasks/tasks.controller';
import { DELIVERY } from '../delivery/delivery';
import { AWB_RE, DEFAULT_MAX_ATTEMPTS, dueAt, newAwb, SCAN_EVENTS, ScanEvent, scanOutcome, Service, SERVICES, STUCK_HOURS, whereIs } from './courier';

const DONE = ['completed', 'reviewed', 'invoiced'];

/** One row per parcel: its delivery task, shipper, hubs, failed attempts, last scan and COD collected. */
const PARCEL_SQL = `
  SELECT p.task_id, p.legal_entity_id, p.awb, p.service, p.pieces, p.weight_kg::float, p.max_attempts, p.due_at, p.rto_at, p.rto_done_at, p.created_at,
         p.origin_hub_id, oh.code AS origin_hub, p.dest_hub_id, dh.code AS dest_hub, p.current_hub_id, ch.code AS current_hub, ch.name AS current_hub_name,
         t.status, t.version, t.customer_id, cu.name AS shipper_name, t.attributes,
         asg.worker_id, w.display_name AS worker_name,
         (SELECT count(*)::int FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed') AS attempts,
         (SELECT max(e.occurred_at) FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'completed') AS delivered_at,
         ls.event AS last_event, ls.scanned_at AS last_scan_at,
         cod.amount::text AS cod_collected
    FROM ops.courier_parcel p JOIN ops.task t ON t.id = p.task_id
    LEFT JOIN crm.customer cu ON cu.id = t.customer_id
    LEFT JOIN ops.courier_hub oh ON oh.id = p.origin_hub_id
    LEFT JOIN ops.courier_hub dh ON dh.id = p.dest_hub_id
    LEFT JOIN ops.courier_hub ch ON ch.id = p.current_hub_id
    LEFT JOIN ops.assignment asg ON asg.task_id = t.id AND asg.active
    LEFT JOIN workforce.worker w ON w.id = asg.worker_id
    LEFT JOIN billing.cod_collection cod ON cod.task_id = t.id
    LEFT JOIN LATERAL (SELECT s.event, s.scanned_at FROM ops.courier_scan s WHERE s.task_id = p.task_id ORDER BY s.scanned_at DESC LIMIT 1) ls ON true`;

const withWhere = <T extends { status: string; current_hub_id: string | null; rto_at: unknown; rto_done_at: unknown }>(r: T) => ({ ...r, where: whereIs(r) });
const hubCode = (val: unknown) => {
  const s = v.str(val, 'code', { required: true, max: 12 })!.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(s)) throw new BadRequestException('code: letters, digits, - and _ only');
  return s;
};
const awbOf = (val: unknown, field = 'awb') => {
  const s = v.str(val, field, { max: 30 })?.toUpperCase().trim() ?? null;
  if (s && !AWB_RE.test(s)) throw new BadRequestException(`${field}: 4-30 letters, digits and -`);
  return s;
};

/**
 * Courier and express (courier pack, sector 4): hubs, parcels with a waybill (each a delivery@1 task, so dispatch, the
 * driver app, proof of delivery, COD and the tracking link are the delivery pack's), hub scans, delivery attempts and
 * return to the shipper, exceptions and the courier KPIs. COD stays in the core books (billing cod collection and payouts).
 */
@Controller('v1/courier')
@UseGuards(AuthGuard)
@Pack('courier')
export class CourierController {
  constructor(private readonly db: DbService) {}

  @Get('hubs')
  @Perm('tasks:read')
  hubs(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT h.id, h.legal_entity_id, h.code, h.name, h.area, h.active,
                (SELECT count(*)::int FROM ops.courier_parcel p JOIN ops.task t ON t.id = p.task_id
                  WHERE p.current_hub_id = h.id AND p.rto_done_at IS NULL AND (t.status IN ('draft','ready','assigned') OR (t.status = 'failed' AND p.rto_at IS NOT NULL))) AS parcels_here
           FROM ops.courier_hub h ORDER BY h.active DESC, h.code LIMIT 200`)).rows,
    }));
  }

  @Post('hubs')
  @Perm('tasks:write')
  addHub(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const code = hubCode(b?.code);
    const name = v.str(b?.name, 'name', { required: true, max: 120 })!;
    const area = v.str(b?.area, 'area', { max: 80 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM org.legal_entity WHERE id = $1', [le])).rowCount) throw new BadRequestException('unknown legal_entity_id');
      const id = randomUUID();
      try {
        await c.query('INSERT INTO ops.courier_hub (id, tenant_id, legal_entity_id, code, name, area) VALUES ($1,$2,$3,$4,$5,$6)', [id, a.tenantId, le, code, name, area]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('a hub with this code exists');
        return pgToHttp(e);
      }
      const row = (await c.query('SELECT id, legal_entity_id, code, name, area, active FROM ops.courier_hub WHERE id = $1', [id])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'courier.hub_created', targetType: 'courier_hub', targetId: id, after: row });
      return row;
    });
  }

  @Patch('hubs/:id')
  @Perm('tasks:write')
  editHub(@Auth() a: AuthContext, @Param('id') id: string, @Body() b: Record<string, unknown>) {
    v.uuid(id, 'id', { required: true });
    const name = v.str(b?.name, 'name', { max: 120 });
    const area = v.str(b?.area, 'area', { max: 80 });
    if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query('SELECT id, code, name, area, active FROM ops.courier_hub WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new NotFoundException();
      const row = (await c.query(
        `UPDATE ops.courier_hub SET name = COALESCE($2, name), area = COALESCE($3, area), active = COALESCE($4, active) WHERE id = $1
         RETURNING id, legal_entity_id, code, name, area, active`, [id, name, area, b?.active ?? null])).rows[0];
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'courier.hub_updated', targetType: 'courier_hub', targetId: id, before, after: row });
      return row;
    });
  }

  /** Books a parcel: a delivery task due by the service level, received at the origin hub when one is given. */
  @Post('parcels')
  @Perm('tasks:write')
  book(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const le = v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true })!;
    const customer = v.uuid(b?.customer_id, 'customer_id');
    const service = (v.str(b?.service, 'service', { max: 20 }) ?? 'next_day') as Service;
    if (!SERVICES.includes(service)) throw new BadRequestException(`service must be one of ${SERVICES.join(', ')}`);
    const pieces = v.int(b?.pieces, 'pieces', 1, 999) ?? 1;
    const weight = b?.weight_kg === undefined || b?.weight_kg === null || b?.weight_kg === '' ? null : Number(b.weight_kg);
    if (weight !== null && (!Number.isFinite(weight) || weight <= 0 || weight > 10_000)) throw new BadRequestException('weight_kg must be 0-10000');
    const origin = v.uuid(b?.origin_hub_id, 'origin_hub_id');
    const dest = v.uuid(b?.dest_hub_id, 'dest_hub_id');
    const maxAttempts = v.int(b?.max_attempts, 'max_attempts', 1, 9) ?? DEFAULT_MAX_ATTEMPTS;
    const recipient = v.obj(b?.recipient, 'recipient');
    const dropoff = v.obj(b?.dropoff, 'dropoff');
    if (!recipient?.phone) throw new BadRequestException('recipient.phone required');
    if (!dropoff?.area) throw new BadRequestException('dropoff.area required');
    const cod = v.money(b?.cod_amount, 'cod_amount');
    if (cod && Number(cod) > 0 && !customer) throw new BadRequestException('cash on delivery needs the shipper (customer_id)');
    const fee = v.money(b?.delivery_fee, 'delivery_fee');
    const awb = awbOf(b?.awb) ?? newAwb();
    const now = new Date();
    const due = dueAt(service, now);
    return this.db.withTenant(a, async (c) => {
      if (origin && !(await c.query('SELECT 1 FROM ops.courier_hub WHERE id = $1 AND active', [origin])).rowCount) throw new BadRequestException('unknown origin_hub_id');
      if (dest && !(await c.query('SELECT 1 FROM ops.courier_hub WHERE id = $1 AND active', [dest])).rowCount) throw new BadRequestException('unknown dest_hub_id');
      if ((await c.query('SELECT 1 FROM ops.courier_parcel WHERE awb = $1', [awb])).rowCount) throw new ConflictException('a parcel with this waybill exists');
      const attrs: Record<string, unknown> = {
        awb, service, pieces, ...(weight !== null ? { weight_kg: weight } : {}), attempt: 1, max_attempts: maxAttempts,
        recipient, dropoff, ...(b?.pickup ? { pickup: v.obj(b.pickup, 'pickup') } : {}),
        ...(cod && Number(cod) > 0 ? { cod_amount: cod } : {}), ...(fee ? { delivery_fee: fee } : {}),
        ...(b?.notes ? { notes: v.str(b.notes, 'notes', { max: 300 }) } : {}),
      };
      const task = await createTask(c, a, { le, pack: DELIVERY, branch: null, ref: awb, attrs, win: { from: now.toISOString(), to: due.toISOString() }, status: 'ready', customer, site: null });
      try {
        await c.query(
          `INSERT INTO ops.courier_parcel (task_id, tenant_id, legal_entity_id, awb, service, pieces, weight_kg, origin_hub_id, dest_hub_id, current_hub_id, max_attempts, due_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10,$11)`,
          [task.id, a.tenantId, le, awb, service, pieces, weight, origin, dest, maxAttempts, due]);
      } catch (e) { return pgToHttp(e); }
      if (origin) await this.scanRow(c, a, task.id, origin, 'received', null);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'courier.parcel_booked', targetType: 'task', targetId: task.id, after: { awb, service, pieces } });
      return this.detailOf(c, task.id);
    });
  }

  @Get('parcels')
  @Perm('tasks:read')
  parcels(@Auth() a: AuthContext, @Query('q') q?: string, @Query('hub_id') hub?: string, @Query('where') where?: string) {
    const term = v.str(q, 'q', { max: 60 });
    const hubId = v.uuid(hub, 'hub_id');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `${PARCEL_SQL}
          WHERE ($1::text IS NULL OR p.awb ILIKE '%' || $1 || '%' OR t.attributes->'recipient'->>'phone' LIKE '%' || $1 || '%' OR cu.name ILIKE '%' || $1 || '%')
            AND ($2::uuid IS NULL OR p.current_hub_id = $2)
          ORDER BY p.created_at DESC LIMIT 300`, [term, hubId])).rows.map(withWhere);
      return { data: where ? rows.filter((r) => r.where === where) : rows };
    });
  }

  /** A parcel by id or waybill, with its hub scans and delivery attempts. */
  @Get('parcels/:key')
  @Perm('tasks:read')
  parcel(@Auth() a: AuthContext, @Param('key') key: string) {
    return this.db.withTenant(a, async (c) => {
      const id = /^[0-9a-f-]{36}$/i.test(key) ? key : (await c.query('SELECT task_id FROM ops.courier_parcel WHERE awb = $1', [key.toUpperCase()])).rows[0]?.task_id;
      if (!id) throw new NotFoundException();
      return this.detailOf(c, id);
    });
  }

  /**
   * Scans a batch of waybills at a hub. Each line is applied or reported (unknown waybill, delivered, with the driver ...);
   * one bad line does not stop the rest. "returned" brings a failed attempt back: out again while attempts remain
   * (the task goes back to the dispatch queue), else marked for return to the shipper; `rto: true` forces that.
   */
  @Post('scans')
  @HttpCode(200)
  @Perm('tasks:write')
  scan(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const event = v.str(b?.event, 'event', { required: true, max: 20 }) as ScanEvent;
    if (!SCAN_EVENTS.includes(event)) throw new BadRequestException(`event must be one of ${SCAN_EVENTS.join(', ')}`);
    const hub = v.uuid(b?.hub_id, 'hub_id', { required: true })!;
    const note = v.str(b?.note, 'note', { max: 300 });
    if (b?.rto !== undefined && typeof b.rto !== 'boolean') throw new BadRequestException('rto must be true/false');
    if (!Array.isArray(b?.awbs) || b.awbs.length === 0 || b.awbs.length > 500) throw new BadRequestException('awbs: 1-500 waybills');
    const awbs = [...new Set((b.awbs as unknown[]).map((x, i) => awbOf(x, `awbs[${i}]`)).filter((x): x is string => !!x))];
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM ops.courier_hub WHERE id = $1 AND active', [hub])).rowCount) throw new BadRequestException('unknown hub_id');
      const results: { awb: string; result: 'applied' | 'rejected'; reason?: string; reopened?: boolean; rto?: boolean }[] = [];
      for (const awb of awbs) {
        const p = (await c.query(
          `SELECT p.task_id, p.max_attempts, p.rto_at, p.rto_done_at, t.status, t.version,
                  (SELECT count(*)::int FROM ops.task_event e WHERE e.task_id = t.id AND e.to_status = 'failed') AS attempts
             FROM ops.courier_parcel p JOIN ops.task t ON t.id = p.task_id WHERE p.awb = $1 FOR UPDATE OF p, t`, [awb])).rows[0];
        if (!p) { results.push({ awb, result: 'rejected', reason: 'unknown_awb' }); continue; }
        const o = scanOutcome(event, p, b?.rto === true);
        if ('error' in o) { results.push({ awb, result: 'rejected', reason: o.error }); continue; }
        await c.query(
          `UPDATE ops.courier_parcel SET current_hub_id = CASE $2 WHEN 'set' THEN $3::uuid WHEN 'clear' THEN NULL ELSE current_hub_id END,
                  rto_at = CASE WHEN $4 THEN now() ELSE rto_at END, rto_done_at = CASE WHEN $5 THEN now() ELSE rto_done_at END
            WHERE task_id = $1`, [p.task_id, o.hub, hub, !!o.rto, !!o.rtoDone]);
        await this.scanRow(c, a, p.task_id, hub, event, note);
        if (o.reopen) {
          // back to the dispatch queue for the next attempt; the driver app shows "attempt n of max"
          await c.query('UPDATE ops.assignment SET active = false, ended_at = now() WHERE task_id = $1 AND active', [p.task_id]);
          await c.query(
            `UPDATE ops.task SET status = 'ready', version = version + 1, updated_at = now(),
                    attributes = attributes || jsonb_build_object('attempt', $2::int) WHERE id = $1`, [p.task_id, p.attempts + 1]);
          await c.query(
            `INSERT INTO ops.task_event (id, tenant_id, task_id, from_status, to_status, occurred_at, actor_id, actor_type, client_op_id, note)
             VALUES ($1,$2,$3,'failed','ready',now(),$4,'staff',$5,$6)`, [randomUUID(), a.tenantId, p.task_id, a.userId, randomUUID(), `courier attempt ${p.attempts + 1}`]);
        }
        if (o.rtoDone) {
          await c.query(
            `INSERT INTO ops.task_milestone (id, tenant_id, task_id, code, occurred_at, actor_id, client_op_id, note) VALUES ($1,$2,$3,'returned_to_sender',now(),$4,$5,$6)`,
            [randomUUID(), a.tenantId, p.task_id, a.userId, randomUUID(), note]);
        }
        results.push({ awb, result: 'applied', ...(o.reopen ? { reopened: true } : {}), ...(o.rto ? { rto: true } : {}) });
      }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'courier.scanned', targetType: 'courier_hub', targetId: hub,
        after: { event, applied: results.filter((r) => r.result === 'applied').length, rejected: results.filter((r) => r.result === 'rejected').length } });
      return { event, hub_id: hub, results };
    });
  }

  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `${PARCEL_SQL}
          WHERE p.rto_done_at IS NULL AND t.status NOT IN ('completed','reviewed','invoiced','canceled') ORDER BY p.due_at LIMIT 1000`)).rows.map(withWhere);
      const now = Date.now();
      return {
        overdue: rows.filter((r) => !r.rto_at && new Date(r.due_at).getTime() < now),
        stuck: rows.filter((r) => r.where === 'at_hub' && new Date(r.last_scan_at ?? r.created_at).getTime() < now - STUCK_HOURS * 3_600_000),
        awaiting_return: rows.filter((r) => r.status === 'failed' && !r.rto_at),
        rto_pending: rows.filter((r) => r.rto_at),
      };
    });
  }

  /** Courier KPIs for parcels booked in a period (Kuwait dates): per service and per shipper. */
  @Get('report')
  @Perm('reports:read')
  report(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `${PARCEL_SQL}
          WHERE (p.created_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $1 AND $2 AND t.status <> 'canceled'`, [f, t])).rows;
      type Acc = { parcels: number; delivered: number; first_attempt: number; on_time: number; rto: number; failed_attempts: number; cod_fils: number };
      const blank = (): Acc => ({ parcels: 0, delivered: 0, first_attempt: 0, on_time: 0, rto: 0, failed_attempts: 0, cod_fils: 0 });
      const byService = new Map<string, Acc>(), byShipper = new Map<string, Acc & { name: string }>();
      const total = blank();
      for (const r of rows) {
        const delivered = DONE.includes(r.status);
        const add = (x: Acc) => {
          x.parcels++; x.failed_attempts += r.attempts;
          if (delivered) { x.delivered++; if (r.attempts === 0) x.first_attempt++; if (r.delivered_at && new Date(r.delivered_at) <= new Date(r.due_at)) x.on_time++; }
          if (r.rto_at) x.rto++;
          if (r.cod_collected) x.cod_fils += Math.round(Number(r.cod_collected) * 1000);
        };
        if (!byService.has(r.service)) byService.set(r.service, blank());
        add(byService.get(r.service)!);
        const sk = r.customer_id ?? '-';
        if (!byShipper.has(sk)) byShipper.set(sk, { ...blank(), name: r.shipper_name ?? '—' });
        add(byShipper.get(sk)!);
        add(total);
      }
      const pct = (x: number, y: number) => (y ? Math.round((x / y) * 1000) / 10 : null);
      const out = (x: Acc) => ({
        parcels: x.parcels, delivered: x.delivered, rto: x.rto, failed_attempts: x.failed_attempts,
        delivery_pct: pct(x.delivered, x.parcels), first_attempt_pct: pct(x.first_attempt, x.delivered), on_time_pct: pct(x.on_time, x.delivered), rto_pct: pct(x.rto, x.parcels),
        cod_collected: (x.cod_fils / 1000).toFixed(3),
      });
      return {
        from: f, to: t,
        services: SERVICES.filter((s) => byService.has(s)).map((s) => ({ service: s, ...out(byService.get(s)!) })),
        shippers: [...byShipper.entries()].map(([id, x]) => ({ customer_id: id === '-' ? null : id, name: x.name, ...out(x) })).sort((x, y) => y.parcels - x.parcels),
        totals: out(total),
      };
    });
  }

  private async scanRow(c: PoolClient, a: AuthContext, taskId: string, hub: string, event: ScanEvent, note: string | null) {
    await c.query('INSERT INTO ops.courier_scan (id, tenant_id, task_id, hub_id, event, scanned_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), a.tenantId, taskId, hub, event, a.userId, note]);
  }

  private async detailOf(c: PoolClient, id: string) {
    const p = (await c.query(`${PARCEL_SQL} WHERE p.task_id = $1`, [id])).rows[0];
    if (!p) throw new NotFoundException();
    const scans = (await c.query(
      `SELECT s.id, s.event, s.scanned_at, s.note, h.code AS hub, h.name AS hub_name
         FROM ops.courier_scan s LEFT JOIN ops.courier_hub h ON h.id = s.hub_id WHERE s.task_id = $1 ORDER BY s.scanned_at`, [id])).rows;
    const events = (await c.query(
      `SELECT e.to_status, e.occurred_at, e.reason_code, e.note, e.actor_type, w.display_name AS driver_name
         FROM ops.task_event e LEFT JOIN workforce.worker w ON w.user_id = e.actor_id AND e.actor_type = 'driver'
        WHERE e.task_id = $1 ORDER BY e.occurred_at`, [id])).rows;
    const link = (await c.query('SELECT token FROM ops.delivery_link WHERE task_id = $1', [id])).rows[0];
    return { ...withWhere(p), scans, events, track_token: link?.token ?? null };
  }
}
