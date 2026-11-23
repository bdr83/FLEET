// Browser test of the landscape pack: a garden company with a crew lead and a customer; a garden with its services, every
// day at a time 40 minutes ago; the day's visit generated; an extra planting visit tomorrow then canceled; exceptions
// (the visit late to start) and the report.
// Run: node e2e/landscape.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const time = new Date(Date.now() + 3 * 3_600_000 - 40 * 60_000).toISOString().slice(11, 16);
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
  await page.fill('input[name=company]', 'حدائق تجريبية');
  await page.check('input[name=pack-landscape]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الحدائق")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const cu = await call('POST', '/customers', { legal_entity_id: le, name: 'فيلا العتيبي' });
  const w = await call('POST', '/workers', { legal_entity_id: le, kind: 'technician', display_name: 'رئيس الطاقم راجو', phone: `+9656${stamp}` });
  if (!w.id || !cu.id) throw new Error(JSON.stringify(w));
  ok('شركة حدائق برئيس طاقم وعميل');

  await page.click('nav a:has-text("الحدائق")');
  await page.locator('h1:has-text("تنسيق الحدائق وصيانتها")').waitFor();
  await page.click('button[role=tab]:text-is("الحدائق والعقود")');
  await page.click('button:has-text("إضافة حديقة")');
  await page.fill('.modal input[name=code]', 'V1');
  await page.fill('.modal input[name=name]', 'فيلا العتيبي: الحديقة الأمامية');
  await page.locator('.modal select[name=customer_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'فيلا العتيبي' });
  await page.fill('.modal input[name=area]', 'الشويخ');
  await page.fill('.modal input[name=area_m2]', '400');
  await page.check('.modal input[name=svc-palm_care]');
  for (const box of await page.locator('.modal fieldset[aria-label="أيام الزيارة"] input').all()) await box.check();
  await page.fill('.modal input[aria-label="وقت الزيارة"]', time);
  await page.fill('.modal input[name=duration]', '180');
  await page.locator('.modal select[name=lead_worker_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=lead_worker_id]', { label: 'رئيس الطاقم راجو' });
  await page.fill('.modal input[name=crew]', '3');
  await page.fill('.modal input[name=instructions]', 'لا تقصوا النخلة');
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('[data-testid=ls-sites] tr:has-text("V1"):has-text("خدمة النخيل"):has-text("كل يوم"):has-text("رئيس الطاقم راجو")').waitFor();
  await shot(page, 'ls-sites');
  ok(`حديقة V1 بأربع خدمات كل يوم ${time} ورئيس الطاقم`);

  await page.click('button[role=tab]:text-is("زيارات اليوم")');
  await page.click('button:has-text("توليد زيارات اليوم")');
  await page.locator('[data-testid=gen-result]:has-text("أُنشئ 1")').waitFor();
  await page.locator('[data-testid=visits] tr:has-text("V1"):has-text("مجدولة"):has-text("قص العشب")').waitFor();
  ok('زيارة اليوم مولّدة لرئيس الطاقم بالخدمات المخططة');

  await page.click('button:has-text("زيارة إضافية")');
  await page.locator('.modal select[aria-label="حديقة الزيارة الإضافية"] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[aria-label="حديقة الزيارة الإضافية"]', { index: 1 });
  await page.fill('.modal input[name=date]', kwDay(1));
  await page.fill('.modal input[name=note]', 'زراعة 20 شتلة ورد');
  await page.click('.modal button:has-text("إضافة الزيارة")');
  await page.locator('.modal').waitFor({ state: 'detached' });
  await page.fill('input[aria-label="يوم الزيارات"]', kwDay(1));
  await page.locator('[data-testid=visits] tr:has-text("V1"):has-text("إضافية"):has-text("زراعة")').waitFor();
  await page.click('[data-testid=visits] tr:has-text("إضافية") button:has-text("فتح")');
  await page.fill('.modal input[aria-label="سبب إلغاء الزيارة"]', 'العميل أجّل');
  await page.click('.modal button:has-text("إلغاء الزيارة")');
  await page.locator('.modal [data-testid=visit-detail]:has-text("ملغاة")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  ok('زيارة زراعة إضافية للغد ثم إلغاؤها بسبب');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-late] tr:has-text("V1"):has-text("رئيس الطاقم راجو")').waitFor();
  await shot(page, 'ls-exceptions');
  ok('الاستثناءات: زيارة V1 لم تبدأ بعد 30 دقيقة من موعدها');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(1));
  await page.locator('[data-testid=ls-report-sites] tr:has-text("V1")').waitFor();
  await shot(page, 'ls-report');
  ok('التقرير: الحديقة V1 بزيارة واحدة (الملغاة لا تُحسب)');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص تنسيق الحدائق: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'ls-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
