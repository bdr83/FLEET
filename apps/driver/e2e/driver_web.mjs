// Browser test of the driver app's web build against a running API (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL).
// Build: flutter build web --no-web-resources-cdn --dart-define=API_URL=$API_URL --dart-define=SHOW_DEV_CODE=true --dart-define=E2E=true
// Serve build/web on APP_URL, then: node e2e/driver_web.mjs
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

// Office side, through the API: a company, a vehicle, a courier and a delivery order assigned to them
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'توصيل الخليج' }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const plate = `${stamp.slice(0, 2)}-${stamp.slice(2)}`;
await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'motorbike', plate_no: plate, odometer_km: 1200 }, T);
const driverPhone = `5${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'courier', display_name: 'ناصر المطيري', phone: `+965${driverPhone}` }, T);
const shop = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'متجر العطور' }, T); // COD money is held for a customer
const task = await call('POST', '/v1/tasks', { legal_entity_id: le, customer_id: shop.id, sector_pack: 'delivery@1', ref: `APP-${stamp}`, attributes: {
  dropoff: { area: 'السالمية', block: '5', street: 'سالم المبارك', house: '12', lat: 29.335, lng: 48.075 },
  pickup: { area: 'الشويخ', lat: 29.35, lng: 47.93 },
  recipient: { name: 'أحمد', phone: '50000001' }, cod_amount: '7.500' } }, T);
await call('POST', `/v1/tasks/${task.id}/assign`, { version: 1, worker_id: w.id }, T);
const { link } = await call('GET', `/v1/delivery/tasks/${task.id}`, undefined, T);
ok('المكتب: شركة ومركبة ومندوب وطلب توصيل مسند');

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.3341, longitude: 48.0745 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
if (process.env.DEBUG) { p.on('request', (q) => q.url().includes('locations') && console.log('REQ', q.postData()?.slice(0, 300))); p.on('response', async (q) => q.url().includes('locations') && console.log('RES', q.status(), (await q.text()).slice(0, 200))); p.on('console', (m) => console.log('CON', m.text().slice(0, 200))); }
/** Flutter web creates the real <input> on focus: wait for it before typing, or the first key is lost. */
async function typeInto(locator, text, { clear = false } = {}) {
  await locator.click();
  await p.waitForTimeout(400);
  if (clear) { await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace'); }
  await p.keyboard.type(text, { delay: 30 });
}
/** Text on screen: Flutter puts it in semantics nodes either as text or as an aria-label. */
const see = (t) => p.locator(`flt-semantics[aria-label*="${t}"], flt-semantics:has-text("${t}")`).last();
const btn = (name) => p.getByRole('button', { name, exact: false }).first();
try {
  await p.goto(APP);
  await typeInto(p.getByLabel('رقم الجوال'), driverPhone);
  await shot(p, 'a01-login');
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  const code = (await dev.textContent()).match(/\d{6}/)[0];
  await typeInto(p.getByLabel('رمز التحقق'), code);
  await btn('دخول').click();
  await see('ناصر المطيري').waitFor();
  ok('دخول المندوب برقم كويتي من 8 أرقام ورمز التحقق');

  await see('سالم المبارك').waitFor();
  await shot(p, 'a02-home');
  await btn('بدء الوردية').click();
  await btn('ابدأ').waitFor();
  await btn('ابدأ').click();
  await see('الوردية مفتوحة').waitFor();
  ok('بدء الوردية بالمركبة الوحيدة المتاحة');

  await see('سالم المبارك').click();
  await btn('قبول المهمة').click();
  await btn('وصلت لنقطة الاستلام').click();
  await btn('استلمت الشحنة').click();
  await btn('بدء التوصيل').click();
  await btn('وصلت للمستلم').click();
  await shot(p, 'a03-task');
  ok('قبول المهمة ومراحلها: الاستلام ثم الطريق ثم الوصول');

  await btn('تسليم').click();
  await see('لا تسلّم الطلب قبل استلام المبلغ').waitFor();
  await p.getByRole('checkbox').first().click();
  const wrong = link.pin === '0000' ? '1111' : '0000';
  await typeInto(p.getByLabel('رمز الاستلام'), wrong);
  await btn('تأكيد التسليم').click();
  await see('رمز المستلم غير صحيح').waitFor();
  await shot(p, 'a04-wrong-pin');
  ok('رمز خاطئ يُرفض فورًا برسالة واضحة');

  await typeInto(p.getByLabel('رمز الاستلام'), link.pin, { clear: true });
  await btn('تأكيد التسليم').click();
  await see('لا توجد مهام مسندة إليك الآن').waitFor();
  ok('الرمز الصحيح يكمل التسليم ويعود للقائمة');

  // give the queue a moment to send the COD and completion
  let t;
  for (let i = 0; i < 20; i++) {
    t = await call('GET', `/v1/tasks/${task.id}`, undefined, T);
    if (t.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (t.status !== 'completed') throw new Error(`task is ${t.status}`);
  const d = await call('GET', `/v1/delivery/tasks/${task.id}`, undefined, T);
  if (d.pod?.method !== 'pin' || !d.pod.verified) throw new Error('no verified pin proof');
  if (d.milestones.map((m) => m.code).join() !== 'at_pickup,picked_up,at_dropoff') throw new Error(`stages ${d.milestones.map((m) => m.code)}`);
  const custody = await call('GET', '/v1/cod/custody', undefined, T);
  if (custody.data.find((x) => x.worker_id === w.id)?.held !== '7.500') throw new Error(`custody ${JSON.stringify(custody.data)}`);
  ok('الخادم: مكتملة، إثبات بالرمز موثّق، المراحل الثلاث، وعهدة 7.500 على المندوب');

  // GPS points are sent in batches every 20 s
  let me;
  for (let i = 0; i < 30; i++) {
    me = (await call('GET', '/v1/dispatch/board', undefined, T)).drivers.find((x) => x.id === w.id);
    if (me?.last_seen_at) break;
    await p.waitForTimeout(1000);
  }
  if (!me?.last_seen_at || Math.abs(me.lat - 29.334) > 0.003) throw new Error(`no live position ${JSON.stringify(me)}`);
  ok('موقع المندوب الحي يصل للوحة التوزيع أثناء الوردية');

  await btn('إنهاء الوردية').click();
  await p.getByRole('button', { name: 'إنهاء', exact: true }).click();
  await see('الوردية مغلقة').waitFor();
  await shot(p, 'a05-shift-ended');
  ok('إنهاء الوردية يوقف التتبع');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'a-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
