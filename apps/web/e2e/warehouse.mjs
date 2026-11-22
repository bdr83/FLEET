// Browser test of the warehouse pack: a 3PL company sets up a warehouse, locations and a customer's items, receives goods
// with expiry, counts stock, creates an outbound order picked first-expiry-first-out and ships it as a delivery task,
// then the exceptions and the report.
// Run: node e2e/warehouse.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const kwLocal = (h) => new Date(Date.now() + 3 * 3_600_000 + h * 3_600_000).toISOString().slice(0, 16);

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-fp-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);

const plusDays = (n) => new Date(Date.now() + 3 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
try {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("الدخول برقم الجوال")');
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'مخازن الخليج التجريبية');
  await page.check('input[name=pack-warehouse]');
  await page.check('input[name=pack-delivery]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("المستودعات")').waitFor();
  const me = await call('GET', '/me');
  await call('POST', '/customers', { legal_entity_id: me.legal_entities[0].id, name: 'شركة الأغذية المتحدة' });
  ok('شركة بنشاطي المستودعات والتوصيل، مع عميل يخزّن بضاعته عندنا');

  await page.click('nav a:has-text("المستودعات")');
  await page.locator('h1:has-text("المستودعات")').waitFor();
  await page.click('button[role=tab]:text-is("المستودعات والأصناف")');
  await page.fill('[aria-label="رمز المستودع"]', 'SHW1');
  await page.fill('[aria-label="اسم المستودع"]', 'مستودع الشويخ');
  await page.click('button:has-text("إضافة مستودع")');
  await page.locator('[data-testid=warehouses] tr:has-text("SHW1")').waitFor();
  await page.selectOption('[aria-label="مستودع المواقع"]', { label: 'SHW1' });
  await page.fill('[aria-label="رموز المواقع"]', 'A-01 A-02 B-01');
  await page.click('button:has-text("إضافة مواقع")');
  await page.locator('[data-testid=warehouses] tr:has-text("A-01، A-02، B-01")').waitFor();
  await page.locator('[aria-label="مالك الصنف"] option:has-text("شركة الأغذية")').waitFor({ state: 'attached' });
  for (const [sku, name, unit, min, exp] of [['MLK', 'حليب', 'carton', '50', true], ['RCE', 'أرز', 'bag', '', false]]) {
    await page.selectOption('[aria-label="مالك الصنف"]', { label: 'شركة الأغذية المتحدة' });
    await page.fill('[aria-label="رمز الصنف"]', sku);
    await page.fill('[aria-label="اسم الصنف"]', name);
    await page.selectOption('[aria-label="الوحدة"]', unit);
    await page.fill('[aria-label="حد إعادة الطلب"]', min);
    if (exp) await page.check('input[name=track_expiry]'); else await page.uncheck('input[name=track_expiry]');
    await page.click('button:has-text("إضافة صنف")');
    await page.locator(`[data-testid=items] tr:has-text("${sku}")`).waitFor();
  }
  ok('مستودع الشويخ بثلاثة مواقع، وصنفان للعميل (الحليب بصلاحية وحد طلب 50)');

  await page.click('button[role=tab]:text-is("الاستلام")');
  await page.locator('select[name=warehouse_id] option:has-text("SHW1")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=warehouse_id]', { label: 'SHW1 · مستودع الشويخ' });
  await page.selectOption('select[name=owner]', { label: 'شركة الأغذية المتحدة' });
  await page.fill('input[name=ref]', 'GRN-1');
  const lines = [['MLK', '30', 'A-01', plusDays(10)], ['MLK', '25', 'A-02', plusDays(60)], ['RCE', '20', 'B-01', '']];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.click('button:has-text("+ سطر")');
    const [sku, qty, l, exp] = lines[i];
    await page.selectOption(`[aria-label="صنف السطر ${i + 1}"]`, { label: `${sku} · ${sku === 'MLK' ? 'حليب' : 'أرز'}` });
    await page.fill(`[aria-label="كمية السطر ${i + 1}"]`, qty);
    await page.selectOption(`[aria-label="موقع السطر ${i + 1}"]`, { label: l });
    if (exp) await page.fill(`[aria-label="صلاحية السطر ${i + 1}"]`, exp);
  }
  await shot(page, 'w-receive');
  await page.click('button:has-text("تسجيل الاستلام")');
  await page.locator('.alert.ok:has-text("سُجّل الاستلام")').waitFor();
  await page.locator('[data-testid=receipts] tr:has-text("GRN-1")').waitFor();
  ok('استلام GRN-1: حليب 30 في A-01 (صلاحية 10 أيام) و25 في A-02، وأرز 20 في B-01');

  await page.click('button[role=tab]:text-is("المخزون")');
  await page.locator('[data-testid=stock] tr:has-text("RCE")').waitFor();
  await page.click('[data-testid=stock] tr:has-text("RCE") button:has-text("جرد")');
  await page.fill('.modal input[name=counted]', '19');
  await page.fill('.modal input[name=reason]', 'جرد شهري');
  await page.click('.modal button:has-text("تسجيل الجرد")');
  await page.locator('[data-testid=stock] tr:has-text("RCE") td.num:has-text("19")').waitFor();
  ok('جرد الأرز في B-01: 19 بدل 20 بسبب مسجل');

  await page.click('button[role=tab]:text-is("أوامر الصرف")');
  await page.click('button:has-text("أمر صرف جديد")');
  await page.locator('.modal select[name=warehouse_id] option:has-text("SHW1")').waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=warehouse_id]', { label: 'SHW1 · مستودع الشويخ' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'شركة الأغذية المتحدة' });
  await page.fill('.modal input[name=ref]', 'SO-1');
  await page.locator('[aria-label="صنف 1"] option:has-text("MLK")').waitFor({ state: 'attached' });
  await page.selectOption('[aria-label="صنف 1"]', { index: 1 });
  await page.fill('[aria-label="كمية 1"]', '40');
  await page.fill('.modal input[name=name]', 'سوبرماركت السلام');
  await page.fill('.modal input[name=phone]', '50003333');
  await page.fill('.modal input[name=area]', 'السالمية');
  await page.click('.modal button:has-text("إنشاء الأمر")');
  await page.locator('.modal h2:has-text("الأمر SO-1")').waitFor();
  await page.locator('.modal [data-testid=picks] tr:has-text("A-01") td.num:text-is("30")').waitFor();
  await page.locator('.modal [data-testid=picks] tr:has-text("A-02") td.num:text-is("10")').waitFor();
  await shot(page, 'w-plan');
  await page.click('.modal button:has-text("تأكيد الالتقاط")');
  await page.locator('.modal .badge:has-text("جُمع")').waitFor();
  await page.click('.modal button:has-text("شحن بأسطولنا")');
  await page.locator('.modal .badge:has-text("شُحن")').waitFor();
  await page.locator('.modal a:has-text("مهمة توصيل")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  ok('أمر صرف SO-1: خطة الالتقاط بأقدم صلاحية أولًا (30 من A-01 ثم 10 من A-02)، ثم الشحن بمهمة توصيل لأسطولنا');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-low] tr:has-text("MLK") td.num:text-is("15")').waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.locator('[data-testid=wh-report] tr:has-text("شركة الأغذية المتحدة"):has-text("75")').waitFor();
  await shot(page, 'w-report');
  ok('الاستثناءات (الحليب 15 تحت حد 50) والتقرير لكل عميل');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص المستودعات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'w-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
