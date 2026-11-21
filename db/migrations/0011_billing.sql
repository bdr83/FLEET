-- 0011 (P8): الفواتير والتحصيل والذمم والقيود، وتحصيل الدفع عند الاستلام (COD).
-- المنصة لا تحتفظ بأموال العملاء (D5): هذه سجلات محاسبية لأموال تحتفظ بها الشركة المشتركة نفسها.

-- إعدادات الفوترة للشركة القانونية. نسبة الضريبة تضبطها الشركة: لا قيمة افتراضية غير الصفر [تحقق محلي]
ALTER TABLE org.legal_entity
  ADD COLUMN tax_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  ADD COLUMN tax_number text CHECK (length(tax_number) <= 40),
  ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,8}$');

-- ترقيم بلا فجوات لكل شركة قانونية ونوع وسنة (الصف يُقفل حتى نهاية المعاملة)
CREATE TABLE billing.number_sequence (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  kind text NOT NULL,
  year integer NOT NULL,
  last integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, legal_entity_id, kind, year),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

CREATE TABLE billing.invoice (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  number text,                                         -- يُعطى عند الإصدار فقط
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','void')),
  currency char(3) NOT NULL,
  period_from date, period_to date,
  issue_date date, due_date date,
  subtotal numeric(18,3) NOT NULL DEFAULT 0,
  tax_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(18,3) NOT NULL DEFAULT 0,
  total numeric(18,3) NOT NULL DEFAULT 0,
  paid_amount numeric(18,3) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  notes text CHECK (length(notes) <= 2000),
  void_reason text CHECK (length(void_reason) <= 300),
  created_by uuid, issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, number),
  CHECK ((status = 'draft') = (number IS NULL) OR status = 'void'),
  CHECK (paid_amount <= total OR status = 'void'),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);
CREATE INDEX invoice_customer ON billing.invoice (tenant_id, customer_id, status);

CREATE TABLE billing.invoice_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  task_id uuid,
  rate_id uuid,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  unit text NOT NULL,
  qty numeric(12,3) NOT NULL CHECK (qty >= 0),
  unit_price numeric(18,3) NOT NULL CHECK (unit_price >= 0),
  amount numeric(18,3) NOT NULL CHECK (amount >= 0),
  active boolean NOT NULL DEFAULT true,                -- يصبح false عند إلغاء الفاتورة فتعود المهمة قابلة للفوترة
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoice (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id)
);
-- المهمة لا تُفوتر في فاتورتين (حتى مسودتين)، ويجوز لها أكثر من بند في الفاتورة نفسها (مهمة + كيلومترات)
ALTER TABLE billing.invoice_line ADD CONSTRAINT invoice_line_task_once
  EXCLUDE USING gist (tenant_id WITH =, task_id WITH =, invoice_id WITH <>) WHERE (task_id IS NOT NULL AND active);

CREATE TABLE billing.payment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  amount numeric(18,3) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  received_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','bank_transfer','knet','card','cheque','cod_offset','other')),
  reference text CHECK (length(reference) <= 100),
  notes text CHECK (length(notes) <= 1000),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reverse_reason text CHECK (length(reverse_reason) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

CREATE TABLE billing.payment_allocation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(18,3) NOT NULL CHECK (amount > 0),
  active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id, payment_id) REFERENCES billing.payment (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoice (tenant_id, id)
);

-- COD: مبلغ يحصّله السائق من المستلم نيابة عن العميل (التاجر)
CREATE TABLE billing.cod_collection (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  task_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  amount numeric(18,3) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  collected_at timestamptz NOT NULL,
  client_op_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_op_id),
  UNIQUE (tenant_id, task_id),                         -- تحصيل واحد لكل مهمة
  FOREIGN KEY (tenant_id, task_id) REFERENCES ops.task (tenant_id, id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workforce.worker (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id)
);

-- الدفتر: دفتر فرعي للعملاء (الذمم وCOD) والسائقين (العهدة والمستحقات)
ALTER TABLE billing.ledger_entry
  ADD COLUMN customer_id uuid,
  ADD COLUMN worker_id uuid,
  ADD COLUMN memo text CHECK (length(memo) <= 300),
  ADD FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES org.legal_entity (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customer (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, worker_id) REFERENCES workforce.worker (tenant_id, id);
CREATE INDEX ledger_account ON billing.ledger_entry (tenant_id, legal_entity_id, account_code, posted_at);
CREATE INDEX ledger_customer ON billing.ledger_entry (tenant_id, customer_id, account_code) WHERE customer_id IS NOT NULL;
CREATE INDEX ledger_worker ON billing.ledger_entry (tenant_id, worker_id, account_code) WHERE worker_id IS NOT NULL;
CREATE INDEX ledger_source ON billing.ledger_entry (tenant_id, source_type, source_id);

-- لا قيد بلا شركة واحدة: كل أسطر القيد للشركة القانونية نفسها
CREATE OR REPLACE FUNCTION billing.assert_journal_zero() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing.ledger_entry WHERE journal_id = NEW.journal_id
             GROUP BY currency HAVING sum(amount) <> 0)
     OR (SELECT count(DISTINCT currency) FROM billing.ledger_entry WHERE journal_id = NEW.journal_id) > 1
     OR (SELECT count(DISTINCT legal_entity_id) FROM billing.ledger_entry WHERE journal_id = NEW.journal_id) > 1 THEN
    RAISE EXCEPTION 'journal % not balanced per currency', NEW.journal_id;
  END IF;
  RETURN NULL;
END $$;

DO $$ BEGIN PERFORM core.apply_tenant_rls(); END $$;
