// Driver app, taxi (taxi pack): the ride card with the passenger and places, on the way, arrived, passenger on board, then
// the drop with the km and cash payment showing the fare from the tariff; the office sees the ride done with its fare.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_taxi.mjs
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

// Office side, through the API: a sedan, a driver, the sedan tariff and a booking now, assigned
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'تاكسي الطلب', packs: ['taxi'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const car = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'car', plate_no: `33-${stamp.slice(-5)}` }, T);
await call('PUT', `/v1/taxi/cars/${car.id}`, { class: 'sedan' }, T);
await call('PUT', '/v1/taxi/tariffs', { legal_entity_id: le, class: 'sedan', base: '0.350', per_km: '0.150', per_wait_min: '0.050', min_fare: '1.000' }, T);
const drvPhone = `9${stamp}`;
const drv = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سالم', phone: `+965${drvPhone}` }, T);
const b = await call('POST', '/v1/taxi/bookings', { legal_entity_id: le, passenger_name: 'محمد', passenger_phone: '+96599112233', pickup: { area: 'حولي', block: '3' },
  dropoff: { name: 'مستشفى الصباح', area: 'الشويخ' } }, T);
await call('POST', `/v1/taxi/bookings/${b.id}/assign`, { asset_id: car.id, driver_worker_id: drv.id }, T);
ok(`المكتب: حجز ${b.ref} فوري لمحمد من حولي إلى مستشفى الصباح، مسند لسالم بسيارة صالون`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.1, longitude: 48.1 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
async function typeInto(locator, text) {
  await locator.click();
  await p.waitForTimeout(400);
  await p.keyboard.type(text, { delay: 30 });
}
const see = (t) => p.locator(`flt-semantics[aria-label*="${t}"], flt-semantics:has-text("${t}")`).last();
const btn = (name) => p.getByRole('button', { name, exact: false }).first();
try {
  await p.goto(APP);
  await btn('الدخول برقم الجوال').click();
  await typeInto(p.getByLabel('رقم الجوال'), drvPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(b.ref).click();
  await see('محمد').waitFor();
  await see('إلى: مستشفى الصباح').waitFor();
  await shot(p, 'tx01-ride');
  ok('بطاقة المشوار: الراكب وهاتفه ومكان الالتقاط والوجهة');

  await btn('قبول الحجز').click();
  await btn('انطلقت للراكب').click();
  await btn('وصلت لمكان الراكب').click();
  await btn('ركب الراكب').click();
  await btn('وصلنا، إنهاء المشوار').click();
  await typeInto(p.getByLabel('كيلومترات المشوار'), '10');
  await see('1.850').waitFor();
  await shot(p, 'tx02-drop');
  await btn('تأكيد').click();
  ok('الوصول والركوب ثم النزول بعشرة كيلومترات نقدًا، والأجرة 1.850 د.ك تظهر للسائق');

  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/taxi/bookings/${b.id}`, undefined, T);
    if (d.state === 'done' && d.task_id) break;
    await p.waitForTimeout(500);
  }
  if (d.state !== 'done' || d.fare !== '1.850' || d.payment !== 'cash' || d.km !== 10) throw new Error(`booking ${JSON.stringify({ s: d.state, f: d.fare, p: d.payment, k: d.km })}`);
  ok('عند المكتب: المشوار منتهٍ بأجرة 1.850 نقدًا و10 كم');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'tx-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
