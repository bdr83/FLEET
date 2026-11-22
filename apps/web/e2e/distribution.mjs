// Browser test of the own-fleet distribution pack: product catalogue, planning a route with stops, the driver's day (simulated
// by API calls: load check, departure, stops with delivered and returned quantities and cash, a closed shop, back at the depot),
// the route's reconciliation, the cash settlement with a variance, exceptions and the distribution report.
// Run: node e2e/distribution.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.goto(`${WEB}/login`);
  await page.fill('input[name=phone]', owner);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'ألبان الخليج');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const truck = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'truck', plate_no: `78-${stamp.slice(-5)}`, odometer_km: 200_000 });
  const phone = `+9656${stamp}`;
  const w = await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'مبارك سائق التوزيع', phone });
  const otp = await apiCall('POST', '/v1/auth/otp/request', { phone });
  const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone, code: otp.dev_code });
  const dtok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
  const sync = async (op) => (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: new Date().toISOString(), ...op }] }, dtok)).results[0];
  ok('دخول وإنشاء شركة توزيع بشاحنة وسائق');

  // 1. Products
  await page.click('nav a:has-text("التوزيع اليومي")');
  await page.locator('h1:has-text("التوزيع اليومي")').waitFor();
  await page.click('button[role=tab]:has-text("الأصناف")');
  for (const [sku, name, unit, price] of [['MLK-1L', 'حليب 1 لتر', 'carton', '0.350'], ['LBN', 'لبن', 'carton', '0.250']]) {
    await page.fill('input[name=sku]', sku);
    await page.fill('input[name=name]', name);
    await page.selectOption('select[name=unit]', unit);
    await page.fill('input[name=price]', price);
    await page.click('button:has-text("إضافة صنف")');
    await page.locator(`[data-testid=products] tr:has-text("${sku}")`).waitFor();
  }
  ok('كتالوج الأصناف: حليب ولبن بالكرتون بأسعارهما');

  // 2. Plan a route with two stops
  await page.click('button[role=tab]:has-text("مسارات اليوم")');
  await page.click('button:has-text("مسار جديد")');
  await page.locator(`.modal select[name=asset_id] option:has-text("${truck.plate_no}")`).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', truck.id);
  await page.locator('.modal select[name=driver_worker_id] option:has-text("مبارك")').waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=driver_worker_id]', w.id);
  await page.fill('.modal input[name=start_time]', '00:00');
  await page.fill('.modal input[name=end_time]', '23:59');
  await page.fill('[aria-label="اسم التوقف 1"]', 'فرع السالمية');
  await page.locator('[aria-label="صنف 1 للتوقف 1"] option:has-text("حليب")').waitFor({ state: 'attached' });
  await page.selectOption('[aria-label="صنف 1 للتوقف 1"]', 'MLK-1L');
  await page.fill('[aria-label="كمية 1 للتوقف 1"]', '20');
  await page.click('[data-testid=stop-1] button:has-text("+ صنف")');
  await page.selectOption('[aria-label="صنف 2 للتوقف 1"]', 'LBN');
  await page.fill('[aria-label="كمية 2 للتوقف 1"]', '10');
  await page.click('.modal button:has-text("+ توقف")');
  await page.fill('[aria-label="اسم التوقف 2"]', 'بقالة الرميثية');
  await page.selectOption('[aria-label="دفع التوقف 2"]', 'cash');
  await page.selectOption('[aria-label="صنف 1 للتوقف 2"]', 'MLK-1L');
  await page.fill('[aria-label="كمية 1 للتوقف 2"]', '10');
  await page.click('.modal button:has-text("+ توقف")');
  await page.fill('[aria-label="اسم التوقف 3"]', 'جمعية حولي');
  await page.selectOption('[aria-label="صنف 1 للتوقف 3"]', 'LBN');
  await page.fill('[aria-label="كمية 1 للتوقف 3"]', '15');
  await shot(page, 'd-plan');
  await page.click('.modal button:has-text("حفظ المسار")');
  await page.locator('.modal h2:text-matches("المسار DR-\\\\d+")').waitFor();
  await page.locator('.modal [data-testid=reconcile] tr:has-text("حليب 1 لتر") td.num:text-is("30")').waitFor();
  const ref = (await page.locator('.modal h2').textContent()).replace('المسار ', '').trim();
  await page.click('.modal button[aria-label=إغلاق]');
  ok(`تخطيط المسار ${ref} بثلاثة توقفات وقائمة تحميل (حليب 30، لبن 25)`);

  // 3. The driver's day (app simulated)
  const tasks = (await apiCall('GET', '/v1/driver/tasks', undefined, dtok)).data.filter((t) => t.sector_pack === 'distribution@1');
  const [rt, s1, s2, s3] = tasks;
  for (const op of [{ type: 'task_status', task_id: rt.id, to_status: 'accepted' }, { type: 'milestone', task_id: rt.id, code: 'load_checked', odometer_km: 200_005 },
    { type: 'task_status', task_id: rt.id, to_status: 'in_progress' },
    { type: 'stop', task_id: s1.id, delivered: { 'MLK-1L': 20, LBN: 8 }, returned: { LBN: 2 }, received_by: 'أمين المخزن' },
    { type: 'stop', task_id: s2.id, delivered: { 'MLK-1L': 10 }, cash_collected: '3.500' },
    { type: 'stop', task_id: s3.id, closed_reason: 'shop_closed' },
    { type: 'milestone', task_id: rt.id, code: 'route_back', odometer_km: 200_062 }, { type: 'task_status', task_id: rt.id, to_status: 'completed' }]) {
    const r = await sync(op);
    if (r.result !== 'applied') throw new Error(`${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  }
  await page.reload();
  await page.locator(`[data-testid=routes] tr:has-text("${ref}") .badge:has-text("بانتظار التسوية")`).waitFor();
  await shot(page, 'd-board');
  ok('يوم السائق: مراجعة الحمولة، الانطلاق، تسليم مع مرتجع، تحصيل نقدي، محل مغلق، العودة بـ 57 كم');

  // 4. The route: stops and reconciliation, then the cash settlement
  await page.click(`[data-testid=routes] button:has-text("${ref}")`);
  await page.locator('.modal [data-testid=stops] tr:has-text("جمعية حولي") .badge:has-text("المحل مغلق")').waitFor();
  // milk 30 loaded, 30 delivered; laban 25 loaded, 8 delivered, 2 returned → 19 back
  await page.locator('.modal [data-testid=reconcile] tr:has-text("لبن") td.num >> nth=3').filter({ hasText: '19' }).waitFor();
  await page.fill('.modal input[name=cash_received]', '3.000');
  await page.locator('.modal .alert.warn:has-text("-0.500")').waitFor();
  await page.fill('.modal input[name=settle_note]', 'نقص نصف دينار');
  await shot(page, 'd-route');
  await page.click('.modal button:has-text("تسوية")');
  await page.locator('.modal .badge:has-text("مُسوّى")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  ok('تفاصيل المسار ومطابقة الحمولة (19 لبن تعود للمستودع)، وتسوية العهدة بفرق ‎-0.500 مع ملاحظة');

  // 5. Exceptions and report
  await page.click('button[role=tab]:has-text("الاستثناءات")');
  await page.locator('section:has(h2:has-text("توقفات تعذّرت")) tr:has-text("جمعية حولي")').waitFor();
  await page.locator('section:has(h2:has-text("مرتجعات")) tr:has-text("فرع السالمية")').waitFor();
  await page.locator('section:has(h2:has-text("فرق عند التسوية")) tr:has-text("مبارك")').waitFor();
  await page.click('button[role=tab]:has-text("تقرير التوزيع")');
  // planned 20×0.350 + 10×0.250 + 10×0.350 + 15×0.250 = 16.750; delivered 7.000 + 2.000 + 3.500 = 12.500; returned 0.500
  await page.locator(`[data-testid=dist-report] tr:has-text("${ref}"):has-text("16.750"):has-text("12.500"):has-text("-0.500")`).waitFor();
  await shot(page, 'd-report');
  ok('الاستثناءات (محل مغلق، مرتجع، فرق تسوية) وتقرير التوزيع: مخطط 16.750 ومسلَّم 12.500');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(page, 'd-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
