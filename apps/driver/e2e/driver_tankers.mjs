// Driver app, tankers (tankers pack): a diesel trip: the card, the litres filled (more than the tanker holds is refused),
// then the litres discharged and the receiver.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_tankers.mjs
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

// Office side, through the API: a driver, a registered diesel tanker, a diesel order assigned to them
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'الصهاريج', packs: ['tankers'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const techPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التانكر', phone: `+965${techPhone}` }, T);
const tk = await call('POST', '/v1/assets', { legal_entity_id: le, asset_type: 'tanker', plate_no: `TF-${stamp.slice(-5)}` }, T);
await call('PUT', `/v1/tankers/vehicles/${tk.id}`, { product_class: 'fuel', capacity_l: 20000 }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, kind: 'business', name: 'موقع البناء' }, T);
const job = await call('POST', '/v1/tankers/orders', { legal_entity_id: le, customer_id: cu.id, product: 'diesel', qty_l: 5000, site: { name: 'موقع البناء', area: 'صباح الأحمد', phone: '+96550006666' }, notes: 'المولد خلف البوابة' }, T);
await call('POST', `/v1/tankers/orders/${job.id}/assign`, { driver_worker_id: w.id, asset_id: tk.id }, T);
ok(`المكتب: طلب ديزل ${job.ref} 5000 لتر مسند للسائق`);

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
  await see('ديزل').waitFor();
  await see('5000 L').waitFor();
  await see('سعة الصهريج 20000 لتر').waitFor();
  await see('المولد خلف البوابة').waitFor();
  await shot(p, 'tk01-trip');
  ok('بطاقة الطلب: المنتج والكمية وسعة الصهريج والملاحظة');

  await btn('قبول الطلب').click();
  await btn('انطلقت للتعبئة').click();
  await btn('تمت التعبئة').click();
  await p.getByLabel('اللترات المعبأة (من العدّاد)').fill('');
  await typeInto(p.getByLabel('اللترات المعبأة (من العدّاد)'), '25000');
  await btn('تأكيد التعبئة').click();
  await p.waitForTimeout(1500);
  let j = await call('GET', `/v1/tankers/orders/${job.id}`, undefined, T);
  if (j.loaded_l !== null) throw new Error('more than the capacity was accepted');
  await btn('تمت التعبئة').click();
  await typeInto(p.getByLabel('محطة التعبئة'), 'محطة الأحمدي');
  await btn('تأكيد التعبئة').click();
  await btn('تم التفريغ').waitFor();
  ok('تعبئة أكثر من سعة الصهريج رُفضت، ثم التعبئة بالكمية المطلوبة من محطة الأحمدي');

  await btn('تم التفريغ').click();
  await typeInto(p.getByLabel('اللترات المفرّغة (من العدّاد)'), '4985');
  await typeInto(p.getByLabel('اسم المستلم'), 'مشرف الموقع');
  await shot(p, 'tk02-done');
  await btn('تأكيد التفريغ').click();
  for (let i = 0; i < 20; i++) {
    j = await call('GET', `/v1/tankers/orders/${job.id}`, undefined, T);
    if (j.state === 'delivered' && j.task_status === 'completed') break;
    await p.waitForTimeout(500);
  }
  if (j.state !== 'delivered' || j.loaded_l !== 5000 || j.delivered_l !== 4985 || j.source !== 'محطة الأحمدي' || j.received_by !== 'مشرف الموقع' || j.loss_l !== 15) throw new Error(`order ${JSON.stringify(j)}`);
  ok('فُرّغ 4985 لتر لمشرف الموقع، وانتهى الطلب بفاقد 15 لتر');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'tk-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
