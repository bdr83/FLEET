// Browser test of the driver app's mixer trip (concrete@1) against a running API (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL).
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_concrete.mjs
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

// Office side, through the API: a ready-mix company, one mixer, a driver and a pour order; load 1 goes to the driver
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'خرسانة الخليج' }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const plate = `MX-${stamp.slice(-4)}`;
const mixer = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'mixer', plate_no: plate, capacity: { m3: 9 } }, T);
const driverPhone = `6${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فهد المطيري', phone: `+965${driverPhone}` }, T);
const pour = await call('POST', '/v1/concrete/pours', { legal_entity_id: le, ref: `RM-${stamp}`, mix_code: 'C35', volume_m3: 12, pour_rate_m3h: 30,
  scheduled_at: new Date(Date.now() + 45 * 60_000).toISOString(), site: { name: 'برج الريم', area: 'الشرق', lat: 29.375, lng: 47.99, contact_name: 'م. خالد', contact_phone: '50000009' } }, T);
const load = pour.loads[0];
await call('POST', `/v1/tasks/${load.task_id}/assign`, { version: load.version, worker_id: w.id, asset_id: mixer.id }, T);
ok('المكتب: خلاطة وسائق وطلب صب 12 م³، والحمولة الأولى (9 م³) مسندة للسائق');

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.3341, longitude: 48.0745 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
async function typeInto(locator, text, { clear = false } = {}) {
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
  await see('فهد المطيري').waitFor();
  await btn('بدء الوردية').click();
  await btn('ابدأ').waitFor();
  await btn('ابدأ').click();
  await see('الوردية مفتوحة').waitFor();
  ok('دخول السائق وبدء الوردية بالخلاطة');

  await see('برج الريم').click();
  await see(`RM-${stamp}-1`).waitFor();
  await see('خلطة C35').waitFor();
  await see('م. خالد').waitFor();
  await btn('قبول الحمولة').click();
  await btn('تم التحميل من المحطة').click();
  await btn('انطلقت إلى الموقع').click();
  await btn('وصلت للموقع').click();
  await shot(p, 'm01-load');
  await btn('بدأ الصب').click();
  await btn('انتهى الصب').click();
  ok('مراحل رحلة الخلاطة: قبول، تحميل، انطلاق، وصول، بدء الصب، انتهاء الصب');

  await btn('توقيع تذكرة التسليم').click();
  await see('تذكرة التسليم').waitFor();
  await typeInto(p.getByLabel('الكمية المصبوبة (م³)'), '8.5', { clear: true });
  await typeInto(p.getByLabel('الكمية المرتجعة (م³)'), '1', { clear: true });
  await btn('تأكيد التذكرة وإنهاء الحمولة').click();
  await see('المصبوب والمرتجع أكثر من حمولة الخلاطة').waitFor();
  await shot(p, 'm02-ticket');
  ok('التذكرة ترفض كمية أكبر من الحمولة قبل الإرسال');

  await typeInto(p.getByLabel('الكمية المرتجعة (م³)'), '0.5', { clear: true });
  await btn('تأكيد التذكرة وإنهاء الحمولة').click();
  await see('لا توجد مهام مسندة إليك الآن').waitFor();
  ok('توقيع مهندس الموقع (الاسم معبأ من الطلب) وإنهاء الحمولة');

  let info;
  for (let i = 0; i < 20; i++) {
    info = await call('GET', `/v1/concrete/tasks/${load.task_id}`, undefined, T);
    if (info.ticket.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  const t = info.ticket;
  if (t.status !== 'completed' || t.poured_m3 !== 8.5 || t.returned_m3 !== 0.5 || t.signed_by !== 'م. خالد' || !t.batched_at || !t.pour_end) throw new Error(`ticket ${JSON.stringify(t)}`);
  ok('الخادم: الحمولة مكتملة، التذكرة موقّعة 8.5 م³ و0.5 مرتجع، ووقت الخلط والصب مسجّلان');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'm-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
