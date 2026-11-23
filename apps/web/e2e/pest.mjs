// Browser test of the pest pack: a pest control company with a licensed technician, an unlicensed one and a customer;
// the pesticide register (one without a registration number flagged); a monthly restaurant job typed in the office;
// the unlicensed technician refused, the licensed one booked; exceptions and the report.
// Run: node e2e/pest.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=company]', 'مكافحة تجريبية');
  await page.check('input[name=pack-pest]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("مكافحة الحشرات")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'مطعم البحر' });
  const w = await call('POST', '/workers', { legal_entity_id: le, kind: 'technician', display_name: 'الفني خالد', phone: `+9656${stamp}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'technician', display_name: 'فني بلا ترخيص', phone: `+9655${stamp}` });
  const doc = await call('POST', '/documents', { legal_entity_id: le, worker_id: w.id, doc_type: 'pesticide_license', number: 'PL-2231', expires_on: kwDay(200) });
  if (!doc.id) throw new Error(JSON.stringify(doc));
  ok('شركة مكافحة بفني مرخّص وآخر بلا ترخيص وعميل');

  await page.click('nav a:has-text("مكافحة الحشرات")');
  await page.locator('h1:has-text("مكافحة الحشرات والقوارض")').waitFor();
  await page.click('button[role=tab]:text-is("سجل المبيدات")');
  for (const [name, ai, reg, unit, h] of [['جل الصراصير', 'Fipronil 0.05%', 'KM-PC-1102', 'g', '0'], ['رش متبقي', 'Cypermethrin 10%', '', 'ml', '4']]) {
    await page.fill('input[name=name]', name);
    await page.fill('input[name=active_ingredient]', ai);
    await page.fill('input[name=registration_no]', reg);
    await page.selectOption('select[name=unit]', unit);
    await page.fill('input[name=reentry_hours]', h);
    await page.click('button:has-text("إضافة")');
    await page.locator(`[data-testid=products] tr:has-text("${name}")`).waitFor();
  }
  await page.locator('[data-testid=products] tr:has-text("رش متبقي"):has-text("بلا رقم"):has-text("4 س")').waitFor();
  ok('سجل المبيدات: جل برقم تسجيل، ورش بلا رقم ومنع دخول 4 ساعات');

  await page.click('button[role=tab]:text-is("الأوامر")');
  await page.click('button:has-text("أمر مكافحة جديد")');
  await page.locator('.modal select[name=customer_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'مطعم البحر' });
  await page.selectOption('.modal select[name=premises]', 'restaurant');
  await page.check('.modal input[name=pest-rodents]');
  await page.fill('.modal input[name=area]', 'السالمية');
  await page.fill('.modal input[name=address]', 'شارع البلاجات');
  await page.fill('.modal input[name=repeat_days]', '30');
  await page.fill('.modal input[name=notes]', 'المطبخ يغلق 3 العصر');
  await page.click('.modal button:has-text("حفظ الأمر")');
  await page.locator('.modal:has-text("رش: صراصير، قوارض"):has-text("عقد كل 30 يوم")').waitFor();
  ok('أمر لمطعم: صراصير وقوارض، رش، عقد شهري');

  await page.locator('.modal select[name=worker_id] option').nth(2).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=worker_id]', { label: 'فني بلا ترخيص' });
  await page.click('.modal button:has-text("إسناد الفني")');
  await page.locator('.modal :text("license_required")').waitFor();
  await page.selectOption('.modal select[name=worker_id]', { label: 'الفني خالد' });
  await page.click('.modal button:has-text("إسناد الفني")');
  await page.locator('.modal [data-testid=job-tech]:has-text("الفني خالد")').waitFor();
  await shot(page, 'pc-job');
  ok('الفني بلا ترخيص مرفوض، والفني المرخّص مسند');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=jobs] tr:has-text("مطعم البحر"):has-text("مسند"):has-text("كل 30 يوم")').waitFor();
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-products] li:has-text("رش متبقي")').waitFor();
  ok('الاستثناءات: المبيد بلا رقم تسجيل');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(1));
  await page.locator('[data-testid=pc-report-pests] tr:has-text("قوارض")').waitFor();
  await page.locator('[data-testid=pc-report-premises] tr:has-text("مطعم")').waitFor();
  await shot(page, 'pc-report');
  ok('التقرير: حسب الآفة ونوع المنشأة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص مكافحة الحشرات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'pc-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
