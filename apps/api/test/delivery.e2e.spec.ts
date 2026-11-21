/**
 * Delivery pack (delivery@1): structured order data, recipient PIN and tracking link, stages, proof of delivery,
 * failure reasons and returns, bulk import, auto-assignment, exceptions, settings and earnings.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('Delivery pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let driver: { token: string; id: string };
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const now = () => new Date().toISOString();
  async function op(o: Record<string, unknown>) {
    const r = await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: now(), ...o }] }, driver.token).expect(200);
    return r.body.results[0];
  }
  const status = (task_id: string, to_status: string, extra: Record<string, unknown> = {}) => op({ type: 'task_status', task_id, to_status, ...extra });
  const order = (extra: Record<string, unknown> = {}) => ({
    dropoff: { area: 'السالمية', block: '5', street: '10', house: '12', lat: 29.335, lng: 48.075 },
    recipient: { name: 'أحمد', phone: '50000001' }, cod_amount: '7.500', delivery_fee: '1.250', ...extra,
  });
  async function create(attributes: Record<string, unknown> = order(), extra: Record<string, unknown> = {}) {
    return (await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', attributes, ...extra }).expect(201)).body;
  }
  async function assigned(attributes?: Record<string, unknown>) {
    const t = await create(attributes);
    await post(`/v1/tasks/${t.id}/assign`, { version: 1, worker_id: driver.id }).expect(200);
    return t.id as string;
  }
  const info = async (id: string) => (await get(`/v1/delivery/tasks/${id}`).expect(200)).body;
  const version = async (id: string) => (await get(`/v1/tasks/${id}`).expect(200)).body.version;

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'توصيل أ');
    B = await onboard(app, 'توصيل ب');
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'courier', display_name: 'سالم العتيبي', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, A.tenant.id, phone)).access_token, id: w.id };
  });
  afterAll(async () => app?.close());

  describe('order data', () => {
    it('validates and normalises the Kuwaiti address, recipient and money', async () => {
      const t = await create();
      expect(t.attributes.address).toBe('السالمية، ق 5، ش 10، م 12');
      expect(t.attributes.recipient.phone).toBe('+96550000001');
      expect(t.attributes.cod_amount).toBe('7.500');
      await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', attributes: { recipient: { phone: '12' } } }).expect(400);
      // other packs are not touched by the delivery rules
      await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'concrete@1', attributes: { recipient: { phone: '12' } } }).expect(201);
    });
    it('edits are validated too', async () => {
      const t = await create();
      await request(http).patch(`/v1/tasks/${t.id}`).set(auth(A.access_token)).send({ version: 1, attributes: { cod_amount: 'abc' } }).expect(400);
      const r = await request(http).patch(`/v1/tasks/${t.id}`).set(auth(A.access_token)).send({ version: 1, attributes: order({ cod_amount: 3 }) }).expect(200);
      expect(r.body.attributes.cod_amount).toBe('3');
    });
  });

  describe('PIN and tracking link', () => {
    it('every delivery order gets a 4-digit PIN and a link; the office sees them, other companies do not', async () => {
      const t = await create();
      const d = await info(t.id);
      expect(d.link.pin).toMatch(/^[0-9]{4}$/);
      expect(d.link.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      await get(`/v1/delivery/tasks/${t.id}`, B.access_token).expect(404);
      await get(`/v1/delivery/tasks/${t.id}`, driver.token).expect(403);
    });
    it('the public page shows limited fields, and unknown tokens are 404', async () => {
      const t = await create();
      const { link } = await info(t.id);
      const r = await request(http).get(`/v1/public/track/${link.token}`).expect(200);
      expect(r.body).toMatchObject({ status: 'ready', area: 'السالمية', pin: link.pin, company: 'توصيل أ', driver: null, position: null });
      expect(JSON.stringify(r.body)).not.toContain('500000');
      expect(r.headers['cache-control']).toBe('no-store');
      await request(http).get(`/v1/public/track/${'x'.repeat(32)}`).expect(404);
      await request(http).get('/v1/public/track/short').expect(404);
    });
  });

  describe('driver: stages, proof and completion', () => {
    let id: string;
    beforeAll(async () => {
      await post('/v1/driver/shifts', { client_op_id: randomUUID() }, driver.token).expect(201);
      await post('/v1/driver/locations', { points: [{ recorded_at: now(), lat: 29.334, lng: 48.074 }] }, driver.token).expect(200);
    });
    it('records stages in the right status, once', async () => {
      id = await assigned();
      expect(await status(id, 'accepted')).toMatchObject({ result: 'applied' });
      expect(await op({ type: 'milestone', task_id: id, code: 'at_dropoff' })).toMatchObject({ result: 'rejected', reason: 'invalid_stage' });
      const opId = randomUUID();
      const m = { type: 'milestone', task_id: id, code: 'picked_up', client_op_id: opId, lat: 29.33, lng: 48.07 };
      expect(await op(m)).toMatchObject({ result: 'applied' });
      expect(await op(m)).toMatchObject({ result: 'duplicate' });
      expect(await status(id, 'in_progress')).toMatchObject({ result: 'applied' });
      const list = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data;
      const mine = list.find((x: { id: string }) => x.id === id);
      expect(mine).toMatchObject({ stage: 'picked_up', has_proof: false });
      expect(JSON.stringify(mine)).not.toContain('"pin"');
    });
    it('the recipient sees the driver first name and position once the parcel is on its way', async () => {
      const { link } = await info(id);
      const r = await request(http).get(`/v1/public/track/${link.token}`).expect(200);
      expect(r.body).toMatchObject({ status: 'in_progress', stage: 'picked_up', driver: 'سالم' });
      expect(r.body.position).toMatchObject({ lat: 29.334, lng: 48.074 });
    });
    it('cannot complete without proof; a wrong PIN is refused; the right PIN proves delivery', async () => {
      expect(await status(id, 'completed')).toMatchObject({ result: 'rejected', reason: 'proof_required' });
      const { link } = await info(id);
      const wrong = link.pin === '0000' ? '1111' : '0000';
      expect(await op({ type: 'pod', task_id: id, method: 'pin', pin: wrong })).toMatchObject({ result: 'rejected', reason: 'wrong_pin' });
      expect(await op({ type: 'pod', task_id: id, method: 'pin', pin: link.pin })).toMatchObject({ result: 'applied', verified: true });
      expect(await op({ type: 'pod', task_id: id, method: 'pin', pin: link.pin })).toMatchObject({ result: 'rejected', reason: 'already_proven' });
      expect(await status(id, 'completed')).toMatchObject({ result: 'applied' });
      expect((await info(id)).pod).toMatchObject({ method: 'pin', verified: true });
      await post(`/v1/tasks/${id}/review`, { version: await version(id) }).expect(200);
      const pub = (await request(http).get(`/v1/public/track/${link.token}`).expect(200)).body;
      expect(pub.pin).toBeNull();
      expect(pub.position).toBeNull();
    });
    it('locks the PIN after 5 wrong tries; a photo proof waits for the office', async () => {
      const t = await assigned();
      await status(t, 'accepted');
      await status(t, 'in_progress');
      const { link } = await info(t);
      const wrong = link.pin === '0000' ? '1111' : '0000';
      const reasons = [];
      for (let i = 0; i < 5; i++) reasons.push((await op({ type: 'pod', task_id: t, method: 'pin', pin: wrong })).reason);
      expect(reasons).toEqual(['wrong_pin', 'wrong_pin', 'wrong_pin', 'wrong_pin', 'pin_locked']);
      expect(await op({ type: 'pod', task_id: t, method: 'pin', pin: link.pin })).toMatchObject({ result: 'rejected', reason: 'pin_locked' });
      expect((await get('/v1/delivery/exceptions').expect(200)).body.pins.map((x: { id: string }) => x.id)).toContain(t);
      expect(await op({ type: 'pod', task_id: t, method: 'photo', file_key: 'pod/abc.jpg', recipient_name: 'حارس العمارة' })).toMatchObject({ result: 'applied', verified: false });
      expect(await status(t, 'completed')).toMatchObject({ result: 'applied' });
      await post(`/v1/tasks/${t}/review`, { version: await version(t) }).expect(409);
      expect((await get('/v1/delivery/exceptions').expect(200)).body.proofs.map((x: { id: string }) => x.id)).toContain(t);
      await post(`/v1/delivery/tasks/${t}/pod/approve`, {}, driver.token).expect(403);
      await post(`/v1/delivery/tasks/${t}/pod/approve`, {}).expect(200);
      await post(`/v1/delivery/tasks/${t}/pod/approve`, {}).expect(409);
      await post(`/v1/tasks/${t}/review`, { version: await version(t) }).expect(200);
    });
    it('a rejected photo blocks the review until a valid proof exists', async () => {
      const t = await assigned();
      await status(t, 'accepted');
      await status(t, 'in_progress');
      await op({ type: 'pod', task_id: t, method: 'signature', recipient_name: 'أحمد' });
      await status(t, 'completed');
      await post(`/v1/delivery/tasks/${t}/pod/reject`, {}).expect(400);
      await post(`/v1/delivery/tasks/${t}/pod/reject`, { reason: 'الصورة غير واضحة' }).expect(200);
      await post(`/v1/tasks/${t}/review`, { version: await version(t) }).expect(409);
    });
    it('no recipient phone: no PIN needed to complete', async () => {
      const t = await assigned({ dropoff: { area: 'حولي' } });
      await status(t, 'accepted');
      await status(t, 'in_progress');
      expect(await status(t, 'completed')).toMatchObject({ result: 'applied' });
    });
    it('fails with a reason code, then returns to the sender', async () => {
      const t = await assigned();
      await status(t, 'accepted');
      await status(t, 'in_progress');
      expect(await status(t, 'failed')).toMatchObject({ result: 'rejected', reason: 'reason_required' });
      expect(await status(t, 'failed', { reason_code: 'recipient_absent' })).toMatchObject({ result: 'applied' });
      expect((await info(t)).failure).toMatchObject({ reason_code: 'recipient_absent' });
      expect((await get('/v1/delivery/exceptions').expect(200)).body.returns.map((x: { id: string }) => x.id)).toContain(t);
      const withReturns = (await get('/v1/driver/tasks?include=returns', driver.token).expect(200)).body.data.map((x: { id: string }) => x.id);
      expect(withReturns).toContain(t);
      expect((await get('/v1/driver/tasks', driver.token).expect(200)).body.data.map((x: { id: string }) => x.id)).not.toContain(t);
      expect(await op({ type: 'milestone', task_id: t, code: 'returned_to_sender' })).toMatchObject({ result: 'applied' });
      expect((await get('/v1/delivery/exceptions').expect(200)).body.returns.map((x: { id: string }) => x.id)).not.toContain(t);
    });
    it('an unknown reason code is a bad request', async () => {
      await post('/v1/driver/sync', { ops: [{ type: 'task_status', client_op_id: randomUUID(), task_id: randomUUID(), to_status: 'failed', reason_code: 'nope', occurred_at: now() }] }, driver.token).expect(400);
      await post('/v1/driver/sync', { ops: [{ type: 'pod', client_op_id: randomUUID(), task_id: randomUUID(), method: 'pin', pin: '12', occurred_at: now() }] }, driver.token).expect(400);
    });
  });

  describe('import and auto-assign', () => {
    it('imports orders, skipping duplicates and reporting bad rows', async () => {
      const r = await post('/v1/delivery/import', { legal_entity_id: A.legal_entity_id, orders: [
        { external_order_id: 'TL-1001', ...order() },
        { external_order_id: 'TL-1002', ...order(), window: { from: new Date(Date.now() + 3_600_000).toISOString(), to: new Date(Date.now() + 7_200_000).toISOString() } },
        { external_order_id: 'TL-1001', ...order() },
        { external_order_id: 'TL-1003', dropoff: { area: 'حولي' } },
        { external_order_id: 'TL-1004', ...order({ cod_amount: 'x' }) },
      ] }).expect(200);
      expect(r.body).toMatchObject({ created: 2, duplicates: 1 });
      expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
      const again = await post('/v1/delivery/import', { legal_entity_id: A.legal_entity_id, orders: [{ external_order_id: 'TL-1001', ...order() }] }).expect(200);
      expect(again.body).toMatchObject({ created: 0, duplicates: 1 });
      await post('/v1/delivery/import', { legal_entity_id: A.legal_entity_id, orders: [] }).expect(400);
    });
    it('assigns to the nearest fresh driver within the radius and leaves far orders in the queue', async () => {
      const near = await create(order({ pickup: { area: 'السالمية', lat: 29.336, lng: 48.076 } }));
      const far = await create(order({ dropoff: { area: 'الوفرة', lat: 28.6, lng: 48.0 } }));
      const r = await post('/v1/delivery/auto-assign', { task_ids: [near.id, far.id] }).expect(200);
      expect(r.body.assigned).toEqual([expect.objectContaining({ task_id: near.id, worker_id: driver.id })]);
      expect(r.body.skipped).toEqual([far.id]);
      expect((await get(`/v1/tasks/${near.id}`).expect(200)).body).toMatchObject({ status: 'assigned', worker_id: driver.id });
      await post('/v1/delivery/auto-assign', { task_ids: [near.id] }, B.access_token).expect(200).expect((x) => expect(x.body.assigned).toEqual([]));
    });
    it('respects the open-task cap from settings', async () => {
      await request(http).put('/v1/delivery/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, max_open_per_driver: 1 }).expect(200);
      const t = await create();
      expect((await post('/v1/delivery/auto-assign', { task_ids: [t.id] }).expect(200)).body.skipped).toEqual([t.id]);
      await request(http).put('/v1/delivery/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, max_open_per_driver: 20 }).expect(200);
    });
  });

  describe('exceptions, settings and earnings', () => {
    it('a past window is late', async () => {
      const t = await create(order(), { window: { from: new Date(Date.now() - 7_200_000).toISOString(), to: new Date(Date.now() - 3_600_000).toISOString() } });
      expect((await get('/v1/delivery/exceptions').expect(200)).body.late.map((x: { id: string }) => x.id)).toContain(t.id);
      expect((await get('/v1/delivery/exceptions', B.access_token).expect(200)).body.late).toEqual([]);
    });
    it('settings: defaults, validated changes, owner only', async () => {
      const d = (await get(`/v1/delivery/settings?legal_entity_id=${B.legal_entity_id}`, B.access_token).expect(200)).body;
      expect(d).toMatchObject({ require_pin: true, max_open_per_driver: 5, commission_per_delivery: '0.000' });
      await request(http).put('/v1/delivery/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, auto_assign_radius_km: 500 }).expect(400);
      await request(http).put('/v1/delivery/settings').set(auth(driver.token)).send({ legal_entity_id: A.legal_entity_id, require_pin: false }).expect(403);
      await request(http).put('/v1/delivery/settings').set(auth(B.access_token)).send({ legal_entity_id: A.legal_entity_id, require_pin: false }).expect(400);
      const r = await request(http).put('/v1/delivery/settings').set(auth(A.access_token))
        .send({ legal_entity_id: A.legal_entity_id, commission_per_delivery: '0.500', commission_per_failed: '0.250' }).expect(200);
      expect(r.body).toMatchObject({ commission_per_delivery: '0.500', commission_per_failed: '0.250', max_open_per_driver: 20 });
    });
    it('earnings: deliveries and failures times the commission', async () => {
      const from = new Date(Date.now() - 3_600_000).toISOString(), to = new Date(Date.now() + 3_600_000).toISOString();
      const r = (await get(`/v1/delivery/earnings?from=${from}&to=${to}`).expect(200)).body.data;
      const me = r.find((x: { worker_id: string }) => x.worker_id === driver.id);
      expect(me).toMatchObject({ delivered: 4, failed: 1, commission: '2.250' });
      expect((await get(`/v1/delivery/earnings?from=${from}&to=${to}`, B.access_token).expect(200)).body.data).toEqual([]);
      await get(`/v1/delivery/earnings?from=${to}&to=${from}`).expect(400);
    });
  });
});
