import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { normalizePhone } from '../common/phone';
import { pgToHttp, v } from '../common/validate';

const COLS = `id, legal_entity_id, ref, kind, name, phone, email, cr_number, payment_terms_days, credit_limit, status, notes, created_at`;
const SITE_COLS = `id, customer_id, name, address, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, contact_name, contact_phone, notes, active`;
export const CUSTOMER_STATUSES = ['active', 'on_hold', 'closed'] as const;

function phoneOf(val: unknown, field: string): string | null | undefined {
  if (val === undefined) return undefined;
  if (val === null || val === '') return null;
  const p = normalizePhone(val);
  if (!p) throw new BadRequestException(`invalid ${field}`);
  return p;
}
function money(val: unknown, field: string): string | null | undefined {
  if (val === undefined) return undefined;
  if (val === null) return null;
  const s = typeof val === 'number' ? String(val) : val;
  if (typeof s !== 'string' || !/^\d{1,15}(\.\d{1,3})?$/.test(s)) throw new BadRequestException(`${field} must be an amount with up to 3 decimals`);
  return s;
}
function coords(b: Record<string, unknown>): { lat: number; lng: number } | null | undefined {
  if (b.lat === undefined && b.lng === undefined) return undefined;
  if (b.lat === null && b.lng === null) return null;
  const lat = b.lat, lng = b.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new BadRequestException('lat/lng invalid');
  return { lat, lng };
}

/** Customers and their sites (branches, warehouses, construction sites). */
@Controller('v1')
@UseGuards(AuthGuard)
export class CustomersController {
  constructor(private readonly db: DbService) {}

