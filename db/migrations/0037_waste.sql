-- 0037: وحدة جمع النفايات والتنظيف (waste، القطاع 23): خطوط جمع ثابتة لكابسات النفايات.
-- الخط له نوع نفايات، وموعد بدء، وأيام تشغيل، وكابسة وسائق افتراضيان، ونقاط جمع مرتبة (حاويات عملاء بأنواعها وعددها).
-- كل يوم تشغيل تُولَّد جولة لكل خط: مهمة تحجز الكابسة والسائق حصريًا لمدة الجولة. السائق يسجّل كل نقطة «جُمعت» بعدد
-- الحاويات المفرّغة أو «لم تُجمع» بسبب (سجل لا يُعدَّل، وآخر تسجيل هو المعتمد)، ويسجّل كل تفريغ في المردم بتذكرة
-- الميزان والوزن الصافي. لا تنتهي الجولة قبل تسجيل كل النقاط، ولا قبل تذكرة ميزان إن جُمعت نقطة.

CREATE TABLE ops.wst_route (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  waste_type text NOT NULL DEFAULT 'general' CHECK (waste_type IN ('general','recyclable','construction','green','organic')),
  start_time time NOT NULL,
  duration_min smallint NOT NULL DEFAULT 480 CHECK (duration_min BETWEEN 30 AND 960),
  days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[]
    CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  facility text CHECK (length(facility) <= 120),                    -- المردم أو مركز الفرز الافتراضي
  asset_id uuid,
  driver_worker_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id)
);

-- نقطة جمع: حاويات عميل في موقع، على خط بترتيب
CREATE TABLE ops.wst_point (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 200),
  customer_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  area text CHECK (length(area) <= 80),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  bins jsonb NOT NULL CHECK (jsonb_typeof(bins) = 'array' AND jsonb_array_length(bins) BETWEEN 1 AND 10),   -- [{type, count}]
  note text CHECK (length(note) <= 300),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.wst_route (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
CREATE INDEX wst_point_route ON ops.wst_point (tenant_id, route_id, seq) WHERE active;

-- الجولة: خط في يوم، بمهمتها وكابستها وسائقها
CREATE TABLE ops.wst_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  run_date date NOT NULL,
  task_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  driver_worker_id uuid NOT NULL,
  points_planned smallint NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, route_id, run_date),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.wst_route (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id)
);
CREATE INDEX wst_run_date ON ops.wst_run (tenant_id, run_date);
REVOKE DELETE, TRUNCATE ON ops.wst_run FROM app_rw;

-- الجمع أو عدمه لكل نقطة: سجل لا يُعدَّل؛ آخر تسجيل للنقطة في الجولة هو المعتمد
CREATE TABLE ops.wst_visit (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  point_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('collected','missed')),
  bins smallint CHECK (bins BETWEEN 0 AND 200),
  reason text CHECK (reason IN ('no_access','bins_not_out','blocked','contaminated','other')),
  note text CHECK (length(note) <= 300),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('driver','office')),
  actor_id uuid,
  client_op_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  CHECK (event <> 'missed' OR reason IS NOT NULL),
  CHECK (event <> 'collected' OR bins IS NOT NULL),
  FOREIGN KEY (tenant_id, run_id) REFERENCES ops.wst_run (tenant_id, id),
  FOREIGN KEY (tenant_id, point_id) REFERENCES ops.wst_point (tenant_id, id)
);
CREATE INDEX wst_visit_run ON ops.wst_visit (tenant_id, run_id, point_id, occurred_at DESC);
CREATE INDEX wst_visit_point ON ops.wst_visit (tenant_id, point_id, occurred_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.wst_visit FROM app_rw;

-- التفريغ في المردم أو مركز الفرز: تذكرة الميزان والوزن الصافي
CREATE TABLE ops.wst_dump (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  ticket_no text NOT NULL CHECK (length(ticket_no) BETWEEN 1 AND 40),
  facility text CHECK (length(facility) <= 120),
  net_kg numeric(9,1) NOT NULL CHECK (net_kg > 0 AND net_kg <= 40000),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('driver','office')),
  actor_id uuid,
  client_op_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  UNIQUE (tenant_id, run_id, ticket_no),
  FOREIGN KEY (tenant_id, run_id) REFERENCES ops.wst_run (tenant_id, id)
);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.wst_dump FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'waste')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','distribution'] AND NOT ('waste' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
