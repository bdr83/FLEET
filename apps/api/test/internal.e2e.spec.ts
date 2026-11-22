/**
 * In-house corporate fleet (internal@1): departments and employees, vehicle requests and the manager's approval, allocation that
 * books the vehicle like any task, desk hand-over and return, the trip with a driver from the driver app, a trip called off before
 * pick-up, cancel, who had the vehicle, exceptions and the charge-back per department.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('Internal fleet pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let dept: string;
  let other: string;
  let manager: { token: string; user_id: string; member: string };
  let emp: { token: string; user_id: string };
  let driver: { token: string; id: string };
  let car: string;
  let van: string;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const put = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).put(path).set(auth(token)).send(body);
  const patch = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).patch(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const inH = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const kwDay = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const kwAt = (daysAhead: number, hhmm: string) => {
    const d = new Date(Date.now() + 3 * 3_600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10);
    return new Date(`${d}T${hhmm}:00+03:00`).toISOString();
  };
  async function op(token: string, o: Record<string, unknown>, at = new Date().toISOString()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'شركة أ');
    B = await onboard(app, 'شركة ب');
    const mp = newPhone();
    const m = (await post('/v1/members', { phone: mp, display_name: 'مدير المبيعات', role_code: 'employee' }).expect(201)).body;
    manager = { token: (await joinAs(app, A.tenant.id, mp)).access_token, user_id: m.user_id, member: m.id };
    const dp = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'سائق الإدارة', phone: dp }).expect(201)).body;
    driver = { token: (await joinAs(app, A.tenant.id, dp)).access_token, id: w.id };
    car = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'car', plate_no: `C-${Date.now() % 100000}`, odometer_km: 10_000 }).expect(201)).body.id;
    van = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'van', plate_no: `V-${Date.now() % 100000}`, odometer_km: 50_000 }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  describe('setup', () => {
    it('saves the settings per legal entity', async () => {
      await put('/v1/internal/settings', { legal_entity_id: A.legal_entity_id, work_start: '17:00', work_end: '07:00' }).expect(400);
      await put('/v1/internal/settings', { legal_entity_id: A.legal_entity_id, cost_per_km: '0.1234' }).expect(400);
      const s = (await put('/v1/internal/settings', { legal_entity_id: A.legal_entity_id, cost_per_km: '0.150', driver_cost_per_hour: '2.000' }).expect(200)).body;
      expect(s).toMatchObject({ require_approval: true, cost_per_km: '0.150', driver_cost_per_hour: '2.000', work_start: '07:00', work_end: '17:00' });
      await put('/v1/internal/settings', { legal_entity_id: A.legal_entity_id, cost_per_km: '1' }, manager.token).expect(403);
    });
    it('creates departments with a manager, and employees in them', async () => {
      dept = (await post('/v1/internal/departments', { legal_entity_id: A.legal_entity_id, name: 'المبيعات', cost_center: 'CC-100', manager_user_id: manager.user_id }).expect(201)).body.id;
      await post('/v1/internal/departments', { legal_entity_id: A.legal_entity_id, name: 'المبيعات' }).expect(409);
      await post('/v1/internal/departments', { legal_entity_id: A.legal_entity_id, name: 'x', cost_center: 'bad cc!' }).expect(400);
      await post('/v1/internal/departments', { legal_entity_id: A.legal_entity_id, name: 'x', manager_user_id: randomUUID() }).expect(400);
      other = (await post('/v1/internal/departments', { legal_entity_id: A.legal_entity_id, name: 'المالية' }).expect(201)).body.id;
      await post('/v1/internal/departments', { legal_entity_id: A.legal_entity_id, name: 'y' }, manager.token).expect(403);
      await patch(`/v1/members/${manager.member}`, { department_id: dept }).expect(200);
      await post('/v1/members', { phone: newPhone(), role_code: 'employee', department_id: randomUUID() }).expect(400);
      const ep = newPhone();
      const e = (await post('/v1/members', { phone: ep, display_name: 'موظف المبيعات', role_code: 'employee', department_id: dept }).expect(201)).body;
      expect(e.department_id).toBe(dept);
      emp = { token: (await joinAs(app, A.tenant.id, ep)).access_token, user_id: e.user_id };
      const ds = (await get('/v1/internal/departments', emp.token).expect(200)).body.data;
      expect(ds.find((d: { id: string }) => d.id === dept)).toMatchObject({ manager_name: 'مدير المبيعات', members: 2 });
    });
  });

  let r1: { id: string; ref: string; version: number; task_id: string };
  describe('a self-drive trip', () => {
    it('the employee asks; checks the period and the department', async () => {
      const body = { purpose: 'زيارة عميل', destination: 'الشويخ', asset_type: 'car', starts_at: kwAt(1, '09:00'), ends_at: kwAt(1, '12:00') };
      await post('/v1/internal/requests', { ...body, ends_at: body.starts_at }, emp.token).expect(400);
      await post('/v1/internal/requests', { ...body, starts_at: inH(-5), ends_at: inH(-2) }, emp.token).expect(400);
      await post('/v1/internal/requests', { ...body, department_id: other }, emp.token).expect(403);
      await post('/v1/internal/requests', { ...body, asset_type: 'rocket' }, emp.token).expect(400);
      r1 = (await post('/v1/internal/requests', body, emp.token).expect(201)).body;
      expect(r1).toMatchObject({ status: 'pending', department_name: 'المبيعات', requester_name: 'موظف المبيعات', with_driver: false });
      expect(r1.ref).toMatch(/^VR-\d+$/);
      const my = (await get('/v1/internal/my', emp.token).expect(200)).body;
      expect(my.department).toEqual({ id: dept, name: 'المبيعات' });
      expect(my.requests.map((x: { id: string }) => x.id)).toEqual([r1.id]);
      await get('/v1/internal/requests', emp.token).expect(403);  // the office list
      await get(`/v1/internal/requests/${r1.id}`, B.access_token).expect(404);
    });
    it('only the department manager (or the office) decides; a rejection needs a reason', async () => {
      await post(`/v1/internal/requests/${r1.id}/decide`, { version: r1.version, approve: true }, emp.token).expect(403);
      const todo = (await get('/v1/internal/my', manager.token).expect(200)).body.to_approve;
      expect(todo.map((x: { id: string }) => x.id)).toEqual([r1.id]);
      await post(`/v1/internal/requests/${r1.id}/decide`, { version: r1.version, approve: false }, manager.token).expect(400);
      await post(`/v1/internal/requests/${r1.id}/decide`, { version: r1.version + 5, approve: true }, manager.token).expect(409);
      r1 = (await post(`/v1/internal/requests/${r1.id}/decide`, { version: r1.version, approve: true, note: 'موافق' }, manager.token).expect(200)).body;
      expect(r1).toMatchObject({ status: 'approved', decided_by_name: 'مدير المبيعات' });
      await post(`/v1/internal/requests/${r1.id}/decide`, { version: r1.version, approve: true }, manager.token).expect(409);
    });
    it('the office allocates a vehicle: an internal task books it, a second booking is refused', async () => {
      const o = (await get(`/v1/internal/requests/${r1.id}/options`).expect(200)).body;
      expect(o.vehicles[0]).toMatchObject({ id: car, matches: true, busy: null });
      expect(o.drivers).toEqual([]);
      await post(`/v1/internal/requests/${r1.id}/allocate`, { version: r1.version, asset_id: car, driver_worker_id: driver.id }).expect(400);
      await post(`/v1/internal/requests/${r1.id}/allocate`, { version: r1.version, asset_id: car }, emp.token).expect(403);
      r1 = (await post(`/v1/internal/requests/${r1.id}/allocate`, { version: r1.version, asset_id: car }).expect(200)).body;
      expect(r1).toMatchObject({ status: 'allocated', asset_id: car });
      const t = (await get(`/v1/tasks/${r1.task_id}`).expect(200)).body;
      expect(t).toMatchObject({ sector_pack: 'internal@1', status: 'assigned', ref: r1.ref });
      expect(t.attributes).toMatchObject({ request_id: r1.id, department: 'المبيعات', with_driver: false });
      // the same car in an overlapping period
      const r2 = (await post('/v1/internal/requests', { purpose: 'اجتماع', starts_at: kwAt(1, '11:00'), ends_at: kwAt(1, '13:00') }, manager.token).expect(201)).body;
      expect(r2.status).toBe('approved'); // the manager's own request needs no approval
      const busy = (await get(`/v1/internal/requests/${r2.id}/options`).expect(200)).body.vehicles.find((x: { id: string }) => x.id === car);
      expect(busy.busy.task_id).toBe(r1.task_id);
      await post(`/v1/internal/requests/${r2.id}/allocate`, { version: r2.version, asset_id: car }).expect(409);
      // the requester cancels it: nothing booked, nothing left open
      const c = (await post(`/v1/internal/requests/${r2.id}/cancel`, { version: r2.version, reason: 'تأجل' }, manager.token).expect(200)).body;
      expect(c.status).toBe('canceled');
      await post(`/v1/internal/requests/${r2.id}/cancel`, { version: c.version }, manager.token).expect(409);
    });
    it('hand-over at the desk records the odometer; the vehicle shows in use and who had it', async () => {
      await post(`/v1/internal/requests/${r1.id}/handover`, { version: r1.version, odometer_km: 9_000 }).expect(400); // below the last reading
      await post(`/v1/internal/requests/${r1.id}/handover`, { version: r1.version }).expect(400);
      await post(`/v1/internal/requests/${r1.id}/handover`, { version: r1.version, odometer_km: 10_010, fuel: 9 }).expect(400);
      r1 = (await post(`/v1/internal/requests/${r1.id}/handover`, { version: r1.version, odometer_km: 10_010, fuel: 6, note: 'خدش بالباب الخلفي' }).expect(200)).body;
      expect(r1).toMatchObject({ status: 'in_use', out_odometer_km: 10_010, out_fuel: 6 });
      expect((await get(`/v1/tasks/${r1.task_id}`).expect(200)).body.status).toBe('in_progress');
      const board = (await get('/v1/internal/board').expect(200)).body;
      expect(board.vehicles.find((x: { id: string }) => x.id === car).state).toBe('in_use');
      const who = (await get(`/v1/internal/who?asset_id=${car}&at=${new Date().toISOString()}`).expect(200)).body;
      expect(who.trip).toMatchObject({ id: r1.id, requester_name: 'موظف المبيعات', department_name: 'المبيعات' });
      // fuel bought on the trip is charged to the department
      await post('/v1/expenses', { category: 'fuel', amount: '4.500', liters: 30, asset_id: car }).expect(201);
      await post(`/v1/internal/requests/${r1.id}/cancel`, { version: r1.version }, emp.token).expect(409);
    });
    it('return: odometer and fuel; the booking ends now and the vehicle is free', async () => {
      await post(`/v1/internal/requests/${r1.id}/return`, { version: r1.version, odometer_km: 10_000 }).expect(400);
      r1 = (await post(`/v1/internal/requests/${r1.id}/return`, { version: r1.version, odometer_km: 10_130, fuel: 3, note: 'نظيفة' }).expect(200)).body;
      expect(r1).toMatchObject({ status: 'returned', km: 120, back_fuel: 3, condition_note: 'خدش بالباب الخلفي | نظيفة' });
      expect((await get(`/v1/tasks/${r1.task_id}`).expect(200)).body.status).toBe('completed');
      expect((await get(`/v1/assets/${car}`).expect(200)).body.odometer_km).toBe(10_130);
      // the car can be booked tomorrow afternoon even though the trip was booked until noon
      const r3 = (await post('/v1/internal/requests', { purpose: 'بعد', starts_at: inH(0.1), ends_at: inH(2) }, manager.token).expect(201)).body;
      await post(`/v1/internal/requests/${r3.id}/allocate`, { version: r3.version, asset_id: car }).expect(200);
      await post(`/v1/internal/requests/${r3.id}/cancel`, { version: r3.version + 1 }).expect(200);
    });
  });

  describe('a trip with a driver, from the driver app', () => {
    let r: { id: string; version: number; task_id: string };
    it('allocating needs a driver; the driver sees the trip', async () => {
      r = (await post('/v1/internal/requests', { purpose: 'نقل وفد', with_driver: true, passengers: 6, asset_type: 'van', starts_at: inH(-1), ends_at: inH(4) }, emp.token).expect(201)).body;
      r = (await post(`/v1/internal/requests/${r.id}/decide`, { version: r.version, approve: true }).expect(200)).body; // the office decides too
      const o = (await get(`/v1/internal/requests/${r.id}/options`).expect(200)).body;
      expect(o.drivers.find((d: { id: string }) => d.id === driver.id)).toMatchObject({ busy: false });
      await post(`/v1/internal/requests/${r.id}/allocate`, { version: r.version, asset_id: van }).expect(400);
      r = (await post(`/v1/internal/requests/${r.id}/allocate`, { version: r.version, asset_id: van, driver_worker_id: driver.id }).expect(200)).body;
      const mine = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data.find((x: { id: string }) => x.id === r.task_id);
      expect(mine).toMatchObject({ sector_pack: 'internal@1', status: 'assigned', asset_id: van });
    });
    it('the trip starts with the hand-over odometer and ends with the return', async () => {
      expect((await op(driver.token, { type: 'task_status', task_id: r.task_id, to_status: 'accepted' })).result).toBe('applied');
      expect(await op(driver.token, { type: 'task_status', task_id: r.task_id, to_status: 'in_progress' })).toMatchObject({ result: 'rejected', reason: 'stage_out_of_order' });
      expect(await op(driver.token, { type: 'milestone', task_id: r.task_id, code: 'vehicle_back', odometer_km: 50_100 })).toMatchObject({ result: 'rejected', reason: 'invalid_stage' });
      expect(await op(driver.token, { type: 'milestone', task_id: r.task_id, code: 'vehicle_out' })).toMatchObject({ result: 'rejected', reason: 'odometer_required' });
      expect(await op(driver.token, { type: 'milestone', task_id: r.task_id, code: 'vehicle_out', odometer_km: 49_000 })).toMatchObject({ result: 'rejected', reason: 'odometer_too_low' });
      const out = await op(driver.token, { type: 'milestone', task_id: r.task_id, code: 'vehicle_out', odometer_km: 50_020, fuel: 8 }, inH(-2));
      expect(out.result).toBe('applied');
      expect((await get(`/v1/internal/requests/${r.id}`).expect(200)).body).toMatchObject({ status: 'in_use', out_odometer_km: 50_020, out_fuel: 8 });
      expect(await op(driver.token, { type: 'milestone', task_id: r.task_id, code: 'vehicle_out', odometer_km: 50_020 })).toMatchObject({ result: 'rejected', reason: 'stage_already_recorded' });
      expect((await op(driver.token, { type: 'task_status', task_id: r.task_id, to_status: 'in_progress' })).result).toBe('applied');
      expect(await op(driver.token, { type: 'task_status', task_id: r.task_id, to_status: 'completed' })).toMatchObject({ result: 'rejected', reason: 'proof_required' });
      expect((await op(driver.token, { type: 'milestone', task_id: r.task_id, code: 'vehicle_back', odometer_km: 50_100, fuel: 5 })).result).toBe('applied');
      expect((await op(driver.token, { type: 'task_status', task_id: r.task_id, to_status: 'completed' })).result).toBe('applied');
      const done = (await get(`/v1/internal/requests/${r.id}`).expect(200)).body;
      expect(done).toMatchObject({ status: 'returned', km: 80, back_fuel: 5, driver_name: 'سائق الإدارة' });
    });
    it('a trip that fails on the road stays out until the office records the return', async () => {
      let x = (await post('/v1/internal/requests', { purpose: 'مشوار', with_driver: true, starts_at: inH(1), ends_at: inH(3) }, manager.token).expect(201)).body;
      x = (await post(`/v1/internal/requests/${x.id}/allocate`, { version: x.version, asset_id: van, driver_worker_id: driver.id }).expect(200)).body;
      expect((await op(driver.token, { type: 'task_status', task_id: x.task_id, to_status: 'accepted' })).result).toBe('applied');
      // taken an hour early: the booking now starts at the hand-over
      expect((await op(driver.token, { type: 'milestone', task_id: x.task_id, code: 'vehicle_out', odometer_km: 50_100 })).result).toBe('applied');
      expect((await op(driver.token, { type: 'task_status', task_id: x.task_id, to_status: 'in_progress' })).result).toBe('applied');
      expect((await op(driver.token, { type: 'task_status', task_id: x.task_id, to_status: 'failed', reason_code: 'vehicle_breakdown' })).result).toBe('applied');
      x = (await get(`/v1/internal/requests/${x.id}`).expect(200)).body;
      expect(x.status).toBe('in_use');
      const back = (await post(`/v1/internal/requests/${x.id}/return`, { version: x.version, odometer_km: 50_112, note: 'سُحبت بالونش' }).expect(200)).body;
      expect(back).toMatchObject({ status: 'returned', km: 12 });
      expect((await get(`/v1/tasks/${x.task_id}`).expect(200)).body.status).toBe('failed'); // a failed trip stays failed
    });
  });

  describe('the office', () => {
    it('exceptions: approved and not allocated soon, waiting approvals, trips outside working hours', async () => {
      const soon = (await post('/v1/internal/requests', { purpose: 'عاجل', starts_at: inH(1), ends_at: inH(2) }, manager.token).expect(201)).body;
      const late = (await post('/v1/internal/requests', { purpose: 'مساء', starts_at: kwAt(2, '19:00'), ends_at: kwAt(2, '22:00') }, emp.token).expect(201)).body;
      const ex = (await get('/v1/internal/exceptions').expect(200)).body;
      expect(ex.to_allocate.map((x: { id: string }) => x.id)).toContain(soon.id);
      expect(ex.after_hours.map((x: { id: string }) => x.id)).toContain(late.id);
      expect(ex.after_hours.map((x: { id: string }) => x.id)).not.toContain(r1.id);
      const n = (await get('/v1/internal/board').expect(200)).body;
      expect(n.pending).toBeGreaterThanOrEqual(1);
      expect(n.to_allocate).toBeGreaterThanOrEqual(1);
      expect((await get('/v1/internal/requests?status=open').expect(200)).body.data.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([soon.id, late.id]));
    });
    it('charges trips back to the department: km, driver hours and expenses', async () => {
      const day = kwDay();
      await get(`/v1/internal/costs?from=${day}`).expect(400);
      const c = (await get(`/v1/internal/costs?from=${day}&to=${day}`).expect(200)).body.data;
      const sales = c.find((x: { department_id: string }) => x.department_id === dept);
      // desk trip 120 km; driver trip 80 km over ~2 h; failed trip 12 km (minutes) → 212 × 0.150 + ~2 h × 2.000 ≈ 35.8, plus 4.500 fuel
      expect(sales).toMatchObject({ department_name: 'المبيعات', cost_center: 'CC-100', trips: 3, km: 212, expenses: '4.500' });
      expect(Number(sales.distance_cost)).toBeCloseTo(35.8, 0);
      expect(Number(sales.total) - Number(sales.distance_cost)).toBeCloseTo(4.5, 3);
      await get(`/v1/internal/costs?from=${day}&to=${day}`, emp.token).expect(403);
      expect((await get(`/v1/internal/costs?from=${day}&to=${day}`, B.access_token).expect(200)).body.data).toEqual([]);
    });
  });
});
