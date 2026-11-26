-- 0043: ربط المحاسبة مع Odoo (المرحلة 1 من خطة التكامل).
-- منصتنا مصدر الحقيقة للتشغيل وOdoo للمحاسبة: كل قيد في دفترنا يُرسل إلى Odoo قيد يومية (account.move) عبر الـ API.
-- لا يُنسخ أي كود من Odoo، فالربط لا يغيّر ترخيص المنصة. الربط اختياري لكل شركة قانونية.

-- إعداد الربط لكل شركة قانونية. مفتاح الـ API مشفّر بالتطبيق ولا يُعاد في أي رد.
CREATE TABLE billing.odoo_link (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  protocol text NOT NULL DEFAULT 'json2' CHECK (protocol IN ('json2','jsonrpc')),  -- json2 من Odoo 19، jsonrpc للنسخ الأقدم
  base_url text NOT NULL CHECK (length(base_url) <= 200 AND base_url ~ '^https?://[^\s/?#]+(/[^\s?#]*)?$'),
  database text CHECK (length(database) <= 100),
  login text CHECK (length(login) <= 200),                        -- مطلوب لـ jsonrpc فقط
  api_key_enc text NOT NULL CHECK (length(api_key_enc) <= 1000),
  journal_id integer NOT NULL CHECK (journal_id > 0),            -- دفتر اليومية في Odoo (عادة: عمليات متنوعة)
  account_map jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(account_map) = 'object'),  -- رمز حسابنا -> رمز الحساب في Odoo
  sync_from date NOT NULL,                                        -- لا تُرسل القيود الأقدم (الأرصدة الافتتاحية تُدخل في Odoo)
  enabled boolean NOT NULL DEFAULT true,
  last_ok_at timestamptz,
  last_error text CHECK (length(last_error) <= 500),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id),
  CHECK (protocol = 'json2' OR (login IS NOT NULL AND database IS NOT NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- حالة إرسال كل قيد. القيد الذي لا صف له لم يُرسل بعد.
CREATE TABLE billing.odoo_sync (
  tenant_id uuid NOT NULL,
  journal_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','failed')),
  odoo_move_id integer,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  last_error text CHECK (length(last_error) <= 500),
  next_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, journal_id),
  CHECK ((status = 'sent') = (odoo_move_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);
CREATE INDEX odoo_sync_failed ON billing.odoo_sync (tenant_id, legal_entity_id, next_attempt_at) WHERE status = 'failed';

-- عملاؤنا كشركاء (res.partner) في Odoo
CREATE TABLE billing.odoo_partner (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  odoo_partner_id integer NOT NULL CHECK (odoo_partner_id > 0),
  PRIMARY KEY (tenant_id, legal_entity_id, customer_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- المزامنة الدورية تحتاج قائمة الروابط المفعّلة قبل معرفة الشركة. تعيد المعرّفات فقط، بلا مفاتيح ولا بيانات.
CREATE FUNCTION billing.odoo_enabled_links() RETURNS TABLE (tenant_id uuid, legal_entity_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, billing, org AS $$
  SELECT l.tenant_id, l.legal_entity_id FROM billing.odoo_link l JOIN org.tenant t ON t.id = l.tenant_id
   WHERE l.enabled AND t.status IN ('trial','active','past_due')
   ORDER BY l.tenant_id, l.legal_entity_id
$$;
REVOKE ALL ON FUNCTION billing.odoo_enabled_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.odoo_enabled_links() TO app_rw;

REVOKE TRUNCATE ON billing.odoo_link, billing.odoo_sync, billing.odoo_partner FROM app_rw;

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
