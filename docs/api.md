# واجهات API

كل الواجهات تحت `/v1`. الشركة تأتي من الـ access token فقط. كل واجهة تعلن صلاحيتها بـ `@Perm()`، والعضوية والدور والنطاق تُقرأ من قاعدة البيانات مع كل طلب.

## الدخول (P1)

| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/auth/otp/request` | `{phone}` يرسل رمزًا من 6 أرقام (5 دقائق، 5 محاولات، فاصل 60 ثانية، 5 في الساعة) |
| POST | `/auth/otp/verify` | `{phone, code}` → `user_token` (10 دقائق) + قائمة الشركات |
| POST | `/auth/register` | `{email, password, display_name?}` حساب جديد (كلمة مرور 8 أحرف على الأقل، تُخزن scrypt) → `user_token` + قائمة الشركات؛ بريد مستخدم = 409 |
| POST | `/auth/login` | `{email, password}` → `user_token` + قائمة الشركات؛ 10 محاولات خاطئة تقفل الحساب 15 دقيقة (429) |
| POST | `/auth/password/forgot` | `{email}` يرسل رابط استعادة صالحًا ساعة لمرة واحدة؛ الرد نفسه للبريد غير المسجل؛ 503 `email_unavailable` بلا SMTP |
| POST | `/auth/password/reset` | `{token, password}` → `user_token` + قائمة الشركات |
| POST | `/auth/password/change` | `{current_password, new_password}` بـ access_token |
| GET | `/auth/methods` | `{password: true, password_reset}` لصفحة الدخول |
| GET | `/auth/memberships` | بـ user_token |
| POST | `/auth/token` | `{tenant_id}` بـ user_token → `access_token` (15 دقيقة) + `refresh_token` (30 يومًا) |
| POST | `/auth/refresh` | تدوير؛ إعادة استخدام رمز قديم تلغي كل جلسات المستخدم في الشركة |
| POST | `/auth/logout` | يلغي refresh token |

إضافة عضو (`POST /members`) تقبل `phone` أو `email`، ومع البريد كلمة مرور أولى اختيارية `password` تُطبَّق فقط إن لم يكن للحساب كلمة مرور.

## الأنشطة (الحزم القطاعية)

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/packs` | `{available, enabled}`: الحزم المتاحة (delivery، freight، staffing، concrete، internal، distribution، coldchain، courier، warehouse) والمفعّلة للشركة |
| PUT | `/packs` | `{packs: [...]}` بصلاحية `org:write`؛ يُسجَّل في سجل التدقيق |

`POST /tenants` يقبل `packs` (بدونها تُفعَّل كل الحزم). مسارات حزمة غير مفعّلة ترد 403 `pack_disabled`، وكذلك إنشاء مهمة من نوعها. أنواع المهام العامة (خارج الحزم) مسموحة دائمًا. `GET /me` يعيد `packs`.

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

## الأسطول والسائقون (P2)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/assets?status=&type=&branch_id=` | fleet:read | المركبات والمعدات ضمن نطاق المستخدم |
| GET | `/assets/:id` | fleet:read | 404 إذا كانت خارج النطاق |
| POST | `/assets` | fleet:write | `{legal_entity_id, asset_type, plate_no?, branch_id?, make?, model?, year?, vin?, odometer_km?, capacity?, notes?}` |
| PATCH | `/assets/:id` | fleet:write | العدّاد لا يرجع للخلف، رقم اللوحة فريد داخل المؤسسة |
| GET | `/workers?status=&kind=` | fleet:read | السائقون والمناديب والفنيون |
| GET | `/workers/:id` | fleet:read | |
| POST | `/workers` | fleet:write | `{legal_entity_id, kind, display_name, phone?, branch_id?}`. مع رقم الهاتف تُنشأ عضوية driver تلقائيًا ليدخل تطبيق السائق |
| PATCH | `/workers/:id` | fleet:write | `status: left` يلغي عضوية السائق وجلساته فورًا |
| GET | `/documents?asset_id=&worker_id=` | fleet:read | الوثائق السارية |
| GET | `/documents/expiring?days=30` | fleet:read | المنتهية والتي تنتهي خلال N يومًا، مع `days_left` و`state` |
| POST | `/documents` | fleet:write | `{doc_type, asset_id XOR worker_id, number?, issued_on?, expires_on?}`. تأخذ شركة المالك تلقائيًا |
| DELETE | `/documents/:id` | fleet:write | أرشفة |

أنواع المركبات: car, motorbike, van, pickup, truck, mixer, pump, trailer, bus, other.
أنواع الوثائق: driving_license, vehicle_registration, insurance, civil_id, residency, work_permit, inspection, other. [تحقق محلي] قائمة الوثائق الإلزامية لكل نشاط في الكويت.

## تطبيق السائق (P3)

