-- 0016: وحدة الأسطول الداخلي للشركات (internal@1، القطاع 21، الوحدة M17): الإدارات ومراكز التكلفة، طلب مركبة من موظف،
-- موافقة مدير الإدارة، تخصيص مركبة (ومعها سائق اختياريًا)، الاستلام والإرجاع بالعدّاد والوقود، وتحميل التكلفة على الإدارات.
-- الطلب المخصص يصبح مهمة (ops.task) عادية بنوع internal@1 بنافذة الاستخدام، فتمنع قيود الإسناد حجز المركبة مرتين.

-- قيادة ذاتية بلا سائق: إسناد بمركبة فقط. قيد تداخل السائق لا يقارن القيم الفارغة، وقيد تداخل المركبة يبقى كما هو.
ALTER TABLE ops.assignment ALTER COLUMN worker_id DROP NOT NULL;
ALTER TABLE ops.assignment ADD CONSTRAINT assignment_has_resource CHECK (worker_id IS NOT NULL OR asset_id IS NOT NULL);

-- الإدارة (مركز التكلفة) ومديرها الذي يوافق على طلبات موظفيها
CREATE TABLE ops.department (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  cost_center text CHECK (cost_center ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$'),
  manager_user_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, name),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (manager_user_id) REFERENCES org.app_user (id)
);

-- الموظف ينتمي لإدارة (عضويته في المؤسسة)
ALTER TABLE org.membership ADD COLUMN department_id uuid;
ALTER TABLE org.membership ADD FOREIGN KEY (tenant_id, department_id) REFERENCES ops.department (tenant_id, id);

-- دور الموظف الطالب: يطلب مركبة ويرى طلباته، ويوافق على طلبات إدارته إن كان مديرها
INSERT INTO org.role (id, tenant_id, code, permissions) VALUES
 ('00000000-0000-4000-8000-000000000008', NULL, 'employee', ARRAY['vehicle_requests:own']);
UPDATE org.role SET permissions = permissions || ARRAY['vehicle_requests:own'] WHERE tenant_id IS NULL AND code IN ('admin','dispatcher','branch_supervisor','accountant');

CREATE TABLE ops.internal_settings (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  require_approval boolean NOT NULL DEFAULT true,
  auto_approve_max_hours integer CHECK (auto_approve_max_hours BETWEEN 1 AND 72),   -- الطلب الأقصر يُعتمد تلقائيًا
  cost_per_km numeric(8,3) NOT NULL DEFAULT 0.100 CHECK (cost_per_km >= 0),         -- لتحميل التكلفة على الإدارة
  driver_cost_per_hour numeric(8,3) NOT NULL DEFAULT 0 CHECK (driver_cost_per_hour >= 0),
  return_grace_minutes integer NOT NULL DEFAULT 30 CHECK (return_grace_minutes BETWEEN 0 AND 600),
  work_start time NOT NULL DEFAULT '07:00', work_end time NOT NULL DEFAULT '17:00',  -- خارجها يُنبَّه الطلب
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- طلب المركبة ودورته: pending → approved|rejected → allocated → in_use → returned، أو canceled
CREATE TABLE ops.vehicle_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^VR-[0-9]{1,9}$'),
  requester_user_id uuid NOT NULL,
  department_id uuid NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 300),
  destination text CHECK (length(destination) <= 300),
  passengers smallint NOT NULL DEFAULT 1 CHECK (passengers BETWEEN 1 AND 60),
  with_driver boolean NOT NULL DEFAULT false,
  asset_type text CHECK (asset_type IN ('car','van','pickup','truck','bus','motorbike','other')),   -- النوع المطلوب إن وُجد
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  notes text CHECK (length(notes) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','allocated','in_use','returned','canceled')),
  decided_by uuid, decided_at timestamptz, decision_note text CHECK (length(decision_note) <= 500),
  task_id uuid, asset_id uuid, driver_worker_id uuid,
  out_at timestamptz, out_odometer_km integer CHECK (out_odometer_km >= 0), out_fuel smallint CHECK (out_fuel BETWEEN 0 AND 8),
  back_at timestamptz, back_odometer_km integer, back_fuel smallint CHECK (back_fuel BETWEEN 0 AND 8),   -- الوقود بالثُمن (0–8)
  condition_note text CHECK (length(condition_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '31 days'),
  CHECK (back_odometer_km IS NULL OR back_odometer_km >= out_odometer_km),
  CHECK (status NOT IN ('allocated','in_use','returned') OR (task_id IS NOT NULL AND asset_id IS NOT NULL)),
  CHECK (status NOT IN ('in_use','returned') OR out_at IS NOT NULL),
  CHECK (status <> 'returned' OR back_at IS NOT NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES ops.department (tenant_id, id),
  FOREIGN KEY (requester_user_id) REFERENCES org.app_user (id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id)
);
CREATE INDEX vehicle_request_status ON ops.vehicle_request (tenant_id, status, starts_at);
CREATE INDEX vehicle_request_asset ON ops.vehicle_request (tenant_id, asset_id, out_at);
CREATE UNIQUE INDEX vehicle_request_task ON ops.vehicle_request (tenant_id, task_id) WHERE task_id IS NOT NULL;
-- الطلب لا يُحذف: الإلغاء حالة، والسجل يجيب "من كان يقود المركبة وقتها"
REVOKE DELETE, TRUNCATE ON ops.vehicle_request FROM app_rw;

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
