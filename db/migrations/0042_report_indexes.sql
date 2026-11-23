-- 0042: فهارس للتقارير على حجم بيانات كبير (فحص الجاهزية: 50 ألف مهمة في شركة واحدة).
-- أرباح السائقين في التوصيل كانت تمسح سجل أحداث المهام كله لكل سائق (2.6 ثانية)، وتقرير المهام يمسح كل المهام
-- ليختار فترة. فهرس على وقت الحدث، وفهرس على موعد المهمة كما تحسبه التقارير.

CREATE INDEX task_event_time ON ops.task_event (tenant_id, occurred_at);
CREATE INDEX task_planned ON ops.task (tenant_id, (COALESCE(lower(service_window), created_at)));
