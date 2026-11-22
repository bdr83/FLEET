# نشر المنصة للتجربة الأولى (pilot)

خادم واحد يشغّل كل شيء بـ Docker Compose: قاعدة البيانات (PostgreSQL 16 + PostGIS)، مهمة الترحيل، الخادم (API)، لوحة التحكم (web)، و Caddy لشهادات HTTPS التلقائية. يناسب التجربة الأولى بعدد محدود من الشركات؛ الانتقال لقاعدة بيانات مُدارة وأكثر من خادم لاحقًا لا يغيّر الصور.

## ما تحتاجه قبل البدء

| البند | لماذا |
|---|---|
| خادم Linux في منطقة سحابية خليجية (قرار معتمد)، 2 vCPU و 4 GB ذاكرة و 40 GB قرص كبداية [تخمين] | يشغّل الحاويات الخمس |
| نطاق ونطاقان فرعيان: `app.` للوحة و`api.` لتطبيق السائق | شهادة HTTPS لكل منهما |
| حساب مزوّد رسائل نصية ببوابة HTTP | رمز الدخول (OTP)؛ الخادم يرفض العمل في الإنتاج بدونه |
| مزوّد بلاطات خريطة للإنتاج | خوادم OpenStreetMap العامة للتطوير فقط |

## أول تشغيل

```bash
# على الخادم (Ubuntu): Docker و git
curl -fsSL https://get.docker.com | sh
sudo mkdir -p /opt/fleet && sudo chown "$USER" /opt/fleet && cd /opt/fleet
git clone https://github.com/bdr83/FLEET.git . && cd deploy
cp .env.example .env && chmod 600 .env
# عدّل .env: النطاقان، كلمات المرور والأسرار (openssl rand -hex 32)، ومزوّد الرسائل
echo "$GHCR_TOKEN" | docker login ghcr.io -u bdr83 --password-stdin   # الصور خاصة: رمز GitHub بصلاحية read:packages
docker compose up -d
docker compose ps        # كل الخدمات healthy، و migrate خرجت بنجاح
curl https://api.<النطاق>/health   # {"status":"ok"}
```

سجلّا DNS من نوع A للنطاقين يجب أن يشيرا للخادم قبل التشغيل، والمنفذان 80 و 443 مفتوحان، وإلا لن تصدر الشهادة.

## التحديث

كل دمج في main ينجح فيه CI ينشر صورًا جديدة على `ghcr.io/bdr83/fleet-{api,web,migrate}` بوسم `latest` وبرقم الالتزام. على الخادم:

```bash
cd /opt/fleet/deploy && git pull && ./update.sh        # نسخة احتياطية، ثم سحب الصور، ثم الترحيل والتشغيل
TAG=<رقم الالتزام> ./update.sh                          # الرجوع لإصدار سابق
```

الترحيلات تُطبَّق تلقائيًا في كل تشغيل (مهمة migrate) وهي آمنة للتكرار. الرجوع لإصدار أقدم لا يلغي ترحيلًا طُبِّق؛ لذلك كل ترحيل يضيف ولا يحذف.

## النسخ الاحتياطي والاستعادة

```bash
crontab -e   # يوميًا 02:15 UTC
15 2 * * *  cd /opt/fleet/deploy && ./backup.sh >> backups/backup.log 2>&1
./restore.sh backups/fleet-YYYYMMDDTHHMMSSZ.dump   # يطلب كتابة restore للتأكيد
```

النسخ تُحفظ 14 يومًا في `deploy/backups`. [تحقق محلي] انسخها يوميًا إلى تخزين خارج الخادم في المنطقة نفسها، وجرّب الاستعادة على خادم آخر مرة شهريًا.

## خادم مشترك فيه nginx موجود (مثل خادم Hostinger الحالي)

