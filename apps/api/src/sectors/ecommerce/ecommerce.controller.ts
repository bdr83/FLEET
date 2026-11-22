import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, HttpException, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Pack, Perm } from '../../auth/auth.guard';
import { Auth } from '../../auth/auth.decorator';
import { DbService } from '../../db/db.service';
import { audit } from '../../common/audit';
import { v } from '../../common/validate';
import { ACCOUNTS, balance } from '../../billing/ledger';
import { SERVICES } from '../courier/courier';
import { normalizeAttributes } from '../delivery/delivery';
import { newApiKey, parseApiKey, secretMatches } from './ecommerce';
import { cancelOrder, createOrder, forStore, merchantOf, ORDER_SQL, requestReturn, Row, withStatus } from './ecommerce.orders';

const APP_URL = () => (process.env.APP_URL ?? process.env.WEB_URL ?? 'https://app.q8hub.com').replace(/\/$/, '');
const r3 = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

/**
 * E-commerce shipping, office side (ecommerce pack, sector 9): stores (customers) with their pickup address, default
 * service, warehouse and API keys; their orders (from the API, a file or the office); cancel and returns; exceptions and
 * each store's statement from the core books.
 */
@Controller('v1/ecommerce')
@UseGuards(AuthGuard)
@Pack('ecommerce')
export class EcommerceController {
  constructor(private readonly db: DbService) {}

