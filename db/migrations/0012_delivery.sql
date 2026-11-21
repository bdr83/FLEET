-- 0012: وحدة قطاع التوصيل (delivery@1): مراحل التنفيذ، إثبات التسليم، رابط التتبع للمستلم، إعدادات القطاع.
-- الجداول في مخطط ops حتى تشملها سياسات العزل تلقائيًا (core.apply_tenant_rls).

-- إعدادات التوصيل لكل شركة قانونية. القيم الافتراضية [تخمين] تُضبط مع أول عميل تجريبي.
CREATE TABLE ops.delivery_settings (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  require_pin boolean NOT NULL DEFAULT true,                 -- التسليم يحتاج رمز المستلم (أو صورة يوافق عليها المكتب)
  max_open_per_driver integer NOT NULL DEFAULT 5 CHECK (max_open_per_driver BETWEEN 1 AND 50),
  auto_assign_radius_km numeric(6,2) NOT NULL DEFAULT 15 CHECK (auto_assign_radius_km > 0 AND auto_assign_radius_km <= 200),
  position_fresh_minutes integer NOT NULL DEFAULT 10 CHECK (position_fresh_minutes BETWEEN 1 AND 120),
  default_sla_minutes integer NOT NULL DEFAULT 90 CHECK (default_sla_minutes BETWEEN 10 AND 1440),  -- لطلب بلا نافذة زمنية
  commission_per_delivery numeric(18,3) NOT NULL DEFAULT 0 CHECK (commission_per_delivery >= 0),
  commission_per_failed numeric(18,3) NOT NULL DEFAULT 0 CHECK (commission_per_failed >= 0),
  custody_alert_amount numeric(18,3) NOT NULL DEFAULT 100 CHECK (custody_alert_amount >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- مراحل داخل التنفيذ يسجلها السائق (لا تغيّر حالة المهمة الأساسية). عامة لكل القطاعات؛ رموزها يحددها القطاع.
CREATE TABLE ops.task_milestone (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  client_op_id uuid NOT NULL,
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  note text CHECK (length(note) <= 500),
  UNIQUE (tenant_id, client_op_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX task_milestone_task ON ops.task_milestone (tenant_id, task_id, occurred_at);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.task_milestone FROM app_rw;

-- سبب الفشل بصيغة رمز يمكن تجميعه في التقارير (الملاحظة الحرة تبقى في note)
ALTER TABLE ops.task_event ADD COLUMN reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,39}$');

-- رمز المستلم ورابط التتبع: يُنشآن مع طلب التوصيل. الرمز من 4 أرقام ومحاولاته محدودة.
CREATE TABLE ops.delivery_link (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  token text NOT NULL CHECK (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  pin text NOT NULL CHECK (pin ~ '^[0-9]{4}$'),
  pin_attempts integer NOT NULL DEFAULT 0 CHECK (pin_attempts >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE UNIQUE INDEX delivery_link_token ON ops.delivery_link (token);

-- إثبات التسليم: رمز المستلم، أو صورة/توقيع بانتظار موافقة المكتب
CREATE TABLE ops.delivery_pod (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('pin','photo','signature')),
  recipient_name text CHECK (length(recipient_name) <= 120),
  file_key text CHECK (length(file_key) <= 300),
  verified boolean NOT NULL,                                 -- pin صحيح، أو وافق المكتب على الصورة
  approved_by uuid, approved_at timestamptz,
  client_op_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, client_op_id),
  CHECK (method = 'pin' OR file_key IS NOT NULL OR recipient_name IS NOT NULL),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);

/*
 * صفحة التتبع العامة للمستلم: بلا تسجيل دخول، بالرابط فقط. الدالة تتجاوز العزل عمدًا
 * وتعيد حقولًا محدودة: لا أرقام هواتف ولا أسماء عائلات ولا موقع السائق إلا وهو في الطريق إلى المستلم.
 */
CREATE FUNCTION ops.public_delivery_track(p_token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops, org, workforce, geo AS $$
  SELECT jsonb_build_object(
    'status', t.status,
    'stage', (SELECT m.code FROM ops.task_milestone m WHERE m.tenant_id = t.tenant_id AND m.task_id = t.id ORDER BY m.occurred_at DESC LIMIT 1),
    'company', le.name,
    'window_from', lower(t.service_window), 'window_to', upper(t.service_window),
    'area', t.attributes #>> '{dropoff,area}',
    'pin', CASE WHEN t.status IN ('ready','assigned','accepted','in_progress') THEN l.pin END,
    'driver', CASE WHEN t.status IN ('accepted','in_progress') THEN split_part(w.display_name, ' ', 1) END,
    'position', CASE WHEN t.status = 'in_progress' AND lp.recorded_at > now() - interval '15 minutes'
                      AND EXISTS (SELECT 1 FROM ops.task_milestone m WHERE m.tenant_id = t.tenant_id AND m.task_id = t.id AND m.code = 'picked_up')
                     THEN jsonb_build_object('lat', round(public.ST_Y(lp.position::public.geometry)::numeric, 4), 'lng', round(public.ST_X(lp.position::public.geometry)::numeric, 4), 'at', lp.recorded_at) END,
    'events', (SELECT coalesce(jsonb_agg(jsonb_build_object('status', e.to_status, 'at', e.occurred_at) ORDER BY e.occurred_at), '[]')
                 FROM ops.task_event e WHERE e.tenant_id = t.tenant_id AND e.task_id = t.id))
    FROM ops.delivery_link l
    JOIN ops.task t ON t.tenant_id = l.tenant_id AND t.id = l.task_id
    JOIN org.legal_entity le ON le.tenant_id = t.tenant_id AND le.id = t.legal_entity_id
    LEFT JOIN ops.assignment asg ON asg.tenant_id = t.tenant_id AND asg.task_id = t.id AND asg.active
    LEFT JOIN workforce.worker w ON w.tenant_id = t.tenant_id AND w.id = asg.worker_id
    LEFT JOIN geo.last_position lp ON lp.tenant_id = t.tenant_id AND lp.worker_id = asg.worker_id
   WHERE l.token = p_token AND l.expires_at > now()
$$;
REVOKE ALL ON FUNCTION ops.public_delivery_track(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.public_delivery_track(text) TO app_rw;

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
