-- 0033: وحدة التاكسي والليموزين (taxi، القطاع 12): حجوزات تاكسي الطلب والليموزين بالهاتف أو من حساب شركة.
-- الحجز له راكب، ومكان وموعد الالتقاط (فوري أو لاحق، أو رحلة مطار)، ووجهة، وفئة سيارة. كل حجز مهمة تحجز سيارة من الفئة وسائقها.
-- السائق يسجّل الوصول، ثم ركوب الراكب، ثم النزول بالكيلومترات وطريقة الدفع. الأجرة سعر ثابت من المكتب أو تعرفة الفئة
-- (فتحة عداد، لكل كم، لكل دقيقة انتظار، حد أدنى). رحلات الحساب تُفوتر للشركة شهريًا، والسائق يسلّم النقد.

CREATE TABLE ops.tx_car (
  asset_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  class text NOT NULL CHECK (class IN ('sedan','suv','van','luxury')),
  UNIQUE (tenant_id, asset_id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id)
);

-- تعرفة الفئة لكل كيان قانوني، يدخلها المكتب
CREATE TABLE ops.tx_tariff (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  class text NOT NULL CHECK (class IN ('sedan','suv','van','luxury')),
  base numeric(18,3) NOT NULL CHECK (base >= 0),
  per_km numeric(18,3) NOT NULL CHECK (per_km >= 0),
  per_wait_min numeric(18,3) NOT NULL DEFAULT 0 CHECK (per_wait_min >= 0),
  min_fare numeric(18,3) NOT NULL DEFAULT 0 CHECK (min_fare >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, class),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

CREATE TABLE ops.tx_booking (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^TX-[0-9]{1,9}$'),
  customer_id uuid,                                                  -- حساب شركة، أو بلا حساب لراكب نقدي
  passenger_name text NOT NULL CHECK (length(passenger_name) BETWEEN 1 AND 120),
  passenger_phone text NOT NULL CHECK (passenger_phone ~ '^\+[1-9][0-9]{7,14}$'),
  pickup jsonb NOT NULL CHECK (jsonb_typeof(pickup) = 'object' AND length(pickup::text) <= 2000),
  dropoff jsonb CHECK (dropoff IS NULL OR (jsonb_typeof(dropoff) = 'object' AND length(dropoff::text) <= 2000)),
  pickup_at timestamptz NOT NULL,
  hold_min smallint NOT NULL DEFAULT 60 CHECK (hold_min BETWEEN 15 AND 720),
  class text NOT NULL DEFAULT 'sedan' CHECK (class IN ('sedan','suv','van','luxury')),
  pax smallint NOT NULL DEFAULT 1 CHECK (pax BETWEEN 1 AND 14),
  flight_no text CHECK (flight_no ~ '^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$'),
  notes text CHECK (length(notes) <= 500),
  fixed_fare numeric(18,3) CHECK (fixed_fare >= 0),                 -- سعر ثابت من المكتب (مطار، ساعات، عقد)
  task_id uuid,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  arrived_at timestamptz, picked_at timestamptz, dropped_at timestamptz,
  km numeric(6,1) CHECK (km BETWEEN 0 AND 1000),
  wait_min smallint CHECK (wait_min BETWEEN 0 AND 720),
  fare numeric(18,3) CHECK (fare >= 0),
  payment text CHECK (payment IN ('cash','card','account')),
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (payment IS DISTINCT FROM 'account' OR customer_id IS NOT NULL),
  CHECK ((dropped_at IS NULL) = (payment IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX tx_booking_day ON ops.tx_booking (tenant_id, pickup_at);
CREATE INDEX tx_booking_task ON ops.tx_booking (tenant_id, task_id);
CREATE INDEX tx_booking_customer ON ops.tx_booking (tenant_id, customer_id);

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','staffing','equipment','rental','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'taxi')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'] AND NOT ('taxi' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
