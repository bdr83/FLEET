/**
 * Landscaping and garden maintenance (landscape pack, sector 27): a customer's garden with the services agreed and the
 * visit days; the day's visits generated for the crew lead; the lead records the arrival and the work (an undone planned
 * service needs a note, the irrigation state, the green waste bags); an irrigation fault stays open until the office
 * closes it; an extra visit; exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Landscape pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, cu: string, lead2: string;
  let lead: { token: string; id: string };
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwNow = (min = 0) => new Date(Date.now() + 3 * 3_600_000 + min * 60_000);
  const kwDay = (plus = 0) => kwNow(plus * 1440).toISOString().slice(0, 10);
  const hm = (min: number) => kwNow(min).toISOString().slice(11, 16);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const ALL = [1, 2, 3, 4, 5, 6, 7];
  async function op(o: Record<string, unknown>, at = ago(1)) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, lead.token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'شركة الحدائق', packs: ['landscape'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'رئيس الطاقم راجو', phone }).expect(201)).body;
    lead = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    lead2 = (await post('/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'رئيس الطاقم أنيل', phone: newPhone() }).expect(201)).body.id;
    cu = (await post('/v1/customers', { legal_entity_id: le, name: 'فيلا العتيبي' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('gardens with services and days; the day\'s visits generated; a garden without a lead skipped', async () => {
    await post('/v1/landscape/sites', { legal_entity_id: le, code: 'V1', name: 'فيلا', customer_id: cu, services: ['mowing', 'swimming'] }).expect(400);
    await post('/v1/landscape/sites', { legal_entity_id: le, code: 'V1', name: 'فيلا', services: ['mowing'] }).expect(400);
    const s = (await post('/v1/landscape/sites', { legal_entity_id: le, code: 'v1', name: 'فيلا العتيبي: الحديقة الأمامية', customer_id: cu, area: 'الشويخ', area_m2: 400,
      services: ['pruning', 'mowing', 'irrigation'], days: ALL, visit_time: hm(-10), duration_min: 180, lead_worker_id: lead.id, crew_size: 3, instructions: 'لا تقصوا النخلة' }).expect(201)).body;
    expect(s).toMatchObject({ code: 'V1', services: ['mowing', 'pruning', 'irrigation'], lead_name: 'رئيس الطاقم راجو', irrigation: true, crew_size: 3, open_faults: 0 });
    await post('/v1/landscape/sites', { legal_entity_id: le, code: 'CMP', name: 'مجمع السالمية', customer_id: cu, services: ['mowing'], days: ALL, visit_time: hm(-50), duration_min: 180, lead_worker_id: lead2, irrigation: false }).expect(201);
    await post('/v1/landscape/sites', { legal_entity_id: le, code: 'NOL', name: 'حديقة بلا رئيس طاقم', customer_id: cu, services: ['weeding'], days: ALL, visit_time: hm(60) }).expect(201);
    await post('/v1/landscape/sites', { legal_entity_id: le, code: 'V1', name: 'مكرر', customer_id: cu, services: ['mowing'] }).expect(409);
    const g = (await post('/v1/landscape/visits/generate', { date: kwDay() }).expect(201)).body;
    const ymd = kwDay().replace(/-/g, '');
    expect(g.created.sort()).toEqual([`LV-CMP-${ymd}`, `LV-V1-${ymd}`]);
    expect(g.skipped).toEqual([{ site: 'NOL', reason: 'no_lead' }]);
    expect((await post('/v1/landscape/visits/generate', { date: kwDay() }).expect(201)).body.existing.sort()).toEqual(['CMP', 'V1']);
  });

  it('the crew lead: arrival, then the work with a note for an undone service, the irrigation state and the bags', async () => {
    const t = (await get('/v1/driver/tasks', lead.token).expect(200)).body.data.find((x: { attributes: { site_code?: string } }) => x.attributes.site_code === 'V1');
    expect(t.attributes).toMatchObject({ kind: 'garden_visit', services: ['mowing', 'pruning', 'irrigation'], irrigation: true, crew_size: 3, instructions: 'لا تقصوا النخلة' });
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, ago(9));
    await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, ago(8));
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_done', services: ['mowing'] })).reason).toBe('stage_out_of_order');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_arrived' }, ago(7))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).reason).toBe('proof_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_done', services: [] })).reason).toBe('services_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_done', services: ['flying'] })).reason).toBe('services_invalid');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_done', services: ['mowing', 'irrigation'], irrigation: 'leak', waste_bags: 4 })).reason).toBe('undone_note_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_done', services: ['mowing', 'pruning', 'irrigation'], waste_bags: 4 })).reason).toBe('irrigation_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_done', services: ['mowing', 'pruning', 'irrigation'], irrigation: 'ok' })).reason).toBe('waste_bags_required');
    expect((await op({ type: 'milestone', task_id: t.id, code: 'ls_done', services: ['mowing', 'irrigation', 'cleanup'], irrigation: 'leak', waste_bags: 4,
      note: 'التقليم الأسبوع القادم، تسريب عند الرشاش الثالث', received_by: 'الحارس' }, ago(3))).result).toBe('applied');
    expect((await op({ type: 'task_status', task_id: t.id, to_status: 'completed' })).result).toBe('applied');
    const v = (await get('/v1/landscape/visits').expect(200)).body.data.find((x: { site_code: string }) => x.site_code === 'V1');
    expect(v).toMatchObject({ state: 'done', services_done: ['mowing', 'irrigation', 'cleanup'], irrigation: 'leak', waste_bags: 4, received_by: 'الحارس', lead_name: 'رئيس الطاقم راجو' });
  });

  it('faults closed by the office, an extra visit, exceptions and the report', async () => {
    const ex = (await get('/v1/landscape/exceptions').expect(200)).body;
    expect(ex.late_start.map((x: { site_code: string }) => x.site_code)).toEqual(['CMP']);
    expect(ex.no_lead.map((x: { code: string }) => x.code)).toEqual(['NOL']);
    expect(ex.services_undone).toMatchObject([{ site_code: 'V1', missing: ['pruning'] }]);
    expect(ex.open_faults.map((x: { site_code: string }) => x.site_code)).toEqual(['V1']);
    const v = ex.open_faults[0];
    await post(`/v1/landscape/visits/${v.id}/close-fault`, {}).expect(400);
    expect((await post(`/v1/landscape/visits/${v.id}/close-fault`, { note: 'تم تغيير الرشاش' }).expect(200)).body.issue_closed_at).toBeTruthy();
    await post(`/v1/landscape/visits/${v.id}/close-fault`, { note: 'مرة أخرى' }).expect(409);
    const sites = (await get('/v1/landscape/sites').expect(200)).body.data;
    const v1 = sites.find((x: { code: string }) => x.code === 'V1');
    expect(v1.open_faults).toBe(0);
    const x = (await post('/v1/landscape/visits', { site_id: v1.id, date: kwDay(1), time: '16:00', services: ['planting'], lead_worker_id: lead2, note: 'زراعة 20 شتلة ورد' }).expect(201)).body;
    expect(x).toMatchObject({ ref: `LV-V1-${kwDay(1).replace(/-/g, '')}-1`, extra: true, services_planned: ['planting'], lead_name: 'رئيس الطاقم أنيل', state: 'assigned' });
    expect((await post(`/v1/landscape/visits/${x.id}/cancel`, { reason: 'العميل أجّل' }).expect(200)).body.state).toBe('canceled');
    const r = (await get(`/v1/landscape/report?from=${kwDay(-1)}&to=${kwDay(1)}`).expect(200)).body;
    expect(r.totals).toMatchObject({ visits: 2, done: 1, services_planned: 3, services_done: 2, completion: 67, waste_bags: 4, faults: 1, open_faults: 0 });
    expect(r.sites.map((s: { site_code: string }) => s.site_code)).toEqual(['CMP', 'V1']);
    expect(r.services).toEqual([{ key: 'mowing', planned: 1, done: 1 }, { key: 'pruning', planned: 1, done: 0 }, { key: 'irrigation', planned: 1, done: 1 }, { key: 'cleanup', planned: 0, done: 1 }]);
    const { user_token } = await login(app, newPhone());
    const other = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'توصيل', packs: ['delivery'] }).expect(201)).body;
    await get('/v1/landscape/sites', other.access_token).expect(403);
  });
});
