// Browser test of the driver app's in-house trip (internal@1) against a running API (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL).
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_internal.mjs
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

// Office side, through the API: a department, a van, a driver, and an approved request with a driver allocated to them
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'شركة تجريبية' }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const dept = await call('POST', '/v1/internal/departments', { legal_entity_id: le, name: 'العلاقات العامة' }, T);
const van = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'van', plate_no: `56-${stamp.slice(-5)}`, odometer_km: 30_000 }, T);
const driverPhone = `6${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سعد سائق الشركة', phone: `+965${driverPhone}` }, T);
let vr = await call('POST', '/v1/internal/requests', { purpose: 'استقبال وفد في المطار', destination: 'مطار الكويت', with_driver: true, passengers: 5, department_id: dept.id,
  starts_at: new Date(Date.now() - 600_000).toISOString(), ends_at: new Date(Date.now() + 3 * 3_600_000).toISOString() }, T);
vr = await call('POST', `/v1/internal/requests/${vr.id}/decide`, { version: vr.version, approve: true }, T);
vr = await call('POST', `/v1/internal/requests/${vr.id}/allocate`, { version: vr.version, asset_id: van.id, driver_worker_id: w.id }, T);
ok(`المكتب: طلب ${vr.ref} موافق عليه ومخصص له فان وسائق`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.24, longitude: 47.97 } });
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
async function odometer(km, fuel) {
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), String(km));
  if (fuel) await see(fuel).click();
}
try {
  await p.goto(APP);
  await typeInto(p.getByLabel('رقم الجوال'), driverPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see('استقبال وفد في المطار').waitFor();
  ok('دخول السائق: المشوار في قائمته بغرضه');

  await see(vr.ref).click();
  await see('مشوار لموظف في الشركة').waitFor();
  await see('العلاقات العامة').waitFor();
  await see('مطار الكويت').waitFor();
  await shot(p, 'in01-trip');
  await btn('قبول المشوار').click();
  await btn('استلمت المركبة').click();
  await odometer(29_000);
  await btn('تأكيد الاستلام').click();
  await see('العدّاد أقل من آخر قراءة').waitFor();
  ok('بطاقة المشوار، والقبول، ورفض عدّاد أقل من آخر قراءة للمركبة');

  await btn('استلمت المركبة').click();
  await odometer(30_010, 'ممتلئ');
  await btn('تأكيد الاستلام').click();
  await btn('أرجعت المركبة').waitFor();
  await see('المركبة معك').waitFor();
  await shot(p, 'in02-out');
  ok('استلام المركبة بالعدّاد والوقود يبدأ المشوار');

  await btn('أرجعت المركبة').click();
  await odometer(30_065, '4/8');
  await shot(p, 'in03-back');
  await btn('تأكيد الإرجاع').click();
  let s, t;
  for (let i = 0; i < 20; i++) {
    s = await call('GET', `/v1/internal/requests/${vr.id}`, undefined, T);
    t = await call('GET', `/v1/tasks/${s.task_id}`, undefined, T);
    if (s.status === 'returned' && t.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (s.status !== 'returned' || s.km !== 55 || s.out_fuel !== 8 || s.back_fuel !== 4) throw new Error(`request ${JSON.stringify(s)}`);
  if (t.status !== 'completed') throw new Error(`task ${t.status}`);
  ok('الإرجاع: الطلب «أُرجعت» بمسافة 55 كم ووقود 8/8 ← 4/8، والمهمة مكتملة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'in-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
