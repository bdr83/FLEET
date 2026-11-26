/**
 * Odoo accounting link: every ledger journal is sent to Odoo once as a posted journal entry, against a fake Odoo
 * that speaks JSON-2 and the legacy JSON-RPC.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { auth, createApp, hasDb, onboard } from './helpers';
import { OdooSyncService } from '../src/integrations/odoo/odoo.sync';
import { isPrivateAddress } from '../src/integrations/odoo/odoo.client';
import { openSecret, sealSecret } from '../src/integrations/odoo/secret';

type Rec = Record<string, unknown> & { id: number };

/** A tiny in-memory Odoo: account.journal, account.account, res.company, res.partner and account.move. */
class FakeOdoo {
  key = 'odoo-key-1';
  models: Record<string, Rec[]> = {
    'account.journal': [{ id: 7, name: 'Miscellaneous', company_id: [1, 'Fleet Co'] }],
    'res.company': [{ id: 1, currency_id: [3, 'KWD'] }],
    'account.account': [
      { id: 101, code: '101000' }, { id: 102, code: '102000' }, { id: 121, code: '121000' }, { id: 400, code: '400000' },
    ],
    'res.partner': [],
    'account.move': [],
  };
  calls: string[] = [];
  failCreate = 0;
  server!: Server;
  url = '';

  private match(r: Rec, domain: unknown[]): boolean {
    return domain.every((d) => {
      const [f, op, val] = d as [string, string, unknown];
      const x = Array.isArray(r[f]) ? (r[f] as unknown[])[0] : r[f];
      return op === 'in' ? (val as unknown[]).includes(x) : x === val;
    });
  }

  private run(model: string, method: string, p: { domain?: unknown[]; fields?: string[]; limit?: number; vals_list?: Record<string, unknown>[]; ids?: number[] }): unknown {
    this.calls.push(`${model}.${method}`);
    const table = (this.models[model] ??= []);
    if (method === 'search_read') {
      const rows = table.filter((r) => this.match(r, p.domain ?? []));
      return rows.slice(0, p.limit ?? rows.length).map((r) => Object.fromEntries(['id', ...(p.fields ?? [])].map((f) => [f, r[f]])));
    }
    if (method === 'create') {
      if (model === 'account.move' && this.failCreate > 0) { this.failCreate--; throw new Error('Odoo is busy'); }
      return (p.vals_list ?? []).map((vals) => {
        const id = 1000 + table.length;
        table.push({ ...vals, id, state: model === 'account.move' ? 'draft' : undefined, journal_id: vals.journal_id });
        return id;
      });
    }
    if (method === 'action_post') {
      for (const id of p.ids ?? []) {
        const m = table.find((r) => r.id === id)!;
        const lines = (m.line_ids as [number, number, { debit: number; credit: number }][]).map((x) => x[2]);
        const d = lines.reduce((s, l) => s + Math.round(l.debit * 1000), 0), c = lines.reduce((s, l) => s + Math.round(l.credit * 1000), 0);
        if (d !== c) throw new Error('unbalanced');
        m.state = 'posted';
      }
      return true;
    }
    throw new Error(`unknown method ${method}`);
  }

