// Driver app, tour bus (tour pack): the trip card with the group, the seats and the itinerary; set off, the group on board
// with the head count and the odometer (over the seats refused), then the return with fewer heads and a note; the office
// sees the bus back with its counts and km.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_tour.mjs
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

// Office side, through the API: a 50-seat bus, a driver, a day trip for a school starting now, the bus added
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'رحلات النوخذة', packs: ['tour'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const bus = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `50-${stamp.slice(-5)}`, capacity: { seats: 50 } }, T);
const drvPhone = `9${stamp}`;
const drv = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فهد', phone: `+965${drvPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مدرسة الرواد', kind: 'business' }, T);
const trip = await call('POST', '/v1/tours/trips', { legal_entity_id: le, customer_id: cu.id, group_name: 'رحلة الصف الخامس', pax: 45, start_at: inMin(-5), end_at: inMin(480),
  pickup: 'مدرسة الرواد، الجابرية', destination: 'المدينة الترفيهية', itinerary: [{ place: 'المدينة الترفيهية' }, { place: 'الغداء', note: 'مطعم الشاطئ' }] }, T);
await call('POST', `/v1/tours/trips/${trip.id}/buses`, { asset_id: bus.id, driver_worker_id: drv.id }, T);
ok(`المكتب: رحلة ${trip.ref} لمدرسة الرواد (45 طالبًا) بحافلة 50 مقعدًا وسائقها فهد`);

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
  await see(trip.ref).click();
  await see('رحلة الصف الخامس').waitFor();
  await see('مقاعد الحافلة: 50').waitFor();
  await see('مطعم الشاطئ').waitFor();
  await shot(p, 'tr01-trip');
  ok('بطاقة الرحلة: المجموعة والركاب والمقاعد ونقطة التجمع والوجهة والبرنامج');

  await btn('قبول الرحلة').click();
  await btn('انطلقت لنقطة التجمع').click();
  await btn('صعد الركاب، انطلقنا').click();
  await typeInto(p.getByLabel('عدد الركاب في الحافلة'), '55');
  await see('العدد أكثر من المقاعد').waitFor();
  await p.getByLabel('عدد الركاب في الحافلة').click();
  for (let i = 0; i < 2; i++) await p.keyboard.press('Backspace');
  await p.keyboard.type('45', { delay: 30 });
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '12000');
  await shot(p, 'tr02-board');
  await btn('تأكيد الصعود والانطلاق').click();
  await btn('عدنا، تسجيل العودة').waitFor();
  ok('الصعود: 55 أكثر من المقاعد فيُرفض في النموذج، ثم 45 راكبًا والعداد 12000');

  await btn('عدنا، تسجيل العودة').click();
  await typeInto(p.getByLabel('عدد الركاب في الحافلة'), '44');
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '12150');
  await btn('تأكيد العودة').click();
  await see('اكتب السبب').waitFor(); // fewer back without a note: refused by the server
  await btn('عدنا، تسجيل العودة').click();
  await typeInto(p.getByLabel('عدد الركاب في الحافلة'), '44');
  await typeInto(p.getByLabel('قراءة العدّاد (كم)'), '12150');
  await typeInto(p.getByLabel('ملاحظة (إلزامية إن عاد عدد أقل)'), 'طالب أخذه والده من المدينة الترفيهية');
  await btn('تأكيد العودة').click();
  ok('العودة بـ 44: تُرفض بلا ملاحظة، ثم تُسجَّل مع السبب وتنتهي الرحلة');

  let t;
  for (let i = 0; i < 20; i++) {
    t = await call('GET', `/v1/tours/trips/${trip.id}`, undefined, T);
    if (t.buses[0].status === 'completed') break;
    await p.waitForTimeout(500);
  }
  const b = t.buses[0];
  if (b.status !== 'completed' || b.boarded !== 45 || b.returned !== 44 || t.km !== 150 || t.state !== 'back') throw new Error(`trip ${JSON.stringify({ s: b.status, b: b.boarded, r: b.returned, km: t.km, st: t.state })}`);
  ok('عند المكتب: الحافلة عادت، صعد 45 وعاد 44 مع السبب، و150 كم');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'tr-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
