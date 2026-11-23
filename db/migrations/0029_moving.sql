-- 0029: وحدة نقل الأثاث (moving، القطاع 5): طلب نقل من عنوان إلى عنوان؛ معاينة تحدد الحجم وقائمة الأغراض، ثم عرض سعر من المكتب
-- وموافقة العميل مع العربون. يوم النقل: الشاحنة والسائق (رئيس الطاقم) على المهمة الرئيسية، وكل عامل على مهمة طاقم تحجزه لنفس النافذة.
-- السائق يسجّل انتهاء التحميل ثم التفريغ مع اسم المستلم. بعد النقل: مطالبات الأضرار وتقييم العميل.
-- العربون يُسجّل فقط: المنصة لا تحتفظ بأموال العملاء.

CREATE TABLE ops.move_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^MV-[0-9]{1,9}$'),
  customer_id uuid NOT NULL,
  from_site jsonb NOT NULL CHECK (jsonb_typeof(from_site) = 'object' AND length(from_site::text) <= 2000),  -- {area, block?, street?, house?, floor?, apartment?, lift?, lat?, lng?, contact?, phone?}
  to_site jsonb NOT NULL CHECK (jsonb_typeof(to_site) = 'object' AND length(to_site::text) <= 2000),
  home_size text NOT NULL CHECK (home_size IN ('room','studio','apt_1','apt_2','apt_3','apt_4','villa','office')),
  services text[] NOT NULL DEFAULT '{}' CHECK (services <@ ARRAY['packing','assembly','crating','storage','cleaning']::text[]),
  move_at timestamptz NOT NULL,                                       -- بداية النقل المطلوبة
  hours smallint NOT NULL CHECK (hours BETWEEN 1 AND 24),             -- مدة الحجز المتوقعة
  crew_size smallint NOT NULL DEFAULT 2 CHECK (crew_size BETWEEN 0 AND 20),   -- عدد العمال مع السائق
  notes text CHECK (length(notes) <= 1000),
  survey_at timestamptz, surveyed_at timestamptz,
  volume_m3 numeric(7,1) CHECK (volume_m3 > 0 AND volume_m3 <= 500),
  quote_amount numeric(18,3) CHECK (quote_amount >= 0), quoted_at timestamptz,
  deposit_amount numeric(18,3) CHECK (deposit_amount >= 0), deposit_paid_at timestamptz,
  accepted_at timestamptz,
  loaded_at timestamptz, unloaded_at timestamptz,
  received_by text CHECK (length(received_by) <= 120),
  delivery_note text CHECK (length(delivery_note) <= 500),
  extra_amount numeric(18,3) CHECK (extra_amount >= 0),
  rating smallint CHECK (rating BETWEEN 1 AND 5), rating_note text CHECK (length(rating_note) <= 500),
  closed_at timestamptz, closed_by uuid,
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK ((quote_amount IS NULL) = (quoted_at IS NULL)),
  CHECK (accepted_at IS NULL OR quoted_at IS NOT NULL),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (closed_at IS NULL OR canceled_at IS NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
CREATE INDEX move_job_customer ON ops.move_job (tenant_id, customer_id);
CREATE INDEX move_job_open ON ops.move_job (tenant_id, move_at) WHERE closed_at IS NULL AND canceled_at IS NULL;

-- قائمة الأغراض من المعاينة (الغرفة، الصنف، العدد، قابل للكسر)
CREATE TABLE ops.move_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  room text CHECK (length(room) <= 60),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  qty smallint NOT NULL CHECK (qty BETWEEN 1 AND 999),
  fragile boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES ops.move_job (tenant_id, id)
);
CREATE INDEX move_item_job ON ops.move_item (tenant_id, job_id);

-- مهام يوم النقل: الرئيسية (الشاحنة والسائق) ومهام الطاقم (عامل لكل مهمة)
CREATE TABLE ops.move_task (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('lead','helper')),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES ops.move_job (tenant_id, id)
);
CREATE INDEX move_task_job ON ops.move_task (tenant_id, job_id);

-- مطالبات الأضرار بعد النقل
CREATE TABLE ops.move_claim (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  item text NOT NULL CHECK (length(item) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  claimed_amount numeric(18,3) CHECK (claimed_amount >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','rejected')),
  settled_amount numeric(18,3) CHECK (settled_amount >= 0),
  decision_note text CHECK (length(decision_note) <= 500),
  decided_at timestamptz, decided_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK (settled_amount IS NULL OR status = 'settled'),
  FOREIGN KEY (tenant_id, job_id) REFERENCES ops.move_job (tenant_id, id)
);
CREATE INDEX move_claim_job ON ops.move_claim (tenant_id, job_id);
REVOKE DELETE, TRUNCATE ON ops.move_claim FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'moving')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'] AND NOT ('moving' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
