// Browser test of the driver app's distribution route (distribution@1) against a running API (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL).
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_distribution.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const APP = process.env.APP_URL ?? 'http://localhost:8080';
const API = process.env.API_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (p, n) => SHOTS && p.screenshot({ path: `${SHOTS}/${n}.png` });
async function call(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(d)}`);
  return d;
}

// Office side, through the API: products, a truck, a driver and today's route with a credit branch and a cash shop
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'ألبان الخليج' }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
await call('POST', '/v1/distribution/products', { legal_entity_id: le, sku: 'MLK', name: 'حليب', unit: 'carton', price: '0.350' }, T);
await call('POST', '/v1/distribution/products', { legal_entity_id: le, sku: 'LBN', name: 'لبن', unit: 'carton', price: '0.250' }, T);
const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `90-${stamp.slice(-5)}`, odometer_km: 50_000 }, T);
const driverPhone = `6${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مبارك', phone: `+965${driverPhone}` }, T);
const kwDay = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const route = await call('POST', '/v1/distribution/routes', { legal_entity_id: le, route_date: kwDay, asset_id: truck.id, driver_worker_id: w.id, start_time: '00:00', end_time: '23:59',
  stops: [{ name: 'فرع السالمية', items: [{ sku: 'MLK', qty: 20 }, { sku: 'LBN', qty: 10 }] }, { name: 'بقالة الرميثية', payment: 'cash', items: [{ sku: 'MLK', qty: 10 }] }] }, T);
ok(`المكتب: المسار ${route.ref} بتوقفين (فرع على الحساب وبقالة نقدًا)`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.33, longitude: 48.07 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
async function typeInto(locator, text, clear = false) {
  await locator.click();
  await p.waitForTimeout(400);
  if (clear) { await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace'); }
  await p.keyboard.type(text, { delay: 30 });
}
const see = (t) => p.locator(`flt-semantics[aria-label*="${t}"], flt-semantics:has-text("${t}")`).last();
const btn = (name) => p.getByRole('button', { name, exact: false }).first();
try {
  await p.goto(APP);
  await typeInto(p.getByLabel('رقم الجوال'), driverPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see('2 توقفات').waitFor();
  ok('دخول السائق: المسار ثم توقفاته في القائمة');

  await see('2 توقفات').click();
  await see('قائمة التحميل').waitFor();
  await see('حليب').waitFor();
  await shot(p, 'dd01-route');
  await btn('قبول المسار').click();
  await btn('راجعت الحمولة').click();
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '50010');
  await btn('تأكيد').click();
  await btn('انطلقت من المستودع').click();
  await btn('عدت للمستودع').waitFor();
  ok('قائمة التحميل (حليب 30، لبن 10)، مراجعة الحمولة بالعدّاد، والانطلاق');

  await p.goBack();
  await see('فرع السالمية').click();
  await btn('تسليم').click();
  await typeInto(p.getByLabel('سُلّم لبن'), '8', true);
  await typeInto(p.getByLabel('مرتجع حليب'), '2');
  await shot(p, 'dd02-stop');
  await btn('تأكيد التسليم').click();
  await see('بقالة الرميثية').waitFor();
  await see('بقالة الرميثية').click();
  await btn('تسليم').click();
  await see('3.500 KWD').waitFor();
  await btn('تأكيد التسليم').click();
  await see('أدخل المبلغ المحصّل').waitFor();
  await typeInto(p.getByLabel('المبلغ المحصّل (د.ك)'), '3.5');
  await btn('تأكيد التسليم').click();
  ok('التوقف الأول: لبن 8 من 10 ومرتجع حليب 2؛ الثاني نقدًا: المستحق 3.500 والمحصّل 3.500');

  await see('2 توقفات').click();
  await btn('عدت للمستودع').click();
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '50048');
  await btn('تأكيد العودة').click();
  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/distribution/routes/${route.id}`, undefined, T);
    if (d.status === 'back' && d.task_status === 'completed') break;
    await p.waitForTimeout(500);
  }
  const [s1, s2] = d.stops;
  if (d.status !== 'back' || d.km !== 38 || s1.delivered.LBN !== 8 || s1.returned.MLK !== 2 || s2.cash_collected !== '3.500' || d.task_status !== 'completed') throw new Error(`route ${JSON.stringify(d)}`);
  ok('العودة: المسار «عاد» بمسافة 38 كم، والخادم سجّل الكميات والمرتجع والنقد');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'dd-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
