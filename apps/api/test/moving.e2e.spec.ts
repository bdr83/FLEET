/**
 * Furniture moving (moving pack, sector 5): a request, the survey with the item list, the quote and the customer's
 * acceptance with the deposit; the truck, driver and helpers booked for the day; the driver loads and unloads with the
 * receiver's name; the office closes with extra charges and the rating; a damage claim; exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Furniture moving pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, client: string, truck: string;
  let driver: { token: string; id: string }, h1: string, h2: string;
  let job: { id: string; ref: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const from = { area: 'السالمية', block: '10', street: '5', house: '22', floor: 3, lift: false, phone: '+96550003333' };
  const to = { area: 'الجابرية', block: '4', street: '12', house: '7', apartment: '2', floor: 0 };
  async function op(o: Record<string, unknown>, token = driver.token) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'نقل الأثاث', packs: ['moving'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق النقل', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    h1 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'عامل 1', phone: newPhone() }).expect(201)).body.id;
    h2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'عامل 2', phone: newPhone() }).expect(201)).body.id;
    truck = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `MV-${Date.now() % 100000}` }).expect(201)).body.id;
    client = (await post('/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'بو فهد' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a request, the survey, the quote and the acceptance', async () => {
    const base = { legal_entity_id: le, customer_id: client, from_site: from, to_site: to, home_size: 'apt_2', services: ['packing', 'assembly'], move_at: new Date(Date.now() + 3_600_000).toISOString() };
    await post('/v1/moving/jobs', { ...base, home_size: 'castle' }).expect(400);
    await post('/v1/moving/jobs', { ...base, services: ['flying'] }).expect(400);
    await post('/v1/moving/jobs', { ...base, to_site: {} }).expect(400);
    const j = (await post('/v1/moving/jobs', base).expect(201)).body;
    expect(j).toMatchObject({ ref: expect.stringMatching(/^MV-\d+$/), state: 'new', hours: 5, crew_size: 3, services: ['packing', 'assembly'] });
    job = { id: j.id, ref: j.ref };
    await post(`/v1/moving/jobs/${j.id}/accept`, {}).expect(409); // no quote yet
    await post(`/v1/moving/jobs/${j.id}/survey`, { volume_m3: 30.25 }).expect(400);
    const s = (await post(`/v1/moving/jobs/${j.id}/survey`, { volume_m3: 30.5, items: [{ room: 'الصالة', name: 'كنبة', qty: 2 }, { room: 'الصالة', name: 'تلفزيون', fragile: true }, { name: 'ثلاجة' }] }).expect(200)).body;
    expect(s).toMatchObject({ volume_m3: 30.5, items: expect.arrayContaining([expect.objectContaining({ name: 'تلفزيون', fragile: true })]) });
    expect(s.items).toHaveLength(3);
    await post(`/v1/moving/jobs/${j.id}/quote`, { quote_amount: '100.000', deposit_amount: '150.000' }).expect(400);
    expect((await post(`/v1/moving/jobs/${j.id}/quote`, { quote_amount: '120.000', deposit_amount: '30.000' }).expect(200)).body).toMatchObject({ state: 'quoted', quote_amount: '120.000' });
    expect((await post(`/v1/moving/jobs/${j.id}/accept`, {}).expect(200)).body).toMatchObject({ state: 'accepted', deposit_paid_at: null });
    const ex = (await get('/v1/moving/exceptions').expect(200)).body;
    expect(ex.to_book.map((x: { ref: string }) => x.ref)).toContain(j.ref);
    expect(ex.deposit_unpaid.map((x: { ref: string }) => x.ref)).toContain(j.ref);
    await post(`/v1/moving/jobs/${j.id}/quote`, { quote_amount: '130.000' }).expect(409); // accepted: the price is fixed
  });

  it('the truck, the driver and two helpers booked; no double booking', async () => {
    await post(`/v1/moving/jobs/${job.id}/book`, { driver_worker_id: driver.id, asset_id: truck, helper_worker_ids: [h1, h1] }).expect(400);
    const j = (await post(`/v1/moving/jobs/${job.id}/book`, { driver_worker_id: driver.id, asset_id: truck, helper_worker_ids: [h1, h2] }).expect(201)).body;
    expect(j.state).toBe('booked');
    expect(j.crew.map((x: { role: string; ref: string }) => `${x.role}:${x.ref}`)).toEqual([`lead:${job.ref}-1`, `helper:${job.ref}-1-H1`, `helper:${job.ref}-1-H2`]);
    expect(j.crew[0]).toMatchObject({ worker_name: 'سائق النقل', plate_no: expect.any(String) });
    await post(`/v1/moving/jobs/${job.id}/book`, { driver_worker_id: driver.id, asset_id: truck }).expect(409);
    // another move the same hour: the truck and a helper are taken
    const other = (await post('/v1/moving/jobs', { legal_entity_id: le, customer_id: client, from_site: from, to_site: to, home_size: 'room', move_at: new Date(Date.now() + 3_600_000).toISOString() }).expect(201)).body;
    await post(`/v1/moving/jobs/${other.id}/quote`, { quote_amount: '40.000' }).expect(200);
    await post(`/v1/moving/jobs/${other.id}/accept`, { deposit_paid: true }).expect(200);
    const truck2 = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `MW-${Date.now() % 100000}` }).expect(201)).body.id;
    const d2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق 2', phone: newPhone() }).expect(201)).body.id;
    expect((await post(`/v1/moving/jobs/${other.id}/book`, { driver_worker_id: d2, asset_id: truck }).expect(409)).body.message).toMatch(/vehicle_booked/);
    expect((await post(`/v1/moving/jobs/${other.id}/book`, { driver_worker_id: d2, asset_id: truck2, helper_worker_ids: [h2] }).expect(409)).body.message).toMatch(/worker_booked/);
    expect((await post(`/v1/moving/jobs/${other.id}/cancel`, { reason: 'العميل أجّل' }).expect(200)).body.state).toBe('canceled');
    const day = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10); // the move's date in Kuwait
    const b = (await get(`/v1/moving/board?date=${day}`).expect(200)).body;
    expect(b.moves.find((x: { ref: string }) => x.ref === job.ref).crew).toHaveLength(3);
  });

  it('the driver loads and unloads with the receiver; a helper task has no stages', async () => {
    const tasks = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data;
    const t = tasks.find((x: { ref: string }) => x.ref === `${job.ref}-1`);
    expect(t.attributes).toMatchObject({ kind: 'move', move_ref: job.ref, items_count: 4, fragile: ['تلفزيون'], pickup_address: 'السالمية، ق 10، 5، منزل 22، الدور 3', address: 'الجابرية، ق 4، 12، منزل 7، الدور 0، شقة 2' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await get(`/v1/moving/jobs/${job.id}`).expect(200)).body.state).toBe('moving');
    await post(`/v1/moving/jobs/${job.id}/cancel`, { reason: 'x' }).expect(409);
    expect((await op({ type: 'milestone', task_id: t.id, code: 'unloaded', received_by: 'بو فهد' })).reason).toBe('stage_out_of_order');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'loaded' })).toMatchObject({ result: 'applied' });
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'unloaded' })).reason).toBe('receiver_required');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'unloaded', received_by: 'بو فهد', note: 'خدش بسيط في الطاولة' })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    const j = (await get(`/v1/moving/jobs/${job.id}`).expect(200)).body;
    expect(j).toMatchObject({ state: 'delivered', received_by: 'بو فهد', delivery_note: 'خدش بسيط في الطاولة' });
    expect(j.loaded_at).not.toBeNull();
    // a helper joins with the app: the plain flow, no stages
    const hp = newPhone();
    const h3 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'عامل 3', phone: hp }).expect(201)).body.id;
    const hTok = (await joinAs(app, tenant, hp)).access_token;
    const m3 = (await post('/v1/moving/jobs', { legal_entity_id: le, customer_id: client, from_site: from, to_site: to, home_size: 'room', move_at: new Date(Date.now() + 30 * 86_400_000).toISOString() }).expect(201)).body;
    await post(`/v1/moving/jobs/${m3.id}/quote`, { quote_amount: '40.000' }).expect(200);
    await post(`/v1/moving/jobs/${m3.id}/accept`, {}).expect(200);
    await post(`/v1/moving/jobs/${m3.id}/book`, { driver_worker_id: driver.id, asset_id: truck, helper_worker_ids: [h3] }).expect(201);
    const crewTask = (await get(`/v1/moving/jobs/${m3.id}`).expect(200)).body.crew.find((x: { role: string }) => x.role === 'helper');
    await op({ type: 'task_status', task_id: crewTask.task_id, to_status: 'accepted' }, hTok);
    await op({ type: 'task_status', task_id: crewTask.task_id, to_status: 'in_progress' }, hTok);
    expect((await op({ type: 'milestone', task_id: crewTask.task_id, code: 'loaded' }, hTok)).reason).toBe('not_supported');
  });

  it('the office closes with extras and the rating; a damage claim is settled', async () => {
    await post(`/v1/moving/jobs/${job.id}/close`, { extra_amount: '15.000', rating: 6 }).expect(400);
    const j = (await post(`/v1/moving/jobs/${job.id}/close`, { extra_amount: '15.000', rating: 4, rating_note: 'ممتاز' }).expect(200)).body;
    expect(j).toMatchObject({ state: 'closed', total: '135.000', rating: 4 });
    expect(j.crew.every((x: { status: string }) => x.status === 'completed')).toBe(true);
    const k = (await post(`/v1/moving/jobs/${job.id}/claims`, { item: 'طاولة الطعام', description: 'خدش في السطح', claimed_amount: '25.000' }).expect(201)).body.claims[0];
    expect((await get('/v1/moving/exceptions').expect(200)).body.claims.map((x: { id: string }) => x.id)).toContain(k.id);
    await post(`/v1/moving/claims/${k.id}/decide`, { status: 'rejected' }).expect(400);
    const d = (await post(`/v1/moving/claims/${k.id}/decide`, { status: 'settled', settled_amount: '10.000', note: 'تعويض جزئي' }).expect(200)).body;
    expect(d.claims[0]).toMatchObject({ status: 'settled', settled_amount: '10.000' });
    await post(`/v1/moving/claims/${k.id}/decide`, { status: 'rejected', note: 'x' }).expect(409);
  });

  it('the report', async () => {
    const r = (await get(`/v1/moving/report?from=${kwDay(-1)}&to=${kwDay(31)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ closed: 1, revenue: '135.000', avg_rating: 4, claims: 1, claims_open: 0, claims_settled: '10.000' });
    expect(r.totals.acceptance_pct).toBe(100);
    await get(`/v1/moving/report?from=${kwDay(0)}`).expect(400);
  });
});
