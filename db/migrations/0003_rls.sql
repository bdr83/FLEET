-- 0003: عزل الشركات بـ RLS على كل جدول فيه tenant_id
ALTER TABLE ops.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.task FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ops.task
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- تضييق إضافي حسب الشركة القانونية والفرع المصرح بهما
CREATE POLICY entity_scope ON ops.task AS RESTRICTIVE
  USING (nullif(current_setting('app.entity_ids', true), '') IS NULL
         OR legal_entity_id = ANY (nullif(current_setting('app.entity_ids', true), '')::uuid[]));

-- العزل نفسه على كل جدول فيه tenant_id، يُولَّد من الفهرس في كل migration
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.oid::regclass AS tbl FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
           WHERE c.relkind IN ('r','p') AND NOT c.relispartition
             AND n.nspname IN ('org','fleet','workforce','shift','ops','geo','billing','core')
             AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %s
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)$p$, t.tbl);
  END LOOP;
END $$;
-- org.role: الأدوار القياسية (tenant_id NULL) مقروءة للجميع
CREATE POLICY role_platform_read ON org.role FOR SELECT USING (tenant_id IS NULL);
