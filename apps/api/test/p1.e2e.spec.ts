/**
 * P1: identity, companies, roles and scopes. Case numbers refer to the Phase E QA plan.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { auth, createApp, hasDb, joinAs, login, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('P1 identity and permissions', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'شركة التوصيل السريع');
  });
  afterAll(async () => app?.close());

  describe('OTP login', () => {
    it('rejects an invalid phone', () => request(http).post('/v1/auth/otp/request').send({ phone: '123' }).expect(400));
    it('rejects a wrong code and locks after 5 tries', async () => {
      const phone = newPhone();
      const r = await request(http).post('/v1/auth/otp/request').send({ phone }).expect(202);
      const wrong = r.body.dev_code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await request(http).post('/v1/auth/otp/verify').send({ phone, code: wrong }).expect(401);
      // even the right code no longer works on this challenge
      await request(http).post('/v1/auth/otp/verify').send({ phone, code: r.body.dev_code }).expect(401);
    });
    it('a code works once', async () => {
      const phone = newPhone();
      const r = await request(http).post('/v1/auth/otp/request').send({ phone }).expect(202);
      await request(http).post('/v1/auth/otp/verify').send({ phone, code: r.body.dev_code }).expect(200);
      await request(http).post('/v1/auth/otp/verify').send({ phone, code: r.body.dev_code }).expect(401);
    });
    it('rate-limits resends (60 s cooldown, 5 per hour)', async () => {
      const saved = { c: process.env.OTP_RESEND_COOLDOWN_MS, m: process.env.OTP_MAX_PER_HOUR };
      try {
        delete process.env.OTP_RESEND_COOLDOWN_MS;
        const phone = newPhone();
        await request(http).post('/v1/auth/otp/request').send({ phone }).expect(202);
        await request(http).post('/v1/auth/otp/request').send({ phone }).expect(429);
        process.env.OTP_RESEND_COOLDOWN_MS = '0';
        delete process.env.OTP_MAX_PER_HOUR;
        const p2 = newPhone();
        for (let i = 0; i < 5; i++) await request(http).post('/v1/auth/otp/request').send({ phone: p2 }).expect(202);
        await request(http).post('/v1/auth/otp/request').send({ phone: p2 }).expect(429);
      } finally {
        process.env.OTP_RESEND_COOLDOWN_MS = saved.c;
        process.env.OTP_MAX_PER_HOUR = saved.m;
      }
    });
    it('a user token cannot call company APIs', async () => {
      const { user_token } = await login(app, newPhone());
      await request(http).get('/v1/me').set(auth(user_token)).expect(401);
    });
    it('cannot get a session in a company you do not belong to', async () => {
      const { user_token } = await login(app, newPhone());
      await request(http).post('/v1/auth/token').set(auth(user_token)).send({ tenant_id: A.tenant.id }).expect(403);
    });
  });

  describe('onboarding', () => {
    it('creator is owner with all permissions', async () => {
      const r = await request(http).get('/v1/me').set(auth(A.access_token)).expect(200);
      expect(r.body.role).toBe('owner');
      expect(r.body.permissions).toEqual(['*']);
    });
    it('the company appears in the user memberships after login', async () => {
      const r = await login(app, A.phone);
      expect(r.memberships.map((m) => m.tenant_id)).toContain(A.tenant.id);
    });
    it('records an audit entry', async () => {
      const r = await request(http).get('/v1/audit-log').set(auth(A.access_token)).expect(200);
      expect(r.body.data.some((e: { action: string }) => e.action === 'tenant.created')).toBe(true);
    });
  });

  describe('2.2 role matrix', () => {
    const cases: [string, string, string, number][] = [
      ['dispatcher', 'GET', '/v1/tasks', 200],
      ['dispatcher', 'GET', '/v1/members', 403],
      ['dispatcher', 'POST', '/v1/legal-entities', 403],
      ['accountant', 'POST', '/v1/tasks', 403],
      ['accountant', 'GET', '/v1/tasks', 200],
      ['driver', 'GET', '/v1/tasks', 403],
      ['driver', 'GET', '/v1/me', 403],
      ['admin', 'GET', '/v1/members', 200],
      ['customer', 'GET', '/v1/tasks', 403],
    ];
    const tokens: Record<string, string> = {};
    beforeAll(async () => {
      for (const role of ['dispatcher', 'accountant', 'driver', 'admin', 'customer']) {
        const phone = newPhone();
        await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone, role_code: role }).expect(201);
        tokens[role] = (await joinAs(app, A.tenant.id, phone)).access_token;
      }
    });
    it.each(cases)('%s %s %s -> %d', async (role, method, path, status) => {
      const req = method === 'GET' ? request(http).get(path) : request(http).post(path).send({ name: 'x', legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1' });
      await req.set(auth(tokens[role])).expect(status);
    });
    it('admin cannot grant owner (no escalation)', () =>
      request(http).post('/v1/members').set(auth(tokens.admin)).send({ phone: newPhone(), role_code: 'owner' }).expect(403));
  });

  describe('2.3 scope by legal entity and branch', () => {
    let le2: string;
    let scoped: string;
    beforeAll(async () => {
      le2 = (await request(http).post('/v1/legal-entities').set(auth(A.access_token)).send({ name: 'الشركة الثانية' }).expect(201)).body.id;
      await request(http).post('/v1/branches').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, name: 'الفروانية' }).expect(201);
      await request(http).post('/v1/branches').set(auth(A.access_token)).send({ legal_entity_id: le2, name: 'الجهراء' }).expect(201);
      await request(http).post('/v1/tasks').set(auth(A.access_token)).send({ legal_entity_id: le2, sector_pack: 'delivery@1' }).expect(201);
      await request(http).post('/v1/tasks').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1' }).expect(201);
      const phone = newPhone();
      await request(http).post('/v1/members').set(auth(A.access_token))
        .send({ phone, role_code: 'dispatcher', scope_legal_entity_ids: [le2] }).expect(201);
      scoped = (await joinAs(app, A.tenant.id, phone)).access_token;
    });
    it('sees only tasks of its legal entity', async () => {
      const r = await request(http).get('/v1/tasks').set(auth(scoped)).expect(200);
      expect(r.body.data.length).toBeGreaterThan(0);
      expect(r.body.data.every((t: { legal_entity_id: string }) => t.legal_entity_id === le2)).toBe(true);
    });
    it('sees only branches of its legal entity', async () => {
      const r = await request(http).get('/v1/branches').set(auth(scoped)).expect(200);
      expect(r.body.data.map((b: { name: string }) => b.name)).toEqual(['الجهراء']);
    });
    it('cannot scope to another company legal entity', async () => {
      const B = await onboard(app, 'شركة أخرى');
      await request(http).post('/v1/members').set(auth(A.access_token))
        .send({ phone: newPhone(), role_code: 'dispatcher', scope_legal_entity_ids: [B.legal_entity_id] }).expect(400);
    });
  });

  describe('2.4 temporary access and 2.8 revocation', () => {
    it('an expired valid_until is refused on the next request', async () => {
      const phone = newPhone();
      const m = await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone, role_code: 'dispatcher' }).expect(201);
      const t = (await joinAs(app, A.tenant.id, phone)).access_token;
      await request(http).get('/v1/tasks').set(auth(t)).expect(200);
      await request(http).patch(`/v1/members/${m.body.id}`).set(auth(A.access_token)).send({ valid_until: new Date(Date.now() - 1000).toISOString() }).expect(200);
      await request(http).get('/v1/tasks').set(auth(t)).expect(401);
    });
    it('revocation applies at once, even with a valid access token, and kills refresh', async () => {
      const phone = newPhone();
      const m = await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone, role_code: 'dispatcher' }).expect(201);
      const s = await joinAs(app, A.tenant.id, phone);
      await request(http).delete(`/v1/members/${m.body.id}`).set(auth(A.access_token)).expect(204);
      await request(http).get('/v1/tasks').set(auth(s.access_token)).expect(401);
      await request(http).post('/v1/auth/refresh').send({ refresh_token: s.refresh_token }).expect(401);
    });
    it('a role change applies on the next request', async () => {
      const phone = newPhone();
      const m = await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone, role_code: 'accountant' }).expect(201);
      const t = (await joinAs(app, A.tenant.id, phone)).access_token;
      await request(http).post('/v1/tasks').set(auth(t)).send({ legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1' }).expect(403);
      await request(http).patch(`/v1/members/${m.body.id}`).set(auth(A.access_token)).send({ role_code: 'dispatcher' }).expect(200);
      await request(http).post('/v1/tasks').set(auth(t)).send({ legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1' }).expect(201);
    });
  });

  describe('2.5 one person, two companies', () => {
    it('chooses a company and gets data of that company only', async () => {
      const B = await onboard(app, 'شركة ثانية للمستخدم');
      await request(http).post('/v1/members').set(auth(B.access_token)).send({ phone: A.phone, role_code: 'dispatcher' }).expect(201);
      const { memberships } = await login(app, A.phone);
      expect(memberships.map((m) => m.tenant_id).sort()).toEqual([A.tenant.id, B.tenant.id].sort());
      const inB = await joinAs(app, B.tenant.id, A.phone);
      const me = await request(http).get('/v1/me').set(auth(inB.access_token)).expect(200);
      expect(me.body).toMatchObject({ tenant_id: B.tenant.id, role: 'dispatcher' });
    });
  });

  describe('owners', () => {
    it('the last owner cannot be removed or demoted', async () => {
      const list = await request(http).get('/v1/members').set(auth(A.access_token)).expect(200);
      const owner = list.body.data.find((m: { role: string }) => m.role === 'owner');
      await request(http).delete(`/v1/members/${owner.id}`).set(auth(A.access_token)).expect(400);
      await request(http).patch(`/v1/members/${owner.id}`).set(auth(A.access_token)).send({ role_code: 'admin' }).expect(400);
    });
  });

  describe('sessions', () => {
    it('refresh rotates, and reusing an old refresh token revokes the family', async () => {
      const s = await joinAs(app, A.tenant.id, A.phone);
      const r1 = await request(http).post('/v1/auth/refresh').send({ refresh_token: s.refresh_token }).expect(200);
      await request(http).get('/v1/me').set(auth(r1.body.access_token)).expect(200);
      await request(http).post('/v1/auth/refresh').send({ refresh_token: s.refresh_token }).expect(401); // reuse
      await request(http).post('/v1/auth/refresh').send({ refresh_token: r1.body.refresh_token }).expect(401); // family revoked
    });
    it('a forged tenant prefix on a refresh token fails', async () => {
      const s = await joinAs(app, A.tenant.id, A.phone);
      const B = await onboard(app, 'شركة ج');
      const forged = `${B.tenant.id}.${s.refresh_token.split('.')[1]}`;
      await request(http).post('/v1/auth/refresh').send({ refresh_token: forged }).expect(401);
    });
    it('logout revokes the refresh token', async () => {
      const s = await joinAs(app, A.tenant.id, A.phone);
      await request(http).post('/v1/auth/logout').send({ refresh_token: s.refresh_token }).expect(204);
      await request(http).post('/v1/auth/refresh').send({ refresh_token: s.refresh_token }).expect(401);
    });
  });

  describe('2.9 audit of permission changes', () => {
    it('logs member add, update and revoke with before/after', async () => {
      const phone = newPhone();
      const m = await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone, role_code: 'dispatcher' }).expect(201);
      await request(http).patch(`/v1/members/${m.body.id}`).set(auth(A.access_token)).send({ role_code: 'accountant' }).expect(200);
      await request(http).delete(`/v1/members/${m.body.id}`).set(auth(A.access_token)).expect(204);
      const r = await request(http).get('/v1/audit-log').set(auth(A.access_token)).expect(200);
      const mine = r.body.data.filter((e: { target_id: string }) => e.target_id === m.body.id).map((e: { action: string }) => e.action);
      expect(mine.sort()).toEqual(['member.added', 'member.revoked', 'member.updated']);
      const upd = r.body.data.find((e: { target_id: string; action: string }) => e.target_id === m.body.id && e.action === 'member.updated');
      expect(upd.before.role).toBe('dispatcher');
      expect(upd.after.role).toBe('accountant');
    });
  });

  it('OTP codes are stored hashed, never in clear', async () => {
    const phone = newPhone();
    const r = await request(http).post('/v1/auth/otp/request').send({ phone }).expect(202);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const row = (await pool.query('SELECT code_hash FROM auth.otp_challenge WHERE phone = $1', [phone])).rows[0];
    await pool.end();
    expect(row.code_hash).not.toContain(r.body.dev_code);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