كل الواجهات تعمل على سجل السائق المرتبط بالمستخدم الداخل، ولا تقبل رقم سائق من التطبيق.

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/driver/me` | shift:own | بيانات السائق والمناوبة المفتوحة |
| POST | `/driver/shifts` | shift:own | بدء مناوبة `{client_op_id, asset_id?, odometer_km?, started_at?}`. إعادة الطلب نفسه تعيد المناوبة نفسها. 409 إن كانت له مناوبة مفتوحة أو المركبة مع سائق آخر |
| POST | `/driver/shifts/:id/end` | shift:own | إنهاء المناوبة `{odometer_km?, ended_at?}`. يعيد المركبة "متاحة"، والتكرار آمن |
| POST | `/driver/locations` | shift:own | دفعة حتى 500 نقطة `{points:[{recorded_at, lat, lng, accuracy_m?, speed_mps?, heading?, battery_pct?, source?}]}`. تُحفظ فقط النقاط داخل مناوبة، وتُتجاهل المكررة. الرد: `received, stored, duplicates, outside_shift, out_of_window` |
| GET | `/driver/tasks` | tasks:read_own | مهامي غير المنتهية |
| POST | `/driver/sync` | tasks:update_own | طابور العمليات دون اتصال `{ops:[{type:'task_status', client_op_id, task_id, to_status, occurred_at, note?}]}`. لكل عملية نتيجة: applied أو duplicate أو rejected مع السبب |

قواعد:
- انتقالات السائق: assigned→accepted→in_progress→completed أو failed. الفشل يتطلب سببًا (`note`).
- الوقت المقبول من الجهاز: حتى 7 أيام للخلف و5 دقائق للأمام.
- لا تتبع خارج المناوبة (D6)، وتُحذف نقاط المواقع بعد 90 يومًا تلقائيًا (`LOCATION_RETENTION_DAYS`).

## المهام والتوزيع (P4)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/tasks?status=a,b&worker_id=&branch_id=&from=&to=&unassigned=true` | tasks:read | قائمة المهام مع السائق والمركبة |
| GET | `/tasks/:id` | tasks:read | المهمة مع سجل الحالات (`events`) |
| POST | `/tasks` | tasks:write | `{legal_entity_id, sector_pack, branch_id?, window?:{from,to}, attributes?, ref?, draft?}`. `ref` يمنع تكرار الطلب نفسه |
| PATCH | `/tasks/:id` | tasks:write | `{version, attributes?, window?, branch_id?}`. قبل بدء السائق فقط |
| POST | `/tasks/:id/publish` | tasks:write | مسودة → جاهزة |
| POST | `/tasks/:id/assign` | tasks:assign | `{version, worker_id, asset_id?, exclusive?}`. إسناد أو إعادة إسناد |
| POST | `/tasks/:id/unassign` | tasks:assign | تعود للطابور |
| POST | `/tasks/:id/cancel` | tasks:write | `{version, reason}` |
| POST | `/tasks/:id/review` | tasks:write | مكتملة → مراجَعة |
| POST | `/tasks/:id/reopen` | tasks:write | فاشلة → جاهزة لإسناد جديد |
| GET | `/dispatch/board?date=YYYY-MM-DD&tz=Asia/Kuwait` | tasks:read | أعداد اليوم حسب الحالة، طابور غير المسندة، السائقون مع المناوبة وعدد المهام وآخر موقع |
| GET | `/shifts?open=true&worker_id=` | fleet:read | المناوبات |
| POST | `/shifts/:id/end` | fleet:write | `{reason}`. إنهاء مناوبة نسيها السائق، ويتوقف التتبع فورًا |

قواعد:
- كل تعديل أو انتقال يتطلب `version` الحالي، وإلا 409 مع `current_version` (منع ضياع التعديلات بين مشرفَين).
- `exclusive: true` يمنع تداخل حجوزات السائق نفسه (سائق مؤجَّر، رحلة خلاطة). بدونه يمكن إسناد عدة طلبات توصيل متزامنة.
- المركبة لا تُحجز في مهمتين متداخلتين أبدًا. في التوصيل تُربط المركبة بالمناوبة لا بكل طلب.
- السائق والمركبة من الشركة القانونية نفسها للمهمة.
- آخر موقع لا يظهر في اللوحة إلا للسائق الذي في مناوبة مفتوحة (D6).

## الخريطة الحية والتقارير (P5)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/map/live?since=&stale_after=300` | fleet:read | السائقون في مناوبة مفتوحة: آخر موقع، البطارية، المهمة الحالية، و`stale` إذا انقطع الموقع. مع `since` (قيمة `server_time` من الرد السابق) يعيد من تحرّك فقط |
| GET | `/shifts/:id/track` | fleet:read | مسار المناوبة لإعادة العرض، مع المسافة والمدة وأعلى سرعة |
| GET | `/reports/tasks?from=&to=&group=day\|worker\|branch&tz=&format=csv` | reports:read | الإجمالي، المكتملة، الفاشلة، الملغاة، المفتوحة، نسبة الالتزام بالموعد، متوسط مدة التنفيذ |
| GET | `/reports/drivers?from=&to=&format=csv` | reports:read | لكل سائق: المهام، الالتزام بالموعد، ساعات المناوبة، الكيلومترات من GPS |
| GET | `/reports/fleet?from=&to=&format=csv` | reports:read | لكل مركبة: المناوبات، ساعات الاستخدام، نسبة الاستغلال، الكيلومترات من العدّاد |

قواعد:
- أقصى مدة للتقرير 93 يومًا [تخمين]. المنطقة الزمنية الافتراضية Asia/Kuwait.
- المسافة تتجاهل النقاط التي دقتها أسوأ من 100 متر حتى لا يضخّم تذبذب GPS الكيلومترات [تخمين].
- ملف CSV يبدأ بـ BOM ليفتح بالعربية في Excel، والخلايا التي تبدأ بـ = أو + أو - أو @ تُسبق بعلامة ' لمنع حقن الصيغ.

## العملاء والعقود وبوابة العميل (P6)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/customers?q=&status=` | customers:read | بحث بالاسم أو الهاتف أو الرقم المرجعي |
| GET | `/customers/:id` | customers:read | العميل مع مواقعه وعقده الفعّال |
| POST | `/customers` | customers:write | `{legal_entity_id, name, kind?, ref?, phone?, email?, cr_number?, payment_terms_days?, credit_limit?}` |
| PATCH | `/customers/:id` | customers:write | منها `status`: active أو on_hold (يوقف إنشاء مهام له) أو closed |
| POST | `/customers/:id/sites` | customers:write | `{name, address?, lat?, lng?, contact_name?, contact_phone?}` |
| PATCH | `/sites/:id` | customers:write | تعديل أو إيقاف موقع |
| GET | `/contracts?customer_id=&status=` | customers:read | |
| GET | `/contracts/:id` | customers:read | العقد مع قائمة الأسعار |
| POST | `/contracts` | customers:write | `{customer_id, starts_on, ends_on?, code?, payment_terms_days?, rates:[{unit, price, sector_pack?, included_qty?, min_charge?}]}` |
| POST/DELETE | `/contracts/:id/rates` | customers:write | في المسودة فقط |
| POST | `/contracts/:id/activate\|suspend\|resume\|end` | customers:write | |
| POST | `/contracts/:id/quote` | customers:read | `{sector_pack, quantities:{task:1, km:12}}` → البنود والإجمالي |
| GET | `/portal/me` | portal:own | بيانات العميل ومواقعه |
| GET | `/portal/tasks`, `/portal/tasks/:id` | portal:own | طلبات العميل فقط، والسائق يظهر بعد قبوله |
| POST | `/portal/tasks` | portal:own | طلب جديد يصل مسودة ليراجعه المشغّل |
| POST | `/portal/tasks/:id/cancel` | portal:own | قبل الإسناد فقط |

