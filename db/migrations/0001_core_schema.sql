-- 0001: المخطط الأساسي (المرحلة C بعد إصلاحات المرحلة E)
-- الامتدادات تُنشأ في db/bootstrap.sql بصلاحية superuser
CREATE SCHEMA IF NOT EXISTS org;  CREATE SCHEMA IF NOT EXISTS fleet; CREATE SCHEMA IF NOT EXISTS workforce;
CREATE SCHEMA IF NOT EXISTS shift; CREATE SCHEMA IF NOT EXISTS ops;   CREATE SCHEMA IF NOT EXISTS geo;
CREATE SCHEMA IF NOT EXISTS billing; CREATE SCHEMA IF NOT EXISTS core;

-- app_rw (دور التطبيق) يقرأ ويكتب فقط، بلا TRUNCATE وبلا ملكية
GRANT USAGE ON SCHEMA org, fleet, workforce, shift, ops, geo, billing, core TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA org, fleet, workforce, shift, ops, geo, billing, core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA org, fleet, workforce, shift, ops, geo, billing, core
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- A: المؤسسات
CREATE TABLE org.tenant (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('trial','active','past_due','suspended','closed')),
  data_region text NOT NULL DEFAULT 'gcc-1',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE org.legal_entity (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES org.tenant(id),
  name text NOT NULL,
  country char(2) NOT NULL DEFAULT 'KW',
  currency char(3) NOT NULL DEFAULT 'KWD',
  timezone text NOT NULL DEFAULT 'Asia/Kuwait',
  cr_number text,                       -- السجل التجاري [تحقق محلي]
  UNIQUE (tenant_id, id)
);
CREATE TABLE org.branch (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  name text NOT NULL,
  location geography(Point,4326),
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity(tenant_id, id)
);
CREATE TABLE org.app_user (              -- هوية عامة، قد تنتمي لعدة مؤسسات
  id uuid PRIMARY KEY,
  phone text UNIQUE, email text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE org.role (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES org.tenant(id),  -- NULL = دور قياسي من المنصة
  code text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE org.membership (            -- مستخدم ↔ شركة ↔ دور ↔ نطاق
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES org.tenant(id),
  user_id uuid NOT NULL REFERENCES org.app_user(id),
  role_id uuid NOT NULL REFERENCES org.role(id),
  scope_legal_entity_ids uuid[],        -- NULL = كل الشركات
  scope_branch_ids uuid[],
  valid_until timestamptz,              -- للمقاولين والوصول المؤقت
  UNIQUE (tenant_id, user_id, role_id)
);

-- B وC: المركبات والعاملون
CREATE TABLE fleet.asset (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  asset_type text NOT NULL,             -- car, bike, van, truck, mixer, pump ...
  plate_no text,
  status text NOT NULL CHECK (status IN ('available','in_use','out_of_service','retired')),
  capacity jsonb NOT NULL DEFAULT '{}', -- مثل {"m3":9} للخلّاطة
  UNIQUE (tenant_id, plate_no)
);
CREATE TABLE workforce.worker (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  user_id uuid REFERENCES org.app_user(id),
  kind text NOT NULL CHECK (kind IN ('driver','courier','technician','supervisor','guard')),
  employer_party_id uuid,               -- جهة التوظيف إن اختلفت (M11)
  status text NOT NULL DEFAULT 'active'
);

-- C2: المناوبات
CREATE TABLE shift.shift (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  worker_id uuid NOT NULL REFERENCES workforce.worker(id),
  asset_id uuid REFERENCES fleet.asset(id),
  period tstzrange NOT NULL,            -- المخطط
  started_at timestamptz, ended_at timestamptz,
  tracking_enabled boolean NOT NULL DEFAULT false
);

-- E: العمليات
CREATE TABLE ops.job (                  -- طلب العميل الذي قد يولّد عدة مهام
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  customer_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE ops.task (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL, branch_id uuid,
  job_id uuid,
  sector_pack text NOT NULL,            -- delivery@1, concrete@1 ...
  status text NOT NULL CHECK (status IN ('draft','ready','assigned','accepted','in_progress',
                                         'completed','reviewed','invoiced','failed','canceled')),
  service_window tstzrange,             -- (window كلمة محجوزة في PostgreSQL)
  customer_id uuid, version integer NOT NULL DEFAULT 1,  -- قفل تفاؤلي
  attributes jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES ops.job (tenant_id, id)
);
CREATE TABLE ops.assignment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES ops.task(id),
  worker_id uuid NOT NULL, asset_id uuid, exclusive boolean NOT NULL DEFAULT true,
  period tstzrange NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE ops.task_event (             -- سجل الحالات، إضافة فقط
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES ops.task(id),
  from_status text, to_status text NOT NULL,
  occurred_at timestamptz NOT NULL,     -- وقت الجهاز
  received_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid, device_id uuid,
  client_op_id uuid NOT NULL,           -- مفتاح منع التكرار
  UNIQUE (tenant_id, client_op_id)
);

-- F: المواقع (مقسم يوميًا، يُحذف القسم بعد 90 يومًا)
CREATE TABLE geo.location_point (
  tenant_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  position geography(Point,4326) NOT NULL,
  accuracy_m real, speed_mps real, heading real, battery_pct smallint,
  source text NOT NULL CHECK (source IN ('fg','bg','sync')),
  PRIMARY KEY (tenant_id, worker_id, recorded_at)
) PARTITION BY RANGE (recorded_at);
-- قسم احتياطي لنقاط خارج الأقسام اليومية (ساعة جهاز خاطئة)؛ الـ API يرفض قبلها ما خارج [الآن-7 أيام، الآن+5 دقائق]
CREATE TABLE geo.location_point_default PARTITION OF geo.location_point DEFAULT;

-- آخر موقع لكل عامل، يُحدَّث بـ upsert مع كل دفعة (الخريطة الحية لا تقرأ جدول النقاط)
CREATE TABLE geo.last_position (
  tenant_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  position geography(Point,4326) NOT NULL,
  accuracy_m real, battery_pct smallint,
  PRIMARY KEY (tenant_id, worker_id)
);

-- I: الدفتر
CREATE TABLE billing.ledger_entry (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL, legal_entity_id uuid NOT NULL,
  journal_id uuid NOT NULL,             -- كل قيد مجموعه صفر
  account_code text NOT NULL,
  amount numeric(18,3) NOT NULL,        -- موجب مدين، سالب دائن
  currency char(3) NOT NULL,
  source_type text NOT NULL, source_id uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now()
);

-- البنية المشتركة
CREATE TABLE core.outbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event_type text NOT NULL, aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE TABLE core.idempotency_key (
  tenant_id uuid NOT NULL, key text NOT NULL,
  request_hash text NOT NULL, response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE core.audit_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_type text NOT NULL,             -- user, app, system, platform_staff
  actor_id uuid, action text NOT NULL,
  target_type text, target_id uuid,
  before jsonb, after jsonb,
  ip inet, at timestamptz NOT NULL DEFAULT now()
);
