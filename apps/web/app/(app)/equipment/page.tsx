'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ASSET_STATUS, ASSET_TYPE, HEAVY_TYPES, HIRE_STATE, ISO_WEEKDAYS, RATE_UNIT, TASK_STATUS, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

interface Hire {
  id: string; ref: string; customer_id: string; customer_name: string; asset_id: string; plate_no: string; asset_type: string; operator_name: string | null; site: Record<string, string>;
  starts_on: string; ends_on: string; off_hired_on: string | null; shift_start: string; shift_end: string; rate_unit: string; min_hours: number; state: string; days: number;
  approved_hours: number; worked_hours: number; uncovered?: number;
}
interface Day {
  task_id: string; hire_id: string; hire_ref: string; work_date: string; status: string; shift_from: string; customer_name: string; site: Record<string, string>; plate_no: string; asset_type: string;
  wet: boolean; operator_name: string | null; covered: boolean; meter_start: number | null; meter_end: number | null; worked_hours: number | null; downtime_hours: number; signed_by: string | null;
  approved_hours: number | null; approved_at: string | null; rate_unit: string; min_hours: number;
}
type Tab = 'days' | 'hires' | 'fleet' | 'exceptions' | 'report';

const siteText = (s: Record<string, string>) => [s.name, s.area].filter(Boolean).join('، ') || '—';
const hrs = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n} س`);
const machine = (type: string, plate: string) => <>{ASSET_TYPE[type] ?? type} <span className="num">{plate}</span></>;

/** Heavy equipment hire (sector 16): today's working days with the hour meter and approval, hires, the machines, exceptions and the report. */
export default function EquipmentPage() {
  const [tab, setTab] = useState<Tab>('days');
  return (
    <div className="page stack">
      <div className="page-head"><h1>تأجير المعدات</h1></div>
      <Tabs tabs={[['days', 'أيام العمل'], ['hires', 'عقود التأجير'], ['fleet', 'المعدات'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'days' && <DaysView />}
      {tab === 'hires' && <HiresView />}
      {tab === 'fleet' && <FleetView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function DaysTable({ rows, onPick, testId }: { rows: Day[]; onPick?: (d: Day) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>العقد</th><th>اليوم</th><th>المعدة</th><th>العميل والموقع</th><th>المشغّل</th><th>الحالة</th><th>العدّاد</th><th>الساعات</th><th>المعتمد</th><th></th></tr></thead>
      <tbody>{rows.map((d) => (
        <tr key={d.task_id}><td className="num">{d.hire_ref}</td><td className="num">{d.work_date}</td><td>{machine(d.asset_type, d.plate_no)}</td><td>{d.customer_name} · {siteText(d.site)}</td>
          <td>{d.wet ? (d.operator_name ?? <Badge tone="danger">غير محجوز</Badge>) : <Badge>تأجير جاف</Badge>}</td><td><Tone map={TASK_STATUS} value={d.status} /></td>
          <td className="num">{d.meter_start ?? '—'} ← {d.meter_end ?? '—'}</td>
          <td className="num">{hrs(d.worked_hours)}{d.downtime_hours > 0 && <> <Badge tone="warning">توقف {d.downtime_hours}</Badge></>}{d.signed_by && <div className="muted">أقرّ: {d.signed_by}</div>}</td>
          <td className="num">{d.approved_hours !== null ? <Badge tone="success">{hrs(d.approved_hours)}</Badge> : '—'}</td>
          <td>{onPick && !d.approved_at && d.status !== 'canceled' && <button className="small" onClick={() => onPick(d)}>تسجيل واعتماد</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function DaysView() {
  const [day, setDay] = useState(todayKw());
  const days = useLoad(() => api<{ data: Day[] }>(`/equipment/days?date=${day}`).then((r) => r.data), [day]);
  const [open, setOpen] = useState<Day | null>(null);
  return (
    <section className="card stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم العمل" style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={days.error} />
      <DaysTable rows={days.data ?? []} onPick={setOpen} testId="days" />
      {open && <DayModal d={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void days.reload(); }} />}
    </section>
  );
}

function DayModal({ d, onClose, onDone }: { d: Day; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const { f, bind } = useForm({ meter_start: d.meter_start?.toString() ?? '', meter_end: d.meter_end?.toString() ?? '', downtime_hours: d.downtime_hours ? String(d.downtime_hours) : '', signed_by: d.signed_by ?? '', hours: '' });
  const canWrite = can(me, 'tasks:assign');
  return (
    <Modal title={`${d.hire_ref} · ${d.work_date}`} onClose={onClose}>
      <ErrorBox error={act.error} />
      <p>{machine(d.asset_type, d.plate_no)} · {d.customer_name} · {RATE_UNIT[d.rate_unit]}{d.rate_unit === 'hour' ? ` · حد أدنى ${d.min_hours} س` : ''}</p>
      {canWrite && <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api(`/equipment/days/${d.task_id}/record`, { method: 'POST', body: { meter_start: Number(f.meter_start), ...(f.meter_end ? { meter_end: Number(f.meter_end) } : {}),
          downtime_hours: f.downtime_hours ? Number(f.downtime_hours) : 0, ...clean({ signed_by: f.signed_by }) } });
        onDone();
      }); }}>
        <div className="row">
          <label className="field">عدّاد البدء<input {...bind('meter_start')} type="number" step={0.1} min={0} required className="num" style={{ width: 110 }} /></label>
          <label className="field">عدّاد الانتهاء<input {...bind('meter_end')} type="number" step={0.1} min={0} className="num" style={{ width: 110 }} /></label>
          <label className="field">توقف العطل (س)<input {...bind('downtime_hours')} type="number" step={0.1} min={0} max={24} className="num" style={{ width: 90 }} /></label>
          <label className="field">مشرف الموقع<input {...bind('signed_by')} maxLength={120} /></label>
        </div>
        <button className="secondary" disabled={act.busy}>حفظ القراءات</button>
      </form>}
      {canWrite && (d.meter_end !== null || d.status === 'failed') && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api(`/equipment/days/${d.task_id}/approve`, { method: 'POST', body: f.hours ? { hours: Number(f.hours) } : {} }); onDone();
      }); }}>
        <label className="field">ساعات مختلفة (اختياري)<input {...bind('hours')} type="number" step={0.1} min={0} max={24} className="num" style={{ width: 110 }} /></label>
        <button disabled={act.busy}>اعتماد اليوم للفوترة</button>
      </form>}
      <p className="muted">الافتراضي: الساعات الفعلية، ولا تقل عن الحد الأدنى اليومي مطروحًا منه توقف أعطالنا [تخمين]. أجرة اليوم أو الشهر: اليوم يُحسب ما لم تتعطل المعدة طوال الدوام.</p>
    </Modal>
  );
}

function HiresView() {
  const me = useMe();
  const hires = useLoad(() => api<{ data: Hire[] }>('/equipment/hires').then((r) => r.data));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Hire | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={hires.error} />
      {can(me, 'tasks:assign') && <div className="row"><button onClick={() => setAdding(true)}>عقد تأجير جديد</button></div>}
      {hires.data?.length === 0 ? <Empty>لا توجد عقود تأجير بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="hires"><thead><tr><th>العقد</th><th>المعدة</th><th>العميل والموقع</th><th>الفترة</th><th>الدوام</th><th>التسعير</th><th>المشغّل</th><th>الحالة</th><th>الساعات</th><th></th></tr></thead>
          <tbody>{hires.data?.map((h) => (
            <tr key={h.id}><td className="num">{h.ref}</td><td>{machine(h.asset_type, h.plate_no)}</td><td>{h.customer_name} · {siteText(h.site)}</td>
              <td className="num">{h.starts_on} ← {h.off_hired_on ?? h.ends_on}{h.off_hired_on && <> <Badge>أُنهي مبكرًا</Badge></>}</td><td className="num">{h.shift_start}–{h.shift_end}</td>
              <td>{RATE_UNIT[h.rate_unit]}{h.rate_unit === 'hour' && h.min_hours > 0 ? ` · حد ${h.min_hours} س` : ''}</td><td>{h.operator_name ?? <Badge>جاف</Badge>}</td>
              <td><Tone map={HIRE_STATE} value={h.state} /></td><td className="num">{h.worked_hours} / معتمد {h.approved_hours}</td>
              <td><button className="small" onClick={() => setOpen(h)}>إدارة</button></td></tr>
          ))}</tbody></table></div>
      )}
      {adding && <HireForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void hires.reload(); }} />}
      {open && <HireModal h={open} onClose={() => { setOpen(null); void hires.reload(); }} />}
    </section>
  );
}

function HireForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const assets = useAssets();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string }[] }>('/workers?status=active').then((x) => x.data));
  const t = todayKw();
  const { f, bind } = useForm({ customer_id: '', asset_id: '', operator_worker_id: '', site_name: '', area: '', phone: '', starts_on: t, ends_on: t, shift_start: '07:00', shift_end: '17:00', rate_unit: 'hour', min_hours: '8', notes: '' });
  const [days, setDays] = useState<number[]>([7, 1, 2, 3, 4, 6]);
  const machines = (assets.data ?? []).filter((a) => HEAVY_TYPES.includes(a.asset_type) && !['out_of_service', 'retired'].includes(a.status));
  const [res, setRes] = useState<Hire | null>(null);
  return (
    <Modal title="عقد تأجير جديد" onClose={res ? onDone : onClose}>
      <ErrorBox error={act.error} />
      {res ? <div className="stack" data-testid="hire-created">
        <p>أُنشئ العقد <b className="num">{res.ref}</b> بعدد {res.days} يوم عمل.{res.uncovered ? <> <Badge tone="warning">{res.uncovered} يوم المشغّل أو المعدة محجوزان فيه</Badge></> : null}</p>
        <button onClick={onDone}>تم</button>
      </div> : <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        setRes(await api<Hire>('/equipment/hires', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, customer_id: f.customer_id, asset_id: f.asset_id, operator_worker_id: f.operator_worker_id || null,
          site: clean({ name: f.site_name, area: f.area, phone: f.phone }), starts_on: f.starts_on, ends_on: f.ends_on, shift_start: f.shift_start, shift_end: f.shift_end, work_days: days,
          rate_unit: f.rate_unit, min_hours: Number(f.min_hours || 0), ...clean({ notes: f.notes }) } }));
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">المعدة<select {...bind('asset_id')} required><option value="">اختر</option>{machines.map((a) => <option key={a.id} value={a.id}>{ASSET_TYPE[a.asset_type]} {a.plate_no}</option>)}</select></label>
          <label className="field">المشغّل<select {...bind('operator_worker_id')}><option value="">بدون (تأجير جاف)</option>{workers.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">اسم الموقع<input {...bind('site_name')} maxLength={120} /></label>
          <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
          <label className="field">هاتف الموقع<input {...bind('phone')} maxLength={20} className="num" dir="ltr" /></label>
        </div>
        <div className="row">
          <label className="field">من<input {...bind('starts_on')} type="date" required /></label>
          <label className="field">إلى<input {...bind('ends_on')} type="date" required /></label>
          <label className="field">بداية الدوام<input {...bind('shift_start')} type="time" required /></label>
          <label className="field">نهاية الدوام<input {...bind('shift_end')} type="time" required /></label>
        </div>
        <fieldset className="row" aria-label="أيام العمل">{ISO_WEEKDAYS.map(([n, l]) => (
          <label key={n} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={days.includes(n)} onChange={(e) => setDays(e.target.checked ? [...days, n] : days.filter((x) => x !== n))} /> {l}</label>
        ))}</fieldset>
        <div className="row">
          <label className="field">التسعير<select {...bind('rate_unit')}>{Object.entries(RATE_UNIT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">الحد الأدنى اليومي (س)<input {...bind('min_hours')} type="number" min={0} max={24} step={0.5} className="num" style={{ width: 90 }} /></label>
          <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        </div>
        <button disabled={act.busy}>إنشاء العقد وحجز الأيام</button>
      </form>}
    </Modal>
  );
}

function HireModal({ h, onClose }: { h: Hire; onClose: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Hire & { work_days_list: Day[] }>(`/equipment/hires/${h.id}`), [h.id]);
  const act = useAction();
  const { f, bind } = useForm({ ends_on: h.ends_on, off_on: todayKw(), reason: '' });
  const x = d.data;
  const open = x && !['canceled', 'ended'].includes(x.state) && !x.off_hired_on;
  return (
    <Modal title={`عقد ${h.ref}`} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {x && <div className="stack">
        <p>{machine(x.asset_type, x.plate_no)} · {x.customer_name} · <Tone map={HIRE_STATE} value={x.state} /> · ساعات فعلية {x.worked_hours} · معتمدة {x.approved_hours}</p>
        {can(me, 'tasks:assign') && open && <>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/equipment/hires/${h.id}/extend`, { method: 'POST', body: { ends_on: f.ends_on } }); await d.reload(); }); }}>
            <label className="field">تمديد إلى<input {...bind('ends_on')} type="date" required /></label><button disabled={act.busy}>تمديد</button>
          </form>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/equipment/hires/${h.id}/off-hire`, { method: 'POST', body: { on: f.off_on, reason: f.reason } }); await d.reload(); }); }}>
            <label className="field">آخر يوم عمل<input {...bind('off_on')} type="date" required /></label>
            <input {...bind('reason')} placeholder="سبب الإنهاء المبكر" required maxLength={500} aria-label="سبب الإنهاء" />
            <button className="danger" disabled={act.busy}>إنهاء مبكر</button>
          </form>
        </>}
        <DaysTable rows={x.work_days_list} testId="hire-days" />
      </div>}
    </Modal>
  );
}

function FleetView() {
  const fleet = useLoad(() => api<{ data: { id: string; plate_no: string; asset_type: string; make: string | null; model: string | null; status: string; hire_ref: string | null; customer_name: string | null; site: Record<string, string> | null; hire_ends_on: string | null }[] }>('/equipment/fleet').then((r) => r.data));
  const on = (fleet.data ?? []).filter((m) => m.hire_ref).length;
  return (
    <div className="stack">
      <ErrorBox error={fleet.error} />
      <div className="grid g4"><Kpi label="مؤجَّرة اليوم" value={on} tone="success" /><Kpi label="في الساحة" value={(fleet.data?.length ?? 0) - on} /></div>
      <section className="card">
        {fleet.data?.length === 0 ? <Empty>لا توجد معدات ثقيلة. أضفها من «المركبات» بنوع حفارة أو رافعة أو شيول…</Empty> : (
          <div className="tbl-wrap"><table data-testid="fleet"><thead><tr><th>المعدة</th><th>الطراز</th><th>اليوم</th><th>العميل والموقع</th><th>حتى</th></tr></thead>
            <tbody>{fleet.data?.map((m) => (
              <tr key={m.id}><td>{machine(m.asset_type, m.plate_no)}</td><td>{[m.make, m.model].filter(Boolean).join(' ') || '—'}</td>
                <td>{m.hire_ref ? <Badge tone="success">مؤجَّرة · {m.hire_ref}</Badge> : m.status === 'available' ? <Badge>في الساحة</Badge> : <Tone map={ASSET_STATUS} value={m.status} />}</td>
                <td>{m.customer_name ? `${m.customer_name} · ${siteText(m.site ?? {})}` : '—'}</td><td className="num">{m.hire_ends_on ?? '—'}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>
    </div>
  );
}

function ExceptionsView() {
  const [day, setDay] = useState(todayKw());
  const x = useLoad(() => api<{ late: Day[]; uncovered: Day[]; to_approve: Day[]; unsigned: Day[]; ending: Hire[] }>(`/equipment/exceptions?date=${day}`), [day]);
  const d = x.data;
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="لم يبدأ العمل بعد 30 دقيقة" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
          <Kpi label="أيام بلا مشغّل محجوز" value={d.uncovered.length} tone={d.uncovered.length ? 'warning' : undefined} />
          <Kpi label="بانتظار الاعتماد" value={d.to_approve.length} />
          <Kpi label="عقود تنتهي خلال 3 أيام" value={d.ending.length} />
        </div>
        <section className="card"><h2>لم يبدأ العمل بعد 30 دقيقة من الدوام [تخمين]</h2><DaysTable rows={d.late} testId="ex-late" /></section>
        <section className="card"><h2>أيام تأجير بمشغّل لم يُحجز لها المشغّل أو المعدة</h2><DaysTable rows={d.uncovered} testId="ex-uncovered" /></section>
        <section className="card"><h2>بانتظار اعتماد الساعات</h2><DaysTable rows={d.to_approve} testId="ex-approve" />
          {d.unsigned.length > 0 && <p className="muted">منها {d.unsigned.length} بلا إقرار من مشرف الموقع.</p>}</section>
        <section className="card"><h2>عقود تنتهي قريبًا</h2>
          {d.ending.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-ending"><thead><tr><th>العقد</th><th>المعدة</th><th>العميل</th><th>ينتهي</th></tr></thead>
            <tbody>{d.ending.map((h) => <tr key={h.id}><td className="num">{h.ref}</td><td>{machine(h.asset_type, h.plate_no)}</td><td>{h.customer_name}</td><td className="num">{h.off_hired_on ?? h.ends_on}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { days: number; approved_days: number; worked_hours: number; downtime_hours: number; billable_hours: number };
  const r = useLoad(() => api<{ customers: (Sum & { customer_name: string })[]; machines: (Sum & { plate_no: string; asset_type: string; scheduled_hours: number; utilization_pct: number | null })[]; totals: Sum }>(`/equipment/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4">
          <Kpi label="أيام عمل" value={`${x.approved_days} معتمد / ${x.days}`} />
          <Kpi label="ساعات فعلية" value={x.worked_hours} />
          <Kpi label="توقف أعطال" value={x.downtime_hours} />
          <Kpi label="ساعات مفوترة معتمدة" value={x.billable_hours} tone="success" />
        </div>
        <section className="card"><h2>حسب العميل</h2>
          {r.data!.customers.length === 0 ? <Empty>لا توجد أيام عمل في الفترة</Empty> : <div className="tbl-wrap"><table data-testid="eq-customers"><thead><tr><th>العميل</th><th>أيام</th><th>معتمدة</th><th>فعلية</th><th>توقف</th><th>مفوترة</th></tr></thead>
            <tbody>{r.data!.customers.map((c) => <tr key={c.customer_name}><td>{c.customer_name}</td><td className="num">{c.days}</td><td className="num">{c.approved_days}</td><td className="num">{c.worked_hours}</td><td className="num">{c.downtime_hours}</td><td className="num">{c.billable_hours}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>حسب المعدة</h2>
          {r.data!.machines.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="eq-machines"><thead><tr><th>المعدة</th><th>أيام</th><th>ساعات الدوام</th><th>فعلية</th><th>الاستغلال</th><th>توقف</th></tr></thead>
            <tbody>{r.data!.machines.map((m) => <tr key={m.plate_no}><td>{machine(m.asset_type, m.plate_no)}</td><td className="num">{m.days}</td><td className="num">{m.scheduled_hours}</td><td className="num">{m.worked_hours}</td>
              <td className="num">{m.utilization_pct === null ? '—' : `${m.utilization_pct}%`}</td><td className="num">{m.downtime_hours}</td></tr>)}</tbody></table></div>}
          <p className="muted" style={{ marginBottom: 0 }}>الساعات المعتمدة أساس الفاتورة بسعر عقد العميل [تحقق محلي].</p>
        </section>
      </>}
    </div>
  );
}
