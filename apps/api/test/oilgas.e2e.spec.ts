/**
 * Oil and gas services (oilgas pack, sector 18): sites with the documents drivers and vehicles must hold; journey plans
 * approved by the journey manager; assignment refused for missing or expiring documents and too few seats; the driver's
 * pre-trip inspection (a failed one kept), departure only once approved, repeated call-ins, the arrival; overdue alarms,
 * cancel and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Oil and gas pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, operator: string, site: string, van: string, pickup: string, bare: string;
  let d1: { token: string; id: string }, d2: { token: string; id: string };
  let jm: { id: string; ref: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const put = (path: string, body: Record<string, unknown>, token = T) => request(http).put(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  async function op(o: Record<string, unknown>, token = d1.token, at = new Date()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at.toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }
  const taskOf = async (token: string, ref: string) => (await get('/v1/driver/tasks', token).expect(200)).body.data.find((x: { ref: string }) => x.ref.startsWith(ref));
  const doc = (owner: Record<string, string>, doc_type: string, expires_on: string) => post('/v1/documents', { ...owner, doc_type, expires_on }).then((r) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r; });
  const allOk = { tyres: true, brakes: true, lights: true, seat_belts: true, fire_extinguisher: true, first_aid: true, spill_kit: true, h2s_monitor: true };

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'خدمات الحقول', packs: ['oilgas'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const driver = async (name: string) => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: name, phone }).expect(201)).body;
      return { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    };
    d1 = await driver('عبدالله'); d2 = await driver('حسين');
    const asset = async (type: string, plate: string, capacity?: Record<string, number>) =>
      (await post('/v1/assets', { legal_entity_id: le, asset_type: type, plate_no: `${plate}-${Date.now() % 100000}`, ...(capacity ? { capacity } : {}) }).expect(201)).body.id;
    van = await asset('van', 'OG1', { seats: 14 }); pickup = await asset('pickup', 'OG2', { seats: 4 }); bare = await asset('van', 'OG3', { seats: 14 });
    operator = (await post('/v1/customers', { legal_entity_id: le, name: 'شركة الحفر الوطنية', kind: 'business' }).expect(201)).body.id;
    for (const t of ['h2s', 'site_pass', 'hazmat']) await doc({ worker_id: d1.id }, t, kwDay(200));
    await doc({ worker_id: d2.id }, 'h2s', kwDay(-5)); // expired
    await doc({ worker_id: d2.id }, 'site_pass', kwDay(200));
    await doc({ asset_id: van }, 'site_sticker', kwDay(100));
    await doc({ asset_id: pickup }, 'site_sticker', kwDay(100));
  });
  afterAll(async () => app?.close());

  it('a site with its required documents, H2S zone and call-in interval', async () => {
    await post('/v1/oilgas/sites', { legal_entity_id: le, code: 'BRG-GC1', name: 'مركز تجميع 1', worker_docs: ['h2s', 'unknown_doc'] }).expect(400);
    const s = (await post('/v1/oilgas/sites', { legal_entity_id: le, code: 'brg-gc1', name: 'مركز تجميع 1', field: 'برقان', customer_id: operator, worker_docs: ['h2s', 'site_pass'],
      asset_docs: ['site_sticker'], h2s_zone: true, checkin_min: 30, lat: 28.95, lng: 47.95 }).expect(201)).body;
    expect(s).toMatchObject({ code: 'BRG-GC1', h2s_zone: true, checkin_min: 30, worker_docs: ['h2s', 'site_pass'] });
    await post('/v1/oilgas/sites', { legal_entity_id: le, code: 'BRG-GC1', name: 'x' }).expect(409);
    expect((await put(`/v1/oilgas/sites/${s.id}`, { notes: 'البوابة الشمالية فقط' }).expect(200)).body.notes).toBe('البوابة الشمالية فقط');
    expect((await get('/v1/oilgas/sites').expect(200)).body.data).toHaveLength(1);
    site = s.id;
  });

  it('a journey plan; assignment refused for missing or expired documents and seats', async () => {
    const base = { site_id: site, purpose: 'crew', from_place: 'قاعدة الأحمدي', depart_at: inMin(-30), eta_at: inMin(60), passengers: 10 };
    await post('/v1/oilgas/journeys', { ...base, eta_at: inMin(-40) }).expect(400);
    await post('/v1/oilgas/journeys', { ...base, depart_at: inMin(-180) }).expect(400);
    await post('/v1/oilgas/journeys', { ...base, hazmat: true }).expect(400); // cargo required
    const j = (await post('/v1/oilgas/journeys', { ...base, end_at: inMin(120), cargo: 'أسطوانات غاز نيتروجين', hazmat: true }).expect(201)).body;
    expect(j).toMatchObject({ ref: expect.stringMatching(/^JM-\d+$/), state: 'draft', site_code: 'BRG-GC1', customer_name: 'شركة الحفر الوطنية', hazmat: true });
    jm = j;
    const cand = (await get(`/v1/oilgas/journeys/${j.id}/candidates`).expect(200)).body;
    expect(cand.worker_docs).toEqual(['h2s', 'site_pass', 'hazmat']);
    expect(cand.drivers.find((x: { id: string }) => x.id === d1.id).missing).toEqual([]);
    expect(cand.drivers.find((x: { id: string }) => x.id === d2.id).missing).toEqual(['h2s', 'hazmat']);
    expect(cand.vehicles.find((x: { asset_id: string }) => x.asset_id === bare).missing).toEqual(['site_sticker']);
    expect((await post(`/v1/oilgas/journeys/${j.id}/assign`, { asset_id: van, driver_worker_id: d2.id }).expect(409)).body.message).toMatch(/driver_docs.*h2s/);
    expect((await post(`/v1/oilgas/journeys/${j.id}/assign`, { asset_id: bare, driver_worker_id: d1.id }).expect(409)).body.message).toMatch(/vehicle_docs.*site_sticker/);
    expect((await post(`/v1/oilgas/journeys/${j.id}/assign`, { asset_id: pickup, driver_worker_id: d1.id }).expect(409)).body.message).toMatch(/over_seats/);
    const a = (await post(`/v1/oilgas/journeys/${j.id}/assign`, { asset_id: van, driver_worker_id: d1.id }).expect(201)).body;
    expect(a).toMatchObject({ state: 'assigned', driver_name: 'عبدالله' });
    const t = await taskOf(d1.token, j.ref);
    expect(t.attributes).toMatchObject({ kind: 'journey', site_code: 'BRG-GC1', hazmat: true, h2s_zone: true, checkin_min: 30, passengers: 10 });
    const ex = (await get('/v1/oilgas/exceptions').expect(200)).body;
    expect(ex.not_approved.map((x: { id: string }) => x.id)).toContain(j.id);
  });

  it('the driver inspects, leaves once approved, calls in and arrives; missed call-ins are flagged', async () => {
    const t = await taskOf(d1.token, jm.ref);
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_inspected' })).toMatchObject({ result: 'rejected', reason: 'checks_required' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_inspected', checks: { ...allOk, brakes: false } }, d1.token, ago(58))).toMatchObject({ result: 'rejected', reason: 'inspection_failed' });
    expect((await get('/v1/oilgas/exceptions').expect(200)).body.failed_inspections[0]).toMatchObject({ ref: jm.ref, failed_items: ['brakes'] });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_inspected', checks: { ...allOk, h2s_monitor: undefined } }, d1.token, ago(57))).toMatchObject({ result: 'rejected', reason: 'inspection_failed' }); // H2S zone
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, d1.token, ago(60));
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_departed' })).toMatchObject({ result: 'rejected', reason: 'stage_out_of_order' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_inspected', checks: allOk }, d1.token, ago(55))).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_departed' }, d1.token, ago(50))).toMatchObject({ result: 'rejected', reason: 'not_approved' });
    expect((await post(`/v1/oilgas/journeys/${jm.id}/approve`, {}).expect(200)).body).toMatchObject({ state: 'ready', approved_by_name: expect.anything() });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_departed' }, d1.token, ago(50))).toMatchObject({ result: 'applied' });
    let j = (await get(`/v1/oilgas/journeys/${jm.id}`).expect(200)).body;
    expect(j.state).toBe('en_route');
    expect((await get('/v1/oilgas/exceptions').expect(200)).body.overdue_checkin.map((x: { id: string }) => x.id)).toContain(jm.id); // 30 min interval, left 50 min ago
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_checkin' }, d1.token, ago(20))).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_checkin' }, d1.token, ago(5))).toMatchObject({ result: 'applied' }); // repeatable
    expect((await get('/v1/oilgas/exceptions').expect(200)).body.overdue_checkin.map((x: { id: string }) => x.id)).not.toContain(jm.id);
    j = (await post(`/v1/oilgas/journeys/${jm.id}/checkin`, { note: 'اتصال لاسلكي عند بوابة الحقل' }).expect(200)).body;
    expect(j.checkins).toBe(3);
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'rejected', reason: 'proof_required' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_arrived' })).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'milestone', task_id: t.id, code: 'og_arrived' })).toMatchObject({ result: 'rejected', reason: 'stage_already_recorded' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    expect((await get(`/v1/oilgas/journeys/${jm.id}`).expect(200)).body).toMatchObject({ state: 'done', inspection: { passed: true } });
  });

  it('a journey canceled before leaving; a finished one cannot be', async () => {
    const j = (await post('/v1/oilgas/journeys', { site_id: site, purpose: 'water', from_place: 'محطة مياه الوفرة', depart_at: inMin(240), eta_at: inMin(330) }).expect(201)).body;
    expect((await get(`/v1/oilgas/journeys/${j.id}/candidates`).expect(200)).body.worker_docs).toEqual(['h2s', 'site_pass']); // no hazmat document needed
    await post(`/v1/oilgas/journeys/${j.id}/assign`, { asset_id: van, driver_worker_id: d1.id }).expect(201); // the van is free again since the arrival
    expect((await post(`/v1/oilgas/journeys/${j.id}/cancel`, { reason: 'أُغلق الموقع للصيانة' }).expect(200)).body.state).toBe('canceled');
    await post(`/v1/oilgas/journeys/${jm.id}/cancel`, { reason: 'x' }).expect(409);
  });

  it('the report per site', async () => {
    await get('/v1/oilgas/report').expect(400);
    const r = (await get(`/v1/oilgas/report?from=${kwDay(-1)}&to=${kwDay(1)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ journeys: 2, done: 1, on_time: 1, late: 0, canceled: 1, passengers: 10, hazmat: 1, checkins: 3 });
    expect(r.sites[0]).toMatchObject({ site_code: 'BRG-GC1', customer_name: 'شركة الحفر الوطنية', journeys: 2 });
  });
});
