import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { DbService } from '../db/db.service';

export const SMS_SENDER = 'SMS_SENDER';
export interface SmsSender { send(phone: string, text: string): Promise<void> }

/** Dev/test sender. The real provider is decision C5 (Phase C) and plugs in here. */
export class LogSmsSender implements SmsSender {
  private readonly log = new Logger('sms');
  async send(phone: string, _text: string) { this.log.log(`OTP sent to ${phone.slice(0, 6)}****`); }
}

const TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const resendCooldownMs = () => num(process.env.OTP_RESEND_COOLDOWN_MS, 60_000);
const maxPerHour = () => num(process.env.OTP_MAX_PER_HOUR, 5);

@Injectable()
export class OtpService {
  constructor(private readonly db: DbService, @Inject(SMS_SENDER) private readonly sms: SmsSender) {}

  private hash(code: string): string {
    const pepper = process.env.OTP_PEPPER ?? '';
    if (process.env.NODE_ENV === 'production' && pepper.length < 16) throw new Error('OTP_PEPPER required in production');
    return createHash('sha256').update(pepper + code).digest('hex');
  }

  /** Returns the code only when OTP_DEV_ECHO=1 outside production (local dev and tests). */
  async request(phone: string): Promise<{ devCode?: string }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.withoutTenant(async (c) => {
      const recent = await c.query(
        `SELECT count(*)::int AS n, max(created_at) AS last FROM auth.otp_challenge
          WHERE phone = $1 AND created_at > now() - interval '1 hour'`, [phone]);
      const { n, last } = recent.rows[0];
      if (n >= maxPerHour() || (last && Date.now() - new Date(last).getTime() < resendCooldownMs())) {
        throw new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS);
      }
      await c.query(
        `INSERT INTO auth.otp_challenge (id, phone, code_hash, expires_at) VALUES ($1,$2,$3, now() + $4 * interval '1 millisecond')`,
        [randomUUID(), phone, this.hash(code), TTL_MS]);
    });
    await this.sms.send(phone, `رمز الدخول: ${code}`);
    const echo = process.env.OTP_DEV_ECHO === '1' && process.env.NODE_ENV !== 'production';
    return echo ? { devCode: code } : {};
  }

  /** True when the code matches the latest live challenge. Wrong codes burn attempts. */
  async verify(phone: string, code: string): Promise<boolean> {
    if (!/^[0-9]{6}$/.test(code)) return false;
    return this.db.withoutTenant(async (c) => {
      const r = await c.query(
        `SELECT id, code_hash, attempts FROM auth.otp_challenge
          WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [phone]);
      const ch = r.rows[0];
      if (!ch || ch.attempts >= MAX_ATTEMPTS) return false;
      const ok = timingSafeEqual(Buffer.from(ch.code_hash, 'hex'), Buffer.from(this.hash(code), 'hex'));
      await c.query(
        ok ? 'UPDATE auth.otp_challenge SET consumed_at = now() WHERE id = $1'
           : 'UPDATE auth.otp_challenge SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
      return ok;
    });
  }
}
