'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { CR_STATUS, dt, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Lift {
  id: string; ref: string; hire_id: string; hire_ref: string; customer_name: string; site: Record<string, string>; plate_no: string; task_id: string; day_status: string;
  lift_date: string; lift_time: string | null; description: string; load_t: number; radius_m: number; rated_t: number; utilization: number; tandem: boolean; over_people: boolean;
  critical: boolean; rigger_name: string | null; operator_name: string | null; approved_at: string | null; approved_by_name: string | null; status: string; done_at: string | null;
  wind_ms: number | null; abort_reason: string | null; wind_limit_ms: number | null;
}
interface Crane { asset_id: string; plate_no: string; make: string | null; model: string | null; max_capacity_t: number | null; boom_m: number | null; wind_limit_ms: number | null; chart: { radius_m: number; capacity_t: number }[] | null; cert_expires_on: string | null }
type Tab = 'day' | 'fleet' | 'exceptions' | 'report';

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : '—');
const t1 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n} ط`);
const pctTone = (p: number) => (p >= 90 ? 'danger' : p >= 75 ? 'warning' : 'success');

/** Cranes and lifting (sector 19): the day's lift plans, the cranes and their load charts, exceptions and the report. Hires and working days stay in the equipment page. */
export default function CranesPage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>الرافعات وخطط الرفع</h1></div>
      <Tabs tabs={[['day', 'رفعات اليوم'], ['fleet', 'الرافعات وجداول الحمولة'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'day' && <DayView />}
      {tab === 'fleet' && <FleetView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function LiftTable({ id, rows, onOpen, date }: { id: string; rows: Lift[]; onOpen?: (id: string) => void; date?: boolean }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr>{date && <th>اليوم</th>}<th>الوقت</th><th>الخطة</th><th>العميل والموقع</th><th>الرافعة</th><th>الحمولة</th><th>نصف القطر</th><th>الاستخدام</th><th>الحالة</th>{onOpen && <th></th>}</tr></thead>
      <tbody>{rows.map((l) => (
        <tr key={l.id}>{date && <td className="num">{l.lift_date}</td>}<td className="num">{hhmm(l.lift_time)}</td>
          <td><span className="num">{l.ref}</span> {l.description}{l.critical && <> <Badge tone={l.approved_at ? 'info' : 'danger'}>{l.approved_at ? 'حرجة معتمدة' : 'حرجة: تحتاج اعتماد'}</Badge></>}</td>
          <td>{l.customer_name}<div className="muted">{[l.site?.name, l.site?.area].filter(Boolean).join('، ')}</div></td>
          <td className="num">{l.plate_no}</td><td className="num">{t1(l.load_t)}</td><td className="num">{l.radius_m} م</td>
          <td><Badge tone={pctTone(l.utilization)}>{l.utilization}%</Badge> <span className="muted num">من {t1(l.rated_t)}</span></td>
          <td><Tone map={CR_STATUS} value={l.status} />{l.wind_ms !== null && <div className="muted num">رياح {l.wind_ms} م/ث</div>}</td>
          {onOpen && <td><button className="small" onClick={() => onOpen(l.id)}>فتح</button></td>}</tr>
      ))}</tbody></table></div>
  );
}

function DayView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const list = useLoad(() => api<{ data: Lift[] }>(`/cranes/lifts?date=${day}`).then((r) => r.data), [day]);
  const [add, setAdd] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الرفعات" /></label>
        {can(me, 'tasks:assign') && <button onClick={() => setAdd(true)}>خطة رفع جديدة</button>}
        <button className="secondary" onClick={() => void list.reload()}>تحديث</button>
      </div>
      <ErrorBox error={list.error} />
      {list.data && <LiftTable id="lifts" rows={list.data} onOpen={setOpen} />}
      <p className="muted" style={{ margin: 0 }}>عقود التأجير وأيام العمل وعدّاد الساعات في صفحة تأجير المعدات. لا يُنهي المشغّل يوم العمل قبل إغلاق رفعاته.</p>
      {add && <LiftForm day={day} onClose={() => setAdd(false)} onDone={(id) => { setAdd(false); setOpen(id); void list.reload(); }} />}
      {open && <LiftModal id={open} onClose={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function LiftForm({ day, onClose, onDone }: { day: string; onClose: () => void; onDone: (id: string) => void }) {
  const act = useAction();
  type H = { id: string; ref: string; asset_type: string; plate_no: string; customer_name: string; state: string };
  const hires = useLoad(() => api<{ data: H[] }>('/equipment/hires').then((r) => r.data.filter((h) => h.asset_type === 'crane' && ['on_hire', 'booked'].includes(h.state))));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string }[] }>('/workers?status=active').then((x) => x.data));
  const { f, bind } = useForm({ hire_id: '', lift_date: day, lift_time: '', description: '', load_t: '', radius_m: '', rigger_worker_id: '', tandem: '', over_people: '' });
  return (
    <Modal title="خطة رفع جديدة" onClose={onClose}>
      <ErrorBox error={act.error} />
      {hires.data?.length === 0 && <p className="muted">لا عقد تأجير رافعة ساري. أنشئ العقد من صفحة تأجير المعدات.</p>}
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const l = await api<Lift>('/cranes/lifts', { method: 'POST', body: {
          hire_id: f.hire_id, lift_date: f.lift_date, description: f.description, load_t: Number(f.load_t), radius_m: Number(f.radius_m), rigger_worker_id: f.rigger_worker_id,
          tandem: f.tandem === 'yes', over_people: f.over_people === 'yes', ...clean({ lift_time: f.lift_time }),
        } });
        onDone(l.id);
      }); }}>
        <div className="row">
          <label className="field">عقد التأجير<select {...bind('hire_id')} required><option value="">—</option>{hires.data?.map((h) => <option key={h.id} value={h.id}>{h.ref} · {h.plate_no} · {h.customer_name}</option>)}</select></label>
          <label className="field">اليوم<input {...bind('lift_date')} type="date" required /></label>
          <label className="field">الوقت<input {...bind('lift_time')} type="time" /></label>
        </div>
        <label className="field">ما يُرفع<input {...bind('description')} required maxLength={300} placeholder="جسر حديد، مولد، خزان…" /></label>
        <div className="row">
          <label className="field">الحمولة مع أدوات الرفع (طن)<input {...bind('load_t')} type="number" step="0.01" min={0.01} required className="num" style={{ width: 110 }} /></label>
          <label className="field">نصف القطر (م)<input {...bind('radius_m')} type="number" step="0.1" min={0.1} required className="num" style={{ width: 100 }} /></label>
          <label className="field">الموجّه (rigger)<select {...bind('rigger_worker_id')} required><option value="">—</option>{workers.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">رفعة مزدوجة (رافعتان)<select {...bind('tandem')}><option value="">لا</option><option value="yes">نعم</option></select></label>
          <label className="field">فوق أشخاص أو منشأة عاملة<select {...bind('over_people')}><option value="">لا</option><option value="yes">نعم</option></select></label>
        </div>
        <p className="muted" style={{ margin: 0 }}>الحمولة المقنّنة من جدول الرافعة عند نصف القطر هذا أو الأكبر منه. 75% فأكثر أو مزدوجة أو فوق أشخاص = رفعة حرجة تحتاج اعتماد [تخمين].</p>
        <button disabled={act.busy}>حفظ الخطة</button>
      </form>
    </Modal>
  );
}

function LiftModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const l = useLoad(() => api<Lift>(`/cranes/lifts/${id}`), [id]);
  const d = l.data;
  const act = useAction();
  const { f, bind } = useForm({ wind_ms: '', note: '', reason: '' });
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/cranes/lifts/${id}/${path}`, { method: 'POST', body }); await l.reload(); });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={d ? `خطة الرفع ${d.ref}` : 'خطة الرفع'} onClose={onClose}>
      <ErrorBox error={l.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={CR_STATUS} value={d.status} /> <b>{d.description}</b> · <span className="num">{d.lift_date} {hhmm(d.lift_time)}</span> · {d.customer_name} · عقد <span className="num">{d.hire_ref}</span></p>
        <p data-testid="lift-calc">الحمولة <b className="num">{t1(d.load_t)}</b> عند <span className="num">{d.radius_m} م</span> · المقنّنة <span className="num">{t1(d.rated_t)}</span> · الاستخدام <Badge tone={pctTone(d.utilization)}>{d.utilization}%</Badge>
          {d.tandem && <> · <Badge tone="warning">مزدوجة</Badge></>}{d.over_people && <> · <Badge tone="warning">فوق أشخاص</Badge></>}</p>
        <p>الرافعة <span className="num">{d.plate_no}</span> · المشغّل {d.operator_name ?? '—'} · الموجّه {d.rigger_name ?? '—'} · حد الرياح <span className="num">{d.wind_limit_ms ?? 9.8} م/ث</span></p>
        {d.critical && <p data-testid="lift-approval">{d.approved_at ? <>رفعة حرجة اعتمدها {d.approved_by_name ?? '—'} <span className="num">{dt(d.approved_at)}</span></> : <b>رفعة حرجة لم تُعتمد: لا ينفذها المشغّل قبل الاعتماد</b>}</p>}
        {d.status === 'done' && <p>نُفذت <span className="num">{dt(d.done_at)}</span> · الرياح <span className="num">{d.wind_ms} م/ث</span></p>}
        {d.abort_reason && <p className="muted">{d.status === 'aborted' ? 'أُوقفت' : 'أُلغيت'}: {d.abort_reason}{d.wind_ms !== null && ` (رياح ${d.wind_ms} م/ث)`}</p>}
        {w && d.status === 'planned' && <>
          {d.critical && !d.approved_at && <div className="row"><button disabled={act.busy} onClick={() => void post('approve', {})}>اعتماد الرفعة الحرجة</button></div>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); void post('record', { event: 'done', wind_ms: Number(f.wind_ms) }); }}>
            <label className="field">الرياح (م/ث)<input {...bind('wind_ms')} type="number" step="0.1" min={0} max={60} required className="num" style={{ width: 90 }} /></label>
            <button className="secondary" disabled={act.busy}>تسجيل التنفيذ من المكتب</button>
          </form>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void post('record', { event: 'aborted', note: f.note, ...(f.wind_ms ? { wind_ms: Number(f.wind_ms) } : {}) }); }}>
            <input {...bind('note')} placeholder="سبب الإيقاف (رياح، عطل، الموقع غير جاهز)" required maxLength={300} aria-label="سبب إيقاف الرفعة" />
            <button className="danger" disabled={act.busy}>إيقاف الرفعة</button>
          </form>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
            <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={300} aria-label="سبب إلغاء الرفعة" />
            <button className="secondary" disabled={act.busy}>إلغاء الخطة</button>
          </form>
        </>}
      </div>}
    </Modal>
  );
}

