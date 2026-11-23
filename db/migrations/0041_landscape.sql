-- 0041: وحدة تنسيق الحدائق وصيانتها (landscape، القطاع 27): عقود صيانة دورية لحدائق الفلل والمجمعات والجهات.
-- الحديقة (موقع العقد) لعميل: المساحة والخدمات المتعاقد عليها (قص، تقليم، ري...) وأيام الزيارة ووقتها ومدتها،
-- ورئيس الطاقم وعدد العمال والمركبة، وهل فيها شبكة ري. كل يوم زيارة تُنشأ زيارة (LV-رمز-تاريخ) بمهمة تحجز رئيس الطاقم
-- والمركبة. رئيس الطاقم يسجّل الوصول ثم الإنجاز: الخدمات المنفذة (وما لم يُنفذ يحتاج ملاحظة) وحالة شبكة الري وعدد
-- أكياس المخلفات الخضراء. عطل الري يبقى مفتوحًا حتى يغلقه المكتب. ويمكن إضافة زيارة إضافية (زراعة، تنظيف بعد مناسبة).

CREATE TABLE ops.ls_site (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  customer_id uuid NOT NULL,
  area text CHECK (length(area) <= 80),
  address text CHECK (length(address) <= 200),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  contact_phone text CHECK (length(contact_phone) <= 20),
  area_m2 integer CHECK (area_m2 BETWEEN 1 AND 10000000),
  services text[] NOT NULL CHECK (cardinality(services) BETWEEN 1 AND 10),
  days smallint[] NOT NULL DEFAULT '{1,4}',                               -- 1 الاثنين ... 7 الأحد
  visit_time text NOT NULL DEFAULT '07:00' CHECK (visit_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min smallint NOT NULL DEFAULT 120 CHECK (duration_min BETWEEN 15 AND 720),
  lead_worker_id uuid,                                                  -- رئيس الطاقم
  crew_size smallint NOT NULL DEFAULT 2 CHECK (crew_size BETWEEN 1 AND 50),
  asset_id uuid,
  irrigation boolean NOT NULL DEFAULT true,                             -- فيها شبكة ري تُفحص كل زيارة
  instructions text CHECK (length(instructions) <= 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id)
);

CREATE TABLE ops.ls_visit (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^LV-[A-Z0-9_-]{1,12}-[0-9]{8}(-[0-9]{1,3})?$'),
  visit_date date NOT NULL,
  extra boolean NOT NULL DEFAULT false,                                 -- زيارة إضافية خارج الجدول
  task_id uuid NOT NULL,
  lead_worker_id uuid NOT NULL,
  asset_id uuid,
  services_planned text[] NOT NULL,
  arrived_at timestamptz,
  done_at timestamptz,
  services_done text[],
  irrigation text CHECK (irrigation IN ('ok','leak','broken','dry_area','not_checked')),
  waste_bags smallint CHECK (waste_bags BETWEEN 0 AND 500),
  received_by text CHECK (length(received_by) <= 120),
  result_note text CHECK (length(result_note) <= 500),
  issue_closed_at timestamptz, issue_close_note text CHECK (length(issue_close_note) <= 500), issue_closed_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, task_id),
  CHECK (done_at IS NULL OR (services_done IS NOT NULL AND waste_bags IS NOT NULL)),
  CHECK ((issue_closed_at IS NULL) = (issue_close_note IS NULL)),
  FOREIGN KEY (tenant_id, site_id) REFERENCES ops.ls_site (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_worker_id) REFERENCES workforce.worker (tenant_id, id)
);
-- زيارة مجدولة واحدة لكل حديقة في اليوم؛ الإضافية بلا حد
CREATE UNIQUE INDEX ls_visit_day ON ops.ls_visit (tenant_id, site_id, visit_date) WHERE NOT extra;
CREATE INDEX ls_visit_date ON ops.ls_visit (tenant_id, visit_date);
REVOKE DELETE, TRUNCATE ON ops.ls_visit FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','utilities','security','pest','landscape','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'landscape')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','moving','containers','tankers','warehouse','ecommerce','school','shuttle','taxi','tour','staffing','equipment','rental','oilgas','cranes','concrete','internal','service','waste','utilities','security','pest','distribution'] AND NOT ('landscape' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
