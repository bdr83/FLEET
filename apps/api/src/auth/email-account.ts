import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { hashPassword, normalizeEmail, passwordProblem } from './password';

/**
 * Gives an account an email login, for people added by a company (drivers, staff).
 * - userId set (found by phone): the email is attached if the account has none and no other account uses it.
 * - userId null: the account is found or created by email.
 * The password is only a first password: an account that already has one keeps it.
 * Returns the user id, or throws 400 / 409.
 */
export async function ensureEmailLogin(
  c: PoolClient, userId: string | null, emailIn: unknown, password: unknown, displayName: string | null,
): Promise<string> {
  const email = normalizeEmail(emailIn);
  if (!email) throw new BadRequestException('invalid email');
  if (password !== undefined && password !== null && password !== '') {
    const p = passwordProblem(password); if (p) throw new BadRequestException(p);
  }
  const pw = typeof password === 'string' && password ? await hashPassword(password) : null;
  const owner = (await c.query('SELECT id, password_hash IS NOT NULL AS has_pw FROM org.app_user WHERE email = $1', [email])).rows[0];
  let id: string;
  if (userId) {
    if (owner && owner.id !== userId) throw new ConflictException('email belongs to another account');
    const cur = (await c.query('SELECT email, password_hash IS NOT NULL AS has_pw FROM org.app_user WHERE id = $1', [userId])).rows[0];
    if (cur.email && cur.email !== email) throw new ConflictException('this phone already has another email');
    if (!cur.has_pw && !pw) throw new BadRequestException('password required for a new email login');
    await c.query(
      `UPDATE org.app_user SET email = $2, password_hash = COALESCE(password_hash, $3),
              password_changed_at = COALESCE(password_changed_at, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END) WHERE id = $1`,
      [userId, email, pw]);
    id = userId;
  } else {
    if (!owner?.has_pw && !pw) throw new BadRequestException('password required for a new email login');
    id = (await c.query(
      `INSERT INTO org.app_user (id, email, display_name, password_hash, password_changed_at) VALUES ($1,$2,$3,$4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(org.app_user.display_name, EXCLUDED.display_name),
         password_hash = COALESCE(org.app_user.password_hash, EXCLUDED.password_hash),
         password_changed_at = COALESCE(org.app_user.password_changed_at, EXCLUDED.password_changed_at) RETURNING id`,
      [randomUUID(), email, displayName, pw])).rows[0].id;
  }
  return id;
}
