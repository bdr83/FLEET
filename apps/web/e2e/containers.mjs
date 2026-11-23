// Browser test of the containers pack: a company opens an import container (the number is checked), books the port leg, the
// driver picks it up and drops it at the customer (through the API), the office marks it emptied, books the empty return,
// the driver gates it in at the depot, the office closes it, and checks the yard, exceptions and the report.
// Run: node e2e/containers.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const API = process.env.API_URL ?? 'http://localhost:3000';
const uuid = () => crypto.randomUUID();
async function apiCall(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const kwDay = (plus) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-fp-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);

try {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("الدخول برقم الجوال")');
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'الحاويات التجريبية');
  await page.check('input[name=pack-containers]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الحاويات")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const dphone = `+9656${stamp}`;
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سائق التريلا', phone: dphone });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `CT-${stamp.slice(-5)}` });
  const otp = await apiCall('POST', '/v1/auth/otp/request', { phone: dphone });
  const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone: dphone, code: otp.dev_code });
  const dtok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
  const drive = async (taskId, pick, drop) => {
    for (const op of [{ type: 'task_status', to_status: 'accepted' }, { type: 'task_status', to_status: 'in_progress' }, { type: 'milestone', code: 'ctr_picked', ...pick },
      { type: 'milestone', code: 'ctr_dropped', ...drop }, { type: 'task_status', to_status: 'completed' }]) {
      const r = (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: new Date().toISOString(), task_id: taskId, ...op }] }, dtok)).results[0];
      if (r.result !== 'applied') throw new Error(`driver op ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
    }
  };
  ok('شركة بنشاط الحاويات، مع سائق وشاحنة');

  await page.click('nav a:has-text("الحاويات")');
  await page.locator('h1:has-text("الحاويات والموانئ")').waitFor();
  await page.click('button:has-text("حاوية جديدة")');
  await page.selectOption('.modal select[name=customer_id]', 'new');
  await page.fill('.modal input[name=new_name]', 'شركة الاستيراد');
  await page.fill('.modal input[name=container_no]', 'MSCU1234567');
  await page.fill('.modal input[name=line]', 'MSC');
  await page.fill('.modal input[name=doc_no]', 'BL-778');
  await page.fill('.modal input[name=depot]', 'ساحة الصليبية');
  await page.fill('.modal input[name=site_name]', 'مستودع الري');
  await page.fill('.modal input[name=area]', 'الري');
  await page.fill('.modal input[name=last_free_day]', kwDay(1));
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('.modal .alert:has-text("ISO 6346")').waitFor();
  await page.fill('.modal input[name=container_no]', 'MSCU 123456-6');
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('[data-testid=ctr-jobs] tr:has-text("MSCU1234566 · 40′"):has-text("استيراد · الشويخ"):has-text("بانتظار السحب")').waitFor();
  ok('حاوية استيراد: رقم بخانة تحقق خاطئة رُفض، والصحيح حُفظ بانتظار السحب');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-storage] tr:has-text("MSCU1234566")').waitFor();
  await page.click('[data-testid=ex-storage] tr:has-text("MSCU1234566") button:has-text("إدارة")');
  await page.locator('.modal h2:has-text("حجز الرحلة التالية: من الميناء للعميل")').waitFor();
  await page.selectOption('.modal select[name=driver]', { label: 'سائق التريلا' });
  await page.selectOption('.modal select[name=truck]', { label: `CT-${stamp.slice(-5)}` });
  await page.click('.modal button:has-text("حجز الرحلة")');
  await page.locator('.modal [data-testid=ctr-legs] tr:has-text("من الميناء للعميل"):has-text("سائق التريلا")').waitFor();
  ok('خطر أرضيات في الاستثناءات، وحُجزت رحلة الميناء للعميل');

  const job = (await call('GET', '/containers/jobs')).data[0];
  let d = await call('GET', `/containers/jobs/${job.id}`);
  await drive(d.legs[0].task_id, { container_no: 'MSCU1234566', seal_no: 'SL-99' }, { received_by: 'أمين المستودع' });
  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("أين الحاويات")');
  await page.locator('[data-testid=yard-customer] tr:has-text("MSCU1234566"):has-text("0 يوم")').waitFor();
  await page.click('[data-testid=yard-customer] tr:has-text("MSCU1234566") button:has-text("إدارة")');
  await page.click('.modal button:has-text("فرّغ العميل الحاوية")');
  await page.locator('.modal .badge:has-text("جاهزة للسحب")').waitFor();
  await page.selectOption('.modal select[name=driver]', { label: 'سائق التريلا' });
  await page.selectOption('.modal select[name=truck]', { label: `CT-${stamp.slice(-5)}` });
  await page.fill('.modal input[name=starts_at]', new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16));
  await page.click('.modal button:has-text("حجز الرحلة")');
  await page.locator('.modal [data-testid=ctr-legs] tr:has-text("إرجاع الفارغة للساحة")').waitFor();
  ok('سُلّمت للعميل (أين الحاويات: عند العميل)، فُرّغت، وحُجزت رحلة إرجاع الفارغة');

  d = await call('GET', `/containers/jobs/${job.id}`);
  await drive(d.legs[1].task_id, { container_no: 'MSCU1234566' }, { gate_ref: 'EIR-5521' });
  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("الحاويات")');
  await page.click('[data-testid=ctr-jobs] tr:has-text("MSCU1234566") button:has-text("إدارة")');
  await page.locator('.modal [data-testid=ctr-legs] tr:has-text("EIR-5521")').waitFor();
  await page.fill('.modal input[name=haul]', '45');
  await page.fill('.modal input[name=extra]', '10');
  await page.click('.modal button:has-text("إغلاق"):not([aria-label])');
  await page.locator('.modal dd:has-text("55.000")').waitFor();
  await shot(page, 'ct-closed');
  ok('أُرجعت الفارغة بإيصال البوابة، وأُغلقت بأجرة 45 وإضافي 10');

  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.locator('[data-testid=ct-kpis]:has-text("1 (2 TEU)")').waitFor();
  await page.locator('[data-testid=ct-lines] tr:has-text("MSC")').waitFor();
  await shot(page, 'ct-report');
  ok('التقرير: حاوية واحدة 2 TEU، ورحلتان، وحسب الخط الملاحي');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص الحاويات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'ct-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
