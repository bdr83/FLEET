/**
 * Freight pack (freight@1): transport orders, planning on our truck and trailer or a subcontract carrier, driver stages
 * with weight, seal and receiver, detention, trip expenses, settlement, report, exceptions and invoicing.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('Freight pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let customer: string;
  let d1: { token: string; id: string; truck: string };
  let trailer: string;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const wb = () => `WB${Date.now() % 1e8}${Math.floor(Math.random() * 100)}`;
  async function op(token: string, o: Record<string, unknown>, at = new Date().toISOString()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, token).expect(200)).body.results[0];
  }
  const body = (extra: Record<string, unknown> = {}) => ({
    legal_entity_id: A.legal_entity_id, waybill_no: wb(), customer_id: customer,
    cargo: { description: 'حديد تسليح', packages: 40, weight_kg: 18000 },
    pickup: { name: 'مصنع الحديد', area: 'الشعيبة', contact_phone: '50000011' },
    dropoff: { name: 'مشروع المطلاع', area: 'المطلاع', lat: 29.6, lng: 47.7 },
    pickup_at: ago(360), deliver_by: new Date(Date.now() + 60 * 60_000).toISOString(), planned_km: 85, ...extra,
  });
  const version = async (id: string) => (await get(`/v1/tasks/${id}`).expect(200)).body.version;

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'نقل أ');
    B = await onboard(app, 'نقل ب');
    customer = (await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'مقاولات المطلاع' }).expect(201)).body.id;
    const k = (await post('/v1/contracts', { customer_id: customer, starts_on: '2026-01-01', rates: [
      { unit: 'trip', price: '85.000', sector_pack: 'freight@1' }, { unit: 'hour', price: '5.000', sector_pack: 'freight@1' },
      { unit: 'ton', price: '4.000', sector_pack: 'freight@1' }] }).expect(201)).body;
    await post(`/v1/contracts/${k.id}/activate`, {}).expect(200);
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'سالم العجمي', phone }).expect(201)).body;
    const truck = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'truck', plate_no: `TR-${Date.now() % 100000}`, capacity: { kg: 20000 } }).expect(201)).body.id;
    trailer = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'trailer', plate_no: `TL-${Date.now() % 100000}` }).expect(201)).body.id;
    const token = (await joinAs(app, A.tenant.id, phone)).access_token;
    await post('/v1/driver/shifts', { client_op_id: randomUUID(), asset_id: truck }, token).expect(201);
    d1 = { token, id: w.id, truck };
  });
  afterAll(async () => app?.close());

  it('creates a transport order as one priced task; same waybill = same order; input is checked', async () => {
    const r = (await post('/v1/freight/shipments', body()).expect(201)).body;
    expect(r).toMatchObject({ status: 'ready', mode: 'ftl', bill_unit: 'trip', planned_km: 85, customer_name: 'مقاولات المطلاع', run_by: null });
    const t = (await get(`/v1/tasks/${r.task_id}`).expect(200)).body;
    expect(t).toMatchObject({ sector_pack: 'freight@1', ref: r.waybill_no });
    expect(t.contract_id).toBeTruthy();
    expect(t.attributes.address).toBe('مشروع المطلاع، المطلاع');
    expect((await post('/v1/freight/shipments', { ...body(), waybill_no: r.waybill_no }).expect(201)).body.task_id).toBe(r.task_id);
    await post('/v1/freight/shipments', body({ bill_unit: 'km', planned_km: undefined })).expect(400);
    await post('/v1/freight/shipments', body({ cargo: { packages: 3 } })).expect(400);
    await post('/v1/freight/shipments', body({ pickup: {} })).expect(400);
    await post('/v1/freight/shipments', body({ deliver_by: ago(400) })).expect(400);
    await get(`/v1/freight/shipments/${r.task_id}`, B.access_token).expect(404);
    await get(`/v1/freight/shipments/${r.task_id}`, d1.token).expect(403);
    expect((await get('/v1/freight/shipments?status=open').expect(200)).body.data.map((x: { task_id: string }) => x.task_id)).toContain(r.task_id);
    expect((await get('/v1/freight/shipments', B.access_token).expect(200)).body.data).toEqual([]);
  });

  describe('own truck: driver stages, detention, settlement and invoice', () => {
    let ship: { task_id: string; waybill_no: string };
    beforeAll(async () => {
      ship = (await post('/v1/freight/shipments', body()).expect(201)).body;
    });

    it('plans the trailer, assigns truck and driver; the driver sees the waybill', async () => {
      await post(`/v1/freight/shipments/${ship.task_id}/plan`, { version: await version(ship.task_id), trailer_asset_id: d1.truck }).expect(400); // not a trailer
      const p = (await post(`/v1/freight/shipments/${ship.task_id}/plan`, { version: await version(ship.task_id), trailer_asset_id: trailer }).expect(200)).body;
      expect(p.trailer_plate).toMatch(/^TL-/);
      await post(`/v1/tasks/${ship.task_id}/assign`, { version: await version(ship.task_id), worker_id: d1.id, asset_id: d1.truck, exclusive: true }).expect(200);
      const t = (await get('/v1/driver/tasks', d1.token).expect(200)).body.data.find((x: { id: string }) => x.id === ship.task_id);
      expect(t.freight).toMatchObject({ waybill_no: ship.waybill_no, trailer_plate: p.trailer_plate, cargo: { weight_kg: 18000 } });
      const s = (await get(`/v1/freight/shipments/${ship.task_id}`).expect(200)).body;
      expect(s).toMatchObject({ run_by: 'own', worker_name: 'سالم العجمي' });
      // a trip on our truck cannot also go to a carrier
      const ca = (await post('/v1/freight/carriers', { legal_entity_id: A.legal_entity_id, name: `ناقل ${wb()}` }).expect(201)).body;
      await post(`/v1/freight/shipments/${ship.task_id}/plan`, { version: s.version, carrier_id: ca.id, carrier_cost: 50 }).expect(409);
    });

    it('stages go in order; loading records weight and seal; unloading needs the receiver', async () => {
      const id = ship.task_id;
      expect((await op(d1.token, { type: 'task_status', task_id: id, to_status: 'accepted' })).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: id, code: 'loaded' })).reason).toBe('stage_out_of_order');
      expect((await op(d1.token, { type: 'milestone', task_id: id, code: 'pour_start' })).reason).toBe('not_supported');
      expect((await op(d1.token, { type: 'milestone', task_id: id, code: 'at_pickup' }, ago(300))).result).toBe('applied');
      expect((await op(d1.token, { type: 'task_status', task_id: id, to_status: 'in_progress' })).reason).toBe('stage_out_of_order'); // not loaded yet
      expect((await op(d1.token, { type: 'milestone', task_id: id, code: 'loaded', weight_kg: 18000, seal_no: 'S-7781' }, ago(120))).result).toBe('applied');
      expect((await op(d1.token, { type: 'task_status', task_id: id, to_status: 'in_progress' }, ago(119))).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: id, code: 'at_dropoff' }, ago(60))).result).toBe('applied');
      expect((await op(d1.token, { type: 'task_status', task_id: id, to_status: 'completed' })).reason).toBe('proof_required');
      expect((await op(d1.token, { type: 'milestone', task_id: id, code: 'unloaded', weight_kg: 17000 })).reason).toBe('receiver_required');
      expect((await op(d1.token, { type: 'milestone', task_id: id, code: 'unloaded', weight_kg: 17000, received_by: 'م. يوسف' }, ago(10))).result).toBe('applied');
      expect((await op(d1.token, { type: 'task_status', task_id: id, to_status: 'failed', reason_code: 'recipient_absent' })).reason).toBe('invalid_reason');
      expect((await op(d1.token, { type: 'task_status', task_id: id, to_status: 'completed' }, ago(9))).result).toBe('applied');
      const s = (await get(`/v1/freight/shipments/${id}`).expect(200)).body;
      // 180 min at pickup - 120 free = 60 min detention → 1 h; 50 min at drop-off is inside the free time
      expect(s).toMatchObject({ status: 'completed', seal_no: 'S-7781', loaded_weight_kg: 18000, delivered_weight_kg: 17000, received_by: 'م. يوسف',
        detention_minutes: 60, quantities: { trip: 1, hour: 1 }, weight_mismatch: true });
    });

    it('trip expenses and settlement; exceptions show the weight mismatch', async () => {
      await post(`/v1/freight/shipments/${ship.task_id}/expenses`, { category: 'fuel', amount: 12.5, note: 'ديزل' }).expect(201);
      await post(`/v1/freight/shipments/${ship.task_id}/expenses`, { category: 'tolls', amount: 0 }).expect(400);
      await post(`/v1/freight/shipments/${ship.task_id}/expenses`, { category: 'tires', amount: 3 }).expect(400);
      const st = (await get(`/v1/freight/shipments/${ship.task_id}/settlement`).expect(200)).body;
      expect(st).toMatchObject({ revenue: 90, carrier_cost: 0, expenses: 12.5, profit: 77.5, estimated: false, on_time: true, capacity_kg: 20000 });
      const e = (await get('/v1/freight/exceptions').expect(200)).body;
      expect(e.weight_mismatch.map((x: { task_id: string }) => x.task_id)).toContain(ship.task_id);
    });

    it('review, then the invoice prices the trip and detention', async () => {
      await post(`/v1/tasks/${ship.task_id}/review`, { version: await version(ship.task_id) }).expect(200);
      const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
      const inv = (await post('/v1/invoices', { customer_id: customer, period_from: today, period_to: today }).expect(201)).body;
      const mine = inv.lines.filter((l: { task_id: string }) => l.task_id === ship.task_id).map((l: { unit: string; amount: string }) => [l.unit, l.amount]).sort();
      expect(mine).toEqual([['hour', '5.000'], ['trip', '85.000']]);
    });
  });

  it('subcontract carrier: planned with its cost, office records the delivery, priced by ton', async () => {
    const ca = (await post('/v1/freight/carriers', { legal_entity_id: A.legal_entity_id, name: 'ناقلات الجهراء', phone: '50000012' }).expect(201)).body;
    await post('/v1/freight/carriers', { legal_entity_id: A.legal_entity_id, name: 'ناقلات الجهراء' }).expect(409);
    const s = (await post('/v1/freight/shipments', body({ bill_unit: 'ton', mode: 'ltl' })).expect(201)).body;
    await post(`/v1/freight/shipments/${s.task_id}/carrier-delivered`, { version: s.version, received_by: 'x' }).expect(409); // not a carrier trip
    await post(`/v1/freight/shipments/${s.task_id}/plan`, { version: s.version, carrier_id: ca.id }).expect(400); // cost required
    const p = (await post(`/v1/freight/shipments/${s.task_id}/plan`, { version: s.version, carrier_id: ca.id, carrier_cost: 60 }).expect(200)).body;
    expect(p).toMatchObject({ run_by: 'carrier', carrier_name: 'ناقلات الجهراء', carrier_cost: 60 });
    const d = (await post(`/v1/freight/shipments/${s.task_id}/carrier-delivered`, { version: p.version, received_by: 'أبو فهد', delivered_weight_kg: 17950 }).expect(200)).body;
    expect(d).toMatchObject({ status: 'completed', quantities: { ton: 17.95 } });
    const st = (await get(`/v1/freight/shipments/${s.task_id}/settlement`).expect(200)).body;
    expect(st).toMatchObject({ revenue: 71.8, carrier_cost: 60, profit: 11.8 });
    const list = (await get('/v1/freight/carriers').expect(200)).body.data;
    expect(list.find((x: { id: string }) => x.id === ca.id).shipments).toBe(1);
  });

  it('report totals and KPIs; exceptions list unplanned and late trips', async () => {
    const late = (await post('/v1/freight/shipments', body({ pickup_at: ago(300), deliver_by: ago(30) })).expect(201)).body;
    const r = (await get(`/v1/freight/report?from=${ago(24 * 60)}&to=${new Date(Date.now() + 86_400_000).toISOString()}`).expect(200)).body;
    expect(r.totals).toMatchObject({ delivered: 2, own_trips: 1, carrier_trips: 1, revenue: 161.8, carrier_cost: 60, expenses: 12.5, profit: 89.3, on_time_pct: 100, load_utilization_pct: 90 });
    expect(r.totals.cost_per_km).toBe(0.426); // (60 + 12.5) / 170 km
    const e = (await get('/v1/freight/exceptions').expect(200)).body;
    expect(e.unplanned.map((x: { task_id: string }) => x.task_id)).toContain(late.task_id);
    expect(e.late.map((x: { task_id: string }) => x.task_id)).toContain(late.task_id);
  });

  it('settings are validated; the pack can be turned off', async () => {
    await request(http).put('/v1/freight/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, free_detention_minutes: 5000 }).expect(400);
    const s = (await request(http).put('/v1/freight/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, free_detention_minutes: 60 }).expect(200)).body;
    expect(s).toMatchObject({ free_detention_minutes: 60, weight_tolerance_pct: 2 });
    const { user_token } = await login(app, newPhone());
    const t = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'بدون شحن', packs: ['delivery'] }).expect(201)).body;
    expect((await get('/v1/freight/shipments', t.access_token).expect(403)).body.message).toBe('pack_disabled');
    await post('/v1/tasks', { legal_entity_id: t.legal_entity_id, sector_pack: 'freight@1' }, t.access_token).expect(403);
  });
});
