/**
 * Technical maintenance (service pack, sector 22): a job with a response time; a technician booked for a visit records
 * arrival and the result from the app (work done, parts, the customer's name); a follow-up visit; the office closes the
 * job with the amounts; preventive plans create jobs; exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Technical maintenance pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, client: string, van: string;
  let tech: { token: string; id: string }, tech2: string;
  let job: { id: string; ref: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const site = { name: 'فيلا 12', area: 'مشرف', block: '3', street: '310', phone: '+96550002222' };
  async function op(o: Record<string, unknown>) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, tech.token).expect(200)).body.results[0];
  }
  const visitTask = async (ref: string) => (await get('/v1/driver/tasks', tech.token).expect(200)).body.data.find((x: { ref: string }) => x.ref === ref);

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'الصيانة الفنية', packs: ['service'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فني التكييف', phone }).expect(201)).body;
    tech = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    tech2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فني الكهرباء', phone: newPhone() }).expect(201)).body.id;
    van = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'van', plate_no: `SV-${Date.now() % 100000}` }).expect(201)).body.id;
    client = (await post('/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'أم عبدالله' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a job with a response time; a technician and van booked for a visit', async () => {
    const base = { legal_entity_id: le, customer_id: client, site, category: 'ac', priority: 'urgent', problem: 'المكيف لا يبرد', unit: { brand: 'Gree', location: 'الصالة' } };
    await post('/v1/service/jobs', { ...base, category: 'cars' }).expect(400);
    await post('/v1/service/jobs', { ...base, site: {} }).expect(400);
    const j = (await post('/v1/service/jobs', base).expect(201)).body;
    expect(j).toMatchObject({ ref: expect.stringMatching(/^WO-\d+$/), state: 'new', priority: 'urgent' });
    expect(Date.parse(j.due_by) - Date.parse(j.created_at)).toBeGreaterThan(3.9 * 3_600_000);
    job = { id: j.id, ref: j.ref };
    const v1 = (await post(`/v1/service/jobs/${j.id}/visits`, { technician_worker_id: tech.id, asset_id: van }).expect(201)).body;
    expect(v1).toMatchObject({ state: 'scheduled', visits: [{ seq: 1, technician_name: 'فني التكييف', status: 'assigned' }] });
    await post(`/v1/service/jobs/${j.id}/visits`, { technician_worker_id: tech2 }).expect(409); // one open visit at a time
    const other = (await post('/v1/service/jobs', { ...base, priority: 'normal' }).expect(201)).body;
    await post(`/v1/service/jobs/${other.id}/visits`, { technician_worker_id: tech.id }).expect(409); // the technician is booked
    await post(`/v1/service/jobs/${other.id}/cancel`, { reason: 'مكرر' }).expect(200);
    const b = (await get('/v1/service/board').expect(200)).body;
    expect(b.visits.map((x: { job_ref: string }) => x.job_ref)).toContain(j.ref);
  });

  it('the technician arrives and records the result: needs another visit, then fixed', async () => {
    const t = await visitTask(`${job.ref}-1`);
    expect(t.attributes).toMatchObject({ kind: 'visit', category: 'ac', priority: 'urgent', problem: 'المكيف لا يبرد', address: 'فيلا 12، مشرف، ق 3، 310' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' });
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_done', result: 'fixed', note: 'x', received_by: 'y' })).reason).toBe('stage_out_of_order');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'arrived' })).toMatchObject({ result: 'applied' });
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_done', note: 'فحص' })).reason).toBe('result_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_done', result: 'follow_up' })).reason).toBe('work_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_done', result: 'follow_up', note: 'فحص' })).reason).toBe('signer_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'work_done', result: 'follow_up', note: 'فحص', received_by: 'أم عبدالله', parts: [{ name: '', qty: 1 }] })).reason).toBe('parts_invalid');
    expect(await op({ type: 'milestone', task_id: t.id, code: 'work_done', result: 'follow_up', note: 'الكمبروسر يحتاج تبديل', received_by: 'أم عبدالله', parts: [{ name: 'فريون R410', qty: 1 }] })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    let j = (await get(`/v1/service/jobs/${job.id}`).expect(200)).body;
    expect(j).toMatchObject({ state: 'follow_up', visits: [{ result: 'follow_up', signed_by: 'أم عبدالله', parts: [{ name: 'فريون R410', qty: 1 }] }] });
    expect(j.first_arrival).not.toBeNull();
    // a second visit by another technician, recorded by the office from the job card
    j = (await post(`/v1/service/jobs/${job.id}/visits`, { technician_worker_id: tech2, starts_at: new Date(Date.now() + 3 * 3_600_000).toISOString() }).expect(201)).body;
    const v2 = j.visits[1];
    await post(`/v1/service/jobs/${job.id}/close`, {}).expect(409);
    await post(`/v1/service/visits/${v2.task_id}/record`, { result: 'fixed', work_done: 'تبديل الكمبروسر', parts: [{ name: 'كمبروسر', qty: 1 }], signed_by: 'أم عبدالله' }).expect(200);
    await post(`/v1/service/visits/${v2.task_id}/record`, { result: 'fixed', work_done: 'x' }).expect(409);
    const closed = (await post(`/v1/service/jobs/${job.id}/close`, { labour_amount: '15', parts_amount: '85.500' }).expect(200)).body;
    expect(closed).toMatchObject({ state: 'closed', outcome: 'fixed', total: '100.500' });
  });

  it('a preventive plan creates jobs ahead of their date', async () => {
    const p = (await post('/v1/service/plans', { legal_entity_id: le, customer_id: client, name: 'تنظيف المكيفات', site, category: 'ac', every_days: 7, first_due: kwDay(1), tasks_note: 'تنظيف الفلاتر' }).expect(201)).body;
    expect(p).toMatchObject({ every_days: 7, next_due: kwDay(1) });
    const g = (await post('/v1/service/plans/generate', {}).expect(200)).body;
    expect(g.created).toHaveLength(1); // day 1 is within the 7-day horizon, day 8 is not yet
    expect((await post('/v1/service/plans/generate', {}).expect(200)).body.created).toEqual([]);
    expect((await post('/v1/service/plans/generate', { date: kwDay(1) }).expect(200)).body.created).toHaveLength(1);
    expect((await get('/v1/service/plans').expect(200)).body.data[0]).toMatchObject({ jobs: 2, next_due: kwDay(15) });
  });

  it('exceptions and the report', async () => {
    const e = (await get('/v1/service/exceptions').expect(200)).body;
    expect(e.unassigned.length).toBeGreaterThanOrEqual(1);
    expect(e.to_close).toEqual([]);
    const r = (await get(`/v1/service/report?from=${kwDay(-1)}&to=${kwDay(0)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ closed: 1, fixed: 1, on_time_pct: 100, first_fix_pct: 0, labour: '15.000', parts: '85.500' });
    expect(r.technicians.find((x: { technician_name: string }) => x.technician_name === 'فني التكييف')).toMatchObject({ visits: 1, follow_up: 1 });
    expect(r.categories[0]).toMatchObject({ category: 'ac' });
  });
});
