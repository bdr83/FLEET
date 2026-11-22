-- 0020: وحدة الشحن والنقل البري (freight@1، القطاع 2): أمر نقل من عميل، يُخطَّط على شاحنة ومقطورة وسائق من أسطولنا
-- أو على ناقل من الباطن، ثم تحميل (الوزن والختم) وطريق وتفريغ بإثبات استلام، وتسوية الرحلة: الإيراد ناقص كلفة الناقل والمصاريف.
-- كل شحنة مهمة (ops.task) واحدة، فيبقى الإسناد والتتبع وتطبيق السائق والفوترة من النواة.

-- إعدادات لكل شركة قانونية: وقت الانتظار المجاني عند التحميل والتفريغ قبل احتساب الحجز (detention) [تخمين] يُضبط مع أول عميل
CREATE TABLE ops.freight_settings (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  free_detention_minutes integer NOT NULL DEFAULT 120 CHECK (free_detention_minutes BETWEEN 0 AND 1440),
  weight_tolerance_pct numeric(5,2) NOT NULL DEFAULT 2 CHECK (weight_tolerance_pct BETWEEN 0 AND 50),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- الناقلون من الباطن (شركات أو أصحاب شاحنات)
CREATE TABLE ops.freight_carrier (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone text CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  cr_number text CHECK (length(cr_number) <= 40),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, name),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- الشحنة: بوليصة النقل والحمولة ونقطتا التحميل والتفريغ، ووحدة الفوترة، والتخطيط، وما سُجّل عند التحميل والتفريغ
CREATE TABLE ops.freight_shipment (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  waybill_no text NOT NULL CHECK (waybill_no ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'),
  mode text NOT NULL DEFAULT 'ftl' CHECK (mode IN ('ftl','ltl')),            -- شاحنة كاملة أو حمولة جزئية
  cargo jsonb NOT NULL CHECK (jsonb_typeof(cargo) = 'object'),               -- {description, packages, weight_kg, volume_m3}
  pickup jsonb NOT NULL CHECK (jsonb_typeof(pickup) = 'object'),
  dropoff jsonb NOT NULL CHECK (jsonb_typeof(dropoff) = 'object'),
  planned_km integer CHECK (planned_km BETWEEN 1 AND 20000),
  bill_unit text NOT NULL DEFAULT 'trip' CHECK (bill_unit IN ('trip','km','ton')),
  trailer_asset_id uuid,
  carrier_id uuid,
  carrier_cost numeric(12,3) CHECK (carrier_cost >= 0),
  loaded_weight_kg numeric(10,1) CHECK (loaded_weight_kg >= 0),
  seal_no text CHECK (length(seal_no) <= 40),
  delivered_weight_kg numeric(10,1) CHECK (delivered_weight_kg >= 0),
  received_by text CHECK (length(received_by) <= 120),
  pod_file_key text CHECK (length(pod_file_key) <= 300),
  delivered_at timestamptz,
  detention_minutes integer CHECK (detention_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, waybill_no),
  CHECK (bill_unit <> 'km' OR planned_km IS NOT NULL),
  CHECK (carrier_id IS NULL OR carrier_cost IS NOT NULL),
  CHECK (delivered_at IS NULL OR received_by IS NOT NULL),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, trailer_asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, carrier_id) REFERENCES ops.freight_carrier (tenant_id, id)
);
CREATE INDEX freight_shipment_carrier ON ops.freight_shipment (tenant_id, carrier_id) WHERE carrier_id IS NOT NULL;
REVOKE DELETE, TRUNCATE ON ops.freight_shipment FROM app_rw;

-- مصاريف الرحلة (ديزل، رسوم، مبيت ...) تُربط بالشحنة لتسوية ربحها
ALTER TABLE maint.expense ADD COLUMN task_id uuid;
ALTER TABLE maint.expense ADD CONSTRAINT expense_task_fk FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id);
CREATE INDEX expense_task ON maint.expense (tenant_id, task_id) WHERE task_id IS NOT NULL;

-- النشاط الجديد يُعرض على الشركات وتختاره من الإعدادات؛ الشركات الجديدة دون قائمة تحصل على كل الأنشطة
ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','staffing','concrete','internal','distribution'];

-- الشركات التي فعّلت كل الأنشطة السابقة يُضاف لها النشاط الجديد كذلك؛ غيرها يفعّله من الإعدادات
UPDATE org.tenant SET packs = array_append(packs, 'freight')
 WHERE packs @> ARRAY['delivery','staffing','concrete','internal','distribution'] AND NOT ('freight' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
