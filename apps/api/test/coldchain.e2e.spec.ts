/**
 * Food distribution and cold chain (coldchain pack, sector 3): a company with only this pack uses the distribution routes,
 * plans a chilled route with delivery windows and item expiry, the driver logs temperatures, a stop takes damaged goods,
 * a shop refuses for temperature; exceptions and the KPIs report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Cold chain pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string;
  let driver: { token: string; id: string };
  let truck: string;
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  async function op(o: Record<string, unknown>, at = new Date().toISOString()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, driver.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'مبردات الخليج', packs: ['coldchain'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'راشد سائق المبرد', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    truck = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CF-${Date.now() % 100000}` }).expect(201)).body.id;
    await post('/v1/distribution/products', { legal_entity_id: le, sku: 'CHK', name: 'دجاج مبرد', unit: 'kg', price: '1.500' }).expect(201);
    await post('/v1/distribution/products', { legal_entity_id: le, sku: 'YGT', name: 'لبن زبادي', unit: 'carton', price: '2.000' }).expect(201);
  });
  afterAll(async () => app?.close());

  let route: { id: string; task_id: string; version: number; temp_min: number; temp_max: number; stops: { task_id: string; window_from: string | null; window_to: string | null; items: { expiry?: string }[] }[] };
  it('a cold-chain-only company plans a chilled route with windows and expiry; other packs stay closed', async () => {
    await get('/v1/delivery/settings?legal_entity_id=' + le).expect(403);
    await post('/v1/distribution/routes', { legal_entity_id: le, route_date: kwDay(), asset_id: truck, driver_worker_id: driver.id, temp_class: 'chilled', temp_min: 5, temp_max: 0,
      stops: [{ name: 'x', items: [{ sku: 'CHK', qty: 1 }] }] }).expect(400);
    await post('/v1/distribution/routes', { legal_entity_id: le, route_date: kwDay(), asset_id: truck, driver_worker_id: driver.id,
      stops: [{ name: 'x', window_from: '10:00', window_to: '09:00', items: [{ sku: 'CHK', qty: 1 }] }] }).expect(400);
    route = (await post('/v1/distribution/routes', {
      legal_entity_id: le, route_date: kwDay(), asset_id: truck, driver_worker_id: driver.id, start_time: '00:00', end_time: '23:59', temp_class: 'chilled',
      stops: [
        { name: 'مطعم الشاطئ', window_from: '00:00', window_to: '23:59', items: [{ sku: 'CHK', qty: 40 }, { sku: 'YGT', qty: 10, expiry: kwDay() }] },
        { name: 'سوبرماركت السلام', window_from: '00:00', window_to: '00:01', items: [{ sku: 'YGT', qty: 20 }] },
        { name: 'بقالة النخيل', items: [{ sku: 'CHK', qty: 5 }] },
      ],
    }).expect(201)).body;
    expect(route).toMatchObject({ temp_class: 'chilled', temp_min: 0, temp_max: 5, last_reading: null });
    expect(route.stops[0].window_to).toBeTruthy();
    expect(route.stops[2].window_from).toBeNull();
    expect(route.stops[0].items[1].expiry).toBe(kwDay());
    const t = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data.find((x: { id: string }) => x.id === route.task_id);
    expect(t.attributes).toMatchObject({ temp_class: 'chilled', temp_min: 0, temp_max: 5 });
  });

  it('temperatures from the driver and from a logger are checked against the range', async () => {
    expect((await op({ type: 'temp', task_id: route.task_id, reading_c: 3 })).reason).toBe('invalid_stage'); // not accepted yet
    await op({ type: 'task_status', task_id: route.task_id, to_status: 'accepted' });
    expect((await op({ type: 'temp', task_id: route.task_id, reading_c: 3.5 })).result).toBe('applied');
    expect((await op({ type: 'temp', task_id: route.stops[0].task_id, reading_c: 3 })).reason).toBe('not_supported'); // on the route, not a stop task
    await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), type: 'temp', task_id: route.task_id, reading_c: 99 }] }, driver.token).expect(400);
    await post(`/v1/distribution/routes/${route.id}/temps`, { reading_c: 7.2, source: 'device' }).expect(400); // device needs its reference
    const r = (await post(`/v1/distribution/routes/${route.id}/temps`, { reading_c: 7.2, source: 'device', device_ref: 'LOGGER-17' }).expect(201)).body;
    expect(r.temps.map((x: { reading_c: number; in_range: boolean; source: string }) => [x.reading_c, x.in_range, x.source])).toEqual([[3.5, true, 'manual'], [7.2, false, 'device']]);
    expect(r.last_reading).toMatchObject({ reading_c: 7.2, in_range: false });
  });

  it('stops: damaged goods, a refusal for temperature, then back at the depot', async () => {
    await op({ type: 'milestone', task_id: route.task_id, code: 'load_checked', odometer_km: 5000 });
    await op({ type: 'task_status', task_id: route.task_id, to_status: 'in_progress' });
    expect((await op({ type: 'stop', task_id: route.stops[0].task_id, delivered: { CHK: 38, YGT: 10 }, damaged: { CHK: 2 }, received_by: 'الشيف علي' })).result).toBe('applied');
    expect((await op({ type: 'temp', task_id: route.task_id, reading_c: 4, stop_task_id: route.stops[1].task_id })).result).toBe('applied');
    expect((await op({ type: 'stop', task_id: route.stops[1].task_id, closed_reason: 'temp_out_of_range', note: 'رفض لارتفاع الحرارة' })).result).toBe('applied');
    expect((await op({ type: 'stop', task_id: route.stops[2].task_id, delivered: { CHK: 5 }, returned: { YGT: 1 } })).result).toBe('applied');
    expect((await op({ type: 'milestone', task_id: route.task_id, code: 'route_back', odometer_km: 5060 })).result).toBe('applied');
    const d = (await get(`/v1/distribution/routes/${route.id}`).expect(200)).body;
    expect(d.stops[0].damaged).toEqual({ CHK: 2 });
    expect(d.stops[1].closed_reason).toBe('temp_out_of_range');
  });

  it('exceptions: out-of-range reading, late stop, expiring items, damaged goods', async () => {
    const e = (await get('/v1/coldchain/exceptions').expect(200)).body;
    expect(e.out_of_range.map((x: { reading_c: number; device_ref: string }) => [x.reading_c, x.device_ref])).toContainEqual([7.2, 'LOGGER-17']);
    expect(e.damaged.find((x: { route_id: string }) => x.route_id === route.id)).toMatchObject({ damaged: { CHK: 2 }, value: '3.000' });
    expect(e.late.map((x: { task_id: string }) => x.task_id)).not.toContain(route.stops[1].task_id); // refused, not delivered late
    expect(e.no_reading.map((x: { route_id: string }) => x.route_id)).not.toContain(route.id); // back at the depot
    // a second chilled route planned today with an item that expires today shows as expiring and, once loaded, as missing readings
    const r2 = (await post('/v1/distribution/routes', { legal_entity_id: le, route_date: kwDay(1), asset_id: truck, driver_worker_id: driver.id, temp_class: 'frozen',
      stops: [{ name: 'فندق', window_from: '06:00', window_to: '08:00', items: [{ sku: 'CHK', qty: 3, expiry: kwDay() }] }] }).expect(201)).body;
    expect(r2).toMatchObject({ temp_min: -25, temp_max: -18 });
    const e2 = (await get('/v1/coldchain/exceptions').expect(200)).body;
    expect(e2.expiring.find((x: { route_id: string }) => x.route_id === r2.id)).toMatchObject({ sku: 'CHK', expiry: kwDay() });
  });

  it('report: on-time, spoilage, return rate, productivity and temperature compliance', async () => {
    const r = (await get(`/v1/coldchain/report?from=${kwDay()}&to=${kwDay()}`).expect(200)).body;
    const row = r.data.find((x: { id: string }) => x.id === route.id);
    expect(row).toMatchObject({ stops: 3, delivered_stops: 2, refused_stops: 1, on_time_stops: 2, delivered_value: '84.500', damaged_value: '3.000', returned_value: '0.000', readings: 3, readings_out: 1 });
    // CHK 43 × 1.5 + YGT 10 × 2 = 84.5; YGT returned at bakery not on its stop = 0
    expect(r.totals).toMatchObject({ routes: 1, on_time_pct: 100, temp_compliance_pct: 66.7 });
    expect(r.totals.spoilage_pct).toBe(3.4); // 3 / (84.5 + 3)
  });
});
