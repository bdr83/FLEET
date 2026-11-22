// Browser test of the driver app's haulage trip (freight@1) against a running API (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL).
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_freight.mjs
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

// Office side, through the API: a truck and trailer, a driver, a priced customer and a transport order assigned to them
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'شركة نقل تجريبية' }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `TR-${stamp.slice(-5)}` }, T);
const trailer = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'trailer', plate_no: `TL-${stamp.slice(-5)}` }, T);
const driverPhone = `6${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'حمد سائق الشاحنة', phone: `+965${driverPhone}` }, T);
let s = await call('POST', '/v1/freight/shipments', { legal_entity_id: le, waybill_no: `WB-${stamp}`, cargo: { description: 'أكياس أسمنت', packages: 400, weight_kg: 20000 },
  pickup: { name: 'مصنع الأسمنت', area: 'الشعيبة', lat: 29.03, lng: 48.1 }, dropoff: { name: 'مشروع المطلاع', area: 'المطلاع', lat: 29.6, lng: 47.7 },
  pickup_at: new Date(Date.now() - 600_000).toISOString(), deliver_by: new Date(Date.now() + 4 * 3_600_000).toISOString(), planned_km: 80 }, T);
s = await call('POST', `/v1/freight/shipments/${s.task_id}/plan`, { version: s.version, trailer_asset_id: trailer.id }, T);
await call('POST', `/v1/tasks/${s.task_id}/assign`, { version: s.version, worker_id: w.id, asset_id: truck.id, exclusive: true }, T);
ok(`المكتب: أمر نقل ${s.waybill_no} على شاحنة ومقطورة وسائق`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.03, longitude: 48.1 } });
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
  await typeInto(p.getByLabel('رقم الجوال'), driverPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(`WB-${stamp}`).waitFor();
  ok('دخول السائق: الرحلة في قائمته');

  await see(`WB-${stamp}`).click();
  await see('بوليصة النقل').waitFor();
  await see('أكياس أسمنت').waitFor();
  await see(`TL-${stamp.slice(-5)}`).waitFor();
  await see('مصنع الأسمنت').waitFor();
  await shot(p, 'fr01-trip');
  ok('بطاقة البوليصة: الحمولة والمقطورة ونقطة التحميل');

  await btn('قبول الرحلة').click();
  await btn('وصلت لنقطة التحميل').click();
  await btn('تم التحميل').click();
  await typeInto(p.getByLabel('الوزن (كغ) إن وُزنت'), '19950');
  await typeInto(p.getByLabel('رقم الختم (إن وُجد)'), 'S-501');
  await btn('تأكيد التحميل').click();
  await btn('انطلقت إلى التفريغ').click();
  await btn('وصلت لنقطة التفريغ').click();
  await btn('تم التفريغ والتسليم').click();
  await typeInto(p.getByLabel('اسم المستلم'), 'م. عبدالله');
  await shot(p, 'fr02-unload');
  await btn('تأكيد التسليم').click();
  await btn('إنهاء الرحلة').click();
  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/freight/shipments/${s.task_id}`, undefined, T);
    if (d.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (d.status !== 'completed' || d.loaded_weight_kg !== 19950 || d.seal_no !== 'S-501' || d.received_by !== 'م. عبدالله' || d.quantities?.trip !== 1) throw new Error(`shipment ${JSON.stringify(d)}`);
  ok('التحميل بالوزن والختم، والتفريغ باسم المستلم، والرحلة مكتملة بكمية «رحلة» للفاتورة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'fr-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
