/**
 * Taxi and limousine (taxi pack, sector 12): cars by class and the class tariffs; bookings (now, later, airport, corporate
 * account, fixed fare); candidates and assignment of a car of the class and a driver; the driver arrives, picks up and
 * drops with km and payment, the fare from the tariff; a no-show only after waiting; exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Taxi pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, account: string, sedan: string, lux: string, van: string;
  let d1: { token: string; id: string }, d2: { token: string; id: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const put = (path: string, body: Record<string, unknown>, token = T) => request(http).put(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  async function op(o: Record<string, unknown>, token = d1.token, at = new Date()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at.toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }
  const taskOf = async (token: string, ref: string) => (await get('/v1/driver/tasks', token).expect(200)).body.data.find((x: { ref: string }) => x.ref.startsWith(ref));

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'تاكسي الطلب', packs: ['taxi'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const driver = async (name: string) => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: name, phone }).expect(201)).body;
      return { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    };
    d1 = await driver('سالم'); d2 = await driver('راشد');
    const car = async (type: string, plate: string) => (await post('/v1/assets', { legal_entity_id: le, asset_type: type, plate_no: `${plate}-${Date.now() % 100000}` }).expect(201)).body.id;
    sedan = await car('car', 'TX1'); lux = await car('car', 'LX1'); van = await car('van', 'VN1');
    account = (await post('/v1/customers', { legal_entity_id: le, name: 'شركة الخليج للاستشارات', kind: 'business' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('cars by class and the class tariffs', async () => {
    await put(`/v1/taxi/cars/${sedan}`, { class: 'bus' }).expect(400);
    await put(`/v1/taxi/cars/${sedan}`, { class: 'sedan' }).expect(200);
    await put(`/v1/taxi/cars/${lux}`, { class: 'luxury' }).expect(200);
    await put(`/v1/taxi/cars/${van}`, { class: 'van' }).expect(200);
    const cars = (await get('/v1/taxi/cars').expect(200)).body.data;
    expect(cars.filter((x: { class: string | null }) => x.class).length).toBe(3);
    await put('/v1/taxi/tariffs', { legal_entity_id: le, class: 'sedan', base: '0.350' }).expect(400);
    expect((await put('/v1/taxi/tariffs', { legal_entity_id: le, class: 'sedan', base: '0.350', per_km: '0.150', per_wait_min: '0.050', min_fare: '1.000' }).expect(200)).body)
      .toMatchObject({ class: 'sedan', base: '0.350', min_fare: '1.000' });
    expect((await get('/v1/taxi/tariffs').expect(200)).body.data).toHaveLength(1);
  });

  it('a booking now, assigned to a free sedan and driver; the driver arrives, picks up and drops; the fare from the tariff', async () => {
    await post('/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'x', passenger_phone: '123', pickup: { area: 'حولي' } }).expect(400);
    await post('/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'x', passenger_phone: '+96599112233', pickup: { area: 'حولي' }, flight_no: 'KUWAIT' }).expect(400);
    const b = (await post('/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'محمد', passenger_phone: '+96599112233', pickup: { area: 'حولي', block: '3', street: 'تونس' },
      dropoff: { area: 'الشويخ', name: 'مستشفى الصباح' }, pickup_at: inMin(-10) }).expect(201)).body;
    expect(b).toMatchObject({ ref: expect.stringMatching(/^TX-\d+$/), class: 'sedan', state: 'new', pax: 1 });
    const cand = (await get(`/v1/taxi/bookings/${b.id}/candidates`).expect(200)).body;
    expect(cand.cars.map((x: { asset_id: string }) => x.asset_id).sort()).toEqual([sedan, lux].sort()); // a luxury car may serve a sedan booking
    expect(cand.drivers).toHaveLength(2);
    await post(`/v1/taxi/bookings/${b.id}/assign`, { asset_id: van, driver_worker_id: d1.id }).expect(409);
    expect((await post(`/v1/taxi/bookings/${b.id}/assign`, { asset_id: sedan, driver_worker_id: d1.id }).expect(201)).body).toMatchObject({ state: 'assigned', driver_name: 'سالم' });
    const t = await taskOf(d1.token, b.ref);
    expect(t.attributes).toMatchObject({ kind: 'ride', passenger_name: 'محمد', passenger_phone: '+96599112233', tariff: { per_km: '0.150' }, account: false });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_arrived' })).toMatchObject({ result: 'rejected', reason: 'invalid_stage' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await get(`/v1/taxi/bookings/${b.id}`).expect(200)).body.state).toBe('on_way');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_picked' })).toMatchObject({ result: 'rejected', reason: 'stage_out_of_order' });
    const now = Date.now() - 10 * 60_000;
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_arrived' }, d1.token, new Date(now))).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_picked' }, d1.token, new Date(now + 8 * 60_000))).toMatchObject({ result: 'applied' }); // waited 8 minutes
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'rejected', reason: 'proof_required' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_dropped', trip_km: 10 })).toMatchObject({ result: 'rejected', reason: 'payment_required' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_dropped', payment: 'cash' })).toMatchObject({ result: 'rejected', reason: 'km_required' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_dropped', trip_km: 10, payment: 'account' })).toMatchObject({ result: 'rejected', reason: 'no_account' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'tx_dropped', trip_km: 10, payment: 'cash' }, d1.token, new Date())).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    expect((await get(`/v1/taxi/bookings/${b.id}`).expect(200)).body).toMatchObject({ state: 'done', km: 10, wait_min: 8, fare: '2.000', payment: 'cash' });
  });

  it('an airport transfer on account at a fixed fare in a luxury car; a sedan cannot serve it', async () => {
    const b = (await post('/v1/taxi/bookings', { legal_entity_id: le, customer_id: account, passenger_name: 'Mr. Smith', passenger_phone: '+96599223344', pickup: { name: 'مطار الكويت T4' },
      dropoff: { area: 'شرق', name: 'فندق الشيراتون' }, pickup_at: inMin(120), class: 'luxury', flight_no: 'ba 157', fixed_fare: '12.000', pax: 2 }).expect(201)).body;
    expect(b).toMatchObject({ flight_no: 'BA157', fixed_fare: '12.000', customer_name: 'شركة الخليج للاستشارات' });
    await post(`/v1/taxi/bookings/${b.id}/assign`, { asset_id: sedan, driver_worker_id: d2.id }).expect(409);
    await post(`/v1/taxi/bookings/${b.id}/assign`, { asset_id: lux, driver_worker_id: d2.id }).expect(201);
    // the office records it from the driver's call: account, no km needed with a fixed fare
    expect((await post(`/v1/taxi/bookings/${b.id}/record`, { payment: 'account' }).expect(200)).body).toMatchObject({ state: 'done', fare: '12.000', payment: 'account' });
    await post(`/v1/taxi/bookings/${b.id}/fare`, { fare: '10.000' }).expect(200);
  });

  it('a no-show only after arriving and waiting; reassign after a failure; double booking refused', async () => {
    const b = (await post('/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'سارة', passenger_phone: '+96599334455', pickup: { area: 'السالمية' }, pickup_at: inMin(-12) }).expect(201)).body;
    const r0 = await post(`/v1/taxi/bookings/${b.id}/assign`, { asset_id: lux, driver_worker_id: d2.id });
    expect([r0.status, r0.body.message]).toEqual([201, undefined]);
    // another booking at the same time on the same car is refused
    const c2 = (await post('/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'علي', passenger_phone: '+96599445566', pickup: { area: 'الجابرية' } }).expect(201)).body;
    expect((await post(`/v1/taxi/bookings/${c2.id}/assign`, { asset_id: lux, driver_worker_id: d1.id }).expect(409)).body.message).toMatch(/vehicle_booked/);
    const t = await taskOf(d2.token, b.ref);
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, d2.token);
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, d2.token);
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'failed', reason_code: 'passenger_no_show' }, d2.token)).toMatchObject({ result: 'rejected', reason: 'not_arrived' });
    const now = Date.now() - 12 * 60_000;
    await op({ type: 'milestone', task_id: t.id, code: 'tx_arrived' }, d2.token, new Date(now));
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'failed', reason_code: 'passenger_no_show' }, d2.token, new Date(now + 4 * 60_000))).toMatchObject({ result: 'rejected', reason: 'wait_more' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'failed', reason_code: 'passenger_no_show' }, d2.token, new Date(now + 11 * 60_000))).toMatchObject({ result: 'applied' });
    expect((await get(`/v1/taxi/bookings/${b.id}`).expect(200)).body).toMatchObject({ state: 'failed', fail_reason: 'passenger_no_show' });
    // the passenger calls back: the car is free again for a new attempt
    expect((await post(`/v1/taxi/bookings/${b.id}/assign`, { asset_id: lux, driver_worker_id: d2.id }).expect(201)).body).toMatchObject({ state: 'assigned', attempts: 2 });
    await post(`/v1/taxi/bookings/${b.id}/cancel`, { reason: 'ألغى الراكب' }).expect(200);
    await post(`/v1/taxi/bookings/${c2.id}/cancel`, { reason: 'x' }).expect(200);
  });

  it('exceptions and the report: drivers, accounts, payments', async () => {
    const late = (await post('/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'خالد', passenger_phone: '+96599556677', pickup: { area: 'الفروانية' }, pickup_at: inMin(-12) }).expect(201)).body;
    const soon = (await post('/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'نوف', passenger_phone: '+96599667788', pickup: { area: 'الرميثية' }, pickup_at: inMin(20), class: 'van' }).expect(201)).body;
    await post(`/v1/taxi/bookings/${late.id}/assign`, { asset_id: lux, driver_worker_id: d2.id }).expect(201);
    const e = (await get('/v1/taxi/exceptions').expect(200)).body;
    expect(e.unassigned.map((x: { ref: string }) => x.ref)).toContain(soon.ref);
    expect(e.late.map((x: { ref: string }) => x.ref)).toContain(late.ref);
    const r = (await get(`/v1/taxi/report?from=${kwDay(-1)}&to=${kwDay(1)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ done: 2, no_shows: 0, canceled: 2, cash: '2.000', account: '10.000', fare: '12.000', km: 10 });
    expect(r.drivers.find((x: { driver_name: string }) => x.driver_name === 'سالم')).toMatchObject({ rides: 1, cash: '2.000', km: 10 });
    expect(r.accounts).toEqual([expect.objectContaining({ customer_name: 'شركة الخليج للاستشارات', rides: 1, account: '10.000' })]);
    await get(`/v1/taxi/report?from=${kwDay(1)}&to=${kwDay(-1)}`).expect(400);
  });
});
