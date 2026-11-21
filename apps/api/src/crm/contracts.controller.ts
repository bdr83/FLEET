import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { pgToHttp, v } from '../common/validate';
import { priceTask, Unit, UNITS } from './pricing';

const COLS = `k.id, k.legal_entity_id, k.customer_id, cu.name AS customer_name, k.code, k.starts_on::text, k.ends_on::text, k.status,
  k.currency, k.payment_terms_days, k.notes, k.created_at`;
const FROM = `crm.contract k JOIN crm.customer cu ON cu.id = k.customer_id`;
const RATE_COLS = `id, sector_pack, unit, price::text, included_qty::float, min_charge::text, description`;

function rateInput(r: Record<string, unknown>, i: number) {
  if (!r || typeof r !== 'object') throw new BadRequestException(`rates[${i}] invalid`);
  const amt = (val: unknown, f: string) => {
    if (val === undefined || val === null) return '0';
    const s = typeof val === 'number' ? String(val) : val;
    if (typeof s !== 'string' || !/^\d{1,15}(\.\d{1,3})?$/.test(s)) throw new BadRequestException(`rates[${i}].${f} must be an amount with up to 3 decimals`);
    return s;
  };
  const pack = v.str(r.sector_pack, `rates[${i}].sector_pack`, { max: 40 });
  if (pack && !/^[a-z][a-z0-9_]*@[0-9]+$/.test(pack)) throw new BadRequestException(`rates[${i}].sector_pack invalid`);
  if (r.price === undefined) throw new BadRequestException(`rates[${i}].price required`);
  return {
    sector_pack: pack,
    unit: v.oneOf(r.unit, `rates[${i}].unit`, UNITS, { required: true })!,
    price: amt(r.price, 'price'),
    included_qty: amt(r.included_qty, 'included_qty'),
    min_charge: amt(r.min_charge, 'min_charge'),
    description: v.str(r.description, `rates[${i}].description`, { max: 200 }),
  };
}

/**
 * Contracts and their price list. A contract is prepared as a draft, then activated;
 * an active contract's prices are frozen (to change prices, end it and activate a new one),
 * so an invoice can always be traced to the prices agreed at the time.
 */
