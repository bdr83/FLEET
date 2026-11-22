import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createApp, hasDb, login, newPhone } from './helpers';

const d = hasDb ? describe : describe.skip;

d('sector packs per company', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });

  it('a company picks its packs at onboarding; other packs are refused until turned on', async () => {
    const { user_token } = await login(app, newPhone());
    await http().post('/v1/tenants').set(auth(user_token)).send({ name: 'خطأ', packs: ['delivery', 'nope'] }).expect(400);
    const t = await http().post('/v1/tenants').set(auth(user_token)).send({ name: 'شركة الخرسانة فقط', packs: ['concrete'] }).expect(201);
    const T = auth(t.body.access_token);
    const le = t.body.legal_entity_id;

    expect((await http().get('/v1/me').set(T).expect(200)).body.packs).toEqual(['concrete']);
    const p = await http().get('/v1/packs').set(T).expect(200);
    expect(p.body.available.map((x: { code: string }) => x.code)).toEqual(['delivery', 'freight', 'coldchain', 'courier', 'warehouse', 'ecommerce', 'staffing', 'concrete', 'internal', 'distribution']);

    await http().get(`/v1/concrete/settings?legal_entity_id=${le}`).set(T).expect(200);
    const r = await http().get(`/v1/delivery/settings?legal_entity_id=${le}`).set(T).expect(403);
    expect(r.body.message).toBe('pack_disabled');
    await http().post('/v1/tasks').set(T).send({ legal_entity_id: le, sector_pack: 'delivery@1' }).expect(403);
    // generic task types are core and always allowed
    await http().post('/v1/tasks').set(T).send({ legal_entity_id: le, sector_pack: 'moving@1' }).expect(201);

    await http().put('/v1/packs').set(T).send({ packs: ['delivery', 'concrete', 'delivery'] }).expect(200);
    expect((await http().get('/v1/me').set(T).expect(200)).body.packs).toEqual(['delivery', 'concrete']);
    await http().get(`/v1/delivery/settings?legal_entity_id=${le}`).set(T).expect(200);
    await http().post('/v1/tasks').set(T).send({ legal_entity_id: le, sector_pack: 'delivery@1' }).expect(201);
    await http().put('/v1/packs').set(T).send({ packs: 'all' }).expect(400);

    const audit = await http().get('/v1/audit-log').set(T).expect(200);
    expect(JSON.stringify(audit.body)).toContain('tenant.packs_changed');
  });

  it('without a list, a new company gets every pack', async () => {
    const { user_token } = await login(app, newPhone());
    const t = await http().post('/v1/tenants').set(auth(user_token)).send({ name: 'شركة كاملة' }).expect(201);
    expect((await http().get('/v1/me').set(auth(t.body.access_token)).expect(200)).body.packs).toHaveLength(10);
  });
});