function FleetView() {
  const me = useMe();
  const fleet = useLoad(() => api<{ data: Crane[] }>('/cranes/fleet').then((r) => r.data));
  const [edit, setEdit] = useState<Crane | null>(null);
  const today = todayKw();
  return (
    <section className="card stack"><h2>الرافعات وجداول الحمولة</h2>
      <ErrorBox error={fleet.error} />
      {fleet.data?.length === 0 ? <Empty>لا رافعات. أضف مركبة نوعها «رافعة (كرين)» من صفحة الأسطول.</Empty> : (
        <div className="tbl-wrap"><table data-testid="cranes-fleet"><thead><tr><th>الرافعة</th><th>أقصى حمولة</th><th>الذراع</th><th>حد الرياح</th><th>جدول الحمولة</th><th>شهادة الفحص</th><th></th></tr></thead>
          <tbody>{fleet.data?.map((c) => (
            <tr key={c.asset_id}><td><span className="num">{c.plate_no}</span>{c.make && <div className="muted">{[c.make, c.model].filter(Boolean).join(' ')}</div>}</td>
              <td className="num">{t1(c.max_capacity_t)}</td><td className="num">{c.boom_m ? `${c.boom_m} م` : '—'}</td><td className="num">{c.wind_limit_ms ? `${c.wind_limit_ms} م/ث` : '—'}</td>
              <td>{c.chart ? <span className="num">{c.chart.length} صف · {c.chart[0].capacity_t} ط عند {c.chart[0].radius_m} م ← {c.chart[c.chart.length - 1].capacity_t} ط عند {c.chart[c.chart.length - 1].radius_m} م</span> : <Badge tone="danger">لا جدول</Badge>}</td>
              <td>{!c.cert_expires_on ? <Badge tone="danger">لا شهادة</Badge> : c.cert_expires_on < today ? <Badge tone="danger">منتهية {c.cert_expires_on}</Badge> : <span className="num">{c.cert_expires_on}</span>}</td>
              <td>{can(me, 'fleet:write') && <button className="small" onClick={() => setEdit(c)}>الجدول</button>}</td></tr>
          ))}</tbody></table></div>
      )}
      <p className="muted" style={{ margin: 0 }}>شهادة الفحص (TPI) ورخصة المشغّل وشهادة الموجّه تُسجَّل من صفحة الوثائق، ولا تُخطط رفعة بدونها سارية في يومها.</p>
      {edit && <ChartForm crane={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void fleet.reload(); }} />}
    </section>
  );
}

