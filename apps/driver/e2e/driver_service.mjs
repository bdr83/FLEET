// Driver app, technical maintenance (service pack): the technician's visit: arrival, result, work done, parts and the customer's name.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_service.mjs
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

// Office side, through the API: a technician and an urgent AC job with a visit booked for them
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'الصيانة الفنية', packs: ['service'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const techPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فني التكييف', phone: `+965${techPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'أم عبدالله' }, T);
const job = await call('POST', '/v1/service/jobs', { legal_entity_id: le, customer_id: cu.id, site: { name: 'فيلا 12', area: 'مشرف', block: '3', phone: '+96550002222' },
  category: 'ac', priority: 'urgent', problem: 'المكيف لا يبرد', unit: { brand: 'Gree', location: 'الصالة' } }, T);
await call('POST', `/v1/service/jobs/${job.id}/visits`, { technician_worker_id: w.id }, T);
ok(`المكتب: بلاغ عاجل ${job.ref} وزيارة محجوزة للفني`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.33, longitude: 48.0 } });
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
  await typeInto(p.getByLabel('رقم الجوال'), techPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(job.ref).click();
  await see('المكيف لا يبرد').waitFor();
  await see('عاجل').waitFor();
  await see('Gree · الصالة').waitFor();
  await shot(p, 'sv01-visit');
  ok('بطاقة الزيارة: التخصص والمشكلة والجهاز والعميل والأولوية');

  await btn('قبول الزيارة').click();
  await btn('انطلقت للعميل').click();
  await btn('وصلت للموقع').click();
  await btn('انتهت الزيارة').click();
  await see('تم الإصلاح').click();
  await typeInto(p.getByLabel('ما تم من عمل'), 'تنظيف وتعبئة فريون');
  await typeInto(p.getByLabel('القطعة'), 'فريون R410');
  await btn('إضافة قطعة').click();
  await see('فريون R410').waitFor();
  await typeInto(p.getByLabel('اسم العميل المستلم'), 'أم عبدالله');
  await shot(p, 'sv02-done');
  await btn('تأكيد انتهاء الزيارة').click();
  let j;
  for (let i = 0; i < 20; i++) {
    j = await call('GET', `/v1/service/jobs/${job.id}`, undefined, T);
    if (j.state === 'to_close') break;
    await p.waitForTimeout(500);
  }
  const v = j.visits[0];
  if (j.state !== 'to_close' || !j.first_arrival || v.result !== 'fixed' || v.signed_by !== 'أم عبدالله' || v.parts[0]?.name !== 'فريون R410' || v.status !== 'completed') throw new Error(`job ${JSON.stringify(j)}`);
  ok('الوصول ثم نتيجة الزيارة: تم الإصلاح مع العمل والقطعة واسم العميل، والبلاغ جاهز للإغلاق عند المكتب');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'sv-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
