/**
 * Pest control (pest pack, sector 26): the pesticide register; a job for a restaurant on a monthly contract; the
 * technician needs a valid licence; arrived, then treated with the products used, the infestation level and the
 * receiver; the re-entry time; the next contract visit created on completion; a callback within the warranty;
 * exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Pest pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, cu: string, gel: string, spray: string, unlicensed: string;
  let tech: { token: string; id: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const patch = (path: string, body: Record<string, unknown>, token = T) => request(http).patch(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  async function op(o: Record<string, unknown>, at = ago(1)) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, tech.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'مكافحة الآفات', packs: ['pest'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'الفني خالد', phone }).expect(201)).body;
    tech = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    unlicensed = (await post('/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'فني بلا ترخيص', phone: newPhone() }).expect(201)).body.id;
    await post('/v1/documents', { legal_entity_id: le, worker_id: tech.id, doc_type: 'pesticide_license', number: 'PL-2231', expires_on: kwDay(200) }).expect(201);
    cu = (await post('/v1/customers', { legal_entity_id: le, name: 'مطعم البحر' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('the pesticide register', async () => {
    gel = (await post('/v1/pest/products', { name: 'جل الصراصير', active_ingredient: 'Fipronil 0.05%', registration_no: 'KM-PC-1102', unit: 'g', reentry_hours: 0 }).expect(201)).body.id;
    const s = (await post('/v1/pest/products', { name: 'رش متبقي', active_ingredient: 'Cypermethrin 10%', unit: 'ml', reentry_hours: 4 }).expect(201)).body;
    spray = s.id;
    await post('/v1/pest/products', { name: 'جل الصراصير', unit: 'g' }).expect(409);
    await post('/v1/pest/products', { name: 'x', unit: 'drum' }).expect(400);
    expect((await get('/v1/pest/exceptions').expect(200)).body.unregistered_products.map((p: { name: string }) => p.name)).toEqual(['رش متبقي']);
    expect((await patch(`/v1/pest/products/${spray}`, { version: s.version, registration_no: 'KM-PC-0877' }).expect(200)).body.registration_no).toBe('KM-PC-0877');
  });

  it('a monthly restaurant job: licence checked; arrived, treated, re-entry time; the next visit booked on completion', async () => {
    await post('/v1/pest/jobs', { legal_entity_id: le, customer_id: cu, premises: 'restaurant', service: 'gel', pests: ['lice'], area: 'السالمية', scheduled_at: ago(30) }).expect(400);
    const j = (await post('/v1/pest/jobs', { legal_entity_id: le, customer_id: cu, premises: 'restaurant', service: 'spray', pests: ['cockroaches', 'rodents', 'cockroaches'],
      area: 'السالمية', address: 'شارع البلاجات', contact_phone: '+96550001111', scheduled_at: ago(30), repeat_days: 30, notes: 'المطبخ يغلق 3 العصر' }).expect(201)).body;
    expect(j).toMatchObject({ ref: expect.stringMatching(/^PC-\d+$/), state: 'open', pests: ['cockroaches', 'rodents'], warranty_days: 30, repeat_days: 30 });
    expect((await post(`/v1/pest/jobs/${j.id}/assign`, { worker_id: unlicensed }).expect(409)).body.message).toMatch(/^license_required/);
    const a = (await post(`/v1/pest/jobs/${j.id}/assign`, { worker_id: tech.id }).expect(201)).body;
    expect(a).toMatchObject({ state: 'assigned', technician_name: 'الفني خالد' });
    const t = (await get('/v1/driver/tasks', tech.token).expect(200)).body.data.find((x: { id: string }) => x.id === a.task_id);
    expect(t.attributes).toMatchObject({ kind: 'pest_job', job_ref: j.ref, premises: 'restaurant', service: 'spray', address: 'شارع البلاجات، السالمية', notes: 'المطبخ يغلق 3 العصر' });
    expect(t.attributes.products.map((p: { name: string }) => p.name)).toEqual(['جل الصراصير', 'رش متبقي']);
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, ago(25));
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, ago(24));
    expect((await op({ type: 'milestone', task_id: t.id, code: 'pc_treated' })).reason).toBe('stage_out_of_order');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'pc_arrived' }, ago(20))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    const treated = { type: 'milestone', task_id: t.id, code: 'pc_treated', infestation: 'medium', received_by: 'مدير المطعم', note: 'آثار قوارض قرب المخزن' };
    expect((await op({ ...treated, applications: [] })).reason).toBe('products_required');
    expect((await op({ ...treated, received_by: undefined, applications: [{ product_id: gel, qty: 30 }] })).reason).toBe('receiver_required');
    expect((await op({ ...treated, applications: [{ product_id: randomUUID(), qty: 30 }] })).reason).toBe('unknown_product');
    expect((await op({ ...treated, applications: [{ product_id: gel, qty: 30, location: 'المطبخ' }, { product_id: spray, qty: 250, location: 'المخزن' }] }, ago(10))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).result).toBe('applied');
    const d = (await get(`/v1/pest/jobs/${j.id}`).expect(200)).body;
    expect(d).toMatchObject({ state: 'done', infestation: 'medium', received_by: 'مدير المطعم', next_ref: expect.stringMatching(/^PC-/) });
    expect(Math.round((Date.parse(d.reentry_at) - Date.parse(d.treated_at)) / 3_600_000)).toBe(4);
    expect(d.applications.map((x: { product_name: string; qty: number }) => [x.product_name, x.qty])).toEqual([['جل الصراصير', 30], ['رش متبقي', 250]]);
    const next = (await get(`/v1/pest/jobs/${d.next_job_id}`).expect(200)).body;
    expect(next).toMatchObject({ state: 'open', repeat_days: 30, customer_name: 'مطعم البحر' });
    expect(Math.round((Date.parse(next.scheduled_at) - Date.parse(d.scheduled_at)) / 86_400_000)).toBe(30);
  });

  it('a callback within the warranty; exceptions and the report', async () => {
    const done = (await get(`/v1/pest/jobs?date=${kwDay()}`).expect(200)).body.data.find((x: { state: string }) => x.state === 'done');
    const open = (await post('/v1/pest/jobs', { legal_entity_id: le, customer_id: cu, premises: 'home', service: 'gel', pests: ['ants'], area: 'حولي', scheduled_at: new Date(Date.now() + 3_600_000).toISOString() }).expect(201)).body;
    await post(`/v1/pest/jobs/${open.id}/callback`, { reason: 'x', scheduled_at: new Date().toISOString() }).expect(409);
    const cb = (await post(`/v1/pest/jobs/${done.id}/callback`, { reason: 'عادت الصراصير في المطبخ', scheduled_at: new Date(Date.now() + 2 * 3_600_000).toISOString() }).expect(201)).body;
    expect(cb).toMatchObject({ in_warranty: true, parent_ref: done.ref, notes: 'عادت الصراصير في المطبخ', repeat_days: null, state: 'open' });
    const ex = (await get('/v1/pest/exceptions').expect(200)).body;
    expect(ex.unassigned.map((x: { id: string }) => x.id).sort()).toEqual([open.id, cb.id].sort());
    expect(ex.callbacks.map((x: { id: string }) => x.id)).toEqual([cb.id]);
    expect(ex.unregistered_products).toEqual([]);
    const r = (await get(`/v1/pest/report?from=${kwDay(-1)}&to=${kwDay(0)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ jobs: 3, done: 1, callbacks: 1, in_warranty: 1, callback_rate: 100 });
    expect(r.pests.find((x: { key: string }) => x.key === 'cockroaches')).toMatchObject({ jobs: 2, done: 1 });
    expect(r.premises.map((x: { key: string }) => x.key)).toEqual(['home', 'restaurant']);
    expect(r.products).toMatchObject([{ name: 'جل الصراصير', qty: 30, jobs: 1 }, { name: 'رش متبقي', qty: 250, unit: 'ml' }]);
    const { user_token } = await login(app, newPhone());
    const other = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'توصيل', packs: ['delivery'] }).expect(201)).body;
    await get('/v1/pest/jobs', other.access_token).expect(403);
  });
});
