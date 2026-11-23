-- 0040: وحدة مكافحة الحشرات والقوارض (pest، القطاع 26): زيارات علاج لمنازل ومطاعم ومنشآت العملاء.
-- سجل المبيدات: كل مبيد بمادته الفعالة ورقم تسجيله لدى الجهة المختصة ووحدته ومدة منع الدخول بعد الرش. أمر المكافحة (PC-n)
-- لعميل في موقع: نوع المنشأة والآفات المستهدفة ونوع الخدمة والموعد والفني (يجب أن يحمل ترخيص مبيدات ساريًا يوم الزيارة).
-- الفني يسجّل الوصول ثم العلاج: المبيدات المستخدمة بكمياتها وأماكنها (سجل لا يُعدَّل)، ومستوى الإصابة، واسم المستلم؛
-- ويُحسب وقت السماح بالدخول من أطول مدة منع بين المبيدات. الضمان: إعادة الزيارة خلال مدته مجانية (أمر تابع)؛ والتكرار:
-- أمر بفاصل أيام يُنشئ الأمر التالي عند إغلاقه (عقود المطاعم الشهرية مثلًا).

CREATE TABLE ops.pc_product (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  active_ingredient text CHECK (length(active_ingredient) <= 120),
  registration_no text CHECK (length(registration_no) <= 60),        -- رقم تسجيل المبيد لدى الجهة المختصة
  unit text NOT NULL CHECK (unit IN ('ml','l','g','kg','unit')),
  reentry_hours smallint NOT NULL DEFAULT 0 CHECK (reentry_hours BETWEEN 0 AND 72),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX pc_product_name ON ops.pc_product (tenant_id, lower(name)) WHERE active;

CREATE TABLE ops.pc_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^PC-[0-9]{1,9}$'),
  customer_id uuid NOT NULL,
  premises text NOT NULL CHECK (premises IN ('home','restaurant','office','warehouse','hospital','school','other')),
  area text NOT NULL CHECK (length(area) BETWEEN 1 AND 80),
  address text CHECK (length(address) <= 200),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  contact_phone text CHECK (length(contact_phone) <= 20),
  pests text[] NOT NULL CHECK (cardinality(pests) BETWEEN 1 AND 10),
  service text NOT NULL CHECK (service IN ('spray','gel','bait','fumigation','inspection')),
  scheduled_at timestamptz NOT NULL,
  duration_min smallint NOT NULL DEFAULT 90 CHECK (duration_min BETWEEN 15 AND 600),
  warranty_days smallint NOT NULL DEFAULT 30 CHECK (warranty_days BETWEEN 0 AND 365),
  repeat_days smallint CHECK (repeat_days BETWEEN 7 AND 365),         -- عقد دوري: الأمر التالي بعد هذا الفاصل
  parent_job_id uuid,                                                   -- إعادة زيارة ضمن الضمان
  in_warranty boolean NOT NULL DEFAULT false,
  notes text CHECK (length(notes) <= 500),
  task_id uuid,
  arrived_at timestamptz,
  treated_at timestamptz,
  infestation text CHECK (infestation IN ('none','low','medium','high')),
  received_by text CHECK (length(received_by) <= 120),
  result_note text CHECK (length(result_note) <= 500),
  reentry_at timestamptz,                                               -- لا دخول قبل هذا الوقت
  next_job_id uuid,
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, task_id),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (treated_at IS NULL OR (infestation IS NOT NULL AND received_by IS NOT NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_job_id) REFERENCES ops.pc_job (tenant_id, id)
);
CREATE INDEX pc_job_scheduled ON ops.pc_job (tenant_id, scheduled_at);
REVOKE DELETE, TRUNCATE ON ops.pc_job FROM app_rw;

-- المبيد المستخدم في زيارة: الكمية والمكان؛ سجل لا يُعدَّل
CREATE TABLE ops.pc_application (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  product_id uuid NOT NULL,
  qty numeric(9,2) NOT NULL CHECK (qty > 0 AND qty <= 100000),
  location text CHECK (length(location) <= 120),
  applied_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('technician','office')),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES ops.pc_job (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES ops.pc_product (tenant_id, id)
);
CREATE INDEX pc_application_job ON ops.pc_application (tenant_id, job_id);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.pc_application FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','utilities','security','pest','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'pest')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','utilities','security','distribution'] AND NOT ('pest' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