قواعد:
- وحدات التسعير: task, km, hour, trip, m3, ton, day, month. السعر الخاص بنوع المهمة يسبق السعر العام.
- الحساب بالفلس (3 منازل عشرية) دون كسور عائمة. الكمية المشمولة مجانية، والحد الأدنى يطبَّق على الكميات الصغيرة (مثل حمولة خرسانة صغيرة).
- عقد فعّال واحد للعميل في أي يوم. أسعار العقد الفعّال وشروط دفعه مجمّدة؛ لتغييرها يُنهى العقد ويُفعَّل عقد جديد، فتبقى كل فاتورة مرتبطة بالأسعار المتفق عليها وقتها.
- المهمة المرتبطة بعميل تأخذ عقده الفعّال في تاريخ تنفيذها (بتوقيت شركته القانونية).
- مستخدم بوابة العميل عضوية بدور customer مرتبطة بعميل واحد (`customer_id` عند إضافة العضو).

## الصيانة والمصروفات (P7)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET/POST | `/maintenance/plans` | fleet:read / fleet:write | خطة دورية `{asset_id, name, interval_km?, interval_days?}` تبدأ من العدّاد الحالي واليوم |
| PATCH | `/maintenance/plans/:id` | fleet:write | |
| GET | `/maintenance/due?within_km=500&within_days=14` | fleet:read | المستحق قريبًا والمتأخر (`state`: due_soon أو overdue) |
| GET/POST | `/work-orders` | fleet:read / fleet:write | أمر عمل `{asset_id, kind, plan_id?, out_of_service?, vendor?, description?}` برقم تسلسلي لكل شركة وسنة |
| GET | `/work-orders/:id` | fleet:read | مع بنود التكلفة |
| POST | `/work-orders/:id/lines` | fleet:write | `{kind: part\|labor\|other, description, qty?, unit_cost}` |
| POST | `/work-orders/:id/start\|complete\|cancel` | fleet:write | الإكمال يحدّث العدّاد وعدّاد الخطة، ويعيد المركبة للخدمة، ويقيّد التكلفة مصروفًا معتمدًا |
| GET | `/expenses?status=&category=&asset_id=&worker_id=&from=&to=` | fleet:read | مع الإجمالي لكل عملة |
| POST | `/expenses` | fleet:write | مصروف من المكتب، معتمد مباشرة. الشركة القانونية تتبع المركبة أو العامل |
| POST | `/expenses/:id/approve`, `/expenses/:id/reject` | fleet:write | الرفض يتطلب سببًا، ولا يعتمد أحد مطالبته |
| POST | `/driver/expenses` | shift:own | مطالبة السائق (وقود، مواقف، رسوم طرق، غسيل) `{client_op_id, category, amount, liters?, odometer_km?}` تُربط بمناوبته ومركبته |
| GET | `/driver/expenses` | shift:own | مطالباتي |
| GET | `/reports/costs?from=&to=&group=asset\|category&format=csv` | reports:read | التكلفة لكل مركبة مع تكلفة الكيلومتر واستهلاك الوقود، أو لكل فئة |

قواعد:
- أمر العمل بـ `out_of_service` يوقف المركبة فلا تُستخدم في مناوبة ولا تُسند لمهمة، وتعود للخدمة عند إغلاق آخر أمر يوقفها.
- العدّاد لا يرجع للخلف في أي مسار.

## الفواتير والتحصيل والذمم والقيود (P8)

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| PATCH | `/legal-entities/:id/billing` | org:write | `{tax_rate, tax_number, invoice_prefix}`. الضريبة صفر افتراضيًا وتضبطها الشركة [تحقق محلي] |
| GET | `/invoices?customer_id=&status=` | billing:read | |
| GET | `/invoices/:id` | billing:read | مع البنود والدفعات المخصصة لها |
| POST | `/invoices` | billing:write | `{customer_id, period_from, period_to}` مسودة من المهام المراجَعة غير المفوترة، مسعّرة بعقد كل مهمة، مع قائمة `skipped` لما تعذّر تسعيره |
| POST | `/invoices/:id/lines` | billing:write | بند يدوي على المسودة |
| POST | `/invoices/:id/lines/:lineId/remove` | billing:write | يزيل بنود المهمة كلها فتعود لطابور الفوترة |
| POST | `/invoices/:id/issue` | billing:write | رقم متسلسل بلا فجوات لكل شركة وسنة، تاريخ الاستحقاق من شروط العقد، المهام تصبح invoiced، وقيد: مدين الذمم، دائن الإيراد والضريبة |
| POST | `/invoices/:id/void` | billing:write | `{reason}`. للمسودة أو الفاتورة غير المدفوعة: قيد عكسي وتعود المهام "مراجَعة" |
| POST | `/payments` | billing:write | `{customer_id, amount, method, allocations?, reference?}`. بلا تخصيص يُخصَّص للأقدم استحقاقًا، والباقي رصيد دائن للعميل |
| GET | `/payments?customer_id=` | billing:read | مع غير المخصص |
| POST | `/payments/:id/reverse` | billing:write | شيك مرتجع أو خطأ: قيد عكسي وتُفتح الفواتير |
| GET | `/receivables/aging?as_of=` | billing:read | لكل عميل: جاري، 1-30، 31-60، 61-90، أكثر من 90، الرصيد الدائن، وتجاوز حد الائتمان |
| GET | `/customers/:id/statement?from=&to=` | billing:read | كشف حساب: رصيد افتتاحي، الحركات برصيد متراكم، رصيد ختامي |
| POST | `/driver/cod` | tasks:update_own | السائق يسجل المبلغ المحصّل من المستلم `{client_op_id, task_id, amount}` |
| GET | `/cod/custody` | billing:read | ما في عهدة كل سائق |
| POST | `/cod/deposits` | billing:write | تسليم السائق النقد للمكتب، لا يتجاوز عهدته |
| GET | `/cod/payable` | billing:read | المستحق لكل عميل من مبالغ COD |
| POST | `/cod/payouts` | billing:write | تحويل المبالغ للعميل، أو تسويتها بفاتورته عبر دفعة `method: cod_offset` |
| GET | `/ledger/trial-balance?legal_entity_id=&as_of=` | billing:read | ميزان المراجعة |

دليل الحسابات الأولي [تخمين، يُراجع مع محاسب كل عميل]: 1000 الصندوق، 1010 البنك، 1050 عهدة السائقين، 1100 ذمم العملاء، 2000 مصروفات مستحقة، 2010 مستحقات السائقين، 2200 ضريبة مستحقة، 2300 مبالغ COD للعملاء، 4000 الإيراد، 5010 إلى 5990 المصروفات حسب الفئة.