function ChartForm({ crane, onClose, onDone }: { crane: Crane; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const { f, bind } = useForm({
    max_capacity_t: crane.max_capacity_t ? String(crane.max_capacity_t) : '', boom_m: crane.boom_m ? String(crane.boom_m) : '', wind_limit_ms: String(crane.wind_limit_ms ?? 9.8),
    chart: (crane.chart ?? []).map((r) => `${r.radius_m} ${r.capacity_t}`).join('\n'),
  });
  return (
    <Modal title={`جدول حمولة الرافعة ${crane.plate_no}`} onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const chart = f.chart.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => { const [r, c] = x.split(/[\s,،]+/).map(Number); return { radius_m: r, capacity_t: c }; });
        await api(`/cranes/fleet/${crane.asset_id}`, { method: 'PUT', body: { max_capacity_t: Number(f.max_capacity_t), wind_limit_ms: Number(f.wind_limit_ms), chart, ...(f.boom_m ? { boom_m: Number(f.boom_m) } : {}) } });
        onDone();
      }); }}>
        <div className="row">
          <label className="field">أقصى حمولة (طن)<input {...bind('max_capacity_t')} type="number" step="0.01" min={0.01} required className="num" style={{ width: 100 }} /></label>
          <label className="field">طول الذراع (م)<input {...bind('boom_m')} type="number" step="0.1" min={0.1} className="num" style={{ width: 90 }} /></label>
          <label className="field">حد الرياح (م/ث)<input {...bind('wind_limit_ms')} type="number" step="0.1" min={3} max={30} required className="num" style={{ width: 90 }} /></label>
        </div>
        <label className="field">جدول الحمولة من كتيّب المصنّع: سطر لكل نصف قطر «المتر الطن»، نصف القطر تصاعدي
          <textarea {...bind('chart')} rows={8} required className="num" placeholder={'3 50\n10 20\n20 8'} aria-label="جدول الحمولة" />
        </label>
        <p className="muted" style={{ margin: 0 }}>حد الرياح الافتراضي 9.8 م/ث [تخمين]. استخدم حد المصنّع لكل رافعة.</p>
        <button disabled={act.busy}>حفظ الجدول</button>
      </form>
    </Modal>
  );
}

