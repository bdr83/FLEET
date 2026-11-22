import { BadRequestException, Body, Controller, Get, Headers, Post, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { SessionService } from '../auth/session.service';
import { bearer, verifyUserToken } from '../auth/tokens';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { PACKS, parsePacks } from '../common/packs';

const OWNER_ROLE = '00000000-0000-4000-8000-000000000001';

@Controller('v1')
export class TenantsController {
  constructor(private readonly db: DbService, private readonly sessions: SessionService) {}

  /**
   * Self-service onboarding: a verified user creates a company (trial), its first legal
   * entity and their own owner membership, all in one transaction under the new tenant id.
   */
  @Post('tenants')
  async create(
    @Req() req: never,
    @Body() body: { name?: string; legal_entity_name?: string; cr_number?: string; country?: string; packs?: unknown },
    @Headers('user-agent') ua?: string,
  ) {
    const u = verifyUserToken(bearer(req));
    const name = body?.name?.trim();
    if (!name || name.length > 120) throw new BadRequestException('name required (max 120)');
    const country = (body?.country ?? 'KW').toUpperCase();
    if (!['KW', 'SA', 'AE', 'QA', 'BH', 'OM'].includes(country)) throw new BadRequestException('unsupported country');
    const currency = { KW: 'KWD', SA: 'SAR', AE: 'AED', QA: 'QAR', BH: 'BHD', OM: 'OMR' }[country];
    const tz = { KW: 'Asia/Kuwait', SA: 'Asia/Riyadh', AE: 'Asia/Dubai', QA: 'Asia/Qatar', BH: 'Asia/Bahrain', OM: 'Asia/Muscat' }[country];
    const packs = body?.packs === undefined ? PACKS.map((p) => p.code as string) : parsePacks(body.packs);
    if (!packs) throw new BadRequestException(`packs must be a list of: ${PACKS.map((p) => p.code).join(', ')}`);
    const tenantId = randomUUID();
    const leId = randomUUID();
    return this.db.withTenant({ tenantId, entityIds: [] }, async (c) => {
      await c.query(`INSERT INTO org.tenant (id, name, status, packs) VALUES ($1, $2, 'trial', $3)`, [tenantId, name, packs]);
      await c.query(
        `INSERT INTO org.legal_entity (id, tenant_id, name, country, currency, timezone, cr_number) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [leId, tenantId, body.legal_entity_name?.trim() || name, country, currency, tz, body.cr_number ?? null]);
      const mId = randomUUID();
      await c.query(`INSERT INTO org.membership (id, tenant_id, user_id, role_id) VALUES ($1,$2,$3,$4)`, [mId, tenantId, u.sub, OWNER_ROLE]);
      await audit(c, { tenantId, actorId: u.sub, action: 'tenant.created', targetType: 'tenant', targetId: tenantId, after: { name, country, packs } });
      const tokens = await this.sessions.issue(c, tenantId, u.sub, ua);
      return { tenant: { id: tenantId, name, status: 'trial' }, legal_entity_id: leId, ...tokens };
    });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @Perm('org:read')
  me(@Auth() a: AuthContext) {
    return this.db.withTenant(a, async (c) => {
      const t = (await c.query('SELECT name, status, packs FROM org.tenant WHERE id = $1', [a.tenantId])).rows[0];
      const u = (await c.query('SELECT phone, email, display_name FROM org.app_user WHERE id = $1', [a.userId])).rows[0];
      const entities = (await c.query(
        `SELECT id, name, country, currency, timezone FROM org.legal_entity WHERE cardinality($1::uuid[]) = 0 OR id = ANY($1::uuid[]) ORDER BY name`,
        [a.entityIds])).rows;
      return { user_id: a.userId, phone: u?.phone ?? null, email: u?.email ?? null, display_name: u?.display_name ?? null,
               tenant_id: a.tenantId, tenant_name: t?.name ?? null, tenant_status: t?.status ?? null, packs: t?.packs ?? [],
               role: a.roleCode, permissions: a.permissions,
               scope: { legal_entity_ids: a.entityIds, branch_ids: a.branchIds }, legal_entities: entities };
    });
  }

  /** The sector packs on offer and the ones this company has turned on. */
  @Get('packs')
  @UseGuards(AuthGuard)
  @Perm('org:read')
  packs(@Auth() a: AuthContext) {
    return { available: PACKS, enabled: a.packs };
  }

  /** Turns packs on or off. Existing tasks of a pack stay readable in the core screens; new ones are refused. */
  @Put('packs')
  @UseGuards(AuthGuard)
  @Perm('org:write')
  setPacks(@Auth() a: AuthContext, @Body() body: { packs?: unknown }) {
    const packs = parsePacks(body?.packs);
    if (!packs) throw new BadRequestException(`packs must be a list of: ${PACKS.map((p) => p.code).join(', ')}`);
    return this.db.withTenant(a, async (c) => {
      await c.query('UPDATE org.tenant SET packs = $2 WHERE id = $1', [a.tenantId, packs]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'tenant.packs_changed', targetType: 'tenant', targetId: a.tenantId,
                       before: { packs: a.packs }, after: { packs } });
      return { available: PACKS, enabled: packs };
    });
  }
}
