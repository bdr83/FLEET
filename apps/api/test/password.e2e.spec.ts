import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createApp, hasDb, onboard } from './helpers';

const d = hasDb ? describe : describe.skip;
const email = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

d('email + password login', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });

  it('registers, creates a company, logs in again and picks it', async () => {
    const e = email('Owner');
    const reg = await http().post('/v1/auth/register').send({ email: `  ${e.toUpperCase()} `, password: 'correct horse', display_name: 'بدران' }).expect(201);
    expect(reg.body.memberships).toEqual([]);
    const t = await http().post('/v1/tenants').set(auth(reg.body.user_token)).send({ name: 'شركة البريد' }).expect(201);
    const me = await http().get('/v1/me').set(auth(t.body.access_token)).expect(200);
    expect(me.body).toMatchObject({ email: e.toLowerCase(), display_name: 'بدران', role: 'owner' });

    await http().post('/v1/auth/register').send({ email: e, password: 'another pass' }).expect(409);
    await http().post('/v1/auth/login').send({ email: e, password: 'wrong pass' }).expect(401);
    await http().post('/v1/auth/login').send({ email: 'nobody@example.com', password: 'correct horse' }).expect(401);
    const li = await http().post('/v1/auth/login').send({ email: e.toUpperCase(), password: 'correct horse' }).expect(200);
    expect(li.body.memberships).toEqual([expect.objectContaining({ tenant_id: t.body.tenant.id, role_code: 'owner' })]);
    await http().post('/v1/auth/token').set(auth(li.body.user_token)).send({ tenant_id: t.body.tenant.id }).expect(200);
  });

  it('rejects weak passwords and bad emails', async () => {
    await http().post('/v1/auth/register').send({ email: email('w'), password: 'short' }).expect(400);
    await http().post('/v1/auth/register').send({ email: 'not-an-email', password: 'long enough' }).expect(400);
  });

  it('locks the account after 10 wrong passwords', async () => {
    const e = email('lock');
    await http().post('/v1/auth/register').send({ email: e, password: 'right password' }).expect(201);
    for (let i = 0; i < 10; i++) await http().post('/v1/auth/login').send({ email: e, password: 'bad password' }).expect(401);
    await http().post('/v1/auth/login').send({ email: e, password: 'right password' }).expect(429);
  });

  it('resets the password with a single-use emailed token', async () => {
    const e = email('reset');
    await http().post('/v1/auth/register').send({ email: e, password: 'old password' }).expect(201);
    const unknown = await http().post('/v1/auth/password/forgot').send({ email: email('ghost') }).expect(202);
    expect(unknown.body).toEqual({ status: 'sent' });
    const f = await http().post('/v1/auth/password/forgot').send({ email: e }).expect(202);
    expect(f.body.dev_token).toBeTruthy();
    await http().post('/v1/auth/password/reset').send({ token: f.body.dev_token, password: 'short' }).expect(400);
    const r = await http().post('/v1/auth/password/reset').send({ token: f.body.dev_token, password: 'new password' }).expect(200);
    expect(r.body.user_token).toBeTruthy();
    await http().post('/v1/auth/password/reset').send({ token: f.body.dev_token, password: 'newer password' }).expect(400);
    await http().post('/v1/auth/login').send({ email: e, password: 'old password' }).expect(401);
    await http().post('/v1/auth/login').send({ email: e, password: 'new password' }).expect(200);
    expect((await http().get('/v1/auth/methods').expect(200)).body).toEqual({ password: true, password_reset: true });
  });

  it('an admin adds a member by email with a first password; the member changes it', async () => {
    const o = await onboard(app, 'شركة الأعضاء');
    const e = email('member');
    await http().post('/v1/members').set(auth(o.access_token)).send({ phone: '+96550000000', password: 'x'.repeat(8) }).expect(400);
    const m = await http().post('/v1/members').set(auth(o.access_token)).send({ email: e, password: 'first password', role_code: 'dispatcher' }).expect(201);
    expect(m.body).toMatchObject({ email: e, role: 'dispatcher' });
    const li = await http().post('/v1/auth/login').send({ email: e, password: 'first password' }).expect(200);
    const s = await http().post('/v1/auth/token').set(auth(li.body.user_token)).send({ tenant_id: o.tenant.id }).expect(200);
    await http().post('/v1/auth/password/change').set(auth(s.body.access_token)).send({ current_password: 'nope nope', new_password: 'my own password' }).expect(401);
    await http().post('/v1/auth/password/change').set(auth(s.body.access_token)).send({ current_password: 'first password', new_password: 'my own password' }).expect(204);
    await http().post('/v1/auth/login').send({ email: e, password: 'my own password' }).expect(200);
    // adding an existing account again elsewhere never overwrites its password
    const o2 = await onboard(app, 'شركة ثانية');
    await http().post('/v1/members').set(auth(o2.access_token)).send({ email: e, password: 'hijack attempt', role_code: 'dispatcher' }).expect(201);
    await http().post('/v1/auth/login').send({ email: e, password: 'hijack attempt', role_code: 'dispatcher' }).expect(401);
  });
});
