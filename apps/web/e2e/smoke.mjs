// Browser smoke test against a running web app (WEB_URL) + API with OTP_DEV_ECHO=1.
// Run: node e2e/smoke.mjs   (uses the preinstalled Playwright; screenshots go to SHOTS_DIR if set)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
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

  // Seed a driver through the same proxy (workers screen comes in W2)
  const me = await page.evaluate(async () => (await fetch('/api/v1/me')).json());
  const w = await page.evaluate(async (le) => (await fetch('/api/v1/workers', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fp-csrf': '1' },
    body: JSON.stringify({ legal_entity_id: le, kind: 'driver', display_name: 'سالم السائق' }),
  })).json(), me.legal_entities[0].id);
  if (!w.id) throw new Error(`worker create failed: ${JSON.stringify(w)}`);

  // 3. Create a task from the form
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