  @Get('merchants')
  @Perm('customers:read')
  merchants(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT m.customer_id, cu.name, m.pickup, m.default_service, m.warehouse_id, w.code AS warehouse_code, m.max_attempts, m.active,
                (SELECT count(*)::int FROM ops.ecom_api_key k WHERE k.customer_id = m.customer_id AND k.revoked_at IS NULL) AS keys,
                (SELECT count(*)::int FROM ops.ecom_order o WHERE o.customer_id = m.customer_id) AS orders
           FROM ops.ecom_merchant m JOIN crm.customer cu ON cu.id = m.customer_id LEFT JOIN ops.wh_warehouse w ON w.id = m.warehouse_id ORDER BY cu.name`)).rows,
    }));
  }

  /** Makes a customer a store, or changes its settings. */
  @Put('merchants/:customerId')
  @Perm('customers:write')
  saveMerchant(@Auth() a: AuthContext, @Param('customerId', new ParseUUIDPipe()) customer: string, @Body() b: Record<string, unknown>) {
    const service = v.str(b?.default_service, 'default_service', { max: 20 }) ?? 'next_day';
    if (!(SERVICES as readonly string[]).includes(service)) throw new BadRequestException(`default_service must be one of ${SERVICES.join(', ')}`);
    const wh = v.uuid(b?.warehouse_id, 'warehouse_id');
    const max = v.int(b?.max_attempts, 'max_attempts', 1, 9) ?? 3;
    if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true/false');
    const pickup = b?.pickup ? (normalizeAttributes({ pickup: v.obj(b.pickup, 'pickup') })!.pickup as Record<string, unknown>) : null;
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query(`SELECT 1 FROM crm.customer WHERE id = $1 AND status = 'active'`, [customer])).rowCount) throw new NotFoundException('unknown customer');
      if (wh && !(await c.query('SELECT 1 FROM ops.wh_warehouse WHERE id = $1 AND active', [wh])).rowCount) throw new BadRequestException('unknown warehouse_id');
      const before = await merchantOf(c, customer);
      await c.query(
        `INSERT INTO ops.ecom_merchant (tenant_id, customer_id, pickup, default_service, warehouse_id, max_attempts, active) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, customer_id) DO UPDATE SET pickup = EXCLUDED.pickup, default_service = EXCLUDED.default_service, warehouse_id = EXCLUDED.warehouse_id,
           max_attempts = EXCLUDED.max_attempts, active = EXCLUDED.active, updated_at = now()`,
        [a.tenantId, customer, pickup && JSON.stringify(pickup), service, wh, max, b?.active ?? true]);
      const after = await merchantOf(c, customer);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'ecommerce.merchant_saved', targetType: 'customer', targetId: customer, before, after });
      return after;
    });
  }

  @Get('merchants/:customerId/keys')
  @Perm('customers:read')
  keys(@Auth() a: AuthContext, @Param('customerId', new ParseUUIDPipe()) customer: string) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT id, 'fpk_' || prefix || '_…' AS hint, label, created_at, last_used_at, revoked_at FROM ops.ecom_api_key WHERE customer_id = $1 ORDER BY created_at DESC`, [customer])).rows,
    }));
  }

  /** A new API key for the store. The full key is in this response only; we keep its hash. */
  @Post('merchants/:customerId/keys')
  @Perm('customers:write')
  addKey(@Auth() a: AuthContext, @Param('customerId', new ParseUUIDPipe()) customer: string, @Body() b: Record<string, unknown>) {
    const label = v.str(b?.label, 'label', { max: 80 });
    return this.db.withTenant(a, async (c) => {
      if (!(await merchantOf(c, customer))) throw new ConflictException('set the store up first');
      const k = newApiKey();
      const id = randomUUID();
      await c.query('INSERT INTO ops.ecom_api_key (id, tenant_id, customer_id, prefix, secret_hash, label, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, a.tenantId, customer, k.prefix, k.hash, label, a.userId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'ecommerce.key_created', targetType: 'customer', targetId: customer, after: { key_id: id, label } });
      return { id, key: k.key, label };
    });
  }

  @Post('keys/:id/revoke')
  @HttpCode(200)
  @Perm('customers:write')
  revoke(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const k = (await c.query('UPDATE ops.ecom_api_key SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING customer_id, revoked_at', [id])).rows[0];
      if (!k) throw new NotFoundException();
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'ecommerce.key_revoked', targetType: 'customer', targetId: k.customer_id, after: { key_id: id } });
      return { id, revoked_at: k.revoked_at };
    });
  }

  @Get('orders')
  @Perm('tasks:read')
  orders(@Auth() a: AuthContext, @Query('customer_id') customer?: string, @Query('status') status?: string, @Query('q') q?: string) {
    const cu = v.uuid(customer, 'customer_id');
    const term = v.str(q, 'q', { max: 60 });
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(
        `${ORDER_SQL} WHERE ($1::uuid IS NULL OR eo.customer_id = $1) AND ($2::text IS NULL OR eo.external_id ILIKE '%' || $2 || '%' OR cp.awb ILIKE '%' || $2 || '%' OR t.attributes->'recipient'->>'phone' LIKE '%' || $2 || '%')
          ORDER BY eo.created_at DESC LIMIT 500`, [cu, term])).rows.map(withStatus);
      return { data: status ? rows.filter((r) => r.status === status) : rows };
    });
  }

  /** Office entry or a file of orders for one store (up to 500 lines); each line is created or reported. */
  @Post('orders')
  @Perm('tasks:write')
  addOrders(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const customer = v.uuid(b?.customer_id, 'customer_id', { required: true })!;
    const many = Array.isArray(b?.orders);
    const list = (many ? b.orders : [b?.order ?? b]) as Record<string, unknown>[];
    if (!list.length || list.length > 500) throw new BadRequestException('orders: 1-500');
    return this.db.withTenant(a, async (c) => {
      const m = await merchantOf(c, customer);
      if (!m?.active) throw new ConflictException('not an active store');
      const results: Record<string, unknown>[] = [];
      for (const [i, o] of list.entries()) {
        await c.query('SAVEPOINT line');
        try {
          const r = await createOrder(c, a, m, o, many ? 'import' : 'office');
          await c.query('RELEASE SAVEPOINT line');
          results.push({ line: i + 1, external_id: r.external_id, result: r.duplicate ? 'duplicate' : 'created', id: r.id, status: r.status });
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT line');
          if (!(e instanceof HttpException)) throw e;
          const msg = e.getResponse();
          results.push({ line: i + 1, external_id: o?.external_id ?? null, result: 'error', error: typeof msg === 'string' ? msg : (msg as { message?: unknown }).message });
        }
      }
      return { results };
    });
  }

  @Get('orders/:id')
  @Perm('tasks:read')
  order(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenant(a, async (c) => {
      const o = (await c.query(`${ORDER_SQL} WHERE eo.id = $1`, [id])).rows[0];
      if (!o) throw new NotFoundException();
      const events = o.task_id ? (await c.query(
        `SELECT to_status, occurred_at, reason_code, note FROM ops.task_event WHERE task_id = $1 ORDER BY occurred_at`, [o.task_id])).rows : [];
      return { ...withStatus(o), events };
    });
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @Perm('tasks:write')
  cancel(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, (c) => cancelOrder(c, a, id, reason));
  }

  @Post('orders/:id/return')
  @HttpCode(200)
  @Perm('tasks:write')
  ret(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.db.withTenant(a, (c) => requestReturn(c, a, id, reason));
  }

  @Get('exceptions')
  @Perm('tasks:read')
  exceptions(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const rows = (await c.query(`${ORDER_SQL} WHERE eo.canceled_at IS NULL AND eo.created_at > now() - interval '30 days' ORDER BY eo.created_at LIMIT 2000`)).rows.map(withStatus);
      const old = (h: number) => (r: Row) => new Date(r.created_at).getTime() < Date.now() - h * 3_600_000;
      const owed = (await c.query(
        `SELECT l.customer_id, cu.name, (-sum(l.amount))::text AS owed, min(l.posted_at) FILTER (WHERE l.amount < 0) AS oldest
           FROM billing.ledger_entry l JOIN crm.customer cu ON cu.id = l.customer_id JOIN ops.ecom_merchant m ON m.customer_id = l.customer_id
          WHERE l.account_code = $1 GROUP BY l.customer_id, cu.name HAVING sum(l.amount) < 0 ORDER BY sum(l.amount)`, [ACCOUNTS.COD_PAYABLE])).rows;
      return {
        not_dispatched: rows.filter((r) => ['received', 'processing', 'ready_to_ship', 'confirmed'].includes(r.status)).filter(old(24)), // [تخمين] 24 h
        failed: rows.filter((r) => r.status === 'failed'),
        returns_open: rows.filter((r) => r.return_task_id && !['completed', 'reviewed', 'invoiced', 'canceled'].includes(String(r.return_status))),
        cod_owed: owed,
      };
    });
  }

  /**
   * A store's statement for a period (Kuwait dates): its orders and outcomes, COD collected on them, and from the core
   * books the COD money we hold for it and its unpaid invoices, so the office can offset and pay out the difference.
   */
  @Get('merchants/:customerId/statement')
  @Perm('billing:read')
  statement(@Auth() a: AuthContext, @Param('customerId', new ParseUUIDPipe()) customer: string, @Query('from') from?: string, @Query('to') to?: string) {
    const f = v.date(from, 'from'), t = v.date(to, 'to');
    if (!f || !t) throw new BadRequestException('from and to required');
    if (t < f || Date.parse(t) - Date.parse(f) > 92 * 86_400_000) throw new BadRequestException('period must be 1-93 days');
    return this.db.withTenant(a, (c) => statementOf(c, customer, f, t));
  }
}

