// Browser test of the technical maintenance pack: a company opens an urgent AC job for a new customer, books a technician,
// records the visit from the job card (needs another visit), books and records a second visit (fixed), closes the job with
// the amounts, adds a preventive plan and creates its jobs, and checks the exceptions and the report.
// Run: node e2e/service.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'الصيانة الفنية التجريبية');
  await page.check('input[name=pack-service]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الصيانة الفنية")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فني التكييف', phone: `+9656${stamp}` });
  await call('POST', '/workers', { legal_entity_id: le, kind: 'driver', display_name: 'فني الكمبروسرات', phone: `+9659${stamp}` });
  ok('شركة بنشاط الصيانة الفنية، مع فنيين');

  await page.click('nav a:has-text("الصيانة الفنية")');
  await page.locator('h1:has-text("الصيانة الفنية")').waitFor();
  await page.click('button:has-text("بلاغ جديد")');
  await page.selectOption('.modal select[name=customer_id]', 'new');
  await page.fill('.modal input[name=new_name]', 'أم عبدالله');
  await page.fill('.modal input[name=site_name]', 'فيلا 12');
  await page.fill('.modal input[name=area]', 'مشرف');
  await page.fill('.modal input[name=block]', '3');
  await page.fill('.modal input[name=phone]', '+96550002222');
  await page.selectOption('.modal select[name=priority]', 'urgent');
  await page.fill('.modal textarea[name=problem]', 'المكيف لا يبرد');
  await page.fill('.modal input[name=brand]', 'Gree');
  await page.click('.modal button:has-text("فتح البلاغ")');
  await page.locator('[data-testid=jobs] tr:has-text("أم عبدالله"):has-text("عاجل"):has-text("بانتظار فني")').waitFor();
  ok('بلاغ عاجل لعميل جديد: موعد الاستجابة 4 ساعات، بانتظار فني');

  await page.click('[data-testid=jobs] tr:has-text("أم عبدالله") button:has-text("إدارة")');
  await page.selectOption('.modal select[name=tech]', { label: 'فني التكييف' });
  await page.click('.modal button:has-text("حجز الزيارة")');
  await page.locator('.modal [data-testid=visits] tr:has-text("فني التكييف"):has-text("مسندة")').waitFor();
  await page.selectOption('.modal select[name=result]', 'follow_up');
  await page.fill('.modal input[name=work_done]', 'الكمبروسر يحتاج تبديل');
  await page.fill('.modal input[name=signed_by]', 'أم عبدالله');
  await page.fill('.modal input[name=part]', 'فريون R410');
  await page.click('.modal button:has-text("حفظ الزيارة")');
  await page.locator('.modal [data-testid=visits] tr:has-text("زيارة أخرى"):has-text("فريون R410 × 1")').waitFor();
  await page.locator('.modal .badge:has-text("يحتاج زيارة أخرى")').waitFor();
  ok('زيارة أولى مسجّلة من بطاقة العمل: تحتاج زيارة أخرى، مع القطعة المستخدمة');

  await page.selectOption('.modal select[name=tech]', { label: 'فني الكمبروسرات' });
  await page.click('.modal button:has-text("حجز الزيارة")');
  await page.locator('.modal [data-testid=visits] tr:has-text("فني الكمبروسرات")').waitFor();
  await page.selectOption('.modal select[name=result]', 'fixed');
  await page.fill('.modal input[name=work_done]', 'تبديل الكمبروسر');
  await page.fill('.modal input[name=part]', 'كمبروسر');
  await page.click('.modal button:has-text("حفظ الزيارة")');
  await page.locator('.modal .badge:has-text("جاهز للإغلاق")').waitFor();
  await page.fill('.modal input[name=labour]', '15');
  await page.fill('.modal input[name=parts_amount]', '85.500');
  await page.click('.modal button:has-text("إغلاق البلاغ")');
  await page.locator('.modal dd:has-text("تم الإصلاح"):has-text("100.500 KWD")').waitFor();
  await shot(page, 'sv-job');
  ok('زيارة ثانية: تم الإصلاح، وأُغلق البلاغ بعمالة 15 وقطع 85.500');

  await page.click('.modal button[aria-label="إغلاق"]');
  await page.click('button[role=tab]:text-is("الصيانة الدورية")');
  await page.selectOption('select[name=customer_id]', { label: 'أم عبدالله' });
  await page.fill('input[name=name]', 'تنظيف المكيفات');
  await page.fill('input[name=area]', 'مشرف');
  await page.fill('input[name=every_days]', '30');
  await page.fill('input[name=first_due]', kwDay(2));
  await page.click('button:has-text("حفظ العقد")');
  await page.locator('[data-testid=plans] tr:has-text("تنظيف المكيفات"):has-text("30 يوم")').waitFor();
  await page.click('button:has-text("إنشاء بلاغات الأسبوع القادم")');
  await page.locator('[data-testid=generated]:has-text("أُنشئ 1 بلاغ: WO-2")').waitFor();
  ok('عقد صيانة دورية كل 30 يومًا، وإنشاء بلاغ الأسبوع القادم');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-unassigned] tr:has-text("صيانة دورية: تنظيف المكيفات")').waitFor();
  await page.click('button[role=tab]:text-is("التقرير")');
  await page.locator('[data-testid=sv-techs] tr:has-text("فني الكمبروسرات")').waitFor();
  await page.locator('[data-testid=sv-cats] tr:has-text("تكييف")').waitFor();
  await shot(page, 'sv-report');
  ok('الاستثناءات (البلاغ الدوري بلا فني) والتقرير حسب الفني والتخصص');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص الصيانة الفنية: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'sv-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
