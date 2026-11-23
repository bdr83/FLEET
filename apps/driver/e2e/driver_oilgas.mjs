// Driver app, oilfield journey (oilgas pack): the journey card with the site, the H2S zone and the call-in interval; a
// pre-trip inspection with a fault refused and kept, then a clean one; departure, a call-in, the arrival and the end; the
// office sees the journey done with its call-in and the passed inspection.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_oilgas.mjs
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
const inMin = (m) => new Date(Date.now() + m * 60_000).toISOString();

// Office side, through the API: an H2S site, a driver and a van with the site's documents, an approved journey leaving now
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'خدمات الحقول', packs: ['oilgas'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const van = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'van', plate_no: `14-${stamp.slice(-5)}`, capacity: { seats: 14 } }, T);
const drvPhone = `9${stamp}`;
const drv = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'عبدالله', phone: `+965${drvPhone}` }, T);
const until = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
for (const t of ['h2s', 'site_pass']) await call('POST', '/v1/documents', { worker_id: drv.id, doc_type: t, expires_on: until }, T);
await call('POST', '/v1/documents', { asset_id: van.id, doc_type: 'site_sticker', expires_on: until }, T);
const site = await call('POST', '/v1/oilgas/sites', { legal_entity_id: le, code: 'BRG-GC1', name: 'مركز تجميع 1', field: 'برقان', worker_docs: ['h2s', 'site_pass'], asset_docs: ['site_sticker'],
  h2s_zone: true, checkin_min: 30 }, T);
const jm = await call('POST', '/v1/oilgas/journeys', { site_id: site.id, purpose: 'crew', from_place: 'قاعدة الأحمدي', depart_at: inMin(-5), eta_at: inMin(90), passengers: 8 }, T);
await call('POST', `/v1/oilgas/journeys/${jm.id}/assign`, { asset_id: van.id, driver_worker_id: drv.id }, T);
await call('POST', `/v1/oilgas/journeys/${jm.id}/approve`, {}, T);
ok(`المكتب: خطة ${jm.ref} معتمدة لطاقم من 8 إلى مركز تجميع 1 (منطقة H2S)، مسندة لعبدالله`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.3, longitude: 48.0 } });
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
  await see(jm.ref).click();
  await see('مركز تجميع 1').waitFor();
  await see('بلاغ كل 30 دقيقة').waitFor();
  await see('منطقة H2S').waitFor();
  await shot(p, 'og01-journey');
  ok('بطاقة الرحلة: الموقع والحقل ونقطة الانطلاق والركاب ومنطقة H2S وفترة البلاغ');

  await btn('قبول الرحلة').click();
  await btn('بدء الرحلة').click();
  const items = ['الإطارات', 'الفرامل', 'الأضواء', 'أحزمة الأمان', 'طفاية الحريق', 'حقيبة الإسعاف', 'عدة احتواء الانسكاب', 'جهاز كشف H2S'];
  await btn('فحص المركبة قبل الانطلاق').click();
  for (const i of items.filter((x) => x !== 'الفرامل')) await p.getByRole('checkbox', { name: i }).click();
  await btn('إرسال الفحص (فيه خلل)').click();
  await see('المركبة لم تجتز الفحص').waitFor();
  ok('فحص فيه خلل في الفرامل: يُرفض الانطلاق ويُحفظ الفحص للمكتب');

  await btn('فحص المركبة قبل الانطلاق').click();
  for (const i of items) await p.getByRole('checkbox', { name: i }).click();
  await shot(p, 'og02-inspect');
  await btn('تأكيد الفحص').click();
  await btn('انطلقت').click();
  await btn('بلاغ: الوضع سليم').click();
  await see('وصل البلاغ').waitFor();
  await btn('وصلت الموقع').click();
  await btn('إنهاء الرحلة').click();
  ok('فحص سليم، ثم الانطلاق وبلاغ والوصول وإنهاء الرحلة');

  let j;
  for (let i = 0; i < 20; i++) {
    j = await call('GET', `/v1/oilgas/journeys/${jm.id}`, undefined, T);
    if (j.state === 'done') break;
    await p.waitForTimeout(500);
  }
  if (j.state !== 'done' || j.checkins !== 1 || !j.inspection?.passed || !j.arrived_at) throw new Error(`journey ${JSON.stringify({ s: j.state, c: j.checkins, i: j.inspection, a: j.arrived_at })}`);
  const ex = await call('GET', '/v1/oilgas/exceptions', undefined, T);
  if (!ex.failed_inspections.some((x) => x.ref === jm.ref && x.failed_items.includes('brakes'))) throw new Error('the failed inspection should be kept for the office');
  ok('عند المكتب: الرحلة منتهية ببلاغ واحد وفحص سليم، والفحص الراسب (الفرامل) ظاهر في إدارة الرحلات');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'og-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
