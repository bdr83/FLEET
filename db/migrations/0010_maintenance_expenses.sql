-- 0010 (P7): الصيانة الوقائية وأوامر العمل والمصروفات.
CREATE SCHEMA IF NOT EXISTS maint;
GRANT USAGE ON SCHEMA maint TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA maint GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;

-- خطة صيانة دورية لمركبة: كل X كم أو كل Y يوم، أيهما أسبق
CREATE TABLE maint.plan (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  interval_km integer CHECK (interval_km > 0),
  interval_days integer CHECK (interval_days > 0),
  last_done_km integer CHECK (last_done_km >= 0),
  last_done_on date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (interval_km IS NOT NULL OR interval_days IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

CREATE TABLE maint.work_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  plan_id uuid,
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('preventive','corrective','inspection','accident')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','canceled')),
  out_of_service boolean NOT NULL DEFAULT false,   -- المركبة متوقفة طوال أمر العمل
  description text CHECK (length(description) <= 2000),
  vendor text CHECK (length(vendor) <= 200),
  odometer_km integer CHECK (odometer_km >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  opened_by uuid, closed_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, number),  -- الترقيم لكل شركة قانونية
  CHECK ((status IN ('done','canceled')) = (closed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES maint.plan (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);
CREATE INDEX work_order_asset ON maint.work_order (tenant_id, asset_id, status);

CREATE TABLE maint.work_order_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('part','labor','other')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  qty numeric(12,3) NOT NULL CHECK (qty > 0),
  unit_cost numeric(18,3) NOT NULL CHECK (unit_cost >= 0),
  amount numeric(18,3) GENERATED ALWAYS AS (round(qty * unit_cost, 3)) STORED,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maint.work_order (tenant_id, id) ON DELETE CASCADE
);

-- المصروف: وقود، صيانة، إطارات، مخالفات... يقدّمه السائق من التطبيق أو الموظف من اللوحة، ويعتمده المشرف.
CREATE TABLE maint.expense (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('fuel','maintenance','tires','insurance','registration','fines','tolls','parking','washing','other')),
  amount numeric(18,3) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  spent_at timestamptz NOT NULL,
  asset_id uuid, worker_id uuid, work_order_id uuid, shift_id uuid,
  liters numeric(10,3) CHECK (liters > 0),
  odometer_km integer CHECK (odometer_km >= 0),
  vendor text CHECK (length(vendor) <= 200),
  note text CHECK (length(note) <= 1000),
  receipt_file_key text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  submitted_by uuid NOT NULL,
  decided_by uuid, decided_at timestamptz, reject_reason text CHECK (length(reject_reason) <= 300),
  client_op_id uuid,                                  -- منع التكرار عند الإرسال من التطبيق دون اتصال
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (liters IS NULL OR category = 'fuel'),
  CHECK ((status = 'submitted') = (decided_at IS NULL)),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES maint.work_order (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shift.shift (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);
CREATE UNIQUE INDEX expense_client_op ON maint.expense (tenant_id, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE INDEX expense_asset_time ON maint.expense (tenant_id, asset_id, spent_at);
CREATE INDEX expense_status ON maint.expense (tenant_id, status);

-- المحاسب يرى تكاليف الأسطول
UPDATE org.role SET permissions = permissions || ARRAY['fleet:read'] WHERE tenant_id IS NULL AND code = 'accountant' AND NOT ('fleet:read' = ANY(permissions));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
