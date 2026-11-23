-- 0032: وحدة النقل المدرسي (school، القطاع 10): خطوط تنقل الطلاب بين بيوتهم والمدرسة، صباحًا إلى المدرسة وظهرًا إلى البيت.
-- الخط له مدرسة، واتجاه، وموعد انطلاق، وأيام دراسة، ومحطات مرتبة، وحافلة وسائق ومشرفة افتراضيون، وقائمة طلاب بهاتف ولي الأمر.
-- كل يوم دراسي تُولَّد رحلة لكل خط: مهمة تحجز الحافلة والسائق، ومهمة ثانية تحجز المشرفة، حصريًا لنافذة الرحلة.
-- السائق أو المشرفة يسجّل صعود كل طالب أو غيابه أو نزوله (سجل لا يُعدَّل، وآخر تسجيل هو المعتمد). لا تُغلق الرحلة وفيها طالب
-- لم ينزل أو طالب متوقع لم يُسجَّل. الطفل الصغير في رحلة العودة يُسلَّم لشخص بالغ باسمه. ولي الأمر يبلغ المكتب بالغياب مسبقًا.

CREATE TABLE ops.sch_route (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid,                                                  -- المدرسة إن كانت هي العميل، أو بلا عميل لاشتراكات الأهالي
  school_name text NOT NULL CHECK (length(school_name) BETWEEN 1 AND 120),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  direction text NOT NULL CHECK (direction IN ('to_school','from_school')),
  depart_time time NOT NULL,
  duration_min smallint NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 10 AND 240),
  days smallint[] NOT NULL DEFAULT ARRAY[7,1,2,3,4]::smallint[]
    CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  stops jsonb NOT NULL CHECK (jsonb_typeof(stops) = 'array' AND jsonb_array_length(stops) BETWEEN 1 AND 40),
  capacity smallint CHECK (capacity BETWEEN 1 AND 120),
  asset_id uuid,
  driver_worker_id uuid,
  attendant_worker_id uuid,                                          -- المشرفة
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (attendant_worker_id IS NULL OR attendant_worker_id <> driver_worker_id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, attendant_worker_id) REFERENCES workforce.worker (tenant_id, id)
);

-- الطالب: على خط، بمحطته، وهاتف ولي الأمر، وهل يُسلَّم لبالغ عند النزول في البيت
CREATE TABLE ops.sch_student (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  grade text CHECK (length(grade) BETWEEN 1 AND 20),
  stop_seq smallint NOT NULL CHECK (stop_seq BETWEEN 1 AND 40),
  guardian_name text CHECK (length(guardian_name) <= 120),
  guardian_phone text NOT NULL CHECK (guardian_phone ~ '^\+[1-9][0-9]{7,14}$'),
  handover boolean NOT NULL DEFAULT false,
  note text CHECK (length(note) <= 300),                              -- ملاحظة للمشرفة (حساسية، دواء، باب البيت)
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.sch_route (tenant_id, id)
);
CREATE INDEX sch_student_route ON ops.sch_student (tenant_id, route_id) WHERE active;

-- بلاغ غياب مسبق من ولي الأمر أو المدرسة: يوم، ورحلة الذهاب أو العودة أو كلتاهما
CREATE TABLE ops.sch_absence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  student_id uuid NOT NULL,
  day date NOT NULL,
  scope text NOT NULL DEFAULT 'both' CHECK (scope IN ('both','to_school','from_school')),
  reported_by text NOT NULL DEFAULT 'guardian' CHECK (reported_by IN ('guardian','school','office')),
  note text CHECK (length(note) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, student_id, day, scope),
  FOREIGN KEY (tenant_id, student_id) REFERENCES ops.sch_student (tenant_id, id)
);
CREATE INDEX sch_absence_day ON ops.sch_absence (tenant_id, day);

-- الرحلة: خط في يوم، بمهمة الحافلة والسائق ومهمة المشرفة
CREATE TABLE ops.sch_trip (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  trip_date date NOT NULL,
  task_id uuid NOT NULL,
  attendant_task_id uuid,
  asset_id uuid NOT NULL,
  driver_worker_id uuid NOT NULL,
  attendant_worker_id uuid,
  students_planned smallint NOT NULL DEFAULT 0,
  capacity smallint,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, route_id, trip_date),
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, attendant_task_id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.sch_route (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, attendant_task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, attendant_worker_id) REFERENCES workforce.worker (tenant_id, id)
);
CREATE INDEX sch_trip_date ON ops.sch_trip (tenant_id, trip_date);
REVOKE DELETE, TRUNCATE ON ops.sch_trip FROM app_rw;

-- الصعود والغياب والنزول: سجل لا يُعدَّل؛ آخر تسجيل للطالب في الرحلة هو المعتمد
CREATE TABLE ops.sch_mark (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  student_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('boarded','absent','dropped')),
  received_by text CHECK (length(received_by) BETWEEN 1 AND 120),     -- البالغ الذي استلم الطفل عند النزول
  occurred_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('driver','office')),
  actor_id uuid,
  client_op_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  CHECK (received_by IS NULL OR event = 'dropped'),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES ops.sch_trip (tenant_id, id),
  FOREIGN KEY (tenant_id, student_id) REFERENCES ops.sch_student (tenant_id, id)
);
CREATE INDEX sch_mark_trip ON ops.sch_mark (tenant_id, trip_id, student_id, occurred_at DESC);
CREATE INDEX sch_mark_student ON ops.sch_mark (tenant_id, student_id, occurred_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.sch_mark FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'school')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','shuttle','staffing','equipment','rental','concrete','internal','service','distribution'] AND NOT ('school' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
