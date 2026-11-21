-- 0002: القيود والمحفزات والمفاتيح المركبة
-- لا سائق في مهمتين متعارضتين زمنيًا (حسب قاعدة القطاع)
ALTER TABLE ops.assignment ADD CONSTRAINT no_worker_overlap
  EXCLUDE USING gist (tenant_id WITH =, worker_id WITH =, period WITH &&)
  WHERE (active AND exclusive);

-- لا مركبة محجوزة مرتين في الوقت نفسه
ALTER TABLE ops.assignment ADD CONSTRAINT no_asset_overlap
  EXCLUDE USING gist (tenant_id WITH =, asset_id WITH =, period WITH &&)
  WHERE (active AND asset_id IS NOT NULL);

-- مناوبة واحدة مفتوحة لكل سائق
CREATE UNIQUE INDEX one_open_shift ON shift.shift (tenant_id, worker_id)
  WHERE started_at IS NOT NULL AND ended_at IS NULL;

-- القيد المالي متوازن: يُفحص عند نهاية المعاملة
CREATE FUNCTION billing.assert_journal_zero() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- متوازن لكل عملة، وعملة واحدة لكل قيد
  IF EXISTS (SELECT 1 FROM billing.ledger_entry WHERE journal_id = NEW.journal_id
             GROUP BY currency HAVING sum(amount) <> 0)
     OR (SELECT count(DISTINCT currency) FROM billing.ledger_entry
         WHERE journal_id = NEW.journal_id) > 1 THEN
    RAISE EXCEPTION 'journal % not balanced per currency', NEW.journal_id;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON billing.ledger_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.assert_journal_zero();

-- الدفتر والسجلات للإضافة فقط
-- (app_rw ليس مالك الجداول؛ المالك دور migrations منفصل)
REVOKE UPDATE, DELETE, TRUNCATE ON billing.ledger_entry, ops.task_event, core.audit_log FROM app_rw;
CREATE FUNCTION core.forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME; END $$;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON billing.ledger_entry FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_truncate();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ops.task_event     FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_truncate();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.audit_log      FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_truncate();

-- كل مرجع بين جداول الشركات يحمل tenant_id، فلا يُربط سجل بسجل شركة أخرى (فحص FK لا يمر بـ RLS)
ALTER TABLE workforce.worker ADD UNIQUE (tenant_id, id);
ALTER TABLE fleet.asset      ADD UNIQUE (tenant_id, id);
ALTER TABLE ops.assignment ADD FOREIGN KEY (tenant_id, task_id)   REFERENCES ops.task (tenant_id, id);
ALTER TABLE ops.assignment ADD FOREIGN KEY (tenant_id, worker_id) REFERENCES workforce.worker (tenant_id, id);
ALTER TABLE ops.assignment ADD FOREIGN KEY (tenant_id, asset_id)  REFERENCES fleet.asset (tenant_id, id);
ALTER TABLE ops.task_event ADD FOREIGN KEY (tenant_id, task_id)   REFERENCES ops.task (tenant_id, id);
ALTER TABLE shift.shift    ADD FOREIGN KEY (tenant_id, worker_id) REFERENCES workforce.worker (tenant_id, id);
ALTER TABLE shift.shift    ADD FOREIGN KEY (tenant_id, asset_id)  REFERENCES fleet.asset (tenant_id, id);
