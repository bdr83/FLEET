/**
 * P7: preventive maintenance, work orders, expenses (office and driver claims) and cost reports.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('P7 maintenance and expenses', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let van: string;
  let truck: string;
  let driver: { token: string; id: string };
  let supervisor: string;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const range = () => `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`;

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'صيانة أ');
    B = await onboard(app, 'صيانة ب');
    van = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'van', plate_no: `V-${Date.now()}`, odometer_km: 9_800 }).expect(201)).body.id;
    truck = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'truck', plate_no: `T-${Date.now()}`, odometer_km: 50_000 }).expect(201)).body.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'ناصر', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, A.tenant.id, phone)).access_token, id: w.id };
    const sp = newPhone();
    await post('/v1/members', { phone: sp, role_code: 'admin' }).expect(201);
    supervisor = (await joinAs(app, A.tenant.id, sp)).access_token;
  });
  afterAll(async () => app?.close());

  describe('preventive maintenance', () => {
    let oil: string;
    it('a plan counts from the current odometer and shows up when due', async () => {
      oil = (await post('/v1/maintenance/plans', { asset_id: van, name: 'تغيير زيت', interval_km: 5000 }).expect(201)).body.id;
      await post('/v1/maintenance/plans', { asset_id: truck, name: 'فحص سنوي', interval_days: 365, last_done_on: new Date(Date.now() - 360 * 86_400_000).toISOString().slice(0, 10) }).expect(201);
      await post('/v1/maintenance/plans', { asset_id: van, name: 'بلا فترة' }).expect(400);
      let due = await get('/v1/maintenance/due').expect(200);
      expect(due.body.data.map((x: { name: string; state: string }) => [x.name, x.state])).toEqual([['فحص سنوي', 'due_soon']]);
      await request(http).patch(`/v1/assets/${van}`).set(auth(A.access_token)).send({ odometer_km: 14_900 }).expect(200);
      due = await get('/v1/maintenance/due').expect(200);
      expect(due.body.data.find((x: { plan_id: string }) => x.plan_id === oil)).toMatchObject({ km_left: -100, state: 'overdue', due_km: 14_800 });
    });
    it('another company sees no plans', async () => {
      const r = await get('/v1/maintenance/due', B.access_token).expect(200);
      expect(r.body.data).toEqual([]);
      await post('/v1/maintenance/plans', { asset_id: van, name: 'x', interval_km: 1 }, B.access_token).expect(400);
    });

    describe('work orders', () => {
      let wo: { id: string; number: string };
      it('opening with out_of_service takes the vehicle off the road and blocks assignment', async () => {
        const r = await post('/v1/work-orders', { asset_id: van, kind: 'preventive', plan_id: oil, out_of_service: true, vendor: 'كراج الري' }).expect(201);
        wo = r.body;
        expect(wo.number).toMatch(/^WO-\d{4}-00001$/);
        expect((await get(`/v1/assets/${van}`).expect(200)).body.status).toBe('out_of_service');
        await post('/v1/driver/shifts', { client_op_id: randomUUID(), asset_id: van }, driver.token).expect(409);
        const second = (await post('/v1/work-orders', { asset_id: truck, kind: 'inspection' }).expect(201)).body;
        expect(second.number).toMatch(/-00002$/);
      });
      it('collects cost lines', async () => {
        await post(`/v1/work-orders/${wo.id}/lines`, { kind: 'part', description: 'زيت 5 لتر', qty: 1, unit_cost: '7.500' }).expect(201);
        const r = await post(`/v1/work-orders/${wo.id}/lines`, { kind: 'labor', description: 'أجرة', qty: 1.5, unit_cost: 4 }).expect(201);
        expect(r.body.total_cost).toBe('13.500');
        await post(`/v1/work-orders/${wo.id}/lines`, { kind: 'part', description: 'x', unit_cost: '-1' }).expect(400);
      });
      it('completing resets the plan, frees the vehicle and books the cost', async () => {
        await post(`/v1/work-orders/${wo.id}/start`, {}).expect(200);
        await post(`/v1/work-orders/${wo.id}/complete`, { odometer_km: 14_000 }).expect(400); // below the last reading
        const r = await post(`/v1/work-orders/${wo.id}/complete`, { odometer_km: 14_950 }).expect(200);
        expect(r.body).toMatchObject({ status: 'done', odometer_km: 14_950 });
        expect((await get(`/v1/assets/${van}`).expect(200)).body).toMatchObject({ status: 'available', odometer_km: 14_950 });
        const due = await get('/v1/maintenance/due').expect(200);
        expect(due.body.data.find((x: { plan_id: string }) => x.plan_id === oil)).toBeUndefined();
        const plan = (await get(`/v1/maintenance/plans?asset_id=${van}`).expect(200)).body.data[0];
        expect(plan.last_done_km).toBe(14_950);
        const ex = await get(`/v1/expenses?asset_id=${van}&category=maintenance`).expect(200);
        expect(ex.body.data).toEqual([expect.objectContaining({ amount: '13.500', status: 'approved', work_order_id: wo.id })]);
        await post(`/v1/work-orders/${wo.id}/lines`, { kind: 'part', description: 'x', unit_cost: '1' }).expect(409);
        await post(`/v1/work-orders/${wo.id}/cancel`, {}).expect(409);
      });
      it('the vehicle stays off the road while another order still holds it', async () => {
        const w1 = (await post('/v1/work-orders', { asset_id: truck, kind: 'accident', out_of_service: true }).expect(201)).body;
        const w2 = (await post('/v1/work-orders', { asset_id: truck, kind: 'corrective', out_of_service: true }).expect(201)).body;
        await post(`/v1/work-orders/${w1.id}/cancel`, {}).expect(200);
        expect((await get(`/v1/assets/${truck}`).expect(200)).body.status).toBe('out_of_service');
        await post(`/v1/work-orders/${w2.id}/complete`, {}).expect(200);
        expect((await get(`/v1/assets/${truck}`).expect(200)).body.status).toBe('available');
      });
      it('another company cannot open or read', async () => {
        await get(`/v1/work-orders/${wo.id}`, B.access_token).expect(404);
        await post(`/v1/work-orders/${wo.id}/start`, {}, B.access_token).expect(404);
      });
    });
  });

  describe('expenses', () => {
    let claim: string;
    it('office entries are approved at once and follow the vehicle legal entity', async () => {
      const r = await post('/v1/expenses', { category: 'insurance', amount: '120.000', asset_id: truck, vendor: 'شركة التأمين' }).expect(201);
      expect(r.body).toMatchObject({ status: 'approved', currency: 'KWD', legal_entity_id: A.legal_entity_id });
      await post('/v1/expenses', { category: 'fuel', amount: '5', liters: 10, asset_id: truck, odometer_km: 50_400 }).expect(201);
      await post('/v1/expenses', { category: 'fines', amount: '0' }).expect(400);
      await post('/v1/expenses', { category: 'fines', amount: '10' }).expect(400); // no vehicle, worker or legal entity
      await post('/v1/expenses', { category: 'tires', amount: '10', liters: 3, asset_id: truck }).expect(400);
      await post('/v1/expenses', { category: 'fines', amount: '10', legal_entity_id: B.legal_entity_id }).expect(400);
    });
    it('a driver claims fuel during a shift; it is linked to the shift vehicle and idempotent', async () => {
      const s = (await post('/v1/driver/shifts', { client_op_id: randomUUID(), asset_id: van, odometer_km: 14_950 }, driver.token).expect(201)).body;
      const op = randomUUID();
      const r = await post('/v1/driver/expenses', { client_op_id: op, category: 'fuel', amount: '6.000', liters: 40, odometer_km: 15_100 }, driver.token).expect(201);
      expect(r.body).toMatchObject({ status: 'submitted', asset_id: van, shift_id: s.id, worker_id: driver.id });
      claim = r.body.id;
      const again = await post('/v1/driver/expenses', { client_op_id: op, category: 'fuel', amount: '6.000' }, driver.token).expect(201);
      expect(again.body.id).toBe(claim);
      await post('/v1/driver/expenses', { client_op_id: randomUUID(), category: 'fines', amount: '5' }, driver.token).expect(400);
      const mine = await get('/v1/driver/expenses', driver.token).expect(200);
      expect(mine.body.data.map((x: { id: string }) => x.id)).toEqual([claim]);
      await post(`/v1/driver/shifts/${s.id}/end`, { odometer_km: 15_200 }, driver.token).expect(200);
    });
    it('a supervisor approves; nobody approves their own claim; decisions are final', async () => {
      await post(`/v1/expenses/${claim}/approve`, {}, driver.token).expect(403);
      await post(`/v1/expenses/${claim}/reject`, {}, supervisor).expect(400);
      const r = await post(`/v1/expenses/${claim}/approve`, {}, supervisor).expect(200);
      expect(r.body.status).toBe('approved');
      await post(`/v1/expenses/${claim}/reject`, { reason: 'x' }, supervisor).expect(409);
    });
    it('a rejected claim keeps its reason', async () => {
      const s2 = (await post('/v1/driver/expenses', { client_op_id: randomUUID(), category: 'parking', amount: '0.500' }, driver.token).expect(201)).body;
      const r = await post(`/v1/expenses/${s2.id}/reject`, { reason: 'لا يوجد إيصال' }, supervisor).expect(200);
      expect(r.body).toMatchObject({ status: 'rejected', reject_reason: 'لا يوجد إيصال' });
    });
    it('lists with totals and filters', async () => {
      const r = await get('/v1/expenses?status=approved').expect(200);
      expect(r.body.totals).toEqual([{ currency: 'KWD', total: '144.500' }]); // 13.5 + 120 + 5 + 6
      expect(r.body.data.every((x: { status: string }) => x.status === 'approved')).toBe(true);
      const b = await get('/v1/expenses', B.access_token).expect(200);
      expect(b.body.data).toEqual([]);
    });
  });

  describe('cost reports', () => {
    it('by vehicle: cost per km and fuel economy', async () => {
      const r = await get(`/v1/reports/costs?${range()}`).expect(200);
      const v = r.body.data.find((x: { asset_id: string }) => x.asset_id === van);
      // van: 13.5 maintenance + 6 fuel = 19.5 over 250 km (shift 14950 → 15200), 40 l
      expect(v).toMatchObject({ total: '19.500', fuel_cost: '6.000', liters: 40, km: 250, cost_per_km: '0.078', km_per_liter: 6.25 });
    });
    it('by category, and as CSV', async () => {
      const r = await get(`/v1/reports/costs?${range()}&group=category`).expect(200);
      expect(r.body.data[0]).toMatchObject({ category: 'insurance', total: '120.000' });
      const csv = await get(`/v1/reports/costs?${range()}&group=category&format=csv`).expect(200);
      expect(csv.text).toContain('category,currency,entries,total');
      await get(`/v1/reports/costs?${range()}`, driver.token).expect(403);
    });
  });
});
