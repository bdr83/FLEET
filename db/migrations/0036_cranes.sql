-- 0036: وحدة الرافعات (cranes، القطاع 19) فوق تأجير المعدات: مواصفات كل رافعة وجدول حمولتها (الحمولة المقنّنة لكل نصف قطر)
-- وحد الرياح. كل رفعة لها خطة رفع (LP-n) في يوم عمل من عقد تأجير: الحمولة ونصف القطر والحمولة المقنّنة ونسبة الاستخدام.
-- الرفعة فوق 100% مرفوضة، والحرجة (75% فأكثر، أو رفعة مزدوجة، أو فوق أشخاص) تحتاج اعتماد الشخص المعيّن. لا تُخطط رفعة
-- برافعة شهادة فحصها منتهية أو مشغّل أو مُعلِّق (rigger) بلا شهادة سارية. المشغّل يسجّل الرفعة منفذة مع سرعة الرياح
-- (فوق حد الرافعة مرفوضة) أو ملغاة بسبب؛ لا يُنهى يوم العمل وفيه رفعة مفتوحة.

CREATE TABLE ops.crane_spec (
  asset_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  max_capacity_t numeric(7,2) NOT NULL CHECK (max_capacity_t > 0 AND max_capacity_t <= 3000),
  boom_m numeric(5,1) CHECK (boom_m > 0 AND boom_m <= 200),
  wind_limit_ms numeric(4,1) NOT NULL DEFAULT 9.8 CHECK (wind_limit_ms BETWEEN 3 AND 30),
  chart jsonb NOT NULL CHECK (jsonb_typeof(chart) = 'array' AND jsonb_array_length(chart) BETWEEN 1 AND 60),   -- [{radius_m, capacity_t}] تصاعديًا
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id)
);

CREATE TABLE ops.crane_lift (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^LP-[0-9]{1,9}$'),
  hire_id uuid NOT NULL,
  task_id uuid NOT NULL,                                             -- يوم العمل (ops.equip_day)
  lift_date date NOT NULL,
  lift_time time,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  load_t numeric(7,2) NOT NULL CHECK (load_t > 0),                   -- مع أدوات الرفع
  radius_m numeric(5,1) NOT NULL CHECK (radius_m > 0),
  rated_t numeric(7,2) NOT NULL CHECK (rated_t > 0),
  utilization numeric(5,1) NOT NULL CHECK (utilization > 0 AND utilization <= 100),
  tandem boolean NOT NULL DEFAULT false,
  over_people boolean NOT NULL DEFAULT false,
  critical boolean NOT NULL,
  rigger_worker_id uuid NOT NULL,
  approved_by uuid, approved_at timestamptz,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','aborted','canceled')),
  done_at timestamptz, wind_ms numeric(4,1) CHECK (wind_ms BETWEEN 0 AND 60),
  abort_reason text CHECK (length(abort_reason) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (status <> 'done' OR (done_at IS NOT NULL AND wind_ms IS NOT NULL)),
  CHECK (status NOT IN ('aborted','canceled') OR abort_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, hire_id) REFERENCES ops.equip_hire (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, rigger_worker_id) REFERENCES workforce.worker (tenant_id, id)
);
CREATE INDEX crane_lift_date ON ops.crane_lift (tenant_id, lift_date);
CREATE INDEX crane_lift_task ON ops.crane_lift (tenant_id, task_id);
REVOKE DELETE, TRUNCATE ON ops.crane_lift FROM app_rw;

-- ما سجّله المشغّل أو المكتب لكل رفعة: سجل لا يُعدَّل
CREATE TABLE ops.crane_lift_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  lift_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('done','aborted')),
  wind_ms numeric(4,1) CHECK (wind_ms BETWEEN 0 AND 60),
  note text CHECK (length(note) <= 300),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('driver','office')),
  actor_id uuid,
  client_op_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  FOREIGN KEY (tenant_id, lift_id) REFERENCES ops.crane_lift (tenant_id, id)
);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.crane_lift_event FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'cranes')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','concrete','internal','service','distribution'] AND NOT ('cranes' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
