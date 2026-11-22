-- 0023: وحدة المستودعات (warehouse، القطاع 8): مستودع لنا أو تخزين لعملاء (3PL).
-- مستودعات ومواقع تخزين، أصناف لكل عميل (مالك البضاعة)، استلام بضاعة إلى موقع (مع دفعة وصلاحية اختيارية)،
-- أوامر صرف تُجمع (picking) بأقدم صلاحية أولًا ثم تُشحن، ويمكن أن يُنشئ الشحن مهمة توصيل لأسطولنا، وجرد بتسوية.
-- الرصيد لا يُخزَّن: هو مجموع حركات المخزون (سجل لا يُعدَّل).

CREATE TABLE ops.wh_warehouse (
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

CREATE TABLE ops.wh_location (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),   -- A-01-02
  kind text NOT NULL DEFAULT 'storage' CHECK (kind IN ('storage','pick','dock','quarantine')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, warehouse_id, code),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES ops.wh_warehouse (tenant_id, id)
);

-- الصنف ملك عميل (customer_id) في التخزين للغير، أو بلا عميل لبضاعة الشركة نفسها
CREATE TABLE ops.wh_item (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid,
  sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  unit text NOT NULL DEFAULT 'piece' CHECK (unit IN ('piece','carton','pallet','kg','liter','bag')),
  min_qty numeric(12,2) CHECK (min_qty >= 0),                       -- حد إعادة الطلب للتنبيه
  track_expiry boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, customer_id, sku),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);

-- إذن استلام (وارد)
CREATE TABLE ops.wh_receipt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  customer_id uuid,
  ref text NOT NULL CHECK (length(ref) BETWEEN 1 AND 40),
  expected jsonb CHECK (jsonb_typeof(expected) = 'array'),           -- [{item_id, qty}] من إشعار الشحن إن وُجد
  note text CHECK (length(note) <= 300),
  received_by uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, warehouse_id, ref),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES ops.wh_warehouse (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id)
);
REVOKE UPDATE, DELETE, TRUNCATE ON ops.wh_receipt FROM app_rw;

-- أمر صرف (صادر)
CREATE TABLE ops.wh_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  customer_id uuid,
  ref text NOT NULL CHECK (length(ref) BETWEEN 1 AND 40),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),         -- [{item_id, qty}]
  ship_to jsonb CHECK (jsonb_typeof(ship_to) = 'object'),            -- {name, phone, area, block, street, house}
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','picked','shipped','canceled')),
  picked_at timestamptz,
  shipped_at timestamptz,
  delivery_task_id uuid,                                             -- مهمة التوصيل إن شُحن بأسطولنا
  cancel_reason text CHECK (length(cancel_reason) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, warehouse_id, ref),
  CHECK (status <> 'canceled' OR cancel_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES ops.wh_warehouse (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_task_id) REFERENCES ops.task (tenant_id, id)
);
CREATE INDEX wh_order_open ON ops.wh_order (tenant_id, status) WHERE status IN ('open','picked');
REVOKE DELETE, TRUNCATE ON ops.wh_order FROM app_rw;

-- حركات المخزون: + وارد، - صادر. الرصيد = المجموع لكل صنف وموقع ودفعة
CREATE TABLE ops.wh_movement (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  qty numeric(12,2) NOT NULL CHECK (qty <> 0),
  lot text CHECK (length(lot) <= 40),
  expiry date,
  kind text NOT NULL CHECK (kind IN ('receipt','pick','move','count')),
  receipt_id uuid,
  order_id uuid,
  reason text CHECK (length(reason) <= 300),
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (kind <> 'receipt' OR (receipt_id IS NOT NULL AND qty > 0)),
  CHECK (kind <> 'pick' OR (order_id IS NOT NULL AND qty < 0)),
  CHECK (kind <> 'count' OR reason IS NOT NULL),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ops.wh_item (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES ops.wh_location (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES ops.wh_receipt (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES ops.wh_order (tenant_id, id)
);
CREATE INDEX wh_movement_stock ON ops.wh_movement (tenant_id, item_id, location_id);
CREATE INDEX wh_movement_order ON ops.wh_movement (tenant_id, order_id) WHERE order_id IS NOT NULL;
REVOKE UPDATE, DELETE, TRUNCATE ON ops.wh_movement FROM app_rw;

ALTER TABLE org.tenant ALTER COLUMN packs SET DEFAULT ARRAY['delivery','freight','coldchain','courier','warehouse','staffing','concrete','internal','distribution'];
UPDATE org.tenant SET packs = array_append(packs, 'warehouse')
 WHERE packs @> ARRAY['delivery','freight','coldchain','courier','staffing','concrete','internal','distribution'] AND NOT ('warehouse' = ANY (packs));

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
