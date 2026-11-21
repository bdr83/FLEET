/**
 * P5: live map, route replay and operational reports (JSON and CSV).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

(hasDb ? describe : describe.skip)('P5 live map and reports', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let d: { token: string; id: string };
  let asset: string;
  let shiftId: string;
  const range = () => `from=${encodeURIComponent(ago(24 * 60))}&to=${encodeURIComponent(ago(-24 * 60))}`;

  const sync = (task_id: string, to_status: string, note?: string) =>
    request(http).post('/v1/driver/sync').set(auth(d.token))
      .send({ ops: [{ type: 'task_status', client_op_id: randomUUID(), task_id, to_status, occurred_at: new Date().toISOString(), note }] }).expect(200);
  async function doneTask(from: string, to: string, outcome: 'completed' | 'failed') {
    const t = (await request(http).post('/v1/tasks').set(auth(A.access_token))
      .send({ legal_entity_id: A.legal_entity_id, sector_pack: 'delivery@1', window: { from, to } }).expect(201)).body;
    await request(http).post(`/v1/tasks/${t.id}/assign`).set(auth(A.access_token)).send({ version: 1, worker_id: d.id }).expect(200);
    await sync(t.id, 'accepted');
    await sync(t.id, 'in_progress');
    await sync(t.id, outcome, outcome === 'failed' ? 'مغلق' : undefined);
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'تقارير أ');
    B = await onboard(app, 'تقارير ب');
    const phone = newPhone();
    // the name starts with "=": CSV export must not turn it into a formula
    const w = await request(http).post('/v1/workers').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, kind: 'driver', display_name: '=سالم', phone }).expect(201);
    d = { token: (await joinAs(app, A.tenant.id, phone)).access_token, id: w.body.id };
    asset = (await request(http).post('/v1/assets').set(auth(A.access_token)).send({ legal_entity_id: A.legal_entity_id, asset_type: 'van', plate_no: `R-${Date.now()}`, odometer_km: 100 }).expect(201)).body.id;
    shiftId = (await request(http).post('/v1/driver/shifts').set(auth(d.token)).send({ client_op_id: randomUUID(), asset_id: asset, odometer_km: 100, started_at: ago(60) }).expect(201)).body.id;
    // three good points 0.01° of latitude apart (~1.11 km each) and one far-off point with poor accuracy
    await request(http).post('/v1/driver/locations').set(auth(d.token)).send({ points: [
      { recorded_at: ago(50), lat: 29.30, lng: 48.0, accuracy_m: 5, speed_mps: 10 },
      { recorded_at: ago(40), lat: 29.31, lng: 48.0, accuracy_m: 5, speed_mps: 12 },
      { recorded_at: ago(35), lat: 29.50, lng: 48.0, accuracy_m: 900 },
      { recorded_at: ago(30), lat: 29.32, lng: 48.0, accuracy_m: 5, speed_mps: 8, battery_pct: 70 },
    ] }).expect(200);
    await doneTask(ago(90), ago(-60), 'completed');   // on time
    await doneTask(ago(180), ago(120), 'completed');  // late
    await doneTask(ago(100), ago(-30), 'failed');
  });
  afterAll(async () => app?.close());

  describe('live map', () => {
    let serverTime: string;
    it('shows drivers on shift with their last position and current task state', async () => {
      const r = await request(http).get('/v1/map/live?stale_after=3600').set(auth(A.access_token)).expect(200);
      const me = r.body.drivers.find((x: { worker_id: string }) => x.worker_id === d.id);
      expect(me).toMatchObject({ shift_id: shiftId, lat: 29.32, lng: 48.0, battery_pct: 70, stale: false });
      serverTime = r.body.server_time;
      const strict = await request(http).get('/v1/map/live').set(auth(A.access_token)).expect(200);
      expect(strict.body.drivers.find((x: { worker_id: string }) => x.worker_id === d.id).stale).toBe(true);
    });
    it('since= returns only drivers that moved', async () => {
      const none = await request(http).get(`/v1/map/live?since=${encodeURIComponent(serverTime)}`).set(auth(A.access_token)).expect(200);
      expect(none.body.drivers).toEqual([]);
      await request(http).post('/v1/driver/locations').set(auth(d.token)).send({ points: [{ recorded_at: new Date(Date.now() + 1000).toISOString(), lat: 29.33, lng: 48.0 }] }).expect(200);
      const moved = await request(http).get(`/v1/map/live?since=${encodeURIComponent(serverTime)}`).set(auth(A.access_token)).expect(200);
      expect(moved.body.drivers.map((x: { worker_id: string }) => x.worker_id)).toEqual([d.id]);
    });
    it('other companies and drivers cannot see it', async () => {
      const r = await request(http).get('/v1/map/live').set(auth(B.access_token)).expect(200);
      expect(r.body.drivers).toEqual([]);
      await request(http).get('/v1/map/live').set(auth(d.token)).expect(403);
    });
  });

  describe('route replay', () => {
    it('returns the points and distance without the inaccurate jump', async () => {
      const r = await request(http).get(`/v1/shifts/${shiftId}/track`).set(auth(A.access_token)).expect(200);
      expect(r.body.points.length).toBe(5);
      expect(r.body.distance_km).toBeGreaterThan(3.2);   // 29.30 → 29.31 → 29.32 → 29.33 ≈ 3.33 km
      expect(r.body.distance_km).toBeLessThan(3.5);      // the 29.50 point would add ~40 km
      expect(r.body.max_kmh).toBe(43.2);
      expect(r.body.duration_min).toBeGreaterThanOrEqual(59);
      await request(http).get(`/v1/shifts/${shiftId}/track`).set(auth(B.access_token)).expect(404);
    });
  });

  describe('reports', () => {
    beforeAll(async () => {
      await request(http).post(`/v1/driver/shifts/${shiftId}/end`).set(auth(d.token)).send({ odometer_km: 130 }).expect(200);
    });
    it('tasks by day: outcomes, on-time rate and handling time', async () => {
      const r = await request(http).get(`/v1/reports/tasks?${range()}&group=day`).set(auth(A.access_token)).expect(200);
      const tot = r.body.data.reduce((s: Record<string, number>, x: Record<string, number>) => ({
        total: s.total + x.total, completed: s.completed + x.completed, failed: s.failed + x.failed }), { total: 0, completed: 0, failed: 0 });
      expect(tot).toEqual({ total: 3, completed: 2, failed: 1 });
    });
    it('tasks by driver', async () => {
      const r = await request(http).get(`/v1/reports/tasks?${range()}&group=worker`).set(auth(A.access_token)).expect(200);
      expect(r.body.data).toEqual([expect.objectContaining({ key: d.id, total: 3, completed: 2, failed: 1, on_time_pct: 50 })]);
      expect(r.body.data[0].avg_minutes).toBeGreaterThanOrEqual(0);
    });
    it('drivers: tasks, hours and GPS kilometres', async () => {
      const r = await request(http).get(`/v1/reports/drivers?${range()}`).set(auth(A.access_token)).expect(200);
      const me = r.body.data.find((x: { worker_id: string }) => x.worker_id === d.id);
      expect(me).toMatchObject({ completed: 2, failed: 1, on_time_pct: 50 });
      expect(me.km).toBeGreaterThan(3.2);
      expect(me.km).toBeLessThan(3.5);
      expect(me.shift_hours).toBeGreaterThan(0.95);
      expect(me.shift_hours).toBeLessThan(1.1);
    });
    it('fleet: hours, utilisation and odometer kilometres', async () => {
      const r = await request(http).get(`/v1/reports/fleet?${range()}`).set(auth(A.access_token)).expect(200);
      const v = r.body.data.find((x: { asset_id: string }) => x.asset_id === asset);
      expect(v).toMatchObject({ shifts: 1, km: 30 });
      expect(v.utilization_pct).toBeGreaterThan(1.9);   // ~1 h of 48 h
      expect(v.utilization_pct).toBeLessThan(2.3);
    });
    it('exports CSV that Excel opens in Arabic, without formula injection', async () => {
      const r = await request(http).get(`/v1/reports/drivers?${range()}&format=csv`).set(auth(A.access_token)).expect(200);
      expect(r.headers['content-type']).toContain('text/csv');
      expect(r.headers['content-disposition']).toContain('drivers.csv');
      expect(r.text.charCodeAt(0)).toBe(0xfeff);
      const lines = r.text.slice(1).trim().split('\r\n');
      expect(lines[0]).toBe('worker_id,name,completed,failed,on_time_pct,shift_hours,km');
      expect(lines[1]).toContain(",'=سالم,");
    });
    it('validates the range and permissions', async () => {
      await request(http).get('/v1/reports/tasks').set(auth(A.access_token)).expect(400);
      await request(http).get(`/v1/reports/tasks?from=${ago(0)}&to=${ago(60)}`).set(auth(A.access_token)).expect(400);
      await request(http).get(`/v1/reports/tasks?from=${ago(200 * 1440)}&to=${ago(0)}`).set(auth(A.access_token)).expect(400);
      await request(http).get(`/v1/reports/tasks?${range()}&group=planet`).set(auth(A.access_token)).expect(400);
      await request(http).get(`/v1/reports/tasks?${range()}&format=xml`).set(auth(A.access_token)).expect(400);
      await request(http).get(`/v1/reports/tasks?${range()}`).set(auth(d.token)).expect(403);
      const b = await request(http).get(`/v1/reports/drivers?${range()}`).set(auth(B.access_token)).expect(200);
      expect(b.body.data).toEqual([]);
    });
  });
});
