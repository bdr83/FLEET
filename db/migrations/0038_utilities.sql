-- 0038: وحدة المرافق (utilities، القطاع 24): أوامر عمل ميدانية لمقاولي الكهرباء والماء والاتصالات.
-- أمر العمل (UJ-n) لعميل (الجهة صاحبة الشبكة أو المقاول الرئيسي): نوع العمل والشبكة والأولوية وموعد الاستجابة، والموقع،
-- ورقم الأصل (مغذٍّ، محول، خط، كابينة)، وعدد المشتركين المتأثرين. أعمال الحفر تحتاج تصريح حفر ساريًا قبل العزل والعمل،
-- وإعادة الطريق (reinstatement) قبل إغلاق الأمر. الفرقة (سيارة وقائد) تُحجز للأمر؛ وتسجّل: الوصول، العزل وقائمة السلامة،
-- الإصلاح بنتيجته، وإعادة الطريق. زمن الاستجابة من البلاغ للوصول، وزمن الانقطاع من البلاغ للإصلاح.

CREATE TABLE ops.ut_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^UJ-[0-9]{1,9}$'),
  customer_id uuid,
  network text NOT NULL CHECK (network IN ('electricity','water','telecom')),
  job_type text NOT NULL CHECK (job_type IN ('outage','repair','connection','meter','inspection','excavation')),
  priority text NOT NULL CHECK (priority IN ('emergency','urgent','planned')),
  reported_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,                                       -- آخر موعد للوصول
  duration_min smallint NOT NULL DEFAULT 240 CHECK (duration_min BETWEEN 30 AND 1440),
  area text NOT NULL CHECK (length(area) BETWEEN 1 AND 80),
  address text CHECK (length(address) <= 200),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  asset_ref text CHECK (length(asset_ref) <= 60),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  affected integer NOT NULL DEFAULT 0 CHECK (affected BETWEEN 0 AND 1000000),
  needs_permit boolean NOT NULL DEFAULT false,
  permit_no text CHECK (length(permit_no) <= 40),
  permit_expires date,
  task_id uuid,
  attempts smallint NOT NULL DEFAULT 0,
  arrived_at timestamptz, isolated_at timestamptz, restored_at timestamptz, reinstated_at timestamptz,
  result text CHECK (result IN ('fixed','follow_up','not_fixed')),
  result_note text CHECK (length(result_note) <= 500),
  checks jsonb CHECK (jsonb_typeof(checks) = 'object'),
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, task_id),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK ((permit_no IS NULL) = (permit_expires IS NULL)),
  CHECK (due_at >= reported_at),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (restored_at IS NULL OR result IS NOT NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX ut_job_reported ON ops.ut_job (tenant_id, reported_at);
REVOKE DELETE, TRUNCATE ON ops.ut_job FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','utilities','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'utilities')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','distribution'] AND NOT ('utilities' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
