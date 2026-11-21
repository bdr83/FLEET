-- 0013: ملفات صغيرة (صور إثبات التسليم أولًا). تُحفظ في قاعدة البيانات مؤقتًا للمرحلة التجريبية
-- مع حد 2 ميغابايت للملف؛ تُنقل لاحقًا إلى تخزين كائنات في منطقة خليجية [تحقق محلي].
CREATE TABLE ops.file_blob (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('pod','expense','document')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL,
  created_by uuid,
  client_op_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_op_id),
  UNIQUE (tenant_id, id)
);
REVOKE UPDATE, TRUNCATE ON ops.file_blob FROM app_rw;

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
