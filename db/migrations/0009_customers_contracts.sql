-- 0009 (P6): العملاء ومواقعهم والعقود وبنود الأسعار، وبوابة العميل.
CREATE SCHEMA IF NOT EXISTS crm;
GRANT USAGE ON SCHEMA crm TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;

CREATE TABLE crm.customer (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES org.tenant(id),
  legal_entity_id uuid NOT NULL,
  ref text CHECK (length(ref) <= 40),                 -- رقم العميل في نظام الشركة
  kind text NOT NULL DEFAULT 'business' CHECK (kind IN ('business','individual')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  phone text, email text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  cr_number text,                                     -- السجل التجاري [تحقق محلي]
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  credit_limit numeric(18,3) CHECK (credit_limit >= 0), -- NULL = بلا حد
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','closed')),
  notes text CHECK (length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);
CREATE UNIQUE INDEX customer_ref_unique ON crm.customer (tenant_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX customer_name ON crm.customer (tenant_id, lower(name));

-- موقع العميل: فرع، مستودع، أو موقع إنشاء (للخرسانة)
CREATE TABLE crm.site (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  address text CHECK (length(address) <= 500),
  location geography(Point,4326),
  contact_name text, contact_phone text,
  notes text CHECK (length(notes) <= 1000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);

CREATE TABLE crm.contract (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  starts_on date NOT NULL,
  ends_on date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','suspended','ended')),
  currency char(3) NOT NULL,
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  notes text CHECK (length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);
-- عقد فعّال واحد للعميل في أي يوم، حتى لا يكون سعر المهمة ملتبسًا
ALTER TABLE crm.contract ADD CONSTRAINT one_active_contract
  EXCLUDE USING gist (tenant_id WITH =, customer_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
  WHERE (status = 'active');

-- بند السعر: لكل نوع مهمة (sector_pack) ووحدة. NULL في sector_pack = يسري على كل الأنواع.
CREATE TABLE crm.rate (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  sector_pack text CHECK (sector_pack ~ '^[a-z][a-z0-9_]*@[0-9]+$'),
  unit text NOT NULL CHECK (unit IN ('task','km','hour','trip','m3','ton','day','month')),
  price numeric(18,3) NOT NULL CHECK (price >= 0),
  included_qty numeric(12,3) NOT NULL DEFAULT 0 CHECK (included_qty >= 0),  -- كمية مشمولة قبل الاحتساب
  min_charge numeric(18,3) NOT NULL DEFAULT 0 CHECK (min_charge >= 0),
  description text CHECK (length(description) <= 200),
  UNIQUE NULLS NOT DISTINCT (tenant_id, contract_id, sector_pack, unit),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES crm.contract (tenant_id, id) ON DELETE CASCADE
);

-- ربط المهمة والطلب بالعميل وموقعه وعقده
ALTER TABLE ops.task ADD COLUMN site_id uuid, ADD COLUMN contract_id uuid,
  ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, site_id) REFERENCES crm.site (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, contract_id) REFERENCES crm.contract (tenant_id, id);
CREATE INDEX task_customer ON ops.task (tenant_id, customer_id);
ALTER TABLE ops.job ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id);

-- مستخدم بوابة العميل: عضوية بدور customer مرتبطة بعميل واحد
ALTER TABLE org.membership ADD COLUMN customer_id uuid,
  ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id);

-- صلاحيات العملاء للأدوار القياسية
UPDATE org.role SET permissions = permissions || ARRAY['customers:read','customers:write'] WHERE tenant_id IS NULL AND code IN ('admin','accountant');
UPDATE org.role SET permissions = permissions || ARRAY['customers:read'] WHERE tenant_id IS NULL AND code IN ('dispatcher','branch_supervisor');

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;

-- العميل يلغي طلبه من البوابة قبل الإسناد
ALTER TABLE ops.task_event DROP CONSTRAINT task_event_actor_type_check;
ALTER TABLE ops.task_event ADD CONSTRAINT task_event_actor_type_check CHECK (actor_type IN ('driver','staff','customer','system'));