قواعد:
- الدفتر للإضافة فقط: لا تعديل ولا حذف، والتصحيح بقيد عكسي. كل قيد متوازن لكل عملة ولشركة قانونية واحدة، ويُفحص في قاعدة البيانات عند الحفظ.
- الفاتورة الصادرة لا تُعدَّل، والمهمة لا تظهر في فاتورتين.
- المصروف المعتمد يُقيَّد تلقائيًا: مطالبة السائق دائنة لحسابه (2010)، ومصروف المكتب دائن للمصروفات المستحقة (2000).
- المنصة لا تحتفظ بأموال (D5): مبالغ COD والدفعات سجلات لأموال تحتفظ بها الشركة المشتركة نفسها.

## قطاع التوصيل delivery@1 (D1–D6)

بيانات الطلب في `attributes` ويتحقق منها القطاع عند الإنشاء والتعديل: `dropoff` و`pickup` كعنوان كويتي `{area, block, street, avenue, house, floor, apartment, notes, lat, lng, phone}`، و`recipient {name, phone}`، و`cod_amount` و`delivery_fee` و`tip` (مبالغ بثلاث خانات)، و`external_order_id`، و`items_count`. يُبنى `address` من عنوان التسليم تلقائيًا. كل طلب توصيل يحصل على رمز مستلم من 4 أرقام ورابط تتبع صالح 14 يومًا.

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET/PUT | `/delivery/settings?legal_entity_id=` | tasks:read / org:write | رمز المستلم مطلوب، الحد الأقصى للطلبات المفتوحة، نطاق الإسناد، حداثة الموقع، SLA، العمولات، حد العهدة [تخمين للقيم الافتراضية] |
| GET | `/delivery/tasks/:id` | tasks:read | الرمز ورابط التتبع (للمكتب فقط)، المراحل، إثبات التسليم، سبب الفشل |
| POST | `/delivery/tasks/:id/pod/approve` و`/reject` | tasks:write | قبول أو رفض صورة/توقيع (الرفض يحتاج `reason`) |
| POST | `/delivery/import` | tasks:write | `{legal_entity_id, customer_id?, branch_id?, orders[≤500]}`؛ `external_order_id` يمنع التكرار؛ يعيد created وduplicates وerrors لكل سطر |
| POST | `/delivery/auto-assign` | tasks:assign | `{task_ids?}` يسند الطلبات الجاهزة لأقرب مندوب في وردية مفتوحة بموقع حديث، ضمن النطاق والحد الأقصى |
| GET | `/delivery/exceptions` | tasks:read | متأخرة (الموعد أو SLA)، إثباتات بانتظار الموافقة، فاشلة لم تُرجع، رموز مقفلة، عهدة نقدية فوق الحد |
| GET | `/delivery/earnings?from&to` | reports:read | تسليمات وفاشلة لكل مندوب × العمولة، وCOD المحصّل (تقرير فقط) |
| GET | `/public/track/:token` | بلا دخول | صفحة المستلم: الحالة والمرحلة واسم الشركة والمنطقة، والرمز ما دام الطلب نشطًا، واسم المندوب الأول، وموقعه التقريبي فقط بعد الاستلام وأثناء الطريق. لا أرقام هواتف |

في `/driver/sync` أنواع إضافية: `milestone {code: at_pickup|picked_up|at_dropoff|returned_to_sender, lat?, lng?}`، و`pod {method: pin|photo|signature, pin?, file_key?, recipient_name?}`. الرمز الخاطئ يُرفض `wrong_pin` ويُقفل بعد 5 محاولات `pin_locked`. إكمال طلب له جوال مستلم يحتاج إثباتًا `proof_required` (حسب الإعداد). الفشل يقبل `reason_code` من: recipient_absent, wrong_address, recipient_refused, unreachable, damaged, cod_not_paid, customer_canceled, other. `GET /driver/tasks?include=returns` يضيف الطلبات الفاشلة التي لم تُرجع بعد.

## قطاع الخرسانة الجاهزة concrete@1 (القطاع 20)

طلب الصب يُقسّم إلى حمولات بسعة الخلاطة في الإعدادات (حمولات كاملة ثم الباقي). كل حمولة مهمة عادية بنوع `concrete@1` ورقم `REF-n` ونافذة من التحميل حتى عودة الخلاطة، ولها تذكرة في `ops.load_ticket`. حالة الطلب تُشتق من حمولاته: scheduled، in_progress، completed، canceled.

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET/PUT | `/concrete/settings?legal_entity_id=` | tasks:read / org:write | سعة الخلاطة، أقصى عمر للخرسانة وتنبيهه، الانتظار المجاني، زمن الوصول، زمن الدورة [تخمين للقيم الافتراضية] |
| GET | `/concrete/pours?from&to` | tasks:read | صبّات الفترة (افتراضيًا اليوم وغدًا) مع الإجماليات والحمولات المختصرة |
| POST | `/concrete/pours` | tasks:write | `{legal_entity_id, ref, customer_id?, site_id?, site{name, area, block, street, plot, lat, lng, contact_name, contact_phone}, mix_code, volume_m3, pour_rate_m3h, pump_required?, pump_asset_id?, scheduled_at, notes?}`؛ إعادة الإرسال بنفس ref تعيد الطلب نفسه |
| GET | `/concrete/pours/:id` | tasks:read | الطلب والحمولات (الحالة، الخلاطة، المرحلة، العمر، الانتظار، المصبوب والمرتجع) والخطة: الفاصل بين الخلاطات وعددها لصب مستمر (تقدير) |
| PATCH | `/concrete/pours/:id` | tasks:write | `{version, site_ready?, pump_asset_id?, notes?, site?, scheduled_at?}`؛ تغيير الموعد يعيد توقيت الحمولات غير المحمّلة |
| POST | `/concrete/pours/:id/adjust` | tasks:write | `{version, volume_m3, reason}` تعديل الكمية بموافقة العميل: تُعدّل أو تُضاف أو تُلغى الحمولات غير المحمّلة، ولا تقل عن المحمّل |
| POST | `/concrete/pours/:id/cancel` | tasks:write | `{version, reason}` يلغي الحمولات غير المحمّلة |
| GET | `/concrete/board` | tasks:read | كل خلاطة وحالتها: off، loading، on_road، waiting، pouring، returning، available، مع أرقام اليوم بتوقيت الشركة |
| GET | `/concrete/exceptions` | tasks:read | عمر الخرسانة فوق التنبيه، انتظار فوق المجاني، حمولات قريبة بلا خلاطة، مواقع متوقفة، مواقع بلا دبوس |
| GET | `/concrete/waiting?from&to` | reports:read | الانتظار لكل تذكرة موقّعة وإجماليات لكل عميل |
| GET | `/concrete/tasks/:id` | tasks:read | تذكرة الحمولة وطلب الصب وحدود العمر والانتظار وسبب الفشل |

