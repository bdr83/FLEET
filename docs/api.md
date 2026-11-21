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
