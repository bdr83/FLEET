// Browser test of the cold-chain pack: a company with only this pack, a chilled route with delivery windows and an item
// expiring today, a logger reading out of range, the driver's reading and a delivery with damaged goods (simulated by API
// calls), the exceptions and the KPIs.
// Run: node e2e/coldchain.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
async function apiCall(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-fp-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);

try {
  const owner = `+9655${stamp}`;
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.click('button:has-text("الدخول برقم الجوال")');
  await page.fill('input[name=phone]', owner);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'مبردات الخليج');
  await page.check('input[name=pack-coldchain]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("سلسلة التبريد")').waitFor();
  await page.locator('nav a:has-text("التوزيع اليومي")').waitFor();
  if (await page.locator('nav a:has-text("الشحن والنقل")').count()) throw new Error('a pack that is off shows in the menu');
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const truck = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `RF-${stamp.slice(-5)}` });
  const phone = `+9656${stamp}`;
  const w = await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'سالم سائق المبرد', phone });
  const otp = await apiCall('POST', '/v1/auth/otp/request', { phone });
  const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone, code: otp.dev_code });
  const dtok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
  const sync = async (op) => (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: new Date().toISOString(), ...op }] }, dtok)).results[0];
  ok('شركة بنشاط التبريد فقط: القائمة تُظهر «سلسلة التبريد» و«التوزيع اليومي»، مع شاحنة مبردة وسائق');

  await page.click('nav a:has-text("التوزيع اليومي")');
  await page.click('button[role=tab]:has-text("الأصناف")');
  await page.fill('input[name=sku]', 'CHK');
  await page.fill('input[name=name]', 'دجاج مبرد');
  await page.selectOption('select[name=unit]', 'carton');
  await page.fill('input[name=price]', '1.500');
  await page.click('button:has-text("إضافة صنف")');
  await page.locator('[data-testid=products] tr:has-text("CHK")').waitFor();

  // a chilled route: a stop with an open window, and one whose window has passed with an item expiring today
  await page.click('button[role=tab]:has-text("مسارات اليوم")');
  await page.click('button:has-text("مسار جديد")');
  await page.locator(`.modal select[name=asset_id] option:has-text("${truck.plate_no}")`).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', truck.id);
  await page.locator('.modal select[name=driver_worker_id] option:has-text("سالم")').waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=driver_worker_id]', w.id);
  await page.fill('.modal input[name=start_time]', '00:00');
  await page.fill('.modal input[name=end_time]', '23:59');
  await page.selectOption('.modal select[name=temp_class]', 'chilled');
  await page.fill('[aria-label="اسم التوقف 1"]', 'مطعم الشيف');
  await page.fill('[aria-label="نافذة التوقف 1 من"]', '00:00');
  await page.fill('[aria-label="نافذة التوقف 1 إلى"]', '23:59');
  await page.locator('[aria-label="صنف 1 للتوقف 1"] option:has-text("دجاج")').waitFor({ state: 'attached' });
  await page.selectOption('[aria-label="صنف 1 للتوقف 1"]', 'CHK');
  await page.fill('[aria-label="كمية 1 للتوقف 1"]', '20');
  await page.click('.modal button:has-text("+ توقف")');
  await page.fill('[aria-label="اسم التوقف 2"]', 'جمعية الروضة');
  await page.fill('[aria-label="نافذة التوقف 2 من"]', '00:00');
  await page.fill('[aria-label="نافذة التوقف 2 إلى"]', '00:01');
  await page.selectOption('[aria-label="صنف 1 للتوقف 2"]', 'CHK');
  await page.fill('[aria-label="كمية 1 للتوقف 2"]', '10');
  await page.fill('[aria-label="صلاحية 1 للتوقف 2"]', today);
  await shot(page, 'c-plan');
  await page.click('.modal button:has-text("حفظ المسار")');
  await page.locator('.modal h2:text-matches("المسار DR-\\\\d+")').waitFor();
  await page.locator('.modal :text("النطاق")').waitFor();
  const ref = (await page.locator('.modal h2').textContent()).replace('المسار ', '').trim();
  ok(`مسار مبرد ${ref} (0° إلى 5°) بنافذتي تسليم وصنف صلاحيته اليوم`);

  // a reading from a logger, out of range
  await page.fill('.modal input[name=reading_c]', '7.2');
  await page.fill('.modal input[name=device_ref]', 'LOGGER-17');
  await page.click('.modal button:has-text("تسجيل قراءة")');
  await page.locator('.modal [data-testid=temps] tr:has-text("LOGGER-17") .badge:has-text("خارج النطاق")').waitFor();
  await shot(page, 'c-route');
  await page.click('.modal button[aria-label=إغلاق]');
  ok('قراءة من جهاز التسجيل 7.2° تظهر «خارج النطاق»');

  // the driver: accept, load, leave, a reading, a delivery with damaged goods
  const tasks = (await apiCall('GET', '/v1/driver/tasks', undefined, dtok)).data.filter((t) => t.sector_pack === 'distribution@1');
  const rt = tasks.find((t) => t.attributes.kind === 'route');
  const s1 = tasks.find((t) => t.attributes.name === 'مطعم الشيف');
  if (rt.attributes.temp_class !== 'chilled') throw new Error('route task has no temp class');
  for (const op of [{ type: 'task_status', task_id: rt.id, to_status: 'accepted' }, { type: 'milestone', task_id: rt.id, code: 'load_checked' },
    { type: 'task_status', task_id: rt.id, to_status: 'in_progress' }, { type: 'temp', task_id: rt.id, reading_c: 3.5 },
    { type: 'stop', task_id: s1.id, delivered: { CHK: 18 }, damaged: { CHK: 2 }, received_by: 'الشيف علي' }]) {
    const r = await sync(op);
    if (r.result !== 'applied') throw new Error(`${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  }
  await page.reload();
  await page.locator(`[data-testid=routes] tr:has-text("${ref}") .badge:has-text("3.5°")`).waitFor();
  ok('السائق يسجل 3.5° ويسلّم 18 مع كرتونين تالفين؛ اللوحة تعرض آخر قراءة');

  await page.click('nav a:has-text("سلسلة التبريد")');
  await page.locator('h1:has-text("سلسلة التبريد")').waitFor();
  await page.locator(`[data-testid=ex-temp] tr:has-text("${ref}"):has-text("7.2°"):has-text("LOGGER-17")`).waitFor();
  await page.locator(`[data-testid=ex-late] tr:has-text("جمعية الروضة") .badge:has-text("لم يُسلَّم")`).waitFor();
  await page.locator(`[data-testid=ex-expiry] tr:has-text("جمعية الروضة"):has-text("${today}")`).waitFor();
  await page.locator(`[data-testid=ex-damaged] tr:has-text("مطعم الشيف"):has-text("3.000")`).waitFor();
  if (await page.locator(`[data-testid=ex-late] tr:has-text("مطعم الشيف")`).count()) throw new Error('an on-time stop is listed late');
  await shot(page, 'c-exceptions');
  ok('الاستثناءات: قراءة خارج النطاق، توقف فاتت نافذته، صنف تنتهي صلاحيته، وتالف بقيمة 3.000');

  await page.click('button[role=tab]:has-text("المؤشرات")');
  // delivered 18 × 1.500 = 27.000; damaged 3.000 → spoilage 3 / 30 = 10%; one reading in range of two
  await page.locator(`[data-testid=coldchain-report] tr:has-text("${ref}"):has-text("27.000"):has-text("3.000")`).waitFor();
  await page.locator('.kpi:has-text("نسبة التلف"):has-text("10%")').waitFor();
  await page.locator('.kpi:has-text("قراءات ضمن النطاق"):has-text("50%")').waitFor();
  await shot(page, 'c-report');
  ok('المؤشرات: مسلَّم 27.000، تالف 3.000، نسبة التلف 10%، والقراءات ضمن النطاق 50%');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص سلسلة التبريد: ${step} خطوات ناجحة`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(page, 'c-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
