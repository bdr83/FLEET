// Driver app, staff transport (shuttle pack): the trip with its stops and times, mark riders boarded or absent, leave and arrive.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_shuttle.mjs
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
const co = await call('POST', '/v1/tenants', { name: 'نقل العمال', packs: ['shuttle'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const bus = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `88-${stamp.slice(-5)}` }, T);
const driverPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'راجو', phone: `+965${driverPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'شركة المقاولات الوطنية' }, T);
// a trip leaving in 30 minutes (Kuwait time)
const at = new Date(Date.now() + 3 * 3_600_000 + 30 * 60_000).toISOString();
const route = await call('POST', '/v1/shuttle/routes', { legal_entity_id: le, customer_id: cu.id, code: 'R7', name: 'المصفاة ← المهبولة', direction: 'from_work', depart_time: at.slice(11, 16),
  duration_min: 60, days: [1, 2, 3, 4, 5, 6, 7], capacity: 30, asset_id: bus.id, driver_worker_id: w.id,
  stops: [{ name: 'مصفاة الأحمدي' }, { name: 'سكن المهبولة', area: 'المهبولة', offset_min: 45 }] }, T);
await call('POST', `/v1/shuttle/routes/${route.id}/riders`, { riders: [{ name: 'أنيل', staff_no: 'E-1', stop_seq: 2 }, { name: 'جوزيف', staff_no: 'E-2', stop_seq: 2 }] }, T);
const g = await call('POST', '/v1/shuttle/trips/generate', { date: at.slice(0, 10), route_ids: [route.id] }, T);
if (g.created[0] !== 'R7') throw new Error(`generate ${JSON.stringify(g)}`);
const trip = (await call('GET', `/v1/shuttle/trips?date=${at.slice(0, 10)}`, undefined, T)).data[0];
ok('المكتب: خط R7 من العمل للسكن براكبين، ورحلته اليوم مسندة للحافلة والسائق');

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
  await typeInto(p.getByLabel('رقم الجوال'), driverPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see('SH-R7').click();
  await see('نقل موظفين من العمل').waitFor();
  await see('صعد 0 من 2').waitFor();
  await see('اقبل الرحلة لتسجيل صعود الركاب').waitFor();
  await shot(p, 'sh01-trip');
  ok('بطاقة الرحلة: الاتجاه والمحطات والركاب، والتسجيل بعد القبول');

  await btn('قبول الرحلة').click();
  await btn('صعد أنيل').click();
  await btn('غائب جوزيف').click();
  await see('صعد 1 من 2').waitFor();
  await btn('صعد جوزيف').click(); // he arrived late: the last mark counts
  await see('صعد 2 من 2').waitFor();
  await shot(p, 'sh02-board');
  ok('تسجيل الصعود والغياب، والتصحيح بآخر تسجيل');

  await btn('انطلقت').click();
  await btn('وصلت وأنهيت الرحلة').click();
  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/shuttle/trips/${trip.id}`, undefined, T);
    if (d.status === 'completed' && d.boarded === 2) break;
    await p.waitForTimeout(500);
  }
  if (d.status !== 'completed' || d.boarded !== 2 || d.no_show !== 0 || !d.started_at) throw new Error(`trip ${JSON.stringify({ s: d.status, b: d.boarded, n: d.no_show })}`);
  ok('الانطلاق والوصول: الرحلة مكتملة بصعود الراكبين عند المكتب');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'sh-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
