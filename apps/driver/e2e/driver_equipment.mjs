// Driver app, heavy equipment hire (equipment pack): the operator's working day with the hour meter, downtime and the site supervisor.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_equipment.mjs
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
const co = await call('POST', '/v1/tenants', { name: 'تأجير المعدات', packs: ['equipment'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const crane = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'crane', plate_no: `CR-${stamp.slice(-5)}` }, T);
const opPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مشغّل الكرين', phone: `+965${opPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مقاولات الخليج' }, T);
const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const hire = await call('POST', '/v1/equipment/hires', { legal_entity_id: le, customer_id: cu.id, asset_id: crane.id, operator_worker_id: w.id, site: { name: 'مشروع جسر الجهراء', area: 'الجهراء' },
  starts_on: today, ends_on: today, shift_start: '00:00', shift_end: '23:59', work_days: [1, 2, 3, 4, 5, 6, 7], min_hours: 8 }, T);
ok(`المكتب: عقد ${hire.ref} لرافعة بمشغّلها اليوم`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.33, longitude: 47.67 } });
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
  await typeInto(p.getByLabel('رقم الجوال'), opPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(hire.ref).click();
  await see('تأجير معدة').waitFor();
  await see('رافعة (كرين)').waitFor();
  await see('الحد الأدنى اليومي 8 ساعات').waitFor();
  await shot(p, 'eq01-day');
  ok('بطاقة يوم العمل: المعدة والدوام والحد الأدنى والموقع');

  await btn('قبول يوم العمل').click();
  await btn('بدأت العمل').click();
  await typeInto(p.getByLabel('عدّاد الساعات'), '1520.5');
  await btn('تأكيد البدء').click();
  await btn('انتهى العمل').waitFor();
  ok('بدء العمل بقراءة العدّاد 1520.5');

  await btn('انتهى العمل').click();
  await typeInto(p.getByLabel('عدّاد الساعات'), '1526');
  await typeInto(p.getByLabel('ساعات توقف بسبب عطل (إن وُجدت)'), '1.5');
  await typeInto(p.getByLabel('اسم مشرف الموقع'), 'م. خالد');
  await shot(p, 'eq02-end');
  await btn('تأكيد الانتهاء').click();
  let d;
  for (let i = 0; i < 20; i++) {
    d = (await call('GET', `/v1/equipment/days?date=${today}`, undefined, T)).data[0];
    if (d?.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (d.status !== 'completed' || d.meter_start !== 1520.5 || d.meter_end !== 1526 || d.downtime_hours !== 1.5 || d.signed_by !== 'م. خالد') throw new Error(`day ${JSON.stringify(d)}`);
  ok('انتهاء العمل: 5.5 ساعات وتوقف 1.5 بإقرار مشرف الموقع، واليوم مكتمل عند المكتب');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'eq-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
