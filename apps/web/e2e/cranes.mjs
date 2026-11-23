// Browser test of the cranes pack: a cranes-only company reaches the equipment hires; the crane's load chart; a lift plan
// over capacity refused, a critical one approved; the office records it done with the wind (over the limit refused);
// exceptions and the report.
// Run: node e2e/cranes.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
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
  await page.fill('input[name=phone]', `+9659${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'رافعات تجريبية');
  await page.check('input[name=pack-cranes]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الرافعات")').waitFor();
  await page.locator('nav a:has-text("تأجير المعدات")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const cu = await call('POST', '/customers', { legal_entity_id: le, name: 'مقاولات البناء' });
  const crane = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'crane', plate_no: `MC-${stamp.slice(-5)}`, make: 'Tadano' });
  const op = await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مشغّل الرافعة', phone: `+9656${stamp}` });
  const rg = await call('POST', '/workers', { legal_entity_id: le, kind: 'technician', display_name: 'الموجّه سالم', phone: `+9655${stamp}` });
  await call('POST', '/documents', { asset_id: crane.id, doc_type: 'tpi_certificate', expires_on: kwDay(200) });
  await call('POST', '/documents', { worker_id: op.id, doc_type: 'crane_operator', expires_on: kwDay(200) });
  await call('POST', '/documents', { worker_id: rg.id, doc_type: 'rigger_cert', expires_on: kwDay(200) });
  const h = await call('POST', '/equipment/hires', { legal_entity_id: le, customer_id: cu.id, asset_id: crane.id, operator_worker_id: op.id, site: { name: 'برج الشرق', area: 'الشرق' },
    starts_on: kwDay(0), ends_on: kwDay(1), shift_start: '00:00', shift_end: '23:59', work_days: [1, 2, 3, 4, 5, 6, 7], min_hours: 8 });
  if (!h.ref) throw new Error(`hire: ${JSON.stringify(h)}`);
  ok(`شركة رافعات فقط (القائمة فيها الرافعات وتأجير المعدات)، رافعة بشهادة فحص، مشغّل وموجّه بشهاداتهما، وعقد تأجير ${h.ref}`);

  await page.click('nav a:has-text("الرافعات")');
  await page.locator('h1:has-text("الرافعات وخطط الرفع")').waitFor();
  await page.click('button[role=tab]:text-is("الرافعات وجداول الحمولة")');
  await page.locator('[data-testid=cranes-fleet] tr:has-text("لا جدول")').waitFor();
  await page.click('[data-testid=cranes-fleet] button:has-text("الجدول")');
  await page.fill('.modal input[name=max_capacity_t]', '50');
  await page.fill('.modal input[name=boom_m]', '40');
  await page.fill('.modal input[name=wind_limit_ms]', '9');
  await page.fill('.modal textarea[name=chart]', '3 50\n10 20\n20 8\n30 4');
  await page.click('.modal button:has-text("حفظ الجدول")');
  await page.locator('[data-testid=cranes-fleet] tr:has-text("4 صف"):has-text("9 م/ث")').waitFor();
  await shot(page, 'cr-fleet');
  ok('جدول حمولة الرافعة من كتيّب المصنّع: 4 صفوف من 50 طن عند 3 م إلى 4 طن عند 30 م، وحد رياح 9 م/ث');

  await page.click('button[role=tab]:text-is("رفعات اليوم")');
  await page.click('button:has-text("خطة رفع جديدة")');
  await page.locator('.modal select[name=hire_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=hire_id]', { index: 1 });
  await page.fill('.modal input[name=lift_time]', '09:30');
  await page.fill('.modal input[name=description]', 'رفع مولد كهرباء');
  await page.fill('.modal input[name=load_t]', '9');
  await page.fill('.modal input[name=radius_m]', '15');
  await page.locator('.modal select[name=rigger_worker_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=rigger_worker_id]', { label: 'الموجّه سالم' });
  await page.click('.modal button:has-text("حفظ الخطة")');
  await page.locator('.modal .alert:has-text("over_capacity")').waitFor();
  await page.fill('.modal input[name=load_t]', '16');
  await page.fill('.modal input[name=radius_m]', '10');
  await page.click('.modal button:has-text("حفظ الخطة")');
  await page.locator('.modal [data-testid=lift-calc]:has-text("80%")').waitFor();
  await page.locator('.modal [data-testid=lift-approval]:has-text("لم تُعتمد")').waitFor();
  ok('9 طن عند 15 م مرفوضة (أكثر من 8 طن المقنّنة)، و16 طن عند 10 م = 80% من 20 طن: رفعة حرجة بانتظار الاعتماد');

  await page.click('.modal button:has-text("اعتماد الرفعة الحرجة")');
  await page.locator('.modal [data-testid=lift-approval]:has-text("اعتمدها")').waitFor();
  await page.fill('.modal input[name=wind_ms]', '11');
  await page.click('.modal button:has-text("تسجيل التنفيذ من المكتب")');
  await page.locator('.modal .alert:has-text("wind_too_high")').waitFor();
  await page.fill('.modal input[name=wind_ms]', '6.5');
  await page.click('.modal button:has-text("تسجيل التنفيذ من المكتب")');
  await page.locator('.modal :text("نُفذت")').first().waitFor();
  await shot(page, 'cr-lift');
  ok('الاعتماد ثم التنفيذ: رياح 11 م/ث مرفوضة فوق حد الرافعة، و6.5 م/ث تُسجَّل منفذة');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=lifts] tr:has-text("رفع مولد كهرباء"):has-text("نُفذت"):has-text("6.5")').waitFor();
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('section:has-text("رفعات حرجة اليوم أو غدًا لم تُعتمد")').first().waitFor();
  ok('الاستثناءات: الرفعات الحرجة بلا اعتماد والمفتوحة والموقوفة وشهادات الرافعات');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(1));
  await page.locator('[data-testid=cr-report] tr:has-text("مقاولات البناء")').waitFor();
  await shot(page, 'cr-report');
  ok('التقرير حسب العميل: مقاولات البناء، رفعة حرجة منفذة بأعلى استخدام 80%');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص الرافعات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'cr-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
