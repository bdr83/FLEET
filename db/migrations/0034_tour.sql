-- 0034: وحدة الحافلات السياحية (tour، القطاع 13): مكاتب السياحة والمدارس والشركات والمجموعات تستأجر حافلات بسائقيها لرحلة:
-- يوم، أو فعالية، أو أيام عبر الحدود (عمرة، جولة خليجية). الرحلة لها مجموعة ركاب وبداية ونهاية وبرنامج وسعر من المكتب.
-- تُضاف لها حافلة أو أكثر؛ كل حافلة مهمة تحجز الحافلة وسائقها حصريًا طوال الرحلة. السائق يعدّ الركاب ويقرأ العداد عند الصعود
-- وعند العودة؛ العائدون أقل من الصاعدين يحتاج ملاحظة. رحلات عبر الحدود تحتاج كشف الركاب.

CREATE TABLE ops.tour_trip (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^TR-[0-9]{1,9}$'),
  customer_id uuid NOT NULL,
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 120),
  contact_name text CHECK (length(contact_name) <= 120),
  contact_phone text CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  pax smallint NOT NULL CHECK (pax BETWEEN 1 AND 2000),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  pickup text NOT NULL CHECK (length(pickup) BETWEEN 1 AND 200),
  destination text NOT NULL CHECK (length(destination) BETWEEN 1 AND 200),
  itinerary jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(itinerary) = 'array' AND jsonb_array_length(itinerary) <= 40),
  cross_border boolean NOT NULL DEFAULT false,
  price numeric(18,3) CHECK (price >= 0),
  deposit numeric(18,3) CHECK (deposit >= 0),
  notes text CHECK (length(notes) <= 1000),
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK (end_at > start_at AND end_at <= start_at + interval '31 days'),
  CHECK (deposit IS NULL OR price IS NULL OR deposit <= price),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
CREATE INDEX tour_trip_start ON ops.tour_trip (tenant_id, start_at);

-- حافلة في الرحلة: مهمة تحجز الحافلة والسائق؛ عدّ الركاب والعداد عند الصعود والعودة
CREATE TABLE ops.tour_bus (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 99),
  asset_id uuid NOT NULL,
  seats smallint CHECK (seats BETWEEN 1 AND 120),
  boarded smallint CHECK (boarded BETWEEN 0 AND 120),
  odometer_out integer CHECK (odometer_out >= 0),
  departed_at timestamptz,
  returned smallint CHECK (returned BETWEEN 0 AND 120),
  odometer_in integer CHECK (odometer_in >= 0),
  returned_at timestamptz,
  return_note text CHECK (length(return_note) <= 500),
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, trip_id, seq),
  CHECK (odometer_in IS NULL OR odometer_out IS NULL OR odometer_in >= odometer_out),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES ops.tour_trip (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id)
);
CREATE INDEX tour_bus_trip ON ops.tour_bus (tenant_id, trip_id);
REVOKE DELETE, TRUNCATE ON ops.tour_bus FROM app_rw;

-- كشف الركاب (إلزامي لرحلات الحدود): الاسم ورقم الهوية أو الجواز
CREATE TABLE ops.tour_pax (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  id_no text CHECK (id_no ~ '^[A-Za-z0-9]{5,20}$'),
  nationality text CHECK (length(nationality) <= 60),
  phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  bus_seq smallint CHECK (bus_seq BETWEEN 1 AND 99),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, trip_id, id_no),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES ops.tour_trip (tenant_id, id)
);
CREATE INDEX tour_pax_trip ON ops.tour_pax (tenant_id, trip_id);

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'tour')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','staffing','equipment','rental','concrete','internal','service','distribution'] AND NOT ('tour' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
