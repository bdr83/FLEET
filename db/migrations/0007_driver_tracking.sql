-- 0007 (P3): مناوبات السائق من التطبيق، استقبال المواقع، ومزامنة حالات المهام دون اتصال.

-- المناوبة: بداية ونهاية من التطبيق، مع مفتاح منع التكرار عند إعادة الإرسال
ALTER TABLE shift.shift
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN start_odometer_km integer CHECK (start_odometer_km >= 0),
  ADD COLUMN end_odometer_km integer CHECK (end_odometer_km >= 0),
  ADD COLUMN start_client_op_id uuid,
  ADD CONSTRAINT shift_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at),
  ADD CONSTRAINT shift_odometer_forward CHECK (end_odometer_km IS NULL OR start_odometer_km IS NULL OR end_odometer_km >= start_odometer_km),
  ADD CONSTRAINT shift_unique_id UNIQUE (tenant_id, id);
CREATE UNIQUE INDEX shift_start_op ON shift.shift (tenant_id, start_client_op_id) WHERE start_client_op_id IS NOT NULL;
-- مركبة واحدة لا تكون في مناوبتين مفتوحتين
CREATE UNIQUE INDEX one_open_shift_per_asset ON shift.shift (tenant_id, asset_id)
  WHERE asset_id IS NOT NULL AND started_at IS NOT NULL AND ended_at IS NULL;

-- ملاحظة السائق مع تغيير الحالة (سبب الفشل مثلًا)
ALTER TABLE ops.task_event ADD COLUMN note text CHECK (length(note) <= 500);
CREATE INDEX task_event_task ON ops.task_event (tenant_id, task_id, occurred_at);
CREATE INDEX assignment_worker_active ON ops.assignment (tenant_id, worker_id) WHERE active;

-- أمان: الأقسام اليومية لا ترث سياسات RLS من الجدول الأم، فلا يُسمح لـ app_rw بقراءتها مباشرة.
-- الوصول يكون عبر geo.location_point فقط (تُفحص الصلاحية والسياسة على الجدول الأم).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT i.inhrelid::regclass AS part FROM pg_inherits i WHERE i.inhparent = 'geo.location_point'::regclass LOOP
    EXECUTE format('REVOKE ALL ON %s FROM app_rw', r.part);
  END LOOP;
END $$;

-- صيانة الأقسام تُستدعى من الـ API (app_rw) فتعمل بصلاحية المالك، وتسحب صلاحية app_rw عن كل قسم جديد
CREATE OR REPLACE FUNCTION geo.maintain_location_partitions(days_ahead int DEFAULT 7, retention_days int DEFAULT 90)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, geo AS $$
DECLARE d date; r record; part text;
BEGIN
  IF days_ahead NOT BETWEEN 0 AND 60 OR retention_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'invalid arguments';
  END IF;
  FOR i IN -1..days_ahead LOOP
    d := (now() AT TIME ZONE 'UTC')::date + i;
    part := 'location_point_' || to_char(d, 'YYYYMMDD');
    IF to_regclass('geo.' || part) IS NULL THEN
      EXECUTE format('CREATE TABLE geo.%I PARTITION OF geo.location_point FOR VALUES FROM (%L) TO (%L)',
                     part, d::timestamptz, (d + 1)::timestamptz);  -- كما في 0004
      EXECUTE format('REVOKE ALL ON geo.%I FROM app_rw', part);
    END IF;
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'geo.location_point'::regclass
             AND c.relname ~ '^location_point_[0-9]{8}$'
             AND to_date(substr(c.relname, 16), 'YYYYMMDD') < (now() AT TIME ZONE 'UTC')::date - retention_days
  LOOP
    EXECUTE format('DROP TABLE geo.%I', r.relname);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION geo.maintain_location_partitions(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.maintain_location_partitions(int, int) TO app_rw;
-- دالة إضافة RLS للجداول الجديدة تخص الترحيلات فقط
REVOKE ALL ON FUNCTION core.apply_tenant_rls() FROM PUBLIC;
