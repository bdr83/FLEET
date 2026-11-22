// Browser test of the staff transport pack: a company adds a route for a customer's workers (stops, days, bus and
// driver), pastes the riders, generates tomorrow's trips (one skipped for lack of a driver), records a rider from the
// office, and checks the exceptions and the report.
// Run: node e2e/shuttle.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=company]', 'نقل العمال التجريبية');
  await page.check('input[name=pack-shuttle]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("نقل الموظفين")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'شركة المقاولات الوطنية' });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `77-${stamp.slice(-5)}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'راجو', phone: `+9656${stamp}` });
  ok('شركة بنشاط نقل الموظفين، مع عميل وحافلة وسائق');

  await page.click('nav a:has-text("نقل الموظفين")');
  await page.locator('h1:has-text("نقل الموظفين")').waitFor();
  await page.click('button[role=tab]:text-is("الخطوط والركاب")');
  for (const [code, withDriver] of [['R1', true], ['R2', false]]) {
    await page.click('button:has-text("إضافة خط")');
    await page.locator('.modal select[name=customer_id] option:has-text("شركة المقاولات")').waitFor({ state: 'attached' });
    await page.fill('.modal input[name=code]', code);
    await page.fill('.modal input[name=name]', code === 'R1' ? 'المهبولة ← المصفاة' : 'الجليب ← الشويخ');
    await page.selectOption('.modal select[name=customer_id]', { label: 'شركة المقاولات الوطنية' });
    await page.fill('.modal input[name=depart_time]', '05:30');
    await page.fill('.modal input[name=capacity]', '30');
    await page.fill('.modal [aria-label=المحطات]', code === 'R1' ? '0 | سكن المهبولة | المهبولة\n15 | الفنطاس\n50 | مصفاة الأحمدي' : '0 | الجليب\n40 | الشويخ الصناعية');
    await page.locator('.modal select[name=asset_id] option').nth(1).waitFor({ state: 'attached' });
    await page.selectOption('.modal select[name=asset_id]', { index: 1 });
    if (withDriver) await page.selectOption('.modal select[name=driver_worker_id]', { label: 'راجو' });
    await page.click('.modal button:has-text("حفظ")');
    await page.locator(`[data-testid=routes] tr:has-text("${code}")`).waitFor();
  }
  await page.locator('[data-testid=routes] tr:has-text("R1"):has-text("الأحد، الإثنين، الثلاثاء، الأربعاء، الخميس"):has-text("سكن المهبولة ← الفنطاس ← مصفاة الأحمدي")').waitFor();
  await page.locator('[data-testid=routes] tr:has-text("R2"):has-text("بلا سائق")').waitFor();
  ok('خطان للعميل: R1 بثلاث محطات من الأحد إلى الخميس، وR2 بلا سائق');

  await page.click('[data-testid=routes] tr:has-text("R1") button:has-text("الركاب")');
  await page.fill('.modal [aria-label=الركاب]', 'أنيل كومار,E-101,1,+96569001122\nمحمد رفيق,E-102,1\nجوزيف,E-103,2\nأنيل مكرر,E-101,2');
  await page.click('.modal button:has-text("إضافة الركاب")');
  await page.locator('[data-testid=riders-result]:has-text("أُضيف 3 · مكرر 1")').waitFor();
  await page.locator('.modal [data-testid=riders] tr:has-text("جوزيف"):has-text("الفنطاس")').waitFor();
  await shot(page, 's-riders');
  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=routes] tr:has-text("R1") td.num:text-is("3 / 30")').waitFor();
  ok('لصق 4 ركاب: أُضيف 3 والرقم الوظيفي المكرر لم يُضف');

  // tomorrow, or Sunday if tomorrow is a Friday or Saturday
  let plus = 1;
  while ([5, 6].includes(new Date(`${kwDay(plus)}T12:00:00Z`).getUTCDay())) plus++;
  const day = kwDay(plus);
  await page.click('button[role=tab]:text-is("رحلات اليوم")');
  await page.fill('[aria-label="يوم الرحلات"]', day);
  await page.click('button:has-text("توليد رحلات اليوم")');
  await page.locator('[data-testid=gen-result]:has-text("أُنشئ 1"):has-text("R2: بلا سائق")').waitFor();
  await page.locator('[data-testid=trips] tr:has-text("R1"):has-text("05:30"):has-text("مسندة"):has-text("0 / 3")').waitFor();
  await page.click('button:has-text("توليد رحلات اليوم")');
  await page.locator('[data-testid=gen-result]:has-text("أُنشئ 0 · موجود 1")').waitFor();
  ok(`توليد رحلات ${day}: رحلة R1 مسندة للحافلة والسائق، وR2 تخطاها لعدم وجود سائق، والتوليد الثاني لا يكرر`);

  await page.click('[data-testid=trips] tr:has-text("R1") button:has-text("الركاب")');
  await page.locator('.modal h3:has-text("05:45"):has-text("الفنطاس")').waitFor();
  await page.click('.modal [aria-label="صعد أنيل كومار"]');
  await page.click('.modal [aria-label="غائب جوزيف"]');
  await page.locator('.modal [data-testid=manifest-1] tr:has-text("أنيل كومار"):has-text("صعد"):has-text("(المكتب)")').waitFor();
  await page.locator('.modal [data-testid=manifest-2] tr:has-text("جوزيف"):has-text("غائب")').waitFor();
  await shot(page, 's-manifest');
  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=trips] tr:has-text("R1"):has-text("1 / 3"):has-text("غائب 1")').waitFor();
  ok('كشف الركاب بالمحطات ومواعيدها، وتسجيل المكتب لصعود راكب وغياب آخر');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.fill('input[type=date]', day);
  await page.locator('[data-testid=ex-missing] tr:has-text("R2"):has-text("بلا سائق")').waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', day);
  await page.locator('[data-testid=sh-report] tr:has-text("شركة المقاولات الوطنية")').waitFor();
  await shot(page, 's-report');
  ok('الاستثناءات (R2 بلا سائق) والتقرير لكل عميل');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص نقل الموظفين: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 's-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
