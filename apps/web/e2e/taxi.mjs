// Browser test of the taxi pack: a company sets the classes of its cars and the sedan tariff, takes a booking now for a
// cash passenger and an airport booking at a fixed fare on a corporate account, dispatches both, records a ride from the
// office with its km, and checks the fare, the exceptions and the report (cash per driver, the account's amount).
// Run: node e2e/taxi.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=company]', 'تاكسي الطلب التجريبية');
  await page.check('input[name=pack-taxi]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("التاكسي والليموزين")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'شركة الخليج للاستشارات', kind: 'business' });
  for (const p of ['11', '22']) await call('POST', '/assets', { legal_entity_id: le, asset_type: 'car', plate_no: `${p}-${stamp.slice(-5)}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سالم', phone: `+9656${stamp}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'راشد', phone: `+9655${stamp}` });
  ok('شركة بنشاط التاكسي، مع حساب شركة وسيارتين وسائقين');

  await page.click('nav a:has-text("التاكسي والليموزين")');
  await page.locator('h1:has-text("التاكسي والليموزين")').waitFor();
  await page.click('button[role=tab]:text-is("السيارات والتعرفة")');
  await page.selectOption(`[aria-label="فئة 11-${stamp.slice(-5)}"]`, 'sedan');
  await page.locator(`[aria-label="فئة 11-${stamp.slice(-5)}"]:not([disabled])`).waitFor();
  await page.selectOption(`[aria-label="فئة 22-${stamp.slice(-5)}"]`, 'luxury');
  await page.fill('input[name=base]', '0.350');
  await page.fill('input[name=per_km]', '0.150');
  await page.fill('input[name=per_wait_min]', '0.050');
  await page.fill('input[name=min_fare]', '1.000');
  await page.click('button:has-text("حفظ التعرفة")');
  await page.locator('[data-testid=tx-tariffs] tr:has-text("صالون"):has-text("0.150")').waitFor();
  const cars = await call('GET', '/taxi/cars');
  if (cars.data.filter((c) => c.class).length !== 2) throw new Error(`cars ${JSON.stringify(cars.data)}`);
  ok('سيارة صالون وأخرى ليموزين فاخرة، وتعرفة الصالون');

  await page.click('button[role=tab]:text-is("حجوزات اليوم")');
  await page.click('button:has-text("حجز جديد")');
  await page.fill('.modal input[name=passenger_name]', 'محمد');
  await page.fill('.modal input[name=passenger_phone]', '+96599112233');
  await page.fill('.modal input[name=p_area]', 'حولي');
  await page.fill('.modal input[name=p_block]', '3');
  await page.fill('.modal input[name=d_name]', 'مستشفى الصباح');
  await page.click('.modal button:has-text("حفظ الحجز")');
  await page.locator('.modal h2:has-text("حجز TX-1"), .modal :text("حجز TX-1")').first().waitFor();
  await page.locator('.modal select[name=asset_id] option').nth(1).waitFor({ state: 'attached' });
  const opts = await page.locator('.modal select[name=asset_id] option').count();
  if (opts !== 3) throw new Error(`a sedan booking should offer the sedan and the luxury car, got ${opts - 1}`);
  await page.selectOption('.modal select[name=asset_id]', { label: `11-${stamp.slice(-5)} · صالون` });
  await page.selectOption('.modal select[name=driver_worker_id]', { label: 'سالم' });
  await page.click('.modal button:has-text("إسناد")');
  await page.locator('.modal [data-testid=booking-driver]:has-text("سالم")').waitFor();
  ok('حجز فوري لراكب نقدي، والإسناد يعرض السيارات المتاحة من الفئة وما فوقها، ثم يُسند لسالم');

  await page.fill('.modal input[name=km]', '10');
  await page.click('.modal button:has-text("تسجيل المشوار من المكتب")');
  await page.locator('.modal [data-testid=booking-fare]:has-text("1.850"):has-text("نقدًا")').waitFor();
  await shot(page, 'tx-booking');
  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=bookings] tr:has-text("TX-1"):has-text("انتهى"):has-text("1.850")').waitFor();
  ok('تسجيل المشوار من المكتب بعشرة كيلومترات: الأجرة 1.850 د.ك من التعرفة');

  await page.click('button:has-text("حجز جديد")');
  await page.fill('.modal input[name=passenger_name]', 'Mr. Smith');
  await page.fill('.modal input[name=passenger_phone]', '+96599223344');
  await page.selectOption('.modal select[name=customer_id]', { label: 'شركة الخليج للاستشارات' });
  await page.fill('.modal input[name=p_name]', 'مطار الكويت T4');
  await page.fill('.modal input[name=d_name]', 'فندق الشيراتون');
  await page.selectOption('.modal select[name=when]', 'later');
  await page.selectOption('.modal select[name=class]', 'luxury');
  await page.fill('.modal input[name=flight_no]', 'BA157');
  await page.fill('.modal input[name=fixed_fare]', '12.000');
  await page.click('.modal button:has-text("حفظ الحجز")');
  await page.locator('.modal :text("حجز TX-2")').first().waitFor();
  await page.locator('.modal select[name=asset_id] option').nth(1).waitFor({ state: 'attached' });
  if (await page.locator('.modal select[name=asset_id] option').count() !== 2) throw new Error('a luxury booking should offer only the luxury car');
  await page.selectOption('.modal select[name=asset_id]', { index: 1 });
  await page.selectOption('.modal select[name=driver_worker_id]', { label: 'راشد' });
  await page.click('.modal button:has-text("إسناد")');
  await page.locator('.modal [data-testid=booking-driver]:has-text("راشد")').waitFor();
  await page.selectOption('.modal select[name=payment]', 'account');
  await page.click('.modal button:has-text("تسجيل المشوار من المكتب")');
  await page.locator('.modal [data-testid=booking-fare]:has-text("12.000"):has-text("على الحساب")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  ok('حجز مطار برحلة BA157 على حساب الشركة بأجرة ثابتة، ليموزين فقط، يُسجَّل بـ 12.000 د.ك على الحساب');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-unassigned], section:has-text("حجوزات بلا سيارة")').first().waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.locator('[data-testid=tx-drivers] tr:has-text("سالم"):has-text("1.850")').waitFor();
  await page.locator('[data-testid=tx-accounts] tr:has-text("شركة الخليج للاستشارات"):has-text("12.000")').waitFor();
  await shot(page, 'tx-report');
  ok('التقرير: نقد سالم 1.850 وحساب الشركة 12.000');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص التاكسي: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'tx-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
