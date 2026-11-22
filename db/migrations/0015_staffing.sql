-- 0015: وحدة قطاع توريد السائقين (staffing@1، القطاع 14، الوحدة M11): طلب التوريد، تعيين السائق، مناوبات يومية،
-- اعتراضات العميل على الساعات، وإعدادات القطاع. كل مناوبة يومية مهمة (ops.task) عادية بنوع staffing@1،
-- فيبقى الإسناد والتطبيق والمراجعة والفوترة من النواة: الحضور = بدء المهمة، الانصراف = إكمالها، اعتماد العميل = المراجعة.

CREATE TABLE ops.staffing_settings (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  checkin_radius_m integer NOT NULL DEFAULT 300 CHECK (checkin_radius_m BETWEEN 50 AND 5000),   -- نطاق موقع العميل لتسجيل الحضور
  late_grace_minutes integer NOT NULL DEFAULT 15 CHECK (late_grace_minutes BETWEEN 0 AND 240), -- بعده يظهر السائق متأخرًا أو غائبًا
  hour_rounding_minutes integer NOT NULL DEFAULT 15 CHECK (hour_rounding_minutes IN (1, 5, 10, 15, 30, 60)),
  doc_types text[] NOT NULL DEFAULT '{driving_license,residency}',                             -- مستندات الأهلية المطلوبة
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- طلب العميل: عدد السائقين، النوع، الفترة، أيام العمل وساعاتها، الموقع، ووحدة الفوترة. الإلغاء فقط يُخزّن، والحالة تُشتق.
CREATE TABLE ops.supply_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$'),
  site_id uuid,
  site jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),
  worker_kind text NOT NULL DEFAULT 'driver' CHECK (worker_kind IN ('driver','courier')),
  with_vehicle boolean NOT NULL DEFAULT false,
  headcount integer NOT NULL CHECK (headcount BETWEEN 1 AND 500),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  shift_start time NOT NULL,
  shift_end time NOT NULL,                                   -- أقل من البداية = مناوبة ليلية تنتهي في اليوم التالي
  work_days smallint[] NOT NULL DEFAULT '{0,1,2,3,4}',      -- 0 = الأحد ... 6 = السبت (أسبوع العمل في الكويت الأحد–الخميس)
  bill_unit text NOT NULL DEFAULT 'hour' CHECK (bill_unit IN ('hour','day')),
  notes text CHECK (length(notes) <= 1000),
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK (ends_on >= starts_on AND ends_on <= starts_on + 366),
  CHECK (shift_start <> shift_end),
  CHECK (cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ '{0,1,2,3,4,5,6}'),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES crm.site (tenant_id, id)
);

-- تعيين سائق على طلب لفترة. السائق لا يُعيّن على طلبين متداخلين. الإنهاء المبكر يقصّر الفترة؛ الحذف قبل البدء active = false.
CREATE TABLE ops.placement (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 9999),
  worker_id uuid NOT NULL,
  asset_id uuid,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  end_reason text CHECK (length(end_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_id, seq),
  CHECK (ends_on >= starts_on),
  FOREIGN KEY (tenant_id, request_id) REFERENCES ops.supply_request (tenant_id, id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  CONSTRAINT no_placement_overlap EXCLUDE USING gist (tenant_id WITH =, worker_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&) WHERE (active)
);
CREATE INDEX placement_request ON ops.placement (tenant_id, request_id);

-- المناوبة اليومية: رابط المهمة باليوم والتعيين، وما يحتاجه الحضور (مسافة تسجيل الحضور عن الموقع) والغياب والاستبدال.
CREATE TABLE ops.staffing_shift (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  work_date date NOT NULL,
  checkin_distance_m integer CHECK (checkin_distance_m >= 0),
  absent_at timestamptz,
  replaced_at timestamptz,
  replaced_worker_id uuid,                                   -- السائق الأصلي عند الاستبدال
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, placement_id, work_date),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, placement_id) REFERENCES ops.placement (tenant_id, id)
);
CREATE INDEX staffing_shift_date ON ops.staffing_shift (tenant_id, work_date);

-- اعتراض العميل على ساعات يوم: يبقى اليوم خارج الفاتورة حتى يُحل.
CREATE TABLE ops.staffing_dispute (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  raised_by uuid,
  raised_at timestamptz NOT NULL DEFAULT now(),
  hours_before numeric(6,2),
  hours_after numeric(6,2) CHECK (hours_after >= 0 AND hours_after <= 24),
  resolution text CHECK (length(resolution) <= 500),
  resolved_by uuid, resolved_at timestamptz,
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE UNIQUE INDEX staffing_dispute_open ON ops.staffing_dispute (tenant_id, task_id) WHERE resolved_at IS NULL;
REVOKE DELETE, TRUNCATE ON ops.staffing_dispute FROM app_rw;

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
