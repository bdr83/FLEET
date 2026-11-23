// Browser test of the security pack: a guarding company with a guard and a customer; a site with patrol times and two
// checkpoints with their tags; the day's patrol generated; the office records a checkpoint scanned and one skipped; an
// incident recorded and closed; exceptions and the report.
// Run: node e2e/security.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const SHOTS = process.env.SHOTS_DIR;
const stamp = String(Date.now()).slice(-7);
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
// the patrol time ten minutes ago, Kuwait time
const slot = new Date(Date.now() + 3 * 3_600_000 - 10 * 60_000).toISOString().slice(11, 16);
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
  await page.fill('input[name=company]', 'حراسات تجريبية');
  await page.check('input[name=pack-security]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("الحراسة والدوريات")').waitFor();
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  const cu = await call('POST', '/customers', { legal_entity_id: le, name: 'مجمع الأفنيوز' });
  const g = await call('POST', '/workers', { legal_entity_id: le, kind: 'guard', display_name: 'الحارس سالم', phone: `+9656${stamp}` });
  if (!g.id || !cu.id) throw new Error(JSON.stringify(g));
  ok('شركة حراسة بحارس وعميل');

  await page.click('nav a:has-text("الحراسة والدوريات")');
  await page.locator('h1:has-text("الحراسة والدوريات")').waitFor();
  await page.click('button[role=tab]:text-is("المواقع ونقاط التفتيش")');
  await page.click('button:has-text("إضافة موقع")');
  await page.fill('.modal input[name=code]', 'AVN');
  await page.fill('.modal input[name=name]', 'الأفنيوز: المواقف');
  await page.locator('.modal select[name=customer_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=customer_id]', { label: 'مجمع الأفنيوز' });
  await page.fill('.modal input[name=area]', 'الري');
  await page.fill('.modal input[aria-label="مواعيد الجولات"]', `${slot} 23:30`);
  await page.fill('.modal input[name=duration]', '120');
  await page.locator('.modal select[name=guard_worker_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('.modal select[name=guard_worker_id]', { label: 'الحارس سالم' });
  await page.fill('.modal input[name=instructions]', 'تأكد من إغلاق باب المخزن');
  await page.click('.modal button:has-text("حفظ")');
  await page.locator(`[data-testid=sc-sites] tr:has-text("AVN"):has-text("${slot}"):has-text("الحارس سالم")`).waitFor();
  ok(`موقع AVN بجولتين (${slot} و23:30) والحارس`);

  await page.click('[data-testid=sc-sites] tr:has-text("AVN") button:has-text("النقاط")');
  for (const [name, tag] of [['البوابة الرئيسية', 'cp-gate'], ['المخزن', 'CP-STORE']]) {
    await page.fill('.modal input[name=name]', name);
    await page.fill('.modal input[name=tag]', tag);
    await page.click('.modal button:has-text("إضافة النقطة")');
    await page.locator(`.modal [data-testid=sc-checkpoints] tr:has-text("${name}")`).waitFor();
  }
  await page.locator('.modal [data-testid=sc-checkpoints] tr:has-text("CP-GATE")').waitFor();
  ok('نقطتا تفتيش برمزيهما (الرمز يُحفظ بأحرف كبيرة)');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.click('button[role=tab]:text-is("جولات اليوم")');
  await page.click('button:has-text("توليد جولات اليوم")');
  await page.locator('[data-testid=gen-result]:has-text("أُنشئ")').waitFor();
  await page.locator(`[data-testid=patrols] tr:has-text("${slot}"):has-text("0 / 2")`).waitFor();
  await page.click(`[data-testid=patrols] tr:has-text("${slot}") button:has-text("فتح")`);
  await page.click('.modal button[aria-label="مُسحت البوابة الرئيسية"]');
  await page.locator('.modal [data-testid=patrol-sheet] tr:has-text("البوابة الرئيسية"):has-text("مُسحت")').waitFor();
  await page.selectOption('.modal select[aria-label="لم تُفحص المخزن"]', 'locked');
  await page.locator('.modal [data-testid=patrol-sheet] tr:has-text("المخزن"):has-text("مقفلة")').waitFor();
  await shot(page, 'sc-patrol');
  ok('جولة اليوم مولّدة؛ المكتب يسجّل البوابة ممسوحة والمخزن مقفلًا');

  await page.click('.modal button[aria-label=إغلاق]');
  await page.click('button[role=tab]:text-is("الحوادث")');
  await page.locator('select[name=site_id] option').nth(1).waitFor({ state: 'attached' });
  await page.selectOption('select[name=site_id]', { index: 1 });
  await page.selectOption('select[name=category]', 'damage');
  await page.selectOption('select[name=severity]', 'high');
  await page.fill('input[name=description]', 'إنارة المواقف معطلة');
  await page.click('button:has-text("تسجيل")');
  await page.locator('[data-testid=incidents] tr:has-text("IN-1"):has-text("إنارة المواقف معطلة"):has-text("مفتوح")').waitFor();
  await page.click('[data-testid=incidents] tr:has-text("IN-1") button:has-text("إغلاق")');
  await page.fill('input[aria-label="ملاحظة الإغلاق"]', 'أُبلغت إدارة المجمع وأُصلحت');
  await page.click('button:has-text("إغلاق الحادث")');
  await page.click('label:has-text("المفتوحة فقط") input');
  await page.locator('[data-testid=incidents] tr:has-text("IN-1"):has-text("مغلق"):has-text("أُبلغت إدارة المجمع")').waitFor();
  await shot(page, 'sc-incidents');
  ok('حادث IN-1 عالي الخطورة من المكتب، ثم إغلاقه بملاحظة');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('[data-testid=ex-skipped] tr:has-text("المخزن"):has-text("مقفلة")').waitFor();
  ok('الاستثناءات: نقطة المخزن لم تُفحص لأنها مقفلة');

  await page.click('button[role=tab]:text-is("التقرير")');
  await page.fill('input[type=date] >> nth=1', kwDay(1));
  await page.locator('[data-testid=sc-report-sites] tr:has-text("AVN"):has-text("25%")').waitFor();
  await page.locator('[data-testid=sc-report-categories] tr:has-text("ضرر أو عطل")').waitFor();
  await shot(page, 'sc-report');
  ok('التقرير: تغطية الموقع AVN 25% (نقطة من 4 في جولتين)، والحوادث حسب النوع');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص الحراسة والدوريات: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'sc-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
