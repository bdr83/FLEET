/**
 * Tourist and charter buses (tour pack, sector 13): a group trip for a customer with an itinerary; buses with drivers booked
 * for the whole trip (seats from the bus record); the passenger list (IDs required across the border); the driver counts
 * heads and reads the odometer on boarding and on return (fewer back needs a note); exceptions, cancel and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Tour pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, agency: string, bus1: string, bus2: string, car: string;
  let d1: { token: string; id: string }, d2: { token: string; id: string };
  let trip: { id: string; ref: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  async function op(o: Record<string, unknown>, token = d1.token, at = new Date()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at.toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  const taskOf = async (token: string, ref: string) => (await get('/v1/driver/tasks', token).expect(200)).body.data.find((x: { ref: string }) => x.ref.startsWith(ref));

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'رحلات النوخذة', packs: ['tour'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const driver = async (name: string) => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: name, phone }).expect(201)).body;
      return { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    };
    d1 = await driver('فهد'); d2 = await driver('ناصر');
    const asset = async (type: string, plate: string, capacity?: Record<string, number>) =>
      (await post('/v1/assets', { legal_entity_id: le, asset_type: type, plate_no: `${plate}-${Date.now() % 100000}`, ...(capacity ? { capacity } : {}) }).expect(201)).body.id;
    bus1 = await asset('bus', 'BS1', { seats: 50 }); bus2 = await asset('bus', 'BS2', { seats: 30 }); car = await asset('car', 'CR1');
    agency = (await post('/v1/customers', { legal_entity_id: le, name: 'مكتب الرحاب للسياحة', kind: 'business' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a cross-border group trip with an itinerary', async () => {
    const base = { legal_entity_id: le, customer_id: agency, group_name: 'عمرة رجب', pax: 60, start_at: inMin(-120), end_at: inMin(2 * 1440), pickup: 'الجهراء، مسجد الدولة', destination: 'مكة المكرمة' };
    await post('/v1/tours/trips', { ...base, customer_id: undefined }).expect(400);
    await post('/v1/tours/trips', { ...base, end_at: inMin(-200) }).expect(400);
    await post('/v1/tours/trips', { ...base, itinerary: [{ place: 'الرياض', at: inMin(5 * 1440) }] }).expect(400);
    await post('/v1/tours/trips', { ...base, price: '1000', deposit: '2000' }).expect(400);
    const t = (await post('/v1/tours/trips', { ...base, cross_border: true, contact_name: 'أبو خالد', contact_phone: '+96599887766', price: '1800.000', deposit: '500',
      itinerary: [{ place: 'منفذ السالمي', at: inMin(60) }, { place: 'الرياض', note: 'استراحة وغداء' }, { place: 'مكة المكرمة' }] }).expect(201)).body;
    expect(t).toMatchObject({ ref: expect.stringMatching(/^TR-\d+$/), state: 'planned', seats: 0, listed: 0, cross_border: true, price: '1800.000', customer_name: 'مكتب الرحاب للسياحة' });
    expect(t.itinerary).toHaveLength(3);
    trip = t;
  });

  it('buses with drivers for the whole trip; a bus or driver booked elsewhere is refused', async () => {
    const cand = (await get(`/v1/tours/trips/${trip.id}/candidates`).expect(200)).body;
    expect(cand.buses.map((x: { asset_id: string }) => x.asset_id).sort()).toEqual([bus1, bus2].sort()); // a car is not a bus
    expect(cand).toMatchObject({ seats_needed: 60 });
    await post(`/v1/tours/trips/${trip.id}/buses`, { asset_id: car, driver_worker_id: d1.id }).expect(400);
    let t = (await post(`/v1/tours/trips/${trip.id}/buses`, { asset_id: bus1, driver_worker_id: d1.id }).expect(201)).body;
    expect(t).toMatchObject({ state: 'planned', seats: 50 });
    expect(t.buses[0]).toMatchObject({ seq: 1, seats: 50, status: 'assigned', driver_name: 'فهد' });
    await post(`/v1/tours/trips/${trip.id}/buses`, { asset_id: bus1, driver_worker_id: d2.id }).expect(409);
    await post(`/v1/tours/trips/${trip.id}/buses`, { asset_id: bus2, driver_worker_id: d1.id }).expect(409);
    t = (await post(`/v1/tours/trips/${trip.id}/buses`, { asset_id: bus2, driver_worker_id: d2.id }).expect(201)).body;
    expect(t).toMatchObject({ state: 'ready', seats: 80 });
    const task = await taskOf(d1.token, `${trip.ref}-B1`);
    expect(task.attributes).toMatchObject({ kind: 'tour', group_name: 'عمرة رجب', seats: 50, cross_border: true, destination: 'مكة المكرمة' });
  });

  it('the passenger list: IDs across the border, not more than the group, buses of the trip', async () => {
    await post(`/v1/tours/trips/${trip.id}/manifest`, { passengers: [{ name: 'علي' }] }).expect(400);
    await post(`/v1/tours/trips/${trip.id}/manifest`, { passengers: [{ name: 'علي', id_no: '280010112345', bus_seq: 7 }] }).expect(400);
    await post(`/v1/tours/trips/${trip.id}/manifest`, { passengers: Array.from({ length: 61 }, (_, i) => ({ name: `ر${i}`, id_no: `ID${10000 + i}` })) }).expect(400);
    await post(`/v1/tours/trips/${trip.id}/manifest`, { passengers: [{ name: 'علي', id_no: 'P1234567' }, { name: 'عمر', id_no: 'p1234567' }] }).expect(400);
    expect((await post(`/v1/tours/trips/${trip.id}/manifest`, { passengers: [
      { name: 'علي', id_no: '280010112345', nationality: 'كويتي', bus_seq: 1 }, { name: 'عمر', id_no: 'P1234567', phone: '+96599001122', bus_seq: 2 }, { name: 'سعد', id_no: '290020212345' },
    ] }).expect(200)).body).toMatchObject({ count: 3 });
    const m = (await get(`/v1/tours/trips/${trip.id}/manifest`).expect(200)).body;
    expect(m.data).toHaveLength(3);
    const ex = (await get('/v1/tours/exceptions').expect(200)).body;
    expect(ex.manifest_missing.map((x: { id: string }) => x.id)).toContain(trip.id); // 3 of 60 listed
    expect(ex.late_start.map((x: { trip_ref: string }) => x.trip_ref)).toContain(trip.ref); // started 2 hours ago, buses not under way
  });

  it('the driver counts heads and reads the odometer on boarding and return; fewer back needs a note', async () => {
    const task = await taskOf(d1.token, `${trip.ref}-B1`);
    await op({ type: 'task_status', task_id: task.id, to_status: 'accepted' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_boarded', headcount: 48, odometer_km: 1000 })).toMatchObject({ result: 'rejected', reason: 'invalid_stage' });
    await op({ type: 'task_status', task_id: task.id, to_status: 'in_progress' }, d1.token, ago(100));
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_returned', headcount: 48, odometer_km: 1000 })).toMatchObject({ result: 'rejected', reason: 'stage_out_of_order' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_boarded', odometer_km: 1000 })).toMatchObject({ result: 'rejected', reason: 'headcount_required' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_boarded', headcount: 48 })).toMatchObject({ result: 'rejected', reason: 'odometer_required' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_boarded', headcount: 55, odometer_km: 1000 })).toMatchObject({ result: 'rejected', reason: 'over_seats' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_boarded', headcount: 48, odometer_km: 1000 }, d1.token, ago(90))).toMatchObject({ result: 'applied' });
    expect((await get(`/v1/tours/trips/${trip.id}`).expect(200)).body.state).toBe('under_way');
    await post(`/v1/tours/trips/${trip.id}/cancel`, { reason: 'x' }).expect(409);
    expect(await op({ type: 'task_status', task_id: task.id, to_status: 'completed' })).toMatchObject({ result: 'rejected', reason: 'proof_required' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_returned', headcount: 46, odometer_km: 1100 })).toMatchObject({ result: 'rejected', reason: 'note_required' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_returned', headcount: 46, odometer_km: 900, note: 'x' })).toMatchObject({ result: 'rejected', reason: 'odometer_too_low' });
    expect(await op({ type: 'milestone', task_id: task.id, code: 'tr_returned', headcount: 46, odometer_km: 1100, note: 'راكبان بقيا مع أقاربهما في الرياض' }, d1.token, ago(10)))
      .toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: task.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    const t = (await get(`/v1/tours/trips/${trip.id}`).expect(200)).body;
    expect(t.buses[0]).toMatchObject({ boarded: 48, returned: 46, odometer_out: 1000, odometer_in: 1100, status: 'completed' });
    expect(t.km).toBe(100);
    const ex = (await get('/v1/tours/exceptions').expect(200)).body;
    expect(ex.left_behind.map((x: { task_id: string }) => x.task_id)).toContain(task.id);
  });

  it('a bus back is free again; another trip, a bus let go, and the trip canceled', async () => {
    const t2 = (await post('/v1/tours/trips', { legal_entity_id: le, customer_id: agency, group_name: 'رحلة مدرسية', pax: 40, start_at: inMin(1440), end_at: inMin(1440 + 480),
      pickup: 'مدرسة الرواد', destination: 'المدينة الترفيهية' }).expect(201)).body;
    let t = (await post(`/v1/tours/trips/${t2.id}/buses`, { asset_id: bus1, driver_worker_id: d1.id }).expect(201)).body; // free once back from the first trip
    expect(t.state).toBe('ready');
    t = (await post(`/v1/tours/trips/${t2.id}/buses/${t.buses[0].task_id}/release`, { reason: 'استبدال' }).expect(200)).body;
    expect(t).toMatchObject({ state: 'planned', seats: 0 });
    expect(t.buses[0].status).toBe('canceled');
    t = (await post(`/v1/tours/trips/${t2.id}/buses`, { asset_id: bus1, driver_worker_id: d1.id }).expect(201)).body;
    t = (await post(`/v1/tours/trips/${t2.id}/cancel`, { reason: 'ألغت المدرسة الرحلة' }).expect(200)).body;
    expect(t.state).toBe('canceled');
    expect(t.buses.every((b: { status: string }) => b.status === 'canceled')).toBe(true);
  });

  it('the report per customer', async () => {
    await get('/v1/tours/report').expect(400);
    const r = (await get(`/v1/tours/report?from=${kwDay(-1)}&to=${kwDay(3)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ trips: 1, pax: 60, buses: 2, km: 100, amount: '1800.000', deposits: '500.000', canceled: 1, cross_border: 1 });
    expect(r.customers[0]).toMatchObject({ customer_name: 'مكتب الرحاب للسياحة', trips: 1 });
    expect((await get(`/v1/tours/trips?from=${kwDay(-1)}&to=${kwDay(3)}`).expect(200)).body.data).toHaveLength(2);
  });
});
