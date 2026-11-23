// Browser test of the furniture moving pack: a company opens a move for a new customer, records the survey with the item
// list, quotes, marks the customer's acceptance with the deposit, books the truck, driver and a helper, the driver unloads
// (through the API), the office closes with extras and the rating, records and settles a damage claim, then checks the
// exceptions and the report.
// Run: node e2e/moving.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
const kwLocal = (plusH) => new Date(Date.now() + (3 + plusH) * 3_600_000).toISOString().slice(0, 16);

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
  await page.fill('input[name=company]', 'نقل الأثاث التجريبية');
  await page.check('input[name=pack-moving]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("نقل الأثاث")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const dphone = `+9656${stamp}`;
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق النقل', phone: dphone });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'عامل التغليف', phone: `+9659${stamp}` });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `MV-${stamp.slice(-5)}` });
  ok('شركة بنشاط نقل الأثاث، مع سائق وعامل وشاحنة');

  await page.click('nav a:has-text("نقل الأثاث")');
  await page.locator('h1:has-text("نقل الأثاث")').waitFor();
  await page.click('button:has-text("طلب نقل جديد")');
  await page.selectOption('.modal select[name=customer_id]', 'new');
  await page.fill('.modal input[name=new_name]', 'بو فهد');
  await page.fill('.modal input[name=phone]', '+96550003333');
  await page.fill('.modal input[name=f_area]', 'السالمية');
  await page.fill('.modal input[name=f_block]', '10');
  await page.fill('.modal input[name=f_floor]', '3');
  await page.fill('.modal input[name=t_area]', 'الجابرية');
  await page.fill('.modal input[name=t_block]', '4');
  await page.selectOption('.modal select[name=home_size]', 'apt_2');
  await page.fill('.modal input[name=move_at]', kwLocal(1));
  await page.check('.modal input[name=packing]');
  await page.click('.modal button:has-text("حفظ الطلب")');
  await page.locator('[data-testid=moves] tr:has-text("بو فهد"):has-text("السالمية، ق 10، الدور 3 ← الجابرية، ق 4"):has-text("بانتظار المعاينة والسعر")').waitFor();
  ok('طلب نقل شقة غرفتين لعميل جديد مع التغليف: بانتظار المعاينة والسعر');

  await page.click('[data-testid=moves] tr:has-text("بو فهد") button:has-text("إدارة")');
  await page.locator('.modal dd:has-text("5 ساعات · 3 عمال · تغليف")').waitFor();
  await page.fill('.modal input[name=volume]', '30.5');
  await page.fill('.modal textarea[name=items]', 'الصالة: كنبة × 2\nالصالة: تلفزيون × 1 *\nثلاجة');
  await page.click('.modal button:has-text("حفظ المعاينة")');
  await page.locator('.modal dd:has-text("30.5 م³ · 4 قطعة")').waitFor();
  await page.fill('.modal input[name=quote]', '120');
  await page.fill('.modal input[name=deposit]', '30');
  await page.click('.modal button:has-text("إرسال السعر")');
  await page.locator('.modal .badge:has-text("بانتظار رد العميل")').waitFor();
  await page.click('.modal button:has-text("وافق دون عربون بعد")');
  await page.locator('.modal .badge:has-text("العربون غير مدفوع")').waitFor();
  await page.click('.modal button:has-text("استُلم العربون")');
  await page.locator('.modal .badge:has-text("العربون مدفوع")').waitFor();
  ok('المعاينة 30.5 م³ و4 قطع، السعر 120 والعربون 30، وافق العميل ثم دفع العربون');

  await page.selectOption('.modal select[name=driver]', { label: 'سائق النقل' });
  await page.selectOption('.modal select[name=truck]', { label: `MV-${stamp.slice(-5)}` });
  await page.check('.modal [data-testid=helpers] label:has-text("عامل التغليف") input');
  await page.click('.modal button:has-text("حجز")');
  await page.locator('.modal [data-testid=crew] tr:has-text("السائق"):has-text("سائق النقل")').waitFor();
  await page.locator('.modal [data-testid=crew] tr:has-text("عامل"):has-text("عامل التغليف")').waitFor();
  await shot(page, 'mv-booked');
  ok('حجز الشاحنة والسائق وعامل لنفس النافذة');

  // the driver loads and unloads from the app (through the API here; the app is tested in driver_moving.mjs)
  const job = (await call('GET', '/moving/jobs')).data[0];
  const d = await call('GET', `/moving/jobs/${job.id}`);
  const lead = d.crew.find((x) => x.role === 'lead');
  const otp = await apiCall('POST', '/v1/auth/otp/request', { phone: dphone });
  const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone: dphone, code: otp.dev_code });
  const dtok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
  const sync = async (op) => (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: new Date().toISOString(), task_id: lead.task_id, ...op }] }, dtok)).results[0];
  for (const op of [{ type: 'task_status', to_status: 'accepted' }, { type: 'task_status', to_status: 'in_progress' }, { type: 'milestone', code: 'loaded' },
    { type: 'milestone', code: 'unloaded', received_by: 'بو فهد' }, { type: 'task_status', to_status: 'completed' }]) {
    const r = await sync(op);
    if (r.result !== 'applied') throw new Error(`driver op ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  }
  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('[data-testid=moves] tr:has-text("بو فهد") button:has-text("إدارة")');
  await page.locator('.modal .badge:has-text("وصل، جاهز للإغلاق")').waitFor();
  await page.fill('.modal input[name=extra]', '15');
  await page.selectOption('.modal select[name=rating]', '4');
  await page.click('.modal button:has-text("إغلاق الطلب")');
  await page.locator('.modal dd:has-text("الإجمالي"):has-text("135.000")').waitFor();
  await page.locator('.modal dd:has-text("★★★★☆")').waitFor();
  ok('وصل النقل؛ أُغلق الطلب بمبلغ إضافي 15 (الإجمالي 135) وتقييم 4 من 5');

  await page.fill('.modal input[name=c_item]', 'طاولة الطعام');
  await page.fill('.modal input[name=c_desc]', 'خدش في السطح');
  await page.fill('.modal input[name=c_amount]', '25');
  await page.click('.modal button:has-text("تسجيل مطالبة")');
  await page.locator('.modal [data-testid=claims] tr:has-text("طاولة الطعام"):has-text("مفتوحة")').waitFor();
  await page.fill('.modal input[name=settle]', '10');
  await page.click('.modal [data-testid=claims] button:has-text("تسوية")');
  await page.locator('.modal [data-testid=claims] tr:has-text("سُوّيت"):has-text("10.000")').waitFor();
  await shot(page, 'mv-closed');
  ok('مطالبة ضرر على طاولة الطعام سُوّيت بـ 10');

  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.locator('[data-testid=mv-kpis]:has-text("135.000"):has-text("4 / 5"):has-text("100%")').waitFor();
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('.kpi:has-text("مطالبات مفتوحة")').waitFor();
  await shot(page, 'mv-report');
  ok('التقرير: الإيراد 135 والتقييم 4 ونسبة قبول العروض 100%، والاستثناءات');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص نقل الأثاث: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'mv-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