  async start() {
    this.server = createServer(async (req: IncomingMessage, res) => {
      let raw = '';
      for await (const ch of req) raw += ch;
      const body = JSON.parse(raw || '{}');
      const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      try {
        const m = req.url!.match(/^\/json\/2\/([\w.]+)\/(\w+)$/);
        if (m) {
          if (req.headers.authorization !== `bearer ${this.key}`) return send(401, { name: 'AccessDenied', message: 'Access Denied' });
          return send(200, this.run(m[1], m[2], body));
        }
        if (req.url === '/jsonrpc') {
          const { service, method, args } = body.params;
          if (service === 'common' && method === 'authenticate') return send(200, { jsonrpc: '2.0', id: body.id, result: args[2] === this.key ? 2 : false });
          const [, uid, key, model, meth, a, kw] = args;
          if (uid !== 2 || key !== this.key) return send(200, { jsonrpc: '2.0', id: body.id, error: { message: 'Access Denied', data: { message: 'Access Denied' } } });
          const p = meth === 'search_read' ? { domain: a[0], ...kw } : meth === 'create' ? { vals_list: a[0] } : { ids: a[0] };
          return send(200, { jsonrpc: '2.0', id: body.id, result: this.run(model, meth, p) });
        }
        send(404, { message: 'not found' });
      } catch (e) {
        send(500, { name: 'ServerError', message: (e as Error).message });
      }
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

const MAP = { '1010': '102000', '1000': '101000', '1100': '121000', '4000': '400000' };

describe('Odoo link helpers', () => {
  it('seals the API key and refuses tampering', () => {
    process.env.AUTH_JWT_SECRET ??= 'unit-secret-'.padEnd(40, 'x');
    const s = sealSecret('secret-key');
    expect(s).not.toContain('secret-key');
    expect(openSecret(s)).toBe('secret-key');
    expect(() => openSecret(s.slice(0, -4) + 'AAAA')).toThrow();
  });
  it('treats internal addresses as private', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['31.97.155.239', '8.8.8.8', '2a00:1450::1']) expect(isPrivateAddress(ip)).toBe(false);
  });
});

(hasDb ? describe : describe.skip)('Odoo accounting link', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let A: Awaited<ReturnType<typeof onboard>>;
  let B: Awaited<ReturnType<typeof onboard>>;
  let customer: string;
  let odoo: FakeOdoo;
  const post = (path: string, body: Record<string, unknown>, token = A.access_token) => request(http).post(path).set(auth(token)).send(body);
  const put = (body: Record<string, unknown>, token = A.access_token) => request(http).put('/v1/integrations/odoo').set(auth(token)).send(body);
  const status = (token = A.access_token, le = A.legal_entity_id) => request(http).get(`/v1/integrations/odoo?legal_entity_id=${le}`).set(auth(token));
  const syncNow = () => post('/v1/integrations/odoo/sync', { legal_entity_id: A.legal_entity_id }).expect(200);
  const settings = (extra: Record<string, unknown> = {}) => ({
    legal_entity_id: A.legal_entity_id, base_url: odoo.url, api_key: odoo.key, journal_id: 7, account_map: MAP, sync_from: '2026-01-01', ...extra,
  });
  const moves = () => odoo.models['account.move'];

  beforeAll(async () => {
    process.env.ODOO_SYNC_DISABLED = '1';
    process.env.ODOO_ALLOW_PRIVATE = '1';
    odoo = new FakeOdoo();
    await odoo.start();
    app = await createApp();
    http = app.getHttpServer();
    A = await onboard(app, 'ربط أودو أ');
    B = await onboard(app, 'ربط أودو ب');
    customer = (await post('/v1/customers', { legal_entity_id: A.legal_entity_id, name: 'شركة الياسمين', email: 'ap@yasmin.example' }).expect(201)).body.id;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise((r) => odoo?.server.close(r));
    delete process.env.ODOO_ALLOW_PRIVATE;
  });

  it('starts unlinked and lists the accounts to map', async () => {
    const r = await status().expect(200);
    expect(r.body.link).toBeNull();
    expect(r.body.accounts.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['1000', '1100', '4000', '5010']));
  });

  it('validates the settings and keeps the API key write-only', async () => {
    await put(settings({ api_key: undefined })).expect(400);
    await put(settings({ account_map: { '9999': 'x' } })).expect(400);
    await put(settings({ protocol: 'jsonrpc' })).expect(400);             // needs database and login
    await put(settings({ base_url: 'ftp://odoo.example' })).expect(400);
    const r = await put(settings()).expect(200);
    expect(r.body).not.toHaveProperty('api_key');
    const s = await status().expect(200);
    expect(s.body.link).toMatchObject({ base_url: odoo.url, journal_id: 7, has_key: true, enabled: true });
    expect(JSON.stringify(s.body)).not.toContain(odoo.key);
    await put(settings({ api_key: undefined })).expect(200);              // an update may keep the saved key
  });

  it('refuses internal addresses when private hosts are not allowed', async () => {
    delete process.env.ODOO_ALLOW_PRIVATE;
    try {
      const r = await put(settings({ base_url: 'https://127.0.0.1:8069' })).expect(400);
      expect(r.body.message).toContain('داخلي');
      await put(settings({ base_url: 'http://odoo.example.com' })).expect(400);
    } finally {
      process.env.ODOO_ALLOW_PRIVATE = '1';
    }
  });

  it('is invisible to another company', async () => {
    await status(B.access_token).expect(404);
    await put({ ...settings(), legal_entity_id: A.legal_entity_id }, B.access_token).expect(404);
    expect((await status(B.access_token, B.legal_entity_id).expect(200)).body.link).toBeNull();
  });

  it('tests the connection: journal, currency and missing accounts', async () => {
    let r = await post('/v1/integrations/odoo/test', { legal_entity_id: A.legal_entity_id }).expect(200);
    expect(r.body).toMatchObject({ ok: true, journal: 'Miscellaneous', company_currency: 'KWD', currency_matches: true, missing_accounts: [] });
    expect(r.body.unmapped_accounts).toContain('5010');
    await put(settings({ account_map: { ...MAP, '5010': '999999' } })).expect(200);
    r = await post('/v1/integrations/odoo/test', { legal_entity_id: A.legal_entity_id }).expect(200);
    expect(r.body).toMatchObject({ ok: false, missing_accounts: ['999999'] });
    await put(settings({ api_key: 'wrong' })).expect(200);
    r = await post('/v1/integrations/odoo/test', { legal_entity_id: A.legal_entity_id }).expect(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('رفض');
    await put(settings()).expect(200);
  });

  let payment: string;
  it('sends a payment as one posted, balanced journal entry with the customer as partner', async () => {
    payment = (await post('/v1/payments', { customer_id: customer, amount: '12.500', method: 'knet', reference: 'K-77' }).expect(201)).body.id;
    const r = await syncNow();
    expect(r.body).toEqual({ sent: 1, failed: 0, error: null });
    expect(moves()).toHaveLength(1);
    const m = moves()[0];
    expect(m).toMatchObject({ move_type: 'entry', journal_id: 7, state: 'posted' });
    expect(String(m.ref)).toMatch(/^fleet:/);
    const lines = (m.line_ids as [number, number, Record<string, unknown>][]).map((x) => x[2]);
    const partner = odoo.models['res.partner'][0];
    expect(partner).toMatchObject({ name: 'شركة الياسمين', ref: `fleet:${customer}`, email: 'ap@yasmin.example', is_company: true });
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_id: 102, debit: 12.5, credit: 0 }),
      expect.objectContaining({ account_id: 121, debit: 0, credit: 12.5, partner_id: partner.id }),
    ]));
    const s = await status().expect(200);
    expect(s.body.counts).toEqual({ sent: 1, failed: 0, waiting: 0 });
    expect(s.body.link.last_ok_at).toBeTruthy();
  });

  it('never sends the same journal twice', async () => {
    expect((await syncNow()).body).toEqual({ sent: 0, failed: 0, error: null });
    expect(moves()).toHaveLength(1);
  });

  it('reuses an entry Odoo already has after a crash between create and our record', async () => {
    await post(`/v1/payments/${payment}/reverse`, { reason: 'رجع الشيك' }).expect(200);
    const svc = app.get(OdooSyncService);
    // simulate: the entry was made in Odoo but our record was lost
    await svc.syncLink(A.tenant.id, A.legal_entity_id);
    expect(moves()).toHaveLength(2);
    const ref = moves()[1].ref;
    const { Client } = await import('pg');
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenant.id]);
    await db.query('DELETE FROM billing.odoo_sync WHERE journal_id = $1', [String(ref).slice(6)]);
    await db.query('COMMIT');
    await db.end();
    expect((await syncNow()).body).toEqual({ sent: 1, failed: 0, error: null });
    expect(moves()).toHaveLength(2);
    expect(odoo.models['res.partner']).toHaveLength(1);
  });

  it('records a failed journal with its reason, retries later, and sends it once Odoo is back', async () => {
    odoo.failCreate = 1;
    await post('/v1/payments', { customer_id: customer, amount: '1.000', method: 'cash' }).expect(201);
    expect((await syncNow()).body).toEqual({ sent: 0, failed: 1, error: null });
    let s = await status().expect(200);
    expect(s.body.counts.failed).toBe(1);
    expect(s.body.failures[0]).toMatchObject({ source_type: 'payment', attempts: 1 });
    expect(s.body.failures[0].last_error).toContain('Odoo is busy');
    expect((await syncNow()).body.sent).toBe(0);                          // waits for its next attempt
    expect((await post('/v1/integrations/odoo/retry', { legal_entity_id: A.legal_entity_id }).expect(200)).body).toEqual({ requeued: 1 });
    expect((await syncNow()).body).toEqual({ sent: 1, failed: 0, error: null });
    s = await status().expect(200);
    expect(s.body.counts).toEqual({ sent: 3, failed: 0, waiting: 0 });   // payment, its reversal, this payment
    expect(moves()).toHaveLength(3);
  });

  it('fails a journal whose account is not mapped and names the account', async () => {
    await put(settings({ account_map: { '1010': '102000', '1100': '121000' } })).expect(200);
    await post('/v1/payments', { customer_id: customer, amount: '2.000', method: 'cash' }).expect(201);
    expect((await syncNow()).body).toMatchObject({ sent: 0, failed: 1 });
    const s = await status().expect(200);
    expect(s.body.failures[0].last_error).toContain('1000 الصندوق');
    await put(settings()).expect(200);
    await post('/v1/integrations/odoo/retry', { legal_entity_id: A.legal_entity_id }).expect(200);
    expect((await syncNow()).body).toMatchObject({ sent: 1, failed: 0 });
  });

  it('stops the run on a rejected key, reports it on the link, and leaves the journals waiting', async () => {
    await put(settings({ api_key: 'revoked' })).expect(200);
    await post('/v1/payments', { customer_id: customer, amount: '3.000', method: 'cash' }).expect(201);
    expect((await syncNow()).body).toEqual({ sent: 0, failed: 0, error: expect.stringContaining('رفض') });
    const s = await status().expect(200);
    expect(s.body.link.last_error).toContain('رفض');
    expect(s.body.counts.waiting).toBe(1);
    await put(settings()).expect(200);
    expect((await status().expect(200)).body.link.last_error).toBeNull();
    expect((await syncNow()).body).toEqual({ sent: 1, failed: 0, error: null });
  });

  it('skips journals before sync_from and stops when the link is turned off', async () => {
    await put(settings({ sync_from: '2099-01-01' })).expect(200);
    await post('/v1/payments', { customer_id: customer, amount: '4.000', method: 'cash' }).expect(201);
    expect((await syncNow()).body).toEqual({ sent: 0, failed: 0, error: null });
    await put(settings({ enabled: false })).expect(200);
    expect((await syncNow()).body).toMatchObject({ sent: 0, error: 'الربط غير مفعّل' });
    await put(settings()).expect(200);
  });

  it('speaks the legacy JSON-RPC for older Odoo versions', async () => {
    await put(settings({ protocol: 'jsonrpc', database: 'prod', login: 'api@fleet.example' })).expect(200);
    const before = moves().length;
    const r = await syncNow();
    expect(r.body).toEqual({ sent: 1, failed: 0, error: null });          // the 4.000 payment
    expect(moves()).toHaveLength(before + 1);
    expect((await post('/v1/integrations/odoo/test', { legal_entity_id: A.legal_entity_id }).expect(200)).body.ok).toBe(true);
  });

  it('runs on schedule over every enabled link', async () => {
    await post('/v1/payments', { customer_id: customer, amount: '5.000', method: 'cash' }).expect(201);
    const before = moves().length;
    await app.get(OdooSyncService).runAll();
    expect(moves()).toHaveLength(before + 1);
  });

  it('writes an audit row for each settings change', async () => {
    const r = await request(http).get('/v1/audit-log').set(auth(A.access_token)).expect(200);
    const rows = r.body.data as { action: string; after: Record<string, unknown> }[];
    expect(rows.map((x) => x.action)).toEqual(expect.arrayContaining(['odoo_link.created', 'odoo_link.updated']));
    expect(JSON.stringify(rows)).not.toContain(odoo.key);
  });
});
