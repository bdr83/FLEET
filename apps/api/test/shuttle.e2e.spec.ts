/**
 * Staff transport (shuttle pack, sector 11): routes with stops, days and a default bus and driver; riders; daily trips
 * generated idempotently and booked exclusively; the driver marks riders boarded or absent from the app (offline sync);
 * office corrections, exceptions (late, missing, repeated absence) and the per-customer report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Staff transport pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, client: string, bus: string;
  let driver: { token: string; id: string };
  let r1: { id: string; version: number }, riders: { id: string; name: string }[], tripId: string;
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const patch = (path: string, body: Record<string, unknown>, token = T) => request(http).patch(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const ALL = [1, 2, 3, 4, 5, 6, 7];
  const stops = [{ name: 'سكن المهبولة', area: 'المهبولة' }, { name: 'الفنطاس', offset_min: 15 }, { name: 'مصفاة الأحمدي', offset_min: 50 }];
  async function op(o: Record<string, unknown>, id = randomUUID()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: id, occurred_at: new Date().toISOString(), ...o }] }, driver.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'نقل العمال', packs: ['shuttle'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'راجو', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    bus = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `BS-${Date.now() % 100000}`, capacity: { seats: 30 } }).expect(201)).body.id;
    client = (await post('/v1/customers', { legal_entity_id: le, name: 'شركة المقاولات الوطنية' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a route with stops and days, and its riders', async () => {
    const base = { legal_entity_id: le, customer_id: client, name: 'المهبولة ← المصفاة', direction: 'to_work', depart_time: '06:00', duration_min: 60, days: ALL, stops, asset_id: bus, driver_worker_id: driver.id, capacity: 3 };
    await post('/v1/shuttle/routes', { ...base, code: 'R1', stops: [{ name: 'a' }, { name: 'b' }] }).expect(400); // second stop needs its minutes
    await post('/v1/shuttle/routes', { ...base, code: 'R1', depart_time: '6am' }).expect(400);
    const r = (await post('/v1/shuttle/routes', { ...base, code: 'r1' }).expect(201)).body;
    expect(r).toMatchObject({ code: 'R1', depart_time: '06:00', days: ALL, capacity: 3, plate_no: expect.any(String), driver_name: 'راجو', riders: 0 });
    await post('/v1/shuttle/routes', { ...base, code: 'R1' }).expect(409);
    r1 = { id: r.id, version: r.version };
    await post(`/v1/shuttle/routes/${r.id}/riders`, { riders: [{ name: 'x', stop_seq: 4 }] }).expect(400);
    const add = (await post(`/v1/shuttle/routes/${r.id}/riders`, { riders: [
      { name: 'أنيل', staff_no: 'E-101', stop_seq: 1 }, { name: 'محمد', staff_no: 'E-102', stop_seq: 1, phone: '+96569001234' },
      { name: 'جوزيف', staff_no: 'E-103', stop_seq: 2 }, { name: 'أنيل مكرر', staff_no: 'E-101', stop_seq: 2 },
    ] }).expect(201)).body;
    expect(add).toEqual({ added: 3, skipped: 1 });
    riders = (await get(`/v1/shuttle/routes/${r.id}/riders`).expect(200)).body.data;
    expect(riders.map((x) => x.name)).toEqual(['أنيل', 'محمد', 'جوزيف']);
    // a second route with no driver, and a third on the same bus at the same time
    await post('/v1/shuttle/routes', { ...base, code: 'R2', driver_worker_id: null }).expect(201);
    const w2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'كومار', phone: newPhone() }).expect(201)).body;
    await post('/v1/shuttle/routes', { ...base, code: 'R3', direction: 'from_work', driver_worker_id: w2.id, depart_time: '06:30' }).expect(201);
  });

  it('trips for a day: created once, booked exclusively, skipped with a reason', async () => {
    const g = (await post('/v1/shuttle/trips/generate', { date: kwDay(1) }).expect(201)).body;
    expect(g.created).toEqual(['R1']);
    expect(g.skipped).toEqual(expect.arrayContaining([{ code: 'R2', reason: 'no_driver' }, { code: 'R3', reason: 'vehicle_booked' }]));
    expect((await post('/v1/shuttle/trips/generate', { date: kwDay(1) }).expect(201)).body.existing).toEqual(['R1']);
    const list = (await get(`/v1/shuttle/trips?date=${kwDay(1)}`).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ route_code: 'R1', status: 'assigned', riders_planned: 3, capacity: 3, boarded: 0, no_show: 0 });
    tripId = list[0].id;
  });

  it('the driver marks riders boarded or absent, offline-safe, then runs the trip', async () => {
    const tasks = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data;
    const t = tasks.find((x: { sector_pack: string }) => x.sector_pack === 'shuttle@1');
    expect(t.attributes).toMatchObject({ kind: 'trip', route_code: 'R1', direction: 'to_work', capacity: 3 });
    expect(t.attributes.stops.map((s: { time: string }) => s.time)).toEqual(['06:00', '06:15', '06:50']);
    expect(t.shuttle.riders).toHaveLength(3);
    const [a, b, c] = riders;
    expect(await op({ type: 'board', task_id: t.id, rider_id: a.id, event: 'boarded' })).toMatchObject({ result: 'rejected', reason: 'invalid_stage' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    const id = randomUUID();
    expect(await op({ type: 'board', task_id: t.id, rider_id: a.id, event: 'boarded' }, id)).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'board', task_id: t.id, rider_id: a.id, event: 'boarded' }, id)).toMatchObject({ result: 'duplicate' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    await op({ type: 'board', task_id: t.id, rider_id: b.id, event: 'no_show' });
    await op({ type: 'board', task_id: t.id, rider_id: b.id, event: 'boarded' }); // he came running: the last mark counts
    await op({ type: 'board', task_id: t.id, rider_id: c.id, event: 'no_show' });
    expect(await op({ type: 'board', task_id: t.id, rider_id: randomUUID(), event: 'boarded' })).toMatchObject({ result: 'rejected', reason: 'unknown_rider' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    const d = (await get(`/v1/shuttle/trips/${tripId}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'completed', boarded: 2, no_show: 1, started_at: expect.any(String), ended_at: expect.any(String) });
    expect(d.riders.map((x: { event: string }) => x.event)).toEqual(['boarded', 'boarded', 'no_show']);
    expect((await op({ type: 'board', task_id: t.id, rider_id: c.id, event: 'boarded' })).reason).toBe('invalid_stage'); // trip closed for the driver
    await post(`/v1/shuttle/trips/${tripId}/cancel`, { reason: 'x' }).expect(409);
  });

  it('exceptions: late trip, route without a driver, repeated absence; route edits', async () => {
    // a trip that should have left 20 minutes ago
    const ago = new Date(Date.now() + 3 * 3_600_000 - 20 * 60_000).toISOString();
    const late = (await post('/v1/shuttle/routes', { legal_entity_id: le, code: 'R9', name: 'رحلة متأخرة', direction: 'from_work', depart_time: ago.slice(11, 16), duration_min: 120, days: ALL,
      stops: [{ name: 'المصفاة' }, { name: 'السكن', offset_min: 60 }], asset_id: bus, driver_worker_id: driver.id }).expect(201)).body;
    expect((await post('/v1/shuttle/trips/generate', { date: ago.slice(0, 10), route_ids: [late.id] }).expect(201)).body.created).toEqual(['R9']);
    // the third rider is absent on three trips in a row (office marks for the next two days)
    const c = riders[2];
    for (const d of [2, 3]) {
      await post('/v1/shuttle/trips/generate', { date: kwDay(d), route_ids: [r1.id] }).expect(201);
      const trip = (await get(`/v1/shuttle/trips?date=${kwDay(d)}`).expect(200)).body.data.find((x: { route_code: string }) => x.route_code === 'R1');
      await post(`/v1/shuttle/trips/${trip.id}/board`, { rider_id: c.id, event: 'no_show' }).expect(200);
    }
    await post(`/v1/shuttle/trips/${tripId}/board`, { rider_id: randomUUID(), event: 'no_show' }).expect(400);
    const e = (await get(`/v1/shuttle/exceptions?date=${ago.slice(0, 10)}`).expect(200)).body;
    expect(e.late.map((x: { route_code: string }) => x.route_code)).toContain('R9');
    expect(e.missing).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'R2', reason: 'no_driver' })]));
    expect(e.no_show_streak.map((x: { name: string }) => x.name)).toEqual(['جوزيف']);
    // edits need the current version; a removed rider drops off new manifests
    await patch(`/v1/shuttle/routes/${r1.id}`, { version: r1.version + 5, capacity: 4 }).expect(409);
    expect((await patch(`/v1/shuttle/routes/${r1.id}`, { version: r1.version, capacity: 4, depart_time: '05:45' }).expect(200)).body).toMatchObject({ capacity: 4, depart_time: '05:45', code: 'R1' });
    await patch(`/v1/shuttle/riders/${riders[0].id}`, { active: false }).expect(200);
    expect((await get(`/v1/shuttle/routes/${r1.id}`.replace(/\/[^/]+$/, `/${r1.id}/riders`)).expect(200)).body.data[2]).toMatchObject({ active: false });
  });

  it('report per customer: trips, on time, riders and seat use', async () => {
    const r = (await get(`/v1/shuttle/report?from=${kwDay(-1)}&to=${kwDay(3)}`).expect(200)).body;
    const row = r.data.find((x: { customer_id: string }) => x.customer_id === client);
    expect(row).toMatchObject({ customer_name: 'شركة المقاولات الوطنية', routes: 1, trips: 3, completed: 1, canceled: 0, boarded: 2, no_shows: 1, occupancy_pct: 66.7 });
    expect(r.totals.trips).toBe(4);
    await get(`/v1/shuttle/report?from=${kwDay(3)}&to=${kwDay(1)}`).expect(400);
  });
});
