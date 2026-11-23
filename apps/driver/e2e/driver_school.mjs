// Driver app, school transport (school pack), as the attendant: the trip home with stops and students, an absence notice,
// mark students boarded, the trip cannot end with a child on the bus, a young child handed to a named adult, then end.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_school.mjs
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

// Office side, through the API: a bus, a driver, an attendant, a route home with three students and an absence notice
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'باصات المدارس', packs: ['school'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const bus = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `66-${stamp.slice(-5)}` }, T);
const drv = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'أبو فهد', phone: `+9656${stamp}` }, T);
const attPhone = `9${stamp}`;
const att = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'supervisor', display_name: 'أم سارة', phone: `+965${attPhone}` }, T);
// a trip leaving in 30 minutes (Kuwait time)
const at = new Date(Date.now() + 3 * 3_600_000 + 30 * 60_000).toISOString();
const route = await call('POST', '/v1/school/routes', { legal_entity_id: le, school_name: 'مدرسة النور', code: 'N7', name: 'النور ← الجابرية', direction: 'from_school', depart_time: at.slice(11, 16),
  duration_min: 60, days: [1, 2, 3, 4, 5, 6, 7], capacity: 24, asset_id: bus.id, driver_worker_id: drv.id, attendant_worker_id: att.id,
  stops: [{ name: 'مدرسة النور' }, { name: 'الجابرية ق 5', area: 'الجابرية', offset_min: 20 }] }, T);
const kids = await call('POST', `/v1/school/routes/${route.id}/students`, { students: [
  { name: 'سارة', grade: 'KG2', stop_seq: 2, guardian_name: 'أم سارة', guardian_phone: '+96599001111' },
  { name: 'عبدالله', grade: '6', stop_seq: 2, guardian_phone: '+96599002222' },
  { name: 'نورة', grade: '8', stop_seq: 2, guardian_phone: '+96599003333' }] }, T);
await call('POST', '/v1/school/absences', { student_id: kids.ids[2], date: at.slice(0, 10), scope: 'from_school' }, T);
const g = await call('POST', '/v1/school/trips/generate', { date: at.slice(0, 10), route_ids: [route.id] }, T);
if (g.created[0] !== 'N7') throw new Error(`generate ${JSON.stringify(g)}`);
const trip = (await call('GET', `/v1/school/trips?date=${at.slice(0, 10)}`, undefined, T)).data[0];
ok('المكتب: خط N7 للعودة بثلاثة طلاب، نورة مبلَّغ بغيابها، ورحلته اليوم مسندة للسائق والمشرفة');

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
  await typeInto(p.getByLabel('رقم الجوال'), attPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see('SC-N7').click();
  await see('نقل مدرسي: إلى البيوت').waitFor();
  await see('المشرفة').waitFor();
  await see('في الحافلة 0 · نزل 0 · غائب 1 · لم يُسجَّل 2').waitFor();
  await see('بلّغ بالغياب').waitFor();
  await shot(p, 'sc01-trip');
  ok('بطاقة المشرفة: المدرسة والمحطات والطلاب بهواتف أولياء الأمور، ونورة «بلّغ بالغياب»');

  await btn('قبول الرحلة').click();
  await btn('صعد سارة').click();
  await btn('صعد عبدالله').click();
  await see('في الحافلة 2').waitFor();
  await btn('انطلقت').click();
  await btn('وصلت وأنهيت الرحلة').click();
  await see('ما زال طالب في الحافلة').waitFor();
  await shot(p, 'sc02-blocked');
  ok('لا يمكن إنهاء الرحلة وفي الحافلة طلاب');

  await btn('نزل عبدالله').click();
  await btn('نزل سارة').click();
  await p.getByRole('textbox').last().waitFor();
  await btn('تم التسليم').click();
  await see('استلمه: أم سارة').waitFor();
  await see('في الحافلة 0 · نزل 2').waitFor();
  await shot(p, 'sc03-handover');
  await btn('وصلت وأنهيت الرحلة').click();
  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/school/trips/${trip.id}`, undefined, T);
    if (d.dropped === 2 && d.on_board === 0) break;
    await p.waitForTimeout(500);
  }
  const sara = d.students.find((x) => x.name === 'سارة');
  if (d.dropped !== 2 || d.on_board !== 0 || sara.received_by !== 'أم سارة') throw new Error(`trip ${JSON.stringify({ dr: d.dropped, ob: d.on_board, rb: sara.received_by })}`);
  const tasks = (await call('GET', `/v1/tasks?q=SC-N7`, undefined, T)).data ?? [];
  const mine = tasks.find((x) => x.ref?.endsWith('-A'));
  if (mine && mine.status !== 'completed') throw new Error(`attendant task ${mine.status}`);
  ok('نزول عبدالله، وتسليم سارة لأمها باسمها، ثم إنهاء رحلة المشرفة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'sc-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
