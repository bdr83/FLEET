-- 0030: وحدة الحاويات والموانئ (containers، القطاع 6): نقل حاوية بين الميناء أو ساحة الحاويات الفارغة وموقع العميل.
-- استيراد: من الميناء إلى العميل، ثم إرجاع الفارغة للساحة. تصدير: فارغة من الساحة إلى العميل، ثم الممتلئة إلى الميناء.
-- كل رحلة (leg) مهمة تحجز الشاحنة والسائق حصريًا؛ السائق يؤكد رقم الحاوية عند الاستلام، ثم المستلم أو رقم إيصال البوابة عند التسليم.
-- آخر يوم مجاني في الميناء (الأرضيات) وموعد إرجاع الفارغة (التأخير) يُراقبان؛ المبالغ يدخلها المكتب عند الإغلاق.

CREATE TABLE ops.ctr_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^CT-[0-9]{1,9}$'),
  customer_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('import','export','local')),
  container_no text NOT NULL CHECK (container_no ~ '^[A-Z]{3}[UJZR][0-9]{7}$'),
  iso_size text NOT NULL CHECK (iso_size IN ('20','40','45')),
  ctype text NOT NULL DEFAULT 'dry' CHECK (ctype IN ('dry','high_cube','reefer','open_top','flat_rack','tank')),
  line text CHECK (length(line) <= 60),                               -- الخط الملاحي
  doc_no text CHECK (length(doc_no) <= 40),                           -- بوليصة الشحن أو رقم الحجز
  seal_no text CHECK (length(seal_no) <= 40),
  weight_kg integer CHECK (weight_kg BETWEEN 0 AND 40000),
  port text NOT NULL CHECK (port IN ('shuwaikh','shuaiba','doha','other')),
  depot text CHECK (length(depot) <= 120),                            -- ساحة الحاويات الفارغة
  site jsonb NOT NULL CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),  -- موقع العميل
  last_free_day date,                                                 -- آخر يوم بلا أرضيات في الميناء
  return_by date,                                                     -- موعد إرجاع الفارغة أو إدخال الممتلئة
  picked_at timestamptz, at_customer_at timestamptz, emptied_at timestamptz, done_at timestamptz,
  haulage_amount numeric(18,3) CHECK (haulage_amount >= 0),
  extra_amount numeric(18,3) CHECK (extra_amount >= 0),               -- أرضيات أو تأخير يُحمَّل على العميل
  closed_at timestamptz, closed_by uuid,
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  notes text CHECK (length(notes) <= 1000),
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
CREATE INDEX ctr_job_customer ON ops.ctr_job (tenant_id, customer_id);
CREATE INDEX ctr_job_container ON ops.ctr_job (tenant_id, container_no);
CREATE UNIQUE INDEX ctr_job_one_open ON ops.ctr_job (tenant_id, container_no) WHERE closed_at IS NULL AND canceled_at IS NULL;

-- رحلة الحاوية: مهمة تحجز الشاحنة والسائق
CREATE TABLE ops.ctr_leg (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 20),
  kind text NOT NULL CHECK (kind IN ('port_to_customer','empty_to_depot','empty_to_customer','full_to_port','transfer')),
  picked_at timestamptz, dropped_at timestamptz,
  seal_no text CHECK (length(seal_no) <= 40),
  received_by text CHECK (length(received_by) <= 120),
  gate_ref text CHECK (length(gate_ref) <= 40),                       -- رقم إيصال البوابة (EIR)
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, job_id, seq),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES ops.ctr_job (tenant_id, id)
);
CREATE INDEX ctr_leg_job ON ops.ctr_leg (tenant_id, job_id);

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'containers')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'] AND NOT ('containers' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
