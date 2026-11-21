-- يُشغَّل مرة واحدة لكل بيئة بصلاحية superuser.
-- psql -v app_rw_password="'...'" -f db/bootstrap.sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner NOLOGIN;          -- يملك الجداول؛ migrations تعمل به
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS;  -- التطبيق يتصل به
  END IF;
END $$;
ALTER ROLE app_rw PASSWORD :app_rw_password;
GRANT CREATE ON DATABASE :"DBNAME" TO app_owner;
GRANT app_owner TO CURRENT_USER;
