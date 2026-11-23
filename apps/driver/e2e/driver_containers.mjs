// Driver app, containers (containers pack): the port leg of an import box: the card, the number typed at pickup (a wrong
// one is refused), the seal, then the receiver at the customer.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_containers.mjs
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

// Office side, through the API: a driver, a truck, an import container with the port leg booked
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'الحاويات', packs: ['containers'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const techPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التريلا', phone: `+965${techPhone}` }, T);
const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CT-${stamp.slice(-5)}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'business', name: 'شركة الاستيراد' }, T);
const job = await call('POST', '/v1/containers/jobs', { legal_entity_id: le, customer_id: cu.id, direction: 'import', container_no: 'MSCU1234566', iso_size: '40', ctype: 'high_cube',
  line: 'MSC', doc_no: 'BL-778', port: 'shuwaikh', site: { name: 'مستودع الري', area: 'الري', phone: '+96550004444' } }, T);
await call('POST', `/v1/containers/jobs/${job.id}/legs`, { driver_worker_id: w.id, asset_id: truck.id }, T);
ok(`المكتب: حاوية استيراد ${job.ref} ورحلة الميناء محجوزة`);

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
  await see('MSCU1234566').waitFor();
  await see('من الميناء إلى العميل').waitFor();
  await see('40 قدم · عالي · MSC').waitFor();
  await see('ميناء الشويخ').waitFor();
  await shot(p, 'ct01-leg');
  ok('بطاقة الرحلة: رقم الحاوية والمقاس والخط ومكان السحب');

  await btn('قبول الرحلة').click();
  await btn('انطلقت لسحب الحاوية').click();
  await btn('سحبت الحاوية').click();
  await typeInto(p.getByLabel('رقم الحاوية كما هو عليها'), 'MSCU1234567');
  await see('رقم غير صحيح').waitFor();
  await p.getByLabel('رقم الحاوية كما هو عليها').fill('');
  await typeInto(p.getByLabel('رقم الحاوية كما هو عليها'), 'MAEU7654320');
  await typeInto(p.getByLabel('رقم الختم (إن وُجد)'), 'SL-99');
  await btn('تأكيد السحب').click();
  await see('الحاوية').waitFor();
  await p.waitForTimeout(1500);
  let j = await call('GET', `/v1/containers/jobs/${job.id}`, undefined, T);
  if (j.picked_at) throw new Error('a different container was accepted');
  await btn('سحبت الحاوية').click();
  await typeInto(p.getByLabel('رقم الحاوية كما هو عليها'), 'mscu1234566');
  await typeInto(p.getByLabel('رقم الختم (إن وُجد)'), 'SL-99');
  await btn('تأكيد السحب').click();
  await btn('سلّمت الحاوية').waitFor();
  ok('رقم بخانة تحقق خاطئة نبّه عليه التطبيق، ورقم حاوية أخرى رفضه الخادم، ثم سُحبت الحاوية الصحيحة بالختم');

  await btn('سلّمت الحاوية').click();
  await typeInto(p.getByLabel('اسم المستلم'), 'أمين المستودع');
  await shot(p, 'ct02-drop');
  await btn('تأكيد التسليم').click();
  for (let i = 0; i < 20; i++) {
    j = await call('GET', `/v1/containers/jobs/${job.id}`, undefined, T);
    if (j.state === 'at_customer' && j.legs[0].status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (j.state !== 'at_customer' || j.seal_no !== 'SL-99' || j.legs[0].received_by !== 'أمين المستودع') throw new Error(`job ${JSON.stringify(j)}`);
  ok('سُلّمت الحاوية للعميل باسم المستلم، وهي الآن عند العميل');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'ct-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
