// Browser test of the delivery pack: order form, PIN and tracking page, proof approval, import, settings, earnings.
// Run: node e2e/delivery.mjs   (needs the API with OTP_DEV_ECHO=1 on API_URL and the web app on WEB_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

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
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
/** Calls the API through the dashboard's proxy with the logged-in session. */
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api/v1${p}`, { method: m, headers: { 'x-fp-csrf': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);

try {
  await page.goto(`${WEB}/login`);
  await page.click('button:has-text("الدخول برقم الجوال")');
  await page.fill('input[name=phone]', `+9655${stamp}`);
  await page.click('button:has-text("إرسال رمز التحقق")');
  await page.fill('input[name=code]', (await page.locator('.alert.ok .num').textContent()).trim());
  await page.click('button:has-text("دخول")');
  await page.fill('input[name=company]', 'توصيل السريع');
  for (const c of await page.locator('input[name^=pack-]').all()) await c.check();
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL(`${WEB}/`);
  const me = await call('GET', '/me');
  const le = me.legal_entities[0].id;
  ok('دخول وإنشاء شركة توصيل');

  // A courier with the driver app (the app is simulated by API calls)
  const driverPhone = `+9656${stamp}`;
  const worker = await call('POST', '/workers', { legal_entity_id: le, kind: 'courier', display_name: 'سالم العتيبي', phone: driverPhone });
  const otp = await apiCall('POST', '/v1/auth/otp/request', { phone: driverPhone });
  const ver = await apiCall('POST', '/v1/auth/otp/verify', { phone: driverPhone, code: otp.dev_code });
  const dtok = (await apiCall('POST', '/v1/auth/token', { tenant_id: me.tenant_id }, ver.user_token)).access_token;
  const sync = async (op) => (await apiCall('POST', '/v1/driver/sync', { ops: [{ client_op_id: uuid(), occurred_at: new Date().toISOString(), ...op }] }, dtok)).results[0];
  await apiCall('POST', '/v1/driver/shifts', { client_op_id: uuid() }, dtok);
  await apiCall('POST', '/v1/driver/locations', { points: [{ recorded_at: new Date().toISOString(), lat: 29.3341, lng: 48.0745 }] }, dtok);
  ok('مندوب في وردية مع موقع حي');

  // 1. Order form with a structured Kuwaiti address
  await page.click('nav a:has-text("المهام")');
  await page.click('button:has-text("مهمة جديدة")');
  await page.fill('input[name=ref]', `TL-${stamp}`);
  await page.fill('input[name=area]', 'السالمية');
  await page.fill('input[name=block]', '5');
  await page.fill('input[name=street]', 'سالم المبارك');
  await page.fill('input[name=house]', '12');
  await page.fill('input[name=recipient_name]', 'أحمد');
  await page.fill('input[name=recipient_phone]', '50000001');
  await page.fill('input[name=cod_amount]', '7.500');
  await page.fill('input[name=delivery_fee]', '1.250');
  await shot(page, 'd01-order-form');
  await page.click('.modal button:has-text("إنشاء")');
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskId = page.url().split('/').pop();
  await page.locator('dd:has-text("السالمية، ق 5، ش سالم المبارك، م 12")').waitFor();
  await page.locator('dd:has-text("7.500 KWD")').waitFor();
  const pin = (await page.locator('[data-testid=pin]').textContent()).trim();
  if (!/^\d{4}$/.test(pin)) throw new Error(`pin ${pin}`);
  ok('نموذج الطلب بالعنوان الكويتي، ورمز المستلم ظاهر للمكتب');

  // 2. The recipient's page (phone size, no login)
  const href = await page.locator('a:has-text("فتح الصفحة")').getAttribute('href');
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ar-KW' });
  const rec = await phoneCtx.newPage();
  rec.on('pageerror', (e) => errors.push(e.message));
  await rec.goto(`${WEB}${href}`);
  await rec.locator('[data-testid=headline]:has-text("استلمنا طلبك")').waitFor();
  if ((await rec.locator('[data-testid=track-pin]').textContent()).trim() !== pin) throw new Error('pin mismatch on tracking page');
  if ((await rec.content()).includes('50000001')) throw new Error('recipient phone leaked on the public page');
  ok('صفحة التتبع العامة تعرض الحالة والرمز بلا رقم الجوال');

  // 3. Auto-assign from the delivery hub, then the driver picks up and heads out
  await page.click('nav a:has-text("مركز التوصيل")');
  await page.click('button:has-text("إسناد تلقائي")');
  await page.locator('text=أُسندت').waitFor();
  const t = await call('GET', `/tasks/${taskId}`);
  if (t.worker_id !== worker.id) throw new Error('auto-assign did not pick the courier');
  ok('الإسناد التلقائي لأقرب مندوب');

  for (const op of [{ type: 'task_status', to_status: 'accepted' }, { type: 'milestone', code: 'picked_up' }, { type: 'task_status', to_status: 'in_progress' }]) {
    const r = await sync({ task_id: taskId, ...op });
    if (r.result !== 'applied') throw new Error(`${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  }
  await rec.reload();
  await rec.locator('[data-testid=headline]:has-text("في الطريق")').waitFor();
  await rec.getByText('سالم', { exact: true }).waitFor();
  await rec.locator('.track-map path.leaflet-interactive').waitFor();
  await shot(rec, 'd02-track-on-the-way');
  ok('المستلم يرى اسم المندوب الأول وموقعه على الخريطة');

  // 4. Without the PIN the driver cannot complete; a photo proof waits for the office
  if ((await sync({ task_id: taskId, type: 'task_status', to_status: 'completed' })).reason !== 'proof_required') throw new Error('completed without proof');
  await sync({ task_id: taskId, type: 'pod', method: 'photo', file_key: 'pod/door.jpg', recipient_name: 'حارس العمارة' });
  await sync({ task_id: taskId, type: 'task_status', to_status: 'completed' });
  await page.click('button[role=tab]:has-text("الاستثناءات")').catch(() => {});
  await page.reload();
  await page.locator('section:has-text("إثباتات تسليم بانتظار الموافقة") td:has-text("حارس العمارة")').waitFor();
  await shot(page, 'd03-exceptions');
  ok('لوحة الاستثناءات تعرض الإثبات بانتظار الموافقة');

  await page.goto(`${WEB}/tasks/${taskId}`);
  await page.locator('text=بانتظار موافقة المكتب').waitFor();
  await page.click('button:has-text("اعتماد المراجعة")');
  await page.locator('.alert:has-text("approve the proof of delivery first")').waitFor();
  await page.click('button:has-text("قبول الإثبات")');
  await page.locator('.badge:has-text("موثّق")').waitFor();
  await page.click('button:has-text("اعتماد المراجعة")');
  await page.locator('.badge:has-text("مراجَعة")').first().waitFor();
  await shot(page, 'd04-task-delivery');
  await rec.reload();
  await rec.locator('[data-testid=headline]:has-text("تم تسليم طلبك")').waitFor();
  if (await rec.locator('[data-testid=track-pin]').count()) throw new Error('pin still shown after delivery');
  ok('قبول الإثبات ثم الاعتماد، والرمز يختفي من صفحة المستلم');

  // 5. Import from a pasted sheet (one duplicate, one bad row)
  await page.click('nav a:has-text("مركز التوصيل")');
  await page.click('button[role=tab]:has-text("استيراد الطلبات")');
  await page.fill('textarea[name=sheet]', [
    'رقم الطلب,اسم المستلم,جوال المستلم,المنطقة,القطعة,الشارع,الجادة,المنزل,COD,رسم التوصيل,ملاحظات',
    `TL-${stamp},أحمد,50000001,السالمية,5,10,,12,7.500,1.250,`,
    `IM-${stamp}-1,سارة,60000002,حولي,3,15,,4,,1.000,الدور الثاني`,
    `IM-${stamp}-2,"خالد, الابن",60000003,الجابرية,1,2,,9,3.000,1.000,`,
    `IM-${stamp}-3,بدون جوال,,الفروانية,1,1,,1,,,`,
  ].join('\n'));
  await page.click('button.primary:has-text("استيراد")');
  await page.locator('[data-testid=import-result]:has-text("أُنشئ 2")').waitFor();
  await page.locator('[data-testid=import-result]:has-text("مكرر 1")').waitFor();
  await page.locator('[data-testid=import-result] td:has-text("recipient.phone required")').waitFor();
  await shot(page, 'd05-import');
  ok('الاستيراد: طلبان جديدان، مكرر واحد، وسطر خاطئ');

  // 6. Settings and earnings
  await page.click('button[role=tab]:has-text("الإعدادات")');
  const fee = page.locator('label:has-text("عمولة السائق لكل تسليم") input');
  await fee.fill('0.750');
  await page.click('button:has-text("حفظ")');
  await page.locator('.alert:has-text("حُفظت الإعدادات")').waitFor();
  await page.click('button[role=tab]:has-text("أرباح السائقين")');
  await page.locator('tr:has-text("سالم العتيبي") td:has-text("0.750 KWD")').waitFor();
  await shot(page, 'd06-earnings');
  ok('إعدادات العمولة وتقرير أرباح السائقين');

  await rec.goto(`${WEB}/track/${'z'.repeat(32)}`).then(() => rec.locator('h1:has-text("الرابط غير صالح")').waitFor());
  ok('رابط تتبع غير صالح يعرض رسالة واضحة');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error(`✗ بعد الخطوة ${step}:`, e.message);
  await shot(page, 'd-fail');
  process.exitCode = 1;
} finally {
  await browser.close();
}
