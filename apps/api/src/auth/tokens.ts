import { UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** 'user' = identity proven by OTP, no company chosen yet. 'access' = acting inside one company. */
export type TokenType = 'user' | 'access';

export interface UserClaims { typ: 'user'; sub: string }
export interface AccessClaims { typ: 'access'; sub: string; tid: string }

export const ACCESS_TTL_SEC = 15 * 60;   // [تخمين] قصير لأن الصلاحيات تُقرأ من القاعدة مع كل طلب
export const USER_TTL_SEC = 10 * 60;

export function jwtSecret(): string {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
  return s;
}

export function sign(claims: Record<string, unknown>, ttlSec: number, secret = jwtSecret(), nowSec = Math.floor(Date.now() / 1000)): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ ...claims, iat: nowSec, exp: nowSec + ttlSec })).toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

function verifyRaw(token: string, secret: string, nowSec: number): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException();
  const [h, p, sig] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedException();
  }
  if (header.alg !== 'HS256') throw new UnauthorizedException();
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException();
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new UnauthorizedException();
  return claims;
}

export function verifyUserToken(token: string, secret = jwtSecret(), nowSec = Math.floor(Date.now() / 1000)): UserClaims {
  const c = verifyRaw(token, secret, nowSec);
  if (c.typ !== 'user' || !isUuid(c.sub)) throw new UnauthorizedException();
  return { typ: 'user', sub: c.sub };
}

export function verifyAccessToken(token: string, secret = jwtSecret(), nowSec = Math.floor(Date.now() / 1000)): AccessClaims {
  const c = verifyRaw(token, secret, nowSec);
  if (c.typ !== 'access' || !isUuid(c.sub) || !isUuid(c.tid)) throw new UnauthorizedException();
  return { typ: 'access', sub: c.sub, tid: c.tid };
}

export function bearer(req: { headers: Record<string, string | string[] | undefined> }): string {
  const h = req.headers['authorization'];
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) throw new UnauthorizedException();
  return h.slice(7);
}
