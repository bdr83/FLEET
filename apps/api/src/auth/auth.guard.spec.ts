import { UnauthorizedException } from '@nestjs/common';
import { verifyAccessToken } from './auth.guard';
import { signToken } from '../../test/token';

const SECRET = 'x'.repeat(32);
const T = 'aaaaaaaa-0000-0000-0000-000000000001';
const U = 'aaaaaaaa-0000-0000-0000-0000000000c1';
const exp = Math.floor(Date.now() / 1000) + 600;

describe('verifyAccessToken', () => {
  it('accepts a valid token and takes the tenant from it', () => {
    const ctx = verifyAccessToken(signToken({ tid: T, sub: U, exp }, SECRET), SECRET);
    expect(ctx).toEqual({ tenantId: T, userId: U, entityIds: [] });
  });
  it('rejects a wrong signature', () => {
    expect(() => verifyAccessToken(signToken({ tid: T, sub: U, exp }, 'y'.repeat(32)), SECRET)).toThrow(UnauthorizedException);
  });
  it('rejects alg none / other algorithms', () => {
    expect(() => verifyAccessToken(signToken({ tid: T, sub: U, exp }, SECRET, 'none'), SECRET)).toThrow(UnauthorizedException);
  });
  it('rejects an expired token', () => {
    expect(() => verifyAccessToken(signToken({ tid: T, sub: U, exp: 1 }, SECRET), SECRET)).toThrow(UnauthorizedException);
  });
  it('rejects a tenant id that is not a uuid (no SQL reaches the database)', () => {
    expect(() => verifyAccessToken(signToken({ tid: "x' OR 1=1", sub: U, exp }, SECRET), SECRET)).toThrow(UnauthorizedException);
  });
  it('rejects malformed entity scopes', () => {
    expect(() => verifyAccessToken(signToken({ tid: T, sub: U, exp, ents: ['nope'] }, SECRET), SECRET)).toThrow(UnauthorizedException);
  });
});
