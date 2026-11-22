import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { MAIL_SENDER, MailSender } from './mail';
import { hashPassword, normalizeEmail, passwordProblem, verifyPassword } from './password';

const MAX_FAILS = 10;          // [تخمين] then the account waits LOCK_MIN minutes
const LOCK_MIN = 15;
const RESET_TTL_MIN = 60;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const echo = () => process.env.OTP_DEV_ECHO === '1' && process.env.NODE_ENV !== 'production';

@Injectable()
export class PasswordService {
  constructor(private readonly db: DbService, @Inject(MAIL_SENDER) private readonly mail: MailSender) {}

  get mailConfigured() { return this.mail.configured; }

  /** New account with email + password. An email already in use (with or without a password) is refused. */
  async register(emailIn: unknown, password: unknown, displayName?: unknown): Promise<string> {
    const email = normalizeEmail(emailIn);
    if (!email) throw new BadRequestException('invalid email');
    const p = passwordProblem(password); if (p) throw new BadRequestException(p);
    const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 120) : null;
    const hash = await hashPassword(password as string);
    return this.db.withoutTenant(async (c) => {
      const r = await c.query(
        `INSERT INTO org.app_user (id, email, display_name, password_hash, password_changed_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (email) DO NOTHING RETURNING id`, [randomUUID(), email, name, hash]);
      if (!r.rows[0]) throw new ConflictException('email_taken');
      return r.rows[0].id as string;
    });
  }

  /** Returns the user id. Same answer for an unknown email and a wrong password. */
  async login(emailIn: unknown, password: unknown): Promise<string> {
    const email = normalizeEmail(emailIn);
    if (!email || typeof password !== 'string' || password.length > 200) throw new UnauthorizedException();
    const u = await this.db.withoutTenant(async (c) =>
      (await c.query('SELECT id, password_hash, locked_until > now() AS locked FROM org.app_user WHERE email = $1', [email])).rows[0]);
    if (u?.locked) throw new HttpException('account locked, try later', HttpStatus.TOO_MANY_REQUESTS);
    const ok = await verifyPassword(password, u?.password_hash);
    if (!u) throw new UnauthorizedException();
    await this.db.withoutTenant((c) => c.query(ok
      ? 'UPDATE org.app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1'
      : `UPDATE org.app_user SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                 locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + $3 * interval '1 minute' ELSE locked_until END
          WHERE id = $1`, ok ? [u.id] : [u.id, MAX_FAILS, LOCK_MIN]));
    if (!ok) throw new UnauthorizedException();
    return u.id;
  }

  /** Always answers the same for known and unknown emails. Returns the token only in dev echo mode (tests). */
  async forgot(emailIn: unknown, appUrl: string): Promise<{ devToken?: string }> {
    const email = normalizeEmail(emailIn);
    if (!email) throw new BadRequestException('invalid email');
    if (!this.mail.configured) throw new ServiceUnavailableException('email_unavailable');
    const token = randomBytes(32).toString('base64url');
    const sent = await this.db.withoutTenant(async (c) => {
      const u = (await c.query('SELECT id FROM org.app_user WHERE email = $1', [email])).rows[0];
      if (!u) return false;
      const recent = (await c.query(
        `SELECT count(*)::int AS n FROM auth.password_reset WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [u.id])).rows[0].n;
      if (recent >= 5) return false;
      await c.query(`INSERT INTO auth.password_reset (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + $4 * interval '1 minute')`,
        [randomUUID(), u.id, sha(token), RESET_TTL_MIN]);
      return true;
    });
    if (!sent) return {};
    const link = `${appUrl.replace(/\/$/, '')}/login/reset?token=${token}`;
    try {
      await this.mail.send(email, 'استعادة كلمة المرور', `لتعيين كلمة مرور جديدة افتح الرابط التالي خلال ساعة:\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة.`);
    } catch (e) {
      new Logger('mail').error(`reset mail failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException('email_unavailable');
    }
    return echo() ? { devToken: token } : {};
  }

  /** Sets a new password from a reset token; the token is single-use. Returns the user id. */
  async reset(token: unknown, password: unknown): Promise<string> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new BadRequestException('invalid token');
    const p = passwordProblem(password); if (p) throw new BadRequestException(p);
    const hash = await hashPassword(password as string);
    const userId = await this.db.withoutTenant(async (c) => {
      const r = await c.query(
        `UPDATE auth.password_reset SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha(token)]);
      const id = r.rows[0]?.user_id as string | undefined;
      if (!id) return null;
      await c.query(`UPDATE org.app_user SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`, [id, hash]);
      await c.query('UPDATE auth.password_reset SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [id]);
      return id;
    });
    if (!userId) throw new BadRequestException('invalid or expired token');
    return userId;
  }

  /** Signed-in user changes their own password (needs the current one). */
  async change(userId: string, current: unknown, next: unknown): Promise<void> {
    const p = passwordProblem(next); if (p) throw new BadRequestException(p);
    const u = await this.db.withoutTenant(async (c) => (await c.query('SELECT password_hash FROM org.app_user WHERE id = $1', [userId])).rows[0]);
    if (u?.password_hash && !(typeof current === 'string' && await verifyPassword(current, u.password_hash))) throw new UnauthorizedException('wrong current password');
    const hash = await hashPassword(next as string);
    await this.db.withoutTenant((c) => c.query('UPDATE org.app_user SET password_hash = $2, password_changed_at = now() WHERE id = $1', [userId, hash]));
  }
}
