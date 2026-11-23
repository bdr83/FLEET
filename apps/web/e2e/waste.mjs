// Browser test of the waste pack: a collection route with a truck, driver and landfill; ordered collection points with
// the customer's bins; the day's round generated; the office records a point collected, one missed and a weighbridge
// ticket; exceptions and the report.
// Run: node e2e/waste.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// the round started an hour ago, Kuwait time
const startHm = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(11, 16);
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
  await page.fill('input[name=company]', 'نظافة تجريبية');
  await page.check('input[name=pack-waste]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("جمع النفايات")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'جمعية السالمية' });
  const truck = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CP-${stamp.slice(-5)}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق الكابسة', phone: `+9656${stamp}` });
  if (!truck.id) throw new Error(JSON.stringify(truck));
  ok('شركة نظافة بكابسة وسائق وعميل');

  await page.click('nav a:has-text("جمع النفايات")');
  await page.locator('h1:has-text("جمع النفايات")').waitFor();
  await page.click('button[role=tab]:text-is("الخطوط ونقاط الجمع")');
  await page.click('button:has-text("إضافة خط")');
  await page.fill('.modal input[name=code]', 'SAL-1');
  await page.fill('.modal input[name=name]', 'السالمية صباحًا');
  await page.fill('.modal input[name=start_time]', startHm);
  await page.fill('.modal input[name=hours]', '10');
  await page.fill('.modal input[name=facility]', 'مردم الجهراء');
  await page.locator('.modal select[name=asset_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', { index: 1 });
  await page.locator('.modal select[name=driver_worker_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=driver_worker_id]', { label: 'سائق الكابسة' });
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('[data-testid=ws-routes] tr:has-text("SAL-1"):has-text("مردم الجهراء")').waitFor();
  ok('خط SAL-1 بالكابسة والسائق، كل يوم، والتفريغ في مردم الجهراء');

  await page.click('[data-testid=ws-routes] tr:has-text("SAL-1") button:has-text("النقاط")');
  for (const [name, type, count] of [['جمعية السالمية الرئيسي', 'bin_1100', '4'], ['فرع الجمعية ق 10', 'bin_240', '6']]) {
    await page.fill('.modal input[name=name]', name);
    await page.fill('.modal input[name=area]', 'السالمية');
    await page.locator('.modal select[name=customer_id] option').nth(1).waitFor({ state: 'attached' });
    await page.selectOption('.modal select[name=customer_id]', { label: 'جمعية السالمية' });
    await page.selectOption('.modal select[name=bin_type]', type);
    await page.fill('.modal input[name=count]', count);
    await page.click('.modal button:has-text("إضافة النقطة")');
    await page.locator(`.modal [data-testid=ws-points] tr:has-text("${name}")`).waitFor();
  }
  await page.locator('.modal [data-testid=ws-points] tr:has-text("4 × حاوية 1100 لتر")').waitFor();
  await shot(page, 'ws-points');
  ok('نقطتا جمع بالترتيب: 4 حاويات 1100 لتر و6 حاويات 240 لتر');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.click('button[role=tab]:text-is("جولات اليوم")');
  await page.click('button:has-text("توليد جولات اليوم")');
  await page.locator('[data-testid=gen-result]:has-text("أُنشئ 1")').waitFor();
  await page.locator('[data-testid=runs] tr:has-text("SAL-1"):has-text("0 / 2")').waitFor();
  await page.click('[data-testid=runs] tr:has-text("SAL-1") button:has-text("فتح")');
  await page.click('.modal button[aria-label="جُمعت جمعية السالمية الرئيسي"]');
  await page.locator('.modal [data-testid=round-sheet] tr:has-text("جمعية السالمية الرئيسي"):has-text("جُمعت")').waitFor();
  await page.selectOption('.modal select[aria-label="لم تُجمع فرع الجمعية ق 10"]', 'blocked');
  await page.locator('.modal [data-testid=round-sheet] tr:has-text("فرع الجمعية ق 10"):has-text("مغلقة بسيارة")').waitFor();
  await page.fill('.modal input[name=ticket_no]', 'JH-88120');
  await page.fill('.modal input[name=net_kg]', '5240');
  await page.click('.modal button:has-text("تسجيل تذكرة")');
  await page.locator('.modal [data-testid=tickets] tr:has-text("JH-88120"):has-text("مردم الجهراء")').waitFor();
  await shot(page, 'ws-run');
  ok('الجولة مولّدة؛ المكتب يسجّل نقطة جُمعت وأخرى مغلقة بسيارة وتذكرة ميزان 5.24 طن');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-missed] tr:has-text("فرع الجمعية ق 10"):has-text("مغلقة بسيارة")').waitFor();
  ok('الاستثناءات: النقطة التي لم تُجمع اليوم بسببها');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(1));
  await page.locator('[data-testid=ws-report-routes] tr:has-text("SAL-1"):has-text("5.2")').waitFor();
  await page.locator('[data-testid=ws-report-customers] tr:has-text("جمعية السالمية")').waitFor();
  await shot(page, 'ws-report');
  ok('التقرير: الخط SAL-1 بـ 5.2 طن، والعميل جمعية السالمية');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص جمع النفايات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'ws-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
