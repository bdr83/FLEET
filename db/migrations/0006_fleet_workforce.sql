-- 0006: المركبات والعاملون والوثائق (المرحلة P2)

-- دالة واحدة تطبّق العزل على كل جدول جديد فيه tenant_id، ونطاق الشركة القانونية على كل جدول فيه legal_entity_id.
-- تُستدعى في آخر كل migration تضيف جداول.
CREATE FUNCTION core.apply_tenant_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.oid, c.oid::regclass AS tbl FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
           WHERE c.relkind IN ('r','p') AND NOT c.relispartition
             AND n.nspname IN ('org','fleet','workforce','shift','ops','geo','billing','core','crm','maint')
             AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %s
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)$p$, t.tbl);
  END LOOP;
  FOR t IN SELECT c.oid, c.oid::regclass AS tbl FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'legal_entity_id' AND NOT a.attisdropped
           WHERE c.relkind IN ('r','p') AND NOT c.relispartition
             AND n.nspname IN ('org','fleet','workforce','shift','ops','geo','billing','core','crm','maint')
             AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'entity_scope')
  LOOP
    EXECUTE format($p$CREATE POLICY entity_scope ON %s AS RESTRICTIVE
      USING (nullif(current_setting('app.entity_ids', true), '') IS NULL
             OR legal_entity_id = ANY (nullif(current_setting('app.entity_ids', true), '')::uuid[]))$p$, t.tbl);
  END LOOP;
END $$;

-- المركبات
ALTER TABLE fleet.asset
  ADD COLUMN branch_id uuid,
  ADD COLUMN make text, ADD COLUMN model text, ADD COLUMN year smallint CHECK (year BETWEEN 1980 AND 2100),
  ADD COLUMN vin text,
  ADD COLUMN odometer_km integer CHECK (odometer_km >= 0),
  ADD COLUMN notes text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id);
ALTER TABLE org.branch ADD UNIQUE (tenant_id, id);
ALTER TABLE fleet.asset ADD FOREIGN KEY (tenant_id, branch_id) REFERENCES org.branch (tenant_id, id);
ALTER TABLE fleet.asset ADD CONSTRAINT asset_type_known CHECK (asset_type IN ('car','motorbike','van','pickup','truck','mixer','pump','trailer','bus','other'));

-- العاملون: مرتبطون بهوية تسجيل الدخول عبر user_id
ALTER TABLE workforce.worker
  ADD COLUMN display_name text NOT NULL DEFAULT '',
  ADD COLUMN phone text,
  ADD COLUMN branch_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, branch_id) REFERENCES org.branch (tenant_id, id),
  ADD CONSTRAINT worker_status_known CHECK (status IN ('active','on_leave','suspended','left'));
CREATE UNIQUE INDEX worker_one_per_user ON workforce.worker (tenant_id, user_id) WHERE user_id IS NOT NULL AND status <> 'left';

-- الوثائق: رخصة القيادة، دفتر المركبة، التأمين، الإقامة... أنواعها قابلة للتوسع حسب القطاع [تحقق محلي]
CREATE TABLE core.document (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  asset_id uuid,
  worker_id uuid,
  doc_type text NOT NULL CHECK (doc_type ~ '^[a-z_]{2,40}$'),
  number text,
  issued_on date,
  expires_on date,
  file_key text,                         -- مسار الملف في التخزين (P3+)
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((asset_id IS NULL) <> (worker_id IS NULL)),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fleet.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);
CREATE INDEX document_expiry ON core.document (tenant_id, expires_on) WHERE archived_at IS NULL;

-- نطاق الشركة القانونية على مستوى القاعدة (لا التطبيق فقط) لكل الجداول التي تحمل legal_entity_id
DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
-- org.legal_entity نفسها: النطاق على id
CREATE POLICY entity_scope ON org.legal_entity AS RESTRICTIVE
  USING (nullif(current_setting('app.entity_ids', true), '') IS NULL
         OR id = ANY (nullif(current_setting('app.entity_ids', true), '')::uuid[]));
