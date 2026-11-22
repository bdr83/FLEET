// Browser test of the equipment hire pack: a company hires a crane with its operator to a customer's site, sees the
// machine on hire, records and approves a working day (daily minimum), and checks the exceptions and the report.
// Run: node e2e/equipment.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'معدات الخليج التجريبية');
  await page.check('input[name=pack-equipment]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("تأجير المعدات")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'مقاولات الخليج' });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'crane', plate_no: `CR-${stamp.slice(-5)}`, make: 'Liebherr' });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'excavator', plate_no: `EX-${stamp.slice(-5)}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مشغّل الكرين', phone: `+9656${stamp}` });
  ok('شركة بنشاط تأجير المعدات، مع عميل ورافعة وحفارة ومشغّل');

  await page.click('nav a:has-text("تأجير المعدات")');
  await page.locator('h1:has-text("تأجير المعدات")').waitFor();
  await page.click('button[role=tab]:text-is("عقود التأجير")');
  await page.click('button:has-text("عقد تأجير جديد")');
  await page.locator('.modal select[name=asset_id] option:has-text("رافعة")').waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'مقاولات الخليج' });
  await page.selectOption('.modal select[name=asset_id]', { label: `رافعة (كرين) CR-${stamp.slice(-5)}` });
  await page.selectOption('.modal select[name=operator_worker_id]', { label: 'مشغّل الكرين' });
  await page.fill('.modal input[name=site_name]', 'مشروع جسر الجهراء');
  await page.fill('.modal input[name=area]', 'الجهراء');
  await page.fill('.modal input[name=ends_on]', kwDay(6));
  await page.fill('.modal input[name=shift_start]', '00:00');
  await page.fill('.modal input[name=shift_end]', '23:59');
  for (const l of ['الجمعة', 'السبت']) { const b = page.locator(`.modal fieldset label:has-text("${l}") input`); if (!(await b.isChecked())) await b.check(); }
  await page.click('.modal button:has-text("إنشاء العقد وحجز الأيام")');
  await page.locator('[data-testid=hire-created]:has-text("بعدد 7 يوم عمل")').waitFor();
  await page.click('.modal button:text-is("تم")');
  await page.locator('[data-testid=hires] tr:has-text("مقاولات الخليج"):has-text("مؤجَّر"):has-text("مشغّل الكرين"):has-text("حد 8 س")').waitFor();
  ok('عقد تأجير رافعة بمشغّلها لأسبوع: 7 أيام عمل محجوزة');

  await page.click('button[role=tab]:text-is("المعدات")');
  await page.locator('[data-testid=fleet] tr:has-text("رافعة"):has-text("مؤجَّرة"):has-text("مشروع جسر الجهراء")').waitFor();
  await page.locator('[data-testid=fleet] tr:has-text("حفارة"):has-text("في الساحة")').waitFor();
  ok('المعدات اليوم: الرافعة مؤجَّرة في موقع العميل، والحفارة في الساحة');

  await page.click('button[role=tab]:text-is("أيام العمل")');
  await page.locator('[data-testid=days] tr:has-text("مشغّل الكرين"):has-text("مسندة")').waitFor();
  await page.click('[data-testid=days] tr button:has-text("تسجيل واعتماد")');
  await page.fill('.modal input[name=meter_start]', '1520.5');
  await page.fill('.modal input[name=meter_end]', '1526');
  await page.fill('.modal input[name=downtime_hours]', '1.5');
  await page.fill('.modal input[name=signed_by]', 'م. خالد');
  await page.click('.modal button:has-text("حفظ القراءات")');
  await page.locator('[data-testid=days] tr:has-text("5.5 س"):has-text("توقف 1.5"):has-text("م. خالد")').waitFor();
  await page.click('[data-testid=days] tr button:has-text("تسجيل واعتماد")');
  await shot(page, 'eq-day');
  await page.click('.modal button:has-text("اعتماد اليوم للفوترة")');
  await page.locator('[data-testid=days] tr:has-text("مكتملة") .badge:has-text("6.5 س")').waitFor();
  ok('تسجيل عدّاد الساعات من المكتب، والاعتماد: 5.5 فعلية ← 6.5 مفوترة (الحد 8 ناقص توقف العطل)');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('h2:has-text("عقود تنتهي قريبًا")').waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.locator('[data-testid=eq-customers] tr:has-text("مقاولات الخليج") td.num:text-is("6.5")').waitFor();
  await page.locator('[data-testid=eq-machines] tr:has-text("رافعة")').waitFor();
  await shot(page, 'eq-report');
  ok('الاستثناءات والتقرير حسب العميل والمعدة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص تأجير المعدات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'eq-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
