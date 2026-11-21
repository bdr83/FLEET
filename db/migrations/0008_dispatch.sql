-- 0008 (P4): المهام الكاملة والتوزيع.

ALTER TABLE ops.task
  ADD COLUMN ref text CHECK (length(ref) <= 60),            -- رقم الطلب لدى العميل، يمنع التكرار عند الاستيراد
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid,
  ADD CONSTRAINT task_sector_pack_format CHECK (sector_pack ~ '^[a-z][a-z0-9_]*@[0-9]+$'),
  ADD CONSTRAINT task_window_bounded CHECK (service_window IS NULL OR (NOT lower_inf(service_window) AND NOT upper_inf(service_window))),
  ADD FOREIGN KEY (tenant_id, branch_id) REFERENCES org.branch (tenant_id, id);
CREATE UNIQUE INDEX task_ref_unique ON ops.task (tenant_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX task_status ON ops.task (tenant_id, status);
CREATE INDEX task_window ON ops.task USING gist (tenant_id, service_window);

ALTER TABLE ops.assignment
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN assigned_by uuid,
  ADD COLUMN ended_at timestamptz;
-- مهمة واحدة لها إسناد فعّال واحد فقط
CREATE UNIQUE INDEX one_active_assignment ON ops.assignment (tenant_id, task_id) WHERE active;

-- من غيّر الحالة: السائق من التطبيق أو المشرف من اللوحة
ALTER TABLE ops.task_event ADD COLUMN actor_type text NOT NULL DEFAULT 'driver' CHECK (actor_type IN ('driver','staff','system'));

-- إنهاء مناوبة من المشرف (سائق نسي الإنهاء)
ALTER TABLE shift.shift ADD COLUMN ended_by uuid, ADD COLUMN end_reason text CHECK (length(end_reason) <= 300);

