-- 0021: وحدة التوزيع الغذائي والتبريد (coldchain، القطاع 3). تبني على مسارات التوزيع (0017) وتضيف:
-- فئة حرارة المسار ونطاقها، نوافذ تسليم لكل توقف، البضاعة التالفة عند التسليم، وصلاحية الأصناف، وسجل قراءات الحرارة.
-- القراءات يدوية من السائق أو المكتب، أو من جهاز/تطبيق خارجي اختياري؛ لا نفترض قياسًا مباشرًا بلا مصدر موثوق.

ALTER TABLE ops.dist_route
  ADD COLUMN temp_class text NOT NULL DEFAULT 'ambient' CHECK (temp_class IN ('ambient','chilled','frozen')),
  ADD COLUMN temp_min numeric(4,1) CHECK (temp_min BETWEEN -50 AND 60),
  ADD COLUMN temp_max numeric(4,1) CHECK (temp_max BETWEEN -50 AND 60),
  ADD CONSTRAINT dist_route_temp_range CHECK (temp_min IS NULL OR temp_max IS NULL OR temp_min <= temp_max),
  ADD CONSTRAINT dist_route_temp_needed CHECK (temp_class = 'ambient' OR (temp_min IS NOT NULL AND temp_max IS NOT NULL));

ALTER TABLE ops.dist_stop
  ADD COLUMN window_from timestamptz,
  ADD COLUMN window_to timestamptz,
  ADD COLUMN damaged jsonb CHECK (jsonb_typeof(damaged) = 'object'),   -- {sku: qty} تالف أو غير صالح عند التسليم
  ADD CONSTRAINT dist_stop_window CHECK (window_from IS NULL OR window_to IS NULL OR window_from < window_to);

CREATE TABLE ops.temp_reading (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  route_id uuid NOT NULL,
  stop_task_id uuid,
  reading_c numeric(4,1) NOT NULL CHECK (reading_c BETWEEN -50 AND 60),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','device','external')),
  device_ref text CHECK (length(device_ref) <= 80),
  in_range boolean,                                                   -- NULL لمسار بلا نطاق
  recorded_at timestamptz NOT NULL,
  recorded_by uuid,
  note text CHECK (length(note) <= 300),
  client_op_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_op_id),
  FOREIGN KEY (tenant_id, route_id) REFERENCES ops.dist_route (tenant_id, id),
  FOREIGN KEY (tenant_id, stop_task_id) REFERENCES ops.dist_stop (tenant_id, task_id)
);
CREATE INDEX temp_reading_route ON ops.temp_reading (tenant_id, route_id, recorded_at);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.temp_reading FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','staffing','concrete','internal','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'coldchain')
 WHERE packs @> ARRAY['delivery','freight','staffing','concrete','internal','distribution'] AND NOT ('coldchain' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