الإسناد بالواجهة العامة `/tasks/:id/assign` مع `asset_id` الخلاطة. قيد تداخل المركبة يمنع إسناد خلاطة لحمولتين متداخلتين، وعند اكتمال الحمولة أو فشلها تُقصّر نافذتها حتى عودة الخلاطة.

في `/driver/sync`: `milestone {code: loaded|at_site|pour_start|pour_end}` بالترتيب (`stage_out_of_order`، `stage_already_recorded`)، و`loaded` يسجّل وقت الخلط في التذكرة. `ticket {poured_m3, returned_m3?, signed_by, file_key?}` بعد انتهاء الصب فقط؛ المصبوب والمرتجع لا يتجاوزان الحمولة (`quantity_exceeds_load`)، والتذكرة لا تُعدّل بعد التوقيع (`already_signed`، ومحمية في قاعدة البيانات). التوقيع يكتب `attributes.quantities = {m3, hour}` للفاتورة: الساعات = الانتظار بعد المجاني بالربع ساعة. الإكمال يحتاج التذكرة (`proof_required`)، والمراجعة كذلك. أسباب الفشل: site_not_ready, age_exceeded, rejected_by_site, truck_breakdown, pump_breakdown, customer_canceled, other (سبب من قطاع آخر يُرفض `invalid_reason`). `GET /driver/tasks` يضيف `ticket` للحمولات.

## قطاع توريد السائقين staffing@1 (القطاع 14)

طلب العميل يُوفَّر بتعيين سائقين عليه لفترات. كل يوم عمل في التعيين مهمة عادية بنوع `staffing@1` ورقم `REF-seq-YYYYMMDD` ونافذة الدوام بتوقيت الشركة (نهاية قبل البداية = دوام ليلي ينتهي في اليوم التالي)، مسندة للسائق إسنادًا حصريًا، ولها صف في `ops.staffing_shift`. تُولَّد المناوبات حتى 93 يومًا مقدمًا، و`POST /staffing/generate` يكمل الباقي (مهمة يومية في الإنتاج). حالة الطلب تُشتق: upcoming، active، ended، canceled.

| الطريقة | المسار | الصلاحية | الوصف |
|---|---|---|---|
| GET/PUT | `/staffing/settings?legal_entity_id=` | tasks:read / org:write | نطاق الموقع للحضور بالمتر، مهلة التأخير، تقريب الساعات (1، 5، 10، 15، 30، 60 دقيقة)، المستندات المطلوبة للأهلية [تخمين للقيم الافتراضية] |
| GET | `/staffing/requests?all=` | tasks:read | الطلبات السارية والقادمة (أو كلها) مع عدد المعيّنين الآن |
| POST | `/staffing/requests` | tasks:write | `{legal_entity_id, customer_id, ref, site_id?, site{name, area, block, street, notes, lat, lng, contact_name, contact_phone}, worker_kind: driver\|courier, with_vehicle?, headcount, starts_on, ends_on, shift_start, shift_end, work_days[0..6]?, bill_unit: hour\|day, notes?}`؛ نفس ref يعيد الطلب نفسه، والفترة سنة كحد أقصى |
| GET | `/staffing/requests/:id` | tasks:read | الطلب والتعيينات مع أهلية كل سائق، ومناوبات أسبوع قبل اليوم وبعده |
| POST | `/staffing/requests/:id/cancel` | tasks:write | `{version, reason}` تنتهي التعيينات اليوم وتُلغى المناوبات القادمة غير المبدوءة |
| GET | `/staffing/requests/:id/candidates` | tasks:read | السائقون من النوع والشركة نفسيهما مع فحص المستندات للفترة والتعيين المتداخل إن وُجد |
| POST | `/staffing/requests/:id/placements` | tasks:assign | `{worker_id, asset_id?, starts_on?, ends_on?}`؛ يُرفض غير المؤهل (409 مع التفاصيل) والطلب المكتمل العدد والتعيين المتداخل للسائق (قيد في قاعدة البيانات)، ويولّد المناوبات |
| POST | `/staffing/placements/:id/end` | tasks:assign | `{reason, end_on?}` يقصّر التعيين ويلغي المناوبات بعده، أو يزيله إن لم يبدأ |
| POST | `/staffing/generate` | tasks:assign | يولّد المناوبات الناقصة للتعيينات السارية |
| POST | `/staffing/shifts/:id/replace` | tasks:assign | `{worker_id, asset_id?}` بديل مؤهل لليوم؛ يُحفظ السائق الأصلي |
| POST | `/staffing/shifts/:id/absent` | tasks:write | `{reason?}` غياب بلا بديل: تُلغى المناوبة |
| GET | `/staffing/board?from&days` | tasks:read | لكل طلب ولكل يوم: المطلوب والمغطى ومن حضر والغياب والبدلاء، ومؤشرات اليوم |
| GET | `/staffing/exceptions` | tasks:read | لم يحضر بعد المهلة، مناوبات قريبة بلا سائق، حضور أبعد من النطاق، مستندات تنتهي، طلبات تنتهي خلال أسبوع، اعتراضات مفتوحة |
| GET | `/staffing/timesheet?from&to&request_id` | tasks:read | أيام العمل بالحضور والانصراف والساعات والحالة والاعتراض (حتى 93 يومًا) |
| POST | `/staffing/approve` | tasks:write | `{task_ids}` اعتماد المكتب نيابة عن العميل؛ يُتخطى المعترض عليه وغير المكتمل |
| POST | `/staffing/disputes/:id/resolve` | tasks:write | `{resolution, hours?}` الساعات المتفق عليها تحل محل المسجّلة (بلا ساعات للفوترة باليوم) |

بوابة العميل: `GET /portal/staffing` طلباته والمعيّنون بالاسم الأول وحالة الرخصة فقط وأيام آخر 31 يومًا، و`POST /portal/staffing/approve {task_ids}`، و`POST /portal/staffing/dispute {task_id, reason}` (اعتراض مفتوح واحد لكل يوم؛ يبقى اليوم خارج الفاتورة حتى يُحل). `GET /portal/tasks` لا يعرض مناوبات التوريد.

