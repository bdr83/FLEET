// Browser test of the driver app's driver-supply day-shift (staffing@1) against a running API (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL).
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_staffing.mjs
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

// Office side, through the API: a supply company, a customer, an eligible driver placed on a two-day request
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'توريد الخليج' }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);
const customer = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'شركة التموين' }, T);
const driverPhone = `6${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فهد المطيري', phone: `+965${driverPhone}` }, T);
for (const doc_type of ['driving_license', 'residency']) await call('POST', '/v1/documents', { doc_type, worker_id: w.id, expires_on: kwDay(300) }, T);
const req = await call('POST', '/v1/staffing/requests', { legal_entity_id: le, customer_id: customer.id, ref: `SR-${stamp}`, headcount: 1, starts_on: kwDay(), ends_on: kwDay(1),
  shift_start: '00:00', shift_end: '23:59', work_days: [0, 1, 2, 3, 4, 5, 6], site: { name: 'مستودع الري', area: 'الري', lat: 29.3341, lng: 48.0745, contact_name: 'أبو محمد', contact_phone: '50000011' } }, T);
await call('POST', `/v1/staffing/requests/${req.id}/placements`, { worker_id: w.id }, T);
ok('المكتب: عميل وسائق مؤهل معيّن على طلب توريد ليومين');

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.3342, longitude: 48.0746 } });
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
  await see('فهد المطيري').waitFor();
  ok('دخول السائق: يرى مناوبات اليوم والغد فقط');

  await see(`SR-${stamp}-1-${kwDay().replaceAll('-', '')}`).click();
  await see('مناوبة لدى العميل').waitFor();
  await see('00:00–23:59').waitFor();
  await see('أبو محمد').waitFor();
  await shot(p, 'st01-shift');
  await btn('تسجيل الحضور').click();
  await btn('تسجيل الانصراف').waitFor();
  await see('سجّل الحضور').waitFor();
  await shot(p, 'st02-checked-in');
  ok('بطاقة المناوبة (الدوام والموقع والمسؤول) وتسجيل الحضور بضغطة واحدة');

  await btn('تسجيل الانصراف').click();
  await see('بانتظار اعتماد العميل').waitFor().catch(() => {});
  // tomorrow's shift is listed, but its check-in is not open yet
  await see(`SR-${stamp}-1-${kwDay(1).replaceAll('-', '')}`).click();
  await see('يفتح تسجيل الحضور').waitFor();
  if (await btn('تسجيل الحضور').count()) throw new Error('check-in offered a day early');
  await shot(p, 'st03-tomorrow');
  ok('تسجيل الانصراف وإنهاء المناوبة، ومناوبة الغد لا يُفتح حضورها قبل موعدها');

  let s;
  for (let i = 0; i < 20; i++) {
    s = (await call('GET', `/v1/staffing/timesheet?from=${kwDay()}&to=${kwDay()}&request_id=${req.id}`, undefined, T)).data[0];
    if (s?.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (s?.status !== 'completed' || !s.check_in || !s.check_out || s.hours === null || s.checkin_distance_m === null || s.checkin_distance_m > 50) throw new Error(`shift ${JSON.stringify(s)}`);
  ok(`الخادم: المناوبة مكتملة، الحضور على بعد ${s.checkin_distance_m} م من الموقع، والساعات محسوبة (${s.hours})`);

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'st-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
