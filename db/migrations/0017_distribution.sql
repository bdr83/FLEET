-- 0017: وحدة التوزيع الذاتي (distribution@1، القطاع 29): الشركة توزّع بضاعتها بأسطولها على فروعها أو عملائها.
-- المسار اليومي = مركبة وسائق ليوم، بقائمة تحميل، وتوقفات متعددة؛ في كل توقف كميات مسلَّمة ومرتجعة ونقد محصَّل،
-- ثم تسوية العهدة النقدية في المكتب. المسار نفسه مهمة (ops.task) تحجز المركبة والسائق حصريًا لنافذة اليوم،
-- وكل توقف مهمة بإسناد للسائق غير حصري، فتبقى قيود الإسناد والتتبع من النواة.

-- الأصناف (كتالوج بسيط لكل شركة قانونية): الرمز والاسم والوحدة والسعر
CREATE TABLE ops.dist_product (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  unit text NOT NULL DEFAULT 'piece' CHECK (unit IN ('piece','carton','crate','kg','liter','bag')),
  price numeric(10,3) NOT NULL DEFAULT 0 CHECK (price >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, sku),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- المسار: planned → loaded (السائق راجع الحمولة) → out (انطلق) → back (عاد بعد كل التوقفات) → settled (سُلّمت العهدة)، أو canceled
CREATE TABLE ops.dist_route (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^DR-[0-9]{1,9}$'),
  route_date date NOT NULL,
  task_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  driver_worker_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','loaded','out','back','settled','canceled')),
  notes text CHECK (length(notes) <= 1000),
  loaded_at timestamptz, out_at timestamptz, back_at timestamptz,
  start_odometer_km integer CHECK (start_odometer_km >= 0), end_odometer_km integer,
  cash_received numeric(12,3) CHECK (cash_received >= 0),              -- ما سلّمه السائق للمكتب
  settled_by uuid, settled_at timestamptz, settle_note text CHECK (length(settle_note) <= 500),
  cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK (end_odometer_km IS NULL OR end_odometer_km >= start_odometer_km),
  CHECK (status <> 'settled' OR (cash_received IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (status NOT IN ('back','settled') OR back_at IS NOT NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id)
);
CREATE UNIQUE INDEX dist_route_task ON ops.dist_route (tenant_id, task_id);
-- مركبة واحدة ومسار واحد في اليوم، وسائق واحد ومسار واحد في اليوم
CREATE UNIQUE INDEX dist_route_asset_day ON ops.dist_route (tenant_id, asset_id, route_date) WHERE status <> 'canceled';
CREATE UNIQUE INDEX dist_route_driver_day ON ops.dist_route (tenant_id, driver_worker_id, route_date) WHERE status <> 'canceled';
CREATE INDEX dist_route_date ON ops.dist_route (tenant_id, route_date, status);

-- التوقف: الفرع أو العميل، الأصناف المخطط تسليمها، وما سُلّم فعلًا وما أُرجع والنقد
CREATE TABLE ops.dist_stop (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 200),
  customer_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  payment text NOT NULL DEFAULT 'credit' CHECK (payment IN ('cash','credit')),   -- نقدًا عند التسليم أو على الحساب (فرع أو عميل آجل)
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 100),  -- [{sku,name,qty,price}]
  delivered jsonb CHECK (jsonb_typeof(delivered) = 'object'),        -- {sku: qty}
  returned jsonb CHECK (jsonb_typeof(returned) = 'object'),          -- {sku: qty} مرتجعات من الفرع (تالف، منتهٍ، زائد)
  cash_due numeric(12,3) CHECK (cash_due >= 0),                      -- قيمة المسلَّم للدفع النقدي، يُحسب عند التسليم
  cash_collected numeric(12,3) CHECK (cash_collected >= 0),
  received_by text CHECK (length(received_by) <= 120),
  closed_reason text CHECK (closed_reason ~ '^[a-z][a-z0-9_]{1,39}$'),
  done_at timestamptz,
  client_op_id uuid,
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, route_id, seq),
  UNIQUE (tenant_id, client_op_id),
  CHECK (done_at IS NULL OR delivered IS NOT NULL OR closed_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.dist_route (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
CREATE INDEX dist_stop_route ON ops.dist_stop (tenant_id, route_id, seq);
REVOKE DELETE, TRUNCATE ON ops.dist_route, ops.dist_stop FROM app_rw;

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