في `/driver/sync`: `milestone {code: check_in|check_out}`؛ الحضور بعد القبول ويفتح قبل بداية الدوام بساعتين (`too_early`) ويسجّل بُعده عن الموقع إن أُرسل الموقع، والبدء `in_progress` يحتاج الحضور، والانصراف يحتاج الحضور، والإكمال يحتاج الانصراف (`proof_required`). الإكمال يكتب `attributes.quantities = {hour}` (الوقت من الحضور للانصراف مقرّبًا) أو `{day: 1}`. أسباب المغادرة المبكرة: sick, vehicle_breakdown, sent_home_by_customer, other. `GET /driver/tasks` يعرض مناوبات التوريد التي تبدأ خلال 36 ساعة فقط. اعتماد العميل (أو المكتب) = المراجعة، ثم الفاتورة بسعر "ساعة" أو "يوم" في عقد العميل لنوع `staffing@1`.


## قطاع الأسطول الداخلي internal@1 (القطاع 21)

طلب المركبة يمر بـ `pending → approved|rejected → allocated → in_use → returned` أو `canceled`. التخصيص ينشئ مهمة `internal@1` بمرجع الطلب وحجزًا حصريًا للمركبة (والسائق إن وُجد) طوال الفترة، فقيود الإسناد نفسها تمنع الحجز المزدوج مع أي قطاع. الإسناد بلا سائق (قيادة ذاتية) مسموح: `assignment.worker_id` اختياري بشرط وجود مركبة.

| الطريق | الصلاحية | ما يفعله |
|---|---|---|
| `GET/PUT /v1/internal/settings` | `tasks:read` / `org:write` | الموافقة، الاعتماد التلقائي حتى N ساعة، سعر الكم وساعة السائق، مهلة الإرجاع، ساعات الدوام |
| `GET /v1/internal/departments`، `POST`، `PATCH :id` | `vehicle_requests:own` / `org:write` | الإدارات ومراكز التكلفة والمدير |
| `GET /v1/internal/my` | `vehicle_requests:own` | إدارتي، طلباتي، وطلبات إداراتي بانتظار قراري |
| `POST /v1/internal/requests` | `vehicle_requests:own` | طلب جديد؛ يُعتمد تلقائيًا إن أوقفت السياسة الموافقة أو كان المشوار قصيرًا أو الطالب مدير الإدارة |
| `POST /v1/internal/requests/:id/decide` | مدير الإدارة أو `tasks:assign` | `{version, approve, note}`؛ الرفض يحتاج سببًا |
| `POST /v1/internal/requests/:id/cancel` | الطالب أو `tasks:write` | قبل التسليم؛ يلغي المهمة ويحرر الحجز |
| `GET /v1/internal/requests?status=open` و`/:id` | `tasks:read` (أو الطالب والمدير) | القائمة والتفاصيل |
| `GET /v1/internal/requests/:id/options` | `tasks:assign` | المركبات والسائقون المتاحون للفترة |
| `POST /v1/internal/requests/:id/allocate` | `tasks:assign` | `{version, asset_id, driver_worker_id?}` |
| `POST /v1/internal/requests/:id/handover` و`/return` | `tasks:write` | `{version, odometer_km, fuel?, note?}` (الوقود بالثُمن 0–8)؛ الإرجاع ينهي الحجز الآن |
| `GET /v1/internal/board?date=` | `tasks:read` | مركبات اليوم وحجوزاتها وحالتها الآن |
| `GET /v1/internal/exceptions` | `tasks:read` | بلا مركبة، لم تُستلم، تأخر الإرجاع، تنتظر القرار، خارج الدوام |
| `GET /v1/internal/who?asset_id&at` | `tasks:read` | من كان معه المفتاح وقت المخالفة (المشوار ثم وردية السائق) |
| `GET /v1/internal/costs?from&to` | `reports:read` | لكل إدارة: المشاوير، الكم، ساعات السائق، التكلفة، المصروفات المعتمدة أثناء المشوار، الإجمالي |

تطبيق السائق (مشوار مع سائق): `task_status accepted` ← `milestone vehicle_out {odometer_km, fuel?}` ← `in_progress` ← `milestone vehicle_back {odometer_km, fuel?}` ← `completed`. أسباب الرفض الجديدة: `odometer_required`، `odometer_too_low`، `vehicle_booked`. مشوار يتعذّر في الطريق يبقى «مع الموظف» حتى يسجّل المكتب الإرجاع، والمهمة تبقى فاشلة.

## قطاع التوزيع الذاتي distribution@1 (القطاع 29)

المسار يمر بـ `planned → loaded → out → back → settled` أو `canceled`. المسار مهمة `distribution@1` (`attributes.kind = route`) بإسناد حصري للمركبة والسائق لنافذة اليوم (افتراضيًا 06:00–18:00 بتوقيت الشركة)، وكل توقف مهمة (`kind = stop`، مرجعها `DR-n-seq`) بإسناد للسائق غير حصري. الكميات حتى 3 منازل عشرية، والمبالغ بالدينار حتى 3 منازل.

| الطريق | الصلاحية | ما يفعله |
|---|---|---|
| `GET/POST /v1/distribution/products`، `PATCH :id` | `tasks:read` / `tasks:write` | الأصناف: `sku` فريد لكل شركة، الاسم، الوحدة (piece, carton, crate, kg, liter, bag)، السعر |
| `POST /v1/distribution/routes` | `tasks:assign` | `{legal_entity_id, route_date, asset_id, driver_worker_id, start_time?, end_time?, stops:[{name, customer_id?, address?, payment?, items:[{sku, qty}]}]}`؛ 409 إن كانت المركبة أو السائق محجوزين ذلك اليوم |
| `GET /v1/distribution/routes?date=` و`/:id` | `tasks:read` | القائمة، والتفاصيل بالتوقفات وقائمة التحميل والمطابقة وفرق النقد |
| `POST /v1/distribution/routes/:id/cancel` | `tasks:assign` | قبل الانطلاق فقط (`planned` أو `loaded`)، مع سبب |
| `POST /v1/distribution/routes/:id/settle` | `billing:write` | `{version, cash_received, note?}` بعد العودة؛ الملاحظة إلزامية إن خالف المستلَم المحصَّل |
| `POST /v1/distribution/stops/:taskId/proof` | `tasks:write` | المكتب يسجّل التوقف نيابة عن السائق: `{delivered, returned?, cash_collected?, received_by?}` أو `{closed_reason}` |
| `GET /v1/distribution/board?date=` | `tasks:read` | مسارات اليوم وتقدّمها |
| `GET /v1/distribution/exceptions` | `tasks:read` | لم تُراجع الحمولة، متأخر، لم يُسوَّ، فرق نقد، تسليم ناقص، توقف متعذّر، مرتجعات |
| `GET /v1/distribution/report?from&to` | `reports:read` | لكل مسار في الفترة: التوقفات المنجزة والمتعذّرة، الكم، قيمة المخطط والمسلَّم والمرتجع، النقد المستحق والمحصّل، مع المجاميع |

