// Browser test of the oilgas pack: a site in an H2S zone with the documents its drivers and vehicles must hold, a journey
// plan with a hazardous load, a driver without the documents offered but blocked, the assignment, the journey manager's
// approval, journey alarms and the report.
// Run: node e2e/oilgas.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=company]', 'خدمات الحقول التجريبية');
  await page.check('input[name=pack-oilgas]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("النفط والغاز")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'شركة الحفر الوطنية', kind: 'business' });
  const van = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'van', plate_no: `14-${stamp.slice(-5)}`, capacity: { seats: 14 } });
  const d1 = await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'عبدالله', phone: `+9656${stamp}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'حسين', phone: `+9655${stamp}` });
  for (const t of ['h2s', 'site_pass', 'hazmat']) await call('POST', '/documents', { worker_id: d1.id, doc_type: t, expires_on: kwDay(200) });
  await call('POST', '/documents', { asset_id: van.id, doc_type: 'site_sticker', expires_on: kwDay(100) });
  ok('شركة خدمات نفطية بمشغّل وفان 14 راكبًا وسائقين، أحدهما بوثائق H2S وتصريح الموقع والمواد الخطرة');

  await page.click('nav a:has-text("النفط والغاز")');
  await page.locator('h1:has-text("خدمات النفط والغاز")').waitFor();
  await page.click('button[role=tab]:text-is("المواقع")');
  await page.fill('input[name=code]', 'BRG-GC1');
  await page.fill('input[name=name]', 'مركز تجميع 1');
  await page.fill('input[name=field]', 'برقان');
  await page.selectOption('select[name=customer_id]', { label: 'شركة الحفر الوطنية' });
  await page.selectOption('select[name=h2s]', 'yes');
  await page.fill('input[name=checkin_min]', '30');
  await page.click('button:has-text("إضافة الموقع")');
  await page.locator('[data-testid=og-sites] tr:has-text("BRG-GC1"):has-text("دورة H2S"):has-text("ملصق دخول المركبة")').waitFor();
  ok('موقع مركز تجميع 1 في برقان، منطقة H2S، وثائق السائق والمركبة، وبلاغ كل 30 دقيقة');

  await page.click('button[role=tab]:text-is("رحلات اليوم")');
  await page.click('button:has-text("خطة رحلة جديدة")');
  await page.locator('.modal select[name=site_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=site_id]', { index: 1 });
  await page.fill('.modal input[name=from_place]', 'قاعدة الأحمدي');
  await page.fill('.modal input[name=passengers]', '8');
  await page.fill('.modal input[name=cargo]', 'أسطوانات نيتروجين');
  await page.selectOption('.modal select[name=hazmat]', 'yes');
  await page.click('.modal button:has-text("حفظ الخطة")');
  await page.locator('.modal :text("خطة الرحلة JM-1")').first().waitFor();
  await page.locator('.modal [data-testid=journey-approval]:has-text("لم تُعتمد بعد")').waitFor();
  ok('خطة رحلة JM-1 لطاقم من 8 مع حمولة خطرة: بانتظار الاعتماد');

  await page.locator('.modal select[name=driver_worker_id] option').nth(2).waitFor({ state: 'attached' });
  const blocked = page.locator('.modal select[name=driver_worker_id] option:has-text("حسين")');
  const bh = await blocked.evaluate((o) => o.outerHTML);
  if (!bh.includes('disabled') || !bh.includes('ينقص')) throw new Error(`a driver without the documents should be shown as blocked: ${bh}`);
  await page.selectOption('.modal select[name=asset_id]', { index: 1 });
  await page.selectOption('.modal select[name=driver_worker_id]', { label: 'عبدالله' });
  await page.click('.modal button:has-text("إسناد")');
  await page.locator('.modal [data-testid=journey-driver]:has-text("عبدالله")').waitFor();
  await page.click('.modal button:has-text("اعتماد الخطة")');
  await page.locator('.modal [data-testid=journey-approval]:has-text("اعتمدها")').waitFor();
  await page.locator('.modal :text("جاهزة")').first().waitFor();
  await shot(page, 'og-journey');
  ok('حسين يظهر ممنوعًا لنقص وثائقه، عبدالله يُسند بالفان، ثم تُعتمد الخطة وتصبح جاهزة');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=journeys] tr:has-text("JM-1"):has-text("جاهزة"):has-text("خطرة")').waitFor();
  await page.click('button[role=tab]:text-is("إدارة الرحلات")');
  await page.locator('section:has-text("فات موعد البلاغ")').first().waitFor();
  ok('إدارة الرحلات: لوحة البلاغات الفائتة والتأخير والاعتماد وفحوص المركبات');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(1));
  await page.locator('[data-testid=og-report] tr:has-text("BRG-GC1"):has-text("شركة الحفر الوطنية")').waitFor();
  await shot(page, 'og-report');
  ok('التقرير حسب الموقع: BRG-GC1 للمشغّل شركة الحفر الوطنية');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص النفط والغاز: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'og-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
