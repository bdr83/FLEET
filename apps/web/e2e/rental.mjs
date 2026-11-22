// Browser test of the car rental pack: a company reserves a car for a walk-in renter (new individual customer), sees it
// booked, checks it out at the counter, records a traffic fine that matches the agreement, checks it in with the charges
// against the deposit, and checks the exceptions and the report.
// Run: node e2e/rental.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
const kwLocal = (h) => new Date(Date.now() + (3 + h) * 3_600_000).toISOString().slice(0, 16);

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
  await page.fill('input[name=company]', 'تأجير السيارات التجريبية');
  await page.check('input[name=pack-rental]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("تأجير السيارات")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const plate = `RC-${stamp.slice(-5)}`;
  const carId = (await call('POST', '/assets', { legal_entity_id: le, asset_type: 'car', plate_no: plate, make: 'Toyota', model: 'Camry', odometer_km: 20000 })).id;
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'car', plate_no: `RD-${stamp.slice(-5)}`, make: 'Nissan', model: 'Sunny' });
  ok('شركة بنشاط تأجير السيارات، مع سيارتين');

  await page.click('nav a:has-text("تأجير السيارات")');
  await page.locator('h1:has-text("تأجير السيارات")').waitFor();
  await page.click('button:has-text("حجز جديد")');
  await page.locator(`.modal select[name=asset_id] option:has-text("${plate}")`).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', 'new');
  await page.fill('.modal input[name=new_phone]', '+96551112222');
  await page.selectOption('.modal select[name=asset_id]', { label: `سيارة ${plate}` });
  await page.fill('.modal input[name=d_name]', 'فهد العتيبي');
  await page.fill('.modal input[name=d_licence]', 'KW-12345');
  await page.fill('.modal input[name=d_expiry]', kwDay(3));
  await page.fill('.modal input[name=pickup_at]', kwLocal(0.1));
  await page.fill('.modal input[name=return_due]', kwLocal(24 * 5));
  await page.fill('.modal input[name=rate]', '12.500');
  await page.click('.modal button:has-text("حجز السيارة")');
  await page.locator('.modal .alert:has-text("licence_expires")').waitFor();
  await page.fill('.modal input[name=d_expiry]', kwDay(60));
  await page.fill('.modal input[name=km_per_day]', '200');
  await page.fill('.modal input[name=extra_km_rate]', '0.050');
  await page.fill('.modal input[name=fuel_rate]', '1');
  await page.fill('.modal input[name=deposit]', '100');
  await page.click('.modal button:has-text("حجز السيارة")');
  await page.locator('[data-testid=agreement-created]:has-text("RA-")').waitFor();
  await page.click('.modal button:text-is("تم")');
  await page.locator('[data-testid=agreements] tr:has-text("فهد العتيبي"):has-text("محجوز"):has-text("12.500 KWD")').waitFor();
  ok('حجز لعميل جديد (فرد): الرخصة يجب أن تكون سارية حتى الإرجاع، ثم أُنشئ العقد');

  await page.click('button[role=tab]:text-is("السيارات")');
  await page.locator(`[data-testid=fleet] tr:has-text("${plate}"):has-text("في الفرع"):has-text("RA-")`).waitFor();
  await page.click('button[role=tab]:text-is("الحجوزات والعقود")');
  await page.click('[data-testid=agreements] tr:has-text("فهد العتيبي") button:has-text("إدارة")');
  await page.fill('.modal input[name=odometer_km]', '19000');
  await page.click('.modal button:text-is("تسليم")');
  await page.locator('.modal .alert:has-text("odometer")').waitFor();
  await page.fill('.modal input[name=odometer_km]', '20010');
  await page.fill('.modal input[name=damage]', 'خدش قديم في المصد');
  await page.click('.modal button:text-is("تسليم")');
  await page.locator('.modal .badge:has-text("مع العميل")').waitFor();
  await page.locator('.modal dd:has-text("20,010 كم"):has-text("ممتلئ")').waitFor();
  ok('التسليم في الفرع: العدّاد لا يقل عن آخر قراءة، والوقود والأضرار القديمة مسجّلة');

  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("المخالفات")');
  await page.selectOption('select[name=asset_id]', { label: plate });
  await page.fill('input[name=occurred_at]', kwLocal(0.05)); // a minute or two after the check-out
  await page.fill('input[name=amount]', '15');
  await page.fill('input[name=fine_no]', `F-${stamp}`);
  await page.fill('input[name=description]', 'تجاوز السرعة');
  await page.click('button:has-text("تسجيل المخالفة")');
  await page.locator('[data-testid=fines] tr:has-text("تجاوز السرعة"):has-text("فهد العتيبي"):has-text("مفتوحة")').waitFor();
  await page.click('[data-testid=fines] tr:has-text("تجاوز السرعة") button:has-text("على المستأجر")');
  await page.locator('[data-testid=fines] tr:has-text("تجاوز السرعة"):has-text("على المستأجر")').waitFor();
  ok('مخالفة مرورية تُطابق تلقائيًا مع العقد وتُحمّل على المستأجر');

  // the car comes back the same day, 440 km later
  const agr = (await call('GET', `/rental/agreements?asset_id=${carId}`)).data[0];
  await page.click('button[role=tab]:text-is("الحجوزات والعقود")');
  await page.click('[data-testid=agreements] tr:has-text("فهد العتيبي") button:has-text("إدارة")');
  await page.fill('.modal input[name=odometer_km]', '20450');
  await page.selectOption('.modal select[name=fuel]', '6');
  await page.fill('.modal input[name=damage]', 'خدش جديد في الباب');
  await page.fill('.modal input[name=damage_amount]', '10');
  await page.click('.modal button:has-text("استلام وحساب الرسوم")');
  await page.locator('[data-testid=charges]:has-text("1 يوم"):has-text("12.500 KWD"):has-text("كم زائد (240)")').waitFor();
  // 1 day × 12.500 + 240 km × 0.050 + 2/8 × 1 + 10 damage = 36.500; deposit 100 → 63.500 back
  await page.locator('[data-testid=charges]:has-text("36.500 KWD"):has-text("يُرد للعميل 63.500 KWD"):has-text("15.000 KWD")').waitFor();
  await shot(page, 'rn-charges');
  ok(`الإرجاع والرسوم: يوم + 240 كم زائدة + نقص الوقود + الأضرار = 36.500، ويُرد من العربون 63.500 (${agr.ref})`);

  await page.keyboard.press('Escape');
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('h2:has-text("سيارات متأخرة الإرجاع")').waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.locator('[data-testid=rn-customers] tr:has-text("فهد العتيبي"):has-text("36.500 KWD")').waitFor();
  await page.locator(`[data-testid=rn-vehicles] tr:has-text("${plate}")`).waitFor();
  await shot(page, 'rn-report');
  ok('الاستثناءات والتقرير حسب العميل واستغلال السيارات');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص تأجير السيارات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'rn-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
