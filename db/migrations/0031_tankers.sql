-- 0031: وحدة الصهاريج (tankers، القطاع 7): توصيل الماء (عذب أو صليبي) والديزل والكيروسين بالصهاريج لمواقع العملاء.
-- الصهريج مسجّل بنوعه (ماء أو وقود) وسعته باللتر؛ لا يُحمَّل وقود في صهريج ماء ولا أكثر من السعة.
-- كل طلب توصيل مهمة تحجز الصهريج والسائق؛ السائق يسجّل اللترات المعبأة ومصدرها، ثم المفرّغة واسم المستلم.
-- الفرق بين المعبأ والمفرّغ يُراقب. طلبات ثابتة (يوميًا أو أيام محددة) تولّد طلبات اليوم. الأسعار من المكتب لكل 1000 لتر.

-- نوع «صهريج» في سجل المركبات
ALTER TABLE fleet.asset DROP CONSTRAINT asset_type_known;
ALTER TABLE fleet.asset ADD CONSTRAINT asset_type_known CHECK (asset_type IN ('car','motorbike','van','pickup','truck','mixer','pump','trailer','bus',
  'excavator','loader','crane','forklift','bulldozer','roller','grader','tanker','other'));

CREATE TABLE ops.tnk_vehicle (
  asset_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  product_class text NOT NULL CHECK (product_class IN ('water','fuel')),
  capacity_l integer NOT NULL CHECK (capacity_l BETWEEN 500 AND 60000),
  UNIQUE (tenant_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id)
);

-- طلب ثابت: كمية من منتج لموقع العميل في أيام الأسبوع المحددة
CREATE TABLE ops.tnk_schedule (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  site jsonb NOT NULL CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),
  product text NOT NULL CHECK (product IN ('water_fresh','water_brackish','diesel','kerosene')),
  qty_l integer NOT NULL CHECK (qty_l BETWEEN 100 AND 60000),
  days smallint[] NOT NULL CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),  -- 0 الأحد … 6 السبت
  at_time time NOT NULL,
  window_min smallint NOT NULL DEFAULT 120 CHECK (window_min BETWEEN 30 AND 720),
  unit_price numeric(18,3) CHECK (unit_price >= 0),                  -- لكل 1000 لتر
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);

CREATE TABLE ops.tnk_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^TK-[0-9]{1,9}$'),
  customer_id uuid NOT NULL,
  site jsonb NOT NULL CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),
  product text NOT NULL CHECK (product IN ('water_fresh','water_brackish','diesel','kerosene')),
  qty_l integer NOT NULL CHECK (qty_l BETWEEN 100 AND 60000),
  wanted tstzrange NOT NULL CHECK (NOT isempty(wanted) AND lower(wanted) IS NOT NULL AND upper(wanted) IS NOT NULL),
  unit_price numeric(18,3) CHECK (unit_price >= 0),
  schedule_id uuid,
  sched_day date,
  task_id uuid,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  source text CHECK (length(source) <= 120),                        -- محطة التعبئة
  loaded_l integer CHECK (loaded_l BETWEEN 0 AND 60000), loaded_at timestamptz,
  delivered_l integer CHECK (delivered_l BETWEEN 0 AND 60000), delivered_at timestamptz,
  received_by text CHECK (length(received_by) <= 120),
  notes text CHECK (length(notes) <= 1000),
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, schedule_id, sched_day),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK ((delivered_l IS NULL) = (delivered_at IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES ops.tnk_schedule (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX tnk_order_day ON ops.tnk_order (tenant_id, lower(wanted));
CREATE INDEX tnk_order_task ON ops.tnk_order (tenant_id, task_id);
CREATE INDEX tnk_order_customer ON ops.tnk_order (tenant_id, customer_id);

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'tankers')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'] AND NOT ('tankers' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
