// Browser test of the driver-supply pack: supply request form, eligible candidates, placement and day-shifts, coverage board,
// check-in/out from the driver app (simulated), far check-in exception, substitute, timesheet, the customer's portal
// (first name only, dispute), resolving the dispute, approving the hours, settings.
// Run: node e2e/staffing.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
const kwDay = (plus = 0) => new Date(Date.now() + 3 * 3_600_000 + plus * 86_400_000).toISOString().slice(0, 10);

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.dismiss());
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-fp-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);
async function login(phone) {
  await page.goto(`${WEB}/login`);
  await page.click('button:has-text("الدخول برقم الجوال")');
  await page.fill('input[name=phone]', phone);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
}

try {
  const owner = `+9655${stamp}`;
  await login(owner);
  await page.fill('input[name=company]', 'توريد الخليج');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const customer = await call('POST', '/customers', { legal_entity_id: le, name: 'شركة التموين' });
  const k = await call('POST', '/contracts', { customer_id: customer.id, starts_on: '2026-01-01', rates: [{ unit: 'hour', price: '3.500', sector_pack: 'staffing@1' }] });
  await call('POST', `/contracts/${k.id}/activate`, {});
  const portalPhone = `+9659${stamp}`;
  await call('POST', '/members', { phone: portalPhone, role_code: 'customer', customer_id: customer.id, display_name: 'مسؤول التموين' });
  ok('دخول وإنشاء شركة توريد وعميل بعقد بالساعة ومستخدم لبوابته');

  // Drivers: one eligible, one without a licence, one whose licence expires during the request (the app is simulated by API calls)
  const drivers = [];
  for (const [name, n, docs] of [['فهد عبدالله المطيري', 1, [['driving_license', kwDay(400)], ['residency', kwDay(300)]]], ['سالم بلا رخصة', 2, [['residency', kwDay(300)]]],
    ['ناصر العنزي', 3, [['driving_license', kwDay(5)], ['residency', kwDay(300)]]]]) {
    const phone = `+9656${stamp.slice(0, 6)}${n}`;
    const w = await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: name, phone });
    for (const [doc_type, expires_on] of docs) await call('POST', '/documents', { doc_type, worker_id: w.id, expires_on });
    const otp = await apiCall('POST', '/v1/auth/otp/request', { phone });
    const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone, code: otp.dev_code });
    drivers.push({ w, tok: (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token });
  }
  const sync = async (d, op, at = new Date().toISOString()) => (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: at, ...op }] }, d.tok)).results[0];
  ok('ثلاثة سائقين بمستندات مختلفة');

  // 1. Supply request form
  await page.click('nav a:has-text("لوحة الإسناد")');
  await page.locator('h1:has-text("لوحة الإسناد")').waitFor();
  await page.click('button:has-text("طلب توريد جديد")');
  const ref = `SR-${stamp}`;
  await page.fill('input[name=ref]', ref);
  await page.locator('select[name=customer_id] option:has-text("شركة التموين")').waitFor({ state: 'attached' });
  await page.selectOption('select[name=customer_id]', { label: 'شركة التموين' });
  await page.fill('input[name=starts_on]', kwDay());
  await page.fill('input[name=ends_on]', kwDay(13));
  await page.fill('input[name=shift_start]', '00:00');
  await page.fill('input[name=shift_end]', '23:59');
  await page.check('fieldset.weekdays label:has-text("الجمعة") input');
  await page.check('fieldset.weekdays label:has-text("السبت") input');
  await page.fill('input[name=name]', 'مستودع الري');
  await page.fill('input[name=area]', 'الري');
  await page.fill('input[name=block]', '1');
  await page.fill('input[name=lat]', '29.3');
  await page.fill('input[name=lng]', '47.93');
  await shot(page, 's-new');
  await page.click('button:has-text("إنشاء الطلب")');
  await page.locator(`.modal h2:has-text("طلب التوريد ${ref}")`).waitFor();
  await page.locator('.modal dd:has-text("كل الأيام")').waitFor();
  ok('نموذج طلب التوريد: سائق واحد لأسبوعين، كل الأيام، مع موقع ودبوس');

  // 2. Candidates and placement
  await page.click('.modal button:has-text("تعيين سائق")');
  const sel = page.locator('.modal select[name=worker_id]');
  await sel.locator('option:has-text("فهد عبدالله المطيري")').waitFor({ state: 'attached' });
  if ((await sel.locator('option:has-text("سالم بلا رخصة")').getAttribute('disabled')) === null) throw new Error(`a driver without a licence is selectable: ${await sel.innerHTML()}`);
  if (!(await sel.locator('option:has-text("ناصر العنزي")').textContent()).includes('ينتهي خلال الفترة')) throw new Error('expiring licence not flagged');
  await sel.selectOption({ label: (await sel.locator('option:has-text("فهد")').textContent()).trim() });
  await page.click('.modal button:has-text("تعيين وإنشاء المناوبات")');
  await page.locator('[data-testid=placements] td:has-text("فهد عبدالله المطيري")').waitFor();
  await page.locator('[data-testid=shifts] tbody tr').nth(7).waitFor();
  await shot(page, 's-request');
  ok('المرشحون: غير المؤهل معطّل والمستند المنتهي قريبًا منبَّه، والتعيين ينشئ المناوبات اليومية');

  // 3. Coverage board
  await page.click('.modal button[aria-label="إغلاق"], .modal .close').catch(() => page.keyboard.press('Escape'));
  await page.keyboard.press('Escape');
  const row = page.locator(`[data-testid=coverage] tr:has-text("${ref}")`);
  await row.waitFor();
  await row.locator('td.cov.ok:has-text("1/1")').first().waitFor();
  ok('لوحة التغطية: اليوم مغطى 1/1');

  // 4. The driver checks in (about 1.1 km away) and out
  const detail = await call('GET', `/staffing/requests/${(await call('GET', '/staffing/requests')).data.find((r) => r.ref === ref).id}`);
  const today = detail.shifts.find((s) => s.work_date === kwDay());
  const tomorrow = detail.shifts.find((s) => s.work_date === kwDay(1));
  const d1 = drivers[0];
  const list = (await apiCall('GET', '/v1/driver/tasks', undefined, d1.tok)).data.filter((t) => t.sector_pack === 'staffing@1');
  if (list.length < 1 || list.length > 3) throw new Error(`driver sees ${list.length} staffing tasks`);
  await sync(d1, { type: 'task_status', task_id: today.task_id, to_status: 'accepted' }, ago(491));
  await sync(d1, { type: 'milestone', task_id: today.task_id, code: 'check_in', lat: 29.31, lng: 47.93 }, ago(490));
  await sync(d1, { type: 'task_status', task_id: today.task_id, to_status: 'in_progress' }, ago(490));
  await sync(d1, { type: 'milestone', task_id: today.task_id, code: 'check_out' });
  if ((await sync(d1, { type: 'task_status', task_id: today.task_id, to_status: 'completed' })).result !== 'applied') throw new Error('completion rejected');
  await page.reload();
  await row.locator('td.cov.in').first().waitFor();
  await shot(page, 's-board');
  ok('الحضور والانصراف من التطبيق: الخلية خضراء (الكل حضر)');

  // 5. Exceptions: far check-in
  await page.click('button[role=tab]:has-text("الاستثناءات")');
  await page.locator('section:has(h2:has-text("حضور بعيد عن الموقع")) td:has-text("فهد عبدالله المطيري")').waitFor();
  await shot(page, 's-exceptions');
  ok('الاستثناءات: حضور على بعد أكثر من نطاق الموقع');

  // 6. Substitute for tomorrow
  await page.click('button[role=tab]:has-text("التغطية")');
  await row.locator(`button:has-text("${ref}")`).click();
  const tRow = page.locator('[data-testid=shifts] tbody tr').filter({ has: page.locator(`a[href="/tasks/${tomorrow.task_id}"]`) });
  await tRow.locator('button:has-text("بديل")').click();
  const sub = page.locator('.modal select[aria-label="السائق البديل"]');
  await sub.locator('option:has-text("ناصر العنزي")').waitFor({ state: 'attached' });
  await sub.selectOption({ label: (await sub.locator('option:has-text("ناصر")').textContent()).trim() });
  await page.click('.modal button:has-text("إسناد البديل")');
  await tRow.locator('td:has-text("ناصر العنزي")').waitFor();
  await tRow.locator('.muted:has-text("بديل")').waitFor();
  ok('بديل ليوم الغد: ناصر بدل فهد');
  await page.keyboard.press('Escape');

  // 7. Timesheet
  await page.click('button[role=tab]:has-text("كشف الساعات")');
  await page.locator(`[data-testid=timesheet] tr:has-text("${ref}") td:has-text("8.25 س")`).waitFor();
  ok('كشف الساعات: 8.25 ساعة (8 س 10 د مقرّبة لربع ساعة)');

  // 8. The customer: first name only, dispute
  await page.click('button:has-text("خروج")');
  await page.waitForURL(/\/login/);
  await login(portalPhone);
  await page.waitForURL(/\/portal$/);
  const ps = page.locator('[data-testid=portal-staffing]');
  await ps.locator('td:has-text("فهد") .badge:has-text("الرخصة سارية")').waitFor();
  if ((await ps.textContent()).includes('المطيري')) throw new Error('the customer sees the full name');
  await ps.locator('[data-testid=portal-shifts] tr:has-text("8.25 س") button:has-text("اعتراض")').click();
  await page.fill('.modal input', 'غادر الساعة 4 عصرًا');
  await page.click('.modal button:has-text("إرسال الاعتراض")');
  await ps.locator('.badge:has-text("اعتراض قيد المراجعة")').waitFor();
  await shot(page, 's-portal');
  ok('بوابة العميل: الاسم الأول فقط وحالة الرخصة، واعتراض على ساعات اليوم');

  // 9. The office settles the dispute and approves
  await page.click('button:has-text("خروج")');
  await page.waitForURL(/\/login/);
  await login(owner);
  await page.waitForURL(`${WEB}/`);
  await page.goto(`${WEB}/staffing`);
  await page.click('button[role=tab]:has-text("الاستثناءات")');
  await page.locator('section:has(h2:has-text("اعتراضات العملاء")) tr:has-text("غادر الساعة 4 عصرًا") button:has-text("حل")').click();
  await page.fill('.modal input[name=hours]', '8');
  await page.fill('.modal input[name=resolution]', 'اتفقنا مع العميل على 8 ساعات');
  await page.click('.modal button:has-text("حفظ الحل")');
  await page.locator('section:has(h2:has-text("اعتراضات العملاء")) :text("لا يوجد")').waitFor();
  await page.click('button[role=tab]:has-text("كشف الساعات")');
  const ts = page.locator(`[data-testid=timesheet] tr:has-text("${ref}")`).filter({ hasText: '8 س' });
  await ts.locator('input[type=checkbox]').check();
  await page.click('button:has-text("اعتماد المحدد")');
  await page.locator('.alert.ok:has-text("اعتُمد 1 يوم")').waitFor();
  await ts.locator('.badge:has-text("مراجَعة")').waitFor();
  await shot(page, 's-timesheet');
  ok('حل الاعتراض على 8 ساعات ثم اعتماد اليوم من كشف الساعات');

  // 10. Invoice by the hour and settings
  const inv = await call('POST', '/invoices', { customer_id: customer.id, period_from: kwDay(), period_to: kwDay() });
  const line = inv.lines?.find((l) => l.task_id === today.task_id);
  if (!line || line.unit !== 'hour' || line.amount !== '28.000') throw new Error(`invoice line ${JSON.stringify(line ?? inv)}`);
  await page.click('button[role=tab]:has-text("الإعدادات")');
  await page.locator('label:has-text("تقريب الساعات") select').selectOption('30');
  await page.click('button:has-text("حفظ")');
  await page.locator('.alert:has-text("حُفظت الإعدادات")').waitFor();
  ok('الفاتورة: 8 ساعات × 3.500 = 28.000، وحفظ الإعدادات');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(page, 's-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
