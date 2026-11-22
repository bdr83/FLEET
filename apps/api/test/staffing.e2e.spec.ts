/**
 * Driver supply pack (staffing@1): supply requests, document eligibility, placements that generate day-shifts,
 * check-in/check-out from the driver app, hours, the customer's approval or dispute, replacement and absence,
 * ending a placement, cancel, the coverage board, exceptions and invoicing by the hour.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('Staffing pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let customer: string;
  let portal: string;
  let d1: { token: string; id: string };
  let d2: { token: string; id: string };
  let d3: { token: string; id: string };
  let courier: string;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10); // Kuwait date (UTC+3)
  const ref = () => `S${Date.now() % 1e8}${Math.floor(Math.random() * 100)}`;
  async function op(token: string, o: Record<string, unknown>, at = new Date().toISOString()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, token).expect(200)).body.results[0];
  }
  // the whole day, every day: today's shift is always under way whatever time the test runs
  const reqBody = (extra: Record<string, unknown> = {}) => ({
    legal_entity_id: A.legal_entity_id, customer_id: customer, ref: ref(), headcount: 1, starts_on: kwDay(), ends_on: kwDay(13),
    shift_start: '00:00', shift_end: '23:59', work_days: [0, 1, 2, 3, 4, 5, 6], bill_unit: 'hour',
    site: { name: 'مستودع الري', area: 'الري', block: '1', lat: 29.3, lng: 47.93, contact_name: 'أبو محمد', contact_phone: '50000011' }, ...extra,
  });

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'توريد أ');
    B = await onboard(app, 'توريد ب');
    customer = (await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'شركة التموين' }).expect(201)).body.id;
    const k = (await post('/v1/contracts', { customer_id: customer, starts_on: '2026-01-01', rates: [
      { unit: 'hour', price: '3.500', sector_pack: 'staffing@1' }, { unit: 'day', price: '25.000', sector_pack: 'staffing@1' }] }).expect(201)).body;
    await post(`/v1/contracts/${k.id}/activate`, {}).expect(200);
    const p = newPhone();
    await post('/v1/members', { phone: p, role_code: 'customer', customer_id: customer }).expect(201);
    portal = (await joinAs(app, A.tenant.id, p)).access_token;
    const mk = async (name: string, docs: [string, string | null][]) => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: name, phone }).expect(201)).body;
      for (const [doc_type, expires_on] of docs) await post('/v1/documents', { doc_type, worker_id: w.id, ...(expires_on ? { expires_on } : {}) }).expect(201);
      return { token: (await joinAs(app, A.tenant.id, phone)).access_token, id: w.id };
    };
    d1 = await mk('فهد عبدالله المطيري', [['driving_license', kwDay(400)], ['residency', kwDay(200)]]);
    d2 = await mk('سالم بلا رخصة', [['residency', kwDay(200)]]);
    d3 = await mk('ناصر العنزي', [['driving_license', kwDay(5)], ['residency', kwDay(200)]]);
    courier = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'courier', display_name: 'مندوب', phone: newPhone() }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  let req: { id: string; ref: string; version: number };
  let placement: string;
  const shiftOn = async (day: string) => (await get(`/v1/staffing/requests/${req.id}`).expect(200)).body.shifts.find((s: { work_date: string }) => s.work_date === day);

  describe('requests and placements', () => {
    it('creates a request, safe to retry, isolated per company', async () => {
      await post('/v1/staffing/requests', reqBody({ shift_start: '8:00' })).expect(400);
      await post('/v1/staffing/requests', reqBody({ ref: 'bad ref' })).expect(400);
      await post('/v1/staffing/requests', reqBody({ ends_on: kwDay(-1) })).expect(400);
      await post('/v1/staffing/requests', reqBody({ work_days: [7] })).expect(400);
      req = (await post('/v1/staffing/requests', reqBody()).expect(201)).body;
      expect(req).toMatchObject({ state: 'active', headcount: 1, bill_unit: 'hour', customer_name: 'شركة التموين', placed_now: 0, placements: [] });
      expect((await post('/v1/staffing/requests', reqBody({ ref: req.ref })).expect(201)).body.id).toBe(req.id);
      await get(`/v1/staffing/requests/${req.id}`, B.access_token).expect(404);
      await get(`/v1/staffing/requests/${req.id}`, d1.token).expect(403);
      expect((await get('/v1/staffing/requests').expect(200)).body.data.map((r: { id: string }) => r.id)).toContain(req.id);
    });
    it('candidates show the document check; a courier is not offered for a driver request', async () => {
      const r = (await get(`/v1/staffing/requests/${req.id}/candidates`).expect(200)).body;
      const by = Object.fromEntries(r.data.map((x: { id: string; eligibility: { status: string } }) => [x.id, x.eligibility.status]));
      expect(by).toMatchObject({ [d1.id]: 'ok', [d2.id]: 'blocked', [d3.id]: 'warn' });
      expect(by[courier]).toBeUndefined();
      expect(r.data[0].id).toBe(d1.id); // eligible first
    });
    it('places an eligible driver and generates the day-shifts; blocks missing documents, a full request and a double placement', async () => {
      const bad = (await post(`/v1/staffing/requests/${req.id}/placements`, { worker_id: d2.id }).expect(409)).body;
      expect(bad.eligibility.issues).toEqual([{ doc_type: 'driving_license', problem: 'missing' }]);
      await post(`/v1/staffing/requests/${req.id}/placements`, { worker_id: courier }).expect(400);
      const p = (await post(`/v1/staffing/requests/${req.id}/placements`, { worker_id: d1.id }).expect(201)).body;
      expect(p).toMatchObject({ starts_on: kwDay(), ends_on: kwDay(13), shifts_created: 14, eligibility: { status: 'ok' } });
      placement = p.id;
      await post(`/v1/staffing/requests/${req.id}/placements`, { worker_id: d3.id }).expect(409); // headcount 1 is filled
      const other = (await post('/v1/staffing/requests', reqBody()).expect(201)).body;
      await post(`/v1/staffing/requests/${other.id}/placements`, { worker_id: d1.id }).expect(409); // already placed in this period
      const r = (await get(`/v1/staffing/requests/${req.id}`).expect(200)).body;
      expect(r.placed_now).toBe(1);
      expect(r.placements[0]).toMatchObject({ worker_id: d1.id, worker_name: 'فهد عبدالله المطيري', active: true });
      const today = r.shifts.find((s: { work_date: string }) => s.work_date === kwDay());
      expect(today).toMatchObject({ status: 'assigned', worker_id: d1.id });
      const t = (await get(`/v1/tasks/${today.task_id}`).expect(200)).body;
      expect(t).toMatchObject({ sector_pack: 'staffing@1', customer_id: customer, ref: `${req.ref}-1-${kwDay().replaceAll('-', '')}` });
      expect(t.contract_id).toBeTruthy();
      expect(t.attributes).toMatchObject({ bill_unit: 'hour', shift: '00:00–23:59', address: 'مستودع الري، الري، ق 1' });
      // generating again adds nothing
      expect((await post('/v1/staffing/generate', {}).expect(200)).body.shifts_created).toBe(0);
    });
    it('the driver sees only the next shifts, not two weeks of them', async () => {
      const mine = (await get('/v1/driver/tasks', d1.token).expect(200)).body.data.filter((x: { sector_pack: string }) => x.sector_pack === 'staffing@1');
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.length).toBeLessThanOrEqual(3);
    });
    it('a shift past its start without check-in is a no-show', async () => {
      const today = await shiftOn(kwDay());
      // the shift started at 00:00 Kuwait; with 15 minutes' grace it is late unless the test runs in the first quarter hour
      if (Date.now() + 3 * 3_600_000 - Date.parse(`${kwDay()}T00:00:00Z`) > 20 * 60_000) {
        expect((await get('/v1/staffing/exceptions').expect(200)).body.no_show.map((x: { task_id: string }) => x.task_id)).toContain(today.task_id);
      }
    });
  });

  describe('check-in, check-out and hours', () => {
    let task: string;
    beforeAll(async () => { task = (await shiftOn(kwDay())).task_id; });
    it('check-out needs check-in; completion needs check-out; hours are rounded', async () => {
      expect((await op(d1.token, { type: 'milestone', task_id: task, code: 'check_in' })).reason).toBe('invalid_stage'); // not accepted yet
      expect((await op(d1.token, { type: 'task_status', task_id: task, to_status: 'accepted' }, ago(491))).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: task, code: 'picked_up' })).reason).toBe('not_supported');
      // about 1.1 km from the site: recorded, not blocked
      expect((await op(d1.token, { type: 'milestone', task_id: task, code: 'check_in', lat: 29.31, lng: 47.93 }, ago(490))).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: task, code: 'check_in' })).reason).toBe('stage_already_recorded');
      expect((await op(d1.token, { type: 'task_status', task_id: task, to_status: 'in_progress' }, ago(490))).result).toBe('applied');
      expect((await op(d1.token, { type: 'task_status', task_id: task, to_status: 'completed' })).reason).toBe('proof_required');
      expect((await op(d1.token, { type: 'milestone', task_id: task, code: 'check_out' })).result).toBe('applied');
      expect((await op(d1.token, { type: 'task_status', task_id: task, to_status: 'completed' })).result).toBe('applied');
      // 8 h 10 min → 8 h 15 min at the 15-minute step
      expect((await get(`/v1/tasks/${task}`).expect(200)).body.attributes.quantities).toEqual({ hour: 8.25 });
      const s = await shiftOn(kwDay());
      expect(s).toMatchObject({ status: 'completed', hours: 8.25 });
      expect(s.checkin_distance_m).toBeGreaterThan(1000);
      expect(s.checkin_distance_m).toBeLessThan(1200);
      expect((await get('/v1/staffing/exceptions').expect(200)).body.far.map((x: { task_id: string }) => x.task_id)).toContain(task);
    });
    it('check-in opens two hours before the shift; the shift starts only with a check-in', async () => {
      const later = (await shiftOn(kwDay(4))).task_id; // starts in more than two days
      expect((await op(d1.token, { type: 'task_status', task_id: later, to_status: 'accepted' })).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: later, code: 'check_in' })).reason).toBe('too_early');
      expect((await op(d1.token, { type: 'task_status', task_id: later, to_status: 'in_progress' })).reason).toBe('stage_out_of_order');
    });
    it('a staffing reason is required for leaving early, not a delivery one', async () => {
      const one = (await post('/v1/staffing/requests', reqBody({ ends_on: kwDay() })).expect(201)).body;
      const pl = (await post(`/v1/staffing/requests/${one.id}/placements`, { worker_id: d3.id }).expect(201)).body;
      expect(pl).toMatchObject({ shifts_created: 1, eligibility: { status: 'ok' } }); // a one-day placement: the licence is valid throughout
      const t2 = (await get(`/v1/staffing/requests/${one.id}`).expect(200)).body.shifts[0].task_id;
      await op(d3.token, { type: 'task_status', task_id: t2, to_status: 'accepted' });
      await op(d3.token, { type: 'milestone', task_id: t2, code: 'check_in' });
      await op(d3.token, { type: 'task_status', task_id: t2, to_status: 'in_progress' });
      expect((await op(d3.token, { type: 'task_status', task_id: t2, to_status: 'failed', reason_code: 'recipient_absent' })).reason).toBe('invalid_reason');
      expect((await op(d3.token, { type: 'task_status', task_id: t2, to_status: 'failed', reason_code: 'sick' })).result).toBe('applied');
    });
  });

  describe('customer approval, dispute and invoice', () => {
    let task: string;
    beforeAll(async () => { task = (await shiftOn(kwDay())).task_id; });
    it('the portal shows the first name only and the licence check', async () => {
      const r = (await get('/v1/portal/staffing', portal).expect(200)).body;
      const mine = r.requests.find((x: { id: string }) => x.id === req.id);
      expect(mine.placements).toEqual([expect.objectContaining({ worker_name: 'فهد', licence_valid: true })]);
      expect(JSON.stringify(r)).not.toContain('المطيري');
      expect(r.shifts.find((x: { task_id: string }) => x.task_id === task)).toMatchObject({ status: 'completed', hours: 8.25, worker_name: 'فهد', disputed: false });
      await get('/v1/portal/staffing', A.access_token).expect(403);
      expect((await get('/v1/portal/staffing', d1.token).expect(403)));
    });
    it('a dispute holds the day; the office settles the hours; then the customer approves', async () => {
      const d = (await post('/v1/portal/staffing/dispute', { task_id: task, reason: 'غادر الساعة 4 عصرًا' }, portal).expect(200)).body;
      expect(d.hours_before).toBe(8.25);
      await post('/v1/portal/staffing/dispute', { task_id: task, reason: 'مرة أخرى' }, portal).expect(409);
      expect((await post('/v1/portal/staffing/approve', { task_ids: [task] }, portal).expect(200)).body.skipped).toEqual([{ task_id: task, reason: 'disputed' }]);
      const ex = (await get('/v1/staffing/exceptions').expect(200)).body.disputes.find((x: { task_id: string }) => x.task_id === task);
      expect(ex).toMatchObject({ reason: 'غادر الساعة 4 عصرًا', hours_before: 8.25, worker_name: 'فهد عبدالله المطيري' });
      await post(`/v1/staffing/disputes/${d.id}/resolve`, { resolution: 'اتفقنا على 8 ساعات', hours: 25 }).expect(400);
      const s = (await post(`/v1/staffing/disputes/${d.id}/resolve`, { resolution: 'اتفقنا على 8 ساعات', hours: 8 }).expect(200)).body;
      expect(s).toMatchObject({ hours: 8, dispute_id: null });
      expect((await post('/v1/portal/staffing/approve', { task_ids: [task] }, portal).expect(200)).body).toEqual({ approved: [task], skipped: [] });
      expect((await post('/v1/staffing/approve', { task_ids: [task] }).expect(200)).body.skipped).toEqual([{ task_id: task, reason: 'already_approved' }]);
    });
    it('another customer cannot see or approve the days', async () => {
      const other = (await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'عميل آخر' }).expect(201)).body.id;
      const p = newPhone();
      await post('/v1/members', { phone: p, role_code: 'customer', customer_id: other }).expect(201);
      const tok = (await joinAs(app, A.tenant.id, p)).access_token;
      expect((await get('/v1/portal/staffing', tok).expect(200)).body).toEqual({ requests: [], shifts: [] });
      await post('/v1/portal/staffing/dispute', { task_id: task, reason: 'x' }, tok).expect(404);
    });
    it('the invoice prices the approved hours', async () => {
      const inv = (await post('/v1/invoices', { customer_id: customer, period_from: kwDay(), period_to: kwDay() }).expect(201)).body;
      const mine = inv.lines.filter((l: { task_id: string }) => l.task_id === task).map((l: { unit: string; quantity: string; amount: string }) => [l.unit, l.amount]);
      expect(mine).toEqual([['hour', '28.000']]); // 8 h × 3.500
    });
  });

  describe('replacement, absence, ending and cancel', () => {
    it('a substitute must be eligible; the shift then belongs to them', async () => {
      const s = await shiftOn(kwDay(2));
      await post(`/v1/staffing/shifts/${s.task_id}/replace`, { worker_id: d2.id }).expect(409);
      await post(`/v1/staffing/shifts/${s.task_id}/replace`, { worker_id: d1.id }).expect(400);
      const r = (await post(`/v1/staffing/shifts/${s.task_id}/replace`, { worker_id: d3.id }).expect(200)).body;
      expect(r).toMatchObject({ worker_id: d3.id, replaced_worker_id: d1.id, status: 'assigned' });
      expect(r.replaced_at).toBeTruthy();
    });
    it('absent with no substitute cancels the shift', async () => {
      const s = await shiftOn(kwDay(3));
      const r = (await post(`/v1/staffing/shifts/${s.task_id}/absent`, { reason: 'مريض' }).expect(200)).body;
      expect(r).toMatchObject({ status: 'canceled' });
      expect(r.absent_at).toBeTruthy();
      await post(`/v1/staffing/shifts/${s.task_id}/absent`, {}).expect(409);
    });
    it('the board counts required and covered per day', async () => {
      const b = (await get(`/v1/staffing/board?from=${kwDay()}&days=7`).expect(200)).body;
      const row = b.rows.find((r: { id: string }) => r.id === req.id);
      expect(row.days[0]).toMatchObject({ date: kwDay(), required: 1, covered: 1, checked_in: 1 });
      expect(row.days[3]).toMatchObject({ required: 1, covered: 0, absent: 1 });
      await get('/v1/staffing/board?days=40').expect(400);
    });
    it('ending a placement early cancels the shifts after the end', async () => {
      const r = (await post(`/v1/staffing/placements/${placement}/end`, { reason: 'طلب العميل', end_on: kwDay(5) }).expect(200)).body;
      expect(r).toMatchObject({ ends_on: kwDay(5), removed: false, shifts_canceled: 8 });
      expect((await shiftOn(kwDay(6))).status).toBe('canceled');
      expect((await shiftOn(kwDay(5))).status).toBe('assigned');
    });
    it('cancelling the request needs the current version and ends the rest', async () => {
      const cur = (await get(`/v1/staffing/requests/${req.id}`).expect(200)).body;
      await post(`/v1/staffing/requests/${req.id}/cancel`, { version: cur.version + 5, reason: 'x' }).expect(409);
      const r = (await post(`/v1/staffing/requests/${req.id}/cancel`, { version: cur.version, reason: 'انتهى العقد' }).expect(200)).body;
      expect(r).toMatchObject({ state: 'canceled', cancel_reason: 'انتهى العقد' });
      expect((await shiftOn(kwDay(4))).status).toBe('canceled');
      expect((await shiftOn(kwDay())).status).toBe('reviewed'); // worked days stay (on the draft invoice)
      await post(`/v1/staffing/requests/${req.id}/placements`, { worker_id: d1.id }).expect(409);
    });
  });

  describe('settings', () => {
    it('reads defaults and saves per legal entity', async () => {
      expect((await get(`/v1/staffing/settings?legal_entity_id=${A.legal_entity_id}`).expect(200)).body).toMatchObject({ checkin_radius_m: 300, hour_rounding_minutes: 15 });
      await request(http).put('/v1/staffing/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, hour_rounding_minutes: 7 }).expect(400);
      const s = (await request(http).put('/v1/staffing/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, hour_rounding_minutes: 30, doc_types: ['driving_license'] }).expect(200)).body;
      expect(s).toMatchObject({ hour_rounding_minutes: 30, doc_types: ['driving_license'], checkin_radius_m: 300 });
    });
  });
});
