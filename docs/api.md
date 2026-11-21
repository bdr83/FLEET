# واجهات API

كل الواجهات تحت `/v1`. الشركة تأتي من الـ access token فقط. كل واجهة تعلن صلاحيتها بـ `@Perm()`، والعضوية والدور والنطاق تُقرأ من قاعدة البيانات مع كل طلب.

## الدخول (P1)

| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/auth/otp/request` | `{phone}` يرسل رمزًا من 6 أرقام (5 دقائق، 5 محاولات، فاصل 60 ثانية، 5 في الساعة) |
| POST | `/auth/otp/verify` | `{phone, code}` → `user_token` (10 دقائق) + قائمة الشركات |
| GET | `/auth/memberships` | بـ user_token |
| POST | `/auth/token` | `{tenant_id}` بـ user_token → `access_token` (15 دقيقة) + `refresh_token` (30 يومًا) |
| POST | `/auth/refresh` | تدوير؛ إعادة استخدام رمز قديم تلغي كل جلسات المستخدم في الشركة |
| POST | `/auth/logout` | يلغي refresh token |

## المؤسسة

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| POST | `/tenants` | user_token | إنشاء مؤسسة تجريبية + أول شركة قانونية + المستخدم مالكًا |
| GET | `/me` | org:read | الدور والصلاحيات والنطاق |
| GET/POST | `/legal-entities` | org:read / org:write | |
| GET/POST/PATCH | `/branches` | org:read / org:write | |
| GET | `/members` | members:read | |
| POST | `/members` | members:write | `{phone, role_code, scope_legal_entity_ids?, scope_branch_ids?, valid_until?}` |
| PATCH | `/members/:id` | members:write | تغيير الدور أو النطاق أو مدة الصلاحية |
| DELETE | `/members/:id` | members:write | إلغاء فوري + إلغاء الجلسات |
| GET | `/audit-log` | members:read | آخر 200 حدث |

قواعد: المالك وحده يمنح دور المالك أو يعدّل مالكًا، ولا تبقى مؤسسة بلا مالك.

## الأدوار القياسية

owner (كل شيء)، admin، dispatcher، accountant، branch_supervisor، driver، customer. التفاصيل في `db/migrations/0005_identity.sql`.

## المهام (مؤقت حتى P4)

`GET /tasks`، `GET /tasks/:id`، `POST /tasks`.
