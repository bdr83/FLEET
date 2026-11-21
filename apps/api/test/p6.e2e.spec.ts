/**
 * P6: customers, sites, contracts with frozen price lists, task ↔ contract link, and the customer portal.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);
const shiftDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

(hasDb ? describe : describe.skip)('P6 customers and contracts', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let cust: { id: string };
  let other: { id: string };
  let site: string;
  let contract: string;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'عقود أ');
    B = await onboard(app, 'عقود ب');
  });
  afterAll(async () => app?.close());

  describe('customers and sites', () => {
    it('creates a customer with a normalised phone', async () => {
      const r = await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'مطعم الخليج', phone: '51234567', ref: 'CU-1', payment_terms_days: 30, credit_limit: '500.000' }).expect(201);
      expect(r.body).toMatchObject({ name: 'مطعم الخليج', phone: '+96551234567', status: 'active', credit_limit: '500.000' });
      cust = r.body;
      other = (await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'شركة البناء الحديث' }).expect(201)).body;
    });
    it('validates input and rejects a duplicate ref', async () => {
      await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'x', ref: 'CU-1' }).expect(400);
      await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'x', email: 'not-an-email' }).expect(400);
      await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'x', credit_limit: '1.2345' }).expect(400);
      await post('/v1/customers', { legal_entity_id: B.legal_entity_id, name: 'x' }).expect(400);
    });
    it('searches by name and phone', async () => {
      const r = await request(http).get('/v1/customers?q=الخليج').set(auth(A.access_token)).expect(200);
      expect(r.body.data.map((x: { id: string }) => x.id)).toEqual([cust.id]);
      const p = await request(http).get('/v1/customers?q=1234567').set(auth(A.access_token)).expect(200);
      expect(p.body.data.map((x: { id: string }) => x.id)).toEqual([cust.id]);
      const pct = await request(http).get('/v1/customers?q=%25').set(auth(A.access_token)).expect(200);
      expect(pct.body.data).toEqual([]); // "%" is a literal, not a wildcard
    });
    it('adds a site with coordinates and returns it with the customer', async () => {
      site = (await post(`/v1/customers/${cust.id}/sites`, { name: 'فرع السالمية', address: 'شارع سالم المبارك', lat: 29.335, lng: 48.076, contact_phone: '99887766' }).expect(201)).body.id;
      const r = await request(http).get(`/v1/customers/${cust.id}`).set(auth(A.access_token)).expect(200);
      expect(r.body.sites).toEqual([expect.objectContaining({ id: site, lat: 29.335, lng: 48.076, contact_phone: '+96599887766' })]);
      expect(r.body.active_contract).toBeNull();
    });
    it('isolation and permissions', async () => {
      await request(http).get(`/v1/customers/${cust.id}`).set(auth(B.access_token)).expect(404);
      await request(http).patch(`/v1/sites/${site}`).set(auth(B.access_token)).send({ name: 'x' }).expect(404);
      const p = newPhone();
      await post('/v1/members', { phone: p, role_code: 'dispatcher' }).expect(201);
      const t = (await joinAs(app, A.tenant.id, p)).access_token;
      await request(http).get('/v1/customers').set(auth(t)).expect(200);
      await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'x' }, t).expect(403);
    });
    it('a user scoped to another legal entity cannot see or change these customers', async () => {
      const le2 = (await post('/v1/legal-entities', { name: 'شركة ثانية' }).expect(201)).body.id;
      const p = newPhone();
      await post('/v1/members', { phone: p, role_code: 'admin', scope_legal_entity_ids: [le2] }).expect(201);
      const t = (await joinAs(app, A.tenant.id, p)).access_token;
      const r = await request(http).get('/v1/customers').set(auth(t)).expect(200);
      expect(r.body.data).toEqual([]);
      await request(http).patch(`/v1/sites/${site}`).set(auth(t)).send({ name: 'تغيير' }).expect(404);
    });
  });

  describe('contracts', () => {
    it('creates a draft with a price list', async () => {
      const r = await post('/v1/contracts', {
        customer_id: cust.id, code: 'K-2026-01', starts_on: shiftDays(-10), payment_terms_days: 15,
        rates: [
          { unit: 'task', price: '1.250', sector_pack: 'delivery@1', description: 'توصيل داخل المدينة' },
          { unit: 'km', price: 0.1, included_qty: 5 },
        ],
      }).expect(201);
      expect(r.body).toMatchObject({ status: 'draft', currency: 'KWD', payment_terms_days: 15, customer_name: 'مطعم الخليج' });
      expect(r.body.rates).toHaveLength(2);
      contract = r.body.id;
    });
    it('quotes a task from the price list', async () => {
      const r = await post(`/v1/contracts/${contract}/quote`, { sector_pack: 'delivery@1', quantities: { task: 1, km: 12 } }).expect(200);
      expect(r.body).toMatchObject({ currency: 'KWD', total: '1.950', unpriced: [] });
      await post(`/v1/contracts/${contract}/quote`, { sector_pack: 'delivery@1', quantities: { parsec: 1 } }).expect(400);
    });
    it('a contract without prices cannot be activated', async () => {
      const k = (await post('/v1/contracts', { customer_id: other.id, starts_on: today() }).expect(201)).body;
      await post(`/v1/contracts/${k.id}/activate`, {}).expect(409);
    });
    it('activates, then freezes prices and terms', async () => {
      const r = await post(`/v1/contracts/${contract}/activate`, {}).expect(200);
      expect(r.body.status).toBe('active');
      await post(`/v1/contracts/${contract}/rates`, { unit: 'hour', price: '5' }).expect(409);
      await request(http).delete(`/v1/contracts/${contract}/rates/${r.body.rates[0].id}`).set(auth(A.access_token)).expect(409);
      await request(http).patch(`/v1/contracts/${contract}`).set(auth(A.access_token)).send({ payment_terms_days: 60 }).expect(409);
      const c = await request(http).get(`/v1/customers/${cust.id}`).set(auth(A.access_token)).expect(200);
      expect(c.body.active_contract.id).toBe(contract);
    });
    it('a second active contract in overlapping dates is refused', async () => {
      const k = (await post('/v1/contracts', { customer_id: cust.id, starts_on: shiftDays(5), rates: [{ unit: 'task', price: '2' }] }).expect(201)).body;
      await post(`/v1/contracts/${k.id}/activate`, {}).expect(409);
    });
    it('other companies cannot read it', () => request(http).get(`/v1/contracts/${contract}`).set(auth(B.access_token)).expect(404));
  });

  describe('tasks linked to customers', () => {
    it('a customer task is linked to the active contract', async () => {
      const r = await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', customer_id: cust.id, site_id: site }).expect(201);
      expect(r.body).toMatchObject({ customer_id: cust.id, customer_name: 'مطعم الخليج', site_id: site, contract_id: contract });
    });
    it('no active contract: the task is created without one', async () => {
      const r = await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'concrete@1', customer_id: other.id }).expect(201);
      expect(r.body.contract_id).toBeNull();
    });
    it('rejects a site of another customer and a customer on hold', async () => {
      await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', customer_id: other.id, site_id: site }).expect(400);
      await request(http).patch(`/v1/customers/${other.id}`).set(auth(A.access_token)).send({ status: 'on_hold' }).expect(200);
      await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', customer_id: other.id }).expect(409);
      await request(http).patch(`/v1/customers/${other.id}`).set(auth(A.access_token)).send({ status: 'active' }).expect(200);
    });
  });

  describe('customer portal', () => {
    let portal: string;
    let reqId: string;
    beforeAll(async () => {
      const p = newPhone();
      await post('/v1/members', { phone: p, role_code: 'customer' }).expect(400); // must name the customer
      await post('/v1/members', { phone: p, role_code: 'customer', customer_id: cust.id }).expect(201);
      portal = (await joinAs(app, A.tenant.id, p)).access_token;
    });
    it('sees its own profile and sites only', async () => {
      const r = await request(http).get('/v1/portal/me').set(auth(portal)).expect(200);
      expect(r.body).toMatchObject({ id: cust.id, name: 'مطعم الخليج' });
      expect(r.body.sites.map((s: { id: string }) => s.id)).toEqual([site]);
    });
    it('cannot use staff endpoints', async () => {
      await request(http).get('/v1/tasks').set(auth(portal)).expect(403);
      await request(http).get('/v1/customers').set(auth(portal)).expect(403);
      await request(http).get('/v1/portal/me').set(auth(A.access_token)).expect(403); // the owner is not a customer account
    });
    it('submits a request that arrives as a draft for the operator', async () => {
      const r = await post('/v1/portal/tasks', { sector_pack: 'delivery@1', site_id: site, attributes: { items: 3 }, ref: 'PO-77' }, portal).expect(201);
      expect(r.body).toMatchObject({ status: 'draft', site_id: site });
      reqId = r.body.id;
      const staff = await request(http).get(`/v1/tasks/${reqId}`).set(auth(A.access_token)).expect(200);
      expect(staff.body).toMatchObject({ customer_id: cust.id, contract_id: contract });
      await post('/v1/portal/tasks', { sector_pack: 'delivery@1', site_id: randomUUID() }, portal).expect(400);
    });
    it('lists only its own tasks and cannot open another customer task', async () => {
      const r = await request(http).get('/v1/portal/tasks').set(auth(portal)).expect(200);
      expect(r.body.data.length).toBeGreaterThan(0);
      const otherTask = (await post('/v1/tasks', { legal_entity_id: A.legal_entity_id, sector_pack: 'concrete@1', customer_id: other.id }).expect(201)).body.id;
      expect(r.body.data.map((x: { id: string }) => x.id)).not.toContain(otherTask);
      await request(http).get(`/v1/portal/tasks/${otherTask}`).set(auth(portal)).expect(404);
      await post(`/v1/portal/tasks/${otherTask}/cancel`, {}, portal).expect(404);
    });
    it('shows the driver only once the job is underway', async () => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'فهد', phone }).expect(201)).body;
      const dTok = (await joinAs(app, A.tenant.id, phone)).access_token;
      await post(`/v1/tasks/${reqId}/publish`, { version: 1 }).expect(200);
      await post(`/v1/tasks/${reqId}/assign`, { version: 2, worker_id: w.id }).expect(200);
      let t = (await request(http).get(`/v1/portal/tasks/${reqId}`).set(auth(portal)).expect(200)).body;
      expect(t.driver_name).toBeNull();
      await post(`/v1/portal/tasks/${reqId}/cancel`, {}, portal).expect(409); // already assigned
      await post('/v1/driver/sync', { ops: [{ type: 'task_status', client_op_id: randomUUID(), task_id: reqId, to_status: 'accepted', occurred_at: new Date().toISOString() }] }, dTok).expect(200);
      t = (await request(http).get(`/v1/portal/tasks/${reqId}`).set(auth(portal)).expect(200)).body;
      expect(t.driver_name).toBe('فهد');
      expect(t.events.map((e: { to_status: string }) => e.to_status)).toEqual(['ready', 'assigned', 'accepted']);
      expect(t.events[0]).not.toHaveProperty('actor_id');
    });
    it('can cancel a request before assignment', async () => {
      const r = await post('/v1/portal/tasks', { sector_pack: 'delivery@1' }, portal).expect(201);
      const c = await post(`/v1/portal/tasks/${r.body.id}/cancel`, { reason: 'طلب مكرر' }, portal).expect(200);
      expect(c.body.status).toBe('canceled');
    });
  });
});
