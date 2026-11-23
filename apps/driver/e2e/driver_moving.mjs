// Driver app, furniture moving (moving pack): the truck driver's move: the card with the items, loading, then unloading with
// the receiver's name and a damage note.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_moving.mjs
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

// Office side, through the API: a driver, a truck, a surveyed and accepted move, booked
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'نقل الأثاث', packs: ['moving'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const techPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق النقل', phone: `+965${techPhone}` }, T);
const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `MV-${stamp.slice(-5)}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'بو فهد' }, T);
const job = await call('POST', '/v1/moving/jobs', { legal_entity_id: le, customer_id: cu.id, home_size: 'apt_2', services: ['packing'], move_at: new Date(Date.now() + 3_600_000).toISOString(),
  from_site: { area: 'السالمية', block: '10', floor: '3', phone: '+96550003333' }, to_site: { area: 'الجابرية', block: '4' } }, T);
await call('POST', `/v1/moving/jobs/${job.id}/survey`, { volume_m3: 30, items: [{ name: 'كنبة', qty: 2 }, { name: 'تلفزيون', fragile: true }] }, T);
await call('POST', `/v1/moving/jobs/${job.id}/quote`, { quote_amount: '120.000' }, T);
await call('POST', `/v1/moving/jobs/${job.id}/accept`, {}, T);
await call('POST', `/v1/moving/jobs/${job.id}/book`, { driver_worker_id: w.id, asset_id: truck.id }, T);
ok(`المكتب: طلب نقل ${job.ref} بمعاينة وسعر، والشاحنة والسائق محجوزان`);

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
  await see('شقة غرفتين').waitFor();
  await see('3 قطعة').waitFor();
  await see('قابل للكسر: تلفزيون').waitFor();
  await see('السالمية، ق 10، الدور 3').waitFor();
  await shot(p, 'mv01-move');
  ok('بطاقة النقل: الحجم وعدد القطع والقابل للكسر وعنوان التحميل');

  await btn('قبول النقل').click();
  await btn('انطلقت للعميل').click();
  await btn('انتهى التحميل').click();
  await btn('انتهى التفريغ والتسليم').click();
  await typeInto(p.getByLabel('اسم المستلم'), 'بو فهد');
  await typeInto(p.getByLabel('ضرر أو نقص لاحظته (إن وُجد)'), 'خدش بسيط في الطاولة');
  await shot(p, 'mv02-done');
  await btn('تأكيد التسليم').click();
  let j;
  for (let i = 0; i < 20; i++) {
    j = await call('GET', `/v1/moving/jobs/${job.id}`, undefined, T);
    if (j.state === 'delivered' && j.crew[0].status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (j.state !== 'delivered' || !j.loaded_at || j.received_by !== 'بو فهد' || j.delivery_note !== 'خدش بسيط في الطاولة' || j.crew[0].status !== 'completed') throw new Error(`job ${JSON.stringify(j)}`);
  ok('انتهى التحميل ثم التفريغ مع اسم المستلم وملاحظة الضرر، والطلب جاهز للإغلاق عند المكتب');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'mv-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
