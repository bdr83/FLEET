// Browser test of the school transport pack: a company adds an afternoon route home from a school (stops, bus, driver
// and attendant), pastes the students, records a guardian's absence notice, generates the day's trip, records a student
// boarded then handed to a named adult from the office, and checks the exceptions and the report.
// Run: node e2e/school.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
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
  await page.fill('input[name=phone]', `+9659${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'باصات المدارس التجريبية');
  await page.check('input[name=pack-school]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("النقل المدرسي")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/customers', { legal_entity_id: le, name: 'مدرسة النور الخاصة', kind: 'business' });
  await call('POST', '/assets', { legal_entity_id: le, asset_type: 'bus', plate_no: `55-${stamp.slice(-5)}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'أبو فهد', phone: `+9656${stamp}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'supervisor', display_name: 'أم سارة', phone: `+9655${stamp}` });
  ok('شركة بنشاط النقل المدرسي، مع مدرسة وحافلة وسائق ومشرفة');

  await page.click('nav a:has-text("النقل المدرسي")');
  await page.locator('h1:has-text("النقل المدرسي")').waitFor();
  await page.click('button[role=tab]:text-is("الخطوط والطلاب")');
  await page.click('button:has-text("إضافة خط")');
  await page.locator('.modal select[name=customer_id] option:has-text("مدرسة النور")').waitFor({ state: 'attached' });
  await page.fill('.modal input[name=code]', 'N1');
  await page.fill('.modal input[name=name]', 'النور ← الجابرية ومشرف');
  await page.fill('.modal input[name=school_name]', 'مدرسة النور');
  await page.selectOption('.modal select[name=customer_id]', { label: 'مدرسة النور الخاصة' });
  await page.selectOption('.modal select[name=direction]', 'from_school');
  await page.fill('.modal input[name=depart_time]', '13:00');
  await page.fill('.modal input[name=capacity]', '24');
  for (const n of [1, 2, 3, 4, 5, 6, 7]) { const c = page.locator('.modal fieldset input[type=checkbox]').nth(n - 1); if (!(await c.isChecked())) await c.check(); }
  await page.fill('.modal [aria-label=المحطات]', '0 | مدرسة النور | السالمية\n15 | الجابرية ق 5\n30 | مشرف ق 3');
  await page.locator('.modal select[name=asset_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=asset_id]', { index: 1 });
  await page.selectOption('.modal select[name=driver_worker_id]', { label: 'أبو فهد' });
  await page.selectOption('.modal select[name=attendant_worker_id]', { label: 'أم سارة' });
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('[data-testid=routes] tr:has-text("N1"):has-text("إلى البيوت"):has-text("مدرسة النور"):has-text("أم سارة")').waitFor();
  ok('خط عودة من المدرسة بثلاث محطات وحافلة وسائق ومشرفة');

  await page.click('[data-testid=routes] tr:has-text("N1") button:has-text("الطلاب")');
  await page.fill('.modal [aria-label=الطلاب]', 'سارة,KG2,2,+96599001111,أم سارة\nعبدالله,6,2,+96599002222\nنورة,8,3,+96599003333');
  await page.click('.modal button:has-text("إضافة الطلاب")');
  await page.locator('[data-testid=students-result]:has-text("أُضيف 3")').waitFor();
  await page.locator('.modal [data-testid=students] tr:has-text("سارة") input[type=checkbox]:checked').waitFor();
  await page.locator('.modal [data-testid=students] tr:has-text("نورة"):has-text("مشرف ق 3")').waitFor();
  await shot(page, 'sc-students');
  await page.click('.modal button[aria-label=إغلاق]');
  await page.locator('[data-testid=routes] tr:has-text("N1") td.num:text-is("3 / 24")').waitFor();
  ok('لصق 3 طلاب بهواتف أولياء الأمور؛ طالبة الروضة تُسلَّم لبالغ تلقائيًا');

  const day = kwDay(1);
  await page.click('button[role=tab]:text-is("بلاغات الغياب")');
  await page.fill('[aria-label="يوم الغياب"]', day);
  await page.locator('[aria-label="خط الطالب"] option:has-text("N1")').waitFor({ state: 'attached' });
  await page.selectOption('[aria-label="خط الطالب"]', { index: 1 });
  await page.locator('[aria-label=الطالب] option:has-text("نورة")').waitFor({ state: 'attached' });
  await page.selectOption('[aria-label=الطالب]', { label: 'نورة' });
  await page.selectOption('select[name=scope]', 'from_school');
  await page.fill('input[name=note]', 'موعد طبيب');
  await page.click('button:has-text("تسجيل الغياب")');
  await page.locator('[data-testid=absences] tr:has-text("نورة"):has-text("العودة فقط"):has-text("ولي الأمر")').waitFor();
  ok(`ولي أمر نورة يبلغ بغيابها عن رحلة العودة يوم ${day}`);

  await page.click('button[role=tab]:text-is("رحلات اليوم")');
  await page.fill('[aria-label="يوم الرحلات"]', day);
  await page.click('button:has-text("توليد رحلات اليوم")');
  await page.locator('[data-testid=gen-result]:has-text("أُنشئ 1")').waitFor();
  await page.locator('[data-testid=trips] tr:has-text("N1"):has-text("13:00"):has-text("مسندة"):has-text("أم سارة")').waitFor();
  await page.click('[data-testid=trips] tr:has-text("N1") button:has-text("الطلاب")');
  await page.locator('.modal [data-testid=manifest-3] tr:has-text("نورة"):has-text("بلّغ بالغياب")').waitFor();
  await page.click('.modal [aria-label="صعد سارة"]');
  await page.locator('.modal [data-testid=manifest-2] tr:has-text("سارة"):has-text("في الحافلة")').waitFor();
  await page.click('.modal [aria-label="نزل سارة"]');
  await page.fill('.modal [aria-label="اسم المستلم"]', 'أم سارة');
  await page.click('.modal button:has-text("تم التسليم")');
  await page.locator('.modal [data-testid=manifest-2] tr:has-text("سارة"):has-text("نزل"):has-text("استلمه أم سارة")').waitFor();
  await page.locator('.modal [data-testid=trip-count]:has-text("في الحافلة 0"):has-text("نزل 1")').waitFor();
  await shot(page, 'sc-manifest');
  await page.click('.modal button[aria-label=إغلاق]');
  ok('رحلة الغد: نورة «بلّغ بالغياب»، والمكتب يسجل صعود سارة ثم تسليمها لأمها باسمها');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.fill('input[type=date]', day);
  await page.locator('h2:has-text("طلاب ما زالوا مسجّلين")').waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', day);
  await page.locator('[data-testid=sc-report] tr:has-text("مدرسة النور"):has-text("مدرسة النور الخاصة")').waitFor();
  await shot(page, 'sc-report');
  ok('الاستثناءات والتقرير لكل مدرسة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص النقل المدرسي: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'sc-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