async function statementOf(c: PoolClient, customer: string, f: string, t: string) {
  const cu = (await c.query('SELECT id, name FROM crm.customer WHERE id = $1', [customer])).rows[0];
  if (!cu) throw new NotFoundException();
  const rows = (await c.query(`${ORDER_SQL} WHERE eo.customer_id = $1 AND (eo.created_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $2 AND $3 ORDER BY eo.created_at`, [customer, f, t])).rows.map(withStatus);
  const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
  const cod = rows.reduce((s, r) => s + (r.cod_collected ? Number(r.cod_collected) : 0), 0);
  const held = -(await balance(c, ACCOUNTS.COD_PAYABLE, { customerId: customer }));
  const due = Number((await c.query(`SELECT COALESCE(sum(total - paid_amount), 0) AS d FROM billing.invoice WHERE customer_id = $1 AND status IN ('issued','partially_paid')`, [customer])).rows[0].d);
  return {
    customer: cu, from: f, to: t,
    orders: rows.length, delivered: n(['delivered']), failed: n(['failed']), returned: n(['returning_to_store', 'returned_to_store']) + rows.filter((r) => r.return_task_id).length,
    canceled: n(['canceled']), open: rows.length - n(['delivered', 'failed', 'returning_to_store', 'returned_to_store', 'canceled']),
    delivery_pct: rows.length ? Math.round((n(['delivered']) / rows.length) * 1000) / 10 : null,
    cod_collected: r3(cod), cod_held_now: r3(held / 1000), invoices_due_now: r3(due), net_payable_now: r3(held / 1000 - due),
    lines: rows.map((r) => ({ external_id: r.external_id, awb: r.awb, status: r.status, created_at: r.created_at, delivered_at: r.delivered_at, cod_amount: (r.attributes as { cod_amount?: string } | null)?.cod_amount ?? null, cod_collected: r.cod_collected })),
  };
}

