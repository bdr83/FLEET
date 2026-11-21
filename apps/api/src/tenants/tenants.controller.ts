import { BadRequestException, Body, Controller, Get, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { audit } from '../common/audit';
import { SessionService } from '../auth/session.service';
import { bearer, verifyUserToken } from '../auth/tokens';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';

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
    @Body() body: { name?: string; legal_entity_name?: string; cr_number?: string; country?: string },
    @Headers('user-agent') ua?: string,
  ) {
    const u = verifyUserToken(bearer(req));
    const name = body?.name?.trim();
    if (!name || name.length > 120) throw new BadRequestException('name required (max 120)');
    const country = (body?.country ?? 'KW').toUpperCase();
    if (!['KW', 'SA', 'AE', 'QA', 'BH', 'OM'].includes(country)) throw new BadRequestException('unsupported country');
    const currency = { KW: 'KWD', SA: 'SAR', AE: 'AED', QA: 'QAR', BH: 'BHD', OM: 'OMR' }[country];
    const tz = { KW: 'Asia/Kuwait', SA: 'Asia/Riyadh', AE: 'Asia/Dubai', QA: 'Asia/Qatar', BH: 'Asia/Bahrain', OM: 'Asia/Muscat' }[country];
    const tenantId = randomUUID();
    const leId = randomUUID();
    return this.db.withTenant({ tenantId, entityIds: [] }, async (c) => {
      await c.query(`INSERT INTO org.tenant (id, name, status) VALUES ($1, $2, 'trial')`, [tenantId, name]);
      await c.query(
        `INSERT INTO org.legal_entity (id, tenant_id, name, country, currency, timezone, cr_number) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [leId, tenantId, body.legal_entity_name?.trim() || name, country, currency, tz, body.cr_number ?? null]);
      const mId = randomUUID();
      await c.query(`INSERT INTO org.membership (id, tenant_id, user_id, role_id) VALUES ($1,$2,$3,$4)`, [mId, tenantId, u.sub, OWNER_ROLE]);
      await audit(c, { tenantId, actorId: u.sub, action: 'tenant.created', targetType: 'tenant', targetId: tenantId, after: { name, country } });
      const tokens = await this.sessions.issue(c, tenantId, u.sub, ua);
      return { tenant: { id: tenantId, name, status: 'trial' }, legal_entity_id: leId, ...tokens };
    });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @Perm('org:read')
  me(@Auth() a: AuthContext) {
    return { user_id: a.userId, tenant_id: a.tenantId, role: a.roleCode, permissions: a.permissions,
             scope: { legal_entity_ids: a.entityIds, branch_ids: a.branchIds } };
  }
}
