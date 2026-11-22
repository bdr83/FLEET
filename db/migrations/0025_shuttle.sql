-- 0025: وحدة نقل الموظفين (shuttle، القطاع 11): خطوط ثابتة تنقل موظفي عميل (أو موظفي الشركة) بين السكن والعمل.
-- الخط له اتجاه (إلى العمل أو منه)، وموعد انطلاق، وأيام تشغيل، ومحطات مرتبة، وحافلة وسائق افتراضيان، وقائمة ركاب.
-- كل يوم تشغيل تُولَّد رحلة لكل خط: مهمة (ops.task) تحجز الحافلة والسائق حصريًا لنافذة الرحلة، فلا تُحجز مرتين بين القطاعات.
-- السائق يسجّل صعود كل راكب أو غيابه (سجل لا يُعدَّل، وآخر تسجيل للراكب هو المعتمد). الفوترة من عقود النواة.

CREATE TABLE ops.shuttle_route (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid,                                                  -- العميل صاحب الموظفين، أو بلا عميل لموظفي الشركة
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  direction text NOT NULL CHECK (direction IN ('to_work','from_work')),
  depart_time time NOT NULL,                                         -- بتوقيت الكيان القانوني
  duration_min smallint NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 10 AND 480),
  days smallint[] NOT NULL DEFAULT ARRAY[7,1,2,3,4]::smallint[]      -- أيام ISO (1 الإثنين … 7 الأحد)؛ الافتراضي الأحد-الخميس
    CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  stops jsonb NOT NULL CHECK (jsonb_typeof(stops) = 'array' AND jsonb_array_length(stops) BETWEEN 1 AND 40),  -- [{name, area?, lat?, lng?, offset_min}]
  capacity smallint CHECK (capacity BETWEEN 1 AND 120),
  asset_id uuid,
  driver_worker_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id)
);

-- الراكب: موظف على خط، بمحطة صعوده (أو نزوله في اتجاه العودة)
CREATE TABLE ops.shuttle_rider (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  staff_no text CHECK (staff_no ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$'),
  phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  stop_seq smallint NOT NULL CHECK (stop_seq BETWEEN 1 AND 40),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, route_id, staff_no),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.shuttle_route (tenant_id, id)
);
CREATE INDEX shuttle_rider_route ON ops.shuttle_rider (tenant_id, route_id) WHERE active;

-- الرحلة: خط في يوم، بمهمتها وحافلتها وسائقها
CREATE TABLE ops.shuttle_trip (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  trip_date date NOT NULL,
  task_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  driver_worker_id uuid NOT NULL,
  riders_planned smallint NOT NULL DEFAULT 0,
  capacity smallint,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, route_id, trip_date),
  UNIQUE (tenant_id, task_id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.shuttle_route (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id)
);
CREATE INDEX shuttle_trip_date ON ops.shuttle_trip (tenant_id, trip_date);
REVOKE DELETE, TRUNCATE ON ops.shuttle_trip FROM app_rw;

-- الصعود والغياب: سجل لا يُعدَّل؛ آخر تسجيل للراكب في الرحلة هو المعتمد (تصحيح المكتب أو السائق)
CREATE TABLE ops.shuttle_board (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  rider_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('boarded','no_show')),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('driver','office')),
  actor_id uuid,
  client_op_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES ops.shuttle_trip (tenant_id, id),
  FOREIGN KEY (tenant_id, rider_id) REFERENCES ops.shuttle_rider (tenant_id, id)
);
CREATE INDEX shuttle_board_trip ON ops.shuttle_board (tenant_id, trip_id, rider_id, occurred_at DESC);
CREATE INDEX shuttle_board_rider ON ops.shuttle_board (tenant_id, rider_id, occurred_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.shuttle_board FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','shuttle','staffing','concrete','internal','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'shuttle')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','staffing','concrete','internal','distribution'] AND NOT ('shuttle' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
