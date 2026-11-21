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
  await page.click('nav a:has-text("المركبات")');
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

  // Create a task from the form
  await page.click('nav a:has-text("المهام")');
  await page.locator('h1:has-text("المهام")').waitFor();
  await page.click('button:has-text("مهمة جديدة")');
  await page.fill('input[name=ref]', 'WEB-001');
  await page.fill('input[name=address]', 'السالمية، قطعة 5، شارع 10');
  await page.fill('input[name=recipient_name]', 'أحمد');
  await shot(page, '02-new-task');
  await page.click('.modal button:has-text("إنشاء")');
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  await page.locator('.badge:has-text("جاهزة")').waitFor();
  ok('إنشاء مهمة من النموذج وفتح صفحتها');

  // 4. It shows on the dispatch board queue; assign it from there
  await page.click('nav a:has-text("لوحة التوزيع")');
  await page.locator('td a:has-text("WEB-001")').waitFor();
  await page.locator('tr', { has: page.locator('a:has-text("WEB-001")') }).locator('button:has-text("إسناد")').click();
  await page.selectOption('select[name=worker]', w.id);
  await shot(page, '03-assign');
  await page.click('.modal button.primary:has-text("إسناد")');
  await page.locator('.modal').waitFor({ state: 'detached' });
  await page.locator('text=لا توجد مهام بانتظار سائق').waitFor();
  ok('الإسناد من لوحة التوزيع يُخرج المهمة من القائمة');
  await shot(page, '04-board');

  // 5. Detail page: assigned, then cancel with a reason, timeline grows
  await page.click('nav a:has-text("المهام")');
  await page.click('td a:has-text("WEB-001")');
  await page.locator('.badge:has-text("مسندة")').waitFor();
  await page.locator('dd:has-text("سالم السائق")').waitFor();
  await page.click('button:has-text("إلغاء المهمة")');
  await page.fill('textarea[name=reason]', 'طلب العميل الإلغاء');
  await page.click('button:has-text("تأكيد الإلغاء")');
  await page.locator('.badge:has-text("ملغاة")').first().waitFor();
  await page.locator('.timeline li:has-text("طلب العميل الإلغاء")').waitFor();
  ok('صفحة المهمة: الإلغاء بسبب يظهر في السجل');
  await shot(page, '05-detail');

  // 6. Logout clears the session
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
