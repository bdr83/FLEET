// Driver app, waste round (waste pack): the round card with the landfill and the points with their bins; a point
// collected, the round refused while a point is open, a point missed with a reason, the round refused without a
// weighbridge ticket, the ticket, the end; the office sees the run complete with the tonnage.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_waste.mjs
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

// Office side, through the API: a waste company, a compactor truck and driver, a route with two collection points
// starting an hour ago, and today's round generated
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'خدمات النظافة', packs: ['waste'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const truck = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CP-${stamp.slice(-5)}` }, T);
const drvPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق الكابسة', phone: `+965${drvPhone}` }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'جمعية السالمية' }, T);
const startHm = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(11, 16);
const route = await call('POST', '/v1/waste/routes', { legal_entity_id: le, code: 'SAL-1', name: 'السالمية صباحًا', start_time: startHm, duration_min: 600, facility: 'مردم الجهراء', asset_id: truck.id, driver_worker_id: w.id }, T);
await call('POST', `/v1/waste/routes/${route.id}/points`, { name: 'جمعية السالمية الرئيسي', area: 'السالمية', customer_id: cu.id, bins: [{ type: 'bin_1100', count: 4 }] }, T);
await call('POST', `/v1/waste/routes/${route.id}/points`, { name: 'فرع الجمعية ق 10', area: 'السالمية', customer_id: cu.id, bins: [{ type: 'bin_240', count: 6 }], note: 'المدخل الخلفي' }, T);
const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const g = await call('POST', '/v1/waste/runs/generate', { date: today }, T);
if (g.created[0] !== 'SAL-1') throw new Error(JSON.stringify(g));
ok('المكتب: خط SAL-1 بنقطتي جمع، وجولة اليوم مولّدة ومسندة لسائق الكابسة');

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 29.33, longitude: 47.67 } });
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
  await see('SAL-1').click();
  await see('جولة جمع').waitFor();
  await see('المردم: مردم الجهراء').waitFor();
  await see('4 × حاوية 1100 لتر').waitFor();
  await see('المدخل الخلفي').waitFor();
  await shot(p, 'ws01-round');
  ok('بطاقة الجولة: المردم والنقاط بالترتيب وحاويات كل عميل وملاحظة السائق');

  await btn('قبول الجولة').click();
  await btn('بدأت الجولة').click();
  await btn('جُمعت جمعية السالمية الرئيسي').click();
  await p.getByRole('button', { name: 'تأكيد', exact: true }).click();
  await see('حاويات مفرّغة: 4').waitFor();
  await btn('أنهيت الجولة').click();
  await see('سجّل كل نقطة جُمعت أو لم تُجمع').waitFor();
  await btn('لم تُجمع فرع الجمعية ق 10').click();
  await p.getByRole('button', { name: 'مغلقة بسيارة أو عائق' }).click();
  await see('لم تُجمع: مغلقة بسيارة أو عائق').waitFor();
  ok('نقطة جُمعت بـ 4 حاويات، ولا تنتهي الجولة والنقطة الثانية مفتوحة، ثم تُسجَّل مغلقة بسيارة');

  await btn('أنهيت الجولة').click();
  await see('سجّل تذكرة ميزان المردم').waitFor();
  await btn('تفريغ في المردم').click();
  await typeInto(p.getByLabel('رقم تذكرة الميزان'), 'JH-88120');
  await typeInto(p.getByLabel('الوزن الصافي (كغ)'), '5240');
  await p.getByRole('button', { name: 'تسجيل التذكرة', exact: true }).click();
  await see('سُجّلت تذكرة الميزان').waitFor();
  await shot(p, 'ws02-ticket');
  await btn('أنهيت الجولة').click();
  ok('لا تنتهي الجولة بلا تذكرة ميزان؛ تذكرة JH-88120 بـ 5240 كغ ثم إنهاء الجولة');

  let d;
  for (let i = 0; i < 20; i++) {
    const runs = (await call('GET', `/v1/waste/runs?date=${today}`, undefined, T)).data;
    d = runs[0];
    if (d?.status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (d.status !== 'completed' || d.collected !== 1 || d.missed !== 1 || d.bins !== 4 || d.net_kg !== 5240 || d.dumps !== 1) throw new Error(`run ${JSON.stringify(d)}`);
  ok('عند المكتب: الجولة مكتملة، نقطة جُمعت وأخرى لم تُجمع، 4 حاويات و5.24 طن');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'ws-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
