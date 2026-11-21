-- 0005: الهوية والصلاحيات (المرحلة P1)

-- الأدوار القياسية من المنصة (tenant_id NULL). الصلاحيات بصيغة مورد:فعل، و'*' للمالك.
ALTER TABLE org.role ADD CONSTRAINT role_code_unique UNIQUE NULLS NOT DISTINCT (tenant_id, code);
INSERT INTO org.role (id, tenant_id, code, permissions) VALUES
 ('00000000-0000-4000-8000-000000000001', NULL, 'owner',             ARRAY['*']),
 ('00000000-0000-4000-8000-000000000002', NULL, 'admin',             ARRAY['org:read','org:write','members:read','members:write','tasks:read','tasks:write','tasks:assign','fleet:read','fleet:write','billing:read','reports:read']),
 ('00000000-0000-4000-8000-000000000003', NULL, 'dispatcher',        ARRAY['org:read','tasks:read','tasks:write','tasks:assign','fleet:read','reports:read']),
 ('00000000-0000-4000-8000-000000000004', NULL, 'accountant',        ARRAY['org:read','tasks:read','billing:read','billing:write','reports:read']),
 ('00000000-0000-4000-8000-000000000005', NULL, 'branch_supervisor', ARRAY['org:read','tasks:read','tasks:write','tasks:assign','fleet:read','members:read']),
 ('00000000-0000-4000-8000-000000000006', NULL, 'driver',            ARRAY['tasks:read_own','tasks:update_own','shift:own']),
 ('00000000-0000-4000-8000-000000000007', NULL, 'customer',          ARRAY['portal:own']);

-- عضوية واحدة نشطة لكل مستخدم في كل مؤسسة (تغيير الدور = تعديل العضوية)
ALTER TABLE org.membership DROP CONSTRAINT membership_tenant_id_user_id_role_id_key;
ALTER TABLE org.membership ADD COLUMN revoked_at timestamptz;
ALTER TABLE org.membership ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX membership_one_active ON org.membership (tenant_id, user_id) WHERE revoked_at IS NULL;

ALTER TABLE org.app_user ADD COLUMN display_name text;
ALTER TABLE org.app_user ADD COLUMN locale text NOT NULL DEFAULT 'ar';

-- ما قبل تسجيل الدخول: لا tenant_id هنا
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO app_rw;

CREATE TABLE auth.otp_challenge (
  id uuid PRIMARY KEY,
  phone text NOT NULL,
  code_hash text NOT NULL,              -- sha256(pepper || code)، لا يُخزن الرمز
  expires_at timestamptz NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_by_phone ON auth.otp_challenge (phone, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON auth.otp_challenge TO app_rw;

-- جلسات التجديد: الرمز نفسه يحمل tenant_id فيُبحث عنه تحت RLS
CREATE TABLE org.session (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES org.tenant(id),
  user_id uuid NOT NULL REFERENCES org.app_user(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);
ALTER TABLE org.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org.session
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- org.tenant بلا tenant_id: يُحمى بسياسة على id
ALTER TABLE org.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON org.tenant
  USING (id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (id = current_setting('app.tenant_id')::uuid);

-- الدالة الوحيدة التي تعبر الشركات: مؤسسات مستخدم واحد عند تسجيل الدخول
CREATE FUNCTION auth.user_memberships(p_user uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_status text, role_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT t.id, t.name, t.status, r.code
  FROM org.membership m
  JOIN org.tenant t ON t.id = m.tenant_id
  JOIN org.role r ON r.id = m.role_id
  WHERE m.user_id = p_user AND m.revoked_at IS NULL
    AND (m.valid_until IS NULL OR m.valid_until > now())
    AND t.status IN ('trial','active','past_due')
  ORDER BY t.name
$$;
GRANT USAGE ON SCHEMA org TO app_auth;
GRANT USAGE, CREATE ON SCHEMA auth TO app_auth;
GRANT SELECT ON org.membership, org.tenant, org.role TO app_auth;
ALTER FUNCTION auth.user_memberships(uuid) OWNER TO app_auth;
REVOKE ALL ON FUNCTION auth.user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.user_memberships(uuid) TO app_rw;

-- سجل التدقيق قابل للقراءة لمن يملك org:read (عبر الـ API)، والتطبيق يكتب فيه فقط
