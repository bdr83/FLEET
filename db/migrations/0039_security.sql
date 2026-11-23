-- 0039: وحدة الحراسة والدوريات (security، القطاع 25): مواقع عملاء تُحرس بجولات تفتيش دورية.
-- الموقع لعميل، وله نقاط تفتيش مرتبة (لكل نقطة رمز مثبت في المكان يُدخله الحارس أو يمسحه دليلًا على المرور)، ومواعيد
-- جولات في اليوم، وأيام تشغيل، وحارس افتراضي، وسيارة دورية اختيارية. كل موعد في يوم تشغيل تُولَّد له جولة: مهمة تحجز الحارس
-- (والسيارة إن وُجدت) حصريًا لمدة الجولة. الحارس يسجّل كل نقطة «مُسحت» بالرمز الصحيح أو «لم تُفحص» بسبب (سجل لا يُعدَّل،
-- وآخر تسجيل هو المعتمد)، ويبلّغ عن الحوادث (تسلل، سرقة، حريق، ضرر، اشتباه...) بدرجة خطورتها. لا تنتهي الجولة قبل تسجيل
-- كل النقاط. الحادث يبقى مفتوحًا حتى يغلقه المكتب بملاحظة.

CREATE TABLE ops.sec_site (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  customer_id uuid,
  area text CHECK (length(area) <= 80),
  address text CHECK (length(address) <= 200),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  patrol_times text[] NOT NULL DEFAULT ARRAY[]::text[]                -- مواعيد الجولات HH:MM
    CHECK (cardinality(patrol_times) <= 24),
  duration_min smallint NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 10 AND 480),
  days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[]
    CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  guard_worker_id uuid,
  asset_id uuid,                                                      -- سيارة الدورية (اختيارية)
  instructions text CHECK (length(instructions) <= 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, guard_worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id)
);

-- نقطة تفتيش في الموقع، بترتيب، ورمزها المثبت في المكان
CREATE TABLE ops.sec_checkpoint (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 100),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  tag text NOT NULL CHECK (tag ~ '^[A-Z0-9][A-Z0-9-]{2,23}$'),
  note text CHECK (length(note) <= 300),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES ops.sec_site (tenant_id, id)
);
CREATE INDEX sec_checkpoint_site ON ops.sec_checkpoint (tenant_id, site_id, seq) WHERE active;
CREATE UNIQUE INDEX sec_checkpoint_tag ON ops.sec_checkpoint (tenant_id, site_id, tag) WHERE active;

-- الجولة: موعد في يوم، بمهمتها وحارسها
CREATE TABLE ops.sec_patrol (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  patrol_date date NOT NULL,
  slot text NOT NULL CHECK (slot ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  task_id uuid NOT NULL,
  guard_worker_id uuid NOT NULL,
  asset_id uuid,
  checkpoints_planned smallint NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, site_id, patrol_date, slot),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES ops.sec_site (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, guard_worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id)
);
CREATE INDEX sec_patrol_date ON ops.sec_patrol (tenant_id, patrol_date);
REVOKE DELETE, TRUNCATE ON ops.sec_patrol FROM app_rw;

-- مرور الحارس بكل نقطة أو عدمه: سجل لا يُعدَّل؛ آخر تسجيل للنقطة في الجولة هو المعتمد
CREATE TABLE ops.sec_scan (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  patrol_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('scanned','skipped')),
  reason text CHECK (reason IN ('no_access','locked','unsafe','other')),
  note text CHECK (length(note) <= 300),
  occurred_at timestamptz NOT NULL,
  lat double precision, lng double precision,
  source text NOT NULL CHECK (source IN ('guard','office')),
  actor_id uuid,
  client_op_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  CHECK (event <> 'skipped' OR reason IS NOT NULL),
  FOREIGN KEY (tenant_id, patrol_id) REFERENCES ops.sec_patrol (tenant_id, id),
  FOREIGN KEY (tenant_id, checkpoint_id) REFERENCES ops.sec_checkpoint (tenant_id, id)
);
CREATE INDEX sec_scan_patrol ON ops.sec_scan (tenant_id, patrol_id, checkpoint_id, occurred_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.sec_scan FROM app_rw;

-- حادث في موقع: من الحارس أثناء الجولة أو من المكتب؛ يغلقه المكتب بملاحظة
CREATE TABLE ops.sec_incident (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  patrol_id uuid,
  ref text NOT NULL CHECK (ref ~ '^IN-[0-9]{1,9}$'),
  category text NOT NULL CHECK (category IN ('intrusion','theft','fire','damage','suspicious','medical','safety','other')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL,
  lat double precision, lng double precision,
  source text NOT NULL CHECK (source IN ('guard','office')),
  reported_by uuid,
  client_op_id uuid NOT NULL,
  closed_at timestamptz,
  close_note text CHECK (length(close_note) <= 500),
  closed_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, client_op_id),
  CHECK ((closed_at IS NULL) = (close_note IS NULL)),
  FOREIGN KEY (tenant_id, site_id) REFERENCES ops.sec_site (tenant_id, id),
  FOREIGN KEY (tenant_id, patrol_id) REFERENCES ops.sec_patrol (tenant_id, id)
);
CREATE INDEX sec_incident_open ON ops.sec_incident (tenant_id, occurred_at DESC) WHERE closed_at IS NULL;
REVOKE DELETE, TRUNCATE ON ops.sec_incident FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','utilities','security','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'security')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','utilities','distribution'] AND NOT ('security' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
