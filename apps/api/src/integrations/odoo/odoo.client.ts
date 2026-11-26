import { lookup } from 'dns/promises';
import { isIP } from 'net';

export type OdooProtocol = 'json2' | 'jsonrpc';

export interface OdooConn {
  protocol: OdooProtocol;
  baseUrl: string;
  database: string | null;
  login: string | null;
  apiKey: string;
}

/** An Odoo call that failed. `auth` and `network` stop a sync run; anything else fails only the record being sent. */
export class OdooError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'remote' | 'config' = 'remote') {
    super(message);
  }
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9')
    || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}

/**
 * The URL is typed by a customer and called from our server, so it must be https and must not reach
 * our own network (the database, the API, the cloud metadata address). ODOO_ALLOW_PRIVATE=1 lifts this
 * for local tests only.
 */
export async function assertSafeUrl(url: string): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { throw new OdooError('رابط Odoo غير صالح', 'config'); }
  if (process.env.ODOO_ALLOW_PRIVATE === '1') return;
  if (u.protocol !== 'https:') throw new OdooError('رابط Odoo يجب أن يبدأ بـ https', 'config');
  let addrs: { address: string }[];
  try { addrs = await lookup(u.hostname, { all: true }); } catch { throw new OdooError('تعذر الوصول إلى عنوان Odoo', 'network'); }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new OdooError('رابط Odoo يشير إلى عنوان داخلي', 'config');
}

const errText = (d: unknown): string | null => {
  const o = d as { message?: string; error?: { message?: string; data?: { message?: string } } } | null;
  return o?.error?.data?.message ?? o?.message ?? o?.error?.message ?? null;
};

/**
 * Talks to one Odoo database. JSON-2 (`POST /json/2/<model>/<method>`, bearer API key) for Odoo 19 and later;
 * the legacy JSON-RPC endpoint for older versions, which Odoo removes in version 22.
 */
export class OdooClient {
  private uid: number | null = null;
  private seq = 0;

  constructor(private readonly c: OdooConn, private readonly timeoutMs = 20_000) {}

  private async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    await assertSafeUrl(this.c.baseUrl);
    let res: Response;
    try {
      res = await fetch(this.c.baseUrl.replace(/\/+$/, '') + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'fleet-odoo-connector/1', ...headers },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new OdooError(`تعذر الاتصال بـ Odoo: ${(e as Error).message}`.slice(0, 300), 'network');
    }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new OdooError('رفض Odoo مفتاح الـ API أو الصلاحية', 'auth');
    if (res.status >= 300 && res.status < 400) throw new OdooError(`أعاد Odoo تحويلًا (${res.status}): تأكد من الرابط`, 'config');
    if (res.status === 404) throw new OdooError('الرابط لا يعرض واجهة Odoo المطلوبة (404): تأكد من النسخة ونوع الربط', 'config');
    if (!res.ok) throw new OdooError(`خطأ من Odoo (${res.status}): ${errText(data) ?? text.slice(0, 200)}`.slice(0, 450));
    return data;
  }

  private async rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
    const r = await this.post('/jsonrpc', { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: ++this.seq }) as
      { result?: unknown; error?: unknown } | null;
    if (r?.error) {
      const msg = errText(r) ?? 'unknown error';
      if (/access ?denied|authentic/i.test(msg)) throw new OdooError('رفض Odoo بيانات الدخول', 'auth');
      throw new OdooError(`خطأ من Odoo: ${msg}`.slice(0, 450));
    }
    return r?.result;
  }

  private async exec(model: string, method: string, json2: Record<string, unknown>, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    if (this.c.protocol === 'json2') {
      const headers: Record<string, string> = { Authorization: `bearer ${this.c.apiKey}` };
      if (this.c.database) headers['X-Odoo-Database'] = this.c.database;
      return this.post(`/json/2/${model}/${method}`, json2, headers);
    }
    if (this.uid === null) {
      const uid = await this.rpc('common', 'authenticate', [this.c.database, this.c.login, this.c.apiKey, {}]);
      if (typeof uid !== 'number' || uid <= 0) throw new OdooError('رفض Odoo بيانات الدخول', 'auth');
      this.uid = uid;
    }
    return this.rpc('object', 'execute_kw', [this.c.database, this.uid, this.c.apiKey, model, method, args, kwargs]);
  }

  async searchRead<T = Record<string, unknown>>(model: string, domain: unknown[], fields: string[], limit?: number): Promise<T[]> {
    const opts: Record<string, unknown> = { fields };
    if (limit) opts.limit = limit;
    const r = await this.exec(model, 'search_read', { domain, ...opts }, [domain], opts);
    if (!Array.isArray(r)) throw new OdooError('رد غير متوقع من Odoo');
    return r as T[];
  }

  async create(model: string, vals: Record<string, unknown>): Promise<number> {
    const r = await this.exec(model, 'create', { vals_list: [vals] }, [[vals]]);
    const id = Array.isArray(r) ? r[0] : r;
    if (typeof id !== 'number') throw new OdooError('لم يُعد Odoo رقم السجل الجديد');
    return id;
  }

  async call(model: string, method: string, ids: number[]): Promise<unknown> {
    return this.exec(model, method, { ids }, [ids]);
  }
}
