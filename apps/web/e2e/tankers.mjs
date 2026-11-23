// Browser test of the tankers pack: a company registers a water and a diesel tanker, opens a water order for a new customer,
// the diesel tanker is not offered, assigns the water tanker, the driver fills and discharges (through the API) with a loss,
// a standing diesel order creates tomorrow's order, the office records it from the paper ticket, then exceptions and report.
// Run: node e2e/tankers.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const API = process.env.API_URL ?? 'http://localhost:3000';
const uuid = () => crypto.randomUUID();
async function apiCall(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const kwDay = (plus) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);

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
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'الصهاريج التجريبية');
  await page.check('input[name=pack-tankers]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الصهاريج")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const dphone = `+9656${stamp}`;
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التانكر', phone: dphone });
  const W = `TW-${stamp.slice(-5)}`, F = `TF-${stamp.slice(-5)}`;
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'tanker', plate_no: W });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'tanker', plate_no: F });
  const otp = await apiCall('POST', '/v1/auth/otp/request', { phone: dphone });
  const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone: dphone, code: otp.dev_code });
  const dtok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
  ok('شركة بنشاط الصهاريج، مع سائق وصهريجين');

  await page.click('nav a:has-text("الصهاريج")');
  await page.locator('h1:has-text("صهاريج المياه والديزل والوقود")').waitFor();
  await page.click('button[role=tab]:text-is("الصهاريج")');
  await page.fill(`input[aria-label="سعة ${W}"]`, '10000');
  await page.click(`[data-testid=tk-vehicles] tr:has-text("${W}") button:has-text("تسجيل كصهريج")`);
  await page.locator(`[data-testid=tk-vehicles] tr:has-text("${W}") .badge:has-text("صهريج ماء")`).waitFor();
  await page.selectOption(`select[aria-label="نوع ${F}"]`, 'fuel');
  await page.fill(`input[aria-label="سعة ${F}"]`, '20000');
  await page.click(`[data-testid=tk-vehicles] tr:has-text("${F}") button:has-text("تسجيل كصهريج")`);
  await page.locator(`[data-testid=tk-vehicles] tr:has-text("${F}") .badge:has-text("صهريج وقود")`).waitFor();
  ok('تسجيل صهريج ماء 10,000 لتر وصهريج وقود 20,000 لتر');

  await page.click('button[role=tab]:text-is("الطلبات")');
  await page.click('button:has-text("طلب جديد")');
  await page.selectOption('.modal select[name=customer_id]', 'new');
  await page.fill('.modal input[name=new_name]', 'إدارة عمارة 5');
  await page.fill('.modal input[name=site_name]', 'عمارة 5');
  await page.fill('.modal input[name=area]', 'حولي');
  await page.fill('.modal input[name=qty_l]', '8000');
  await page.fill('.modal input[name=unit_price]', '3.5');
  await page.click('.modal button:has-text("حفظ الطلب")');
  await page.locator('[data-testid=tk-orders] tr:has-text("إدارة عمارة 5"):has-text("ماء عذب"):has-text("8,000 لتر"):has-text("بلا صهريج")').waitFor();
  await page.click('[data-testid=tk-orders] tr:has-text("إدارة عمارة 5") button:has-text("إدارة")');
  await page.locator(`.modal select[name=tanker] option:has-text("${W}")`).waitFor({ state: 'attached' });
  const opts = await page.locator('.modal select[name=tanker] option').allTextContents();
  if (opts.some((o) => o.includes(F)) || !opts.some((o) => o.includes(W))) throw new Error(`tankers offered: ${opts}`);
  await page.selectOption('.modal select[name=tanker]', { label: `${W} · 10,000 لتر` });
  await page.selectOption('.modal select[name=driver]', { label: 'سائق التانكر' });
  await page.click('.modal button:has-text("إسناد")');
  await page.locator('.modal .badge:has-text("مسند")').waitFor();
  ok('طلب ماء 8,000 لتر؛ يُعرض صهريج الماء فقط، وأُسند');

  const ord = (await call('GET', `/tankers/orders`)).data[0];
  for (const op of [{ type: 'task_status', to_status: 'accepted' }, { type: 'task_status', to_status: 'in_progress' }, { type: 'milestone', code: 'tank_filled', litres: 8000, note: 'محطة الشويخ' },
    { type: 'milestone', code: 'tank_discharged', litres: 7600, received_by: 'الحارس' }, { type: 'task_status', to_status: 'completed' }]) {
    const r = (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: new Date().toISOString(), task_id: (await call('GET', `/tankers/orders/${ord.id}`)).task_id, ...op }] }, dtok)).results[0];
    if (r.result !== 'applied') throw new Error(`driver op ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  }
  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('[data-testid=tk-orders] tr:has-text("إدارة عمارة 5") button:has-text("إدارة")');
  await page.locator('.modal .badge:has-text("فاقد 400 لتر (5%)")').waitFor();
  await page.locator('.modal dd:has-text("7,600 لتر"):has-text("الحارس"):has-text("26.600")').waitFor();
  await shot(page, 'tk-order');
  ok('عُبّئ 8,000 وفُرّغ 7,600 للحارس: فاقد 5% فوق المسموح، والمبلغ 26.600');

  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("الطلبات الثابتة")');
  await page.selectOption('select[name=customer_id]', { label: 'إدارة عمارة 5' });
  await page.fill('input[name=area]', 'حولي');
  await page.selectOption('select[name=product]', 'diesel');
  await page.fill('input[name=qty_l]', '5000');
  for (const i of [0, 1, 2, 3, 4]) await page.uncheck(`[data-testid=tk-days] label:nth-child(${i + 1}) input`);
  const tomorrow = kwDay(1);
  const dow = new Date(`${tomorrow}T12:00:00Z`).getUTCDay();
  await page.check(`[data-testid=tk-days] label:nth-child(${dow + 1}) input`);
  await page.click('button:has-text("حفظ الطلب الثابت")');
  await page.locator('[data-testid=tk-schedules] tr:has-text("ديزل"):has-text("5,000 لتر")').waitFor();
  await page.fill('input[aria-label="يوم الإنشاء"]', tomorrow);
  await page.click('button:has-text("إنشاء طلبات اليوم")');
  await page.locator('[data-testid=tk-generated]:has-text("أُنشئ 1 طلب: TK-2")').waitFor();
  ok('طلب ثابت للديزل يوم الغد أنشأ الطلب TK-2');

  await page.click('button[role=tab]:text-is("الطلبات")');
  await page.fill('input[aria-label="اليوم"]', tomorrow);
  await page.click('[data-testid=tk-orders] tr:has-text("TK-2") button:has-text("إدارة")');
  await page.selectOption('.modal select[name=tanker]', { label: `${F} · 20,000 لتر` });
  await page.selectOption('.modal select[name=driver]', { label: 'سائق التانكر' });
  await page.click('.modal button:has-text("إسناد")');
  await page.fill('.modal input[name=loaded]', '5000');
  await page.fill('.modal input[name=delivered]', '4990');
  await page.fill('.modal input[name=received_by]', 'مشرف المولد');
  await page.click('.modal button:has-text("تسجيل من الإيصال")');
  await page.locator('.modal .badge:has-text("وُصّل")').waitFor();
  ok('أُسند لصهريج الوقود وسُجّل من الإيصال الورقي: 4,990 لتر');

  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-losses] tr:has-text("TK-1")').waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', tomorrow);
  await page.locator('[data-testid=tk-kpis]:has-text("12,590 لتر"):has-text("410 لتر")').waitFor();
  await page.locator('[data-testid=tk-products] tr:has-text("ديزل"):has-text("4,990 لتر")').waitFor();
  await shot(page, 'tk-report');
  ok('الاستثناءات (فاقد TK-1) والتقرير: 12,590 لتر مفرّغة وفاقد 410');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص الصهاريج: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'tk-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
