/**
 * School transport (school pack, sector 10): routes with a school, stops, a bus, driver and attendant; students with a
 * guardian's phone; daily trips booking the bus and driver and, on a second task, the attendant; the attendant marks
 * students boarded, absent or dropped from the app; a young child going home is handed to a named adult; a trip cannot
 * close with a child on the bus or a student unmarked; absence notices; exceptions and the per-school report.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { auth, createApp, hasDb, joinAs, login, newPhone } from './helpers';

(hasDb ? describe : describe.skip)('School transport pack', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let T: string, le: string, tenant: string, school: string, bus: string;
  let driver: { token: string; id: string }, attendant: { token: string; id: string };
  let home: { id: string; version: number }, kids: { id: string; name: string; handover: boolean }[], tripId: string;
  const post = (path: string, body: Record<string, unknown>, token = T) => request(http).post(path).set(auth(token)).send(body);
  const patch = (path: string, body: Record<string, unknown>, token = T) => request(http).patch(path).set(auth(token)).send(body);
  const get = (path: string, token = T) => request(http).get(path).set(auth(token));
  const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const ALL = [1, 2, 3, 4, 5, 6, 7];
  const stops = [{ name: 'مدرسة النور', area: 'السالمية' }, { name: 'الجابرية ق 5', offset_min: 15 }, { name: 'مشرف ق 3', offset_min: 30 }];
  async function op(o: Record<string, unknown>, token = attendant.token, id = randomUUID()) {
    return (await post('/v1/driver/sync', { ops: [{ client_op_id: id, occurred_at: new Date().toISOString(), ...o }] }, token).expect(200)).body.results[0];
  }

  beforeAll(async () => {
    app = await createApp();
    http = app.getHttpServer();
    const { user_token } = await login(app, newPhone());
    const co = (await request(http).post('/v1/tenants').set(auth(user_token)).send({ name: 'باصات المدارس', packs: ['school'] }).expect(201)).body;
    T = co.access_token; le = co.legal_entity_id; tenant = co.tenant.id;
    const worker = async (kind: string, name: string) => {
      const phone = newPhone();
      const w = (await post('/v1/workers', { legal_entity_id: le, kind, display_name: name, phone }).expect(201)).body;
      return { token: (await joinAs(app, tenant, phone)).access_token, id: w.id };
    };
    driver = await worker('driver', 'أبو فهد');
    attendant = await worker('supervisor', 'أم سارة');
    bus = (await post('/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `SC-${Date.now() % 100000}`, capacity: { seats: 24 } }).expect(201)).body.id;
    school = (await post('/v1/customers', { legal_entity_id: le, name: 'مدرسة النور الخاصة', kind: 'business' }).expect(201)).body.id;
  });
  afterAll(async () => app?.close());

  it('a route home from school with an attendant, and its students', async () => {
    const base = { legal_entity_id: le, customer_id: school, school_name: 'مدرسة النور', name: 'النور ← الجابرية ومشرف', direction: 'from_school', depart_time: '13:00', duration_min: 45,
      days: ALL, stops, asset_id: bus, driver_worker_id: driver.id, attendant_worker_id: attendant.id, capacity: 24 };
    await post('/v1/school/routes', { ...base, code: 'N1', attendant_worker_id: driver.id }).expect(400);
    await post('/v1/school/routes', { ...base, code: 'N1', school_name: undefined }).expect(400);
    const r = (await post('/v1/school/routes', { ...base, code: 'n1' }).expect(201)).body;
    expect(r).toMatchObject({ code: 'N1', school_name: 'مدرسة النور', driver_name: 'أبو فهد', attendant_name: 'أم سارة', students: 0 });
    home = { id: r.id, version: r.version };
    await post(`/v1/school/routes/${r.id}/students`, { students: [{ name: 'x', stop_seq: 2 }] }).expect(400); // guardian's phone required
    const add = (await post(`/v1/school/routes/${r.id}/students`, { students: [
      { name: 'سارة', grade: 'KG2', stop_seq: 2, guardian_name: 'أم سارة', guardian_phone: '+96599001111' },
      { name: 'عبدالله', grade: '6', stop_seq: 2, guardian_phone: '+96599002222' },
      { name: 'نورة', grade: '8', stop_seq: 3, guardian_phone: '+96599003333', note: 'حساسية فول سوداني' },
    ] }).expect(201)).body;
    expect(add.added).toBe(3);
    kids = (await get(`/v1/school/routes/${r.id}/students`).expect(200)).body.data;
    expect(kids.map((x) => [x.name, x.handover])).toEqual([['سارة', true], ['عبدالله', false], ['نورة', false]]);
  });

  it('absence notices, then trips booking the driver and the attendant', async () => {
    const nora = kids[2];
    await post('/v1/school/absences', { student_id: nora.id, date: kwDay(-1) }).expect(400);
    expect((await post('/v1/school/absences', { student_id: nora.id, date: kwDay(1), scope: 'from_school', note: 'موعد طبيب' }).expect(201)).body.created).toBe(true);
    expect((await post('/v1/school/absences', { student_id: nora.id, date: kwDay(1), scope: 'from_school' }).expect(201)).body.created).toBe(false);
    expect((await get(`/v1/school/absences?date=${kwDay(1)}`).expect(200)).body.data).toHaveLength(1);
    const g = (await post('/v1/school/trips/generate', { date: kwDay(1) }).expect(201)).body;
    expect(g.created).toEqual(['N1']);
    expect((await post('/v1/school/trips/generate', { date: kwDay(1) }).expect(201)).body.existing).toEqual(['N1']);
    const t = (await get(`/v1/school/trips?date=${kwDay(1)}`).expect(200)).body.data[0];
    expect(t).toMatchObject({ route_code: 'N1', status: 'assigned', students_planned: 3, attendant_name: 'أم سارة', attendant_task_id: expect.any(String) });
    tripId = t.id;
    const d = (await get(`/v1/school/trips/${tripId}`).expect(200)).body;
    expect(d.students.map((x: { state: string }) => x.state)).toEqual(['waiting', 'waiting', 'excused']);
  });

  it('the attendant marks students; a young child is handed to a named adult; the trip closes only when all are off', async () => {
    const mine = (await get('/v1/driver/tasks', attendant.token).expect(200)).body.data;
    const at = mine.find((x: { sector_pack: string }) => x.sector_pack === 'school@1');
    expect(at.attributes).toMatchObject({ kind: 'attend', route_code: 'N1', direction: 'from_school' });
    expect(at.school.students.map((x: { excused: boolean }) => x.excused)).toEqual([false, false, true]);
    const dt = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data.find((x: { sector_pack: string }) => x.sector_pack === 'school@1');
    expect(dt.attributes.kind).toBe('trip');
    const [sara, abd] = kids;
    expect(await op({ type: 'student', task_id: at.id, student_id: sara.id, event: 'boarded' })).toMatchObject({ result: 'rejected', reason: 'invalid_stage' });
    await op({ type: 'task_status', task_id: at.id, to_status: 'accepted' });
    await op({ type: 'task_status', task_id: dt.id, to_status: 'accepted' }, driver.token);
    const id = randomUUID();
    expect(await op({ type: 'student', task_id: at.id, student_id: sara.id, event: 'boarded' }, attendant.token, id)).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'student', task_id: at.id, student_id: sara.id, event: 'boarded' }, attendant.token, id)).toMatchObject({ result: 'duplicate' });
    expect(await op({ type: 'student', task_id: at.id, student_id: abd.id, event: 'dropped' })).toMatchObject({ result: 'rejected', reason: 'not_on_board' });
    await op({ type: 'student', task_id: at.id, student_id: abd.id, event: 'boarded' });
    await op({ type: 'task_status', task_id: dt.id, to_status: 'in_progress' }, driver.token);
    expect(await op({ type: 'student', task_id: at.id, student_id: abd.id, event: 'absent' })).toMatchObject({ result: 'rejected', reason: 'already_on_board' });
    expect(await op({ type: 'student', task_id: at.id, student_id: randomUUID(), event: 'boarded' })).toMatchObject({ result: 'rejected', reason: 'unknown_student' });
    await op({ type: 'student', task_id: at.id, student_id: abd.id, event: 'dropped' });
    // the driver cannot end the trip while Sara is on the bus
    expect(await op({ type: 'task_status', task_id: dt.id, to_status: 'completed' }, driver.token)).toMatchObject({ result: 'rejected', reason: 'students_on_board' });
    expect(await op({ type: 'student', task_id: at.id, student_id: sara.id, event: 'dropped' })).toMatchObject({ result: 'rejected', reason: 'receiver_required' });
    expect(await op({ type: 'student', task_id: dt.id, student_id: sara.id, event: 'dropped', received_by: 'أم سارة' }, driver.token)).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: dt.id, to_status: 'completed' }, driver.token)).toMatchObject({ result: 'applied' });
    const d = (await get(`/v1/school/trips/${tripId}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'completed', on_board: 0, dropped: 2, absent: 0 });
    expect(d.students.map((x: { state: string }) => x.state)).toEqual(['dropped', 'dropped', 'excused']);
    expect(d.students[0].received_by).toBe('أم سارة');
    await post(`/v1/school/trips/${tripId}/cancel`, { reason: 'x' }).expect(409);
  });

  it('exceptions: a child left on a bus, unmarked students block closing, absence streaks; route edits', async () => {
    // a morning trip that should have left 20 minutes ago, with no attendant
    const ago = new Date(Date.now() + 3 * 3_600_000 - 20 * 60_000).toISOString();
    const m = (await post('/v1/school/routes', { legal_entity_id: le, school_name: 'مدرسة النور', code: 'M1', name: 'الصباح', direction: 'to_school', depart_time: ago.slice(11, 16), duration_min: 30,
      days: ALL, stops: [{ name: 'مشرف' }, { name: 'المدرسة', offset_min: 25 }], asset_id: bus, driver_worker_id: driver.id }).expect(201)).body;
    const kid = (await post(`/v1/school/routes/${m.id}/students`, { name: 'يوسف', grade: '4', stop_seq: 1, guardian_phone: '+96599004444' }).expect(201)).body.ids[0];
    expect((await post('/v1/school/trips/generate', { date: ago.slice(0, 10), route_ids: [m.id] }).expect(201)).body.created).toEqual(['M1']);
    const trip = (await get(`/v1/school/trips?date=${ago.slice(0, 10)}`).expect(200)).body.data.find((x: { route_code: string }) => x.route_code === 'M1');
    let e = (await get(`/v1/school/exceptions?date=${ago.slice(0, 10)}`).expect(200)).body;
    expect(e.late.map((x: { route_code: string }) => x.route_code)).toContain('M1');
    expect(e.no_attendant.map((x: { route_code: string }) => x.route_code)).toContain('M1');
    // the driver runs it, boards Yousef, and the window passes with him still marked on board
    const t = (await get('/v1/driver/tasks', driver.token).expect(200)).body.data.find((x: { attributes: { route_code: string } }) => x.attributes.route_code === 'M1');
    await op({ type: 'task_status', task_id: t.id, to_status: 'accepted' }, driver.token);
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'in_progress' }, driver.token)).toMatchObject({ result: 'applied' });
    expect(await op({ type: 'task_status', task_id: t.id, to_status: 'completed' }, driver.token)).toMatchObject({ result: 'rejected', reason: 'students_unmarked' });
    await op({ type: 'student', task_id: t.id, student_id: kid, event: 'boarded' }, driver.token);
    await op({ type: 'task_status', task_id: t.id, to_status: 'failed', reason_code: 'vehicle_breakdown' }, driver.token);
    e = (await get(`/v1/school/exceptions?date=${ago.slice(0, 10)}`).expect(200)).body;
    expect(e.left_on_board).toHaveLength(1);
    expect(e.left_on_board[0].students.map((x: { name: string }) => x.name)).toEqual(['يوسف']);
    // the office records him dropped at school
    await post(`/v1/school/trips/${trip.id}/mark`, { student_id: kid, event: 'dropped' }).expect(200);
    expect((await get(`/v1/school/exceptions?date=${ago.slice(0, 10)}`).expect(200)).body.left_on_board).toHaveLength(0);
    // Abdullah absent with no notice on three trips in a row (office marks)
    for (const d of [2, 3, 4]) {
      await post('/v1/school/trips/generate', { date: kwDay(d), route_ids: [home.id] }).expect(201);
      const x = (await get(`/v1/school/trips?date=${kwDay(d)}`).expect(200)).body.data.find((y: { route_code: string }) => y.route_code === 'N1');
      await post(`/v1/school/trips/${x.id}/mark`, { student_id: kids[1].id, event: 'absent' }).expect(200);
    }
    e = (await get(`/v1/school/exceptions?date=${kwDay(2)}`).expect(200)).body;
    expect(e.absent_streak.map((x: { name: string }) => x.name)).toEqual(['عبدالله']);
    await post(`/v1/school/trips/${tripId}/mark`, { student_id: randomUUID(), event: 'absent' }).expect(400);
    // edits need the current version; a student leaves the route
    await patch(`/v1/school/routes/${home.id}`, { version: home.version + 5, capacity: 20 }).expect(409);
    expect((await patch(`/v1/school/routes/${home.id}`, { version: home.version, depart_time: '12:45' }).expect(200)).body).toMatchObject({ depart_time: '12:45', code: 'N1' });
    expect((await patch(`/v1/school/students/${kids[2].id}`, { active: false, guardian_phone: '+96599005555' }).expect(200)).body).toMatchObject({ active: false, guardian_phone: '+96599005555' });
    // a notice for a future day can be withdrawn
    const ab = (await post('/v1/school/absences', { student_id: kids[0].id, date: kwDay(5) }).expect(201)).body.id;
    await request(http).delete(`/v1/school/absences/${ab}`).set(auth(T)).expect(200);
  });

  it('report per school: trips, on time, students carried, absences and notices', async () => {
    const r = (await get(`/v1/school/report?from=${kwDay(-1)}&to=${kwDay(4)}`).expect(200)).body;
    const row = r.data.find((x: { school_name: string }) => x.school_name === 'مدرسة النور');
    expect(row).toMatchObject({ customer_name: 'مدرسة النور الخاصة', routes: 2, trips: 5, completed: 1, failed: 1, carried: 2, notices: 1 });
    await get(`/v1/school/report?from=${kwDay(3)}&to=${kwDay(1)}`).expect(400);
  });
});
