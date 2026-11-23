// Browser test of the tour pack: an agency's cross-border group trip with an itinerary and a price, two buses with their
// drivers until the seats cover the group, the passenger list (an ID needed across the border), the exceptions and the report.
// Run: node e2e/tour.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=company]', 'رحلات النوخذة التجريبية');
  await page.check('input[name=pack-tour]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الحافلات السياحية")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'مكتب الرحاب للسياحة', kind: 'business' });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `50-${stamp.slice(-5)}`, capacity: { seats: 50 } });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `30-${stamp.slice(-5)}`, capacity: { seats: 30 } });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فهد', phone: `+9656${stamp}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'ناصر', phone: `+9655${stamp}` });
  ok('شركة بنشاط الحافلات السياحية، مع مكتب سياحة وحافلتين (50 و30 مقعدًا) وسائقين');

  await page.click('nav a:has-text("الحافلات السياحية")');
  await page.locator('h1:has-text("الحافلات السياحية")').waitFor();
  await page.click('button:has-text("رحلة جديدة")');
  await page.selectOption('.modal select[name=customer_id]', { label: 'مكتب الرحاب للسياحة' });
  await page.fill('.modal input[name=group_name]', 'عمرة رجب');
  await page.fill('.modal input[name=pax]', '60');
  await page.fill('.modal input[name=contact_name]', 'أبو خالد');
  await page.fill('.modal input[name=contact_phone]', '+96599887766');
  await page.selectOption('.modal select[name=cross_border]', 'yes');
  await page.fill('.modal input[name=pickup]', 'الجهراء، مسجد الدولة');
  await page.fill('.modal input[name=destination]', 'مكة المكرمة');
  await page.fill('.modal textarea[name=itinerary]', 'منفذ السالمي\nالرياض\nمكة المكرمة');
  await page.fill('.modal input[name=price]', '1800');
  await page.fill('.modal input[name=deposit]', '500');
  await page.click('.modal button:has-text("حفظ الرحلة")');
  await page.locator('.modal :text("رحلة TR-1")').first().waitFor();
  await page.locator('.modal :text("مقاعد ناقصة")').first().waitFor();
  await page.locator('.modal :text("منفذ السالمي ← الرياض ← مكة المكرمة")').waitFor();
  ok('رحلة عمرة عبر الحدود لستين راكبًا ببرنامج وسعر 1800 وعربون 500: مقاعد ناقصة');

  await page.locator('.modal select[name=asset_id] option').nth(2).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', { label: `50-${stamp.slice(-5)} · 50 مقعد` });
  await page.selectOption('.modal select[name=driver_worker_id]', { label: 'فهد' });
  await page.click('.modal button:has-text("إضافة حافلة")');
  await page.locator('.modal [data-testid=trip-buses] tr:has-text("فهد")').waitFor();
  await page.locator('.modal :text("ينقص 10 مقعد")').waitFor();
  await page.locator('.modal select[name=asset_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', { label: `30-${stamp.slice(-5)} · 30 مقعد` });
  await page.selectOption('.modal select[name=driver_worker_id]', { label: 'ناصر' });
  await page.click('.modal button:has-text("إضافة حافلة")');
  await page.locator('.modal [data-testid=trip-buses] tr:has-text("ناصر")').waitFor();
  await page.locator('.modal :text("جاهزة")').first().waitFor();
  ok('حافلة فهد (50) ثم حافلة ناصر (30): 80 مقعدًا لستين راكبًا والرحلة جاهزة');

  await page.fill('.modal textarea[name=manifest]', 'علي أحمد، 280010112345، كويتي، +96599001122، 1\nعمر سالم');
  await page.click('.modal button:has-text("حفظ الكشف")');
  await page.locator('.modal .alert:has-text("id_required")').waitFor();
  await page.fill('.modal textarea[name=manifest]', 'علي أحمد، 280010112345، كويتي، +96599001122، 1\nعمر سالم، P1234567، مصري، ، 2');
  await page.click('.modal button:has-text("حفظ الكشف")');
  await page.locator('.modal [data-testid=manifest] tr:has-text("P1234567")').waitFor();
  await page.locator('.modal :text("كشف الركاب · 2 من 60")').waitFor();
  await shot(page, 'tr-trip');
  ok('كشف الركاب: يُرفض راكب بلا هوية في رحلة الحدود، ثم يُحفظ راكبان بهويتيهما وحافلتيهما');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=trips] tr:has-text("TR-1"):has-text("جاهزة"):has-text("60 / 80")').waitFor();
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-manifest] tr:has-text("TR-1"):has-text("2 من 60")').waitFor();
  ok('الاستثناءات: رحلة حدود تبدأ غدًا وكشفها ناقص (2 من 60)');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(5));
  await page.locator('[data-testid=tr-customers] tr:has-text("مكتب الرحاب للسياحة"):has-text("1800.000"):has-text("500.000")').waitFor();
  await shot(page, 'tr-report');
  ok('التقرير: مكتب الرحاب برحلة واحدة وحافلتين ومبلغ 1800.000 وعربون 500.000');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص الحافلات السياحية: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'tr-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
