// Browser test of the utilities pack: a networks contractor with a crew pickup and lead; an excavation work order typed
// in the office (needs a permit), the permit recorded, the crew booked; an emergency past its response time shows in
// the exceptions; the report by customer and network.
// Run: node e2e/utilities.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=company]', 'مقاولات الشبكات التجريبية');
  await page.check('input[name=pack-utilities]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("أعمال المرافق")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const cu = await call('POST', '/customers', { legal_entity_id: le, name: 'وزارة الكهرباء والماء' });
  const van = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'pickup', plate_no: `UT-${stamp.slice(-5)}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'technician', display_name: 'رئيس الفرقة', phone: `+9656${stamp}` });
  if (!van.id || !cu.id) throw new Error(JSON.stringify(van));
  ok('مقاول شبكات بسيارة فرقة وقائد وعميل');

  await page.click('nav a:has-text("أعمال المرافق")');
  await page.locator('h1:has-text("أعمال المرافق")').waitFor();
  await page.click('button:has-text("أمر عمل جديد")');
  await page.selectOption('.modal select[name=network]', 'water');
  await page.selectOption('.modal select[name=job_type]', 'excavation');
  await page.selectOption('.modal select[name=priority]', 'urgent');
  await page.locator('.modal select[name=customer_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'وزارة الكهرباء والماء' });
  await page.fill('.modal input[name=description]', 'كسر خط مياه 200 مم');
  await page.fill('.modal input[name=area]', 'الجابرية');
  await page.fill('.modal input[name=address]', 'ق 1 ش 5');
  await page.fill('.modal input[name=asset_ref]', 'WM-JAB-07');
  await page.click('.modal button:has-text("حفظ الأمر")');
  await page.locator('.modal [data-testid=job-permit]:has-text("يحتاج تصريح حفر")').waitFor();
  await page.locator('.modal:has-text("ماء · حفر")').waitFor();
  ok('أمر حفر عاجل لخط مياه، ويظهر أنه يحتاج تصريح حفر');

  await page.fill('.modal input[aria-label="رقم التصريح"]', 'DIG-2026-551');
  await page.fill('.modal input[aria-label="انتهاء التصريح"]', kwDay(10));
  await page.click('.modal button:has-text("تسجيل التصريح")');
  await page.locator(`.modal [data-testid=job-permit]:has-text("DIG-2026-551"):has-text("${kwDay(10)}")`).waitFor();
  await page.locator('.modal select[name=asset_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', { index: 1 });
  await page.locator('.modal select[name=worker_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=worker_id]', { label: 'رئيس الفرقة' });
  await page.click('.modal button:has-text("إسناد الفرقة")');
  await page.locator('.modal [data-testid=job-crew]:has-text("رئيس الفرقة")').waitFor();
  await shot(page, 'ut-job');
  ok('تصريح الحفر DIG-2026-551 مسجّل، والفرقة مسندة');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=jobs] tr:has-text("كسر خط مياه"):has-text("مسند"):has-text("تصريح DIG-2026-551")').waitFor();
  const late = await call('POST', '/utilities/jobs', { legal_entity_id: le, customer_id: cu.id, network: 'electricity', job_type: 'outage', priority: 'emergency',
    reported_at: new Date(Date.now() - 200 * 60_000).toISOString(), area: 'حولي', description: 'عمود إنارة ساقط', affected: 40 });
  if (!late.id) throw new Error(JSON.stringify(late));
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-breach] tr:has-text("عمود إنارة ساقط"):has-text("تجاوز")').waitFor();
  await shot(page, 'ut-exceptions');
  ok('الاستثناءات: بلاغ طارئ تجاوز موعد الاستجابة (ساعتان) بلا فرقة');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(1));
  await page.locator('[data-testid=ut-report-customers] tr:has-text("وزارة الكهرباء والماء")').waitFor();
  await page.locator('[data-testid=ut-report-networks] tr:has-text("ماء")').waitFor();
  await page.locator('[data-testid=ut-report-networks] tr:has-text("كهرباء")').waitFor();
  await shot(page, 'ut-report');
  ok('التقرير: العميل وزارة الكهرباء والماء، والشبكتان الماء والكهرباء');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص أعمال المرافق: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'ut-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
