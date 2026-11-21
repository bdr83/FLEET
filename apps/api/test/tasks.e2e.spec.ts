/**
 * End-to-end isolation through the HTTP API, against a real PostgreSQL with
 * migrations applied and db/tests/seed.sql loaded (tenant A has 2 tasks, B has 1).
 * Needs DATABASE_URL (role app_rw). Skipped when it is not set.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { signToken } from './token';

const SECRET = 'e2e-secret-'.padEnd(40, 'x');
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const A_E1 = 'aaaaaaaa-0000-0000-0000-0000000000e1';
const B_E1 = 'bbbbbbbb-0000-0000-0000-0000000000e1';
const B_TASK = 'bbbbbbbb-0000-0000-0000-0000000000b1';
const exp = () => Math.floor(Date.now() / 1000) + 600;
const tok = (tid: string, ents?: string[]) =>
  `Bearer ${signToken({ tid, sub: 'aaaaaaaa-0000-0000-0000-0000000000c1', exp: exp(), ...(ents ? { ents } : {}) }, SECRET)}`;

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('tasks API isolation', () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = SECRET;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => app?.close());

  it('health works without a token', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });
  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/v1/tasks').expect(401);
  });
  it('tenant A sees only its own tasks', async () => {
    const r = await request(app.getHttpServer()).get('/v1/tasks').set('Authorization', tok(A)).expect(200);
    expect(r.body.data.length).toBeGreaterThanOrEqual(2);
    expect(r.body.data.map((t: { id: string }) => t.id)).not.toContain(B_TASK);
  });
  it("404 (not 403) for another tenant's task", async () => {
    await request(app.getHttpServer()).get(`/v1/tasks/${B_TASK}`).set('Authorization', tok(A)).expect(404);
  });
  it('tenant B can read its own task', async () => {
    await request(app.getHttpServer()).get(`/v1/tasks/${B_TASK}`).set('Authorization', tok(B)).expect(200);
  });
  it('entity scope narrows results inside a tenant', async () => {
    const all = await request(app.getHttpServer()).get('/v1/tasks').set('Authorization', tok(A)).expect(200);
    const one = await request(app.getHttpServer()).get('/v1/tasks').set('Authorization', tok(A, [A_E1])).expect(200);
    expect(one.body.data.length).toBeLessThan(all.body.data.length);
    expect(one.body.data.every((t: { legal_entity_id: string }) => t.legal_entity_id === A_E1)).toBe(true);
  });
  it("cannot create a task under another tenant's legal entity", async () => {
    await request(app.getHttpServer()).post('/v1/tasks').set('Authorization', tok(A))
      .send({ legal_entity_id: B_E1, sector_pack: 'delivery@1' }).expect(400);
  });
  it('creates a task in its own tenant', async () => {
    const r = await request(app.getHttpServer()).post('/v1/tasks').set('Authorization', tok(A))
      .send({ legal_entity_id: A_E1, sector_pack: 'delivery@1' }).expect(201);
    expect(r.body.status).toBe('draft');
    await request(app.getHttpServer()).get(`/v1/tasks/${r.body.id}`).set('Authorization', tok(B)).expect(404);
  });
});
