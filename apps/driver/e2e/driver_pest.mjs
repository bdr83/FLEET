// Driver app, pest control visit (pest pack): the job card with the premises, pests and notes; accept, set off, arrive;
// the treatment refused without products, then recorded with two products, the infestation level and the receiver;
// the re-entry warning; done; the office sees the products used, the re-entry time and the next contract visit.
// Build as for driver_web.mjs, serve build/web on APP_URL, then: node e2e/driver_pest.mjs
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

// Office side, through the API: a pest control company, a licensed technician, two products, a monthly restaurant job booked
const owner = `+9655${stamp}`;
let r = await call('POST', '/v1/auth/otp/request', { phone: owner });
r = await call('POST', '/v1/auth/otp/verify', { phone: owner, code: r.dev_code });
const co = await call('POST', '/v1/tenants', { name: 'مكافحة الآفات', packs: ['pest'] }, r.user_token);
const T = co.access_token, le = co.legal_entity_id;
const techPhone = `9${stamp}`;
const w = await call('POST', '/v1/workers', { legal_entity_id: le, kind: 'technician', display_name: 'الفني خالد', phone: `+965${techPhone}` }, T);
await call('POST', '/v1/documents', { legal_entity_id: le, worker_id: w.id, doc_type: 'pesticide_license', number: 'PL-2231', expires_on: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10) }, T);
await call('POST', '/v1/pest/products', { name: 'جل الصراصير', registration_no: 'KM-PC-1102', unit: 'g', reentry_hours: 0 }, T);
await call('POST', '/v1/pest/products', { name: 'رش متبقي', registration_no: 'KM-PC-0877', unit: 'ml', reentry_hours: 4 }, T);
const cu = await call('POST', '/v1/customers', { legal_entity_id: le, name: 'مطعم البحر' }, T);
const job = await call('POST', '/v1/pest/jobs', { legal_entity_id: le, customer_id: cu.id, premises: 'restaurant', service: 'spray', pests: ['cockroaches', 'rodents'], area: 'السالمية',
  address: 'شارع البلاجات', scheduled_at: new Date(Date.now() - 10 * 60_000).toISOString(), repeat_days: 30, notes: 'المطبخ يغلق 3 العصر' }, T);
await call('POST', `/v1/pest/jobs/${job.id}/assign`, { worker_id: w.id }, T);
ok(`المكتب: أمر ${job.ref} لمطعم بعقد شهري، مسند لفني مرخّص`);

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
  await typeInto(p.getByLabel('رقم الجوال'), techPhone);
  await btn('إرسال رمز التحقق').click();
  const dev = p.getByText(/رمز التطوير: \d{6}/);
  await dev.waitFor();
  await typeInto(p.getByLabel('رمز التحقق'), (await dev.textContent()).match(/\d{6}/)[0]);
  await btn('دخول').click();
  await see(job.ref).click();
  await see('مطعم البحر').waitFor();
  await see('الآفات: صراصير، قوارض').waitFor();
  await see('المطبخ يغلق 3 العصر').waitFor();
  await shot(p, 'pc01-job');
  ok('بطاقة الزيارة: العميل ونوع المنشأة والآفات والملاحظات');

  await btn('قبول الزيارة').click();
  await btn('انطلقت للعميل').click();
  await btn('وصلت الموقع').click();
  await btn('تسجيل العلاج').click();
  await see('متوسطة').click();
  await typeInto(p.getByLabel('اسم المستلم'), 'مدير المطعم');
  await p.getByRole('button', { name: 'تأكيد العلاج', exact: true }).click();
  await see('سجّل المبيدات المستخدمة').waitFor();
  ok('وصل الفني؛ العلاج مرفوض بلا مبيدات');

  await btn('تسجيل العلاج').click();
  await typeInto(p.getByLabel('جل الصراصير (غرام)'), '30');
  await typeInto(p.getByLabel('رش متبقي (مل)'), '250');
  await typeInto(p.getByLabel('أماكن العلاج (المطبخ، المخزن...)'), 'المطبخ والمخزن');
  await see('متوسطة').click();
  await typeInto(p.getByLabel('اسم المستلم'), 'مدير المطعم');
  await p.getByRole('button', { name: 'تأكيد العلاج', exact: true }).click();
  await see('لا دخول قبل 4 ساعات').waitFor();
  await shot(p, 'pc02-treated');
  await btn('إنهاء الزيارة').click();
  ok('العلاج بمبيدين (30 غرام جل و250 مل رش)، وتنبيه منع الدخول 4 ساعات، ثم الإنهاء');

  let d;
  for (let i = 0; i < 20; i++) {
    d = await call('GET', `/v1/pest/jobs/${job.id}`, undefined, T);
    if (d.state === 'done') break;
    await p.waitForTimeout(500);
  }
  const hours = Math.round((Date.parse(d.reentry_at) - Date.parse(d.treated_at)) / 3_600_000);
  if (d.state !== 'done' || d.infestation !== 'medium' || d.received_by !== 'مدير المطعم' || d.applications.length !== 2 || hours !== 4 || !d.next_ref) throw new Error(`job ${JSON.stringify(d)}`);
  ok(`عند المكتب: الأمر مغلق بمبيدين وإصابة متوسطة، ومنع دخول 4 ساعات، والزيارة التالية ${d.next_ref} محجوزة بعد 30 يومًا`);

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(p, 'pc-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
