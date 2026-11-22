/**
 * Heavy equipment hire (equipment pack, sector 16): a machine hired with its operator to a customer's site; each working
 * day a task booked exclusively; the operator records the hour meter (start, end, downtime, supervisor) from the app;
 * the office approves billable hours (daily minimum less our downtime); dry hire recorded by the office; extend,
 * off-hire, exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Equipment hire pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, client: string, crane: string, loader: string;
  let op1: { token: string; id: string };
  let hire: { id: string; ref: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const ALL = [1, 2, 3, 4, 5, 6, 7];
  const site = { name: 'مشروع جسر الجهراء', area: 'الجهراء', phone: '+96550001111' };
  async function op(o: Record<string, unknown>) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, op1.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'تأجير المعدات', packs: ['equipment'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مشغّل الكرين', phone }).expect(201)).body;
    op1 = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    crane = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'crane', plate_no: `CR-${Date.now() % 100000}`, make: 'Liebherr' }).expect(201)).body.id;
    loader = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'loader', plate_no: `LD-${Date.now() % 100000}` }).expect(201)).body.id;
    client = (await post('/v1/customers', { legal_entity_id: le, name: 'مقاولات الخليج' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a wet hire: every working day a task booked for the machine and operator; no double hire', async () => {
    const base = { legal_entity_id: le, customer_id: client, asset_id: crane, operator_worker_id: op1.id, site, starts_on: kwDay(0), ends_on: kwDay(2), shift_start: '00:00', shift_end: '23:59', work_days: ALL, min_hours: 8 };
    await post('/v1/equipment/hires', { ...base, site: {} }).expect(400);
    await post('/v1/equipment/hires', { ...base, ends_on: kwDay(-1) }).expect(400);
    const h = (await post('/v1/equipment/hires', base).expect(201)).body;
    expect(h).toMatchObject({ ref: expect.stringMatching(/^EH-\d+$/), state: 'on_hire', days: 3, rate_unit: 'hour', min_hours: 8, operator_name: 'مشغّل الكرين', uncovered: 0 });
    hire = { id: h.id, ref: h.ref };
    await post('/v1/equipment/hires', { ...base, operator_worker_id: null, starts_on: kwDay(2), ends_on: kwDay(4) }).expect(409); // the crane is taken on day 2
    const days = (await get(`/v1/equipment/hires/${h.id}`).expect(200)).body.work_days_list;
    expect(days.map((d: { status: string }) => d.status)).toEqual(['assigned', 'assigned', 'assigned']);
    const fleet = (await get('/v1/equipment/fleet').expect(200)).body.data;
    expect(fleet.find((x: { id: string }) => x.id === crane)).toMatchObject({ hire_ref: h.ref, customer_name: 'مقاولات الخليج' });
    expect(fleet.find((x: { id: string }) => x.id === loader).hire_id).toBeNull();
  });

  it('the operator records the hour meter; the office approves the billable hours', async () => {
    const t = (await get('/v1/driver/tasks', op1.token).expect(200)).body.data.find((x: { sector_pack: string; attributes: { work_date: string } }) => x.sector_pack === 'equipment@1' && x.attributes.work_date === kwDay(0));
    expect(t.attributes).toMatchObject({ kind: 'hire_day', hire_ref: hire.ref, machine_type: 'crane', min_hours: 8, address: 'مشروع جسر الجهراء، الجهراء' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'work_start' })).toMatchObject({ result: 'rejected', reason: 'meter_required' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'work_start', meter_hours: 1520.5 })).toMatchObject({ result: 'applied' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_end', meter_hours: 1526 })).reason).toBe('signer_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_end', meter_hours: 1500, received_by: 'م. خالد' })).reason).toBe('meter_invalid');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'work_end', meter_hours: 1526, downtime_hours: 1.5, received_by: 'م. خالد' })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    const d = (await get(`/v1/equipment/days?date=${kwDay(0)}`).expect(200)).body.data[0];
    expect(d).toMatchObject({ meter_start: 1520.5, meter_end: 1526, worked_hours: 5.5, downtime_hours: 1.5, signed_by: 'م. خالد', status: 'completed', approved_hours: null });
    // 5.5 worked < minimum 8, less 1.5 h of our breakdown = 6.5 billable
    expect((await post(`/v1/equipment/days/${t.id}/approve`, {}).expect(200)).body.approved_hours).toBe(6.5);
    await post(`/v1/equipment/days/${t.id}/approve`, {}).expect(409);
    await post(`/v1/equipment/days/${t.id}/record`, { meter_start: 1520.5, meter_end: 1527 }).expect(409); // approved days are locked
    // the next day's meter cannot start below the last reading
    const t2 = (await get('/v1/driver/tasks', op1.token).expect(200)).body.data.find((x: { sector_pack: string; attributes: { work_date: string } }) => x.sector_pack === 'equipment@1' && x.attributes.work_date === kwDay(1));
    await op({ type: 'task_status', task_id: t2.id, to_status: 'accepted' });
    expect((await op({ type: 'milestone', task_id: t2.id, code: 'work_start', meter_hours: 1510 })).reason).toBe('meter_too_low');
  });

  it('extend, off-hire, and a dry hire recorded by the office', async () => {
    expect((await post(`/v1/equipment/hires/${hire.id}/extend`, { ends_on: kwDay(4) }).expect(200)).body).toMatchObject({ ends_on: kwDay(4), days: 5 });
    await post(`/v1/equipment/hires/${hire.id}/extend`, { ends_on: kwDay(3) }).expect(400);
    const off = (await post(`/v1/equipment/hires/${hire.id}/off-hire`, { on: kwDay(2), reason: 'انتهى العمل مبكرًا' }).expect(200)).body;
    expect(off).toMatchObject({ off_hired_on: kwDay(2) });
    const days = (await get(`/v1/equipment/hires/${hire.id}`).expect(200)).body.work_days_list;
    expect(days.map((d: { status: string }) => d.status)).toEqual(['completed', 'accepted', 'assigned', 'canceled', 'canceled']);
    // the crane is free again after the off-hire: a dry hire to another customer
    const other = (await post('/v1/customers', { legal_entity_id: le, name: 'شركة الطرق' }).expect(201)).body.id;
    const dry = (await post('/v1/equipment/hires', { legal_entity_id: le, customer_id: other, asset_id: loader, site: { area: 'الوفرة' }, starts_on: kwDay(0), ends_on: kwDay(0),
      shift_start: '00:00', shift_end: '23:59', work_days: ALL, rate_unit: 'day' }).expect(201)).body;
    const dd = (await get(`/v1/equipment/hires/${dry.id}`).expect(200)).body.work_days_list[0];
    expect(dd).toMatchObject({ status: 'ready', wet: false });
    await post(`/v1/equipment/days/${dd.task_id}/approve`, {}).expect(409); // no reading yet
    await post(`/v1/equipment/days/${dd.task_id}/record`, { meter_start: 300, meter_end: 299 }).expect(400);
    await post(`/v1/equipment/days/${dd.task_id}/record`, { meter_start: 300, meter_end: 306, signed_by: 'أبو فهد' }).expect(200);
    const ap = (await post(`/v1/equipment/days/${dd.task_id}/approve`, {}).expect(200)).body;
    expect(ap).toMatchObject({ status: 'completed', worked_hours: 6, approved_hours: 24 }); // a day rate counts the whole shift
  });

  it('exceptions and the report', async () => {
    const e = (await get(`/v1/equipment/exceptions?date=${kwDay(1)}`).expect(200)).body;
    expect(e.ending.map((h: { ref: string }) => h.ref)).toContain(hire.ref);
    expect(e.to_approve).toEqual([]);
    const r = (await get(`/v1/equipment/report?from=${kwDay(0)}&to=${kwDay(4)}`).expect(200)).body;
    expect(r.customers.find((x: { customer_name: string }) => x.customer_name === 'مقاولات الخليج')).toMatchObject({ days: 3, approved_days: 1, worked_hours: 5.5, downtime_hours: 1.5, billable_hours: 6.5 });
    const m = r.machines.find((x: { asset_type: string }) => x.asset_type === 'loader');
    expect(m).toMatchObject({ days: 1, worked_hours: 6, scheduled_hours: 24, utilization_pct: 25 });
    await post(`/v1/equipment/hires/${hire.id}/cancel`, { reason: 'x' }).expect(409); // work started
  });
});