تطبيق السائق: على المسار `task_status accepted` ← `milestone load_checked {odometer_km}` ← `in_progress` (فتنتقل التوقفات إلى «مقبولة») ← نوع عملية جديد `stop {task_id, delivered, returned?, cash_collected?, received_by?}` أو `{closed_reason}` لكل توقف ← `milestone route_back {odometer_km}` (بعد إغلاق كل التوقفات) ← `completed`. لا يُرسل `task_status` على مهمة التوقف. أسباب الرفض الجديدة: `route_not_started`، `stop_already_recorded`، `item_not_planned`، `quantity_exceeds_plan`، `cash_required`، `stops_open`. أسباب التعذّر: shop_closed, refused, no_cash, no_space, vehicle_breakdown, other.

## قطاع الشحن والنقل البري freight@1 (القطاع 2)

أمر النقل مهمة واحدة `freight@1` مع بوليصة في `ops.freight_shipment`. موعد التحميل وموعد التسليم هما نافذة المهمة، فالإسناد الحصري يحجز الشاحنة والسائق للرحلة. النشاط `freight` يُفعَّل من الإعدادات.

| الطلب | الوصف |
|---|---|
| `GET/PUT /v1/freight/settings?legal_entity_id=` | الانتظار المجاني عند كل طرف (افتراضي 120 دقيقة [تخمين]) ونسبة فرق الوزن المسموحة (2%) |
| `GET/POST /v1/freight/carriers`، `PATCH /v1/freight/carriers/:id` | الناقلون من الباطن |
| `GET /v1/freight/shipments?from&to&status=open\|done\|failed\|canceled` | الشحنات حسب موعد التحميل |
| `POST /v1/freight/shipments` | أمر نقل: `waybill_no`، `customer_id`، `mode` ftl/ltl، `cargo {description, packages, weight_kg, volume_m3}`، `pickup`، `dropoff`، `pickup_at`، `deliver_by`، `planned_km`، `bill_unit` trip/km/ton. نفس البوليصة مرة أخرى تعيد نفس الشحنة |
| `GET /v1/freight/shipments/:id` | الشحنة ومراحلها والمصاريف واختلاف الوزن |
| `POST /v1/freight/shipments/:id/plan` | المقطورة `trailer_asset_id`، أو ناقل `carrier_id` مع `carrier_cost` (يحتاج المهمة بلا سائق). الشاحنة والسائق بـ `POST /v1/tasks/:id/assign` |
| `POST /v1/freight/shipments/:id/carrier-delivered` | المكتب يسجل تسليم رحلة الناقل: `received_by`، `delivered_weight_kg` |
| `POST /v1/freight/shipments/:id/expenses` | مصروف رحلة (fuel، tolls، parking، other) يدخل التسوية |
| `GET /v1/freight/shipments/:id/settlement` | الإيراد من عقد العميل ناقص كلفة الناقل والمصاريف = الربح (تقديري قبل التسليم) |
| `GET /v1/freight/report?from&to` | ربح كل رحلة والمؤشرات: كلفة الكيلومتر، ربح الرحلة، في الموعد، استغلال الحمولة (يحتاج `capacity.kg` للشاحنة)، ساعات الانتظار |
| `GET /v1/freight/exceptions` | بلا تخطيط خلال 24 ساعة، متأخرة، انتظار بعد الوقت المجاني، اختلاف وزن |

تطبيق السائق: المراحل `at_pickup` → `loaded` (مع `weight_kg` و`seal_no` اختياريين) → بدء الرحلة → `at_dropoff` → `unloaded` (يلزم `received_by`، و`weight_kg` اختياري). البدء يحتاج `loaded` والإكمال يحتاج `unloaded`. عند الإكمال تُكتب الكميات: `trip: 1` أو `km` المخطط أو `ton` من الوزن المسلَّم، و`hour` للانتظار بعد الوقت المجاني عند كل طرف بربع الساعة. أسباب التعثر: truck_breakdown، refused_by_consignee، weight_mismatch، cargo_damaged، address_not_found، cargo_not_ready، customer_canceled، other.

## قطاع التوزيع الغذائي والتبريد coldchain (القطاع 3)

يبني على مسارات التوزيع (`distribution@1`): النشاط `coldchain` يفتح «التوزيع اليومي» و«سلسلة التبريد» حتى بدون نشاط التوزيع. المسار يحمل فئة الحرارة ونطاقها، والتوقف نافذة تسليم، والصنف تاريخ صلاحية.

| المسار | الوصف |
|---|---|
| `POST /v1/distribution/routes` | حقول إضافية: `temp_class` (`ambient`، `chilled`، `frozen`)، `temp_min` و`temp_max` (الافتراضي مبرد 0° إلى 5° ومجمد -25° إلى -18° [تخمين])؛ التوقف `window_from` و`window_to` بصيغة HH:MM بتوقيت الكيان؛ الصنف `expiry` |
| `POST /v1/distribution/routes/:id/temps` | قراءة حرارة `{reading_c, source: manual\|device\|external, device_ref, recorded_at?, stop_task_id?, note?}`؛ رقم الجهاز مطلوب لغير اليدوي. القراءات لا تُعدَّل ولا تُحذف |
| `POST /v1/driver/sync` op `temp` | `{task_id: مهمة المسار, reading_c, stop_task_id?}` بعد قبول المسار؛ op `stop` يقبل `damaged: {sku: qty}` |
| `GET /v1/coldchain/exceptions` | قراءات خارج النطاق (7 أيام)، مسارات مبردة على الطريق بلا قراءة منذ 90 دقيقة [تخمين]، تسليمات خارج النافذة، أصناف تنتهي صلاحيتها في يوم المسار أو قبله، وتالف عند التسليم |
| `GET /v1/coldchain/report?from&to` | لكل مسار وإجمالي: الالتزام بالنافذة، قيمة المسلَّم والتالف والمرتجع، نسبة التلف = تالف ÷ (مسلَّم + تالف)، نسبة المرتجعات، توقفات في الساعة، ونسبة القراءات ضمن النطاق |

