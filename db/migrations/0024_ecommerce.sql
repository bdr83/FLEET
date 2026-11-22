-- 0024: وحدة شحن التجارة الإلكترونية (ecommerce، القطاع 9): المتاجر (عملاء) ترسل طلباتها عبر API بمفتاح خاص أو ملف،
-- فيصبح كل طلب شحنة بريد سريع (إن كان نشاط البريد مفعّلًا) أو طلب توصيل، أو أمر صرف من مستودعنا إن كان المتجر يخزّن عندنا.
-- المتجر يتابع حالة طلباته عبر الـ API، والمرتجعات من المشتري للمتجر مهام توصيل عكسية.
-- مبالغ الدفع عند الاستلام ورسوم الخدمة تبقى في دفاتر النواة (تحصيل COD، الفواتير، المقاصة، التحويل للمتجر).

CREATE TABLE ops.ecom_merchant (
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  pickup jsonb CHECK (jsonb_typeof(pickup) = 'object'),             -- عنوان الاستلام من المتجر ووجهة المرتجعات
  default_service text NOT NULL DEFAULT 'next_day' CHECK (default_service IN ('express','same_day','next_day')),
  warehouse_id uuid,                                                -- يخزّن عندنا: الطلب أمر صرف من هذا المستودع
  max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 9),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES ops.wh_warehouse (tenant_id, id)
);

-- مفاتيح API للمتجر: يُخزَّن بصمة المفتاح فقط، ويُعرض المفتاح مرة واحدة عند إنشائه
CREATE TABLE ops.ecom_api_key (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{10}$'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  label text CHECK (length(label) <= 80),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
REVOKE DELETE, TRUNCATE ON ops.ecom_api_key FROM app_rw;

CREATE TABLE ops.ecom_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  external_id text NOT NULL CHECK (external_id ~ '^[A-Za-z0-9][A-Za-z0-9_.#-]{0,59}$'),
  source text NOT NULL CHECK (source IN ('api','import','office')),
  items jsonb CHECK (jsonb_typeof(items) = 'array'),                -- [{sku?, name, qty}]
  task_id uuid,                                                     -- التوصيل أو الشحنة
  wh_order_id uuid,                                                 -- أمر الصرف إن كان من مستودعنا
  return_task_id uuid,                                              -- استرجاع من المشتري للمتجر
  return_reason text CHECK (length(return_reason) <= 300),
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, customer_id, external_id),
  CHECK (task_id IS NOT NULL OR wh_order_id IS NOT NULL),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, wh_order_id) REFERENCES ops.wh_order (tenant_id, id),
  FOREIGN KEY (tenant_id, return_task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX ecom_order_customer ON ops.ecom_order (tenant_id, customer_id, created_at DESC);
REVOKE DELETE, TRUNCATE ON ops.ecom_order FROM app_rw;

-- يجد المفتاح قبل معرفة الشركة (بلا سياق مستأجر)، ويعيد ما يلزم للتحقق فقط
CREATE FUNCTION ops.ecom_key_lookup(p_prefix text) RETURNS TABLE (key_id uuid, tenant_id uuid, customer_id uuid, secret_hash text, revoked boolean, merchant_active boolean, packs text[], tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops, org AS $$
  SELECT k.id, k.tenant_id, k.customer_id, k.secret_hash, k.revoked_at IS NOT NULL,
         COALESCE((SELECT m.active FROM ops.ecom_merchant m WHERE m.tenant_id = k.tenant_id AND m.customer_id = k.customer_id), false),
         t.packs, t.status
    FROM ops.ecom_api_key k JOIN org.tenant t ON t.id = k.tenant_id
   WHERE k.prefix = p_prefix
$$;
REVOKE ALL ON FUNCTION ops.ecom_key_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.ecom_key_lookup(text) TO app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','warehouse','ecommerce','staffing','concrete','internal','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'ecommerce')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','warehouse','staffing','concrete','internal','distribution'] AND NOT ('ecommerce' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
