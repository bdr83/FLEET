/**
 * Courier and express (courier pack, sector 4): a company with only this pack sets up hubs, books parcels with waybills
 * (each a delivery task), scans them through hubs, the driver delivers one with the PIN and COD, another fails twice and
 * goes out again until it is returned to the shipper; exceptions and the KPIs report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Courier pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string;
  let driver: { token: string; id: string };
  let shipper: string;
  const hubs: Record<string, string> = {};
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  async function op(o: Record<string, unknown>) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: randomUUID(), occurred_at: new Date().toISOString(), ...o }] }, driver.token).expect(200)).body.results[0];
  }
  const scan = (event: string, hub: string, awbs: string[], extra: Record<string, unknown> = {}) => post('/v1/courier/scans', { event, hub_id: hubs[hub], awbs, ...extra }).expect(200).then((r) => r.body.results);
  async function assign(taskId: string) {
    const t = (await get(`/v1/tasks/${taskId}`).expect(200)).body;
    await post(`/v1/tasks/${taskId}/assign`, { version: t.version, worker_id: driver.id }).expect(200);
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'البريد السريع', packs: ['courier'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const phone = newPhone();
    const w = (await post('/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فهد المندوب', phone }).expect(201)).body;
    driver = { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    shipper = (await post('/v1/customers', { legal_entity_id: le, name: 'متجر الأناقة' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('hubs; other packs stay closed but the delivery desk opens', async () => {
    await get('/v1/freight/settings?legal_entity_id=' + le).expect(403);
    await get('/v1/delivery/exceptions').expect(200);
    for (const [code, name] of [['KWI', 'محطة الشويخ'], ['AHM', 'محطة الأحمدي']]) hubs[code] = (await post('/v1/courier/hubs', { legal_entity_id: le, code, name }).expect(201)).body.id;
    await post('/v1/courier/hubs', { legal_entity_id: le, code: 'kwi', name: 'مكرر' }).expect(409);
    await post('/v1/courier/hubs', { legal_entity_id: le, code: 'K W', name: 'خطأ' }).expect(400);
  });

  let a1: { task_id: string; awb: string }, a2: { task_id: string; awb: string };
  it('books parcels: a waybill, a due time by service, received at the origin hub', async () => {
    const base = { legal_entity_id: le, customer_id: shipper, recipient: { name: 'نورة', phone: '+96550001111' }, dropoff: { area: 'الفحيحيل', block: '3' }, origin_hub_id: hubs.KWI, dest_hub_id: hubs.AHM };
    await post('/v1/courier/parcels', { ...base, recipient: { name: 'x' } }).expect(400);
    await post('/v1/courier/parcels', { ...base, customer_id: undefined, cod_amount: '5' }).expect(400);
    await post('/v1/courier/parcels', { ...base, service: 'rocket' }).expect(400);
    a1 = (await post('/v1/courier/parcels', { ...base, awb: 'tst-0001', service: 'same_day', pieces: 2, weight_kg: 3.5, cod_amount: '12.500', delivery_fee: '1.500' }).expect(201)).body;
    expect(a1).toMatchObject({ awb: 'TST-0001', service: 'same_day', pieces: 2, weight_kg: 3.5, where: 'at_hub', current_hub: 'KWI', attempts: 0, status: 'ready', shipper_name: 'متجر الأناقة' });
    expect(new Date((a1 as unknown as { due_at: string }).due_at).toISOString()).toBe(new Date(`${kwDay()}T23:59:00+03:00`).toISOString());
    await post('/v1/courier/parcels', { ...base, awb: 'TST-0001' }).expect(409);
    a2 = (await post('/v1/courier/parcels', { ...base, service: 'express', max_attempts: 2 }).expect(201)).body;
    expect(a2.awb).toMatch(/^KW\d{10}$/);
    const t = (await get(`/v1/tasks/${a1.task_id}`).expect(200)).body;
    expect(t).toMatchObject({ sector_pack: 'delivery@1', ref: 'TST-0001', customer_id: shipper });
    expect(t.attributes).toMatchObject({ awb: 'TST-0001', pieces: 2, attempt: 1, max_attempts: 3, cod_amount: '12.500', address: 'الفحيحيل، ق 3' });
    expect((await get('/v1/courier/parcels/tst-0001').expect(200)).body.scans.map((s: { event: string; hub: string }) => [s.event, s.hub])).toEqual([['received', 'KWI']]);
  });

  it('hub scans in a batch: line by line, unknown waybills reported', async () => {
    const r = await scan('dispatched', 'KWI', [a1.awb, a2.awb, 'NOPE-1']);
    expect(r.map((x: { result: string; reason?: string }) => x.reason ?? x.result)).toEqual(['applied', 'applied', 'unknown_awb']);
    expect((await get(`/v1/courier/parcels/${a1.task_id}`).expect(200)).body.where).toBe('in_transit');
    await scan('arrived', 'AHM', [a1.awb, a2.awb]);
    const p = (await get(`/v1/courier/parcels?hub_id=${hubs.AHM}`).expect(200)).body.data;
    expect(p.map((x: { awb: string }) => x.awb).sort()).toEqual([a1.awb, a2.awb].sort());
    expect((await get('/v1/courier/hubs').expect(200)).body.data.find((h: { code: string }) => h.code === 'AHM').parcels_here).toBe(2);
  });

  it('delivered with the PIN and cash on delivery', async () => {
    await assign(a1.task_id);
    await op({ type: 'task_status', task_id: a1.task_id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: a1.task_id, to_status: 'in_progress' });
    expect((await scan('sorted', 'AHM', [a1.awb]))[0]).toMatchObject({ result: 'rejected', reason: 'with_driver' });
    const pin = (await get(`/v1/delivery/tasks/${a1.task_id}`).expect(200)).body.link.pin;
    expect(await op({ type: 'pod', task_id: a1.task_id, method: 'pin', pin })).toMatchObject({ result: 'applied' });
    await post('/v1/driver/cod', { client_op_id: randomUUID(), task_id: a1.task_id, amount: '12.500' }, driver.token).expect(201);
    expect(await op({ type: 'task_status', task_id: a1.task_id, to_status: 'completed' })).toMatchObject({ result: 'applied' });
    expect((await get(`/v1/courier/parcels/${a1.awb}`).expect(200)).body).toMatchObject({ where: 'delivered', cod_collected: '12.500' });
    expect((await scan('received', 'AHM', [a1.awb]))[0].reason).toBe('closed');
  });

  it('a failed attempt comes back to the hub and goes out again; at the last attempt it goes back to the shipper', async () => {
    const attempt = async () => {
      await assign(a2.task_id);
      await op({ type: 'task_status', task_id: a2.task_id, to_status: 'accepted' });
      await op({ type: 'task_status', task_id: a2.task_id, to_status: 'in_progress' });
      expect(await op({ type: 'task_status', task_id: a2.task_id, to_status: 'failed', reason_code: 'recipient_absent' })).toMatchObject({ result: 'applied' });
    };
    await attempt();
    expect((await get('/v1/courier/exceptions').expect(200)).body.awaiting_return.map((x: { awb: string }) => x.awb)).toContain(a2.awb);
    expect((await scan('received', 'AHM', [a2.awb]))[0].reason).toBe('awaiting_return');
    expect((await scan('returned', 'AHM', [a2.awb]))[0]).toMatchObject({ result: 'applied', reopened: true });
    let p = (await get(`/v1/courier/parcels/${a2.awb}`).expect(200)).body;
    expect(p).toMatchObject({ status: 'ready', attempts: 1, where: 'at_hub', current_hub: 'AHM' });
    expect(p.attributes.attempt).toBe(2);
    expect(p.events.find((e: { to_status: string }) => e.to_status === 'failed')).toMatchObject({ reason_code: 'recipient_absent', driver_name: 'فهد المندوب' });
    await attempt();
    expect((await scan('rto_out', 'AHM', [a2.awb]))[0].reason).toBe('not_rto');
    expect((await scan('returned', 'AHM', [a2.awb]))[0]).toMatchObject({ result: 'applied', rto: true });
    p = (await get(`/v1/courier/parcels/${a2.awb}`).expect(200)).body;
    expect(p).toMatchObject({ status: 'failed', attempts: 2, where: 'at_hub' });
    expect(p.rto_at).toBeTruthy();
    expect((await get('/v1/courier/exceptions').expect(200)).body.rto_pending.map((x: { awb: string }) => x.awb)).toContain(a2.awb);
    await scan('dispatched', 'AHM', [a2.awb]);
    await scan('arrived', 'KWI', [a2.awb]);
    expect((await scan('rto_out', 'KWI', [a2.awb], { note: 'سُلّمت لمندوب المتجر' }))[0].result).toBe('applied');
    p = (await get(`/v1/courier/parcels/${a2.awb}`).expect(200)).body;
    expect(p.where).toBe('rto_done');
    expect(p.scans.map((s: { event: string }) => s.event)).toEqual(['received', 'dispatched', 'arrived', 'returned', 'returned', 'dispatched', 'arrived', 'rto_out']);
    const ex = (await get('/v1/courier/exceptions').expect(200)).body;
    expect([...ex.rto_pending, ...ex.awaiting_return].map((x: { awb: string }) => x.awb)).not.toContain(a2.awb);
    expect((await get('/v1/delivery/exceptions').expect(200)).body.returns.map((x: { id: string }) => x.id)).not.toContain(a2.task_id);
  });

  it('report: delivery, first attempt, on time, RTO and COD per service and shipper', async () => {
    await get('/v1/courier/report?from=2026-01-01').expect(400);
    const r = (await get(`/v1/courier/report?from=${kwDay()}&to=${kwDay()}`).expect(200)).body;
    expect(r.totals).toMatchObject({ parcels: 2, delivered: 1, rto: 1, failed_attempts: 2, delivery_pct: 50, first_attempt_pct: 100, on_time_pct: 100, rto_pct: 50, cod_collected: '12.500' });
    expect(r.services.map((s: { service: string; parcels: number }) => [s.service, s.parcels])).toEqual([['express', 1], ['same_day', 1]]);
    expect(r.shippers[0]).toMatchObject({ name: 'متجر الأناقة', parcels: 2, cod_collected: '12.500' });
  });
});