أسباب تعذر إضافية: `temp_out_of_range`، `expired`، `late_window`.

## قطاع البريد والشحن السريع courier (القطاع 4)

كل شحنة مهمة توصيل `delivery@1` واحدة (فيبقى الإسناد وتطبيق السائق ورمز المستلم والدفع عند الاستلام ورابط التتبع من قطاع التوصيل) مع بوليصة في `ops.courier_parcel`. النشاط `courier` يفتح «البريد السريع» و«مركز التوصيل». مبالغ الدفع عند الاستلام في دفاتر النواة (`billing.cod_collection` و`POST /v1/cod/payouts` للمرسل).

| المسار | الوصف |
|---|---|
| `GET/POST /v1/courier/hubs`، `PATCH /v1/courier/hubs/:id` | المحطات (رمز فريد مثل KWI)، مع عدد الشحنات الموجودة فيها |
| `POST /v1/courier/parcels` | حجز شحنة: `{legal_entity_id, customer_id? (المرسل), awb? (يُولَّد KW + 10 أرقام), service: express\|same_day\|next_day, pieces, weight_kg?, origin_hub_id?, dest_hub_id?, max_attempts? (3), recipient {name, phone}, dropoff {area, ...}, cod_amount?, delivery_fee?, notes?}`. الموعد: سريع 4 ساعات، نفس اليوم 23:59، اليوم التالي 23:59 من الغد بتوقيت الكويت [تخمين]. الدفع عند الاستلام يحتاج المرسل |
| `GET /v1/courier/parcels?q&hub_id&where` | قائمة بمكان كل شحنة (`at_hub`، `in_transit`، `with_driver`، `delivered`، `rto_done`) والمحاولات الفاشلة |
| `GET /v1/courier/parcels/:id أو :awb` | التفاصيل مع المسح في المحطات وأحداث المهمة (الفشل بسببه واسم المندوب) ورمز رابط التتبع |
| `POST /v1/courier/scans` | مسح دفعة `{hub_id, event: received\|sorted\|dispatched\|arrived\|returned\|rto_out, awbs[≤500], rto?, note?}`؛ نتيجة لكل بوليصة (`unknown_awb`، `closed`، `with_driver`، `awaiting_return`، `not_failed`، `not_rto`). «returned» بعد محاولة فاشلة يعيد المهمة لقائمة الإسناد ويزيد رقم المحاولة ما بقيت محاولات، وإلا (أو مع `rto: true`) يقرر الإرجاع للمرسل؛ «rto_out» يسجل تسليمها للمرسل |
| `GET /v1/courier/exceptions` | تجاوزت موعدها، راكدة في محطة بلا مسح منذ 24 ساعة [تخمين]، فشلت ولم تعد للمحطة، تنتظر الإرجاع للمرسل |
| `GET /v1/courier/report?from&to` | للشحنات المحجوزة في الفترة، حسب الخدمة والمرسل: نسبة التسليم، من أول محاولة، في الموعد، نسبة الإرجاع، COD المحصّل |

## قطاع المستودعات warehouse (القطاع 8)

مستودع للشركة أو تخزين لعملاء (3PL). الرصيد لا يُخزَّن: هو مجموع حركات `ops.wh_movement` (سجل لا يُعدَّل: استلام، التقاط، نقل، جرد). الصنف ملك عميل (`customer_id`) أو بضاعة الشركة، وكل مستند (استلام أو أمر صرف) لأصناف مالك واحد.

| المسار | الوصف |
|---|---|
| `GET/POST /v1/warehouse/warehouses` | المستودعات مع مواقعها (الإضافة تحتاج org:write) |
| `POST /v1/warehouse/warehouses/:id/locations` | `{codes[≤500], kind: storage\|pick\|dock\|quarantine}`؛ الرموز الموجودة تُتخطى |
| `GET/POST /v1/warehouse/items`، `PATCH /v1/warehouse/items/:id` | الأصناف: `sku` فريد لكل مالك، الوحدة، حد إعادة الطلب `min_qty`، و`track_expiry` (الصلاحية إلزامية عند الاستلام)، والمتوفر |
| `POST /v1/warehouse/receipts`، `GET` | إذن استلام `{warehouse_id, customer_id?, ref, lines[{item_id, qty, location_id, lot?, expiry?}], expected?[{item_id, qty}]}`؛ يعيد الفروق عن الإشعار |
| `GET /v1/warehouse/stock?warehouse_id&customer_id&item_id` | الرصيد لكل صنف وموقع ودفعة وصلاحية |
| `POST /v1/warehouse/moves` | نقل بين موقعين في المستودع نفسه (أقدم صلاحية أولًا من المصدر) |
| `POST /v1/warehouse/counts` | جرد موقع `{item_id, location_id, counted_qty, reason, lot?}`؛ الفرق يُسجل حركة بسببه |
| `POST/GET /v1/warehouse/orders`، `GET /orders/:id` | أمر صرف `{warehouse_id, customer_id?, ref, lines, ship_to?, due_at?}`؛ التفاصيل تعرض خطة الالتقاط المقترحة وما ينقص |
| `POST /orders/:id/pick` | التقاط بأقدم صلاحية أولًا (بلا صلاحية آخرًا، ثم الموقع الأصغر رصيدًا)، يتخطى الحجر والمنتهي، كله أو لا شيء (409 مع `short`) |
| `POST /orders/:id/ship` | `{delivery?: true}` ينشئ مهمة توصيل `delivery@1` لأسطولنا (يحتاج نشاط التوصيل أو البريد السريع، وجوال ومنطقة في `ship_to`) |
| `POST /orders/:id/cancel` | `{reason}`؛ الأمر المجموع تعود بضاعته لمواقعها |
| `GET /v1/warehouse/exceptions` | تحت حد الطلب، صلاحية منتهية أو خلال 30 يومًا [تخمين]، أوامر متأخرة (الموعد أو 24 ساعة [تخمين])، استلامات بفروق (7 أيام) |
| `GET /v1/warehouse/report?from&to` | لكل مالك: استلامات ووحدات مستلمة ومصروفة وفروق الجرد وأوامر مشحونة والالتزام بالموعد ومتوسط ساعات الشحن والمخزون والمواقع المشغولة الآن |
