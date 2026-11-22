// Browser test of the driver app's cold-chain route (coldchain pack) against a running API (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL).
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_coldchain.mjs
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

// Office side, through the API: a cold-chain company, a chilled route with one stop and an item with its expiry
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'مبردات الخليج', packs: ['coldchain'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
await call('POST', '/v1/distribution/products', { legal_entity_id: le, sku: 'CHK', name: 'دجاج', unit: 'carton', price: '1.500' }, T);
const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `RF-${stamp.slice(-5)}`, odometer_km: 50_000 }, T);
const driverPhone = `6${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سالم', phone: `+965${driverPhone}` }, T);
const kwDay = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const route = await call('POST', '/v1/distribution/routes', { legal_entity_id: le, route_date: kwDay, asset_id: truck.id, driver_worker_id: w.id, start_time: '00:00', end_time: '23:59',
  temp_class: 'chilled', stops: [{ name: 'مطعم الشيف', window_from: '00:00', window_to: '23:59', items: [{ sku: 'CHK', qty: 20, expiry: '2099-01-31' }] }] }, T);
ok(`المكتب: مسار مبرد ${route.ref} بتوقف واحد وصنف بتاريخ صلاحيته`);

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
  await btn('الدخول برقم الجوال').click();
  await typeInto(p.getByLabel('رقم الجوال'), driverPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see('1 توقفات').click();
  await see('مبرد').waitFor();
  await btn('قبول المسار').click();
  await btn('راجعت الحمولة').click();
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '50010');
  await btn('تأكيد').click();
  await btn('انطلقت من المستودع').click();
  await btn('عدت للمستودع').waitFor();
  ok('المسار يُظهر «مبرد» ونطاقه، ثم القبول ومراجعة الحمولة والانطلاق');

  await btn('تسجيل الحرارة').click();
  await typeInto(p.getByLabel('الحرارة (°C)'), '7.5');
  await shot(p, 'dc01-temp');
  await p.getByRole('button', { name: 'تسجيل', exact: true }).click();
  await see('خارج النطاق').waitFor();
  ok('تسجيل الحرارة 7.5° من الثلاجة: التطبيق ينبّه أنها خارج النطاق');

  await p.goBack();
  await see('مطعم الشيف').click();
  await see('صلاحية 2099-01-31').waitFor();
  await btn('تسليم').click();
  await typeInto(p.getByLabel('سُلّم دجاج'), '18', true);
  await typeInto(p.getByLabel('تالف دجاج'), '2');
  await shot(p, 'dc02-stop');
  await btn('تأكيد التسليم').click();
  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/distribution/routes/${route.id}`, undefined, T);
    if (d.temps.length && d.stops[0].delivered) break;
    await p.waitForTimeout(500);
  }
  const t0 = d.temps[0], s1 = d.stops[0];
  if (t0?.reading_c !== 7.5 || t0.in_range !== false || t0.source !== 'manual' || s1.delivered?.CHK !== 18 || s1.damaged?.CHK !== 2) throw new Error(`route ${JSON.stringify(d)}`);
  ok('التسليم: 18 سليمة و2 تالفة؛ الخادم سجّل القراءة خارج النطاق والكمية التالفة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'dc-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
