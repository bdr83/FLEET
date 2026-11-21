-- 0014: وحدة قطاع الخرسانة الجاهزة (concrete@1، القطاع 20): طلب الصب، تذكرة الحمولة، إعدادات المحطة.
-- كل حمولة خلاطة مهمة (ops.task) عادية بنوع concrete@1، فتبقى دورة المهمة والإسناد والتتبع والفوترة من النواة.
-- الجداول في مخطط ops حتى تشملها سياسات العزل تلقائيًا (core.apply_tenant_rls).

-- إعدادات المحطة لكل شركة قانونية. كل القيم الافتراضية [تخمين] وتُضبط مع المصنع الشريك.
CREATE TABLE ops.concrete_settings (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  truck_capacity_m3 numeric(5,2) NOT NULL DEFAULT 9 CHECK (truck_capacity_m3 > 0 AND truck_capacity_m3 <= 20),  -- حمولة الخلاطة المعتادة
  max_age_minutes integer NOT NULL DEFAULT 90 CHECK (max_age_minutes BETWEEN 15 AND 360),    -- عمر الخرسانة المسموح من الخلط حتى انتهاء الصب
  age_warn_minutes integer NOT NULL DEFAULT 70 CHECK (age_warn_minutes BETWEEN 5 AND 360),   -- تنبيه مبكر قبل الحد
  free_wait_minutes integer NOT NULL DEFAULT 30 CHECK (free_wait_minutes BETWEEN 0 AND 240), -- انتظار مجاني في الموقع قبل رسوم الانتظار
  lead_minutes integer NOT NULL DEFAULT 30 CHECK (lead_minutes BETWEEN 5 AND 240),           -- من التحميل حتى الوصول للموقع
  cycle_minutes integer NOT NULL DEFAULT 120 CHECK (cycle_minutes BETWEEN 20 AND 600),       -- دورة كاملة: تحميل، ذهاب، صب، عودة، غسيل
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id),
  CHECK (age_warn_minutes < max_age_minutes),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- طلب الصب من العميل: الكمية والخلطة والموقع والموعد ومعدل الصب. حالته تُشتق من حمولاته، ويُخزَّن الإلغاء فقط.
CREATE TABLE ops.pour_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'),
  customer_id uuid,
  site_id uuid,
  site jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(site) = 'object' AND length(site::text) <= 2000),  -- عنوان الموقع ومهندس الموقع
  mix_code text NOT NULL CHECK (length(mix_code) BETWEEN 1 AND 40),                  -- مثل C30 أو C40/SRC
  volume_m3 numeric(7,2) NOT NULL CHECK (volume_m3 > 0 AND volume_m3 <= 5000),
  pour_rate_m3h numeric(6,2) NOT NULL CHECK (pour_rate_m3h > 0 AND pour_rate_m3h <= 300),
  pump_required boolean NOT NULL DEFAULT false,
  pump_asset_id uuid,
  scheduled_at timestamptz NOT NULL,
  site_ready boolean NOT NULL DEFAULT true,                                          -- false = أوقف المجدول الإرسال لأن الموقع غير جاهز
  notes text CHECK (length(notes) <= 1000),
  canceled_at timestamptz, cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, ref),
  CHECK ((canceled_at IS NULL) = (cancel_reason IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES crm.site (tenant_id, id),
  FOREIGN KEY (tenant_id, pump_asset_id) REFERENCES fleet.asset (tenant_id, id)
);
CREATE INDEX pour_order_day ON ops.pour_order (tenant_id, legal_entity_id, scheduled_at);

-- تذكرة التسليم الرقمية لكل حمولة: رقم التذكرة، وقت الخلط (يبدأ عدّاد العمر)، الكمية المصبوبة والمرتجعة، وتوقيع مهندس الموقع.
CREATE TABLE ops.load_ticket (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  pour_order_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 999),
  ticket_no text NOT NULL CHECK (length(ticket_no) BETWEEN 1 AND 60),
  volume_m3 numeric(5,2) NOT NULL CHECK (volume_m3 > 0 AND volume_m3 <= 20),
  planned_arrival timestamptz NOT NULL,
  batched_at timestamptz,                                                             -- من مرحلة "تم التحميل" في تطبيق السائق
  poured_m3 numeric(5,2) CHECK (poured_m3 >= 0),
  returned_m3 numeric(5,2) CHECK (returned_m3 >= 0),
  signed_by text CHECK (length(signed_by) BETWEEN 1 AND 120),
  file_key text CHECK (length(file_key) <= 300),                                      -- صورة التوقيع أو التذكرة الورقية
  signed_at timestamptz,
  wait_minutes integer CHECK (wait_minutes >= 0),                                     -- من الوصول حتى بدء الصب، يُحسب عند التوقيع
  sign_client_op_id uuid,
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, pour_order_id, seq),
  UNIQUE (tenant_id, sign_client_op_id),
  CHECK ((signed_at IS NULL) = (signed_by IS NULL) AND (signed_at IS NULL) = (poured_m3 IS NULL)),
  CHECK (coalesce(poured_m3, 0) + coalesce(returned_m3, 0) <= volume_m3 + 0.05),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, pour_order_id) REFERENCES ops.pour_order (tenant_id, id)
);
CREATE INDEX load_ticket_pour ON ops.load_ticket (tenant_id, pour_order_id, seq);
-- التذكرة الموقّعة لا تُعدّل ولا تُحذف: أساس الفاتورة.
REVOKE DELETE, TRUNCATE ON ops.load_ticket FROM app_rw;
CREATE FUNCTION ops.load_ticket_signed_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'signed load ticket % cannot change', OLD.ticket_no USING ERRCODE = 'check_violation', CONSTRAINT = 'ticket_signed_final';
  END IF;
  IF OLD.batched_at IS NOT NULL AND NEW.batched_at IS DISTINCT FROM OLD.batched_at THEN
    RAISE EXCEPTION 'batch time of % cannot change', OLD.ticket_no USING ERRCODE = 'check_violation', CONSTRAINT = 'ticket_batch_final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER load_ticket_final BEFORE UPDATE ON ops.load_ticket FOR EACH ROW EXECUTE FUNCTION ops.load_ticket_signed_is_final();

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
