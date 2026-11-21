import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { ACCESS_TTL_SEC, isUuid, sign } from './tokens';

const REFRESH_TTL_DAYS = 30; // [تخمين]
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface TokenPair { access_token: string; refresh_token: string; expires_in: number; tenant_id: string }

/**
 * Refresh tokens look like "<tenant_id>.<secret>". The tenant prefix lets us open the
 * right tenant context and find the session under RLS, with no cross-tenant lookup.
 * Tokens rotate on every use; presenting a used token revokes all of that user's
 * sessions in the tenant (stolen-token detection).
 */
@Injectable()
export class SessionService {
  constructor(private readonly db: DbService) {}

  /** Call inside a withTenant() transaction for tenantId. */
  async issue(c: PoolClient, tenantId: string, userId: string, userAgent?: string): Promise<TokenPair> {
    const raw = `${tenantId}.${randomBytes(32).toString('base64url')}`;
    await c.query(
      `INSERT INTO org.session (id, tenant_id, user_id, token_hash, expires_at, user_agent)
       VALUES ($1,$2,$3,$4, now() + $5 * interval '1 day', $6)`,
      [randomUUID(), tenantId, userId, sha(raw), REFRESH_TTL_DAYS, userAgent?.slice(0, 200) ?? null]);
    return {
      access_token: sign({ typ: 'access', sub: userId, tid: tenantId }, ACCESS_TTL_SEC),
      refresh_token: raw,
      expires_in: ACCESS_TTL_SEC,
      tenant_id: tenantId,
    };
  }

  async refresh(raw: unknown, userAgent?: string): Promise<TokenPair> {
    if (typeof raw !== 'string') throw new UnauthorizedException();
    const tenantId = raw.split('.')[0];
    if (!isUuid(tenantId)) throw new UnauthorizedException();
    const result = await this.db.withTenant({ tenantId, entityIds: [] }, async (c) => {
      const r = await c.query(
        `SELECT s.id, s.user_id, s.revoked_at, s.expires_at > now() AS live,
                EXISTS (SELECT 1 FROM org.membership m WHERE m.user_id = s.user_id AND m.revoked_at IS NULL
                          AND (m.valid_until IS NULL OR m.valid_until > now())) AS member
           FROM org.session s WHERE s.token_hash = $1 FOR UPDATE`, [sha(raw)]);
      const s = r.rows[0];
      if (!s) return null;
      if (s.revoked_at) {
        await c.query('UPDATE org.session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [s.user_id]);
        return 'reuse' as const;
      }
      if (!s.live || !s.member) return null;
      const pair = await this.issue(c, tenantId, s.user_id, userAgent);
      await c.query('UPDATE org.session SET revoked_at = now() WHERE id = $1', [s.id]);
      return pair;
    });
    if (!result || result === 'reuse') throw new UnauthorizedException();
    return result;
  }

  async revoke(raw: unknown): Promise<void> {
    if (typeof raw !== 'string') return;
    const tenantId = raw.split('.')[0];
    if (!isUuid(tenantId)) return;
    await this.db.withTenant({ tenantId, entityIds: [] }, (c) =>
      c.query('UPDATE org.session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha(raw)]));
  }
}
