import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { auth, createApp, hasDb, onboard } from './helpers';

(hasDb ? describe : describe.skip)('tasks API isolation', () => {
  let app: INestApplication;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let bTask: string;
  beforeAll(async () => {
    app = await createApp();
    A = await onboard(app, 'شركة أ');
    B = await onboard(app, 'شركة ب');
    const r = await request(app.getHttpServer()).post('/v1/tasks').set(auth(B.access_token))
      .send({ legal_entity_id: B.legal_entity_id, sector_pack: 'delivery@1' }).expect(201);
    bTask = r.body.id;
  });
  afterAll(async () => app?.close());

  it('health works without a token', () => request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' }));
  it('401 without a token', () => request(app.getHttpServer()).get('/v1/tasks').expect(401));
  it('A does not see B tasks', async () => {
    const r = await request(app.getHttpServer()).get('/v1/tasks').set(auth(A.access_token)).expect(200);
    expect(r.body.data.map((t: { id: string }) => t.id)).not.toContain(bTask);
  });
  it("404 (not 403) for another tenant's task", () =>
    request(app.getHttpServer()).get(`/v1/tasks/${bTask}`).set(auth(A.access_token)).expect(404));
  it('B reads its own task', () => request(app.getHttpServer()).get(`/v1/tasks/${bTask}`).set(auth(B.access_token)).expect(200));
  it("A cannot create a task under B's legal entity", () =>
    request(app.getHttpServer()).post('/v1/tasks').set(auth(A.access_token))
      .send({ legal_entity_id: B.legal_entity_id, sector_pack: 'delivery@1' }).expect(400));
});
