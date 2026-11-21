import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DbService, TenantContext } from '../db/db.service';
import { hasPermission, Permission } from '../common/permissions';
import { bearer, verifyAccessToken } from './tokens';

export interface AuthContext extends TenantContext {
  userId: string;
  membershipId: string;
  roleCode: string;
  permissions: string[];
  branchIds: string[];
}

export const PERM_KEY = 'required_permission';
/** Declares the permission an endpoint needs. Every route behind AuthGuard must declare one. */
export const Perm = (p: Permission) => SetMetadata(PERM_KEY, p);

/**
 * Verifies the access token, then loads the caller's membership, role and scope
 * from the database inside the tenant context on every request. A revoked or
 * expired membership, or a changed role, takes effect on the next request (QA 2.4, 2.8).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly db: DbService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const claims = verifyAccessToken(bearer(req));
    const needed = this.reflector.getAllAndOverride<Permission | undefined>(PERM_KEY, [context.getHandler(), context.getClass()]);
    if (!needed) throw new Error(`route ${req.method} ${req.url} has no @Perm()`);

    const row = await this.db.withTenant({ tenantId: claims.tid, entityIds: [] }, async (c) => {
      const r = await c.query(
        `SELECT m.id, r.code, r.permissions, m.scope_legal_entity_ids, m.scope_branch_ids, t.status
           FROM org.membership m
           JOIN org.role r ON r.id = m.role_id
           JOIN org.tenant t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.revoked_at IS NULL
            AND (m.valid_until IS NULL OR m.valid_until > now())`,
        [claims.sub],
      );
      return r.rows[0];
    });
    if (!row || !['trial', 'active', 'past_due'].includes(row.status)) throw new UnauthorizedException();
    if (!hasPermission(row.permissions, needed)) throw new ForbiddenException();

    const ctx: AuthContext = {
      tenantId: claims.tid,
      userId: claims.sub,
      membershipId: row.id,
      roleCode: row.code,
      permissions: row.permissions,
      entityIds: row.scope_legal_entity_ids ?? [],
      branchIds: row.scope_branch_ids ?? [],
    };
    req.auth = ctx;
    return true;
  }
}