function ExceptionsView() {
  type C = { asset_id: string; plate_no: string; has_chart: boolean; cert_expires_on: string | null };
  type X = { unapproved: Lift[]; open_past: Lift[]; aborted: Lift[]; no_chart: C[]; certificates: C[] };
  const x = useLoad(() => api<X>('/cranes/exceptions'));
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="حرجة بلا اعتماد" value={d.unapproved.length} tone={d.unapproved.length ? 'danger' : undefined} />
          <Kpi label="رفعات أيام سابقة مفتوحة" value={d.open_past.length} tone={d.open_past.length ? 'warning' : undefined} />
          <Kpi label="أُوقفت (يومان)" value={d.aborted.length} tone={d.aborted.length ? 'warning' : undefined} />
          <Kpi label="شهادات رافعات" value={d.certificates.length} tone={d.certificates.length ? 'danger' : undefined} />
        </div>
        <section className="card"><h2>رفعات حرجة اليوم أو غدًا لم تُعتمد</h2><LiftTable id="ex-unapproved" rows={d.unapproved} date /></section>
        <section className="card"><h2>رفعات أيام سابقة لم تُغلق</h2><LiftTable id="ex-open" rows={d.open_past} date /></section>
        <section className="card"><h2>رفعات أُوقفت</h2><LiftTable id="ex-aborted" rows={d.aborted} date /></section>
        <section className="card"><h2>رافعات بلا جدول حمولة أو شهادتها منتهية أو تنتهي خلال 30 يومًا</h2>
          {d.no_chart.length + d.certificates.length === 0 ? <Empty>لا يوجد</Empty> : (
            <div className="tbl-wrap"><table data-testid="ex-cranes"><thead><tr><th>الرافعة</th><th>جدول الحمولة</th><th>شهادة الفحص</th></tr></thead>
              <tbody>{[...new Map([...d.no_chart, ...d.certificates].map((c) => [c.asset_id, c])).values()].map((c) => (
                <tr key={c.asset_id}><td className="num">{c.plate_no}</td><td>{c.has_chart ? 'موجود' : <Badge tone="danger">لا جدول</Badge>}</td><td className="num">{c.cert_expires_on ?? 'لا شهادة'}</td></tr>))}</tbody></table></div>
          )}</section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { lifts: number; done: number; aborted: number; aborted_wind: number; critical: number; max_utilization: number; heaviest_t: number };
  const r = useLoad(() => api<{ totals: Sum & { canceled: number }; customers: (Sum & { customer_name: string })[] }>(`/cranes/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="رفعات منفذة" value={`${x.done} / ${x.lifts}`} />
          <Kpi label="أُوقفت (منها للرياح)" value={`${x.aborted} (${x.aborted_wind})`} />
          <Kpi label="حرجة منفذة" value={x.critical} />
          <Kpi label="أثقل رفعة" value={t1(x.heaviest_t)} />
        </div>
        <p className="muted">أعلى نسبة استخدام {x.max_utilization}% · ملغاة {x.canceled}</p>
        <section className="card"><h2>حسب العميل</h2>
          {r.data!.customers.length === 0 ? <Empty>لا رفعات</Empty> : <div className="tbl-wrap"><table data-testid="cr-report"><thead><tr><th>العميل</th><th>رفعات</th><th>منفذة</th><th>أُوقفت</th><th>حرجة</th><th>أعلى استخدام</th><th>أثقل</th></tr></thead>
            <tbody>{r.data!.customers.map((c) => <tr key={c.customer_name}><td>{c.customer_name}</td><td className="num">{c.lifts}</td><td className="num">{c.done}</td><td className="num">{c.aborted}</td>
              <td className="num">{c.critical}</td><td className="num">{c.max_utilization}%</td><td className="num">{t1(c.heaviest_t)}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
