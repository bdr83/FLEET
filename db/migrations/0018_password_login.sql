-- 0018: الدخول بالبريد وكلمة المرور (إلى جانب رمز الجوال)
-- لا تُخزن كلمة المرور: scrypt مع ملح عشوائي، بصيغة scrypt$N$r$p$salt$hash
ALTER TABLE org.app_user ADD COLUMN password_hash text;
ALTER TABLE org.app_user ADD COLUMN password_changed_at timestamptz;
ALTER TABLE org.app_user ADD COLUMN failed_logins smallint NOT NULL DEFAULT 0;
ALTER TABLE org.app_user ADD COLUMN locked_until timestamptz;
-- البريد يُخزن بأحرف صغيرة، ولا يتكرر بغض النظر عن حالة الأحرف
UPDATE org.app_user SET email = lower(email) WHERE email IS NOT NULL AND email <> lower(email);
ALTER TABLE org.app_user ADD CONSTRAINT app_user_email_lower CHECK (email = lower(email));

-- روابط استعادة كلمة المرور: يُخزن sha256 للرمز فقط، صالحة ساعة، تُستخدم مرة واحدة
CREATE TABLE auth.password_reset (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES org.app_user(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_by_user ON auth.password_reset (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON auth.password_reset TO app_rw;
