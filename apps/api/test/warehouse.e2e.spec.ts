/**
 * Warehousing (warehouse pack, sector 8): a 3PL company sets up a warehouse and locations, items for a customer, receives
 * goods with expiry against a notice, moves and counts stock, picks an order first-expiry-first-out, ships one as a
 * delivery task, cancels a picked one back into stock; exceptions and the report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createApp, hasDb, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('Warehouse pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string;
  let owner: string, other: string, wh: string;
  const loc: Record<string, string> = {};
  const item: Record<string, string> = {};
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const onHand = async (id: string) => (await get('/v1/warehouse/items').expect(200)).body.data.find((x: { id: string }) => x.id === id).on_hand;

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'مخازن الخليج', packs: ['warehouse', 'delivery'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id;
    owner = (await post('/v1/customers', { legal_entity_id: le, name: 'شركة الأغذية المتحدة' }).expect(201)).body.id;
    other = (await post('/v1/customers', { legal_entity_id: le, name: 'متجر آخر' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('warehouse, locations and items per owner', async () => {
    await get('/v1/freight/carriers').expect(403);
    wh = (await post('/v1/warehouse/warehouses', { legal_entity_id: le, code: 'shw1', name: 'مستودع الشويخ' }).expect(201)).body.id;
    await post('/v1/warehouse/warehouses', { legal_entity_id: le, code: 'SHW1', name: 'مكرر' }).expect(409);
    const l = (await post(`/v1/warehouse/warehouses/${wh}/locations`, { codes: ['a-01', 'A-02', 'A-01', 'B-01'] }).expect(201)).body;
    expect(l).toMatchObject({ added: 3, skipped: 0 });
    expect((await post(`/v1/warehouse/warehouses/${wh}/locations`, { codes: ['A-01', 'Q-01'], kind: 'quarantine' }).expect(201)).body).toMatchObject({ added: 1, skipped: 1 });
    for (const x of (await get('/v1/warehouse/warehouses').expect(200)).body.data[0].locations) loc[x.code] = x.id;
    item.MLK = (await post('/v1/warehouse/items', { legal_entity_id: le, customer_id: owner, sku: 'MLK', name: 'حليب', unit: 'carton', min_qty: 50, track_expiry: true }).expect(201)).body.id;
    item.RCE = (await post('/v1/warehouse/items', { legal_entity_id: le, customer_id: owner, sku: 'RCE', name: 'أرز', unit: 'bag' }).expect(201)).body.id;
    await post('/v1/warehouse/items', { legal_entity_id: le, customer_id: owner, sku: 'MLK', name: 'مكرر' }).expect(409);
    item.OTH = (await post('/v1/warehouse/items', { legal_entity_id: le, customer_id: other, sku: 'MLK', name: 'حليب متجر آخر' }).expect(201)).body.id;
  });

  it('receives goods with expiry against the notice, and reports the variance', async () => {
    const base = { warehouse_id: wh, customer_id: owner };
    await post('/v1/warehouse/receipts', { ...base, ref: 'X', lines: [{ item_id: item.MLK, qty: 10, location_id: loc['A-01'] }] }).expect(400); // expiry required
    await post('/v1/warehouse/receipts', { ...base, ref: 'X', lines: [{ item_id: item.OTH, qty: 10, location_id: loc['A-01'] }] }).expect(400); // other owner
    const r = (await post('/v1/warehouse/receipts', {
      ...base, ref: 'GRN-1', expected: [{ item_id: item.MLK, qty: 60 }, { item_id: item.RCE, qty: 20 }],
      lines: [
        { item_id: item.MLK, qty: 30, location_id: loc['A-01'], lot: 'L1', expiry: kwDay(10) },
        { item_id: item.MLK, qty: 25, location_id: loc['A-02'], lot: 'L2', expiry: kwDay(60) },
        { item_id: item.RCE, qty: 20, location_id: loc['B-01'] },
      ],
    }).expect(201)).body;
    expect(r.variance).toEqual([{ item_id: item.MLK, expected: 60, received: 55, diff: -5 }]);
    await post('/v1/warehouse/receipts', { ...base, ref: 'GRN-1', lines: [{ item_id: item.RCE, qty: 1, location_id: loc['B-01'] }] }).expect(409);
    expect(await onHand(item.MLK)).toBe(55);
    const s = (await get(`/v1/warehouse/stock?item_id=${item.MLK}`).expect(200)).body.data;
    expect(s.map((x: { location_code: string; qty: number }) => [x.location_code, x.qty])).toEqual([['A-01', 30], ['A-02', 25]]);
  });

  it('moves and counts stock', async () => {
    await post('/v1/warehouse/moves', { item_id: item.RCE, from_location_id: loc['B-01'], to_location_id: loc['A-02'], qty: 25 }).expect(409);
    await post('/v1/warehouse/moves', { item_id: item.RCE, from_location_id: loc['B-01'], to_location_id: loc['A-02'], qty: 5 }).expect(201);
    const c = (await post('/v1/warehouse/counts', { item_id: item.RCE, location_id: loc['B-01'], counted_qty: 14, reason: 'جرد شهري' }).expect(201)).body;
    expect(c).toMatchObject({ system: 15, counted: 14, diff: -1 });
    await post('/v1/warehouse/counts', { item_id: item.RCE, location_id: loc['B-01'], counted_qty: 14 }).expect(400); // reason
    expect(await onHand(item.RCE)).toBe(19);
  });

  let o1: string, o2: string;
  it('an order is picked first expiry first, all or nothing', async () => {
    o1 = (await post('/v1/warehouse/orders', { warehouse_id: wh, customer_id: owner, ref: 'SO-1', lines: [{ item_id: item.MLK, qty: 40 }, { item_id: item.RCE, qty: 4 }],
      ship_to: { name: 'سوبرماركت السلام', phone: '+96550003333', area: 'السالمية' } }).expect(201)).body.id;
    const d = (await get(`/v1/warehouse/orders/${o1}`).expect(200)).body;
    expect(d.plan.short).toEqual([]);
    expect(d.plan.picks.filter((p: { item_id: string }) => p.item_id === item.MLK).map((p: { location_code: string; qty: number }) => [p.location_code, p.qty])).toEqual([['A-01', 30], ['A-02', 10]]);
    o2 = (await post('/v1/warehouse/orders', { warehouse_id: wh, customer_id: owner, ref: 'SO-2', lines: [{ item_id: item.MLK, qty: 20 }] }).expect(201)).body.id;
    await post(`/v1/warehouse/orders/${o1}/pick`, {}).expect(200);
    const e = await post(`/v1/warehouse/orders/${o2}/pick`, {}).expect(409);
    expect(e.body.short).toEqual([{ item_id: item.MLK, qty: 5 }]);
    expect(await onHand(item.MLK)).toBe(15);
  });

  it('shipping makes a delivery task for our fleet; canceling a picked order puts the goods back', async () => {
    await post(`/v1/warehouse/orders/${o2}/ship`, {}).expect(409); // not picked
    const s = (await post(`/v1/warehouse/orders/${o1}/ship`, { delivery: true }).expect(200)).body;
    expect(s).toMatchObject({ status: 'shipped', delivery_status: 'ready' });
    const t = (await get(`/v1/tasks/${s.delivery_task_id}`).expect(200)).body;
    expect(t).toMatchObject({ sector_pack: 'delivery@1', customer_id: owner });
    expect(t.attributes).toMatchObject({ recipient: { phone: '+96550003333' }, external_order_id: 'SO-1', items_count: 44 });
    await post(`/v1/warehouse/orders/${o2}/cancel`, {}).expect(400);
    await post('/v1/warehouse/receipts', { warehouse_id: wh, customer_id: owner, ref: 'GRN-2', lines: [{ item_id: item.MLK, qty: 10, location_id: loc['A-02'], expiry: kwDay(90) }] }).expect(201);
    await post(`/v1/warehouse/orders/${o2}/pick`, {}).expect(200);
    expect(await onHand(item.MLK)).toBe(5);
    expect((await post(`/v1/warehouse/orders/${o2}/cancel`, { reason: 'العميل ألغى' }).expect(200)).body.status).toBe('canceled');
    expect(await onHand(item.MLK)).toBe(25);
  });

  it('exceptions: low stock, expiring stock, a short receipt; and the report', async () => {
    await post('/v1/warehouse/orders', { warehouse_id: wh, customer_id: owner, ref: 'SO-3', lines: [{ item_id: item.RCE, qty: 1 }], due_at: new Date(Date.now() - 60_000).toISOString() }).expect(201);
    const e = (await get('/v1/warehouse/exceptions').expect(200)).body;
    expect(e.low.map((x: { sku: string; on_hand: number }) => [x.sku, x.on_hand])).toContainEqual(['MLK', 25]);
    expect(e.late.map((x: { ref: string }) => x.ref)).toContain('SO-3');
    expect(e.variance[0]).toMatchObject({ ref: 'GRN-1', variance: [{ sku: 'MLK', diff: -5 }] });
    expect(e.expiring.length).toBe(0); // the 10-day lot was picked out
    const r = (await get(`/v1/warehouse/report?from=${kwDay()}&to=${kwDay()}`).expect(200)).body;
    const row = r.data.find((x: { customer_id: string }) => x.customer_id === owner);
    expect(row).toMatchObject({ customer_name: 'شركة الأغذية المتحدة', receipts: 2, units_in: 85, units_picked: 64, count_diff: -1, orders_shipped: 1, on_hand: 40 }); // milk 25 + rice 15
  });
});
