// Browser test of the e-commerce pack: a courier company sets up an online store as a customer, gives it an API key,
// the store sends an order through its API, the office imports more from pasted lines, cancels one, and checks the
// store's exceptions and statement.
// Run: node e2e/ecommerce.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
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
  await page.fill('input[name=phone]', `+9656${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'شحن المتاجر التجريبية');
  await page.check('input[name=pack-ecommerce]');
  await page.check('input[name=pack-courier]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  await page.locator('nav a:has-text("طلبات المتاجر")').waitFor();
  const me = await call('GET', '/me');
  await call('POST', '/customers', { legal_entity_id: me.legal_entities[0].id, name: 'متجر العطور' });
  ok('شركة بنشاطي التجارة الإلكترونية والبريد السريع، وعميل هو متجر إلكتروني');

  await page.click('nav a:has-text("طلبات المتاجر")');
  await page.locator('h1:has-text("طلبات المتاجر")').waitFor();
  await page.click('button[role=tab]:text-is("المتاجر والمفاتيح")');
  await page.click('button:has-text("إضافة متجر")');
  await page.locator('[aria-label="عميل المتجر"] option:has-text("متجر العطور")').waitFor({ state: 'attached' });
  await page.selectOption('[aria-label="عميل المتجر"]', { label: 'متجر العطور' });
  await page.fill('.modal input[name=area]', 'الري');
  await page.fill('.modal input[name=phone]', '+96550001111');
  await page.selectOption('.modal select[name=default_service]', 'same_day');
  await page.click('.modal button:has-text("حفظ")');
  await page.locator('[data-testid=stores] tr:has-text("متجر العطور"):has-text("نفس اليوم")').waitFor();
  await page.click('[data-testid=stores] tr:has-text("متجر العطور") button:has-text("مفاتيح API")');
  await page.fill('[aria-label="وصف المفتاح"]', 'Shopify');
  await page.click('.modal button:has-text("إنشاء مفتاح")');
  const key = (await page.locator('[data-testid=new-key] code').textContent()).trim();
  if (!/^fpk_[a-z0-9]{10}_/.test(key)) throw new Error(`unexpected key ${key}`);
  await page.locator(`.modal [data-testid=keys] tr:has-text("${key.slice(0, 15)}")`).waitFor();
  await shot(page, 'e-key');
  await page.click('.modal button[aria-label=إغلاق]');
  ok('المتجر: الاستلام من الري بخدمة نفس اليوم، ومفتاح API يظهر مرة واحدة');

  const res = await fetch(`${API}/v1/ecom/api/orders`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ external_id: 'S-100', recipient: { name: 'مريم', phone: '+96599001122' }, dropoff: { area: 'السالمية', block: '5' }, cod_amount: '12.500', items: [{ name: 'عطر عود', qty: 1 }] }) });
  const o = await res.json();
  if (res.status !== 201 || o.status !== 'confirmed' || !o.awb || !o.tracking_url) throw new Error(`store API: ${res.status} ${JSON.stringify(o)}`);
  await page.click('button[role=tab]:text-is("الطلبات")');
  await page.locator(`[data-testid=ecom-orders] tr:has-text("S-100"):has-text("${o.awb}"):has-text("بانتظار السائق")`).waitFor();
  ok(`المتجر أرسل الطلب S-100 عبر الـ API فصار بوليصة ${o.awb} برابط تتبع`);

  await page.click('button[role=tab]:text-is("إدخال واستيراد")');
  await page.locator('[aria-label="متجر الاستيراد"] option:has-text("متجر العطور")').waitFor({ state: 'attached' });
  await page.selectOption('[aria-label="متجر الاستيراد"]', { label: 'متجر العطور' });
  await page.fill('textarea[name=orders]', [
    'رقم الطلب,الاسم,الهاتف,المنطقة,القطعة,الشارع,المنزل,COD,ملاحظات',
    'S-101,خالد,+96569001122,حولي,3,10,7,5,',
    'S-102,نورة,+96550002233,الجابرية,1,,,,اتصل قبل الوصول',
    'S-100,مريم,+96599001122,السالمية,,,,,',
    'S-103,سعد,,الفروانية,,,,,',
  ].join('\n'));
  await page.click('button:has-text("إنشاء 4 طلب")');
  await page.locator('.kpi:has-text("أُنشئ"):has-text("2")').waitFor();
  await page.locator('.kpi:has-text("مكرر"):has-text("1")').waitFor();
  await page.locator('[data-testid=import-errors] tr:has-text("S-103"):has-text("recipient")').waitFor();
  await shot(page, 'e-import');
  ok('استيراد 4 أسطر: أُنشئ 2، والمكرر لم يُنشأ مرة ثانية، والسطر الناقص ظهر خطؤه');

  await page.click('button[role=tab]:text-is("الطلبات")');
  await page.click('[data-testid=ecom-orders] tr:has-text("S-102") button:has-text("تفاصيل")');
  await page.locator('.modal h2:has-text("الطلب S-102")').waitFor();
  await page.fill('.modal [aria-label="السبب"]', 'طلب المتجر الإلغاء');
  await page.click('.modal button:has-text("إلغاء الطلب")');
  await page.locator('[data-testid=ecom-orders] tr:has-text("S-102"):has-text("ملغى")').waitFor();
  const st = await (await fetch(`${API}/v1/ecom/api/orders/S-102`, { headers: { 'x-api-key': key } })).json();
  if (st.status !== 'canceled') throw new Error(`store sees ${st.status}`);
  ok('إلغاء S-102 من المكتب، والمتجر يراه ملغى عبر الـ API');

  await page.click('button[role=tab]:text-is("الاستثناءات")');
  await page.locator('h2:has-text("مبالغ COD مستحقة للمتاجر")').waitFor();
  await page.click('button[role=tab]:text-is("كشف المتجر")');
  await page.selectOption('[aria-label="متجر الكشف"]', { label: 'متجر العطور' });
  await page.locator('.kpi:has-text("الطلبات"):has-text("3")').waitFor();
  await page.locator('[data-testid=statement] tr:has-text("S-102"):has-text("ملغى")').waitFor();
  await shot(page, 'e-statement');
  ok('الاستثناءات وكشف المتجر: 3 طلبات في الفترة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nفحص التجارة الإلكترونية: ${step} خطوات ناجحة`);
} catch (e) {
  await shot(page, 'e-failure');
  console.error(`✗ بعد الخطوة ${step}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
