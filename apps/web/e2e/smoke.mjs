// Browser smoke test against a running web app (WEB_URL) + API with OTP_DEV_ECHO=1.
// Run: node e2e/smoke.mjs   (uses the preinstalled Playwright; screenshots go to SHOTS_DIR if set)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const API = process.env.API_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const phone = `+9655${String(Date.now()).slice(-7)}`;
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  // 1. Unauthenticated → redirected to login
  await page.goto(`${WEB}/tasks`);
  await page.waitForURL(/\/login\?next=%2Ftasks/);
  ok('غير المسجّل يُحوَّل إلى الدخول');

  // 2. OTP login, then create the first company
  await page.fill('input[name=phone]', phone);
  await page.click('button:has-text("إرسال رمز التحقق")');
  const code = (await page.locator('.alert.ok .num').textContent()).trim();
  await page.fill('input[name=code]', code);
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'شركة اختبار المتصفح');
  await shot(page, '01-onboard');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(/\/tasks$/);
  await page.locator('h1:has-text("المهام")').waitFor();
  ok('الدخول بالرمز وإنشاء الشركة');

  // Tokens never reach JavaScript: session cookies are httpOnly
  const jsCookies = await page.evaluate(() => document.cookie);
  if (/fp_(at|rt|ut)/.test(jsCookies)) throw new Error('session cookie readable from JS');
  ok('رموز الجلسة غير مقروءة من JavaScript');

  // A request without the CSRF header is refused by the proxy
  const csrf = await page.evaluate(async () => (await fetch('/api/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  if (csrf !== 403) throw new Error(`csrf check returned ${csrf}`);
  ok('طلب بلا ترويسة CSRF مرفوض');

  // Fleet screens: add a vehicle, a driver with a phone (enables the driver app), and a document that expires soon
  await page.click('nav a:text-is("المركبات")');
  await page.click('button:has-text("إضافة مركبة")');
  await page.fill('input[name=plate_no]', '12-34567');
  await page.fill('input[name=make]', 'Toyota');
  await page.fill('input[name=odometer_km]', '15000');
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('td:has-text("12-34567")').waitFor();
  ok('إضافة مركبة');

  const driverPhone = `+9656${String(Date.now()).slice(-7)}`;
  await page.click('nav a:has-text("السائقون")');
  await page.click('button:has-text("إضافة سائق")');
  await page.fill('input[name=display_name]', 'سالم السائق');
  await page.fill('input[name=phone]', driverPhone);
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('td:has-text("سالم السائق")').waitFor();
  await page.click('td:has-text("سالم السائق")');
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await page.fill('.modal input[name=number]', 'DL-998877');
  await page.fill('.modal input[name=expires_on]', soon);
  await page.click('.modal button:has-text("إضافة وثيقة")');
  await page.locator('.modal .badge:has-text("تنتهي خلال")').waitFor();
  await page.keyboard.press('Escape');
  await page.click('nav a:has-text("الوثائق")');
  await page.locator('tr:has-text("DL-998877")').waitFor();
  ok('إضافة سائق بجواله ووثيقة تظهر في تنبيهات الانتهاء');
  await shot(page, '02a-documents');

  // The driver logs in from the (future) mobile app: simulated straight against the API
  const tenantId = (await page.evaluate(async () => (await fetch('/api/v1/me')).json())).tenant_id;
  const j = async (path, body, token) => {
    const r = await fetch(`${API}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(data)}`);
    return data;
  };
  const otp = await j('/v1/auth/otp/request', { phone: driverPhone });
  const ver = await j('/v1/auth/otp/verify', { phone: driverPhone, code: otp.dev_code });
  const drv = await j('/v1/auth/token', { tenant_id: tenantId }, ver.user_token);
  const shift = await j('/v1/driver/shifts', { client_op_id: crypto.randomUUID() }, drv.access_token);
  const now = Date.now();
  const pts = [[29.3375, 48.0186], [29.3402, 48.0250], [29.3431, 48.0322]].map(([lat, lng], i) => ({
    recorded_at: new Date(now + i * 20_000).toISOString(), lat, lng, accuracy_m: 8, speed_mps: 10, battery_pct: 80 }));
  await j('/v1/driver/locations', { points: pts }, drv.access_token);

  await page.click('nav a:has-text("الخريطة الحية")');
  await page.locator('.driver-row:has-text("سالم السائق")').waitFor();
  await page.locator('.leaflet-interactive').first().waitFor();
  await page.click('.driver-row:has-text("سالم السائق")');
  await page.locator('text=مسار المناوبة').waitFor();
  await page.locator('path.leaflet-interactive[stroke="#1d6fb8"]').waitFor();
  const stats = await page.locator('aside .card div').last().textContent(); if (!(parseFloat(stats) > 1)) throw new Error(`track distance wrong: ${stats}`);
  ok('السائق في المناوبة يظهر على الخريطة مع مساره');
  await shot(page, '02b-map');
  const w = { id: (await page.evaluate(async () => (await (await fetch('/api/v1/workers?status=active')).json()).data[0].id)) };
  void shift;

  // Customers and contracts: customer with a site, a contract with a price, activate, price preview
  await page.click('nav a:has-text("العملاء")');
  await page.click('button:has-text("إضافة عميل")');
  await page.fill('.modal input[name=name]', 'متجر الورد');
  await page.fill('.modal input[name=payment_terms_days]', '15');
  await page.click('.modal button:has-text("حفظ")');
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
  await page.click('button:has-text("إضافة موقع")');
  await page.fill('.modal input[name=name]', 'المستودع الرئيسي');
  await page.fill('.modal input[name=lat]', '29.3375');
  await page.fill('.modal input[name=lng]', '48.0186');
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('td:has-text("المستودع الرئيسي")').waitFor();
  ok('إضافة عميل وموقع');

  await page.click('a:has-text("عقد جديد")');
  await page.locator('.modal select[name=customer_id] option:has-text("متجر الورد")').waitFor({ state: 'attached' });
  await page.click('.modal button:has-text("إنشاء المسودة")');
  await page.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
  await page.selectOption('select[name=sector_pack]', 'delivery@1');
  await page.fill('input[name=price]', '1.500');
  await page.click('button:has-text("إضافة السعر")');
  await page.locator('td:has-text("1.500 KWD")').waitFor();
  await page.click('button:has-text("تفعيل العقد")');
  await page.locator('.badge:has-text("ساري")').waitFor();
  if (await page.locator('button:has-text("إضافة السعر")').count()) throw new Error('rates still editable after activation');
  await page.click('button:has-text("احسب")');
  await page.locator('strong.num:has-text("1.500 KWD")').waitFor();
  ok('عقد بسعر توصيل، تفعيله يجمّد الأسعار، وحاسبة السعر صحيحة');
  await shot(page, '02c-contract');

  // Maintenance: a 7-day plan is due soon → open a work order from it, add a cost line, complete → expense posted
  await page.click('nav a:has-text("الصيانة")');
  await page.click('button[role=tab]:has-text("خطط الصيانة")');
  await page.selectOption('select[name=asset_id]', { label: '12-34567' });
  await page.fill('input[name=name]', 'فحص أسبوعي');
  await page.fill('input[name=interval_days]', '7');
  await page.click('button:has-text("إضافة خطة")');
  await page.locator('td:has-text("فحص أسبوعي")').waitFor();
  await page.click('button[role=tab]:has-text("المستحقة")');
  await page.locator('tr:has-text("فحص أسبوعي") button:has-text("فتح أمر عمل")').click();
  await page.click('.modal button:has-text("فتح")');
  await page.waitForURL(/\/maintenance\/[0-9a-f-]{36}$/);
  await page.fill('input[name=description]', 'فلتر زيت');
  await page.fill('input[name=qty]', '2');
  await page.fill('input[name=unit_cost]', '3.250');
  await page.click('button:has-text("إضافة بند")');
  await page.locator('td strong:has-text("6.500 KWD")').waitFor();
  await page.click('button:has-text("تم الإنجاز")');
  await page.locator('.badge:has-text("منجز")').waitFor();
  ok('خطة صيانة مستحقة ← أمر عمل ببنود ← إنجاز');
  await shot(page, '02d-work-order');

  // Expenses: the work order cost is there; a driver's claim from the app waits for approval
  await j('/v1/driver/expenses', { client_op_id: crypto.randomUUID(), category: 'fuel', amount: '4.750', liters: 30 }, drv.access_token);
  await page.click('nav a:has-text("المصروفات")');
  await page.locator('tr:has-text("صيانة"):has-text("6.500 KWD")').waitFor();
  const claim = page.locator('tr:has-text("4.750 KWD")');
  await claim.locator('.badge:has-text("بانتظار الاعتماد")').waitFor();
  await claim.locator('button:has-text("اعتماد")').click();
  await claim.locator('.badge:has-text("معتمد")').waitFor();
  ok('مصروف الصيانة مسجّل، ومطالبة السائق تُعتمد من المكتب');

  // Tasks: create from the form for the customer, assign from the dispatch board
  await page.click('nav a:has-text("المهام")');
  await page.locator('h1:has-text("المهام")').waitFor();
  await page.click('button:has-text("مهمة جديدة")');
  await page.fill('input[name=ref]', 'WEB-001');
  await page.fill('input[name=area]', 'السالمية');
  await page.fill('input[name=block]', '5');
  await page.fill('input[name=street]', '10');
  await page.fill('input[name=recipient_name]', 'أحمد');
  await page.fill('input[name=recipient_phone]', '50000001');
  await page.selectOption('select[name=customer_id]', { label: 'متجر الورد' });
  await shot(page, '03-new-task');
  await page.click('.modal button:has-text("إنشاء")');
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  await page.locator('.badge:has-text("جاهزة")').waitFor();
  const taskId = page.url().split('/').pop();
  ok('إنشاء مهمة من النموذج وفتح صفحتها');

  await page.click('nav a:has-text("لوحة التوزيع")');
  await page.locator('td a:has-text("WEB-001")').waitFor();
  await page.locator('tr', { has: page.locator('a:has-text("WEB-001")') }).locator('button:has-text("إسناد")').click();
  const wid = await page.locator('select[name=worker] option', { hasText: 'سالم السائق' }).getAttribute('value');
  await page.selectOption('select[name=worker]', wid);
  await shot(page, '04-assign');
  await page.click('.modal button.primary:has-text("إسناد")');
  await page.locator('.modal').waitFor({ state: 'detached' });
  await page.locator('text=لا توجد مهام بانتظار سائق').waitFor();
  ok('الإسناد من لوحة التوزيع يُخرج المهمة من القائمة');
  await shot(page, '05-board');

  // The driver works it from the app (simulated): accept, start, collect cash on delivery, complete
  const status = (to_status) => j('/v1/driver/sync', { ops: [{ type: 'task_status', client_op_id: crypto.randomUUID(), task_id: taskId, to_status, occurred_at: new Date().toISOString() }] }, drv.access_token);
  await status('accepted');
  await status('in_progress');
  await j('/v1/driver/cod', { client_op_id: crypto.randomUUID(), task_id: taskId, amount: '10.000' }, drv.access_token);
  // delivery with a recipient phone: the driver enters the recipient's PIN before completing
  const pin = (await page.evaluate(async (id) => (await (await fetch(`/api/v1/delivery/tasks/${id}`)).json()).link.pin, taskId));
  await j('/v1/driver/sync', { ops: [{ type: 'pod', method: 'pin', pin, client_op_id: crypto.randomUUID(), task_id: taskId, occurred_at: new Date().toISOString() }] }, drv.access_token);
  await status('completed');

  await page.goto(`${WEB}/tasks/${taskId}`);
  await page.locator('.badge:has-text("مكتملة")').first().waitFor();
  await page.click('button:has-text("اعتماد المراجعة")');
  await page.locator('h1 + .badge:has-text("مراجَعة")').waitFor();
  await page.locator('.timeline li:has-text("قيد التنفيذ")').waitFor();
  ok('السائق ينفّذ المهمة والمكتب يعتمد مراجعتها، والسجل يعرض كل المراحل');
  await shot(page, '06-task-reviewed');

  // A second task is canceled with a reason
  const t2 = await page.evaluate(async (le) => (await (await fetch('/api/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fp-csrf': '1' },
    body: JSON.stringify({ legal_entity_id: le, sector_pack: 'delivery@1', ref: 'WEB-002' }) })).json()).id, (await page.evaluate(async () => (await fetch('/api/v1/me')).json())).legal_entities[0].id);
  await page.goto(`${WEB}/tasks/${t2}`);
  await page.click('button:has-text("إلغاء المهمة")');
  await page.fill('textarea[name=reason]', 'طلب العميل الإلغاء');
  await page.click('button:has-text("تأكيد الإلغاء")');
  await page.locator('.badge:has-text("ملغاة")').first().waitFor();
  await page.locator('.timeline li:has-text("طلب العميل الإلغاء")').waitFor();
  ok('إلغاء مهمة بسبب يظهر في السجل');

  // Billing: invoice from the reviewed task, a manual line, issue
  await page.click('nav a:has-text("الفواتير")');
  await page.click('button:has-text("فاتورة جديدة")');
  await page.locator('.modal select[name=customer_id] option:has-text("متجر الورد")').waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'متجر الورد' });
  await page.click('.modal button:has-text("إنشاء المسودة")');
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}/);
  await page.locator('td:has-text("WEB-001")').waitFor();
  await page.fill('input[name=description]', 'رسوم انتظار');
  await page.fill('input[name=unit_price]', '0.500');
  await page.click('button:has-text("إضافة")');
  await page.locator('strong.num:has-text("2.000 KWD")').waitFor();
  await page.click('button:has-text("إصدار الفاتورة")');
  await page.locator('.badge:has-text("صادرة")').waitFor();
  const number = (await page.locator('h1').textContent()).trim();
  if (!/^INV-\d{4}-\d+/.test(number)) throw new Error(`unexpected invoice number ${number}`);
  ok(`فاتورة من المهمة المراجَعة + بند يدوي، وإصدارها برقم ${number}`);
  await shot(page, '07-invoice');

  // Payment for the invoice → paid; statement closes at zero
  await page.click('a:has-text("تسجيل دفعة لهذه الفاتورة")');
  await page.fill('.modal input[name=amount]', '2.000');
  await page.fill('.modal input[name=reference]', 'TRX-1001');
  await page.click('.modal button:has-text("تسجيل")');
  await page.locator('td:has-text("TRX-1001")').waitFor();
  await page.goto(page.url().replace(/receivables.*/, 'invoices'));
  await page.locator('tr:has-text("متجر الورد") .badge:has-text("مدفوعة")').waitFor();
  await page.click('nav a:has-text("الذمم والتحصيل")');
  await page.locator('text=لا توجد ذمم مفتوحة').waitFor();
  await page.click('button[role=tab]:has-text("كشف حساب")');
  await page.selectOption('select[name=customer_id]', { label: 'متجر الورد' });
  await page.locator('tr:has-text("الرصيد الختامي") td.num:has-text("0.000 KWD")').waitFor();
  ok('الدفعة تسدد الفاتورة، ولا ذمم مفتوحة، وكشف الحساب يُقفل على صفر');

  // Cash on delivery: the driver hands in the cash, the merchant is paid out
  await page.click('button[role=tab]:has-text("التحصيل عند الاستلام")');
  await page.locator('tr:has-text("سالم السائق"):has-text("10.000 KWD") button').click();
  await page.click('.modal button:has-text("تأكيد")');
  await page.locator('text=لا يوجد نقد غير مسلَّم').waitFor();
  await page.locator('tr:has-text("متجر الورد"):has-text("10.000 KWD") button').click();
  await page.fill('.modal input[name=reference]', 'PAYOUT-1');
  await page.click('.modal button:has-text("تأكيد")');
  await page.locator('text=لا يوجد مستحق').waitFor();
  ok('دورة التحصيل عند الاستلام: من السائق إلى المكتب ثم إلى التاجر');

  await page.click('button[role=tab]:has-text("ميزان المراجعة")');
  await page.locator('tr:has-text("الإجمالي") td.num').first().waitFor();
  const totals = await page.locator('tr:has-text("الإجمالي") td.num').allTextContents();
  if (totals.length !== 2 || totals[0] !== totals[1]) throw new Error(`trial balance not balanced: ${totals}`);
  ok(`ميزان المراجعة متوازن (${totals[0]})`);
  await shot(page, '08-trial-balance');

  // Reports: tasks by day, CSV export
  await page.click('nav a:has-text("التقارير")');
  await page.locator('tbody tr').first().waitFor();
  const csv = await page.evaluate(async (href) => { const r = await fetch(href); return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), body: await r.text() }; },
    await page.locator('a:has-text("تنزيل CSV")').getAttribute('href'));
  if (csv.status !== 200 || !csv.type?.includes('text/csv') || !csv.disp?.includes('attachment') || !csv.body.includes('completed')) throw new Error(`csv export failed: ${JSON.stringify(csv).slice(0, 200)}`);
  await page.click('button[role=tab]:has-text("تكاليف التشغيل")');
  await page.locator('td:has-text("12-34567")').waitFor();
  ok('التقارير: المهام حسب اليوم وتصدير CSV وتكاليف المركبة');
  await shot(page, '09-reports');

  // Settings: invoice prefix, and a customer-portal user for the merchant
  await page.click('nav a:has-text("الإعدادات")');
  await page.fill('input[name=invoice_prefix]', 'WRD');
  await page.click('button:has-text("حفظ")');
  await page.locator('text=تم الحفظ').waitFor();
  await page.click('button[role=tab]:has-text("المستخدمون")');
  await page.click('button:has-text("إضافة مستخدم")');
  const portalPhone = `+9659${String(Date.now()).slice(-7)}`;
  await page.fill('.modal input[name=phone]', portalPhone);
  await page.fill('.modal input[name=display_name]', 'موظف متجر الورد');
  await page.selectOption('.modal select[name=role_code]', 'customer');
  await page.locator('.modal select[name=customer_id] option:has-text("متجر الورد")').waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'متجر الورد' });
  await page.click('.modal button:has-text("إضافة")');
  await page.locator('td:has-text("موظف متجر الورد")').waitFor();
  ok('الإعدادات: بادئة الفواتير ومستخدم لبوابة العملاء');
  await shot(page, '10-settings');

  // The merchant logs in: only the portal, their own task, and a new request
  await page.click('button:has-text("خروج")');
  await page.waitForURL(/\/login/);
  await page.fill('input[name=phone]', portalPhone);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.waitForURL(/\/portal$/);
  await page.locator('td:has-text("WEB-001")').waitFor();
  if (await page.locator('nav a:has-text("الفواتير")').count()) throw new Error('portal user sees staff navigation');
  const staffApi = await page.evaluate(async () => (await fetch('/api/v1/tasks')).status);
  if (staffApi !== 403) throw new Error(`portal user reached staff API: ${staffApi}`);
  await page.click('button:has-text("طلب جديد")');
  await page.fill('.modal input[name=ref]', 'WRD-77');
  await page.fill('.modal input[name=address]', 'حولي، شارع تونس');
  await page.click('.modal button:has-text("إرسال الطلب")');
  await page.locator('td:has-text("WRD-77")').waitFor();
  ok('بوابة العميل: يرى مهامه فقط، ولا يصل لواجهات الموظفين، ويرسل طلبًا جديدًا');
  await shot(page, '11-portal');

  // Logout clears the session
  await page.click('button:has-text("خروج")');
  await page.waitForURL(/\/login/);
  const after = await page.evaluate(async () => (await fetch('/api/v1/me')).status);
  if (after !== 401) throw new Error(`after logout /me returned ${after}`);
  ok('الخروج ينهي الجلسة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`PASS ${step} steps`);
} catch (e) {
  await shot(page, 'failure');
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
