/**
 * Ready-mix concrete pack (concrete@1): pour orders split into loads, mixer stages and the signed delivery ticket,
 * age and waiting time, quantity changes, cancel, the mixers board, exceptions, waiting report and invoicing by m³.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

(hasDb ? describe : describe.skip)('Concrete pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let customer: string;
  let d1: { token: string; id: string; mixer: string };
  let d2: { token: string; id: string; mixer: string };
  let pump: string;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = A.access_token) => request(http).get(path).set(auth(token));
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const ref = () => `P${Date.now() % 1e8}${Math.floor(Math.random() * 100)}`;
  async function op(token: string, o: Record<string, unknown>, at = new Date().toISOString()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: at, ...o }] }, token).expect(200)).body.results[0];
  }
  const pourBody = (extra: Record<string, unknown> = {}) => ({
    legal_entity_id: A.legal_entity_id, ref: ref(), customer_id: customer, mix_code: 'C35', volume_m3: 22, pour_rate_m3h: 30,
    scheduled_at: new Date(Date.now() + 60 * 60_000).toISOString(), site: { name: 'برج الريم', area: 'الشرق', block: '2', plot: '15', lat: 29.375, lng: 47.99, contact_name: 'م. خالد', contact_phone: '50000009' }, ...extra,
  });
  async function assign(taskId: string, d: { id: string; mixer: string }) {
    const v = (await get(`/v1/tasks/${taskId}`).expect(200)).body.version;
    await post(`/v1/tasks/${taskId}/assign`, { version: v, worker_id: d.id, asset_id: d.mixer }).expect(200);
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'خرسانة أ');
    B = await onboard(app, 'خرسانة ب');
    customer = (await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'مقاولات الريم' }).expect(201)).body.id;
    const k = (await post('/v1/contracts', { customer_id: customer, starts_on: '2026-01-01', rates: [
      { unit: 'm3', price: '22.000', min_charge: '66.000', sector_pack: 'concrete@1' }, { unit: 'hour', price: '10.000', sector_pack: 'concrete@1' }] }).expect(201)).body;
    await post(`/v1/contracts/${k.id}/activate`, {}).expect(200);
    const mk = async (name: string, plate: string) => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: name, phone }).expect(201)).body;
      const m = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'mixer', plate_no: plate, capacity: { m3: 9 } }).expect(201)).body;
      const token = (await joinAs(app, A.tenant.id, phone)).access_token;
      await post('/v1/driver/shifts', { client_op_id: randomUUID(), asset_id: m.id }, token).expect(201);
      return { token, id: w.id, mixer: m.id };
    };
    d1 = await mk('فهد المطيري', `MX-${Date.now() % 100000}`);
    d2 = await mk('ناصر العنزي', `MX-${(Date.now() + 7) % 100000}`);
    pump = (await post('/v1/assets', { legal_entity_id: A.legal_entity_id, asset_type: 'pump', plate_no: `PU-${Date.now() % 100000}` }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  describe('pour orders and loads', () => {
    it('splits the pour into loads for a continuous pour and creates one ready task per load', async () => {
      const r = (await post('/v1/concrete/pours', pourBody({ pump_asset_id: pump })).expect(201)).body;
      expect(r).toMatchObject({ state: 'scheduled', mix_code: 'C35', volume_m3: 22, pump_required: true, customer_name: 'مقاولات الريم' });
      expect(r.loads.map((l: { volume_m3: number }) => l.volume_m3)).toEqual([9, 9, 4]);
      expect(r.loads.map((l: { ticket_no: string }) => l.ticket_no)).toEqual([`${r.ref}-1`, `${r.ref}-2`, `${r.ref}-3`]);
      expect(r.plan).toMatchObject({ spacing_minutes: 18, trucks_needed: 3, pour_minutes: 44, estimated: true });
      const t = (await get(`/v1/tasks/${r.loads[0].task_id}`).expect(200)).body;
      expect(t).toMatchObject({ sector_pack: 'concrete@1', status: 'ready', customer_id: customer });
      expect(t.contract_id).toBeTruthy();
      expect(t.attributes).toMatchObject({ mix_code: 'C35', volume_m3: 9, address: 'برج الريم، الشرق، ق 2، قسيمة 15' });
      // same ref again = same order (safe retry)
      const again = (await post('/v1/concrete/pours', { ...pourBody(), ref: r.ref }).expect(201)).body;
      expect(again.id).toBe(r.id);
      expect(again.loads).toHaveLength(3);
    });
    it('validates input and isolates companies', async () => {
      await post('/v1/concrete/pours', pourBody({ volume_m3: 0 })).expect(400);
      await post('/v1/concrete/pours', pourBody({ ref: 'bad ref!' })).expect(400);
      await post('/v1/concrete/pours', pourBody({ pump_asset_id: d1.mixer })).expect(400); // a mixer is not a pump
      const r = (await post('/v1/concrete/pours', pourBody()).expect(201)).body;
      await get(`/v1/concrete/pours/${r.id}`, B.access_token).expect(404);
      await get(`/v1/concrete/pours/${r.id}`, d1.token).expect(403);
      const list = (await get('/v1/concrete/pours').expect(200)).body.data;
      expect(list.find((p: { id: string }) => p.id === r.id).totals).toMatchObject({ loads: 3, assigned: 0 });
      expect((await get('/v1/concrete/pours', B.access_token).expect(200)).body.data).toEqual([]);
    });
  });

  describe('mixer driver: stages, ticket and completion', () => {
    let pour: { id: string; ref: string; loads: { task_id: string }[] };
    let load: string;
    beforeAll(async () => {
      pour = (await post('/v1/concrete/pours', pourBody()).expect(201)).body;
      load = pour.loads[0].task_id;
      await assign(load, d1);
    });

    it('the driver sees the ticket on the task', async () => {
      const t = (await get('/v1/driver/tasks', d1.token).expect(200)).body.data.find((x: { id: string }) => x.id === load);
      expect(t.ticket).toMatchObject({ ticket_no: `${pour.ref}-1`, signed: false, batched_at: null, mix_code: 'C35', site_ready: true });
      expect(t.has_proof).toBe(false);
    });
    it('stages go in order; batching starts the age clock', async () => {
      expect((await op(d1.token, { type: 'task_status', task_id: load, to_status: 'accepted' })).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'at_site' })).reason).toBe('invalid_stage'); // still accepted
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'picked_up' })).reason).toBe('not_supported'); // a delivery stage
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'loaded' }, ago(80))).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'loaded' })).reason).toBe('stage_already_recorded');
      expect((await op(d1.token, { type: 'task_status', task_id: load, to_status: 'in_progress' }, ago(75))).result).toBe('applied');
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'pour_start' })).reason).toBe('stage_out_of_order');
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'at_site' }, ago(60))).result).toBe('applied');
      const p = (await get(`/v1/concrete/pours/${pour.id}`).expect(200)).body;
      expect(p.state).toBe('in_progress');
      expect(p.loads[0].age_minutes).toBeGreaterThanOrEqual(80);
    });
    it('the board and exceptions show the waiting truck and the ageing load', async () => {
      const b = (await get('/v1/concrete/board').expect(200)).body;
      const m = b.mixers.find((x: { asset_id: string }) => x.asset_id === d1.mixer);
      expect(m).toMatchObject({ state: 'waiting', worker_name: 'فهد المطيري', ticket_no: `${pour.ref}-1`, age_level: 'warn' });
      expect(b.mixers.find((x: { asset_id: string }) => x.asset_id === d2.mixer).state).toBe('available');
      const e = (await get('/v1/concrete/exceptions').expect(200)).body;
      expect(e.age.map((x: { task_id: string }) => x.task_id)).toContain(load);
      expect(e.waiting.find((x: { task_id: string }) => x.task_id === load).wait_minutes).toBeGreaterThanOrEqual(59);
      expect(e.unassigned.map((x: { pour_ref: string }) => x.pour_ref)).toContain(pour.ref); // loads 2 and 3 due soon with no mixer
      expect((await get('/v1/concrete/board', B.access_token).expect(200)).body.mixers).toEqual([]);
    });
    it('no completion without a signed ticket; the ticket checks quantities and records waiting', async () => {
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'pour_start' }, ago(15))).result).toBe('applied');
      expect((await op(d1.token, { type: 'ticket', task_id: load, poured_m3: 9, signed_by: 'م. خالد' })).reason).toBe('stage_out_of_order'); // pour not ended
      expect((await op(d1.token, { type: 'milestone', task_id: load, code: 'pour_end' }, ago(2))).result).toBe('applied');
      expect((await op(d1.token, { type: 'task_status', task_id: load, to_status: 'completed' })).reason).toBe('proof_required');
      expect((await op(d1.token, { type: 'ticket', task_id: load, poured_m3: 8.5, returned_m3: 1, signed_by: 'م. خالد' })).reason).toBe('quantity_exceeds_load');
      await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), type: 'ticket', task_id: load, poured_m3: 8.555, signed_by: 'x' }] }, d1.token).expect(400);
      const sign = { client_op_id: randomUUID(), occurred_at: new Date().toISOString(), type: 'ticket', task_id: load, poured_m3: 8.5, returned_m3: 0.5, signed_by: 'م. خالد' };
      expect((await post('/v1/driver/sync', { ops: [sign] }, d1.token).expect(200)).body.results[0].result).toBe('applied');
      expect((await post('/v1/driver/sync', { ops: [sign] }, d1.token).expect(200)).body.results[0].result).toBe('duplicate');
      expect((await op(d1.token, { type: 'ticket', task_id: load, poured_m3: 9, signed_by: 'غيره' })).reason).toBe('already_signed');
      expect((await op(d1.token, { type: 'task_status', task_id: load, to_status: 'completed' })).result).toBe('applied');
      const t = (await get(`/v1/concrete/tasks/${load}`).expect(200)).body;
      expect(t.ticket).toMatchObject({ poured_m3: 8.5, returned_m3: 0.5, signed_by: 'م. خالد', wait_minutes: 45, status: 'completed' });
      expect(t.ticket.age_minutes).toBeGreaterThanOrEqual(77);
      expect(t.limits).toMatchObject({ max_age_minutes: 90, free_wait_minutes: 30 });
      // 45 min waiting, 30 free → 15 min charged = 0.25 h
      expect((await get(`/v1/tasks/${load}`).expect(200)).body.attributes.quantities).toEqual({ m3: 8.5, hour: 0.25 });
      const m = (await get('/v1/concrete/board').expect(200)).body.mixers.find((x: { asset_id: string }) => x.asset_id === d1.mixer);
      expect(m.state).toBe('returning');
    });
    it('review needs the signed ticket, then the invoice prices m³ and waiting', async () => {
      const second = pour.loads[1].task_id;
      await assign(second, d2);
      await op(d2.token, { type: 'task_status', task_id: second, to_status: 'accepted' });
      await op(d2.token, { type: 'milestone', task_id: second, code: 'loaded' }, ago(30));
      await op(d2.token, { type: 'task_status', task_id: second, to_status: 'in_progress' }, ago(29));
      // a failed load needs a concrete reason, not a delivery one
      expect((await op(d2.token, { type: 'task_status', task_id: second, to_status: 'failed', reason_code: 'recipient_absent' })).reason).toBe('invalid_reason');
      expect((await op(d2.token, { type: 'task_status', task_id: second, to_status: 'failed', reason_code: 'rejected_by_site', note: 'هبوط غير مطابق' })).result).toBe('applied');
      const v = (await get(`/v1/tasks/${load}`).expect(200)).body.version;
      await post(`/v1/tasks/${load}/review`, { version: v }).expect(200);
      const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10); // Kuwait date (UTC+3)
      const inv = (await post('/v1/invoices', { customer_id: customer, period_from: today, period_to: today }).expect(201)).body;
      const mine = inv.lines.filter((l: { task_id: string }) => l.task_id === load).map((l: { unit: string; amount: string }) => [l.unit, l.amount]).sort();
      expect(mine).toEqual([['hour', '2.500'], ['m3', '187.000']]); // 0.25 h × 10, 8.5 m³ × 22
    });
  });

  describe('quantity change, hold and cancel', () => {
    it('adjusting resizes, adds or cancels loads not yet batched, never below what is loaded', async () => {
      const p = (await post('/v1/concrete/pours', pourBody({ volume_m3: 18 })).expect(201)).body;
      await assign(p.loads[0].task_id, d2);
      let r = (await post(`/v1/concrete/pours/${p.id}/adjust`, { version: p.version, volume_m3: 30, reason: 'طلب المهندس زيادة' }).expect(200)).body;
      expect(r.loads.filter((l: { status: string }) => l.status !== 'canceled').map((l: { volume_m3: number }) => l.volume_m3)).toEqual([9, 9, 9, 3]);
      expect(r.loads[0].worker_id).toBe(d2.id); // the assigned mixer keeps its load
      await op(d2.token, { type: 'task_status', task_id: p.loads[0].task_id, to_status: 'accepted' });
      await op(d2.token, { type: 'milestone', task_id: p.loads[0].task_id, code: 'loaded' });
      await post(`/v1/concrete/pours/${p.id}/adjust`, { version: r.version, volume_m3: 5, reason: 'x' }).expect(409);
      r = (await post(`/v1/concrete/pours/${p.id}/adjust`, { version: r.version, volume_m3: 12.5, reason: 'تقليل' }).expect(200)).body;
      expect(r.volume_m3).toBe(12.5);
      expect(r.loads.filter((l: { status: string }) => l.status !== 'canceled').map((l: { volume_m3: number }) => l.volume_m3)).toEqual([9, 3.5]);
      expect(r.totals).toMatchObject({ loads: 2, dispatched_m3: 9 });
      await post(`/v1/concrete/pours/${p.id}/adjust`, { version: 1, volume_m3: 20, reason: 'x' }).expect(409); // stale version
      await post(`/v1/concrete/pours/${p.id}/adjust`, { version: r.version, volume_m3: 20 }).expect(400);   // reason required
    });
    it('site on hold and a new start time re-times loads', async () => {
      const p = (await post('/v1/concrete/pours', pourBody({ site: { name: 'موقع بلا دبوس' } })).expect(201)).body;
      let e = (await get('/v1/concrete/exceptions').expect(200)).body;
      expect(e.no_location.map((x: { pour_id: string }) => x.pour_id)).toContain(p.id);
      const later = new Date(Date.parse(p.scheduled_at) + 2 * 3_600_000).toISOString();
      const r = (await request(http).patch(`/v1/concrete/pours/${p.id}`).set(auth(A.access_token)).send({ version: p.version, site_ready: false, scheduled_at: later, site: { lat: 29.3, lng: 48 } }).expect(200)).body;
      expect(r.site_ready).toBe(false);
      expect(new Date(r.loads[0].planned_arrival).toISOString()).toBe(later);
      expect(Date.parse(r.loads[1].planned_arrival) - Date.parse(later)).toBe(18 * 60_000);
      e = (await get('/v1/concrete/exceptions').expect(200)).body;
      expect(e.holds.map((x: { pour_id: string }) => x.pour_id)).toContain(p.id);
      expect(e.no_location.map((x: { pour_id: string }) => x.pour_id)).not.toContain(p.id);
    });
    it('cancel cancels loads not yet batched and needs a reason', async () => {
      const p = (await post('/v1/concrete/pours', pourBody()).expect(201)).body;
      await post(`/v1/concrete/pours/${p.id}/cancel`, { version: p.version }).expect(400);
      const r = (await post(`/v1/concrete/pours/${p.id}/cancel`, { version: p.version, reason: 'أمطار' }).expect(200)).body;
      expect(r.state).toBe('canceled');
      expect(r.loads.every((l: { status: string }) => l.status === 'canceled')).toBe(true);
    });
  });

  describe('settings and reports', () => {
    it('settings are validated and change the plan', async () => {
      await request(http).put('/v1/concrete/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, age_warn_minutes: 100 }).expect(400);
      const s = (await request(http).put('/v1/concrete/settings').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, truck_capacity_m3: 10, free_wait_minutes: 20 }).expect(200)).body;
      expect(s).toMatchObject({ truck_capacity_m3: 10, free_wait_minutes: 20, max_age_minutes: 90 });
      const p = (await post('/v1/concrete/pours', pourBody({ volume_m3: 25 })).expect(201)).body;
      expect(p.loads.map((l: { volume_m3: number }) => l.volume_m3)).toEqual([10, 10, 5]);
      await request(http).put('/v1/concrete/settings').set(auth(B.access_token)).send({ legal_entity_id: A.legal_entity_id, truck_capacity_m3: 8 }).expect(400);
    });
    it('waiting report by customer', async () => {
      const r = (await get(`/v1/concrete/waiting?from=${ago(24 * 60)}&to=${new Date(Date.now() + 60_000).toISOString()}`).expect(200)).body;
      expect(r.customers[0]).toMatchObject({ customer_name: 'مقاولات الريم', loads: 1, wait_minutes: 45, billable_hours: 0.25, poured_m3: 8.5, returned_m3: 0.5 });
      await get('/v1/concrete/waiting?from=x&to=y').expect(400);
    });
  });
});