لا يُشغَّل Caddy (`COMPOSE_PROFILES=none`)، ويُضم الخادم واللوحة إلى شبكة الـ nginx الموجود (`docker-compose.shared.yml`) باسمي `fleet-api` و`fleet-web`. تشغيل workflow ‏deploy مع خيار **proxy_setup** مرة واحدة ينفّذ `nginx-shared.sh`: نسخة احتياطية من ملف إعداد nginx، كتلة المنفذ 80 لتحدي ACME، شهادة Let's Encrypt بطريقة webroot، ثم كتلتا HTTPS، مع `nginx -t` قبل كل إعادة تحميل والرجوع للنسخة الاحتياطية عند الفشل. الكتل محصورة بين علامتي `fleet-begin` و`fleet-end` فلا تتكرر. وتوقّف المنصة لا يمنع nginx من الإقلاع (العنوان يُحَل وقت الطلب).

متغيرات GitHub لهذا الوضع: `COMPOSE_PROFILES=none`، `COMPOSE_FILE=docker-compose.yml:docker-compose.shared.yml`، `EDGE_NETWORK`، `NGINX_CONTAINER`، `NGINX_CONF`، `ACME_WEBROOT`، `ACME_WEBROOT_IN`.

[تحقق محلي] جُرّب مع nginx 1.27 في حاوية: الموقع الآخر يبقى يعمل، والمنصة تعمل بـ HTTPS عبره، والتكرار لا يضاعف الكتل، وإعداد خاطئ يُرجَع تلقائيًا.

## النشر عبر runner على الخادم (بلا مفتاح SSH)

بديل أسهل من مفتاح SSH: `deploy/install-runner.sh` يثبّت GitHub Actions runner على الخادم كخدمة باسم `<hostname>-fleet` ووسم `fleet-pilot`، ويطلب فقط رمز التسجيل من صفحة Settings → Actions → Runners → New self-hosted runner. بعدها workflow ‏**deploy-runner** ينشر محليًا على الخادم بالإعدادات من متغير `SERVER_ENV`. [تخمين] الـ runner يعمل بصلاحية root للتجربة لأنه يعدّل nginx المشترك ويصدر الشهادات؛ المستودع خاص ولا يشغّله إلا هذا الـ workflow.

## الدخول والبريد

- الموقع يدخل بالبريد وكلمة المرور. أول حساب: افتح لوحة التحكم ← «حساب جديد» ← أنشئ شركتك، فتصبح مالكها. بعدها تضيف المستخدمين من الإعدادات ← المستخدمون، بالبريد مع كلمة مرور أولى.
- رسائل «نسيت كلمة المرور» تحتاج SMTP: أضف السر `SMTP_URL` في GitHub (مثل `smtps://no-reply%40النطاق:كلمة_المرور@smtp.hostinger.com:465`) والسطر `MAIL_FROM=FLEET <no-reply@النطاق>` في `SERVER_ENV`، ثم أعد النشر. بدونها يختفي رابط الاستعادة.
- الدخول برقم الجوال يظهر فقط مع `LOGIN_PHONE=1` ومزود SMS.

## تطبيق السائق

في إعدادات المستودع على GitHub (Settings → Secrets and variables → Actions → Variables) أضف `DRIVER_API_URL=https://api.<النطاق>`، ثم شغّل workflow ‏driver-app يدويًا لبناء APK يتصل بالخادم.

## الأسرار والأمان

- `.env` لا يُرفع إلى git، وصلاحيته 600.
- قاعدة البيانات لا تُفتح للإنترنت؛ الخادم يتصل بها بدور `app_rw` المقيّد بعزل الشركات (RLS).
- `OTP_DEV_ECHO` لا يعمل في الإنتاج، و`SMS_PROVIDER=log` مرفوض فيه.
- نقاط المواقع تُحذف بعد 90 يومًا (`LOCATION_RETENTION_DAYS`).

## ما جُرِّب

[تحقق محلي] شُغّلت الحزمة كاملة في بيئة التطوير بنطاقات `*.localhost`: الترحيل من الصفر (18 ترحيلًا)، الخادم واللوحة بحالة healthy خلف Caddy بـ HTTPS، رفض الدخول بوضوح (503) حين تكون بوابة الرسائل غير متاحة، ونسخة احتياطية ثم استعادة كاملة. بناء الصور نفسها يتم على GitHub Actions.
