import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { sign, verifyAccessToken, verifyUserToken } from './tokens';

const S = 'x'.repeat(32);
const T = 'aaaaaaaa-0000-0000-0000-000000000001';
const U = 'aaaaaaaa-0000-0000-0000-0000000000c1';

function forge(header: object, claims: object, secret = S) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

describe('tokens', () => {
  it('round-trips an access token', () => {
    expect(verifyAccessToken(sign({ typ: 'access', sub: U, tid: T }, 60, S), S)).toEqual({ typ: 'access', sub: U, tid: T });
  });
  it('a user token is not an access token, and the reverse', () => {
    expect(() => verifyAccessToken(sign({ typ: 'user', sub: U }, 60, S), S)).toThrow(UnauthorizedException);
    expect(() => verifyUserToken(sign({ typ: 'access', sub: U, tid: T }, 60, S), S)).toThrow(UnauthorizedException);
  });
  it('rejects a wrong secret', () => {
    expect(() => verifyAccessToken(sign({ typ: 'access', sub: U, tid: T }, 60, 'y'.repeat(32)), S)).toThrow(UnauthorizedException);
  });
  it('rejects alg none', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(() => verifyAccessToken(forge({ alg: 'none' }, { typ: 'access', sub: U, tid: T, exp }), S)).toThrow(UnauthorizedException);
  });
  it('rejects an expired token', () => {
    expect(() => verifyAccessToken(sign({ typ: 'access', sub: U, tid: T }, -1, S), S)).toThrow(UnauthorizedException);
  });
  it('rejects a tenant id that is not a uuid', () => {
    expect(() => verifyAccessToken(sign({ typ: 'access', sub: U, tid: "x' OR 1=1" }, 60, S), S)).toThrow(UnauthorizedException);
  });
});
