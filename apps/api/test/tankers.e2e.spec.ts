/**
 * Tankers (tankers pack, sector 7): tankers registered as water or fuel with their capacity; an order assigned to a
 * matching tanker and driver; the driver records the litres filled and discharged and the receiver; a failed trip is
 * reassigned; a standing order creates the day's order; the office records a paper ticket; exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Tankers pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, client: string, water: string, fuel: string;
  let driver: { token: string; id: string }, d2: string;
  let order: { id: string; ref: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const put = (path: string, body: Record<string, unknown>) => request(http).put(path).set(auth(T)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const site = { name: 'عمارة 5', area: 'حولي', block: '2', street: '15', phone: '+96550005555' };
  async function op(o: Record<string, unknown>, token = driver.token) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }
  const trip = async (ref: string) => (await get('/v1/driver/tasks', driver.token).expect(200)).body.data.find((x: { ref: string }) => x.ref === ref);

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'الصهاريج', packs: ['tankers'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التانكر', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    d2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق 2', phone: newPhone() }).expect(201)).body.id;
    water = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'tanker', plate_no: `TW-${Date.now() % 100000}` }).expect(201)).body.id;
    fuel = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'tanker', plate_no: `TF-${Date.now() % 100000}` }).expect(201)).body.id;
    client = (await post('/v1/customers', { legal_entity_id: le, kind: 'business', name: 'إدارة عمارة 5' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('tankers registered as water or fuel with their capacity', async () => {
    await put(`/v1/tankers/vehicles/${water}`, { product_class: 'oil', capacity_l: 10000 }).expect(400);
    await put(`/v1/tankers/vehicles/${water}`, { product_class: 'water', capacity_l: 10000 }).expect(200);
    await put(`/v1/tankers/vehicles/${fuel}`, { product_class: 'fuel', capacity_l: 20000 }).expect(200);
    const v = (await get('/v1/tankers/vehicles').expect(200)).body.data;
    expect(v.find((x: { asset_id: string }) => x.asset_id === water)).toMatchObject({ product_class: 'water', capacity_l: 10000 });
  });

  it('an order goes only on a matching tanker big enough', async () => {
    const base = { legal_entity_id: le, customer_id: client, site, product: 'water_fresh', qty_l: 8000, unit_price: '3.500', from: new Date(Date.now() + 3_600_000).toISOString() };
    await post('/v1/tankers/orders', { ...base, product: 'milk' }).expect(400);
    await post('/v1/tankers/orders', { ...base, qty_l: 50 }).expect(400);
    const o = (await post('/v1/tankers/orders', base).expect(201)).body;
    expect(o).toMatchObject({ ref: expect.stringMatching(/^TK-\d+$/), state: 'new', qty_l: 8000 });
    expect(Date.parse(o.wanted_to) - Date.parse(o.wanted_from)).toBe(120 * 60_000);
    order = { id: o.id, ref: o.ref };
    expect((await post(`/v1/tankers/orders/${o.id}/assign`, { driver_worker_id: driver.id, asset_id: fuel }).expect(409)).body.message).toMatch(/wrong_tanker/);
    const big = (await post('/v1/tankers/orders', { ...base, qty_l: 12000 }).expect(201)).body;
    expect((await post(`/v1/tankers/orders/${big.id}/assign`, { driver_worker_id: d2, asset_id: water }).expect(409)).body.message).toMatch(/too_small/);
    await post(`/v1/tankers/orders/${big.id}/cancel`, { reason: 'كمية خطأ' }).expect(200);
    const a = (await post(`/v1/tankers/orders/${o.id}/assign`, { driver_worker_id: driver.id, asset_id: water }).expect(201)).body;
    expect(a).toMatchObject({ state: 'assigned', driver_name: 'سائق التانكر', attempts: 1 });
    expect((await get('/v1/tankers/exceptions').expect(200)).body.unassigned.map((x: { ref: string }) => x.ref)).not.toContain(o.ref);
  });

  it('the driver fills and discharges with the receiver; a failed trip is reassigned', async () => {
    let t = await trip(`${order.ref}-1`);
    expect(t.attributes).toMatchObject({ kind: 'tank', product: 'water_fresh', qty_l: 8000, capacity_l: 10000, address: 'عمارة 5، حولي، ق 2، 15' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await op({ type: 'milestone', task_id: t.id, code: 'tank_filled' })).reason).toBe('litres_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'tank_filled', litres: 12000 })).reason).toBe('over_capacity');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tank_filled', litres: 8000, note: 'محطة الشويخ' })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'failed', reason_code: 'customer_absent' })).toMatchObject({ result: 'applied' });
    let o = (await get(`/v1/tankers/orders/${order.id}`).expect(200)).body;
    expect(o).toMatchObject({ state: 'failed', loaded_l: 8000, source: 'محطة الشويخ' });
    expect((await get('/v1/tankers/exceptions').expect(200)).body.failed.map((x: { ref: string }) => x.ref)).toContain(order.ref);
    o = (await post(`/v1/tankers/orders/${order.id}/assign`, { driver_worker_id: driver.id, asset_id: water }).expect(201)).body;
    expect(o).toMatchObject({ state: 'assigned', attempts: 2, loaded_l: null });
    t = await trip(`${order.ref}-2`);
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await op({ type: 'milestone', task_id: t.id, code: 'tank_discharged', litres: 7000, received_by: 'x' })).reason).toBe('stage_out_of_order');
    await op({ type: 'milestone', task_id: t.id, code: 'tank_filled', litres: 8000 });
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'tank_discharged', litres: 8500, received_by: 'الحارس' })).reason).toBe('more_than_loaded');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'tank_discharged', litres: 7400 })).reason).toBe('receiver_required');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tank_discharged', litres: 7400, received_by: 'الحارس' })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    o = (await get(`/v1/tankers/orders/${order.id}`).expect(200)).body;
    expect(o).toMatchObject({ state: 'delivered', delivered_l: 7400, received_by: 'الحارس', loss_l: 600, loss_pct: 7.5, loss_flag: true, short: true, amount: '25.900' });
    const ex = (await get('/v1/tankers/exceptions').expect(200)).body;
    expect(ex.losses.map((x: { ref: string }) => x.ref)).toContain(order.ref);
    expect(ex.short.map((x: { ref: string }) => x.ref)).toContain(order.ref);
  });

  it('a standing order creates the day\'s order once; the office records a paper ticket', async () => {
    const dow = new Date(`${kwDay(1)}T12:00:00Z`).getUTCDay();
    await post('/v1/tankers/schedules', { legal_entity_id: le, customer_id: client, site, product: 'diesel', qty_l: 5000, days: [dow], at_time: '25:00' }).expect(400);
    await post('/v1/tankers/schedules', { legal_entity_id: le, customer_id: client, site, product: 'diesel', qty_l: 5000, days: [dow], at_time: '07:30', unit_price: '120.000' }).expect(201);
    const g = (await post('/v1/tankers/schedules/generate', { date: kwDay(1) }).expect(200)).body;
    expect(g.created).toHaveLength(1);
    expect((await post('/v1/tankers/schedules/generate', { date: kwDay(1) }).expect(200)).body.created).toHaveLength(0);
    const o = (await get(`/v1/tankers/orders?date=${kwDay(1)}`).expect(200)).body.data[0];
    expect(o).toMatchObject({ product: 'diesel', qty_l: 5000, unit_price: '120.000', state: 'new' });
    expect(new Date(o.wanted_from).toISOString()).toBe(new Date(`${kwDay(1)}T07:30:00+03:00`).toISOString());
    await post(`/v1/tankers/orders/${o.id}/assign`, { driver_worker_id: d2, asset_id: fuel }).expect(201);
    await post(`/v1/tankers/orders/${o.id}/record`, { loaded_l: 5000, delivered_l: 4990, received_by: 'مشرف المولد' }).expect(200);
    const r = (await get(`/v1/tankers/orders/${o.id}`).expect(200)).body;
    expect(r).toMatchObject({ state: 'delivered', loss_l: 10, loss_flag: false, amount: '598.800' });
  });

  it('the report', async () => {
    const r = (await get(`/v1/tankers/report?from=${kwDay(-1)}&to=${kwDay(2)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ orders: 2, delivered: 2, delivered_l: 12390, loss_l: 610, amount: '624.700' });
    expect(r.products.find((p: { product: string }) => p.product === 'diesel')).toMatchObject({ delivered_l: 4990 });
    expect(r.tankers).toHaveLength(2);
  });
});
