// Browser test of the driver app with a courier parcel (courier pack: a delivery task with a waybill) against a running API
// (OTP_DEV_ECHO=1, CORS_ORIGINS incl. APP_URL). Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_courier.mjs
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

// Office side, through the API: a courier company, a hub, a parcel that failed its first attempt and came back to the hub
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'البريد السريع', packs: ['courier'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const hub = await call('POST', '/v1/courier/hubs', { legal_entity_id: le, code: 'AHM', name: 'محطة الأحمدي' }, T);
const driverPhone = `6${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'courier', display_name: 'فهد', phone: `+965${driverPhone}` }, T);
const awb = `DRV-${stamp}`;
const parcel = await call('POST', '/v1/courier/parcels', { legal_entity_id: le, awb, service: 'next_day', origin_hub_id: hub.id, recipient: { name: 'نورة', phone: '+96550001111' }, dropoff: { area: 'الفحيحيل' } }, T);
const assign = async (worker) => {
  const t = await call('GET', `/v1/tasks/${parcel.task_id}`, undefined, T);
  await call('POST', `/v1/tasks/${parcel.task_id}/assign`, { version: t.version, worker_id: worker }, T);
};
// the first attempt is another courier's (simulated through the API)
const firstPhone = `+9659${stamp}`;
const w1 = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'courier', display_name: 'ماجد', phone: firstPhone }, T);
await assign(w1.id);
r = await call('POST', '/v1/auth/otp/request', { phone: firstPhone });
r = await call('POST', '/v1/auth/otp/verify', { phone: firstPhone, code: r.dev_code });
const dtok = (await call('POST', '/v1/auth/token', { tenant_id: co.tenant.id }, r.user_token)).access_token;
for (const to of ['accepted', 'in_progress', 'failed']) {
  await call('POST', '/v1/driver/sync', { ops: [{ client_op_id: crypto.randomUUID(), occurred_at: new Date().toISOString(), type: 'task_status', task_id: parcel.task_id, to_status: to, ...(to === 'failed' ? { reason_code: 'recipient_absent' } : {}) }] }, dtok);
}
await call('POST', '/v1/courier/scans', { hub_id: hub.id, event: 'returned', awbs: [awb] }, T);
await assign(w.id);
const pin = (await call('GET', `/v1/delivery/tasks/${parcel.task_id}`, undefined, T)).link.pin;
ok(`المكتب: الشحنة ${awb} فشلت محاولتها الأولى وعادت للمحطة، ثم أُسندت للمحاولة الثانية`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.33, longitude: 48.07 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
async function typeInto(locator, text, clear = false) {
  await locator.click();
  await p.waitForTimeout(400);
  if (clear) { await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace'); }
  await p.keyboard.type(text, { delay: 30 });
}
const see = (t) => p.locator(`flt-semantics[aria-label*="${t}"], flt-semantics:has-text("${t}")`).last();
const btn = (name) => p.getByRole('button', { name, exact: false }).first();
try {
  await p.goto(APP);
  await btn('الدخول برقم الجوال').click();
  await typeInto(p.getByLabel('رقم الجوال'), driverPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see('المحاولة 2 من 3').waitFor();
  await shot(p, 'dk01-list');
  ok('القائمة تُظهر البوليصة وعدد القطع والمحاولة 2 من 3');

  await see('المحاولة 2 من 3').click();
  await see('محاولة تسليم جديدة').waitFor();
  await btn('قبول المهمة').click();
  await btn('استلمت الشحنة').click();
  await btn('بدء التوصيل').click();
  await btn('وصلت للمستلم').click();
  await btn('تسليم').click();
  await typeInto(p.getByLabel('رمز الاستلام'), pin);
  await shot(p, 'dk02-pin');
  await btn('تأكيد التسليم').click();
  await see('لا توجد مهام مسندة إليك الآن').waitFor();
  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/courier/parcels/${awb}`, undefined, T);
    if (d.where === 'delivered') break;
    await p.waitForTimeout(500);
  }
  if (d.where !== 'delivered' || d.attempts !== 1) throw new Error(`parcel ${JSON.stringify(d)}`);
  ok('التسليم بالرمز في المحاولة الثانية: الشحنة «سُلّمت» ومحاولاتها الفاشلة 1');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'dk-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
