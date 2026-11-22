-- 0027: وحدة تأجير السيارات (rental، القطاع 17): عقد إيجار لعميل (فرد أو شركة) على مركبة لفترة، باليوم أو الأسبوع أو الشهر.
-- العقد مهمة (ops.task) تحجز المركبة حصريًا لفترة الإيجار في ops.assignment، فلا تُحجز لقطاع آخر في الوقت نفسه.
-- الاستلام والإرجاع يسجّلان العدّاد والوقود (بالأثمان) والأضرار؛ الرسوم تُحسب عند الإرجاع من سعر العقد الذي أدخله المكتب
-- (أيام، كيلومترات زائدة، نقص الوقود، أضرار). التوصيل للعميل والاستلام منه مهمة لسائق من التطبيق.
-- المخالفات المرورية تُطابَق مع العقد الذي كانت المركبة فيه وقت المخالفة. العربون يُسجَّل فقط (الشركة تحتفظ به، لا المنصة).

CREATE TABLE ops.rental_agreement (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  branch_id uuid,
  ref text NOT NULL CHECK (ref ~ '^RA-[0-9]{1,9}$'),
  customer_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  task_id uuid NOT NULL,                                             -- الحجز الحصري للمركبة
  drivers jsonb NOT NULL CHECK (jsonb_typeof(drivers) = 'array' AND jsonb_array_length(drivers) BETWEEN 1 AND 4 AND length(drivers::text) <= 4000),
                                                                     -- [{name, phone?, civil_id?, licence_no, licence_expiry}] الأول هو المستأجر
  pickup_at timestamptz NOT NULL,
  return_due timestamptz NOT NULL,
  rate_unit text NOT NULL DEFAULT 'day' CHECK (rate_unit IN ('day','week','month')),
  rate numeric(18,3) NOT NULL CHECK (rate >= 0),                     -- سعر الوحدة من المكتب
  km_per_day integer CHECK (km_per_day BETWEEN 1 AND 5000),          -- بلا قيمة = كيلومترات مفتوحة
  extra_km_rate numeric(18,3) NOT NULL DEFAULT 0 CHECK (extra_km_rate >= 0),
  fuel_rate numeric(18,3) NOT NULL DEFAULT 0 CHECK (fuel_rate >= 0),  -- لكل ثُمن خزان ناقص
  deposit numeric(18,3) NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  notes text CHECK (length(notes) <= 1000),
  out_at timestamptz, out_odometer_km integer CHECK (out_odometer_km >= 0), out_fuel smallint CHECK (out_fuel BETWEEN 0 AND 8),
  out_damage text CHECK (length(out_damage) <= 1000), out_by text CHECK (out_by IN ('staff','driver')),
  in_at timestamptz, in_odometer_km integer, in_fuel smallint CHECK (in_fuel BETWEEN 0 AND 8),
  in_damage text CHECK (length(in_damage) <= 1000), in_by text CHECK (in_by IN ('staff','driver')),
  -- الرسوم عند الإغلاق
  days integer CHECK (days >= 1),
  rental_amount numeric(18,3), extra_km integer, km_amount numeric(18,3), fuel_amount numeric(18,3),
  damage_amount numeric(18,3) NOT NULL DEFAULT 0 CHECK (damage_amount >= 0),
  total numeric(18,3),
  closed_at timestamptz,
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, task_id),
  CHECK (return_due > pickup_at AND return_due <= pickup_at + interval '366 days'),
  CHECK (in_at IS NULL OR (out_at IS NOT NULL AND in_at >= out_at AND in_odometer_km >= out_odometer_km)),
  CHECK ((out_at IS NULL) = (out_odometer_km IS NULL)),
  CHECK ((in_at IS NULL) = (in_odometer_km IS NULL)),
  CHECK ((closed_at IS NULL) = (total IS NULL)),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (canceled_at IS NULL OR out_at IS NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES org.branch (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX rental_agreement_asset ON ops.rental_agreement (tenant_id, asset_id, pickup_at);
CREATE INDEX rental_agreement_customer ON ops.rental_agreement (tenant_id, customer_id);
REVOKE DELETE, TRUNCATE ON ops.rental_agreement FROM app_rw;

-- توصيل المركبة للعميل أو استلامها منه: مهمة لسائق
CREATE TABLE ops.rental_move (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('deliver','collect')),
  address jsonb NOT NULL CHECK (jsonb_typeof(address) = 'object' AND length(address::text) <= 2000),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, agreement_id) REFERENCES ops.rental_agreement (tenant_id, id)
);
CREATE INDEX rental_move_agreement ON ops.rental_move (tenant_id, agreement_id);

-- المخالفات المرورية على مركبات الإيجار
CREATE TABLE ops.rental_fine (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  amount numeric(18,3) NOT NULL CHECK (amount > 0),
  fine_no text CHECK (length(fine_no) <= 60),
  description text CHECK (length(description) <= 500),
  agreement_id uuid,                                                 -- بلا عقد = المركبة لم تكن مؤجرة وقتها
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','charged','waived','paid_by_us')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, agreement_id) REFERENCES ops.rental_agreement (tenant_id, id)
);
CREATE UNIQUE INDEX rental_fine_no ON ops.rental_fine (tenant_id, fine_no) WHERE fine_no IS NOT NULL;
CREATE INDEX rental_fine_agreement ON ops.rental_fine (tenant_id, agreement_id);

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'rental')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','equipment','concrete','internal','distribution'] AND NOT ('rental' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
