// Browser test of the freight pack: a haulage company with only this pack, carriers, a transport order from the form,
// planning on our truck and trailer, a trip given to a carrier and its delivery recorded by the office, trip expenses,
// the settlement, exceptions and the trip-profit report.
// Run: node e2e/freight.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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

try {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("الدخول برقم الجوال")');
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'شركة النقل البري التجريبية');
  await page.check('input[name=pack-freight]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الشحن والنقل")').waitFor();
  if (await page.locator('nav a:has-text("جدول الصب")').count()) throw new Error('a pack that is off shows in the menu');
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const cu = await call('POST', '/customers', { legal_entity_id: le, name: 'مصنع الأسمنت الكويتي' });
  const k = await call('POST', '/contracts', { customer_id: cu.id, starts_on: '2026-01-01', rates: [{ unit: 'trip', price: '95.000', sector_pack: 'freight@1' }, { unit: 'ton', price: '4.500', sector_pack: 'freight@1' }] });
  await call('POST', `/contracts/${k.id}/activate`, {});
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مبارك الرشيدي', phone: `+9656${stamp}` });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `TR-${stamp.slice(-5)}`, capacity: { kg: 25000 } });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'trailer', plate_no: `TL-${stamp.slice(-5)}` });
  ok('شركة بنشاط الشحن فقط: القائمة تُظهر «الشحن والنقل» وحده، مع عميل بعقد وسائق وشاحنة ومقطورة');

  await page.goto(`${WEB}/freight`);
  await page.locator('h1:has-text("الشحن والنقل البري")').waitFor();
  await page.click('button[role=tab]:text-is("الناقلون")');
  await page.fill('input[name=name]', 'ناقلات الصليبية');
  await page.fill('input[name=phone]', '50001234');
  await page.click('button:has-text("إضافة ناقل")');
  await page.locator('[data-testid=carriers] tr:has-text("ناقلات الصليبية")').waitFor();
  ok('إضافة ناقل من الباطن');

  // a transport order from the form, planned on our truck and trailer
  await page.click('button[role=tab]:text-is("الشحنات")');
  await page.click('button:has-text("أمر نقل جديد")');
  await page.fill('input[name=waybill_no]', `WB-A${stamp}`);
  await page.locator('select[name=customer_id] option:has-text("مصنع الأسمنت الكويتي")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=customer_id]', { label: 'مصنع الأسمنت الكويتي' });
  await page.fill('input[name=description]', 'أسمنت أكياس');
  await page.fill('input[name=weight_kg]', '22000');
  await page.fill('input[name=planned_km]', '60');
  await page.fill('input[name=pickup_name]', 'مصنع الأسمنت');
  await page.fill('input[name=pickup_area]', 'الشعيبة');
  await page.fill('input[name=dropoff_name]', 'مشروع جنوب سعد العبدالله');
  await page.fill('input[name=pickup_at]', kwLocal(2));
  await page.fill('input[name=deliver_by]', kwLocal(6));
  await page.click('button:has-text("إنشاء")');
  await page.locator(`.modal h2:has-text("الشحنة WB-A${stamp}")`).waitFor();
  await page.locator('[data-testid=settlement]:has-text("تقديرية")').waitFor();
  await page.locator('[data-testid=settlement]:has-text("95.000")').waitFor();
  await page.locator('select[name=asset_id] option:has-text("TR-")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=asset_id]', { label: `TR-${stamp.slice(-5)}` });
  await page.selectOption('select[name=worker_id]', { label: 'مبارك الرشيدي' });
  await page.selectOption('select[name=trailer_asset_id]', { label: `TL-${stamp.slice(-5)}` });
  await page.click('button:has-text("حفظ التخطيط")');
  await page.locator(`.modal :text("مقطورة TL-${stamp.slice(-5)}")`).waitFor();
  await page.locator('.modal :text("مبارك الرشيدي")').first().waitFor();
  await shot(page, 'f-shipment');
  ok('أمر نقل من النموذج بسعر تقديري من العقد، ثم تخطيطه على شاحنتنا والمقطورة والسائق');
  await page.click('.modal button[aria-label="إغلاق"]');

  // a trip given to a carrier: the office records its delivery; priced by ton
  const s2 = await call('POST', '/freight/shipments', { legal_entity_id: le, waybill_no: `WB-B${stamp}`, customer_id: cu.id, bill_unit: 'ton', mode: 'ltl',
    cargo: { description: 'حديد', weight_kg: 10000 }, pickup: { name: 'ميناء الشويخ' }, dropoff: { name: 'الوفرة' },
    pickup_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), deliver_by: new Date(Date.now() + 3_600_000).toISOString() });
  await page.reload();
  await page.click(`button[aria-label="الشحنة WB-B${stamp}"]`);
  await page.locator('label:has-text("ناقل من الباطن") input').check();
  await page.locator('select[name=carrier_id] option:has-text("ناقلات الصليبية")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=carrier_id]', { label: 'ناقلات الصليبية' });
  await page.fill('input[name=carrier_cost]', '30');
  await page.click('button:has-text("حفظ التخطيط")');
  await page.locator('.modal :text("ناقل: ناقلات الصليبية")').waitFor();
  await page.fill('input[name=received_by]', 'أبو ناصر');
  await page.fill('input[name=delivered_weight_kg]', '9800');
  await page.click('button:has-text("تسجيل التسليم")');
  await page.locator('.modal .badge:has-text("مكتملة"), .modal :text("مكتملة")').first().waitFor();
  await page.selectOption('select[name=category]', 'tolls');
  await page.fill('input[name=amount]', '2.5');
  await page.click('button:has-text("إضافة مصروف")');
  await page.locator('[data-testid=trip-expenses] tr:has-text("2.500")').waitFor();
  // 9.8 t × 4.500 = 44.100; profit 44.100 − 30 − 2.500 = 11.600
  await page.locator('[data-testid=settlement]:has-text("44.100")').waitFor();
  await page.locator('[data-testid=settlement]:has-text("11.600")').waitFor();
  await shot(page, 'f-carrier');
  ok('رحلة لناقل بكلفته، تسليمه يسجله المكتب، مصروف رسوم، وتسوية بالطن: 44.100 إيراد و11.600 ربح');
  await page.click('.modal button[aria-label="إغلاق"]');

  await page.click('button[role=tab]:text-is("ربح الرحلات")');
  await page.locator(`[data-testid=freight-report] tr:has-text("WB-B${stamp}"):has-text("11.600")`).waitFor();
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('h2:has-text("بلا شاحنة أو ناقل")').waitFor();
  await page.click('button[role=tab]:text-is("الإعدادات")');
  await page.locator('label:has-text("الانتظار المجاني") input').fill('90');
  await page.click('button:has-text("حفظ")');
  await page.locator('.alert.ok:has-text("حُفظت الإعدادات")').waitFor();
  ok('تقرير ربح الرحلات والاستثناءات والإعدادات');
  if (s2.task_id === undefined) throw new Error('shipment not created');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص الشحن والنقل البري: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'f-failure');
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
