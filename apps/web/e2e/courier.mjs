// Browser test of the courier pack: a company with only this pack, hubs, a parcel booked from the form and received at the
// origin hub, batch scans between hubs, a parcel assigned to the courier that fails (simulated by API calls), scanned back
// at its last attempt and marked for return to the shipper, the exceptions and the KPIs.
// Run: node e2e/courier.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const API = process.env.API_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const uuid = () => crypto.randomUUID();
async function apiCall(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

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
  await page.fill('input[name=company]', 'البريد السريع التجريبي');
  await page.check('input[name=pack-courier]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("البريد السريع")').waitFor();
  await page.locator('nav a:has-text("مركز التوصيل")').waitFor();
  if (await page.locator('nav a:has-text("الشحن والنقل")').count()) throw new Error('a pack that is off shows in the menu');
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'متجر الأناقة' });
  const phone = `+9656${stamp}`;
  await call('POST', '/workers', { legal_entity_id: le, kind: 'courier', display_name: 'فهد المندوب', phone });
  const otp = await apiCall('POST', '/v1/auth/otp/request', { phone });
  const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone, code: otp.dev_code });
  const dtok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
  const sync = async (op) => (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: new Date().toISOString(), ...op }] }, dtok)).results[0];
  ok('شركة بنشاط البريد السريع فقط: القائمة تُظهر «البريد السريع» و«مركز التوصيل»');

  await page.click('nav a:has-text("البريد السريع")');
  await page.locator('h1:has-text("البريد والشحن السريع")').waitFor();
  await page.click('button[role=tab]:text-is("المحطات")');
  for (const [code, name] of [['KWI', 'محطة الشويخ'], ['AHM', 'محطة الأحمدي']]) {
    await page.fill('[aria-label="رمز المحطة"]', code);
    await page.fill('[aria-label="اسم المحطة"]', name);
    await page.click('button:has-text("إضافة محطة")');
    await page.locator(`[data-testid=hubs] tr:has-text("${code}")`).waitFor();
  }
  ok('محطتان: الشويخ والأحمدي');

  await page.click('button[role=tab]:text-is("الشحنات")');
  await page.click('button:has-text("شحنة جديدة")');
  await page.locator('select[name=customer_id] option:has-text("متجر الأناقة")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=customer_id]', { label: 'متجر الأناقة' });
  await page.selectOption('select[name=service]', 'same_day');
  await page.fill('input[name=pieces]', '2');
  await page.locator('select[name=origin_hub_id] option:has-text("KWI")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=origin_hub_id]', { label: 'KWI · محطة الشويخ' });
  await page.selectOption('select[name=dest_hub_id]', { label: 'AHM · محطة الأحمدي' });
  await page.fill('input[name=name]', 'نورة');
  await page.fill('input[name=phone]', '50001111');
  await page.fill('input[name=area]', 'الفحيحيل');
  await page.fill('input[name=cod_amount]', '12.5');
  await page.click('button:has-text("حجز الشحنة")');
  await page.locator('.modal h2:text-matches("الشحنة KW\\\\d{10}")').waitFor();
  const awb1 = (await page.locator('.modal h2').textContent()).replace('الشحنة ', '').trim();
  await page.locator('.modal [data-testid=timeline] :text("استلام في المحطة · KWI")').waitFor();
  await page.locator('.modal :text("لم يُحصّل")').waitFor();
  await shot(page, 'cr-parcel');
  await page.click('.modal button[aria-label=إغلاق]');
  const kwi = (await call('GET', '/courier/hubs')).data.find((h) => h.code === 'KWI').id;
  const awb2 = `E2E-${stamp}`;
  await call('POST', '/courier/parcels', { legal_entity_id: le, awb: awb2, service: 'express', max_attempts: 1, origin_hub_id: kwi, recipient: { name: 'سالم', phone: '+96550002222' }, dropoff: { area: 'المنقف' } });
  ok(`حجز شحنة ${awb1} من النموذج (نفس اليوم، قطعتان، دفع عند الاستلام) تُستلم في محطة الشويخ، وأخرى سريعة بمحاولة واحدة`);

  await page.click('button[role=tab]:text-is("المسح في المحطة")');
  await page.locator('select[name=hub_id] option:has-text("KWI")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=hub_id]', { label: 'KWI · محطة الشويخ' });
  await page.selectOption('select[name=event]', 'dispatched');
  await page.fill('textarea[name=awbs]', `${awb1}\n${awb2.toLowerCase()}\nNOPE-1`);
  await page.click('button:has-text("تسجيل المسح (3)")');
  await page.locator(`[data-testid=scan-results] tr:has-text("${awb1}") .badge:has-text("سُجّل")`).waitFor();
  await page.locator('[data-testid=scan-results] tr:has-text("NOPE-1") .badge:has-text("بوليصة غير معروفة")').waitFor();
  await page.selectOption('select[name=hub_id]', { label: 'AHM · محطة الأحمدي' });
  await page.selectOption('select[name=event]', 'arrived');
  await page.fill('textarea[name=awbs]', `${awb1} ${awb2}`);
  await page.click('button:has-text("تسجيل المسح (2)")');
  await page.locator(`[data-testid=scan-results] tr:has-text("${awb2}") .badge:has-text("سُجّل")`).waitFor();
  await shot(page, 'cr-scan');
  ok('مسح دفعة: إرسال من الشويخ (والبوليصة المجهولة تُرفض وحدها)، ثم وصول للأحمدي');

  // the express parcel goes out with the courier and fails
  await page.click('button[role=tab]:text-is("الشحنات")');
  await page.click(`button[aria-label="الشحنة ${awb2}"]`);
  await page.locator('.modal select[aria-label=المندوب] option:has-text("فهد")').waitFor({ state: 'attached' });
  await page.selectOption('.modal select[aria-label=المندوب]', { label: 'فهد المندوب' });
  await page.click('.modal button:text-is("إسناد")');
  await page.locator('.modal :text("الحالي: فهد المندوب")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  const t2 = (await apiCall('GET', '/v1/driver/tasks', undefined, dtok)).data.find((t) => t.attributes.awb === awb2);
  for (const op of [{ type: 'task_status', task_id: t2.id, to_status: 'accepted' }, { type: 'task_status', task_id: t2.id, to_status: 'in_progress' },
    { type: 'task_status', task_id: t2.id, to_status: 'failed', reason_code: 'recipient_absent' }]) {
    const r = await sync(op);
    if (r.result !== 'applied') throw new Error(`${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  }
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator(`[data-testid=ex-return] tr:has-text("${awb2}")`).waitFor();
  ok('إسناد الشحنة السريعة للمندوب من النافذة، وفشل التسليم (المستلم غير موجود) يظهر في «فشلت ولم تعد للمحطة»');

  await page.click('button[role=tab]:text-is("المسح في المحطة")');
  await page.locator('select[name=hub_id] option:has-text("AHM")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=hub_id]', { label: 'AHM · محطة الأحمدي' });
  await page.selectOption('select[name=event]', 'returned');
  await page.fill('textarea[name=awbs]', awb2);
  await page.click('button:has-text("تسجيل المسح (1)")');
  await page.locator(`[data-testid=scan-results] tr:has-text("${awb2}") .badge:has-text("تقرر إرجاعها للمرسل")`).waitFor();
  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator(`[data-testid=ex-rto] tr:has-text("${awb2}")`).waitFor();
  await page.click(`[data-testid=ex-rto] button[aria-label="الشحنة ${awb2}"]`);
  await page.locator('.modal [data-testid=timeline] :text("المستلم غير موجود")').waitFor();
  await page.locator('.modal .badge:has-text("تقرر الإرجاع للمرسل")').waitFor();
  await shot(page, 'cr-rto');
  await page.click('.modal button[aria-label=إغلاق]');
  ok('عودتها للمحطة بعد آخر محاولة: تقرر إرجاعها للمرسل، والمسار الزمني يُظهر سبب الفشل');

  await page.click('button[role=tab]:text-is("المؤشرات")');
  await page.locator('[data-testid=courier-services] tr:has-text("سريع"):has-text("100%")').waitFor();
  await page.locator('[data-testid=courier-shippers] tr:has-text("متجر الأناقة")').waitFor();
  await page.locator('.kpi:has-text("نسبة الإرجاع للمرسل"):has-text("50%")').waitFor();
  await shot(page, 'cr-report');
  ok('المؤشرات حسب الخدمة والمرسل: نسبة الإرجاع 50%');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص البريد السريع: ${step} خطوات ناجحة`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(page, 'cr-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
