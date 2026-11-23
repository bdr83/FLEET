// Driver app, guard patrol (security pack): the patrol card with the site's instructions and checkpoints; a wrong tag
// refused, the right tag accepted; the patrol refused while a checkpoint is open; a checkpoint skipped (locked); an
// incident reported; the end; the office sees the patrol complete and the incident open.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_security.mjs
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

// Office side, through the API: a guarding company, a guard, a site with two checkpoints and a patrol ten minutes ago, generated
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'شركة الحراسة', packs: ['security'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const guardPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'guard', display_name: 'الحارس سالم', phone: `+965${guardPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مجمع الأفنيوز' }, T);
const slot = new Date(Date.now() + 3 * 3_600_000 - 10 * 60_000).toISOString().slice(11, 16);
const site = await call('POST', '/v1/security/sites', { legal_entity_id: le, code: 'AVN', name: 'الأفنيوز: المواقف', customer_id: cu.id, area: 'الري', patrol_times: [slot], duration_min: 120,
  guard_worker_id: w.id, instructions: 'تأكد من إغلاق باب المخزن' }, T);
await call('POST', `/v1/security/sites/${site.id}/checkpoints`, { name: 'البوابة الرئيسية', tag: 'CP-GATE' }, T);
await call('POST', `/v1/security/sites/${site.id}/checkpoints`, { name: 'المخزن', tag: 'CP-STORE', note: 'خلف المواقف' }, T);
const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const g = await call('POST', '/v1/security/patrols/generate', { date: today }, T);
if (g.created.length !== 1) throw new Error(JSON.stringify(g));
ok(`المكتب: موقع AVN بنقطتي تفتيش وجولة ${slot} مسندة للحارس`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.30, longitude: 47.93 } });
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
async function scan(name, tag) {
  await btn(`مسح ${name}`).click();
  await typeInto(p.getByLabel('رمز النقطة'), tag);
  await p.getByRole('button', { name: 'تأكيد', exact: true }).click();
}
try {
  await p.goto(APP);
  await btn('الدخول برقم الجوال').click();
  await typeInto(p.getByLabel('رقم الجوال'), guardPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see('PT-AVN').click();
  await see('جولة حراسة').waitFor();
  await see('تأكد من إغلاق باب المخزن').waitFor();
  await see('باقية 2').waitFor();
  await see('خلف المواقف').waitFor();
  await shot(p, 'sc01-patrol');
  ok('بطاقة الجولة: تعليمات الموقع ونقاط التفتيش بالترتيب');

  await btn('قبول الجولة').click();
  await btn('بدأت الجولة').click();
  await scan('البوابة الرئيسية', 'CP-STORE');
  await see('الرمز لا يطابق هذه النقطة').waitFor();
  await scan('البوابة الرئيسية', 'cp-gate');
  await see('مُسحت البوابة الرئيسية').waitFor();
  ok('رمز خاطئ مرفوض، والرمز الصحيح (بأحرف صغيرة) مقبول');

  await btn('أنهيت الجولة').click();
  await see('سجّل كل نقطة تفتيش').waitFor();
  await btn('لم تُفحص المخزن').click();
  await p.getByRole('button', { name: 'مقفلة', exact: true }).click();
  await see('لم تُفحص: مقفلة').waitFor();
  ok('لا تنتهي الجولة والمخزن مفتوح، ثم يُسجَّل «لم تُفحص: مقفلة»');

  await btn('بلاغ حادث').click();
  await see('تسلل').click();
  await see('عالية').click();
  await typeInto(p.getByLabel('وصف الحادث'), 'سياج مقطوع خلف المواقف');
  await p.getByRole('button', { name: 'إرسال البلاغ', exact: true }).click();
  await see('وصل البلاغ للمكتب').waitFor();
  await see('حوادث 1').waitFor();
  await shot(p, 'sc02-incident');
  await btn('أنهيت الجولة').click();
  ok('بلاغ تسلل عالي الخطورة، ثم إنهاء الجولة');

  let d;
  for (let i = 0; i < 20; i++) {
    d = (await call('GET', `/v1/security/patrols?date=${today}`, undefined, T)).data[0];
    if (d?.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (d.status !== 'completed' || d.scanned !== 1 || d.skipped !== 1 || d.incidents !== 1) throw new Error(`patrol ${JSON.stringify(d)}`);
  const inc = (await call('GET', '/v1/security/incidents?open=1', undefined, T)).data[0];
  if (inc?.category !== 'intrusion' || inc.severity !== 'high' || inc.description !== 'سياج مقطوع خلف المواقف') throw new Error(`incident ${JSON.stringify(inc)}`);
  ok('عند المكتب: الجولة مكتملة (نقطة مُسحت وأخرى مقفلة)، وبلاغ IN-1 مفتوح بخطورة عالية');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'sc-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
