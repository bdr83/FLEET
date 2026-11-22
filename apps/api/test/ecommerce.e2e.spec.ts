/**
 * E-commerce shipping (ecommerce pack, sector 9): stores get API keys and send orders (idempotent), which become courier
 * parcels or, for a store that keeps stock with us, warehouse orders; the store reads status changes, cancels, asks for a
 * return; office import, exceptions and the store's statement from the core books.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('E-commerce pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string;
  let driver: { token: string; id: string };
  let storeA: string, storeB: string, keyA: string, keyB: string, keyAId: string;
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const put = (path: string, body: Record<string, unknown>, token = T) => request(http).put(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const api = (method: 'get' | 'post', path: string, key: string, body?: Record<string, unknown>) => {
    const r = request(http)[method](`/v1/ecom/api${path}`).set('x-api-key', key);
    return body ? r.send(body) : r;
  };
  const kwDay = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const order = (ext: string, extra: Record<string, unknown> = {}) => ({ external_id: ext, recipient: { name: 'مها', phone: '+96550001234' }, dropoff: { area: 'الجابرية', block: '9' }, ...extra });
  async function op(o: Record<string, unknown>) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, driver.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'شحن المتاجر', packs: ['ecommerce', 'courier', 'warehouse'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'courier', display_name: 'سعود', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    storeA = (await post('/v1/customers', { legal_entity_id: le, name: 'متجر الأزياء' }).expect(201)).body.id;
    storeB = (await post('/v1/customers', { legal_entity_id: le, name: 'متجر العطور' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a store with its pickup address and an API key shown once', async () => {
    await post(`/v1/ecommerce/merchants/${storeA}/keys`, {}).expect(409); // not a store yet
    await put(`/v1/ecommerce/merchants/${storeA}`, { pickup: { area: 'الري', phone: '12' } }).expect(400);
    const m = (await put(`/v1/ecommerce/merchants/${storeA}`, { pickup: { name: 'مستودع المتجر', area: 'الري', phone: '+96550009999' }, default_service: 'same_day' }).expect(200)).body;
    expect(m).toMatchObject({ default_service: 'same_day', max_attempts: 3, active: true });
    const k = (await post(`/v1/ecommerce/merchants/${storeA}/keys`, { label: 'سلة' }).expect(201)).body;
    expect(k.key).toMatch(/^fpk_[a-z0-9]{10}_[A-Za-z0-9_-]{32}$/);
    keyA = k.key; keyAId = k.id;
    const list = (await get(`/v1/ecommerce/merchants/${storeA}/keys`).expect(200)).body.data;
    expect(list[0].hint).toBe(`${keyA.slice(0, 15)}…`);
    expect(JSON.stringify(list)).not.toContain(keyA.slice(16));
  });

  it('the store API: key required, orders idempotent on the store order id', async () => {
    await api('post', '/orders', 'nope', order('X')).expect(401);
    await api('post', '/orders', keyA.slice(0, -1) + (keyA.endsWith('A') ? 'B' : 'A'), order('X')).expect(401);
    await api('post', '/orders', keyA, order('bad id!')).expect(400);
    await api('post', '/orders', keyA, { ...order('A-1'), recipient: { name: 'x' } }).expect(400);
    const r = (await api('post', '/orders', keyA, order('A-1001', { cod_amount: '7.500', items: [{ name: 'فستان', qty: 1 }, { sku: 'BAG', qty: 2 }] })).expect(201)).body;
    expect(r).toMatchObject({ external_id: 'A-1001', status: 'confirmed', cod_amount: '7.500', duplicate: false });
    expect(r.awb).toMatch(/^KW\d{10}$/);
    expect(r.tracking_url).toMatch(/\/track\/[A-Za-z0-9_-]{32}/);
    expect((await api('post', '/orders', keyA, order('A-1001')).expect(200)).body).toMatchObject({ awb: r.awb, duplicate: true });
    const parcel = (await get(`/v1/courier/parcels/${r.awb}`).expect(200)).body;
    expect(parcel).toMatchObject({ service: 'same_day', shipper_name: 'متجر الأزياء' });
    expect(parcel.attributes).toMatchObject({ external_order_id: 'A-1001', items_count: 3, pickup: { area: 'الري' } });
    await api('post', '/orders', keyA, order('A-1002')).expect(201);
    expect((await api('post', '/orders/A-1002/cancel', keyA, {}).expect(200)).body.status).toBe('canceled');
    expect((await api('get', `/orders?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`, keyA).expect(200)).body.data.map((x: { external_id: string }) => x.external_id)).toEqual(expect.arrayContaining(['A-1001', 'A-1002']));
    await api('get', '/orders/NOPE', keyA).expect(404);
  });

  it('delivered with COD; the store sees it and asks for a return', async () => {
    const id = (await get(`/v1/ecommerce/orders?q=A-1001`).expect(200)).body.data[0].task_id;
    const t = (await get(`/v1/tasks/${id}`).expect(200)).body;
    await post(`/v1/tasks/${id}/assign`, { version: t.version, worker_id: driver.id }).expect(200);
    await op({ type: 'task_status', task_id: id, to_status: 'accepted' });
    expect((await api('get', '/orders/A-1001', keyA).expect(200)).body.status).toBe('confirmed');
    await op({ type: 'task_status', task_id: id, to_status: 'in_progress' });
    expect((await api('get', '/orders/A-1001', keyA).expect(200)).body.status).toBe('out_for_delivery');
    await api('post', '/orders/A-1001/cancel', keyA, {}).expect(409);
    const pin = (await get(`/v1/delivery/tasks/${id}`).expect(200)).body.link.pin;
    await op({ type: 'pod', task_id: id, method: 'pin', pin });
    await post('/v1/driver/cod', { client_op_id: randomUUID(), task_id: id, amount: '7.500' }, driver.token).expect(201);
    expect(await op({ type: 'task_status', task_id: id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    expect((await api('get', '/orders/A-1001', keyA).expect(200)).body).toMatchObject({ status: 'delivered', cod_collected: '7.500' });
    const r = (await api('post', '/orders/A-1001/return', keyA, { reason: 'المقاس غير مناسب' }).expect(200)).body;
    expect(r.return_status).toBe('ready');
    await api('post', '/orders/A-1001/return', keyA, { reason: 'x' }).expect(409);
  });

  it('office import: each line created, duplicate or reported', async () => {
    const r = (await post('/v1/ecommerce/orders', { customer_id: storeA, orders: [order('A-2001'), order('A-2002', { cod_amount: '3' }), order('A-1001'), { external_id: 'A-2003' }] }).expect(201)).body.results;
    expect(r.map((x: { result: string }) => x.result)).toEqual(['created', 'created', 'duplicate', 'error']);
    expect(r[3].error).toMatch(/recipient/);
  });

  it('a store that keeps its stock with us: orders become warehouse orders, then a delivery', async () => {
    const wh = (await post('/v1/warehouse/warehouses', { legal_entity_id: le, code: 'EC1', name: 'مستودع المتاجر' }).expect(201)).body.id;
    const loc = (await post(`/v1/warehouse/warehouses/${wh}/locations`, { codes: ['P-01'] }).expect(201)).body.locations[0].id;
    const item = (await post('/v1/warehouse/items', { legal_entity_id: le, customer_id: storeB, sku: 'OUD-50', name: 'عطر عود 50مل' }).expect(201)).body.id;
    await post('/v1/warehouse/receipts', { warehouse_id: wh, customer_id: storeB, ref: 'B-IN-1', lines: [{ item_id: item, qty: 10, location_id: loc }] }).expect(201);
    await put(`/v1/ecommerce/merchants/${storeB}`, { pickup: { area: 'الشويخ', phone: '+96550008888' }, warehouse_id: wh }).expect(200);
    keyB = (await post(`/v1/ecommerce/merchants/${storeB}/keys`, {}).expect(201)).body.key;
    await api('post', '/orders', keyB, order('B-1', { items: [{ name: 'عطر', qty: 1 }] })).expect(400); // needs sku
    await api('post', '/orders', keyB, order('B-1', { items: [{ sku: 'NOPE', qty: 1 }] })).expect(400);
    expect((await api('post', '/orders', keyB, order('B-1', { items: [{ sku: 'OUD-50', qty: 2 }] })).expect(201)).body.status).toBe('processing');
    const o = (await get(`/v1/ecommerce/orders?customer_id=${storeB}`).expect(200)).body.data[0];
    await post(`/v1/warehouse/orders/${o.wh_order_id}/pick`, {}).expect(200);
    expect((await api('get', '/orders/B-1', keyB).expect(200)).body.status).toBe('ready_to_ship');
    await post(`/v1/warehouse/orders/${o.wh_order_id}/ship`, { delivery: true }).expect(200);
    const s = (await api('get', '/orders/B-1', keyB).expect(200)).body;
    expect(s.status).toBe('confirmed');
    expect(s.tracking_url).toBeTruthy();
    // a store only sees its own orders
    await api('get', '/orders/A-1001', keyB).expect(404);
  });

  it('a revoked key stops working; exceptions and the statement', async () => {
    await post(`/v1/ecommerce/keys/${keyAId}/revoke`, {}).expect(200);
    await api('get', '/orders/A-1001', keyA).expect(401);
    const e = (await get('/v1/ecommerce/exceptions').expect(200)).body;
    expect(e.returns_open.map((x: { external_id: string }) => x.external_id)).toContain('A-1001');
    expect(e.cod_owed.find((x: { customer_id: string }) => x.customer_id === storeA)).toMatchObject({ owed: '7.500' });
    const st = (await get(`/v1/ecommerce/merchants/${storeA}/statement?from=${kwDay()}&to=${kwDay()}`).expect(200)).body;
    expect(st).toMatchObject({ orders: 4, delivered: 1, canceled: 1, open: 2, cod_collected: '7.500', cod_held_now: '7.500', invoices_due_now: '0.000', net_payable_now: '7.500' });
    expect((await get('/v1/ecommerce/merchants').expect(200)).body.data.find((m: { customer_id: string }) => m.customer_id === storeA)).toMatchObject({ keys: 0, orders: 4 });
  });
});
