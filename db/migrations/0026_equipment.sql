-- 0026: وحدة تأجير المعدات الثقيلة (equipment، القطاع 16): رافعات وحفارات وشيولات وغيرها تُؤجَّر لعميل في موقعه،
-- مع مشغّل من عندنا (تأجير بمشغّل) أو بدونه (تأجير جاف)، بالساعة أو اليوم أو الشهر، مع حد أدنى يومي للساعات.
-- كل يوم عمل مهمة (ops.task) تحجز المعدة والمشغّل حصريًا لنافذة الدوام. المشغّل يسجّل قراءة عدّاد الساعات عند البدء والانتهاء،
-- وتوقف الأعطال، واسم مشرف الموقع الذي أقرّ الساعات. المكتب يعتمد اليوم فتُحسب الساعات المفوترة. السعر من عقد العميل.

-- أنواع المعدات الثقيلة في سجل المركبات (عدّاد الساعات يُحفظ في قراءات أيام العمل)
ALTER TABLE fleet.asset DROP CONSTRAINT asset_type_known;
ALTER TABLE fleet.asset ADD CONSTRAINT asset_type_known CHECK (asset_type IN ('car','motorbike','van','pickup','truck','mixer','pump','trailer','bus',
  'excavator','loader','crane','forklift','bulldozer','roller','grader','other'));

CREATE TABLE ops.equip_hire (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^EH-[0-9]{1,9}$'),
  asset_id uuid NOT NULL,
  operator_worker_id uuid,                                           -- بلا مشغّل = تأجير جاف
  site jsonb NOT NULL CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),   -- {name, area, lat?, lng?, contact?, phone?}
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  shift_start time NOT NULL,
  shift_end time NOT NULL,
  work_days smallint[] NOT NULL DEFAULT ARRAY[7,1,2,3,4,6]::smallint[]  -- أيام ISO؛ الافتراضي كل الأيام عدا الجمعة [تخمين]
    CHECK (cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  rate_unit text NOT NULL DEFAULT 'hour' CHECK (rate_unit IN ('hour','day','month')),
  min_hours numeric(4,1) NOT NULL DEFAULT 8 CHECK (min_hours BETWEEN 0 AND 24),   -- الحد الأدنى المفوتر يوميًا [تخمين]
  notes text CHECK (length(notes) <= 1000),
  off_hired_on date,                                                 -- إنهاء مبكر: آخر يوم عمل
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK (ends_on >= starts_on AND ends_on <= starts_on + 186),
  CHECK (shift_end > shift_start),
  CHECK (off_hired_on IS NULL OR off_hired_on BETWEEN starts_on - 1 AND ends_on),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, operator_worker_id) REFERENCES workforce.worker (tenant_id, id),
  -- المعدة لا تُؤجَّر لعقدين متداخلين
  CONSTRAINT no_equip_hire_overlap EXCLUDE USING gist (tenant_id WITH =, asset_id WITH =, daterange(starts_on, COALESCE(off_hired_on, ends_on), '[]') WITH &&) WHERE (canceled_at IS NULL)
);
CREATE INDEX equip_hire_customer ON ops.equip_hire (tenant_id, customer_id);

-- يوم العمل: قراءات عدّاد الساعات، التوقف بسبب عطل (لا يُفوتر)، إقرار مشرف الموقع، واعتماد المكتب
CREATE TABLE ops.equip_day (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  hire_id uuid NOT NULL,
  work_date date NOT NULL,
  meter_start numeric(9,1) CHECK (meter_start >= 0),
  meter_end numeric(9,1),
  downtime_hours numeric(4,1) NOT NULL DEFAULT 0 CHECK (downtime_hours BETWEEN 0 AND 24),
  signed_by text CHECK (length(signed_by) <= 120),
  approved_hours numeric(4,1) CHECK (approved_hours BETWEEN 0 AND 24),
  approved_by uuid, approved_at timestamptz,
  note text CHECK (length(note) <= 500),
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, hire_id, work_date),
  CHECK (meter_end IS NULL OR (meter_start IS NOT NULL AND meter_end >= meter_start AND meter_end - meter_start <= 24)),
  CHECK ((approved_at IS NULL) = (approved_hours IS NULL)),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, hire_id) REFERENCES ops.equip_hire (tenant_id, id)
);
CREATE INDEX equip_day_date ON ops.equip_day (tenant_id, work_date);
REVOKE DELETE, TRUNCATE ON ops.equip_day FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','equipment','concrete','internal','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'equipment')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','concrete','internal','distribution'] AND NOT ('equipment' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
