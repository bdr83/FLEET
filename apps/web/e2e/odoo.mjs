// Browser test of the Odoo accounting link: the office links its Odoo from Settings, maps the accounts,
// tests the connection, records a customer payment and syncs it; the entry lands in a fake Odoo as one posted move.
// Run: node e2e/odoo.mjs   (needs the API with OTP_DEV_ECHO=1 and ODOO_ALLOW_PRIVATE=1 on API_URL, and the web app on WEB_URL)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

// A fake Odoo 19 speaking JSON-2
const KEY = 'odoo-e2e-key';
const db = {
  'account.journal': [{ id: 3, name: 'Miscellaneous Operations', company_id: [1, 'Fleet Co'] }],
  'res.company': [{ id: 1, currency_id: [2, 'KWD'] }],
  'account.account': [{ id: 11, code: '101100' }, { id: 12, code: '101200' }, { id: 13, code: '121000' }, { id: 14, code: '400000' }],
  'res.partner': [], 'account.move': [],
};
const match = (r, dom) => dom.every(([f, op, v]) => { const x = Array.isArray(r[f]) ? r[f][0] : r[f]; return op === 'in' ? v.includes(x) : x === v; });
const odoo = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const p = JSON.parse(raw || '{}');
  const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  const m = req.url.match(/^\/json\/2\/([\w.]+)\/(\w+)$/);
  if (!m) return send(404, {});
  if (req.headers.authorization !== `bearer ${KEY}`) return send(401, { message: 'Access Denied' });
  const t = (db[m[1]] ??= []);
  if (m[2] === 'search_read') return send(200, t.filter((r) => match(r, p.domain)).slice(0, p.limit ?? 999));
  if (m[2] === 'create') return send(200, p.vals_list.map((v) => { const id = 500 + t.length; t.push({ ...v, id, state: 'draft' }); return id; }));
  if (m[2] === 'action_post') { for (const id of p.ids) t.find((r) => r.id === id).state = 'posted'; return send(200, true); }
  send(400, { message: 'unknown' });
});
await new Promise((r) => odoo.listen(0, '127.0.0.1', r));
const ODOO_URL = `http://127.0.0.1:${odoo.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-fp-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);

try {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("الدخول برقم الجوال")');
  await page.fill('input[name=phone]', `+9659${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'نقليات تجريبية');
  await page.check('input[name=pack-delivery]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const cu = await call('POST', '/customers', { legal_entity_id: le, name: 'متجر اللؤلؤة' });
  ok('شركة جديدة وعميل');

  await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle' });
  await page.click('button[role=tab]:text-is("الربط مع Odoo")');
  await page.locator('h2:has-text("مع Odoo")').waitFor();
  await page.fill('input[placeholder="https://mycompany.odoo.com"]', ODOO_URL);
  await page.fill('input[type=password]', KEY);
  await page.locator('label:has-text("رقم دفتر اليومية") input').fill('3');
  for (const [ours, theirs] of [['1000', '101100'], ['1010', '101200'], ['1100', '121000'], ['4000', '400000']]) {
    await page.locator(`tr:has(td span.num:text-is("${ours}")) input`).fill(theirs);
  }
  await shot(page, 'odoo-1-form');
  await page.click('button:has-text("حفظ")');
  await page.locator('h2:has-text("حالة المزامنة")').waitFor();
  ok('الربط محفوظ وظهرت حالة المزامنة');

  await page.click('button:has-text("اختبر الاتصال")');
  await page.locator('.alert.ok:has-text("الاتصال يعمل")').waitFor();
  await page.locator('.alert.ok:has-text("Miscellaneous Operations")').waitFor();
  ok('اختبار الاتصال: الدفتر والحسابات موجودة');

  const pay = await call('POST', '/payments', { customer_id: cu.id, amount: '25.000', method: 'knet', reference: 'K-1' });
  if (!pay.id) throw new Error(JSON.stringify(pay));
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('button[role=tab]:text-is("الربط مع Odoo")');
  await page.locator('.kpi:has-text("بانتظار الإرسال") .v:text-is("1")').waitFor();
  await page.click('button:has-text("زامن الآن")');
  await page.locator('.alert.ok:has-text("أُرسل 1 قيد")').waitFor();
  await page.locator('.kpi:has-text("أُرسلت") .v:text-is("1")').waitFor();
  const move = db['account.move'][0];
  if (!move || move.state !== 'posted' || move.journal_id !== 3 || move.line_ids.length !== 2) throw new Error(`unexpected move ${JSON.stringify(move)}`);
  if (db['res.partner'][0]?.name !== 'متجر اللؤلؤة') throw new Error('partner not created');
  await shot(page, 'odoo-2-synced');
  ok('دفعة KNET وصلت Odoo كقيد مرحّل واحد والعميل شريك');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log('PASS odoo');
} catch (e) {
  await shot(page, 'odoo-fail');
  console.error('FAIL', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  odoo.close();
}
