/**
 * P2: vehicles, drivers, documents and expiry alerts.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

(hasDb ? describe : describe.skip)('P2 fleet and workforce', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let plateA: string;
  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'شركة أسطول أ');
    B = await onboard(app, 'شركة أسطول ب');
    plateA = `A-${Math.floor(Math.random() * 1e6)}`;
  });
  afterAll(async () => app?.close());

  describe('assets', () => {
    let assetId: string;
    it('creates a vehicle', async () => {
      const r = await request(http).post('/v1/assets').set(auth(A.access_token))
        .send({ legal_entity_id: A.legal_entity_id, asset_type: 'van', plate_no: plateA, make: 'Toyota', model: 'Hiace', year: 2022, odometer_km: 1000 })
        .expect(201);
      expect(r.body).toMatchObject({ asset_type: 'van', status: 'available', plate_no: plateA, odometer_km: 1000 });
      assetId = r.body.id;
    });
    it('rejects unknown type and missing legal entity', async () => {
      await request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, asset_type: 'spaceship' }).expect(400);
      await request(http).post('/v1/assets').set(auth(A.access_token)).send({ asset_type: 'van' }).expect(400);
    });
    it('rejects a duplicate plate in the same company', () =>
      request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, asset_type: 'car', plate_no: plateA }).expect(400));
    it('the same plate is fine in another company', () =>
      request(http).post('/v1/assets').set(auth(B.access_token)).send({ legal_entity_id: B.legal_entity_id, asset_type: 'car', plate_no: plateA }).expect(201));
    it('cannot use another company legal entity', () =>
      request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: B.legal_entity_id, asset_type: 'car' }).expect(400));
    it('lists and filters', async () => {
      await request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, asset_type: 'mixer', plate_no: `M-${Date.now()}` }).expect(201);
      const all = await request(http).get('/v1/assets').set(auth(A.access_token)).expect(200);
      expect(all.body.data.length).toBe(2);
      const mixers = await request(http).get('/v1/assets?type=mixer').set(auth(A.access_token)).expect(200);
      expect(mixers.body.data.map((x: { asset_type: string }) => x.asset_type)).toEqual(['mixer']);
      await request(http).get('/v1/assets?status=flying').set(auth(A.access_token)).expect(400);
    });
    it('odometer cannot go backwards', async () => {
      await request(http).patch(`/v1/assets/${assetId}`).set(auth(A.access_token)).send({ odometer_km: 900 }).expect(400);
      const r = await request(http).patch(`/v1/assets/${assetId}`).set(auth(A.access_token)).send({ odometer_km: 1500, status: 'out_of_service' }).expect(200);
      expect(r.body).toMatchObject({ odometer_km: 1500, status: 'out_of_service' });
    });
    it('another company gets 404, not the vehicle', async () => {
      await request(http).get(`/v1/assets/${assetId}`).set(auth(B.access_token)).expect(404);
      await request(http).patch(`/v1/assets/${assetId}`).set(auth(B.access_token)).send({ notes: 'x' }).expect(404);
      const r = await request(http).get('/v1/assets').set(auth(B.access_token)).expect(200);
      expect(r.body.data.map((x: { id: string }) => x.id)).not.toContain(assetId);
    });
    it('is written to the audit log', async () => {
      const r = await request(http).get('/v1/audit-log').set(auth(A.access_token)).expect(200);
      const actions = r.body.data.map((x: { action: string }) => x.action);
      expect(actions).toEqual(expect.arrayContaining(['asset.created', 'asset.updated']));
    });
  });

  describe('workers and driver access', () => {
    const phone = newPhone();
    let workerId: string;
    let driverToken: string;
    it('adding a driver with a phone lets them log in with the driver role', async () => {
      const r = await request(http).post('/v1/workers').set(auth(A.access_token))
        .send({ legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'سائق تجريبي', phone: phone.slice(4) })
        .expect(201);
      expect(r.body).toMatchObject({ kind: 'driver', status: 'active', phone });
      expect(r.body.user_id).toBeTruthy();
      workerId = r.body.id;
      driverToken = (await joinAs(app, A.tenant.id, phone)).access_token;
      const m = await request(http).get('/v1/members').set(auth(A.access_token)).expect(200);
      expect(m.body.data.find((x: { phone: string }) => x.phone === phone)?.role).toBe('driver');
    });
    it('a driver cannot read the fleet', () => request(http).get('/v1/assets').set(auth(driverToken)).expect(403));
    it('a dispatcher can read but not write', async () => {
      const p = newPhone();
      await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone: p, role_code: 'dispatcher' }).expect(201);
      const t = (await joinAs(app, A.tenant.id, p)).access_token;
      await request(http).get('/v1/workers').set(auth(t)).expect(200);
      await request(http).post('/v1/workers').set(auth(t)).send({ legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'x' }).expect(403);
    });
    it('one worker record per user', () =>
      request(http).post('/v1/workers').set(auth(A.access_token))
        .send({ legal_entity_id: A.legal_entity_id, kind: 'courier', display_name: 'مكرر', phone }).expect(400));
    it('rejects a bad phone', () =>
      request(http).post('/v1/workers').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'x', phone: '12' }).expect(400));
    it('marking a worker as left revokes their access', async () => {
      const r = await request(http).patch(`/v1/workers/${workerId}`).set(auth(A.access_token)).send({ status: 'left' }).expect(200);
      expect(r.body.status).toBe('left');
      await request(http).get('/v1/tasks').set(auth(driverToken)).expect(401);
    });
    it('another company cannot see the worker', () => request(http).get(`/v1/workers/${workerId}`).set(auth(B.access_token)).expect(404));
  });

  describe('documents and expiry alerts', () => {
    let assetId: string;
    let workerId: string;
    beforeAll(async () => {
      assetId = (await request(http).post('/v1/assets').set(auth(A.access_token))
        .send({ legal_entity_id: A.legal_entity_id, asset_type: 'truck', plate_no: `D-${Date.now()}` }).expect(201)).body.id;
      workerId = (await request(http).post('/v1/workers').set(auth(A.access_token))
        .send({ legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: 'صاحب رخصة' }).expect(201)).body.id;
    });
    it('needs exactly one owner', async () => {
      await request(http).post('/v1/documents').set(auth(A.access_token)).send({ doc_type: 'insurance' }).expect(400);
      await request(http).post('/v1/documents').set(auth(A.access_token)).send({ doc_type: 'insurance', asset_id: assetId, worker_id: workerId }).expect(400);
    });
    it('rejects an unknown type and a bad date', async () => {
      await request(http).post('/v1/documents').set(auth(A.access_token)).send({ doc_type: 'passport2', asset_id: assetId }).expect(400);
      await request(http).post('/v1/documents').set(auth(A.access_token)).send({ doc_type: 'insurance', asset_id: assetId, expires_on: '2026-13-40' }).expect(400);
    });
    it('cannot attach to another company vehicle', () =>
      request(http).post('/v1/documents').set(auth(B.access_token)).send({ doc_type: 'insurance', asset_id: assetId }).expect(404));
    it('lists expired and soon-expiring documents', async () => {
      const ins = await request(http).post('/v1/documents').set(auth(A.access_token))
        .send({ doc_type: 'insurance', asset_id: assetId, number: 'INS-1', expires_on: day(10) }).expect(201);
      expect(ins.body.legal_entity_id).toBe(A.legal_entity_id);
      await request(http).post('/v1/documents').set(auth(A.access_token))
        .send({ doc_type: 'driving_license', worker_id: workerId, expires_on: day(-3) }).expect(201);
      await request(http).post('/v1/documents').set(auth(A.access_token))
        .send({ doc_type: 'vehicle_registration', asset_id: assetId, expires_on: day(200) }).expect(201);
      const r = await request(http).get('/v1/documents/expiring?days=30').set(auth(A.access_token)).expect(200);
      expect(r.body.data.map((d: { doc_type: string; state: string; days_left: number }) => [d.doc_type, d.state, d.days_left]))
        .toEqual([['driving_license', 'expired', -3], ['insurance', 'expiring', 10]]);
      expect(r.body.data[1].plate_no).toBeTruthy();
      expect(r.body.data[0].worker_name).toBe('صاحب رخصة');
      const b = await request(http).get('/v1/documents/expiring').set(auth(B.access_token)).expect(200);
      expect(b.body.data).toEqual([]);
      await request(http).get('/v1/documents/expiring?days=-1').set(auth(A.access_token)).expect(400);
    });
    it('archiving removes a document from alerts', async () => {
      const list = await request(http).get(`/v1/documents?worker_id=${workerId}`).set(auth(A.access_token)).expect(200);
      await request(http).delete(`/v1/documents/${list.body.data[0].id}`).set(auth(A.access_token)).expect(204);
      await request(http).delete(`/v1/documents/${list.body.data[0].id}`).set(auth(A.access_token)).expect(404);
      const r = await request(http).get('/v1/documents/expiring').set(auth(A.access_token)).expect(200);
      expect(r.body.data.map((d: { doc_type: string }) => d.doc_type)).toEqual(['insurance']);
    });
  });

  describe('scope by legal entity (enforced in the database)', () => {
    it('a dispatcher scoped to one legal entity sees only its vehicles, drivers and documents', async () => {
      const le2 = (await request(http).post('/v1/legal-entities').set(auth(A.access_token)).send({ name: 'فرع السعودية', country: 'SA' }).expect(201)).body.id;
      const a2 = (await request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: le2, asset_type: 'pickup', plate_no: `S-${Date.now()}` }).expect(201)).body.id;
      const w2 = (await request(http).post('/v1/workers').set(auth(A.access_token)).send({ legal_entity_id: le2, kind: 'driver', display_name: 'سائق السعودية' }).expect(201)).body.id;
      await request(http).post('/v1/documents').set(auth(A.access_token)).send({ doc_type: 'insurance', asset_id: a2, expires_on: day(5) }).expect(201);
      const p = newPhone();
      await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone: p, role_code: 'dispatcher', scope_legal_entity_ids: [le2] }).expect(201);
      const t = (await joinAs(app, A.tenant.id, p)).access_token;
      const assets = await request(http).get('/v1/assets').set(auth(t)).expect(200);
      expect(assets.body.data.map((x: { id: string }) => x.id)).toEqual([a2]);
      const workers = await request(http).get('/v1/workers').set(auth(t)).expect(200);
      expect(workers.body.data.map((x: { id: string }) => x.id)).toEqual([w2]);
      const docs = await request(http).get('/v1/documents/expiring').set(auth(t)).expect(200);
      expect(docs.body.data.map((x: { asset_id: string }) => x.asset_id)).toEqual([a2]);
      // a vehicle in the head-office entity is invisible to them
      const own = await request(http).get('/v1/assets').set(auth(A.access_token)).expect(200);
      const other = own.body.data.find((x: { legal_entity_id: string }) => x.legal_entity_id === A.legal_entity_id).id;
      await request(http).get(`/v1/assets/${other}`).set(auth(t)).expect(404);
    });
  });
});
