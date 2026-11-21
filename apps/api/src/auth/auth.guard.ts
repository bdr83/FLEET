import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { TenantContext } from '../db/db.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthContext extends TenantContext {
  userId: string;
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * P0 placeholder: verifies an HS256 access token issued by the identity module (P1).
 * The tenant comes only from the signed token, never from the URL, body or a header,
 * so a caller cannot ask for another company's data by changing a parameter.
 */
export function verifyAccessToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): AuthContext {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException();
  const [h, p, sig] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    throw new UnauthorizedException();
  }
  if (header.alg !== 'HS256') throw new UnauthorizedException();
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException();
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new UnauthorizedException();
  const tid = claims.tid;
  const sub = claims.sub;
  const ents = claims.ents ?? [];
  if (typeof tid !== 'string' || !UUID.test(tid)) throw new UnauthorizedException();
  if (typeof sub !== 'string' || !UUID.test(sub)) throw new UnauthorizedException();
  if (!Array.isArray(ents) || !ents.every((e) => typeof e === 'string' && UUID.test(e))) throw new UnauthorizedException();
  return { tenantId: tid, userId: sub, entityIds: ents as string[] };
}

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    req.auth = verifyAccessToken(header.slice(7), secret);
    return true;
  }
}
