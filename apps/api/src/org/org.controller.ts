import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { isUuid } from '../auth/tokens';

const COUNTRIES: Record<string, { currency: string; tz: string }> = {
  KW: { currency: 'KWD', tz: 'Asia/Kuwait' }, SA: { currency: 'SAR', tz: 'Asia/Riyadh' }, AE: { currency: 'AED', tz: 'Asia/Dubai' },
  QA: { currency: 'QAR', tz: 'Asia/Qatar' }, BH: { currency: 'BHD', tz: 'Asia/Bahrain' }, OM: { currency: 'OMR', tz: 'Asia/Muscat' },
};

/** Legal entities and branches. Members with a scope only see what their scope allows. */
@Controller('v1')
@UseGuards(AuthGuard)
export class OrgController {
  constructor(private readonly db: DbService) {}

  @Get('legal-entities')
  @Perm('org:read')
  listEntities(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT id, name, country, currency, timezone, cr_number, tax_rate::float, tax_number, invoice_prefix FROM org.legal_entity
          WHERE cardinality($1::uuid[]) = 0 OR id = ANY($1::uuid[]) ORDER BY name`, [a.entityIds])).rows,
    }));
  }

  @Post('legal-entities')
  @Perm('org:write')
  async createEntity(@Auth() a: AuthContext, @Body() b: { name?: string; country?: string; cr_number?: string }) {
    const name = b?.name?.trim();
    const country = (b?.country ?? 'KW').toUpperCase();
    if (!name) throw new BadRequestException('name required');
    if (!COUNTRIES[country]) throw new BadRequestException('unsupported country');
    if (a.entityIds.length) throw new BadRequestException('scoped members cannot create legal entities');
    return this.db.withTenant(a, async (c) => {
      const id = randomUUID();
      const r = await c.query(
        `INSERT INTO org.legal_entity (id, tenant_id, name, country, currency, timezone, cr_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, country, currency, timezone, cr_number`,
        [id, a.tenantId, name, country, COUNTRIES[country].currency, COUNTRIES[country].tz, b.cr_number ?? null]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'legal_entity.created', targetType: 'legal_entity', targetId: id, after: r.rows[0] });
      return r.rows[0];
    });
  }

  @Get('branches')
  @Perm('org:read')
  listBranches(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query(
        `SELECT id, legal_entity_id, name, active FROM org.branch
          WHERE (cardinality($1::uuid[]) = 0 OR legal_entity_id = ANY($1::uuid[]))
            AND (cardinality($2::uuid[]) = 0 OR id = ANY($2::uuid[]))
          ORDER BY name`, [a.entityIds, a.branchIds])).rows,
    }));
  }

  @Post('branches')
  @Perm('org:write')
  async createBranch(@Auth() a: AuthContext, @Body() b: { legal_entity_id?: string; name?: string }) {
    if (!isUuid(b?.legal_entity_id) || !b?.name?.trim()) throw new BadRequestException('legal_entity_id and name required');
    if (a.entityIds.length && !a.entityIds.includes(b.legal_entity_id!)) throw new NotFoundException();
    return this.db.withTenant(a, async (c) => {
      const id = randomUUID();
      try {
        const r = await c.query(
          `INSERT INTO org.branch (id, tenant_id, legal_entity_id, name) VALUES ($1,$2,$3,$4) RETURNING id, legal_entity_id, name, active`,
          [id, a.tenantId, b.legal_entity_id, b.name!.trim()]);
        await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'branch.created', targetType: 'branch', targetId: id, after: r.rows[0] });
        return r.rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23503') throw new BadRequestException('unknown legal_entity_id');
        throw e;
      }
    });
  }

  @Patch('branches/:id')
  @Perm('org:write')
  async updateBranch(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() b: { name?: string; active?: boolean }) {
    return this.db.withTenant(a, async (c) => {
      const before = (await c.query('SELECT id, legal_entity_id, name, active FROM org.branch WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before || (a.entityIds.length && !a.entityIds.includes(before.legal_entity_id))) throw new NotFoundException();
      const r = await c.query(
        `UPDATE org.branch SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1 RETURNING id, legal_entity_id, name, active`,
        [id, b?.name?.trim() || null, typeof b?.active === 'boolean' ? b.active : null]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'branch.updated', targetType: 'branch', targetId: id, before, after: r.rows[0] });
      return r.rows[0];
    });
  }

  @Get('audit-log')
  @Perm('members:read')
  auditLog(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => ({
      data: (await c.query('SELECT id, actor_type, actor_id, action, target_type, target_id, before, after, at FROM core.audit_log ORDER BY at DESC LIMIT 200')).rows,
    }));
  }
}
