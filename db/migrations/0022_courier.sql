-- 0022: وحدة البريد والشحن السريع (courier، القطاع 4). تبني على طلبات التوصيل (delivery@1):
-- كل شحنة مهمة توصيل واحدة لها رقم بوليصة (AWB) وعدد قطع ووزن ومستوى خدمة، وتمر بالمحطات (hubs) بمسح الباركود:
-- استلام، فرز، إرسال، وصول، عودة بعد محاولة فاشلة، وإرجاع للمرسل (RTO). محاولات التسليم محدودة (3 افتراضيًا [تخمين]).
-- مبالغ الدفع عند الاستلام تبقى في دفاتر النواة (billing.cod_collection وتحويلات cod/payouts للمرسل)؛ المنصة لا تمسك أموالًا.

CREATE TABLE ops.courier_hub (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  area text CHECK (length(area) <= 80),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

CREATE TABLE ops.courier_parcel (
  task_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  awb text NOT NULL CHECK (awb ~ '^[A-Z0-9][A-Z0-9-]{3,29}$'),
  service text NOT NULL DEFAULT 'next_day' CHECK (service IN ('express','same_day','next_day')),
  pieces integer NOT NULL DEFAULT 1 CHECK (pieces BETWEEN 1 AND 999),
  weight_kg numeric(8,2) CHECK (weight_kg > 0 AND weight_kg <= 10000),
  origin_hub_id uuid,
  dest_hub_id uuid,
  current_hub_id uuid,                                      -- NULL: بين محطتين أو مع المندوب
  max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 9),
  due_at timestamptz NOT NULL,                              -- موعد التسليم حسب مستوى الخدمة
  rto_at timestamptz,                                       -- تقرر الإرجاع للمرسل
  rto_done_at timestamptz,                                  -- سُلّمت للمرسل
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, awb),
  CHECK (rto_done_at IS NULL OR rto_at IS NOT NULL),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, origin_hub_id) REFERENCES ops.courier_hub (tenant_id, id),
  FOREIGN KEY (tenant_id, dest_hub_id) REFERENCES ops.courier_hub (tenant_id, id),
  FOREIGN KEY (tenant_id, current_hub_id) REFERENCES ops.courier_hub (tenant_id, id)
);
CREATE INDEX courier_parcel_hub ON ops.courier_parcel (tenant_id, current_hub_id) WHERE current_hub_id IS NOT NULL;
REVOKE DELETE, TRUNCATE ON ops.courier_parcel FROM app_rw;

-- مسح الشحنة في محطة (سجل لا يُعدَّل)
CREATE TABLE ops.courier_scan (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  hub_id uuid,
  event text NOT NULL CHECK (event IN ('received','sorted','dispatched','arrived','returned','rto_out')),
  scanned_by uuid,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (length(note) <= 300),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.courier_parcel (tenant_id, task_id),
  FOREIGN KEY (tenant_id, hub_id) REFERENCES ops.courier_hub (tenant_id, id)
);
CREATE INDEX courier_scan_task ON ops.courier_scan (tenant_id, task_id, scanned_at);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.courier_scan FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','staffing','concrete','internal','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'courier')
 WHERE packs @> ARRAY['delivery','freight','coldchain','staffing','concrete','internal','distribution'] AND NOT ('courier' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
