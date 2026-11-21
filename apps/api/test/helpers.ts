import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

export const hasDb = !!process.env.DATABASE_URL;

export async function createApp(): Promise<INestApplication> {
  process.env.AUTH_JWT_SECRET = 'e2e-secret-'.padEnd(40, 'x');
  process.env.OTP_DEV_ECHO = '1';
  process.env.OTP_PEPPER = 'test-pepper-123456';
  process.env.OTP_RESEND_COOLDOWN_MS = '0';
  process.env.OTP_MAX_PER_HOUR = '1000';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

/** A random Kuwaiti mobile number, so test files never share a phone. */
export function newPhone(): string {
  return `+9655${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

export async function login(app: INestApplication, phone: string): Promise<{ user_token: string; memberships: { tenant_id: string; role_code: string }[] }> {
  const r1 = await request(app.getHttpServer()).post('/v1/auth/otp/request').send({ phone }).expect(202);
  const r2 = await request(app.getHttpServer()).post('/v1/auth/otp/verify').send({ phone, code: r1.body.dev_code }).expect(200);
  return r2.body;
}

export async function onboard(app: INestApplication, name: string) {
  const phone = newPhone();
  const { user_token } = await login(app, phone);
  const r = await request(app.getHttpServer()).post('/v1/tenants').set('Authorization', `Bearer ${user_token}`).send({ name }).expect(201);
  return { phone, ...r.body } as { phone: string; access_token: string; refresh_token: string; tenant: { id: string }; legal_entity_id: string };
}

export async function joinAs(app: INestApplication, tenantId: string, phone: string) {
  const { user_token } = await login(app, phone);
  const r = await request(app.getHttpServer()).post('/v1/auth/token').set('Authorization', `Bearer ${user_token}`).send({ tenant_id: tenantId }).expect(200);
  return r.body as { access_token: string; refresh_token: string };
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
