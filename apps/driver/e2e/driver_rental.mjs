// Driver app, car rental (rental pack): the driver delivers the rental car to the renter with the odometer, fuel and the renter's name.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_rental.mjs
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

// Office side, through the API: a car, a driver, and a reservation with a delivery to the renter's address
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'تأجير السيارات', packs: ['rental'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const car = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'car', plate_no: `RC-${stamp.slice(-5)}`, make: 'Toyota', model: 'Camry', odometer_km: 20000 }, T);
const drvPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التوصيل', phone: `+965${drvPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'individual', name: 'فهد العتيبي' }, T);
const at = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const expiry = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
const ra = await call('POST', '/v1/rental/agreements', { legal_entity_id: le, customer_id: cu.id, asset_id: car.id, pickup_at: at(0.2), return_due: at(48), rate: '12.500',
  drivers: [{ name: 'فهد العتيبي', phone: '+96551112222', licence_no: 'KW-12345', licence_expiry: expiry }] }, T);
await call('POST', `/v1/rental/agreements/${ra.id}/moves`, { kind: 'deliver', driver_worker_id: w.id, address: { area: 'السالمية', block: '10', street: '5' } }, T);
ok(`المكتب: حجز ${ra.ref} مع توصيل السيارة للعميل في السالمية`);

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
  await typeInto(p.getByLabel('رقم الجوال'), drvPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(ra.ref).click();
  await see('توصيل السيارة للعميل').waitFor();
  await see('المستأجر: فهد العتيبي').waitFor();
  await see('السالمية، ق 10، 5').waitFor();
  await shot(p, 'rn01-task');
  ok('بطاقة التوصيل: السيارة والمستأجر وهاتفه والعنوان');

  await btn('قبول المهمة').click();
  await btn('انطلقت للعميل').click();
  await btn('سلّمت السيارة للعميل').click();
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '19000');
  await typeInto(p.getByLabel('اسم المستلم'), 'فهد');
  await btn('تأكيد التسليم').click();
  await see('العدّاد أقل من آخر قراءة').waitFor();
  ok('العدّاد أقل من آخر قراءة للسيارة: مرفوض برسالة واضحة');

  await btn('سلّمت السيارة للعميل').click();
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '20015');
  await see('ممتلئ').click();
  await typeInto(p.getByLabel('اسم المستلم'), 'فهد العتيبي');
  await shot(p, 'rn02-handover');
  await btn('تأكيد التسليم').click();
  let a;
  for (let i = 0; i < 20; i++) {
    a = await call('GET', `/v1/rental/agreements/${ra.id}`, undefined, T);
    if (a.state === 'out' && a.moves[0]?.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (a.state !== 'out' || a.out_odometer_km !== 20015 || a.out_fuel !== 8 || a.out_by !== 'driver' || a.moves[0].status !== 'completed') throw new Error(`agreement ${JSON.stringify(a)}`);
  ok('التسليم: العدّاد 20015 والخزان ممتلئ، والعقد صار «مع العميل» عند المكتب، والمهمة مكتملة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'rn-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
