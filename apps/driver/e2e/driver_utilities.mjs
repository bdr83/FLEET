// Driver app, utilities work order (utilities pack): the order card with the priority, the network asset and the dig
// permit missing; the crew accepts, sets off, arrives; isolation refused without a permit, the office records it, the
// safety checklist (the confirm stays off until every item is ticked); the repair with its result; the order cannot
// close before the road is reinstated; the office sees the order done with the times.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_utilities.mjs
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

// Office side, through the API: a networks contractor, a crew pickup and lead, an excavation order without a permit, the crew booked
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'مقاولات الشبكات', packs: ['utilities'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const van = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'pickup', plate_no: `UT-${stamp.slice(-5)}` }, T);
const leadPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'رئيس الفرقة', phone: `+965${leadPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'وزارة الكهرباء والماء' }, T);
const job = await call('POST', '/v1/utilities/jobs', { legal_entity_id: le, customer_id: cu.id, network: 'water', job_type: 'excavation', priority: 'urgent',
  reported_at: new Date(Date.now() - 30 * 60_000).toISOString(), area: 'الجابرية', address: 'ق 1 ش 5', asset_ref: 'WM-JAB-07', description: 'كسر خط مياه 200 مم', affected: 60 }, T);
await call('POST', `/v1/utilities/jobs/${job.id}/assign`, { worker_id: w.id, asset_id: van.id }, T);
ok(`المكتب: أمر حفر ${job.ref} بلا تصريح، والفرقة مسندة`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.33, longitude: 48.03 } });
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
const checks = ['العزل والقفل', 'معدات الحماية الشخصية', 'الحواجز واللوحات التحذيرية', 'تصريح الحفر في الموقع'];
async function isolate() {
  await btn('العزل وقائمة السلامة').click();
  for (const c of checks) await p.getByRole('checkbox', { name: c }).click();
  await p.getByRole('button', { name: 'تأكيد العزل', exact: true }).click();
}
try {
  await p.goto(APP);
  await btn('الدخول برقم الجوال').click();
  await typeInto(p.getByLabel('رقم الجوال'), leadPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(job.ref).click();
  await see('كسر خط مياه 200 مم').waitFor();
  await see('الأولوية: عاجل').waitFor();
  await see('الأصل: WM-JAB-07').waitFor();
  await see('أعمال حفر: لا تصريح بعد').waitFor();
  await shot(p, 'ut01-order');
  ok('بطاقة الأمر: الوصف والأولوية والأصل وتنبيه أن الحفر بلا تصريح');

  await btn('قبول أمر العمل').click();
  await btn('انطلقت للموقع').click();
  await btn('وصلت الموقع').click();
  await isolate();
  await see('لا عزل ولا حفر بلا تصريح حفر').waitFor();
  ok('الفرقة وصلت؛ العزل مرفوض بلا تصريح حفر');

  const day = new Date(Date.now() + 3 * 3_600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
  await call('PUT', `/v1/utilities/jobs/${job.id}/permit`, { permit_no: 'DIG-2026-551', permit_expires: day }, T);
  await isolate();
  await btn('تم الإصلاح').click();
  ok('المكتب سجّل التصريح؛ قائمة السلامة الأربعة ثم العزل');

  await p.getByRole('button', { name: 'تم الإصلاح نهائيًا' }).click();
  await typeInto(p.getByLabel('ملاحظة (ما تم)'), 'تبديل جزء 2 متر');
  await p.getByRole('button', { name: 'تأكيد', exact: true }).click();
  await btn('أُعيد الطريق').waitFor();
  if (await p.getByRole('button', { name: 'إغلاق أمر العمل' }).count()) throw new Error('close offered before reinstatement');
  await btn('أُعيد الطريق').click();
  await shot(p, 'ut02-reinstated');
  await btn('إغلاق أمر العمل').click();
  ok('الإصلاح بنتيجته؛ لا يُغلق الأمر قبل إعادة الطريق، ثم الإغلاق');

  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/utilities/jobs/${job.id}`, undefined, T);
    if (d.state === 'done') break;
    await p.waitForTimeout(500);
  }
  if (d.state !== 'done' || d.result !== 'fixed' || d.result_note !== 'تبديل جزء 2 متر' || !d.reinstated_at || d.response_min === null || d.checks?.permit_on_site !== true)
    throw new Error(`job ${JSON.stringify(d)}`);
  ok(`عند المكتب: الأمر مغلق، أُصلح نهائيًا، الطريق معاد، الاستجابة ${d.response_min} دقيقة`);

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'ut-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
