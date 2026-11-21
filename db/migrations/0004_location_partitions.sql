-- 0004: صيانة أقسام جدول المواقع: إنشاء أقسام الأيام القادمة وحذف ما تجاوز مدة الحفظ (D6: 90 يومًا).
-- تُستدعى يوميًا من مهمة مجدولة: SELECT geo.maintain_location_partitions();
CREATE FUNCTION geo.maintain_location_partitions(days_ahead int DEFAULT 7, retention_days int DEFAULT 90)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d date; r record;
BEGIN
  FOR i IN -1..days_ahead LOOP
    d := (now() AT TIME ZONE 'UTC')::date + i;
    IF to_regclass(format('geo.location_point_%s', to_char(d, 'YYYYMMDD'))) IS NULL THEN
      EXECUTE format('CREATE TABLE geo.%I PARTITION OF geo.location_point FOR VALUES FROM (%L) TO (%L)',
                     'location_point_' || to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz);
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
DO $$ BEGIN PERFORM geo.maintain_location_partitions(); END $$;
