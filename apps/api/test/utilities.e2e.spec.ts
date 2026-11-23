/**
 * Utilities field work (utilities pack, sector 24): a work order with priority and due time; a crew booked; the crew
 * arrives, isolates (a dig needs a valid permit and the safety checklist), repairs with a result, reinstates the road;
 * the order cannot close before; exceptions (response breach, permits, follow-up) and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Utilities pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, van: string, van2: string, mew: string;
  let lead: { token: string; id: string };
  let lead2: string;
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const put = (path: string, body: Record<string, unknown>, token = T) => request(http).put(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  async function op(o: Record<string, unknown>, at = ago(1)) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, lead.token).expect(200)).body.results[0];
  }
  const job = (o: Record<string, unknown> = {}) => post('/v1/utilities/jobs', { legal_entity_id: le, customer_id: mew, network: 'electricity', job_type: 'outage', priority: 'emergency',
    area: 'الجابرية', address: 'ق 1 ش 5', asset_ref: 'SS-JAB-112', description: 'انقطاع كهرباء عن المجمع', affected: 120, ...o });

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'مقاولات الشبكات', packs: ['utilities'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'رئيس الفرقة', phone }).expect(201)).body;
    lead = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    lead2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'الفرقة الثانية', phone: newPhone() }).expect(201)).body.id;
    van = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'pickup', plate_no: `UT-${Date.now() % 100000}` }).expect(201)).body.id;
    van2 = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'pickup', plate_no: `UV-${Date.now() % 100000}` }).expect(201)).body.id;
    mew = (await post('/v1/customers', { legal_entity_id: le, name: 'وزارة الكهرباء والماء' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('an emergency outage: due in two hours; the crew arrives, isolates, restores; response and outage minutes', async () => {
    await job({ network: 'gas' }).expect(400);
    await job({ reported_at: new Date(Date.now() + 3_600_000).toISOString() }).expect(400);
    const j = (await job({ reported_at: ago(50) }).expect(201)).body;
    expect(j).toMatchObject({ ref: expect.stringMatching(/^UJ-\d+$/), state: 'open', needs_permit: false, customer_name: 'وزارة الكهرباء والماء', affected: 120, breached: false });
    expect(Math.round((Date.parse(j.due_at) - Date.parse(j.reported_at)) / 60_000)).toBe(120);
    const a = (await post(`/v1/utilities/jobs/${j.id}/assign`, { worker_id: lead.id, asset_id: van, start_at: ago(48) }).expect(201)).body;
    expect(a).toMatchObject({ state: 'assigned', lead_name: 'رئيس الفرقة', plate_no: expect.any(String) });
    // the same crew cannot be booked on another order at the same time
    const other = (await job({ priority: 'urgent' }).expect(201)).body;
    expect((await post(`/v1/utilities/jobs/${other.id}/assign`, { worker_id: lead.id, asset_id: van2 }).expect(409)).body.message).toMatch(/^worker_booked/);
    const t = (await get('/v1/driver/tasks', lead.token).expect(200)).body.data.find((x: { id: string }) => x.id === a.task_id);
    expect(t.attributes).toMatchObject({ kind: 'work_order', job_ref: j.ref, network: 'electricity', job_type: 'outage', priority: 'emergency', asset_ref: 'SS-JAB-112', address: 'ق 1 ش 5، الجابرية' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, ago(45));
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, ago(44));
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_isolated', checks: {} })).reason).toBe('stage_out_of_order');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_arrived' }, ago(20))).result).toBe('applied');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_isolated' })).reason).toBe('checks_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_isolated', checks: { isolation: true, ppe: true } })).reason).toBe('checks_failed');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_isolated', checks: { isolation: true, ppe: true, barriers: true } }, ago(18))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_restored' })).reason).toBe('result_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_restored', result: 'follow_up', note: 'تغذية مؤقتة من محطة مجاورة' }, ago(10))).result).toBe('applied');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ut_reinstated' })).reason).toBe('not_required');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).result).toBe('applied');
    const d = (await get(`/v1/utilities/jobs/${j.id}`).expect(200)).body;
    expect(d).toMatchObject({ state: 'done', response_min: 30, restore_min: 40, breached: false, result: 'follow_up', checks: { isolation: true, ppe: true, barriers: true } });
    // the crew is free after the repair
    expect((await post(`/v1/utilities/jobs/${other.id}/assign`, { worker_id: lead.id, asset_id: van2 }).expect(201)).body.state).toBe('assigned');
    expect((await post(`/v1/utilities/jobs/${other.id}/cancel`, { reason: 'مكرر' }).expect(200)).body.state).toBe('canceled');
  });

  it('an excavation: no isolation without a valid permit; the order closes only reinstated', async () => {
    const j = (await job({ network: 'water', job_type: 'excavation', priority: 'planned', reported_at: ago(37), description: 'إصلاح كسر خط مياه 200 مم', affected: 0, duration_min: 480 }).expect(201)).body;
    expect(j.needs_permit).toBe(true);
    const ex0 = (await get('/v1/utilities/exceptions').expect(200)).body;
    expect(ex0.permits.map((x: { id: string }) => x.id)).toContain(j.id);
    const a = (await post(`/v1/utilities/jobs/${j.id}/assign`, { worker_id: lead.id, asset_id: van, start_at: ago(9.5) }).expect(201)).body;
    await op({ type: 'task_status', task_id: a.task_id, to_status: 'accepted' }, ago(9));
    await op({ type: 'task_status', task_id: a.task_id, to_status: 'in_progress' }, ago(8));
    await op({ type: 'milestone', task_id: a.task_id, code: 'ut_arrived' }, ago(7));
    const checks = { isolation: true, ppe: true, barriers: true, permit_on_site: true };
    expect((await op({ type: 'milestone', task_id: a.task_id, code: 'ut_isolated', checks })).reason).toBe('permit_required');
    await put(`/v1/utilities/jobs/${j.id}/permit`, { permit_no: 'DIG-2026-551', permit_expires: kwDay(-1) }).expect(200);
    expect((await op({ type: 'milestone', task_id: a.task_id, code: 'ut_isolated', checks })).reason).toBe('permit_expired');
    await put(`/v1/utilities/jobs/${j.id}/permit`, { permit_no: 'DIG-2026-551', permit_expires: kwDay(10) }).expect(200);
    expect((await op({ type: 'milestone', task_id: a.task_id, code: 'ut_isolated', checks: { ...checks, permit_on_site: false } })).reason).toBe('checks_failed');
    expect((await op({ type: 'milestone', task_id: a.task_id, code: 'ut_isolated', checks }, ago(6))).result).toBe('applied');
    expect((await op({ type: 'milestone', task_id: a.task_id, code: 'ut_restored', result: 'fixed' }, ago(4))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: a.task_id, to_status: 'completed' })).reason).toBe('reinstatement_required');
    expect((await op({ type: 'milestone', task_id: a.task_id, code: 'ut_reinstated' }, ago(2))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: a.task_id, to_status: 'completed' })).result).toBe('applied');
    expect((await get(`/v1/utilities/jobs/${j.id}`).expect(200)).body).toMatchObject({ state: 'done', permit_no: 'DIG-2026-551', result: 'fixed' });
  });

  it('exceptions: a response breach and a temporary repair to follow up; the report', async () => {
    const late = (await job({ reported_at: ago(200), description: 'عمود إنارة ساقط' }).expect(201)).body; // due 80 minutes ago
    const ex = (await get('/v1/utilities/exceptions').expect(200)).body;
    expect(ex.response_breach.map((x: { id: string }) => x.id)).toContain(late.id);
    expect(ex.follow_up.map((x: { description: string }) => x.description)).toContain('انقطاع كهرباء عن المجمع');
    const r = (await get(`/v1/utilities/report?from=${kwDay(-1)}&to=${kwDay(0)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ jobs: 3, done: 2, breached: 1, avg_response_min: 30, customer_minutes: 120 * 40, follow_up: 1 });
    expect(r.networks.map((x: { key: string }) => x.key).sort()).toEqual(['electricity', 'water']);
    expect(r.customers[0]).toMatchObject({ key: 'وزارة الكهرباء والماء', jobs: 3 });
    const { user_token } = await login(app, newPhone());
    const other = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'توصيل', packs: ['delivery'] }).expect(201)).body;
    await get('/v1/utilities/jobs', other.access_token).expect(403);
    void lead2;
  });
});
