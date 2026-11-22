// Browser test of the in-house fleet pack: departments, an employee asking for a vehicle from their own page, the department
// manager approving, the fleet office allocating, handing over and taking back the car, the vehicle board, who had the car,
// exceptions, the charge-back per department and the settings.
// Run: node e2e/internal.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// "YYYY-MM-DDTHH:MM" in Kuwait time, hours from now (for datetime-local inputs)
const kwLocal = (h) => new Date(Date.now() + 3 * 3_600_000 + h * 3_600_000).toISOString().slice(0, 16);

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept('تغيّر الموعد'));
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
async function logout() {
  await page.click('button:has-text("خروج")');
  await page.waitForURL(/\/login/);
}

try {
  const owner = `+9655${stamp}`;
  await login(owner);
  await page.fill('input[name=company]', 'شركة النفط الوطنية التجريبية');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const managerPhone = `+9656${stamp}`, empPhone = `+9659${stamp}`;
  const mgr = await call('POST', '/members', { phone: managerPhone, role_code: 'employee', display_name: 'خالد مدير المبيعات' });
  const car = await call('POST', '/assets', { legal_entity_id: le, asset_type: 'car', plate_no: `12-${stamp.slice(-5)}`, odometer_km: 42_000 });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'van', plate_no: `34-${stamp.slice(-5)}`, odometer_km: 80_000 });
  ok('دخول وإنشاء الشركة ومستخدم بدور «موظف» ومركبتين');

  // 1. Departments: create with a manager, then put the employees in it
  await page.goto(`${WEB}/internal`);
  await page.locator('h1:has-text("أسطول الشركة")').waitFor();
  await page.click('button[role=tab]:text-is("الإدارات")');
  await page.fill('input[name=name]', 'المبيعات');
  await page.fill('input[name=cost_center]', 'CC-200');
  await page.locator(`select[name=manager_user_id] option:has-text("خالد مدير المبيعات")`).waitFor({ state: 'attached' });
  await page.selectOption('select[name=manager_user_id]', { label: 'خالد مدير المبيعات' });
  await page.click('button:has-text("إضافة إدارة")');
  await page.locator('[data-testid=departments] tr:has-text("المبيعات"):has-text("CC-200")').waitFor();
  const dept = (await call('GET', '/internal/departments')).data.find((d) => d.name === 'المبيعات');
  await call('POST', '/members', { phone: empPhone, role_code: 'employee', display_name: 'سارة من المبيعات', department_id: dept.id });
  await page.reload();
  await page.click('button[role=tab]:text-is("الإدارات")');
  await page.selectOption('select[aria-label="إدارة خالد مدير المبيعات"]', { label: 'المبيعات' });
  await page.locator('[data-testid=departments] tr:has-text("المبيعات") td.num:text-is("2")').waitFor();
  await shot(page, 'i-departments');
  ok('إدارة المبيعات بمركز تكلفة ومدير، وموظفان فيها');

  // 2. The employee asks for a car from their own page
  await logout();
  await login(empPhone);
  await page.waitForURL(/\/requests$/);
  await page.locator('text=إدارتك: المبيعات').waitFor();
  if (await page.locator('nav a:has-text("لوحة التوزيع")').count()) throw new Error('the employee sees the dispatch board');
  await page.click('button:has-text("طلب مركبة")');
  await page.fill('input[name=purpose]', 'زيارة عميل في الأحمدي');
  await page.fill('input[name=destination]', 'الأحمدي');
  await page.fill('input[name=starts_at]', kwLocal(0.05));
  await page.fill('input[name=ends_at]', kwLocal(3));
  await page.selectOption('select[name=asset_type]', 'car');
  await page.click('button:has-text("إرسال الطلب")');
  await page.locator('.modal .badge:has-text("بانتظار الموافقة")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  const row = page.locator('[data-testid=my-requests] tr:has-text("زيارة عميل في الأحمدي")');
  await row.locator('.badge:has-text("بانتظار الموافقة")').waitFor();
  const ref = (await row.locator('button.link').textContent()).trim();
  await shot(page, 'i-employee');
  ok(`الموظفة تطلب سيارة من صفحتها (${ref}) فيذهب لموافقة المدير`);

  // 3. The manager approves
  await logout();
  await login(managerPhone);
  await page.waitForURL(/\/requests$/);
  await page.click(`[data-testid=to-approve] button:has-text("${ref}")`);
  await page.fill('.modal input[aria-label="ملاحظة القرار"]', 'موافق');
  await page.click('.modal button:has-text("موافقة")');
  await page.locator('.modal .badge:has-text("موافق عليه")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  ok('مدير الإدارة يوافق من صفحته');

  // 4. The fleet office allocates the car and hands over the key
  await logout();
  await login(owner);
  await page.waitForURL(`${WEB}/`);
  await page.goto(`${WEB}/internal`);
  await page.click('button[role=tab]:has-text("الطلبات")');
  await page.click(`[data-testid=vr-list] button:has-text("${ref}")`);
  await page.locator('.modal h3:has-text("تخصيص مركبة")').waitFor();
  await page.locator(`.modal select[name=asset_id] option:has-text("${car.plate_no}")`).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', car.id);
  await page.click('.modal button:has-text("تخصيص")');
  await page.locator('.modal .badge:has-text("خُصصت مركبة")').waitFor();
  await page.fill('.modal input[name=odometer_km]', '41000');
  await page.click('.modal button:has-text("تسليم")');
  await page.locator('.modal .alert:has-text("odometer")').waitFor();
  await page.fill('.modal input[name=odometer_km]', '42015');
  await page.selectOption('.modal select[name=fuel]', '6');
  await page.fill('.modal input[name=note]', 'خدش بسيط بالصدام');
  await page.click('.modal button:has-text("تسليم")');
  await page.locator('.modal .badge:has-text("المركبة مع الموظف")').waitFor();
  await shot(page, 'i-handover');
  await page.click('.modal button[aria-label=إغلاق]');
  ok('المكتب يخصص السيارة ويسلّم المفتاح بالعدّاد والوقود (ويرفض عدّادًا أقل من السابق)');

  // 5. The vehicle board and who had the car
  await page.click('button[role=tab]:has-text("المركبات اليوم")');
  await page.locator(`[data-testid=vehicle-board] tr:has-text("${car.plate_no}") .badge:has-text("في مشوار")`).waitFor();
  await page.locator(`[data-testid=vehicle-board] tr:has-text("${car.plate_no}"):has-text("سارة من المبيعات")`).waitFor();
  await shot(page, 'i-board');
  await page.click('button[role=tab]:has-text("من كان يقود؟")');
  await page.selectOption('select[name=asset_id]', car.id);
  await page.fill('input[name=at]', kwLocal(0.02));
  await page.click('button:has-text("بحث")');
  await page.locator(`[data-testid=who-result]:has-text("${ref}"):has-text("سارة من المبيعات")`).waitFor();
  ok('لوحة المركبات تُظهر السيارة في مشوار، والبحث عن المخالفة يجد الموظفة');

  // 6. Fuel on the trip, then the car comes back
  await call('POST', '/expenses', { category: 'fuel', amount: '3.000', liters: 20, asset_id: car.id });
  await page.click('button[role=tab]:has-text("الطلبات")');
  await page.click(`[data-testid=vr-list] button:has-text("${ref}")`);
  await page.fill('.modal input[name=odometer_km]', '42095');
  await page.selectOption('.modal select[name=fuel]', '4');
  await page.click('.modal button:has-text("استلام")');
  await page.locator('.modal .badge:has-text("أُرجعت")').waitFor();
  await page.locator('.modal dd:has-text("80 كم")').waitFor();
  await page.click('.modal button[aria-label=إغلاق]');
  ok('الإرجاع: 80 كم، والسيارة متاحة من جديد');

  // 7. Charge-back per department
  await page.click('button[role=tab]:has-text("التكلفة على الإدارات")');
  // 80 km × 0.100 (default) = 8.000 + 3.000 fuel = 11.000
  await page.locator('[data-testid=costs] tr:has-text("المبيعات"):has-text("CC-200"):has-text("11.000 KWD")').waitFor();
  await shot(page, 'i-costs');
  ok('تحميل التكلفة: 80 كم × 0.100 + وقود 3.000 = 11.000 د.ك على المبيعات');

  // 8. Exceptions: a request for the next hour still waiting for the manager
  await call('POST', '/internal/requests', { purpose: 'عاجل', starts_at: new Date(Date.now() + 3_600_000).toISOString(), ends_at: new Date(Date.now() + 7_200_000).toISOString(), department_id: dept.id });
  await page.click('button[role=tab]:has-text("الاستثناءات")');
  await page.locator('section:has(h2:has-text("تنتظر قرار مدير الإدارة")) tr:has-text("المبيعات")').waitFor();
  await shot(page, 'i-exceptions');
  ok('الاستثناءات: طلب يبدأ خلال ساعة وما زال ينتظر قرار المدير');

  // 9. Settings
  await page.click('button[role=tab]:has-text("الإعدادات")');
  await page.locator('label:has-text("سعر الكيلومتر") input').fill('0.150');
  await page.locator('label:has-text("اعتماد تلقائي") input').fill('2');
  await page.click('button:has-text("حفظ")');
  await page.locator('.alert:has-text("حُفظت الإعدادات")').waitFor();
  ok('حفظ الإعدادات: سعر الكيلومتر والاعتماد التلقائي للمشاوير القصيرة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(page, 'i-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
