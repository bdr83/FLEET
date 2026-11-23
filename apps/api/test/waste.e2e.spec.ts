/**
 * Waste collection (waste pack, sector 23): a route with a compactor truck and ordered collection points (a customer's
 * bins); the day's run generated and booked; the driver marks points collected or missed and records the weighbridge
 * ticket; the run cannot end with a point open or without a ticket; exceptions (missed, repeat missed) and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Waste pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, truck: string, coop: string, mall: string;
  let drv: { token: string; id: string };
  let route: { id: string; version: number };
  const points: string[] = [];
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const patch = (path: string, body: Record<string, unknown>, token = T) => request(http).patch(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  // the round started an hour ago, Kuwait time (a run ending in the past is not generated)
  const startHm = new Date(Date.now() + 3 * 3_600_000 - 3_600_000).toISOString().slice(11, 16);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  async function op(o: Record<string, unknown>, at = ago(1)) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, drv.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'خدمات النظافة', packs: ['waste'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق الكابسة', phone }).expect(201)).body;
    drv = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    truck = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CP-${Date.now() % 100000}`, make: 'Mercedes' }).expect(201)).body.id;
    coop = (await post('/v1/customers', { legal_entity_id: le, name: 'جمعية السالمية' }).expect(201)).body.id;
    mall = (await post('/v1/customers', { legal_entity_id: le, name: 'مجمع المروج' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a route with a truck and ordered collection points', async () => {
    const base = { legal_entity_id: le, code: 'SAL-1', name: 'السالمية صباحًا', start_time: startHm, duration_min: 600, facility: 'مردم الجهراء', asset_id: truck, driver_worker_id: drv.id };
    await post('/v1/waste/routes', { ...base, start_time: '25:00' }).expect(400);
    await post('/v1/waste/routes', { ...base, waste_type: 'nuclear' }).expect(400);
    const r = (await post('/v1/waste/routes', base).expect(201)).body;
    expect(r).toMatchObject({ code: 'SAL-1', waste_type: 'general', days: [1, 2, 3, 4, 5, 6, 7], plate_no: expect.any(String), driver_name: 'سائق الكابسة', points: 0 });
    await post('/v1/waste/routes', base).expect(409);
    route = { id: r.id, version: r.version };
    // a route with no points is skipped
    expect((await post('/v1/waste/runs/generate', { date: kwDay(0) }).expect(201)).body.skipped).toEqual([{ code: 'SAL-1', reason: 'no_points' }]);
    await post(`/v1/waste/routes/${r.id}/points`, { name: 'x', bins: [{ type: 'bin_9000', count: 1 }] }).expect(400);
    await post(`/v1/waste/routes/${r.id}/points`, { name: 'x', bins: [{ type: 'bin_1100', count: 1 }, { type: 'bin_1100', count: 2 }] }).expect(400);
    const p1 = (await post(`/v1/waste/routes/${r.id}/points`, { name: 'جمعية السالمية الرئيسي', area: 'السالمية', customer_id: coop, bins: [{ type: 'bin_1100', count: 4 }] }).expect(201)).body;
    const p3 = (await post(`/v1/waste/routes/${r.id}/points`, { name: 'مجمع المروج', area: 'السالمية', customer_id: mall, bins: [{ type: 'compactor', count: 1 }, { type: 'bin_660', count: 2 }] }).expect(201)).body;
    const p2 = (await post(`/v1/waste/routes/${r.id}/points`, { name: 'فرع الجمعية ق 10', area: 'السالمية', customer_id: coop, seq: 2, bins: [{ type: 'bin_240', count: 6 }] }).expect(201)).body;
    const list = (await get(`/v1/waste/routes/${r.id}/points`).expect(200)).body.data;
    expect(list.map((x: { name: string; seq: number }) => [x.seq, x.name])).toEqual([[1, 'جمعية السالمية الرئيسي'], [2, 'فرع الجمعية ق 10'], [3, 'مجمع المروج']]);
    points.push(p1.id, p2.id, p3.id);
  });

  it('the run: generated once, booked; the driver marks points and records the weighbridge ticket', async () => {
    const g = (await post('/v1/waste/runs/generate', { date: kwDay(0) }).expect(201)).body;
    expect(g).toMatchObject({ created: ['SAL-1'], skipped: [] });
    expect((await post('/v1/waste/runs/generate', { date: kwDay(0) }).expect(201)).body.existing).toEqual(['SAL-1']);
    const run = (await get(`/v1/waste/runs?date=${kwDay(0)}`).expect(200)).body.data[0];
    expect(run).toMatchObject({ route_code: 'SAL-1', status: 'assigned', points_planned: 3, collected: 0, net_kg: 0 });
    const t = (await get('/v1/driver/tasks', drv.token).expect(200)).body.data.find((x: { id: string }) => x.id === run.task_id);
    expect(t.attributes).toMatchObject({ kind: 'round', route_code: 'SAL-1', facility: 'مردم الجهراء', points: 3 });
    expect(t.waste.points.map((x: { name: string }) => x.name)).toEqual(['جمعية السالمية الرئيسي', 'فرع الجمعية ق 10', 'مجمع المروج']);
    expect(t.waste.points[0]).toMatchObject({ customer_name: 'جمعية السالمية', bins: [{ type: 'bin_1100', count: 4 }], event: null });
    const [p1, p2, p3] = points;
    expect((await op({ type: 'visit', task_id: t.id, point_id: p1, event: 'collected', bins: 4 })).reason).toBe('invalid_transition'); // not started
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, ago(40));
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, ago(39));
    expect((await op({ type: 'visit', task_id: t.id, point_id: p1, event: 'collected' })).reason).toBe('bins_required');
    expect((await op({ type: 'visit', task_id: t.id, point_id: p1, event: 'collected', bins: 30 })).reason).toBe('bins_invalid');
    expect((await op({ type: 'visit', task_id: t.id, point_id: randomUUID(), event: 'collected', bins: 1 })).reason).toBe('unknown_point');
    expect((await op({ type: 'visit', task_id: t.id, point_id: p1, event: 'collected', bins: 4 }, ago(30))).result).toBe('applied');
    expect((await op({ type: 'visit', task_id: t.id, point_id: p2, event: 'missed' })).reason).toBe('miss_reason_required');
    expect((await op({ type: 'visit', task_id: t.id, point_id: p2, event: 'missed', reason: 'blocked', note: 'سيارة أمام الحاويات' }, ago(25))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('points_open');
    // a re-sent op is a duplicate
    const id = randomUUID();
    const send = () => post('/v1/driver/sync', { ops: [{ client_op_id: id, occurred_at: ago(20), type: 'visit', task_id: t.id, point_id: p3, event: 'collected', bins: 3 }] }, drv.token).expect(200);
    expect((await send()).body.results[0].result).toBe('applied');
    expect((await send()).body.results[0].result).toBe('duplicate');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('dump_required');
    expect((await op({ type: 'dump', task_id: t.id, net_kg: 5200 })).reason).toBe('ticket_required');
    expect((await op({ type: 'dump', task_id: t.id, ticket_no: 'JH-88120' })).reason).toBe('weight_required');
    expect((await op({ type: 'dump', task_id: t.id, ticket_no: 'JH-88120', net_kg: 5240.5 }, ago(10))).result).toBe('applied');
    expect((await op({ type: 'dump', task_id: t.id, ticket_no: 'JH-88120', net_kg: 100 })).reason).toBe('ticket_already_recorded');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).result).toBe('applied');
    const d = (await get(`/v1/waste/runs/${run.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'completed', collected: 2, missed: 1, bins: 7, dumps: 1, net_kg: 5240.5 });
    expect(d.tickets[0]).toMatchObject({ ticket_no: 'JH-88120', facility: 'مردم الجهراء', net_kg: 5240.5 });
    expect(d.points[1]).toMatchObject({ event: 'missed', reason: 'blocked', mark_note: 'سيارة أمام الحاويات' });
  });

  it('exceptions: missed today and points missed on runs in a row; the office corrects', async () => {
    const run = (await get(`/v1/waste/runs?date=${kwDay(0)}`).expect(200)).body.data[0];
    let ex = (await get(`/v1/waste/exceptions?date=${kwDay(0)}`).expect(200)).body;
    expect(ex.missed).toEqual([expect.objectContaining({ name: 'فرع الجمعية ق 10', customer_name: 'جمعية السالمية', reason: 'blocked' })]);
    expect(ex.repeat_missed).toEqual([]); // one run only
    // the next day's run: the same point missed again
    await post('/v1/waste/runs/generate', { date: kwDay(1) }).expect(201);
    const r2 = (await get(`/v1/waste/runs?date=${kwDay(1)}`).expect(200)).body.data[0];
    await post(`/v1/waste/runs/${r2.id}/visit`, { point_id: points[1], event: 'missed', reason: 'bins_not_out' }).expect(200);
    ex = (await get(`/v1/waste/exceptions?date=${kwDay(1)}`).expect(200)).body;
    expect(ex.repeat_missed).toEqual([expect.objectContaining({ name: 'فرع الجمعية ق 10', runs: 2 })]);
    // the office corrects today's mark: the latest counts
    await post(`/v1/waste/runs/${run.id}/visit`, { point_id: points[1], event: 'collected' }).expect(409);
    const fixed = (await post(`/v1/waste/runs/${run.id}/visit`, { point_id: points[1], event: 'collected', bins: 6 }).expect(200)).body;
    expect(fixed).toMatchObject({ collected: 3, missed: 0, bins: 13 });
    await post(`/v1/waste/runs/${r2.id}/cancel`, {}).expect(400);
    expect((await post(`/v1/waste/runs/${r2.id}/cancel`, { reason: 'عطلة رسمية' }).expect(200)).body.status).toBe('canceled');
    // a point taken off the route closes the gap in the order
    await patch(`/v1/waste/points/${points[1]}`, { active: false }).expect(200);
    const list = (await get(`/v1/waste/routes/${route.id}/points`).expect(200)).body.data.filter((x: { active: boolean }) => x.active);
    expect(list.map((x: { seq: number }) => x.seq)).toEqual([1, 2]);
  });

  it('the report per route and customer', async () => {
    const r = (await get(`/v1/waste/report?from=${kwDay(0)}&to=${kwDay(1)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ runs: 1, completed: 1, collected: 3, missed: 0, bins: 13, dumps: 1, tonnes: 5.2 });
    expect(r.routes[0]).toMatchObject({ route_code: 'SAL-1', tonnes: 5.2 });
    expect(r.customers.find((x: { customer_name: string }) => x.customer_name === 'جمعية السالمية')).toMatchObject({ collected: 2, bins: 10 });
    const { user_token } = await login(app, newPhone());
    const other = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'توصيل', packs: ['delivery'] }).expect(201)).body;
    await get('/v1/waste/runs', other.access_token).expect(403);
  });
});
