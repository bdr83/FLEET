/**
 * Cranes and lifting (cranes pack, sector 19) on top of equipment hire: a crane's load chart; lift plans on a hire's
 * working day with the rated capacity and utilization; refused over 100%, beyond the chart or without valid crane,
 * operator and rigger certificates; critical lifts need approval; the operator records the lift with the wind speed
 * (over the limit refused) or aborts it with a reason; the day cannot end with an open lift; exceptions and report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Cranes pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, client: string, crane: string, rigger: string;
  let op1: { token: string; id: string };
  let hireId: string, dayTask: string;
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const put = (path: string, body: Record<string, unknown>, token = T) => request(http).put(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const doc = (owner: Record<string, string>, doc_type: string, expires_on: string) => post('/v1/documents', { ...owner, doc_type, expires_on }).then((r) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r; });
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  async function op(o: Record<string, unknown>, at = ago(1)) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, op1.token).expect(200)).body.results[0];
  }
  const chart = [{ radius_m: 3, capacity_t: 50 }, { radius_m: 10, capacity_t: 20 }, { radius_m: 20, capacity_t: 8 }, { radius_m: 30, capacity_t: 4 }];
  const lift = (o: Record<string, unknown> = {}) => post('/v1/cranes/lifts', { hire_id: hireId, lift_date: kwDay(0), lift_time: '09:00', description: 'رفع جسر حديد', load_t: 10, radius_m: 8, rigger_worker_id: rigger, ...o });

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    // a crane company: the cranes pack alone still reaches the equipment hires it builds on
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'رافعات الخليج', packs: ['cranes'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مشغّل الرافعة', phone }).expect(201)).body;
    op1 = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    rigger = (await post('/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'الموجّه سالم', phone: newPhone() }).expect(201)).body.id;
    crane = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'crane', plate_no: `MC-${Date.now() % 100000}`, make: 'Tadano' }).expect(201)).body.id;
    client = (await post('/v1/customers', { legal_entity_id: le, name: 'مقاولات البناء' }).expect(201)).body.id;
    const h = (await post('/v1/equipment/hires', { legal_entity_id: le, customer_id: client, asset_id: crane, operator_worker_id: op1.id, site: { name: 'برج الشرق', area: 'الشرق' },
      starts_on: kwDay(0), ends_on: kwDay(1), shift_start: '00:00', shift_end: '23:59', work_days: [1, 2, 3, 4, 5, 6, 7], min_hours: 8 }).expect(201)).body;
    hireId = h.id;
  });
  afterAll(async () => app?.close());

  it('the load chart: radii increasing, capacity not increasing; only for cranes', async () => {
    await put(`/v1/cranes/fleet/${crane}`, { max_capacity_t: 50, chart: [{ radius_m: 10, capacity_t: 20 }, { radius_m: 5, capacity_t: 30 }] }).expect(400);
    await put(`/v1/cranes/fleet/${crane}`, { max_capacity_t: 50, chart: [{ radius_m: 5, capacity_t: 20 }, { radius_m: 10, capacity_t: 30 }] }).expect(400);
    await put(`/v1/cranes/fleet/${crane}`, { max_capacity_t: 40, chart }).expect(400); // the chart above the maximum
    const van = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'van', plate_no: `VN-${Date.now() % 100000}` }).expect(201)).body.id;
    await put(`/v1/cranes/fleet/${van}`, { max_capacity_t: 50, chart }).expect(400);
    // a lift before the chart is refused
    expect((await lift().expect(409)).body.message).toMatch(/^no_chart/);
    expect((await put(`/v1/cranes/fleet/${crane}`, { max_capacity_t: 50, boom_m: 40, wind_limit_ms: 9, chart }).expect(200)).body).toMatchObject({ wind_limit_ms: 9 });
    const f = (await get('/v1/cranes/fleet').expect(200)).body.data;
    expect(f.find((x: { asset_id: string }) => x.asset_id === crane)).toMatchObject({ max_capacity_t: 50, cert_expires_on: null });
    const ex = (await get('/v1/cranes/exceptions').expect(200)).body;
    expect(ex.certificates.map((x: { asset_id: string }) => x.asset_id)).toContain(crane);
  });

  it('a lift plan: rated capacity from the chart; over capacity, beyond the chart and missing certificates refused', async () => {
    expect((await lift().expect(409)).body.message).toMatch(/^crane_cert/);
    await doc({ asset_id: crane }, 'tpi_certificate', kwDay(200));
    expect((await lift().expect(409)).body.message).toMatch(/^operator_cert/);
    await doc({ worker_id: op1.id }, 'crane_operator', kwDay(200));
    expect((await lift().expect(409)).body.message).toMatch(/^rigger_cert/);
    await doc({ worker_id: rigger }, 'rigger_cert', kwDay(200));
    expect((await lift({ load_t: 9, radius_m: 15 }).expect(409)).body.message).toMatch(/^over_capacity/); // rated 8 t at 20 m
    expect((await lift({ radius_m: 35 }).expect(409)).body.message).toMatch(/^out_of_chart/);
    expect((await lift({ lift_date: kwDay(5) }).expect(409)).body.message).toMatch(/^no_work_day/);
    const l = (await lift({ load_t: 10, radius_m: 8 }).expect(201)).body; // rated 20 t at 10 m
    expect(l).toMatchObject({ ref: expect.stringMatching(/^LP-\d+$/), rated_t: 20, utilization: 50, critical: false, status: 'planned', rigger_name: 'الموجّه سالم', operator_name: 'مشغّل الرافعة' });
    dayTask = l.task_id;
    const c = (await lift({ load_t: 16, radius_m: 10, lift_time: '11:00', description: 'رفع مولد' }).expect(201)).body;
    expect(c).toMatchObject({ utilization: 80, critical: true, approved_at: null });
    expect((await lift({ load_t: 2, radius_m: 5, over_people: true, lift_time: '13:00', description: 'رفع فوق ممر' }).expect(201)).body.critical).toBe(true);
    const ex = (await get('/v1/cranes/exceptions').expect(200)).body;
    expect(ex.unapproved.map((x: { id: string }) => x.id)).toContain(c.id);
    expect(ex.certificates.map((x: { asset_id: string }) => x.asset_id)).not.toContain(crane);
  });

  it('the operator records lifts with the wind; critical needs approval; the day cannot end with an open lift', async () => {
    const t = (await get('/v1/driver/tasks', op1.token).expect(200)).body.data.find((x: { id: string }) => x.id === dayTask);
    expect(t.lifts).toHaveLength(3);
    expect(t.lifts[0]).toMatchObject({ ref: expect.any(String), time: '09:00:00', utilization: 50, critical: false, approved: false, status: 'planned', wind_limit_ms: 9 });
    const [easy, crit, people] = t.lifts as { id: string }[];
    expect((await op({ type: 'lift', task_id: t.id, lift_id: easy.id, event: 'done', wind_ms: 5 })).reason).toBe('invalid_transition'); // not started yet
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, ago(30));
    await op({ type: 'milestone', task_id: t.id, code: 'work_start', meter_hours: 100 }, ago(29));
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, ago(28));
    expect((await op({ type: 'lift', task_id: t.id, lift_id: easy.id, event: 'done' })).reason).toBe('wind_required');
    expect((await op({ type: 'lift', task_id: t.id, lift_id: easy.id, event: 'done', wind_ms: 11 })).reason).toBe('wind_too_high');
    expect((await op({ type: 'lift', task_id: t.id, lift_id: easy.id, event: 'done', wind_ms: 6.4 })).result).toBe('applied');
    expect((await op({ type: 'lift', task_id: t.id, lift_id: easy.id, event: 'done', wind_ms: 6 })).reason).toBe('lift_closed');
    expect((await op({ type: 'lift', task_id: t.id, lift_id: crit.id, event: 'done', wind_ms: 4 })).reason).toBe('lift_not_approved');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_end', meter_hours: 106, received_by: 'م. ناصر' })).reason).toBe('lifts_open');
    const ap = (await post(`/v1/cranes/lifts/${crit.id}/approve`, {}).expect(200)).body;
    expect(ap.approved_by_name).toBeTruthy();
    expect((await op({ type: 'lift', task_id: t.id, lift_id: crit.id, event: 'done', wind_ms: 4 })).result).toBe('applied');
    expect((await op({ type: 'lift', task_id: t.id, lift_id: people.id, event: 'aborted' })).reason).toBe('abort_reason_required');
    // aborted for wind; re-sending the same op is a duplicate, not a second record
    const id = randomUUID();
    const send = () => post('/v1/driver/sync', { ops: [{ client_op_id: id, occurred_at: ago(1), type: 'lift', task_id: t.id, lift_id: people.id, event: 'aborted', wind_ms: 12, note: 'رياح قوية' }] }, op1.token).expect(200);
    expect((await send()).body.results[0].result).toBe('applied');
    expect((await send()).body.results[0].result).toBe('duplicate');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_end', meter_hours: 106, received_by: 'م. ناصر' })).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).result).toBe('applied');
    const day = (await get(`/v1/cranes/lifts?date=${kwDay(0)}`).expect(200)).body.data;
    expect(day.map((x: { status: string }) => x.status)).toEqual(['done', 'done', 'aborted']);
    expect(day[0]).toMatchObject({ wind_ms: 6.4, day_status: 'completed' });
    await lift({ lift_time: '15:00' }).expect(409); // the working day is over
  });

  it('the office records, cancels; the report per customer', async () => {
    const l = (await lift({ lift_date: kwDay(1), load_t: 3, radius_m: 18 }).expect(201)).body;
    await post(`/v1/cranes/lifts/${l.id}/cancel`, {}).expect(400);
    expect((await post(`/v1/cranes/lifts/${l.id}/cancel`, { reason: 'العميل أجّل' }).expect(200)).body.status).toBe('canceled');
    await post(`/v1/cranes/lifts/${l.id}/record`, { event: 'done', wind_ms: 3 }).expect(409);
    const l2 = (await lift({ lift_date: kwDay(1), load_t: 3, radius_m: 18, lift_time: '10:00' }).expect(201)).body;
    expect((await post(`/v1/cranes/lifts/${l2.id}/record`, { event: 'done', wind_ms: 3 }).expect(200)).body.status).toBe('done');
    const r = (await get(`/v1/cranes/report?from=${kwDay(0)}&to=${kwDay(1)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ lifts: 4, done: 3, aborted: 1, aborted_wind: 1, critical: 1, max_utilization: 80, heaviest_t: 16, canceled: 1 });
    expect(r.customers[0]).toMatchObject({ customer_name: 'مقاولات البناء', lifts: 4 });
    // another pack's company cannot reach the cranes endpoints
    const { user_token } = await login(app, newPhone());
    const other = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'توصيل', packs: ['delivery'] }).expect(201)).body;
    await get('/v1/cranes/lifts', other.access_token).expect(403);
  });
});
