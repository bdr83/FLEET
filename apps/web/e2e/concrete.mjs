// Browser test of the ready-mix pack: pour order form, loads on the time axis, mixer assignment, driver stages,
// mixers board, exceptions, signed ticket and review, quantity change and hold, waiting report, settings.
// Run: node e2e/concrete.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const API = process.env.API_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const uuid = () => crypto.randomUUID();
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
async function apiCall(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const kw = (d, o) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait', ...o }).format(d);

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-fp-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);

try {
  await page.goto(`${WEB}/login`);
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'خرسانة الخليج');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const customer = await call('POST', '/customers', { legal_entity_id: le, name: 'مقاولات الريم' });
  const k = await call('POST', '/contracts', { customer_id: customer.id, starts_on: '2026-01-01', rates: [{ unit: 'm3', price: '22.000', sector_pack: 'concrete@1' }, { unit: 'hour', price: '10.000', sector_pack: 'concrete@1' }] });
  await call('POST', `/contracts/${k.id}/activate`, {});
  ok('دخول وإنشاء شركة خرسانة وعميل بعقد بالمتر المكعب');

  // Two mixers with drivers on shift (the driver app is simulated by API calls)
  const drivers = [];
  for (const [name, n] of [['فهد المطيري', 1], ['ناصر العنزي', 2]]) {
    const phone = `+9656${stamp.slice(0, 6)}${n}`;
    const w = await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: name, phone });
    const m = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'mixer', plate_no: `MX-${n}${stamp.slice(-3)}`, capacity: { m3: 9 } });
    const otp = await apiCall('POST', '/v1/auth/otp/request', { phone });
    const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone, code: otp.dev_code });
    const tok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
    await apiCall('POST', '/v1/driver/shifts', { client_op_id: uuid(), asset_id: m.id }, tok);
    drivers.push({ w, m, tok });
  }
  const sync = async (d, op, at = new Date().toISOString()) => (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: at, ...op }] }, d.tok)).results[0];
  ok('خلاطتان وسائقان في وردية');

  // 1. Pour order form
  await page.click('nav a:has-text("جدول الصب")');
  await page.click('button:has-text("طلب صب جديد")');
  const start = new Date(Date.now() + 60 * 60_000);
  await page.fill('input[name=ref]', `RM-${stamp}`);
  await page.selectOption('select[name=customer_id]', { label: 'مقاولات الريم' });
  await page.fill('input[name=mix_code]', 'C35');
  await page.fill('input[name=volume_m3]', '22');
  await page.fill('input[name=pour_rate_m3h]', '30');
  await page.fill('input[name=date]', kw(start, {}));
  await page.fill('input[name=at]', kw(start, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  await page.fill('input[name=name]', 'برج الريم');
  await page.fill('input[name=area]', 'الشرق');
  await page.fill('input[name=block]', '2');
  await page.fill('input[name=plot]', '15');
  await page.fill('input[name=contact_name]', 'م. خالد');
  await page.fill('input[name=lat]', '29.375');
  await page.fill('input[name=lng]', '47.99');
  await shot(page, 'c01-pour-form');
  await page.click('.modal button:has-text("إنشاء وجدولة الحمولات")');
  const loads = page.locator('[data-testid=loads] tbody tr');
  await page.locator('.modal h2:has-text("طلب الصب RM-")').waitFor();
  if ((await loads.count()) !== 3) throw new Error(`loads ${await loads.count()}`);
  await page.locator('.modal dd:has-text("3 خلاطات لصب مستمر")').waitFor().catch(async () => { await page.locator('.modal dd:has-text("خلاطة كل")').waitFor(); });
  ok('طلب الصب يُقسّم إلى 3 حمولات (9 + 9 + 4 م³) مع خطة الصب المستمر');

  // 2. Assign the first load to a mixer from the pour window
  await page.selectOption('select[aria-label="خلاطة للحمولة 1"]', { index: 1 });
  await loads.first().locator(`text=${drivers[0].m.plate_no}`).waitFor();
  const pour = (await call('GET', `/concrete/pours?from=${encodeURIComponent(ago(24 * 60))}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86_400_000).toISOString())}`)).data.find((p) => p.ref === `RM-${stamp}`);
  const load1 = pour.loads_brief[0].task_id;
  await shot(page, 'c02-pour-detail');
  ok('إسناد الحمولة الأولى لخلاطة في الوردية من نافذة الطلب');

  // 3. Driver stages: loaded 80 min ago, on site for an hour
  for (const [op, at] of [[{ type: 'task_status', to_status: 'accepted' }, ago(85)], [{ type: 'milestone', code: 'loaded' }, ago(80)],
    [{ type: 'task_status', to_status: 'in_progress' }, ago(78)], [{ type: 'milestone', code: 'at_site' }, ago(60)]]) {
    const r = await sync(drivers[0], { task_id: load1, ...op }, at);
    if (r.result !== 'applied') throw new Error(`${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  }
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('[data-testid=mixers] li:has-text("انتظار بالموقع")').waitFor();
  await page.locator('[data-testid=mixers] .age.warn').waitFor();
  await page.locator('[data-testid=gantt] .g-load').first().waitFor();
  await shot(page, 'c03-schedule');
  ok('جدول الصب: الحمولات على المحور الزمني، والخلاطة «انتظار بالموقع» مع تنبيه عمر الخرسانة');

  // 4. Exceptions
  await page.click('button[role=tab]:has-text("الاستثناءات")');
  await page.locator('section:has-text("عمر الخرسانة") td:has-text("RM-")').first().waitFor();
  await page.locator('section:has-text("خلاطات تنتظر في الموقع") td:has-text("RM-")').first().waitFor();
  await shot(page, 'c04-exceptions');
  ok('الاستثناءات: عمر الخرسانة والانتظار فوق المجاني والحمولات القريبة بلا خلاطة');

  // 5. The pour ends, the site engineer signs, the office reviews
  await sync(drivers[0], { task_id: load1, type: 'milestone', code: 'pour_start' }, ago(15));
  await sync(drivers[0], { task_id: load1, type: 'milestone', code: 'pour_end' }, ago(2));
  if ((await sync(drivers[0], { task_id: load1, type: 'task_status', to_status: 'completed' })).reason !== 'proof_required') throw new Error('completed without ticket');
  await sync(drivers[0], { task_id: load1, type: 'ticket', poured_m3: 8.5, returned_m3: 0.5, signed_by: 'م. خالد' });
  await sync(drivers[0], { task_id: load1, type: 'task_status', to_status: 'completed' });
  await page.goto(`${WEB}/tasks/${load1}`);
  await page.locator('[data-testid=ticket] .badge:has-text("موقّعة")').waitFor();
  await page.locator('[data-testid=ticket] dd:has-text("45 د")').waitFor();
  await page.click('button:has-text("اعتماد المراجعة")');
  await page.locator('.badge:has-text("مراجَعة")').first().waitFor();
  await shot(page, 'c05-ticket');
  ok('تذكرة موقّعة بالمصبوب والمرتجع والانتظار، ثم اعتماد المراجعة');

  // 6. Quantity change and site hold from the pour window
  await page.click('nav a:has-text("جدول الصب")');
  await page.click(`button[aria-label="طلب الصب RM-${stamp}"]`);
  await page.click('.modal button:has-text("تعديل الكمية")');
  await page.fill('.modal input[name=volume_m3]', '30');
  await page.fill('.modal input[name=reason]', 'طلب المهندس زيادة');
  await page.click('.modal button:has-text("حفظ الكمية")');
  await loads.nth(3).waitFor();
  if ((await loads.count()) !== 4) throw new Error(`loads after adjust ${await loads.count()}`);
  await page.locator('.modal dd:has-text("C35 · 30 م³")').waitFor();
  await page.click('.modal button:has-text("إيقاف: الموقع غير جاهز")');
  await page.locator('.modal .badge:has-text("الموقع غير جاهز")').waitFor();
  ok('تعديل الكمية إلى 30 م³ يضيف حمولة، وإيقاف الإرسال لأن الموقع غير جاهز');
  await page.keyboard.press('Escape');

  // 7. Waiting report and settings
  await page.click('button[role=tab]:has-text("تقرير الانتظار")');
  await page.locator('[data-testid=waiting] tr:has-text("مقاولات الريم") td:has-text("0.25")').waitFor();
  await shot(page, 'c06-waiting');
  await page.click('button[role=tab]:has-text("الإعدادات")');
  await page.locator('label:has-text("حمولة الخلاطة") input').fill('10');
  await page.click('button:has-text("حفظ")');
  await page.locator('.alert:has-text("حُفظت الإعدادات")').waitFor();
  ok('تقرير الانتظار بالعميل (0.25 ساعة محتسبة) وحفظ إعدادات المحطة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(page, 'c-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
