import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

function scrypt(pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((res, rej) => scryptCb(pw, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
}

/** "scrypt$N$r$p$salt$hash" (base64url). The parameters travel with the hash so they can be raised later. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const k = await scrypt(pw, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), k.toString('base64url')].join('$');
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) { await scrypt(pw, randomBytes(16), N, R, P); return false; } // same cost whether or not the account exists
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const k = await scrypt(pw, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  const h = Buffer.from(hash, 'base64url');
  return h.length === k.length && timingSafeEqual(h, k);
}

/** At least 8 characters, at most 200; no other composition rules (NIST 800-63B). */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return 'password must be at least 8 characters';
  if (pw.length > 200) return 'password too long';
  return null;
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
