-- يُشغَّل مرة واحدة لكل بيئة بصلاحية superuser.
-- psql -v app_rw_password="'...'" -f db/bootstrap.sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    -- يملك الجداول؛ migrations فقط تعمل به (SET ROLE). يتجاوز RLS حتى يتحقق من القيود على كل الصفوف.
    CREATE ROLE app_owner NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS;  -- التطبيق يتصل به
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    -- يملك دوال auth.* القليلة التي تعبر الشركات بطبيعتها (مثل: عضويات مستخدم في كل مؤسساته)
    CREATE ROLE app_auth NOLOGIN BYPASSRLS;
  END IF;
END $$;
ALTER ROLE app_owner BYPASSRLS;
ALTER ROLE app_rw PASSWORD :app_rw_password;
GRANT CREATE ON DATABASE :"DBNAME" TO app_owner;
GRANT app_owner TO CURRENT_USER;
GRANT app_auth TO CURRENT_USER;
GRANT app_auth TO app_owner;
