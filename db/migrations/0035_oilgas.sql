-- 0035: وحدة خدمات النفط والغاز (oilgas، القطاع 18): مقاولو النفط ينقلون الطواقم والمعدات والمواد إلى مواقع الحقول.
-- الموقع (حقل، مركز تجميع، منصة حفر) له وثائق إلزامية للسائق (مثل H2S والقيادة الوقائية وتصريح الدخول) وللمركبة (فحص وملصق).
-- كل رحلة خطة رحلة (JM-n) يعتمدها مدير الرحلات قبل الانطلاق، وتحجز المركبة والسائق حصريًا، ولا يُسند لها سائق أو مركبة
-- بوثائق ناقصة أو منتهية قبل نهاية الرحلة. السائق يفحص المركبة قبل الانطلاق، ويبلغ موقعه كل فترة، ويسجّل الوصول؛
-- رحلة بلا بلاغ في موعده أو لم تصل في وقتها تظهر إنذارًا.

-- رموز الوثائق تقبل الأرقام (h2s)
ALTER TABLE core.document DROP CONSTRAINT document_doc_type_check;
ALTER TABLE core.document ADD CONSTRAINT document_doc_type_check CHECK (doc_type ~ '^[a-z][a-z0-9_]{1,39}$');

CREATE TABLE ops.og_site (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid,                                                  -- الشركة المشغّلة أو المقاول الرئيسي
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  field text CHECK (length(field) <= 80),                            -- الحقل أو المنطقة (برقان، الروضتين…)
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  worker_docs text[] NOT NULL DEFAULT '{}' CHECK (cardinality(worker_docs) <= 12),
  asset_docs text[] NOT NULL DEFAULT '{}' CHECK (cardinality(asset_docs) <= 12),
  h2s_zone boolean NOT NULL DEFAULT false,
  checkin_min smallint NOT NULL DEFAULT 60 CHECK (checkin_min BETWEEN 15 AND 240),
  notes text CHECK (length(notes) <= 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);

-- خطة الرحلة: موقع، غرض، انطلاق ووصول متوقع ونهاية، ركاب وحمولة (خطرة أو لا)، اعتماد، ومهمة تحجز المركبة والسائق
CREATE TABLE ops.og_journey (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^JM-[0-9]{1,9}$'),
  site_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('crew','equipment','materials','water','waste','other')),
  from_place text NOT NULL CHECK (length(from_place) BETWEEN 1 AND 200),
  depart_at timestamptz NOT NULL,
  eta_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  passengers smallint NOT NULL DEFAULT 0 CHECK (passengers BETWEEN 0 AND 60),
  cargo text CHECK (length(cargo) <= 300),
  hazmat boolean NOT NULL DEFAULT false,
  notes text CHECK (length(notes) <= 500),
  task_id uuid,
  attempts smallint NOT NULL DEFAULT 0,
  approved_by uuid, approved_at timestamptz,
  inspected_at timestamptz, departed_at timestamptz, last_checkin_at timestamptz, checkins smallint NOT NULL DEFAULT 0, arrived_at timestamptz,
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, task_id),
  CHECK (depart_at < eta_at AND eta_at <= end_at AND end_at <= depart_at + interval '3 days'),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES ops.og_site (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX og_journey_depart ON ops.og_journey (tenant_id, depart_at);
REVOKE DELETE, TRUNCATE ON ops.og_journey FROM app_rw;

-- فحص المركبة قبل الانطلاق: سجل لا يُعدَّل (الناجح والراسب)
CREATE TABLE ops.og_inspection (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  journey_id uuid NOT NULL,
  task_id uuid NOT NULL,
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'object'),
  passed boolean NOT NULL,
  failed_items text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  actor_id uuid,
  client_op_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  FOREIGN KEY (tenant_id, journey_id) REFERENCES ops.og_journey (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX og_inspection_journey ON ops.og_inspection (tenant_id, journey_id, occurred_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.og_inspection FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'oilgas')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','concrete','internal','service','distribution'] AND NOT ('oilgas' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
