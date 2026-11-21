# منصة إدارة الأساطيل والعمليات الميدانية

منصة SaaS متعددة الشركات للنقل والأساطيل والعمليات الميدانية، تبدأ بالكويت ثم الخليج.
المستندات المرجعية: التحليل (A)، تجربة المستخدم (B)، المعمارية (C)، خطة البناء (D)، الجودة (E).

## الحالة: P0 وP1 مكتملتان

| المكوّن | المسار | الحالة |
|---|---|---|
| مخطط قاعدة البيانات + RLS | `db/migrations` | جاهز ومختبر |
| اختبارات العزل والقيود والمحاسبة | `db/tests/run.sh` | 23 فحصًا |
| خدمة API (NestJS) | `apps/api` | P1: دخول OTP، إنشاء مؤسسة، الأدوار والنطاقات، الأعضاء، الشركات والفروع، سجل التدقيق |
| لوحة التحكم (Next.js) | `apps/web` | تبدأ في P1 |
| تطبيق السائق (Flutter) | `apps/driver` | يبدأ في P3 |

## التشغيل محليًا

```bash
docker compose up -d
psql postgresql://admin:admin@localhost:5432/fleet -v app_rw_password="'devpass'" -f db/bootstrap.sql
DATABASE_URL=postgresql://admin:admin@localhost:5432/fleet ./db/migrate.sh
ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:5432/fleet \
APP_DATABASE_URL=postgresql://app_rw:devpass@localhost:5432/fleet ./db/tests/run.sh

cd apps/api && npm ci
DATABASE_URL=postgresql://app_rw:devpass@localhost:5432/fleet npm test
```

## قواعد ثابتة

- كل جدول فيه `tenant_id` محمي بـ RLS، وCI يفشل إن وُجد جدول بدونه.
- كل مرجع بين جداول الشركات مفتاح مركّب `(tenant_id, id)`.
- الشركة تأتي من الـ token الموقّع فقط، لا من الرابط أو الطلب.
- كل استعلام على بيانات الشركات يمر عبر `DbService.withTenant()`.
- الدفتر وسجل الحالات وسجل التدقيق للإضافة فقط.
- التطبيق يتصل بدور `app_rw` الذي لا يملك الجداول ولا يتجاوز RLS.
- لا تُدمج ميزة إلى `main` دون نجاح CI ومراجعة.

## واجهات P1

انظر [docs/api.md](docs/api.md).

## التالي

P2 المركبات والسائقون، ثم P3 تطبيق السائق والتتبع، ثم P4 المناوبات والمهام (خطة البناء، المرحلة D). القطاعات بعد اكتمال النواة.