  @Get('customers')
  @Perm('customers:read')
  list(@Auth() a: AuthContext, @Query('q') q?: string, @Query('status') status?: string) {
    const st = v.oneOf(status, 'status', CUSTOMER_STATUSES);
    const term = v.str(q, 'q', { max: 100 });
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT ${COLS} FROM crm.customer
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%' OR ref = $2)
          ORDER BY name LIMIT 500`, [st, term && term.replace(/[%_\\]/g, (m) => `\\${m}`)])).rows,
    }));
  }

  @Get('customers/:id')
  @Perm('customers:read')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.db.withTenant(a, async (c) => {
      const cu = (await c.query(`SELECT ${COLS} FROM crm.customer WHERE id = $1`, [id])).rows[0];
      if (!cu) return null;
      cu.sites = (await c.query(`SELECT ${SITE_COLS} FROM crm.site WHERE customer_id = $1 ORDER BY name`, [id])).rows;
      cu.active_contract = (await c.query(
        `SELECT id, code, starts_on::text, ends_on::text, currency, payment_terms_days FROM crm.contract
          WHERE customer_id = $1 AND status = 'active' AND starts_on <= current_date AND (ends_on IS NULL OR ends_on >= current_date)`, [id])).rows[0] ?? null;
      return cu;
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post('customers')
  @Perm('customers:write')
  create(@Auth() a: AuthContext, @Body() b: Record<string, unknown>) {
    const f = {
      le: v.uuid(b?.legal_entity_id, 'legal_entity_id', { required: true }),
      name: v.str(b?.name, 'name', { required: true, max: 200 }),
      kind: v.oneOf(b?.kind, 'kind', ['business', 'individual'] as const) ?? 'business',
      ref: v.str(b?.ref, 'ref', { max: 40 }),
      phone: phoneOf(b?.phone, 'phone') ?? null,
      email: v.str(b?.email, 'email', { max: 200 }),
      cr: v.str(b?.cr_number, 'cr_number', { max: 40 }),
      terms: v.int(b?.payment_terms_days, 'payment_terms_days', 0, 365) ?? 0,
      limit: money(b?.credit_limit, 'credit_limit') ?? null,
      notes: v.str(b?.notes, 'notes', { max: 2000 }),
    };
    return this.db.withTenant(a, async (c) => {
      const id = randomUUID();
      try {
        const r = await c.query(
          `INSERT INTO crm.customer (id, tenant_id, legal_entity_id, ref, kind, name, phone, email, cr_number, payment_terms_days, credit_limit, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLS}`,
          [id, a.tenantId, f.le, f.ref, f.kind, f.name, f.phone, f.email, f.cr, f.terms, f.limit, f.notes]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'customer.created', targetType: 'customer', targetId: id, after: r.rows[0] });
        return r.rows[0];
      } catch (e) { return pgToHttp(e); }
    });
  }

  @Patch('customers/:id')
  @Perm('customers:write')
  update(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const f = {
      name: v.str(b?.name, 'name', { max: 200 }),
      phone: phoneOf(b?.phone, 'phone'),
      email: v.str(b?.email, 'email', { max: 200 }),
      terms: v.int(b?.payment_terms_days, 'payment_terms_days', 0, 365),
      limit: money(b?.credit_limit, 'credit_limit'),
      status: v.oneOf(b?.status, 'status', CUSTOMER_STATUSES),
      notes: v.str(b?.notes, 'notes', { max: 2000 }),
    };
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query(`SELECT ${COLS} FROM crm.customer WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException();
      try {
        const r = await c.query(
          `UPDATE crm.customer SET name = COALESCE($2, name), phone = CASE WHEN $3 THEN $4 ELSE phone END, email = COALESCE($5, email),
             payment_terms_days = COALESCE($6, payment_terms_days), credit_limit = CASE WHEN $7 THEN $8::numeric ELSE credit_limit END,
             status = COALESCE($9, status), notes = COALESCE($10, notes)
           WHERE id = $1 RETURNING ${COLS}`,
          [id, f.name, f.phone !== undefined, f.phone ?? null, f.email, f.terms, f.limit !== undefined, f.limit ?? null, f.status, f.notes]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'customer.updated', targetType: 'customer', targetId: id, before, after: r.rows[0] });
        return r.rows[0];
      } catch (e) { return pgToHttp(e); }
    });
  }

  @Post('customers/:id/sites')
  @Perm('customers:write')
  addSite(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { required: true, max: 200 });
    const address = v.str(b?.address, 'address', { max: 500 });
    const pos = coords(b ?? {}) ?? null;
    const contact = v.str(b?.contact_name, 'contact_name', { max: 120 });
    const cphone = phoneOf(b?.contact_phone, 'contact_phone') ?? null;
    const notes = v.str(b?.notes, 'notes', { max: 1000 });
    return this.db.withTenant(a, async (c) => {
      if (!(await c.query('SELECT 1 FROM crm.customer WHERE id = $1', [id])).rowCount) throw new NotFoundException();
      const sid = randomUUID();
      await c.query(
        `INSERT INTO crm.site (id, tenant_id, customer_id, name, address, location, contact_name, contact_phone, notes)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography END, $8,$9,$10)`,
        [sid, a.tenantId, id, name, address, pos?.lat ?? null, pos?.lng ?? null, contact, cphone, notes]);
      return (await c.query(`SELECT ${SITE_COLS} FROM crm.site WHERE id = $1`, [sid])).rows[0];
    });
  }

  @Patch('sites/:id')
  @Perm('customers:write')
  updateSite(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: Record<string, unknown>) {
    const name = v.str(b?.name, 'name', { max: 200 });
    const address = v.str(b?.address, 'address', { max: 500 });
    const pos = coords(b ?? {});
    const active = b?.active === undefined ? null : b.active === true;
    if (b?.active !== undefined && typeof b.active !== 'boolean') throw new BadRequestException('active must be true or false');
    return this.db.withTenant(a, async (c) => {
      const r = await c.query(
        `UPDATE crm.site SET name = COALESCE($2, name), address = COALESCE($3, address), active = COALESCE($4, active),
           location = CASE WHEN $5 THEN (CASE WHEN $6::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography END) ELSE location END
         WHERE id = $1 AND EXISTS (SELECT 1 FROM crm.customer cu WHERE cu.id = crm.site.customer_id) -- the customer must be in the caller's scope
         RETURNING id`, [id, name, address, active, pos !== undefined, pos?.lat ?? null, pos?.lng ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      return (await c.query(`SELECT ${SITE_COLS} FROM crm.site WHERE id = $1`, [id])).rows[0];
    });
  }
}
