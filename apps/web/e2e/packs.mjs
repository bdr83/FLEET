// Sector packs: a company sees only the screens of the activities it picked. Run like smoke.mjs.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
let step = 0;
const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar-KW', viewport: { width: 1360, height: 860 } });
try {
  await page.goto(`${WEB}/login`);
  await page.click('button:has-text("حساب جديد")');
  await page.fill('input[name=email]', `packs-${Date.now()}@example.com`);
  await page.fill('input[name=password]', 'packs-password');
  await page.click('button:has-text("إنشاء الحساب")');
  await page.fill('input[name=company]', 'مصنع خرسانة');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.locator('text=اختر نشاطًا واحدًا على الأقل').waitFor();
  await page.check('input[name=pack-concrete]');
  await page.click('button:has-text("إنشاء الشركة")');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.locator('nav a:has-text("جدول الصب")').waitFor();
  if (await page.locator('nav a:has-text("مركز التوصيل")').count()) throw new Error('delivery menu visible');
  if (await page.locator('nav a:has-text("لوحة الإسناد")').count()) throw new Error('staffing menu visible');
  ok('شركة اختارت الخرسانة فقط: تظهر شاشة الصب وتختفي البقية');

  await page.goto(`${WEB}/settings`);
  await page.click('button:has-text("الأنشطة")');
  await page.check('input[name=pack-delivery]');
  await page.click('.card button:has-text("حفظ")');
  await page.locator('nav a:has-text("مركز التوصيل")').waitFor();
  ok('تفعيل التوصيل من الإعدادات يظهر شاشته');
  console.log(`\nكل الخطوات نجحت (${step})`);
} catch (e) {
  console.error('FAIL', e.message); process.exitCode = 1;
} finally { await browser.close(); }
