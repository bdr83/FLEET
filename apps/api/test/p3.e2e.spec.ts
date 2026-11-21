/**
 * P3: driver app backend: shifts, GPS ingest, own tasks and offline sync.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, newPhone, onboard } from './helpers';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

(hasDb ? describe : describe.skip)('P3 driver app and tracking', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let pool: Pool;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let driver: { token: string; workerId: string; phone: string };
  let assetId: string;

  /** Assignment has no API until P4 (dispatch); tests create it directly under the tenant's RLS context.
   *  Exclusive assignments of one worker may not overlap (no_worker_overlap), so each gets its own hour. */
  let slot = 0;
  async function assign(tenantId: string, taskId: string, workerId: string, status = 'assigned') {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.entity_ids', '', true)", [tenantId]);
      await c.query('UPDATE ops.task SET status = $2 WHERE id = $1', [taskId, status]);
      await c.query(`INSERT INTO ops.assignment (id, tenant_id, task_id, worker_id, period) VALUES ($1,$2,$3,$4,tstzrange(now() + make_interval(hours => $5), now() + make_interval(hours => $5 + 1)))`,
        [randomUUID(), tenantId, taskId, workerId, slot++]);
      await c.query('COMMIT');
    } finally { c.release(); }
  }
  async function newDriver(T: typeof A) {
    const phone = newPhone();
    const w = await request(http).post('/v1/workers').set(auth(T.access_token))
      .send({ legal_entity_id: T.legal_entity_id, kind: 'driver', display_name: 'سائق', phone }).expect(201);
    return { token: (await joinAs(app, T.tenant.id, phone)).access_token, workerId: w.body.id as string, phone };
  }
  async function newTask(T: typeof A) {
    return (await request(http).post('/v1/tasks').set(auth(T.access_token)).send({ legal_entity_id: T.legal_entity_id, sector_pack: 'delivery@1' }).expect(201)).body.id as string;
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    A = await onboard(app, 'توصيل أ');
    B = await onboard(app, 'توصيل ب');
    driver = await newDriver(A);
    assetId = (await request(http).post('/v1/assets').set(auth(A.access_token))
      .send({ legal_entity_id: A.legal_entity_id, asset_type: 'motorbike', plate_no: `P3-${Date.now()}`, odometer_km: 5000 }).expect(201)).body.id;
  });
  afterAll(async () => { await pool?.end(); await app?.close(); });

  describe('access', () => {
    it('a manager without a worker record cannot use driver endpoints', () =>
      request(http).get('/v1/driver/me').set(auth(A.access_token)).expect(403));
    it('a dispatcher lacks the driver permissions', async () => {
      const p = newPhone();
      await request(http).post('/v1/members').set(auth(A.access_token)).send({ phone: p, role_code: 'dispatcher' }).expect(201);
      const t = (await joinAs(app, A.tenant.id, p)).access_token;
      await request(http).get('/v1/driver/me').set(auth(t)).expect(403);
    });
    it('the driver sees their profile with no open shift', async () => {
      const r = await request(http).get('/v1/driver/me').set(auth(driver.token)).expect(200);
      expect(r.body.worker.id).toBe(driver.workerId);
      expect(r.body.open_shift).toBeNull();
    });
  });

  describe('shifts', () => {
    let shiftId: string;
    const op = randomUUID();
    it('GPS points before the shift starts are not stored (no tracking off shift)', async () => {
      const r = await request(http).post('/v1/driver/locations').set(auth(driver.token))
        .send({ points: [{ recorded_at: new Date().toISOString(), lat: 29.37, lng: 47.98 }] }).expect(200);
      expect(r.body).toMatchObject({ received: 1, stored: 0, outside_shift: 1 });
    });
    it('starts a shift on a vehicle and marks the vehicle in use', async () => {
      const r = await request(http).post('/v1/driver/shifts').set(auth(driver.token))
        .send({ client_op_id: op, asset_id: assetId, odometer_km: 5010, started_at: ago(30) }).expect(201);
      expect(r.body).toMatchObject({ asset_id: assetId, tracking_enabled: true, start_odometer_km: 5010, ended_at: null });
      shiftId = r.body.id;
      const asset = await request(http).get(`/v1/assets/${assetId}`).set(auth(A.access_token)).expect(200);
      expect(asset.body).toMatchObject({ status: 'in_use', odometer_km: 5010 });
    });
    it('retrying the same start returns the same shift', async () => {
      const r = await request(http).post('/v1/driver/shifts').set(auth(driver.token)).send({ client_op_id: op, asset_id: assetId }).expect(201);
      expect(r.body.id).toBe(shiftId);
    });
    it('a second open shift is refused', () =>
      request(http).post('/v1/driver/shifts').set(auth(driver.token)).send({ client_op_id: randomUUID() }).expect(409));
    it('another driver cannot take the same vehicle', async () => {
      const d2 = await newDriver(A);
      await request(http).post('/v1/driver/shifts').set(auth(d2.token)).send({ client_op_id: randomUUID(), asset_id: assetId }).expect(409);
    });
    it('a vehicle from another company is not found', async () => {
      const d = await newDriver(B);
      await request(http).post('/v1/driver/shifts').set(auth(d.token)).send({ client_op_id: randomUUID(), asset_id: assetId }).expect(404);
    });
    it('shows the open shift in /driver/me', async () => {
      const r = await request(http).get('/v1/driver/me').set(auth(driver.token)).expect(200);
      expect(r.body.open_shift.id).toBe(shiftId);
    });

    describe('GPS ingest', () => {
      it('stores points in the shift, ignores duplicates, and rejects bad clocks', async () => {
        const pts = [
          { recorded_at: ago(20), lat: 29.37, lng: 47.97, accuracy_m: 8, battery_pct: 80, source: 'bg' },
          { recorded_at: ago(10), lat: 29.38, lng: 47.98, speed_mps: 11.5, heading: 90 },
          { recorded_at: ago(60), lat: 29.30, lng: 47.90 },                                    // before the shift
          { recorded_at: new Date(Date.now() + 3_600_000).toISOString(), lat: 29.3, lng: 47.9 }, // device clock ahead
        ];
        const r = await request(http).post('/v1/driver/locations').set(auth(driver.token)).send({ points: pts }).expect(200);
        expect(r.body).toEqual({ received: 4, stored: 2, duplicates: 0, outside_shift: 1, out_of_window: 1 });
        const again = await request(http).post('/v1/driver/locations').set(auth(driver.token)).send({ points: pts.slice(0, 2) }).expect(200);
        expect(again.body).toMatchObject({ stored: 0, duplicates: 2 });
      });
      it('keeps the latest position even when an older backlog arrives later', async () => {
        await request(http).post('/v1/driver/locations').set(auth(driver.token)).send({ points: [{ recorded_at: ago(15), lat: 29.1, lng: 47.1 }] }).expect(200);
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.entity_ids', '', true)", [A.tenant.id]);
          const r = await c.query('SELECT ST_Y(position::geometry) AS lat, ST_X(position::geometry) AS lng FROM geo.last_position WHERE worker_id = $1', [driver.workerId]);
          expect(r.rows[0]).toEqual({ lat: 29.38, lng: 47.98 });
          const n = await c.query('SELECT count(*)::int AS n FROM geo.location_point WHERE worker_id = $1', [driver.workerId]);
          expect(n.rows[0].n).toBe(3);
          await c.query('COMMIT');
        } finally { c.release(); }
      });
      it('another company cannot read the points', async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.entity_ids', '', true)", [B.tenant.id]);
          const n = await c.query('SELECT count(*)::int AS n FROM geo.location_point WHERE worker_id = $1', [driver.workerId]);
          expect(n.rows[0].n).toBe(0);
          await c.query('COMMIT');
        } finally { c.release(); }
      });
      it('validates the batch', async () => {
        await request(http).post('/v1/driver/locations').set(auth(driver.token)).send({ points: [] }).expect(400);
        await request(http).post('/v1/driver/locations').set(auth(driver.token)).send({ points: [{ recorded_at: ago(1), lat: 99, lng: 47 }] }).expect(400);
        await request(http).post('/v1/driver/locations').set(auth(driver.token)).send({ points: [{ recorded_at: 'yesterday', lat: 29, lng: 47 }] }).expect(400);
        await request(http).post('/v1/driver/locations').set(auth(driver.token))
          .send({ points: Array.from({ length: 501 }, () => ({ recorded_at: ago(1), lat: 29, lng: 47 })) }).expect(400);
      });
    });

    it('ending the shift frees the vehicle; retry is safe; odometer cannot go back', async () => {
      await request(http).post(`/v1/driver/shifts/${shiftId}/end`).set(auth(driver.token)).send({ odometer_km: 5000 }).expect(400);
      const r = await request(http).post(`/v1/driver/shifts/${shiftId}/end`).set(auth(driver.token)).send({ odometer_km: 5042, ended_at: ago(5) }).expect(200);
      expect(r.body.ended_at).toBeTruthy();
      expect(r.body.end_odometer_km).toBe(5042);
      const again = await request(http).post(`/v1/driver/shifts/${shiftId}/end`).set(auth(driver.token)).send({}).expect(200);
      expect(again.body.ended_at).toBe(r.body.ended_at);
      const asset = await request(http).get(`/v1/assets/${assetId}`).set(auth(A.access_token)).expect(200);
      expect(asset.body).toMatchObject({ status: 'available', odometer_km: 5042 });
    });
    it('points recorded during the shift still sync after it ended; points after it do not', async () => {
      const r = await request(http).post('/v1/driver/locations').set(auth(driver.token))
        .send({ points: [{ recorded_at: ago(7), lat: 29.2, lng: 47.2, source: 'sync' }, { recorded_at: ago(2), lat: 29.2, lng: 47.2 }] }).expect(200);
      expect(r.body).toMatchObject({ stored: 1, outside_shift: 1 });
    });
    it('another driver cannot end my shift', async () => {
      const d2 = await newDriver(A);
      await request(http).post(`/v1/driver/shifts/${shiftId}/end`).set(auth(d2.token)).send({}).expect(404);
    });
  });

  describe('tasks and offline sync', () => {
    let t1: string;
    let t2: string;
    let other: string;
    beforeAll(async () => {
      t1 = await newTask(A);
      t2 = await newTask(A);
      other = await newTask(A);
      await assign(A.tenant.id, t1, driver.workerId);
      await assign(A.tenant.id, t2, driver.workerId);
    });
    const op = (task: string, to: string, extra: Record<string, unknown> = {}) =>
      ({ type: 'task_status', client_op_id: randomUUID(), task_id: task, to_status: to, occurred_at: ago(1), ...extra });

    it('lists only my assigned tasks', async () => {
      const r = await request(http).get('/v1/driver/tasks').set(auth(driver.token)).expect(200);
      expect(r.body.data.map((t: { id: string }) => t.id).sort()).toEqual([t1, t2].sort());
    });
    it('applies a queued sequence in order and reports each op', async () => {
      const ops = [op(t1, 'accepted'), op(t1, 'in_progress'), op(t1, 'completed'), op(t2, 'completed'), op(other, 'accepted'), op(t2, 'failed')];
      const r = await request(http).post('/v1/driver/sync').set(auth(driver.token)).send({ ops }).expect(200);
      expect(r.body.results.map((x: { result: string; reason?: string }) => [x.result, x.reason])).toEqual([
        ['applied', undefined], ['applied', undefined], ['applied', undefined],
        ['rejected', 'invalid_transition'], ['rejected', 'not_assigned_to_you'], ['rejected', 'invalid_transition'],
      ]);
      // re-sending the whole queue (lost response) changes nothing
      const again = await request(http).post('/v1/driver/sync').set(auth(driver.token)).send({ ops: ops.slice(0, 3) }).expect(200);
      expect(again.body.results.map((x: { result: string }) => x.result)).toEqual(['duplicate', 'duplicate', 'duplicate']);
      const task = await request(http).get(`/v1/tasks/${t1}`).set(auth(A.access_token)).expect(200);
      expect(task.body.status).toBe('completed');
    });
    it('a failed task needs a reason', async () => {
      await request(http).post('/v1/driver/sync').set(auth(driver.token)).send({ ops: [op(t2, 'accepted'), op(t2, 'in_progress')] }).expect(200);
      const r = await request(http).post('/v1/driver/sync').set(auth(driver.token)).send({ ops: [op(t2, 'failed'), op(t2, 'failed', { note: 'العميل لا يرد' })] }).expect(200);
      expect(r.body.results.map((x: { result: string; reason?: string }) => x.reason ?? x.result)).toEqual(['reason_required', 'applied']);
    });
    it('finished tasks leave the list', async () => {
      const r = await request(http).get('/v1/driver/tasks').set(auth(driver.token)).expect(200);
      expect(r.body.data).toEqual([]);
    });
    it('rejects malformed ops and stale clocks', async () => {
      await request(http).post('/v1/driver/sync').set(auth(driver.token)).send({ ops: [{ type: 'teleport' }] }).expect(400);
      const t3 = await newTask(A);
      await assign(A.tenant.id, t3, driver.workerId);
      const r = await request(http).post('/v1/driver/sync').set(auth(driver.token))
        .send({ ops: [op(t3, 'accepted', { occurred_at: new Date(Date.now() - 10 * 86_400_000).toISOString() })] }).expect(200);
      expect(r.body.results[0]).toMatchObject({ result: 'rejected', reason: 'bad_time' });
    });
    it('a suspended driver cannot sync', async () => {
      const d = await newDriver(A);
      await request(http).patch(`/v1/workers/${d.workerId}`).set(auth(A.access_token)).send({ status: 'suspended' }).expect(200);
      await request(http).post('/v1/driver/sync').set(auth(d.token)).send({ ops: [op(t1, 'accepted')] }).expect(403);
      await request(http).post('/v1/driver/shifts').set(auth(d.token)).send({ client_op_id: randomUUID() }).expect(403);
    });
  });
});
