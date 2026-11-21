'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { EXPENSE_CAT, money, todayKw } from '@/lib/format';
import { Empty, ErrorBox, Tabs, useLoad } from '@/components/ui';

type Tab = 'tasks' | 'drivers' | 'fleet' | 'costs';
type Row = Record<string, string | number | null>;

/** Columns per report: [field, Arabic header, kind]. */
const COLUMNS: Record<string, [string, string, ('num' | 'money' | 'pct' | 'text')?][]> = {
  tasks: [['label', 'البند', 'text'], ['total', 'الإجمالي'], ['completed', 'مكتملة'], ['failed', 'فاشلة'], ['canceled', 'ملغاة'], ['open', 'مفتوحة'], ['on_time_pct', 'في الموعد', 'pct'], ['avg_minutes', 'متوسط التنفيذ (د)']],
  drivers: [['name', 'السائق', 'text'], ['completed', 'مكتملة'], ['failed', 'فاشلة'], ['on_time_pct', 'في الموعد', 'pct'], ['shift_hours', 'ساعات المناوبة'], ['km', 'كم']],
  fleet: [['plate_no', 'المركبة', 'text'], ['asset_type', 'النوع', 'text'], ['shifts', 'مناوبات'], ['hours', 'ساعات'], ['utilization_pct', 'الاستغلال', 'pct'], ['km', 'كم']],
  costs: [['plate_no', 'المركبة', 'text'], ['total', 'إجمالي المصروفات', 'money'], ['fuel_cost', 'الوقود', 'money'], ['liters', 'لترات'], ['km', 'كم'], ['cost_per_km', 'تكلفة الكيلومتر', 'money'], ['km_per_liter', 'كم/لتر']],
  costs_category: [['category', 'الفئة', 'text'], ['entries', 'عدد القيود'], ['total', 'الإجمالي', 'money']],
};

/** Kuwait day boundaries (UTC+3, no daylight saving) for the API's from/to timestamps. */
const startOf = (d: string) => `${d}T00:00:00+03:00`;
const nextDay = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

export default function ReportsPage() {
  const today = todayKw();
  const [tab, setTab] = useState<Tab>('tasks');
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [group, setGroup] = useState('day');
  const params = new URLSearchParams({ from: startOf(from), to: startOf(nextDay(to)) });
  if (tab === 'tasks' || tab === 'costs') params.set('group', tab === 'tasks' ? group : group === 'category' ? 'category' : 'asset');
  const path = `/reports/${tab}?${params}`;
  const r = useLoad(() => api<{ rows?: Row[]; data?: Row[] }>(path), [path]);
  const rows = r.data?.rows ?? r.data?.data ?? [];
  const cols = COLUMNS[tab === 'costs' && group === 'category' ? 'costs_category' : tab];
  const cell = (row: Row, [k, , kind]: [string, string, string?]) => {
    const v = row[k];
    if (v === null || v === undefined || v === '') return '—';
    if (k === 'category') return EXPENSE_CAT[String(v)] ?? String(v);
    if (kind === 'money') return money(String(v), String(row.currency ?? 'KWD'));
    if (kind === 'pct') return `${v}%`;
    return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
  };
  return (
    <div className="page stack">
      <div className="page-head"><h1>التقارير</h1></div>
      <Tabs<Tab> tabs={[['tasks', 'المهام'], ['drivers', 'أداء السائقين'], ['fleet', 'استغلال الأسطول'], ['costs', 'تكاليف التشغيل']]} value={tab}
        onChange={(t) => { setTab(t); setGroup(t === 'tasks' ? 'day' : 'asset'); }} />
      <div className="row">
        <label className="row">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} /></label>
        <label className="row">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} /></label>
        {tab === 'tasks' && <select aria-label="التجميع" value={group} onChange={(e) => setGroup(e.target.value)} style={{ width: 'auto' }}>
          <option value="day">حسب اليوم</option><option value="worker">حسب السائق</option><option value="branch">حسب الفرع</option></select>}
        {tab === 'costs' && <select aria-label="التجميع" value={group} onChange={(e) => setGroup(e.target.value)} style={{ width: 'auto' }}>
          <option value="asset">حسب المركبة</option><option value="category">حسب الفئة</option></select>}
        <a className="btn" href={`/api/v1${path}&format=csv`} download>تنزيل CSV</a>
      </div>
      <p className="muted" style={{ margin: 0 }}>المدة القصوى 93 يومًا. ملف CSV يفتح في Excel بالعربية.</p>
      <ErrorBox error={r.error} />
      {r.data && (rows.length === 0 ? <Empty>لا توجد بيانات في هذه الفترة</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr>{cols.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => <tr key={i}>{cols.map((c) => <td key={c[0]} className={c[2] === 'text' ? undefined : 'num'}>{cell(row, c)}</td>)}</tr>)}</tbody>
        </table></div>
      ))}
    </div>
  );
}
