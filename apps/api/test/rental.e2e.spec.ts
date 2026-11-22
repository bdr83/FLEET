/**
 * Car rental (rental pack, sector 17): a reservation books the car exclusively; a driver delivers it to the customer from
 * the app (odometer, fuel, the renter's name); the counter checks it in and the charges follow from the agreement's rates
 * (days, extra km, fuel short, damage) against the deposit; traffic fines match the agreement; exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Car rental pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, renter: string, car: string, car2: string, loader: string;
  let drv: { token: string; id: string };
  let ra: { id: string; ref: string };
  let outAt: number;
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const licence = (days: number) => kwDay(days);
  async function op(o: Record<string, unknown>) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, drv.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'تأجير السيارات', packs: ['rental'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التوصيل', phone }).expect(201)).body;
    drv = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    car = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'car', plate_no: `RC-${Date.now() % 100000}`, make: 'Toyota', model: 'Camry', odometer_km: 1000 }).expect(201)).body.id;
    car2 = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'car', plate_no: `RD-${Date.now() % 100000}` }).expect(201)).body.id;
    loader = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'loader', plate_no: `RL-${Date.now() % 100000}` }).expect(201)).body.id;
    renter = (await post('/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'فهد العتيبي', phone: '+96551112222' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a reservation books the car; licences must outlast the rental; no double booking', async () => {
    const base = { legal_entity_id: le, customer_id: renter, asset_id: car, pickup_at: at(0.5), return_due: at(24.5), rate_unit: 'day', rate: '15', km_per_day: 200,
      extra_km_rate: '0.100', fuel_rate: '1.500', deposit: '50', drivers: [{ name: 'فهد العتيبي', phone: '+96551112222', licence_no: 'KW-12345', licence_expiry: licence(30) }] };
    await post('/v1/rental/agreements', { ...base, drivers: [{ name: 'فهد', licence_no: 'X', licence_expiry: kwDay(0) }] }).expect(400); // licence expires before the return
    await post('/v1/rental/agreements', { ...base, asset_id: loader }).expect(400);
    await post('/v1/rental/agreements', { ...base, drivers: [] }).expect(400);
    const r = (await post('/v1/rental/agreements', base).expect(201)).body;
    expect(r).toMatchObject({ ref: expect.stringMatching(/^RA-\d+$/), state: 'reserved', renter_name: 'فهد العتيبي', rate: '15.000', deposit: '50.000' });
    ra = { id: r.id, ref: r.ref };
    await post('/v1/rental/agreements', { ...base, pickup_at: at(10), return_due: at(30) }).expect(409); // the car is booked then
    const fleet = (await get('/v1/rental/fleet').expect(200)).body.data;
    expect(fleet.find((x: { id: string }) => x.id === car)).toMatchObject({ next_ref: r.ref, out_id: null });
    expect(fleet.find((x: { id: string }) => x.id === loader)).toBeUndefined();
  });

  it('a driver delivers the car: odometer, fuel and the renter at hand-over', async () => {
    await post(`/v1/rental/agreements/${ra.id}/moves`, { kind: 'deliver', driver_worker_id: drv.id, address: {} }).expect(400);
    const mv = (await post(`/v1/rental/agreements/${ra.id}/moves`, { kind: 'deliver', driver_worker_id: drv.id, address: { area: 'السالمية', block: '10', street: '5' } }).expect(201)).body;
    expect(mv).toMatchObject({ kind: 'deliver', status: 'assigned', driver_name: 'سائق التوصيل' });
    await post(`/v1/rental/agreements/${ra.id}/moves`, { kind: 'deliver', driver_worker_id: drv.id, address: { area: 'السالمية' } }).expect(409);
    const t = (await get('/v1/driver/tasks', drv.token).expect(200)).body.data.find((x: { sector_pack: string }) => x.sector_pack === 'rental@1');
    expect(t.attributes).toMatchObject({ kind: 'deliver', rental_ref: ra.ref, renter_name: 'فهد العتيبي', address: 'السالمية، ق 10، 5' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    expect((await op({ type: 'milestone', task_id: t.id, code: 'handover', odometer_km: 1010 })).reason).toBe('invalid_stage');
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'collected', odometer_km: 1010 })).reason).toBe('not_supported');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'handover' })).reason).toBe('odometer_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'handover', odometer_km: 1010, fuel: 8 })).reason).toBe('receiver_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'handover', odometer_km: 900, fuel: 8, received_by: 'فهد' })).reason).toBe('odometer_too_low');
    // recorded two days ago (the app was offline): the charges below run from then
    expect(await op({ type: 'milestone', task_id: t.id, code: 'handover', odometer_km: 1010, fuel: 8, received_by: 'فهد', occurred_at: at(-50) })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    const r = (await get(`/v1/rental/agreements/${ra.id}`).expect(200)).body;
    expect(r).toMatchObject({ state: 'out', out_odometer_km: 1010, out_fuel: 8, out_by: 'driver' });
    outAt = Date.parse(r.out_at);
    expect((await get('/v1/rental/fleet').expect(200)).body.data.find((x: { id: string }) => x.id === car)).toMatchObject({ out_ref: ra.ref, status: 'in_use' });
    await post(`/v1/rental/agreements/${ra.id}/cancel`, { reason: 'x' }).expect(409); // the car is out
  });

  it('traffic fines match the agreement the car was on', async () => {
    const f = (await post('/v1/rental/fines', { asset_id: car, occurred_at: new Date(outAt + 60_000).toISOString(), amount: '20', fine_no: `F-${Date.now()}`, description: 'تجاوز السرعة' }).expect(201)).body;
    expect(f).toMatchObject({ rental_ref: ra.ref, renter_name: 'فهد العتيبي', status: 'open' });
    await post('/v1/rental/fines', { asset_id: car, occurred_at: new Date(outAt + 120_000).toISOString(), amount: '5', fine_no: f.fine_no }).expect(409);
    const before = (await post('/v1/rental/fines', { asset_id: car, occurred_at: at(-60), amount: '10' }).expect(201)).body;
    expect(before.agreement_id).toBeNull();
    await post(`/v1/rental/fines/${before.id}`, { status: 'charged' }).expect(409);
    await post(`/v1/rental/fines/${before.id}`, { status: 'paid_by_us' }).expect(200);
    expect((await post(`/v1/rental/fines/${f.id}`, { status: 'charged' }).expect(200)).body.status).toBe('charged');
  });

  it('check-in at the counter: the charges against the deposit', async () => {
    const back = new Date(outAt + 48 * 3_600_000).toISOString();
    await post(`/v1/rental/agreements/${ra.id}/checkin`, { odometer_km: 1510, fuel: 6, at: at(1) }).expect(400);
    await post(`/v1/rental/agreements/${ra.id}/checkin`, { odometer_km: 1000, fuel: 6, at: back }).expect(400);
    const r = (await post(`/v1/rental/agreements/${ra.id}/checkin`, { odometer_km: 1510, fuel: 6, damage: 'خدش في الباب', damage_amount: '5', at: back }).expect(200)).body;
    // 2 days × 15 + (500 − 400 km) × 0.100 + 2/8 short × 1.500 + 5 damage = 48 against a 50 deposit
    expect(r).toMatchObject({ state: 'returned', days: 2, rental_amount: '30.000', extra_km: 100, km_amount: '10.000', fuel_amount: '3.000', damage_amount: '5.000', total: '48.000', balance: '-2.000', fines_amount: '20.000' });
    await post(`/v1/rental/agreements/${ra.id}/checkin`, { odometer_km: 1600, fuel: 6 }).expect(409);
    expect((await get('/v1/rental/fleet').expect(200)).body.data.find((x: { id: string }) => x.id === car)).toMatchObject({ out_id: null, status: 'available', odometer_km: 1510 });
  });

  it('a counter rental: check-out, extend; a late pickup; exceptions and the report', async () => {
    const d = [{ name: 'شركة النخبة - سالم', licence_no: 'KW-9', licence_expiry: licence(10) }];
    const r = (await post('/v1/rental/agreements', { legal_entity_id: le, customer_id: renter, asset_id: car2, pickup_at: at(0), return_due: at(24), rate_unit: 'week', rate: '70', drivers: d }).expect(201)).body;
    await post(`/v1/rental/agreements/${r.id}/checkout`, { fuel: 8 }).expect(400);
    expect((await post(`/v1/rental/agreements/${r.id}/checkout`, { odometer_km: 5000, fuel: 8 }).expect(200)).body).toMatchObject({ state: 'out', out_by: 'staff' });
    await post(`/v1/rental/agreements/${r.id}/checkout`, { odometer_km: 5000, fuel: 8 }).expect(409);
    await post(`/v1/rental/agreements/${r.id}/extend`, { return_due: at(24 * 20) }).expect(400); // the licence expires first
    expect((await post(`/v1/rental/agreements/${r.id}/extend`, { return_due: at(24 * 5) }).expect(200)).body.state).toBe('out');
    const late = (await post('/v1/rental/agreements', { legal_entity_id: le, customer_id: renter, asset_id: car, pickup_at: at(-1.5), return_due: at(30), rate: '12', drivers: d }).expect(201)).body;
    const e = (await get('/v1/rental/exceptions').expect(200)).body;
    expect(e.late_pickups.map((x: { ref: string }) => x.ref)).toContain(late.ref);
    expect(e.open_fines).toEqual([]);
    expect((await post(`/v1/rental/agreements/${late.id}/cancel`, { reason: 'لم يحضر' }).expect(200)).body.state).toBe('canceled');
    const rep = (await get(`/v1/rental/report?from=${kwDay(-3)}&to=${kwDay(0)}`).expect(200)).body;
    expect(rep.customers[0]).toMatchObject({ customer_name: 'فهد العتيبي', agreements: 1, days: 2, km: 500, total: '48.000' });
    expect(rep.fines).toMatchObject({ charged: '20.000' });
    expect(rep.vehicles.find((x: { plate_no: string }) => x.plate_no.startsWith('RD-')).rented_hours).toBeGreaterThanOrEqual(0);
  });
});
