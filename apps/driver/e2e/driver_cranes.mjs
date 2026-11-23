// Driver app, crane working day (cranes pack): the lift plans with load and utilization; the day cannot end with an open
// lift; a lift done with the wind speed (over the crane's limit refused), another stopped with the reason; then the day
// ends and the office sees both lifts closed.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_cranes.mjs
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

// Office side, through the API: a cranes company, a crane with its chart and certificate, an operator and a rigger with
// their cards, a hire for today, and two lift plans: a light one and a critical one (80%) approved
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'رافعات الخليج', packs: ['cranes'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const crane = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'crane', plate_no: `MC-${stamp.slice(-5)}` }, T);
await call('PUT', `/v1/cranes/fleet/${crane.id}`, { max_capacity_t: 50, wind_limit_ms: 9, chart: [{ radius_m: 3, capacity_t: 50 }, { radius_m: 10, capacity_t: 20 }, { radius_m: 20, capacity_t: 8 }] }, T);
const opPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مشغّل الرافعة', phone: `+965${opPhone}` }, T);
const rg = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'الموجّه سالم', phone: `+9656${stamp}` }, T);
const until = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
await call('POST', '/v1/documents', { asset_id: crane.id, doc_type: 'tpi_certificate', expires_on: until }, T);
await call('POST', '/v1/documents', { worker_id: w.id, doc_type: 'crane_operator', expires_on: until }, T);
await call('POST', '/v1/documents', { worker_id: rg.id, doc_type: 'rigger_cert', expires_on: until }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مقاولات البناء' }, T);
const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const hire = await call('POST', '/v1/equipment/hires', { legal_entity_id: le, customer_id: cu.id, asset_id: crane.id, operator_worker_id: w.id, site: { name: 'برج الشرق', area: 'الشرق' },
  starts_on: today, ends_on: today, shift_start: '00:00', shift_end: '23:59', work_days: [1, 2, 3, 4, 5, 6, 7], min_hours: 8 }, T);
const lift = (o) => call('POST', '/v1/cranes/lifts', { hire_id: hire.id, lift_date: today, rigger_worker_id: rg.id, ...o }, T);
const l1 = await lift({ lift_time: '09:00', description: 'رفع مولد', load_t: 16, radius_m: 10 });
const l2 = await lift({ lift_time: '11:00', description: 'رفع خزان مياه', load_t: 4, radius_m: 15 });
await call('POST', `/v1/cranes/lifts/${l1.id}/approve`, {}, T);
ok(`المكتب: عقد ${hire.ref} لرافعة اليوم وخطتا رفع: ${l1.ref} حرجة 80% معتمدة، ${l2.ref} 50%`);

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
  await see('خطط الرفع اليوم').waitFor();
  await see('رفع مولد').waitFor();
  await see('رفعة حرجة معتمدة').waitFor();
  await shot(p, 'cr01-lifts');
  ok('بطاقة خطط الرفع: الرفعتان بالحمولة ونسبة الاستخدام، والحرجة معتمدة');

  await btn('قبول يوم العمل').click();
  await btn('بدأت العمل').click();
  await typeInto(p.getByLabel('عدّاد الساعات'), '800');
  await btn('تأكيد البدء').click();
  await btn('انتهى العمل').waitFor();
  await btn('انتهى العمل').click();
  await see('سجّل كل رفعة منفذة أو موقوفة').waitFor();
  ok('لا يُنهى يوم العمل والرفعات مفتوحة');

  await btn(`نُفذت ${l1.ref}`).click();
  await typeInto(p.getByLabel('سرعة الرياح الآن (م/ث)'), '11');
  await p.getByRole('button', { name: 'نُفذت', exact: true }).click();
  await see('الرياح فوق حد الرافعة').waitFor();
  await btn(`نُفذت ${l1.ref}`).click();
  await typeInto(p.getByLabel('سرعة الرياح الآن (م/ث)'), '6.5');
  await p.getByRole('button', { name: 'نُفذت', exact: true }).click();
  await see('سُجّلت الرفعة منفذة').waitFor();
  await btn(`أوقفت ${l2.ref}`).click();
  await typeInto(p.getByLabel('سبب الإيقاف'), 'الموقع غير جاهز');
  await p.getByRole('button', { name: 'أوقفت', exact: true }).click();
  await see('سُجّل إيقاف الرفعة').waitFor();
  await shot(p, 'cr02-recorded');
  ok('رياح 11 م/ث مرفوضة فوق الحد، الحرجة منفذة برياح 6.5، والثانية موقوفة بسبب');

  await btn('انتهى العمل').click();
  await typeInto(p.getByLabel('عدّاد الساعات'), '806');
  await typeInto(p.getByLabel('اسم مشرف الموقع'), 'م. ناصر');
  await btn('تأكيد الانتهاء').click();
  let ls;
  for (let i = 0; i < 20; i++) {
    ls = (await call('GET', `/v1/cranes/lifts?date=${today}`, undefined, T)).data;
    if (ls.every((x) => x.day_status === 'completed')) break;
    await p.waitForTimeout(500);
  }
  const a = ls.find((x) => x.id === l1.id), b = ls.find((x) => x.id === l2.id);
  if (a.status !== 'done' || a.wind_ms !== 6.5 || b.status !== 'aborted' || b.abort_reason !== 'الموقع غير جاهز' || a.day_status !== 'completed') throw new Error(`lifts ${JSON.stringify(ls.map((x) => [x.ref, x.status, x.wind_ms, x.abort_reason, x.day_status]))}`);
  ok('عند المكتب: الرفعة منفذة برياح 6.5 والثانية موقوفة بسببها، ويوم العمل مكتمل');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'cr-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
