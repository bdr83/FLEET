/**
 * Containers and ports (containers pack, sector 6): an import container from the port to the customer and the empty back
 * to the depot, legs booking the truck and driver; the driver confirms the box number and gives the receiver or the gate
 * receipt; free dates and the yard; an export; exceptions, closing and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Containers pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, client: string, truck: string, truck2: string;
  let driver: { token: string; id: string }, d2: string;
  let job: { id: string; ref: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const site = { name: 'مستودع الري', area: 'الري', block: '1', street: '20', phone: '+96550004444' };
  async function op(o: Record<string, unknown>, token = driver.token) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }
  const legTask = async (ref: string) => (await get('/v1/driver/tasks', driver.token).expect(200)).body.data.find((x: { ref: string }) => x.ref === ref);

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'الحاويات', packs: ['containers'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التريلا', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    d2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق 2', phone: newPhone() }).expect(201)).body.id;
    truck = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CT-${Date.now() % 100000}` }).expect(201)).body.id;
    truck2 = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CU-${Date.now() % 100000}` }).expect(201)).body.id;
    client = (await post('/v1/customers', { legal_entity_id: le, kind: 'business', name: 'شركة الاستيراد' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('an import container: the number is checked; one open job per box; legs in order', async () => {
    const base = { legal_entity_id: le, customer_id: client, direction: 'import', container_no: 'mscu 123456-6', iso_size: '40', ctype: 'high_cube', line: 'MSC', doc_no: 'BL-778',
      port: 'shuwaikh', depot: 'ساحة الصليبية', site, last_free_day: kwDay(1), return_by: kwDay(-1) };
    await post('/v1/containers/jobs', { ...base, container_no: 'MSCU1234567' }).expect(400); // wrong check digit
    await post('/v1/containers/jobs', { ...base, port: 'jebel_ali' }).expect(400);
    const j = (await post('/v1/containers/jobs', base).expect(201)).body;
    expect(j).toMatchObject({ ref: expect.stringMatching(/^CT-\d+$/), container_no: 'MSCU1234566', state: 'waiting', next_leg: 'port_to_customer', next_booked: false });
    job = { id: j.id, ref: j.ref };
    expect((await post('/v1/containers/jobs', base).expect(409)).body.message).toMatch(/container_open/);
    const ex = (await get('/v1/containers/exceptions').expect(200)).body;
    expect(ex.storage_risk.map((x: { ref: string }) => x.ref)).toContain(j.ref);
    expect(ex.detention_risk.map((x: { ref: string }) => x.ref)).toContain(j.ref);
    expect(ex.unbooked.map((x: { ref: string }) => x.ref)).toContain(j.ref);
    const b = (await post(`/v1/containers/jobs/${j.id}/legs`, { driver_worker_id: driver.id, asset_id: truck }).expect(201)).body;
    expect(b).toMatchObject({ next_leg: 'empty_to_depot', next_booked: true, legs: [{ seq: 1, kind: 'port_to_customer', driver_name: 'سائق التريلا', status: 'assigned' }] });
    // the second leg booked ahead for later; the truck is taken now
    await post(`/v1/containers/jobs/${j.id}/legs`, { driver_worker_id: d2, asset_id: truck }).expect(409);
    await post(`/v1/containers/jobs/${j.id}/dates`, { return_by: kwDay(5) }).expect(200);
  });

  it('the driver confirms the number at the port and the receiver at the customer', async () => {
    const t = await legTask(`${job.ref}-1`);
    expect(t.attributes).toMatchObject({ kind: 'leg', leg: 'port_to_customer', container_no: 'MSCU1234566', iso_size: '40', pickup_address: 'ميناء الشويخ', address: 'مستودع الري، الري، ق 1، 20', gate: false });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ctr_picked' })).reason).toBe('container_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ctr_picked', container_no: 'MAEU7654320' })).reason).toBe('container_mismatch');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'ctr_picked', container_no: 'mscu1234566', seal_no: 'SL-99' })).toMatchObject({ result: 'applied' });
    expect((await get(`/v1/containers/jobs/${job.id}`).expect(200)).body).toMatchObject({ state: 'in_transit', seal_no: 'SL-99', storage_days: 0 });
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ctr_dropped' })).reason).toBe('receiver_required');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'ctr_dropped', received_by: 'أمين المستودع' })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    const y = (await get('/v1/containers/yard').expect(200)).body;
    expect(y.at_customer.find((x: { ref: string }) => x.ref === job.ref)).toMatchObject({ days_at_customer: 0, state: 'at_customer' });
    await post(`/v1/containers/jobs/${job.id}/close`, {}).expect(409);
    await post(`/v1/containers/jobs/${job.id}/cancel`, { reason: 'x' }).expect(409);
  });

  it('the empty is ready and goes back to the depot with the gate receipt', async () => {
    await post(`/v1/containers/jobs/${job.id}/ready`, {}).expect(200);
    expect((await get('/v1/containers/exceptions').expect(200)).body.ready_to_collect.map((x: { ref: string }) => x.ref)).toContain(job.ref);
    const j = (await post(`/v1/containers/jobs/${job.id}/legs`, { driver_worker_id: driver.id, asset_id: truck2, starts_at: new Date(Date.now() + 4 * 3_600_000).toISOString() }).expect(201)).body;
    expect(j.legs[1]).toMatchObject({ seq: 2, kind: 'empty_to_depot' });
    await post(`/v1/containers/jobs/${job.id}/legs`, { driver_worker_id: driver.id, asset_id: truck2 }).expect(409); // all booked
    const t = await legTask(`${job.ref}-2`);
    expect(t.attributes).toMatchObject({ leg: 'empty_to_depot', pickup_address: 'مستودع الري، الري، ق 1، 20', address: 'ساحة الصليبية', gate: true });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    await op({ type: 'milestone', task_id: t.id, code: 'ctr_picked', container_no: 'MSCU1234566' });
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ctr_dropped', received_by: 'x' })).reason).toBe('gate_ref_required');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'ctr_dropped', gate_ref: 'EIR-5521' })).toMatchObject({ result: 'applied' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'completed' });
    const done = (await get(`/v1/containers/jobs/${job.id}`).expect(200)).body;
    expect(done).toMatchObject({ state: 'done', detention_days: 0, legs: [{ received_by: 'أمين المستودع' }, { gate_ref: 'EIR-5521' }] });
    expect((await post(`/v1/containers/jobs/${job.id}/close`, { haulage_amount: '45.000', extra_amount: '10.000' }).expect(200)).body).toMatchObject({ state: 'closed', total: '55.000' });
    // the box can be booked again after its job closed
    await post('/v1/containers/jobs', { legal_entity_id: le, customer_id: client, direction: 'export', container_no: 'MSCU1234566', iso_size: '40', port: 'shuaiba', site }).expect(201);
  });

  it('an export starts with an empty from the depot; a waiting job can be canceled', async () => {
    const e = (await post('/v1/containers/jobs', { legal_entity_id: le, customer_id: client, direction: 'export', container_no: 'CSQU3054383', iso_size: '20', line: 'CMA', port: 'shuaiba', site }).expect(201)).body;
    const j = (await post(`/v1/containers/jobs/${e.id}/legs`, { driver_worker_id: d2, asset_id: truck2, starts_at: new Date(Date.now() + 30 * 86_400_000).toISOString() }).expect(201)).body;
    expect(j.legs[0].kind).toBe('empty_to_customer');
    const c = (await post(`/v1/containers/jobs/${e.id}/cancel`, { reason: 'ألغى العميل الحجز' }).expect(200)).body;
    expect(c).toMatchObject({ state: 'canceled', legs: [{ status: 'canceled' }] });
    const b = (await get(`/v1/containers/board?date=${kwDay(0)}`).expect(200)).body;
    expect(b.legs.map((x: { job_ref: string }) => x.job_ref)).toContain(job.ref);
  });

  it('the report', async () => {
    const r = (await get(`/v1/containers/report?from=${kwDay(-1)}&to=${kwDay(1)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ containers: 2, teu: 4, import: 1, export: 1, moves: 2, closed: 1, storage_days: 0, haulage: '45.000', extra: '10.000' });
    expect(r.lines.find((l: { line: string }) => l.line === 'MSC')).toMatchObject({ containers: 1, teu: 2 });
  });
});
