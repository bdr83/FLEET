/**
 * Security guarding and patrols (security pack, sector 25): a customer site with checkpoints and patrol times; the day's
 * patrols generated for the guard; the guard scans checkpoints with their tags, skips one with a reason, reports an
 * incident; the patrol cannot end with a checkpoint open; exceptions (late patrol, skipped, open incidents) and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Security pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, cu: string, guard2: string;
  let guard: { token: string; id: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwNow = (min = 0) => new Date(Date.now() + 3 * 3_600_000 + min * 60_000);
  const kwDay = (plus = 0) => kwNow(plus * 1440).toISOString().slice(0, 10);
  const hm = (min: number) => kwNow(min).toISOString().slice(11, 16);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  async function op(o: Record<string, unknown>, at = ago(1)) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, guard.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'شركة الحراسة', packs: ['security'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'guard', display_name: 'الحارس سالم', phone }).expect(201)).body;
    guard = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    guard2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'guard', display_name: 'الحارس فهد', phone: newPhone() }).expect(201)).body.id;
    cu = (await post('/v1/customers', { legal_entity_id: le, name: 'مجمع الأفنيوز' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a site with checkpoints; the day\'s patrols generated; a site without a guard skipped', async () => {
    await post('/v1/security/sites', { legal_entity_id: le, code: 'AVN', name: 'المجمع', patrol_times: ['25:00'] }).expect(400);
    const s = (await post('/v1/security/sites', { legal_entity_id: le, code: 'avn', name: 'مجمع الأفنيوز: المواقف', customer_id: cu, area: 'الري',
      patrol_times: [hm(-10)], duration_min: 120, guard_worker_id: guard.id, instructions: 'تأكد من إغلاق باب المخزن' }).expect(201)).body;
    expect(s).toMatchObject({ code: 'AVN', guard_name: 'الحارس سالم', customer_name: 'مجمع الأفنيوز', checkpoints: 0 });
    for (const [name, tag] of [['البوابة الرئيسية', 'cp-gate'], ['المخزن', 'CP-STORE'], ['السطح', 'CP-ROOF']]) {
      await post(`/v1/security/sites/${s.id}/checkpoints`, { name, tag }).expect(201);
    }
    expect((await post(`/v1/security/sites/${s.id}/checkpoints`, { name: 'مكرر', tag: 'CP-GATE' }).expect(409)).body.message).toMatch(/tag/);
    const w2 = (await post('/v1/security/sites', { legal_entity_id: le, code: 'WH', name: 'مستودع الشويخ', customer_id: cu, patrol_times: [hm(-40)], duration_min: 120, guard_worker_id: guard2 }).expect(201)).body;
    await post(`/v1/security/sites/${w2.id}/checkpoints`, { name: 'الباب', tag: 'WH-01' }).expect(201);
    await post('/v1/security/sites', { legal_entity_id: le, code: 'NOG', name: 'موقع بلا حارس', patrol_times: [hm(30)] }).expect(201);
    const g = (await post('/v1/security/patrols/generate', { date: kwDay() }).expect(201)).body;
    expect(g.created.sort()).toEqual([`AVN ${hm(-10)}`, `WH ${hm(-40)}`].sort());
    expect(g.skipped).toEqual([{ patrol: `NOG ${hm(30)}`, reason: 'no_guard' }]);
    expect((await post('/v1/security/patrols/generate', { date: kwDay() }).expect(201)).body.existing).toHaveLength(2);
  });

  it('the guard: tags checked, a skip needs a reason, an incident; the patrol ends only with every checkpoint marked', async () => {
    const t = (await get('/v1/driver/tasks', guard.token).expect(200)).body.data.find((x: { attributes: { site_code?: string } }) => x.attributes.site_code === 'AVN');
    expect(t.attributes).toMatchObject({ kind: 'patrol', site_name: 'مجمع الأفنيوز: المواقف', checkpoints: 3, instructions: 'تأكد من إغلاق باب المخزن' });
    const [gate, store, roof] = t.security.checkpoints as { id: string; name: string }[];
    expect(gate.name).toBe('البوابة الرئيسية');
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: gate.id, event: 'scanned', tag: 'CP-GATE' })).reason).toBe('invalid_transition');
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, ago(9));
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, ago(8));
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: gate.id, event: 'scanned', tag: 'CP-ROOF' })).reason).toBe('tag_mismatch');
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: gate.id, event: 'scanned' })).reason).toBe('tag_required');
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: gate.id, event: 'scanned', tag: 'cp gate' })).reason).toBe('tag_mismatch');
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: gate.id, event: 'scanned', tag: 'cp-gate' }, ago(7))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('checkpoints_open');
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: store.id, event: 'skipped' })).reason).toBe('skip_reason_required');
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: store.id, event: 'skipped', reason: 'locked', note: 'الباب مقفل والمفتاح مع الإدارة' }, ago(6))).result).toBe('applied');
    expect((await op({ type: 'incident', task_id: t.id, category: 'intrusion', severity: 'high' })).reason).toBe('description_required');
    expect((await op({ type: 'incident', task_id: t.id, category: 'intrusion', severity: 'high', note: 'سياج مقطوع خلف المواقف' }, ago(5))).result).toBe('applied');
    expect((await op({ type: 'scan', task_id: t.id, checkpoint_id: roof.id, event: 'scanned', tag: 'CP-ROOF' }, ago(4))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).result).toBe('applied');
    const p = (await get('/v1/security/patrols').expect(200)).body.data.find((x: { site_code: string }) => x.site_code === 'AVN');
    expect(p).toMatchObject({ status: 'completed', scanned: 2, skipped: 1, incidents: 1, checkpoints_planned: 3, guard_name: 'الحارس سالم' });
    const d = (await get(`/v1/security/patrols/${p.id}`).expect(200)).body;
    expect(d.checkpoints.map((x: { event: string }) => x.event)).toEqual(['scanned', 'skipped', 'scanned']);
    expect(d.incidents[0]).toMatchObject({ ref: 'IN-1', category: 'intrusion', severity: 'high', reported_by_name: 'الحارس سالم', closed_at: null });
  });

  it('exceptions, incidents closed by the office, and the report', async () => {
    const ex = (await get('/v1/security/exceptions').expect(200)).body;
    expect(ex.late_start.map((x: { site_code: string }) => x.site_code)).toEqual(['WH']);
    expect(ex.skipped).toMatchObject([{ tag: 'CP-STORE', reason: 'locked', site_code: 'AVN' }]);
    expect(ex.open_incidents.map((x: { ref: string }) => x.ref)).toEqual(['IN-1']);
    expect(ex.no_guard_or_checkpoints.map((x: { code: string }) => x.code)).toEqual(['NOG']);
    const site = (await get('/v1/security/sites').expect(200)).body.data.find((x: { code: string }) => x.code === 'WH');
    const inc = (await post('/v1/security/incidents', { site_id: site.id, category: 'damage', severity: 'low', description: 'إنارة معطلة عند الباب' }).expect(201)).body;
    expect(inc).toMatchObject({ ref: 'IN-2', source: 'office', site_code: 'WH' });
    const open = (await get('/v1/security/incidents?open=1').expect(200)).body.data;
    expect(open.map((x: { ref: string }) => x.ref)).toEqual(['IN-1', 'IN-2']); // high first
    const i1 = open[0];
    await post(`/v1/security/incidents/${i1.id}/close`, {}).expect(400);
    expect((await post(`/v1/security/incidents/${i1.id}/close`, { note: 'بلاغ للشرطة رقم 4471 وإصلاح السياج' }).expect(200)).body.closed_at).toBeTruthy();
    await post(`/v1/security/incidents/${i1.id}/close`, { note: 'مرة أخرى' }).expect(409);
    const r = (await get(`/v1/security/report?from=${kwDay(-1)}&to=${kwDay(0)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ patrols: 2, completed: 1, checkpoints: 4, scanned: 2, skipped: 1, coverage: 50, incidents: 2, high: 1, open: 1 });
    expect(r.sites.map((x: { site_code: string }) => x.site_code)).toEqual(['AVN', 'WH']);
    expect(r.categories.map((x: { category: string }) => x.category).sort()).toEqual(['damage', 'intrusion']);
    const { user_token } = await login(app, newPhone());
    const other = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'توصيل', packs: ['delivery'] }).expect(201)).body;
    await get('/v1/security/sites', other.access_token).expect(403);
  });
});