@Controller('v1/contracts')
@UseGuards(AuthGuard)
export class ContractsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Perm('customers:read')
  list(@Auth() a: AuthContext, @Query('customer_id') customer?: string, @Query('status') status?: string) {
    const cu = v.uuid(customer, 'customer_id');
    const st = v.oneOf(status, 'status', ['draft', 'active', 'suspended', 'ended'] as const);
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${COLS} FROM ${FROM} WHERE ($1::uuid IS NULL OR k.customer_id = $1) AND ($2::text IS NULL OR k.status = $2)
          ORDER BY k.starts_on DESC LIMIT 500`, [cu, st])).rows,
    }));
  }

  @Get(':id')
  @Perm('customers:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(a, (c) => this.load(c, id));
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post()
  @Perm('customers:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const customerId = v.uuid(b?.customer_id, 'customer_id', { required: true });
    const code = v.str(b?.code, 'code', { max: 40 });
    const starts = v.date(b?.starts_on, 'starts_on') ?? (() => { throw new BadRequestException('starts_on required'); })();
    const ends = v.date(b?.ends_on, 'ends_on');
    if (ends && ends < starts) throw new BadRequestException('ends_on is before starts_on');
    const terms = v.int(b?.payment_terms_days, 'payment_terms_days', 0, 365);
    const notes = v.str(b?.notes, 'notes', { max: 2000 });
    const rates = b?.rates === undefined ? [] : Array.isArray(b.rates) && b.rates.length <= 100 ? b.rates.map(rateInput) : (() => { throw new BadRequestException('rates must be a list of up to 100'); })();
    return this.db.withTenant(a, async (c) => {
      const cu = (await c.query(
        `SELECT cu.legal_entity_id, cu.payment_terms_days, le.currency FROM crm.customer cu JOIN org.legal_entity le ON le.id = cu.legal_entity_id WHERE cu.id = $1`,
        [customerId])).rows[0];
      if (!cu) throw new BadRequestException('unknown customer_id');
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO crm.contract (id, tenant_id, legal_entity_id, customer_id, code, starts_on, ends_on, currency, payment_terms_days, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, a.tenantId, cu.legal_entity_id, customerId, code ?? `C-${id.slice(0, 8).toUpperCase()}`, starts, ends, cu.currency, terms ?? cu.payment_terms_days, notes]);
        for (const r of rates) await this.insertRate(c, a, id, r);
      } catch (e) { return pgToHttp(e); }
      const row = await this.load(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'contract.created', targetType: 'contract', targetId: id, after: row });
      return row;
    });
  }

  @Patch(':id')
  @Perm('customers:write')
  update(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const ends = v.date(b?.ends_on, 'ends_on');
    const notes = v.str(b?.notes, 'notes', { max: 2000 });
    const terms = v.int(b?.payment_terms_days, 'payment_terms_days', 0, 365);
    return this.db.withTenant(a, async (c) => {
      const k = await this.lock(c, id);
      if (terms !== null && k.status !== 'draft') throw new ConflictException('payment terms are frozen once the contract is active');
      try {
        await c.query(`UPDATE crm.contract SET ends_on = COALESCE($2, ends_on), notes = COALESCE($3, notes), payment_terms_days = COALESCE($4, payment_terms_days) WHERE id = $1`,
          [id, ends, notes, terms]);
      } catch (e) { return this.conflict(e); }
      const row = await this.load(c, id);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'contract.updated', targetType: 'contract', targetId: id, before: k, after: row });
      return row;
    });
  }

  @Post(':id/rates')
  @Perm('customers:write')
  addRate(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const r = rateInput(b ?? {}, 0);
    return this.db.withTenant(a, async (c) => {
      const k = await this.lock(c, id);
      if (k.status !== 'draft') throw new ConflictException('prices of an active contract cannot change');
      try { await this.insertRate(c, a, id, r); } catch (e) { return pgToHttp(e); }
      return this.load(c, id);
    });
  }

  @Delete(':id/rates/:rateId')
  @HttpCode(204)
  @Perm('customers:write')
  async removeRate(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('rateId', new ParseUUIDPipe()) rateId: string) {
    await this.db.withTenant(a, async (c) => {
      const k = await this.lock(c, id);
      if (k.status !== 'draft') throw new ConflictException('prices of an active contract cannot change');
      if (!(await c.query('DELETE FROM crm.rate WHERE id = $1 AND contract_id = $2', [rateId, id])).rowCount) throw new NotFoundException();
    });
  }

  /** draft → active (no overlap with another active contract of the customer), active ⇄ suspended, → ended. */
  @Post(':id/activate') @HttpCode(200) @Perm('customers:write')
  activate(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) { return this.transition(a, id, 'activate'); }
  @Post(':id/suspend') @HttpCode(200) @Perm('customers:write')
  suspend(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) { return this.transition(a, id, 'suspend'); }
  @Post(':id/resume') @HttpCode(200) @Perm('customers:write')
  resume(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) { return this.transition(a, id, 'resume'); }
  @Post(':id/end') @HttpCode(200) @Perm('customers:write')
  end(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) { return this.transition(a, id, 'end'); }

  private transition(a: AuthContext, id: string, action: 'activate' | 'suspend' | 'resume' | 'end') {
    const flow: Record<string, [string[], string]> = {
      activate: [['draft'], 'active'], suspend: [['active'], 'suspended'], resume: [['suspended'], 'active'], end: [['active', 'suspended'], 'ended'],
    };
    const [from, to] = flow[action];
    return this.db.withTenant(a, async (c) => {
      const k = await this.lock(c, id);
      if (!from.includes(k.status)) throw new ConflictException(`cannot ${action} a contract that is ${k.status}`);
      if (action === 'activate' && !(await c.query('SELECT 1 FROM crm.rate WHERE contract_id = $1', [id])).rowCount) {
        throw new ConflictException('add at least one price before activating');
      }
      try {
        await c.query(
          `UPDATE crm.contract SET status = $2, ends_on = CASE WHEN $3 AND (ends_on IS NULL OR ends_on > current_date) THEN GREATEST(current_date, starts_on) ELSE ends_on END WHERE id = $1`,
          [id, to, action === 'end']);
      } catch (e) { return this.conflict(e); }
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: `contract.${action}`, targetType: 'contract', targetId: id });
      return this.load(c, id);
    });
  }

  /** Price preview: what a task of this type with these quantities would cost under the contract. */
  @Post(':id/quote')
  @HttpCode(200)
  @Perm('customers:read')
  quote(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const pack = v.str(b?.sector_pack, 'sector_pack', { required: true, max: 40 })!;
    const qty = (v.obj(b?.quantities, 'quantities') ?? { task: 1 }) as Partial<Record<Unit, number>>;
    for (const [k, n] of Object.entries(qty)) {
      if (!(UNITS as readonly string[]).includes(k)) throw new BadRequestException(`unknown unit ${k}`);
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e6) throw new BadRequestException(`quantity for ${k} invalid`);
    }
    return this.db.withTenant(a, async (c) => {
      const k = await this.load(c, id);
      if (!k) throw new NotFoundException();
      return { contract_id: id, currency: k.currency, ...priceTask(k.rates, pack, qty) };
    });
  }

  private async load(c: PoolClient, id: string) {
    const k = (await c.query(`SELECT ${COLS} FROM ${FROM} WHERE k.id = $1`, [id])).rows[0];
    if (!k) return null;
    k.rates = (await c.query(`SELECT ${RATE_COLS} FROM crm.rate WHERE contract_id = $1 ORDER BY sector_pack NULLS FIRST, unit`, [id])).rows;
    return k;
  }

  private async lock(c: PoolClient, id: string) {
    const k = (await c.query('SELECT k.id, k.status, k.ends_on::text FROM crm.contract k WHERE k.id = $1 FOR UPDATE', [id])).rows[0];
    if (!k) throw new NotFoundException();
    return k;
  }

  private insertRate(c: PoolClient, a: AuthContext, contractId: string, r: ReturnType<typeof rateInput>) {
    return c.query(
      `INSERT INTO crm.rate (id, tenant_id, contract_id, sector_pack, unit, price, included_qty, min_charge, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), a.tenantId, contractId, r.sector_pack, r.unit, r.price, r.included_qty, r.min_charge, r.description]);
  }

  private conflict(e: unknown): never {
    if ((e as { constraint?: string }).constraint === 'one_active_contract') throw new ConflictException('the customer already has an active contract in these dates');
    return pgToHttp(e);
  }
}
