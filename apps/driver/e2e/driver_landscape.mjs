// Driver app, garden maintenance visit (landscape pack): the visit card with the garden, services, crew and instructions;
// accept, set off, arrive; the work refused when a planned service is left undone without a reason, then recorded with
// the reason, an irrigation leak and the green waste bags; done; the office sees the work and the open irrigation fault.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_landscape.mjs
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
const kwDay = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const time = new Date(Date.now() + 3 * 3_600_000 - 10 * 60_000).toISOString().slice(11, 16);

// Office side, through the API: a garden company, a crew lead, a villa garden visited every day, today's visit generated
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'حدائق الخليج', packs: ['landscape'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const leadPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'رئيس الطاقم راجو', phone: `+965${leadPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'فيلا العتيبي' }, T);
const site = await call('POST', '/v1/landscape/sites', { legal_entity_id: le, code: 'V1', name: 'فيلا العتيبي: الحديقة الأمامية', customer_id: cu.id, area: 'الشويخ', area_m2: 400,
  services: ['mowing', 'pruning', 'irrigation'], days: [1, 2, 3, 4, 5, 6, 7], visit_time: time, duration_min: 180, lead_worker_id: w.id, crew_size: 3, instructions: 'لا تقصوا النخلة' }, T);
const g = await call('POST', '/v1/landscape/visits/generate', { date: kwDay }, T);
if (g.created.length !== 1) throw new Error(JSON.stringify(g));
ok(`المكتب: حديقة ${site.code} وزيارة اليوم ${g.created[0]} لرئيس الطاقم`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.33, longitude: 48.06 } });
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
  await typeInto(p.getByLabel('رقم الجوال'), leadPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(g.created[0]).click();
  await see('فيلا العتيبي: الحديقة الأمامية').waitFor();
  await see('الخدمات: قص العشب، تقليم، صيانة الري').waitFor();
  await see('لا تقصوا النخلة').waitFor();
  await shot(p, 'ls01-visit');
  ok('بطاقة الزيارة: الحديقة والخدمات المخططة والطاقم والتعليمات');

  await btn('قبول الزيارة').click();
  await btn('انطلقت للحديقة').click();
  await btn('وصلت الحديقة').click();
  await btn('تسجيل العمل المنجز').click();
  await p.getByRole('checkbox', { name: 'تقليم' }).or(btn('تقليم')).first().click();
  await p.getByLabel('سبب عدم تنفيذ: تقليم').waitFor();
  await see('تسريب').click();
  await typeInto(p.getByLabel('أكياس المخلفات الخضراء'), '4');
  const save = p.getByRole('button', { name: 'تأكيد العمل', exact: true });
  if (await save.isEnabled()) throw new Error('save enabled without a reason for the undone service');
  ok('وصل الطاقم؛ التقليم غير منفذ فلا يُقبل العمل بلا سبب');

  await typeInto(p.getByLabel('سبب عدم تنفيذ: تقليم'), 'المقص معطل، التقليم الزيارة القادمة');
  await save.click();
  await see('أُبلغ المكتب بعطل الري').waitFor();
  await shot(p, 'ls02-done');
  await btn('إنهاء الزيارة').click();
  ok('العمل المنجز: قص وصيانة ري، تسريب في الشبكة، 4 أكياس، ثم الإنهاء');

  let v;
  for (let i = 0; i < 20; i++) {
    v = (await call('GET', `/v1/landscape/visits?date=${kwDay}`, undefined, T)).data[0];
    if (v.state === 'done') break;
    await p.waitForTimeout(500);
  }
  if (v.state !== 'done' || v.irrigation !== 'leak' || v.waste_bags !== 4 || v.services_done.join() !== 'mowing,irrigation') throw new Error(`visit ${JSON.stringify(v)}`);
  const ex = await call('GET', `/v1/landscape/exceptions?date=${kwDay}`, undefined, T);
  if (ex.open_faults.length !== 1 || ex.services_undone[0]?.missing?.join() !== 'pruning') throw new Error(`exceptions ${JSON.stringify(ex)}`);
  ok('عند المكتب: الزيارة منجزة، وعطل الري مفتوح، والتقليم ضمن الخدمات غير المنفذة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'ls-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
