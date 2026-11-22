/**
 * Own-fleet distribution (distribution@1): the product catalogue, planning a day route (vehicle and driver booked for the day,
 * one task per stop), the driver's load check, leaving the depot, stops with delivered and returned quantities and cash, a
 * closed shop, back at the depot, the cash settlement with its variance, cancel, exceptions and the distribution report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('Distribution pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let driver: { token: string; id: string };
  let other: { token: string; id: string };
  let truck: string;
  let truck2: string;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  async function op(token: string, o: Record<string, unknown>) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }
  // today, the whole day so the test runs at any hour
  const routeBody = (extra: Record<string, unknown> = {}) => ({
    legal_entity_id: A.legal_entity_id, route_date: kwDay(), asset_id: truck, driver_worker_id: driver.id, start_time: '00:00', end_time: '23:59',
    stops: [
      { name: 'فرع السالمية', address: 'السالمية، ق 10', phone: '+96550000031', lat: 29.33, lng: 48.07, payment: 'credit', items: [{ sku: 'MLK-1L', qty: 24 }, { sku: 'BRD', qty: 10 }] },
      { name: 'بقالة الرميثية', payment: 'cash', items: [{ sku: 'MLK-1L', qty: 12 }, { sku: 'JCE', qty: 6, name: 'عصير برتقال', price: '0.500' }] },
      { name: 'جمعية حولي', payment: 'cash', items: [{ sku: 'BRD', qty: 20 }] },
    ], ...extra,
  });

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'ألبان الخليج');
    B = await onboard(app, 'شركة ب');
    const mk = async (name: string) => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: name, phone }).expect(201)).body;
      return { token: (await joinAs(app, A.tenant.id, phone)).access_token, id: w.id };
    };
    driver = await mk('مبارك سائق التوزيع');
    other = await mk('سائق آخر');
    truck = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'truck', plate_no: `T-${Date.now() % 100000}`, odometer_km: 120_000 }).expect(201)).body.id;
    truck2 = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'truck', plate_no: `U-${Date.now() % 100000}` }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('keeps a product catalogue per legal entity', async () => {
    await post('/v1/distribution/products', { legal_entity_id: A.legal_entity_id, sku: 'MLK-1L', name: 'حليب 1 لتر', unit: 'carton', price: '0.350' }).expect(201);
    await post('/v1/distribution/products', { legal_entity_id: A.legal_entity_id, sku: 'BRD', name: 'خبز عربي', price: '0.125' }).expect(201);
    await post('/v1/distribution/products', { legal_entity_id: A.legal_entity_id, sku: 'BRD', name: 'x' }).expect(409);
    await post('/v1/distribution/products', { legal_entity_id: A.legal_entity_id, sku: 'bad sku', name: 'x' }).expect(400);
    await post('/v1/distribution/products', { legal_entity_id: A.legal_entity_id, sku: 'X1', name: 'x', price: '1.2345' }).expect(400);
    expect((await get('/v1/distribution/products').expect(200)).body.data.map((p: { sku: string }) => p.sku)).toEqual(['BRD', 'MLK-1L']);
    expect((await get('/v1/distribution/products', B.access_token).expect(200)).body.data).toEqual([]);
  });

  let route: { id: string; ref: string; task_id: string; version: number; stops: { task_id: string; seq: number; items: { sku: string; name: string; price: string }[] }[]; load: unknown[] };
  it('plans a route: load list, one task per stop, the vehicle and driver booked for the day', async () => {
    await post('/v1/distribution/routes', routeBody({ stops: [] })).expect(400);
    await post('/v1/distribution/routes', routeBody({ stops: [{ name: 'x', items: [{ sku: 'NOPE', qty: 1 }] }] })).expect(400); // not in the catalogue
    await post('/v1/distribution/routes', routeBody({ stops: [{ name: 'x', items: [{ sku: 'BRD', qty: 1 }, { sku: 'BRD', qty: 2 }] }] })).expect(400);
    await post('/v1/distribution/routes', routeBody({ route_date: kwDay(-1) })).expect(400);
    await post('/v1/distribution/routes', routeBody(), driver.token).expect(403);
    route = (await post('/v1/distribution/routes', routeBody()).expect(201)).body;
    expect(route).toMatchObject({ status: 'planned', stops: expect.any(Array), driver_name: 'مبارك سائق التوزيع' });
    expect(route.ref).toMatch(/^DR-\d+$/);
    expect(route.load).toEqual([
      { sku: 'BRD', name: 'خبز عربي', qty: 30 }, { sku: 'JCE', name: 'عصير برتقال', qty: 6 }, { sku: 'MLK-1L', name: 'حليب 1 لتر', qty: 36 }]);
    expect(route.stops.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(route.stops[0].items[0]).toMatchObject({ sku: 'MLK-1L', name: 'حليب 1 لتر', price: '0.350' });
    // the same truck or the same driver cannot take a second route that day
    await post('/v1/distribution/routes', routeBody({ driver_worker_id: other.id })).expect(409);
    await post('/v1/distribution/routes', routeBody({ asset_id: truck2 })).expect(409);
    await get(`/v1/distribution/routes/${route.id}`, B.access_token).expect(404);
    // the driver sees the route first, then the stops in order
    const mine = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data.filter((t: { sector_pack: string }) => t.sector_pack === 'distribution@1');
    expect(mine.map((t: { ref: string }) => t.ref)).toEqual([route.ref, `${route.ref}-1`, `${route.ref}-2`, `${route.ref}-3`]);
    expect(mine[0].attributes).toMatchObject({ kind: 'route', stops: 3 });
    expect(mine[1].attributes).toMatchObject({ kind: 'stop', seq: 1, name: 'فرع السالمية', payment: 'credit' });
  });

  it('the driver checks the load and leaves; stops open only then', async () => {
    const [s1] = route.stops;
    expect(await op(driver.token, { type: 'stop', task_id: s1.task_id, delivered: { 'MLK-1L': 24 } })).toMatchObject({ result: 'rejected', reason: 'route_not_started' });
    expect((await op(driver.token, { type: 'task_status', task_id: route.task_id, to_status: 'accepted' })).result).toBe('applied');
    expect(await op(driver.token, { type: 'task_status', task_id: route.task_id, to_status: 'in_progress' })).toMatchObject({ result: 'rejected', reason: 'stage_out_of_order' });
    expect(await op(driver.token, { type: 'milestone', task_id: route.task_id, code: 'load_checked', odometer_km: 100 })).toMatchObject({ result: 'rejected', reason: 'odometer_too_low' });
    expect(await op(driver.token, { type: 'milestone', task_id: s1.task_id, code: 'load_checked' })).toMatchObject({ result: 'rejected', reason: 'not_supported' });
    expect((await op(driver.token, { type: 'milestone', task_id: route.task_id, code: 'load_checked', odometer_km: 120_010 })).result).toBe('applied');
    expect((await get(`/v1/distribution/routes/${route.id}`).expect(200)).body.status).toBe('loaded');
    expect((await op(driver.token, { type: 'task_status', task_id: route.task_id, to_status: 'in_progress' })).result).toBe('applied');
    const r = (await get(`/v1/distribution/routes/${route.id}`).expect(200)).body;
    expect(r.status).toBe('out');
    expect(r.stops.map((s: { status: string }) => s.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(await op(driver.token, { type: 'task_status', task_id: s1.task_id, to_status: 'in_progress' })).toMatchObject({ result: 'rejected', reason: 'not_supported' });
  });

  it('stops: delivered and returned quantities, cash, a closed shop', async () => {
    const [s1, s2, s3] = route.stops;
    expect(await op(driver.token, { type: 'stop', task_id: s1.task_id, delivered: { 'MLK-1L': 25 } })).toMatchObject({ result: 'rejected', reason: 'quantity_exceeds_plan' });
    expect(await op(driver.token, { type: 'stop', task_id: s1.task_id, delivered: { JCE: 1 } })).toMatchObject({ result: 'rejected', reason: 'item_not_planned' });
    await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), type: 'stop', task_id: s1.task_id }] }, driver.token).expect(400);
    // the branch takes 22 of 24 milk and all the bread, and gives back 3 expired milk
    expect((await op(driver.token, { type: 'stop', task_id: s1.task_id, delivered: { 'MLK-1L': 22, BRD: 10 }, returned: { 'MLK-1L': 3 }, received_by: 'أمين المخزن' })).result).toBe('applied');
    expect(await op(driver.token, { type: 'stop', task_id: s1.task_id, delivered: { 'MLK-1L': 1 } })).toMatchObject({ result: 'rejected', reason: 'stop_already_recorded' });
    // cash shop: 12 × 0.350 + 6 × 0.500 = 7.200 due; the driver collects 7.000
    expect(await op(driver.token, { type: 'stop', task_id: s2.task_id, delivered: { 'MLK-1L': 12, JCE: 6 } })).toMatchObject({ result: 'rejected', reason: 'cash_required' });
    expect((await op(driver.token, { type: 'stop', task_id: s2.task_id, delivered: { 'MLK-1L': 12, JCE: 6 }, cash_collected: '7.000' })).result).toBe('applied');
    // the driver cannot come back while a stop is open
    expect(await op(driver.token, { type: 'milestone', task_id: route.task_id, code: 'route_back', odometer_km: 120_090 })).toMatchObject({ result: 'rejected', reason: 'stops_open' });
    expect((await op(driver.token, { type: 'stop', task_id: s3.task_id, closed_reason: 'shop_closed', note: 'مغلق للجرد' })).result).toBe('applied');
    const r = (await get(`/v1/distribution/routes/${route.id}`).expect(200)).body;
    expect(r.stops.map((s: { status: string }) => s.status)).toEqual(['completed', 'completed', 'failed']);
    expect(r.stops[0]).toMatchObject({ delivered: { 'MLK-1L': 22, BRD: 10 }, returned: { 'MLK-1L': 3 }, cash_due: '0.000', received_by: 'أمين المخزن' });
    expect(r.stops[1]).toMatchObject({ cash_due: '7.200', cash_collected: '7.000' });
    expect(r).toMatchObject({ stops_done: 3, stops_failed: 1, cash_due: '7.200', cash_collected: '7.000' });
    // what should come back to the warehouse: milk 36 − 34 + 3 = 5, bread 30 − 10 = 20
    expect(r.reconcile).toEqual([
      { sku: 'BRD', name: 'خبز عربي', loaded: 30, delivered: 10, returned: 0, back: 20 },
      { sku: 'JCE', name: 'عصير برتقال', loaded: 6, delivered: 6, returned: 0, back: 0 },
      { sku: 'MLK-1L', name: 'حليب 1 لتر', loaded: 36, delivered: 34, returned: 3, back: 5 },
    ]);
    const ex = (await get('/v1/distribution/exceptions').expect(200)).body;
    expect(ex.short.map((s: { task_id: string }) => s.task_id)).toEqual([s2.task_id]);
    expect(ex.failed.map((s: { task_id: string }) => s.task_id)).toEqual([s3.task_id]);
    expect(ex.returns.map((s: { task_id: string }) => s.task_id)).toEqual([s1.task_id]);
  });

  it('back at the depot; the office settles the cash and the variance needs a note', async () => {
    expect(await op(driver.token, { type: 'task_status', task_id: route.task_id, to_status: 'completed' })).toMatchObject({ result: 'rejected', reason: 'stage_out_of_order' });
    expect((await op(driver.token, { type: 'milestone', task_id: route.task_id, code: 'route_back', odometer_km: 120_095 })).result).toBe('applied');
    expect((await op(driver.token, { type: 'task_status', task_id: route.task_id, to_status: 'completed' })).result).toBe('applied');
    let r = (await get(`/v1/distribution/routes/${route.id}`).expect(200)).body;
    expect(r).toMatchObject({ status: 'back', km: 85, task_status: 'completed' });
    await post(`/v1/distribution/routes/${route.id}/settle`, { version: r.version, cash_received: '6.500' }).expect(400); // differs: a note is needed
    await post(`/v1/distribution/routes/${route.id}/settle`, { version: r.version, cash_received: '6.500', note: 'x' }, driver.token).expect(403);
    r = (await post(`/v1/distribution/routes/${route.id}/settle`, { version: r.version, cash_received: '6.500', note: 'نقص نصف دينار يُخصم' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'settled', cash_received: '6.500', variance: '-0.500' });
    await post(`/v1/distribution/routes/${route.id}/settle`, { version: r.version, cash_received: '6.500', note: 'x' }).expect(409);
    await post(`/v1/distribution/routes/${route.id}/cancel`, { version: r.version, reason: 'x' }).expect(409);
  });

  it('a route not started can be canceled, which frees the truck and driver', async () => {
    const r = (await post('/v1/distribution/routes', routeBody({ route_date: kwDay(1), asset_id: truck2, driver_worker_id: other.id, stops: [{ name: 'فرع الفحيحيل', items: [{ sku: 'BRD', qty: 5 }] }] })).expect(201)).body;
    await post(`/v1/distribution/routes/${r.id}/cancel`, { version: r.version }).expect(400);
    const c = (await post(`/v1/distribution/routes/${r.id}/cancel`, { version: r.version, reason: 'عطلة' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'canceled', task_status: 'canceled' });
    expect(c.stops[0].status).toBe('canceled');
    await post('/v1/distribution/routes', routeBody({ route_date: kwDay(1), asset_id: truck2, driver_worker_id: other.id })).expect(201);
  });

  it('the day board and the distribution report', async () => {
    const b = (await get(`/v1/distribution/board?date=${kwDay()}`).expect(200)).body;
    expect(b.totals).toMatchObject({ routes: 1, stops: 3, stops_done: 3, cash_due: '7.200', cash_collected: '7.000', unsettled: 0 });
    await get(`/v1/distribution/report?from=${kwDay()}`).expect(400);
    const rep = (await get(`/v1/distribution/report?from=${kwDay()}&to=${kwDay()}`).expect(200)).body;
    // planned: 24×0.350 + 10×0.125 + 12×0.350 + 6×0.500 + 20×0.125 = 19.350; delivered 22×0.350 + 10×0.125 + 7.200 = 16.150; returned 3×0.350
    expect(rep.data[0]).toMatchObject({ ref: route.ref, km: 85, planned_value: '19.350', delivered_value: '16.150', returned_value: '1.050', cash_received: '6.500', variance: '-0.500' });
    expect(rep.totals).toMatchObject({ routes: 1, km: 85, variance: '-0.500' });
    await get(`/v1/distribution/report?from=${kwDay()}&to=${kwDay()}`, driver.token).expect(403);
  });
});
