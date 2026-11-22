-- 0028: وحدة الصيانة الفنية (service، القطاع 22): فنيون يزورون مواقع العملاء لإصلاح أو صيانة أجهزة (تكييف، كهرباء، سباكة،
-- أجهزة منزلية، مصاعد، مولدات). البلاغ (أمر عمل) له أولوية وموعد استجابة؛ كل زيارة مهمة (ops.task) تحجز الفني حصريًا لنافذتها.
-- الفني يسجّل الوصول، ثم نتيجة الزيارة (أُصلح، يحتاج زيارة أخرى، لم يُصلح) مع وصف العمل والقطع المستخدمة واسم العميل.
-- عقود الصيانة الدورية تولّد بلاغات وقائية كل فترة. الأسعار من المكتب عند إغلاق البلاغ أو من عقد العميل.

CREATE TABLE ops.svc_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^WO-[0-9]{1,9}$'),
  customer_id uuid NOT NULL,
  site jsonb NOT NULL CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),   -- {name?, area, block?, street?, building?, lat?, lng?, contact?, phone?}
  category text NOT NULL CHECK (category IN ('ac','electrical','plumbing','appliance','elevator','generator','other')),
  kind text NOT NULL DEFAULT 'repair' CHECK (kind IN ('repair','install','preventive')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','normal','low')),
  problem text NOT NULL CHECK (length(problem) BETWEEN 1 AND 1000),
  unit jsonb CHECK (unit IS NULL OR (jsonb_typeof(unit) = 'object' AND length(unit::text) <= 1000)),  -- {brand?, model?, serial?, location?}
  due_by timestamptz NOT NULL,                                       -- موعد الاستجابة المطلوب
  plan_id uuid,
  outcome text CHECK (outcome IN ('fixed','not_fixed')),
  labour_amount numeric(18,3) CHECK (labour_amount >= 0),
  parts_amount numeric(18,3) CHECK (parts_amount >= 0),
  closed_at timestamptz, closed_by uuid,
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (closed_at IS NULL OR canceled_at IS NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
CREATE INDEX svc_job_customer ON ops.svc_job (tenant_id, customer_id);
CREATE INDEX svc_job_open ON ops.svc_job (tenant_id, due_by) WHERE closed_at IS NULL AND canceled_at IS NULL;

-- زيارة الفني: مهمة تحجزه لنافذة الزيارة
CREATE TABLE ops.svc_visit (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 50),
  arrived_at timestamptz,
  result text CHECK (result IN ('fixed','follow_up','not_fixed')),
  work_done text CHECK (length(work_done) <= 1000),
  signed_by text CHECK (length(signed_by) <= 120),
  finished_at timestamptz,
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, job_id, seq),
  CHECK ((result IS NULL) = (finished_at IS NULL)),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES ops.svc_job (tenant_id, id)
);
CREATE INDEX svc_visit_job ON ops.svc_visit (tenant_id, job_id);

-- القطع المستخدمة في الزيارة (الكمية من الفني، السعر من المكتب عند الإغلاق)
CREATE TABLE ops.svc_part (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  qty numeric(10,2) NOT NULL CHECK (qty > 0 AND qty <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.svc_visit (tenant_id, task_id)
);
CREATE INDEX svc_part_task ON ops.svc_part (tenant_id, task_id);
REVOKE DELETE, TRUNCATE ON ops.svc_part FROM app_rw;

-- عقد الصيانة الدورية: بلاغ وقائي كل فترة لموقع العميل
CREATE TABLE ops.svc_plan (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  site jsonb NOT NULL CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),
  category text NOT NULL CHECK (category IN ('ac','electrical','plumbing','appliance','elevator','generator','other')),
  every_days smallint NOT NULL CHECK (every_days BETWEEN 7 AND 366),
  next_due date NOT NULL,
  ends_on date,
  tasks_note text CHECK (length(tasks_note) <= 1000),                -- ما يُفحص في كل زيارة
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (ends_on IS NULL OR ends_on >= next_due - every_days),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
ALTER TABLE ops.svc_job ADD FOREIGN KEY (tenant_id, plan_id) REFERENCES ops.svc_plan (tenant_id, id);

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'service')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','distribution'] AND NOT ('service' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
