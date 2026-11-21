/**
 * P4: tasks, dispatch and supervisor shift control, end to end with the driver app.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

(hasDb ? describe : describe.skip)('P4 tasks and dispatch', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let d1: { token: string; id: string };
  let d2: { token: string; id: string };
  let bike: string;
  let mixer: string;

  async function driver(T: typeof A, name: string) {
    const phone = newPhone();
    const w = await request(http).post('/v1/workers').set(auth(T.access_token)).send({ legal_entity_id: T.legal_entity_id, kind: 'driver', display_name: name, phone }).expect(201);
    return { token: (await joinAs(app, T.tenant.id, phone)).access_token, id: w.body.id as string };
  }
  const task = (extra: Record<string, unknown> = {}) =>
    request(http).post('/v1/tasks').set(auth(A.access_token))
      .send({ legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', attributes: { address: 'السالمية، ق 10', contact_phone: '+96550000000' }, ...extra });
  const act = (id: string, action: string, body: Record<string, unknown>, token = A.access_token) =>
    request(http).post(`/v1/tasks/${id}/${action}`).set(auth(token)).send(body);
  const sync = (token: string, task_id: string, to_status: string, note?: string) =>
    request(http).post('/v1/driver/sync').set(auth(token))
      .send({ ops: [{ type: 'task_status', client_op_id: randomUUID(), task_id, to_status, occurred_at: new Date().toISOString(), note }] }).expect(200);

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'توزيع أ');
    B = await onboard(app, 'توزيع ب');
    d1 = await driver(A, 'أحمد');
    d2 = await driver(A, 'بدر');
    bike = (await request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, asset_type: 'motorbike', plate_no: `B-${Date.now()}` }).expect(201)).body.id;
    mixer = (await request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, asset_type: 'mixer', plate_no: `MX-${Date.now()}` }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  describe('create and edit', () => {
    it('creates a ready task with a window and attributes', async () => {
      const from = at(1);
      const r = await task({ window: { from, to: at(3) }, ref: `ORD-${Date.now()}` }).expect(201);
      expect(r.body).toMatchObject({ status: 'ready', version: 1, worker_id: null });
      expect(r.body.attributes.address).toBe('السالمية، ق 10');
      expect(new Date(r.body.window_from).getTime()).toBe(new Date(from).getTime());
    });
    it('the same ref returns the existing task instead of a duplicate', async () => {
      const ref = `ORD-${Date.now()}-2`;
      const a1 = await task({ ref }).expect(201);
      const a2 = await task({ ref }).expect(201);
      expect(a2.body.id).toBe(a1.body.id);
    });
    it('validates input', async () => {
      await task({ window: { from: at(3), to: at(1) } }).expect(400);
      await task({ sector_pack: 'Delivery v1' }).expect(400);
      await task({ attributes: 'x' }).expect(400);
    });
    it('a draft must be published before it can be assigned', async () => {
      const t = (await task({ draft: true }).expect(201)).body;
      expect(t.status).toBe('draft');
      await act(t.id, 'assign', { version: 1, worker_id: d1.id }).expect(409);
      const p = await act(t.id, 'publish', { version: 1 }).expect(200);
      expect(p.body).toMatchObject({ status: 'ready', version: 2 });
    });
    it('edits need the current version (no lost updates)', async () => {
      const t = (await task().expect(201)).body;
      await request(http).patch(`/v1/tasks/${t.id}`).set(auth(A.access_token)).send({ version: 1, attributes: { address: 'حولي' } }).expect(200);
      const stale = await request(http).patch(`/v1/tasks/${t.id}`).set(auth(A.access_token)).send({ version: 1, attributes: { address: 'الجهراء' } }).expect(409);
      expect(stale.body.current_version).toBe(2);
      await request(http).patch(`/v1/tasks/${t.id}`).set(auth(A.access_token)).send({ attributes: {} }).expect(400);
    });
  });

  describe('assign and the driver flow', () => {
    let t: { id: string; version: number };
    it('assigns to a driver and the driver sees it', async () => {
      t = (await task({ window: { from: at(1), to: at(2) } }).expect(201)).body;
      const r = await act(t.id, 'assign', { version: 1, worker_id: d1.id, asset_id: bike }).expect(200);
      expect(r.body).toMatchObject({ status: 'assigned', worker_id: d1.id, worker_name: 'أحمد', asset_id: bike, version: 2 });
      const mine = await request(http).get('/v1/driver/tasks').set(auth(d1.token)).expect(200);
      expect(mine.body.data.map((x: { id: string }) => x.id)).toContain(t.id);
    });
    it('reassigning moves it to the other driver', async () => {
      await act(t.id, 'assign', { version: 2, worker_id: d2.id }).expect(200);
      const one = await request(http).get('/v1/driver/tasks').set(auth(d1.token)).expect(200);
      expect(one.body.data.map((x: { id: string }) => x.id)).not.toContain(t.id);
      const two = await request(http).get('/v1/driver/tasks').set(auth(d2.token)).expect(200);
      expect(two.body.data.map((x: { id: string }) => x.id)).toContain(t.id);
    });
    it('the old driver can no longer update it', async () => {
      const r = await sync(d1.token, t.id, 'accepted');
      expect(r.body.results[0].reason).toBe('not_assigned_to_you');
    });
    it('driver completes, supervisor reviews; the timeline shows every step', async () => {
      await sync(d2.token, t.id, 'accepted');
      await sync(d2.token, t.id, 'in_progress');
      await sync(d2.token, t.id, 'completed');
      const now = (await request(http).get(`/v1/tasks/${t.id}`).set(auth(A.access_token)).expect(200)).body;
      expect(now.status).toBe('completed');
      await act(t.id, 'cancel', { version: now.version, reason: 'x' }).expect(409);
      const r = await act(t.id, 'review', { version: now.version }).expect(200);
      expect(r.body.status).toBe('reviewed');
      const full = (await request(http).get(`/v1/tasks/${t.id}`).set(auth(A.access_token)).expect(200)).body;
      expect(full.events.map((e: { to_status: string; actor_type: string }) => `${e.actor_type}:${e.to_status}`)).toEqual([
        'staff:assigned', 'staff:assigned', 'driver:accepted', 'driver:in_progress', 'driver:completed', 'staff:reviewed',
      ]);
    });
    it('cannot edit once the driver started', async () => {
      const x = (await task().expect(201)).body;
      await act(x.id, 'assign', { version: 1, worker_id: d1.id }).expect(200);
      await sync(d1.token, x.id, 'accepted');
      await sync(d1.token, x.id, 'in_progress');
      const cur = (await request(http).get(`/v1/tasks/${x.id}`).set(auth(A.access_token))).body;
      await request(http).patch(`/v1/tasks/${x.id}`).set(auth(A.access_token)).send({ version: cur.version, attributes: { a: 1 } }).expect(409);
    });
    it('a failed task can be reopened and assigned again', async () => {
      const x = (await task().expect(201)).body;
      await act(x.id, 'assign', { version: 1, worker_id: d1.id }).expect(200);
      await sync(d1.token, x.id, 'accepted');
      await sync(d1.token, x.id, 'in_progress');
      await sync(d1.token, x.id, 'failed', 'العنوان غير صحيح');
      let cur = (await request(http).get(`/v1/tasks/${x.id}`).set(auth(A.access_token))).body;
      expect(cur.status).toBe('failed');
      cur = (await act(x.id, 'reopen', { version: cur.version }).expect(200)).body;
      expect(cur).toMatchObject({ status: 'ready', worker_id: null });
      await act(x.id, 'assign', { version: cur.version, worker_id: d2.id }).expect(200);
    });
    it('cancel needs a reason and removes it from the driver', async () => {
      const x = (await task().expect(201)).body;
      await act(x.id, 'assign', { version: 1, worker_id: d1.id }).expect(200);
      await act(x.id, 'cancel', { version: 2 }).expect(400);
      const r = await act(x.id, 'cancel', { version: 2, reason: 'العميل ألغى' }).expect(200);
      expect(r.body).toMatchObject({ status: 'canceled', worker_id: null });
      const mine = await request(http).get('/v1/driver/tasks').set(auth(d1.token)).expect(200);
      expect(mine.body.data.map((y: { id: string }) => y.id)).not.toContain(x.id);
    });
    it('unassign returns it to the queue', async () => {
      const x = (await task().expect(201)).body;
      await act(x.id, 'assign', { version: 1, worker_id: d1.id }).expect(200);
      const r = await act(x.id, 'unassign', { version: 2 }).expect(200);
      expect(r.body).toMatchObject({ status: 'ready', worker_id: null });
    });
  });

  describe('assignment rules', () => {
    it('exclusive bookings of a driver cannot overlap; non-exclusive ones can (several parcels at once)', async () => {
      const x = (await task({ window: { from: at(30), to: at(32) } }).expect(201)).body;
      const y = (await task({ window: { from: at(31), to: at(33) } }).expect(201)).body;
      const z = (await task({ window: { from: at(31), to: at(33) } }).expect(201)).body;
      await act(x.id, 'assign', { version: 1, worker_id: d2.id, exclusive: true }).expect(200);
      await act(y.id, 'assign', { version: 1, worker_id: d2.id, exclusive: true }).expect(409);
      await act(z.id, 'assign', { version: 1, worker_id: d2.id }).expect(200);
    });
    it('a vehicle cannot be booked twice in the same window', async () => {
      const x = (await task({ sector_pack: 'concrete@1', window: { from: at(50), to: at(52) } }).expect(201)).body;
      const y = (await task({ sector_pack: 'concrete@1', window: { from: at(51), to: at(53) } }).expect(201)).body;
      await act(x.id, 'assign', { version: 1, worker_id: d1.id, asset_id: mixer }).expect(200);
      const r = await act(y.id, 'assign', { version: 1, worker_id: d2.id, asset_id: mixer }).expect(409);
      expect(r.body.message).toContain('vehicle');
    });
    it('cannot assign a suspended driver, an out-of-service vehicle, or another company driver', async () => {
      const d3 = await driver(A, 'موقوف');
      await request(http).patch(`/v1/workers/${d3.id}`).set(auth(A.access_token)).send({ status: 'suspended' }).expect(200);
      const x = (await task().expect(201)).body;
      await act(x.id, 'assign', { version: 1, worker_id: d3.id }).expect(409);
      const broken = (await request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, asset_type: 'van' }).expect(201)).body.id;
      await request(http).patch(`/v1/assets/${broken}`).set(auth(A.access_token)).send({ status: 'out_of_service' }).expect(200);
      await act(x.id, 'assign', { version: 1, worker_id: d1.id, asset_id: broken }).expect(409);
      const bd = await driver(B, 'سائق ب');
      await act(x.id, 'assign', { version: 1, worker_id: bd.id }).expect(400);
    });
    it('a dispatcher can assign; an accountant cannot; another company gets 404', async () => {
      const x = (await task().expect(201)).body;
      const p = newPhone();
      await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone: p, role_code: 'accountant' }).expect(201);
      const acc = (await joinAs(app, A.tenant.id, p)).access_token;
      await act(x.id, 'assign', { version: 1, worker_id: d1.id }, acc).expect(403);
      await act(x.id, 'assign', { version: 1, worker_id: d1.id }, B.access_token).expect(404);
      const q = newPhone();
      await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone: q, role_code: 'dispatcher' }).expect(201);
      const disp = (await joinAs(app, A.tenant.id, q)).access_token;
      await act(x.id, 'assign', { version: 1, worker_id: d1.id }, disp).expect(200);
    });
  });

  describe('dispatch board and shifts', () => {
    it('shows counts, the unassigned queue and drivers on shift with their position', async () => {
      const q = (await task({ window: { from: at(0.5), to: at(1.5) } }).expect(201)).body;
      const s = (await request(http).post('/v1/driver/shifts').set(auth(d1.token)).send({ client_op_id: randomUUID(), asset_id: bike }).expect(201)).body;
      await request(http).post('/v1/driver/locations').set(auth(d1.token))
        .send({ points: [{ recorded_at: new Date().toISOString(), lat: 29.33, lng: 48.0, battery_pct: 64 }] }).expect(200);
      const r = await request(http).get('/v1/dispatch/board').set(auth(A.access_token)).expect(200);
      expect(r.body.queue.map((x: { id: string }) => x.id)).toContain(q.id);
      expect(r.body.counts.ready).toBeGreaterThan(0);
      const me = r.body.drivers.find((x: { id: string }) => x.id === d1.id);
      expect(me).toMatchObject({ shift_id: s.id, plate_no: expect.any(String), lat: 29.33, lng: 48.0, battery_pct: 64 });
      expect(r.body.drivers[0].shift_id).toBeTruthy(); // drivers on shift are listed first
      const off = r.body.drivers.find((x: { id: string }) => x.id === d2.id);
      expect(off).toMatchObject({ shift_id: null, lat: null });
      await request(http).get('/v1/dispatch/board?tz=Mars/Base').set(auth(A.access_token)).expect(400);
      const other = await request(http).get('/v1/dispatch/board').set(auth(B.access_token)).expect(200);
      expect(other.body.drivers.map((x: { id: string }) => x.id)).not.toContain(d1.id);
    });
    it('a supervisor can end a forgotten shift, which frees the vehicle and stops tracking', async () => {
      const open = await request(http).get('/v1/shifts?open=true').set(auth(A.access_token)).expect(200);
      const s = open.body.data.find((x: { worker_id: string }) => x.worker_id === d1.id);
      await request(http).post(`/v1/shifts/${s.id}/end`).set(auth(A.access_token)).send({}).expect(400);
      const r = await request(http).post(`/v1/shifts/${s.id}/end`).set(auth(A.access_token)).send({ reason: 'نسي إنهاء المناوبة' }).expect(200);
      expect(r.body.ended_at).toBeTruthy();
      const asset = await request(http).get(`/v1/assets/${bike}`).set(auth(A.access_token)).expect(200);
      expect(asset.body.status).toBe('available');
      const later = await request(http).post('/v1/driver/locations').set(auth(d1.token))
        .send({ points: [{ recorded_at: new Date(Date.now() + 1000).toISOString(), lat: 29.3, lng: 48 }] }).expect(200);
      expect(later.body.outside_shift).toBe(1);
      await request(http).post(`/v1/shifts/${s.id}/end`).set(auth(B.access_token)).send({ reason: 'x' }).expect(404);
    });
    it('filters the task list', async () => {
      const r = await request(http).get(`/v1/tasks?status=assigned,accepted&worker_id=${d1.id}`).set(auth(A.access_token)).expect(200);
      expect(r.body.data.every((x: { status: string; worker_id: string }) => ['assigned', 'accepted'].includes(x.status) && x.worker_id === d1.id)).toBe(true);
      const u = await request(http).get('/v1/tasks?unassigned=true').set(auth(A.access_token)).expect(200);
      expect(u.body.data.every((x: { worker_id: string | null }) => x.worker_id === null)).toBe(true);
      await request(http).get('/v1/tasks?status=lost').set(auth(A.access_token)).expect(400);
    });
  });
});