/**
 * The store's own API, authenticated by its key in `X-Api-Key` (no user login). Create orders (idempotent on the store's
 * order id), read one or the changes since a time, cancel before dispatch, and ask for a return after delivery.
 */
@Controller('v1/ecom/api')
export class EcomApiController {
  constructor(private readonly db: DbService) {}

  private async auth(header: unknown): Promise<AuthContext> {
    const p = parseApiKey(header);
    if (!p) throw new UnauthorizedException('X-Api-Key missing or malformed');
    const k = (await this.db.withoutTenant((c) => c.query('SELECT * FROM ops.ecom_key_lookup($1)', [p.prefix]))).rows[0];
    if (!k || !secretMatches(p.secret, k.secret_hash) || k.revoked) throw new UnauthorizedException('invalid API key');
    if (!['trial', 'active', 'past_due'].includes(k.tenant_status) || !k.packs.includes('ecommerce') || !k.merchant_active) throw new UnauthorizedException('store not active');
    return { tenantId: k.tenant_id, entityIds: [], userId: null as unknown as string, membershipId: '', roleCode: 'store_api', permissions: [], branchIds: [], customerId: k.customer_id, packs: k.packs, keyId: k.key_id } as AuthContext;
  }

  private run<T>(header: unknown, fn: (c: PoolClient, a: AuthContext) => Promise<T>) {
    return this.auth(header).then((a) => this.db.withTenant(a, async (c) => {
      await c.query(`UPDATE ops.ecom_api_key SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [(a as AuthContext & { keyId: string }).keyId]);
      return fn(c, a);
    }));
  }

  private async byExternal(c: PoolClient, a: AuthContext, ext: string) {
    const o = (await c.query(`${ORDER_SQL} WHERE eo.customer_id = $1 AND eo.external_id = $2`, [a.customerId, ext])).rows[0];
    if (!o) throw new NotFoundException('unknown order');
    return o;
  }

  @Post('orders')
  async create(@Headers('x-api-key') key: string, @Body() b: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const r = await this.run(key, async (c, a) => {
      const m = await merchantOf(c, a.customerId!);
      return createOrder(c, a, m!, b, 'api');
    });
    res.status(r.duplicate ? 200 : 201);
    return { ...forStore(r, APP_URL()), duplicate: r.duplicate };
  }

  /** Orders changed since a time (for polling), newest last, up to 200. */
  @Get('orders')
  list(@Headers('x-api-key') key: string, @Query('since') since?: string) {
    const s = v.ts(since, 'since') ?? new Date(Date.now() - 86_400_000);
    return this.run(key, async (c, a) => {
      const rows = (await c.query(`SELECT * FROM (${ORDER_SQL} WHERE eo.customer_id = $1) x WHERE x.updated_at > $2 ORDER BY x.updated_at LIMIT 200`, [a.customerId, s])).rows;
      return { data: rows.map((r) => forStore(withStatus(r), APP_URL())), next_since: rows.length ? rows[rows.length - 1].updated_at : s };
    });
  }

  @Get('orders/:ext')
  one(@Headers('x-api-key') key: string, @Param('ext') ext: string) {
    return this.run(key, async (c, a) => forStore(withStatus(await this.byExternal(c, a, ext)), APP_URL()));
  }

  @Post('orders/:ext/cancel')
  @HttpCode(200)
  cancel(@Headers('x-api-key') key: string, @Param('ext') ext: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { max: 300 }) ?? 'canceled by the store';
    return this.run(key, async (c, a) => forStore(await cancelOrder(c, a, (await this.byExternal(c, a, ext)).id, reason), APP_URL()));
  }

  @Post('orders/:ext/return')
  @HttpCode(200)
  ret(@Headers('x-api-key') key: string, @Param('ext') ext: string, @Body() b: Record<string, unknown>) {
    const reason = v.str(b?.reason, 'reason', { required: true, max: 300 })!;
    return this.run(key, async (c, a) => forStore(await requestReturn(c, a, (await this.byExternal(c, a, ext)).id, reason), APP_URL()));
  }
}
