import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Encrypts the customer's Odoo API key at rest (AES-256-GCM). The key comes from ODOO_SECRET_KEY,
 * or is derived from AUTH_JWT_SECRET so the pilot needs no new setting. Changing that secret means
 * every company re-enters its Odoo key.
 */
function key(): Buffer {
  const base = process.env.ODOO_SECRET_KEY || process.env.AUTH_JWT_SECRET;
  if (!base) throw new Error('ODOO_SECRET_KEY or AUTH_JWT_SECRET is required');
  return createHash('sha256').update(`odoo-api-key:${base}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function openSecret(sealed: string): string {
  const [ver, iv, tag, body] = sealed.split(':');
  if (ver !== 'v1' || !iv || !tag || !body) throw new Error('unreadable secret');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}
