'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ABSENCE_SCOPE, dt, ISO_WEEKDAYS, REPORTED_BY, SCHOOL_DIRECTION, SCHOOL_SKIP, SCHOOL_STATE, TASK_STATUS, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

interface Stop { name: string; area?: string; offset_min: number }
interface Route {
  id: string; legal_entity_id: string; customer_id: string | null; customer_name: string | null; school_name: string; code: string; name: string; direction: string; depart_time: string;
  duration_min: number; days: number[]; stops: Stop[]; capacity: number | null; asset_id: string | null; plate_no: string | null; driver_worker_id: string | null; driver_name: string | null;
  attendant_worker_id: string | null; attendant_name: string | null; active: boolean; version: number; students: number;
}
interface Student {
  id: string; name: string; grade: string | null; stop_seq: number; guardian_name: string | null; guardian_phone: string; handover: boolean; note: string | null; active?: boolean;
  event?: string | null; received_by?: string | null; source?: string | null; state?: string; absent_30d?: number;
}
interface Trip {
  id: string; route_id: string; route_code: string; route_name: string; school_name: string; direction: string; customer_name: string | null; trip_date: string; task_id: string; status: string;
  depart_at: string; arrive_by: string; plate_no: string; driver_name: string; attendant_name: string | null; attendant_worker_id: string | null; students_planned: number; capacity: number | null;
  started_at: string | null; ended_at: string | null; on_board: number; dropped: number; absent: number;
}
type Tab = 'day' | 'routes' | 'absences' | 'exceptions' | 'report';

const useRoutes = () => useLoad(() => api<{ data: Route[] }>('/school/routes').then((r) => r.data));
const hhmm = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16);
const daysText = (d: number[]) => d.length === 7 ? 'كل يوم' : ISO_WEEKDAYS.filter(([n]) => d.includes(n)).map(([, l]) => l).join('، ');
const tomorrowKw = () => new Date(Date.now() + 27 * 3_600_000).toISOString().slice(0, 10);

/** School transport (sector 10): today's trips with each student's boarding and drop, routes and students, absence notices, exceptions and the report. */
export default function SchoolPage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>النقل المدرسي</h1></div>
      <Tabs tabs={[['day', 'رحلات اليوم'], ['routes', 'الخطوط والطلاب'], ['absences', 'بلاغات الغياب'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'day' && <DayView />}
      {tab === 'routes' && <RoutesView />}
      {tab === 'absences' && <AbsencesView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function DayView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const trips = useLoad(() => api<{ data: Trip[] }>(`/school/trips?date=${day}`).then((r) => r.data), [day]);
  const act = useAction();
  const [gen, setGen] = useState<{ created: string[]; existing: string[]; skipped: { code: string; reason: string }[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => { setDay(e.target.value); setGen(null); }} aria-label="يوم الرحلات" /></label>
        {can(me, 'tasks:assign') && <button disabled={act.busy} onClick={() => void act.run(async () => {
          setGen(await api('/school/trips/generate', { method: 'POST', body: { date: day } })); await trips.reload();
        })}>توليد رحلات اليوم</button>}
      </div>
      <ErrorBox error={act.error ?? trips.error} />
      {gen && <p data-testid="gen-result" className="muted">أُنشئ {gen.created.length}{gen.existing.length ? ` · موجود ${gen.existing.length}` : ''}
        {gen.skipped.map((s) => <span key={s.code}> · <Badge tone="warning">{s.code}: {SCHOOL_SKIP[s.reason] ?? s.reason}</Badge></span>)}</p>}
      {trips.data?.length === 0 ? <Empty>لا توجد رحلات لهذا اليوم. ولّدها من الخطوط العاملة فيه.</Empty> : (
        <div className="tbl-wrap"><table data-testid="trips"><thead><tr><th>الانطلاق</th><th>الخط</th><th>المدرسة</th><th>الحافلة والسائق والمشرفة</th><th>الحالة</th><th>الطلاب</th><th></th></tr></thead>
          <tbody>{trips.data?.map((t) => (
            <tr key={t.id}><td className="num">{hhmm(t.depart_at)}{t.started_at && <> <span className="muted">انطلق {hhmm(t.started_at)}</span></>}</td>
              <td><span className="num">{t.route_code}</span> {t.route_name} <Badge>{SCHOOL_DIRECTION[t.direction]}</Badge></td><td>{t.school_name}</td>
              <td><span className="num">{t.plate_no}</span> · {t.driver_name} · {t.attendant_name ?? <Badge tone="warning">بلا مشرفة</Badge>}</td><td><Tone map={TASK_STATUS} value={t.status} /></td>
              <td className="num">نزل {t.dropped} / {t.students_planned}{t.on_board > 0 && <> <Badge tone={['completed', 'failed', 'canceled'].includes(t.status) ? 'danger' : 'info'}>في الحافلة {t.on_board}</Badge></>}
                {t.absent > 0 && <> <Badge tone="warning">غائب {t.absent}</Badge></>}</td>
              <td><button className="small" onClick={() => setOpen(t.id)}>الطلاب</button></td></tr>
          ))}</tbody></table></div>
      )}
      {open && <TripModal id={open} onClose={() => { setOpen(null); void trips.reload(); }} />}
    </section>
  );
}

function TripModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const t = useLoad(() => api<Trip & { stops: Stop[]; students: Student[] }>(`/school/trips/${id}`), [id]);
  const act = useAction();
  const [reason, setReason] = useState('');
  const d = t.data;
  const [handTo, setHandTo] = useState<{ s: Student; name: string } | null>(null);
  const send = (s: Student, event: string, received_by = '') => act.run(async () => {
    await api(`/school/trips/${id}/mark`, { method: 'POST', body: { student_id: s.id, event, ...clean({ received_by }) } }); setHandTo(null); await t.reload();
  });
  // a young child going home is handed to a named adult: ask for the name first
  const mark = (s: Student, event: string) => event === 'dropped' && d?.direction === 'from_school' && s.handover ? setHandTo({ s, name: s.guardian_name ?? '' }) : void send(s, event);
  const office = can(me, 'tasks:assign') && d && d.status !== 'canceled';
  return (
    <Modal title={d ? `رحلة ${d.route_code} · ${d.trip_date}` : 'الرحلة'} onClose={onClose}>
      <ErrorBox error={t.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={TASK_STATUS} value={d.status} /> {d.school_name} · {SCHOOL_DIRECTION[d.direction]} · <span className="num">{d.plate_no}</span> · {d.driver_name} · المشرفة {d.attendant_name ?? '—'}</p>
        <p data-testid="trip-count"><b>في الحافلة {d.on_board}</b> · نزل {d.dropped} · غائب {d.absent} من {d.students.length}</p>
        {d.stops.map((s, i) => (
          <div key={i}>
            <h3><span className="num">{hhmm(new Date(new Date(d.depart_at).getTime() + s.offset_min * 60_000).toISOString())}</span> {s.name}{s.area ? ` · ${s.area}` : ''}</h3>
            {d.students.filter((x) => x.stop_seq === i + 1).length === 0 ? <p className="muted">لا طلاب من هذه المحطة</p> : (
              <div className="tbl-wrap"><table data-testid={`manifest-${i + 1}`}><tbody>{d.students.filter((x) => x.stop_seq === i + 1).map((x) => (
                <tr key={x.id}><td>{x.name} {x.grade && <span className="muted">{x.grade}</span>}{x.handover && <> <Badge>يُسلَّم لبالغ</Badge></>}{x.note && <div className="muted">{x.note}</div>}</td>
                  <td className="num">{x.guardian_phone}</td>
                  <td><Tone map={SCHOOL_STATE} value={x.state ?? 'waiting'} />{x.received_by && <span className="muted"> استلمه {x.received_by}</span>}{x.source === 'office' && <span className="muted"> (المكتب)</span>}</td>
                  <td>{office && <>
                    {x.state !== 'on_board' && x.state !== 'dropped' && <button className="small" disabled={act.busy} onClick={() => void mark(x, 'boarded')} aria-label={`صعد ${x.name}`}>صعد</button>}{' '}
                    {x.state !== 'on_board' && x.state !== 'absent' && x.state !== 'dropped' && <button className="small" disabled={act.busy} onClick={() => void mark(x, 'absent')} aria-label={`غائب ${x.name}`}>غائب</button>}
                    {x.state === 'on_board' && <button className="small" disabled={act.busy} onClick={() => void mark(x, 'dropped')} aria-label={`نزل ${x.name}`}>نزل</button>}</>}</td></tr>
              ))}</tbody></table></div>
            )}
          </div>
        ))}
        {handTo && <form className="row" data-testid="handover" onSubmit={(e) => { e.preventDefault(); void send(handTo.s, 'dropped', handTo.name.trim()); }}>
          <label className="field">اسم من استلم {handTo.s.name}<input value={handTo.name} onChange={(e) => setHandTo({ ...handTo, name: e.target.value })} required maxLength={120} autoFocus aria-label="اسم المستلم" /></label>
          <button disabled={act.busy}>تم التسليم</button> <button type="button" className="secondary" onClick={() => setHandTo(null)}>إلغاء</button>
        </form>}
        {can(me, 'tasks:assign') && ['ready', 'assigned', 'accepted'].includes(d.status) && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api(`/school/trips/${id}/cancel`, { method: 'POST', body: { reason } }); await t.reload();
        }); }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="سبب الإلغاء" required maxLength={300} aria-label="سبب إلغاء الرحلة" />
          <button className="danger" disabled={act.busy}>إلغاء الرحلة</button>
        </form>}
      </div>}
    </Modal>
  );
}

function RoutesView() {
  const me = useMe();
  const routes = useRoutes();
  const [edit, setEdit] = useState<Route | 'new' | null>(null);
  const [studentsOf, setStudentsOf] = useState<Route | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={routes.error} />
      {can(me, 'tasks:assign') && <div className="row"><button onClick={() => setEdit('new')}>إضافة خط</button></div>}
      {routes.data?.length === 0 ? <Empty>لا توجد خطوط بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="routes"><thead><tr><th>الخط</th><th>المدرسة</th><th>الانطلاق</th><th>الأيام</th><th>المحطات</th><th>الحافلة والسائق والمشرفة</th><th>الطلاب</th><th></th></tr></thead>
          <tbody>{routes.data?.map((r) => (
            <tr key={r.id}><td><span className="num">{r.code}</span> {r.name} <Badge>{SCHOOL_DIRECTION[r.direction]}</Badge>{!r.active && <> <Badge>موقوف</Badge></>}</td><td>{r.school_name}</td>
              <td className="num">{r.depart_time} · {r.duration_min} د</td><td>{daysText(r.days)}</td><td>{r.stops.map((s) => s.name).join(' ← ')}</td>
              <td>{r.plate_no ? <span className="num">{r.plate_no}</span> : <Badge tone="warning">بلا حافلة</Badge>} · {r.driver_name ?? <Badge tone="warning">بلا سائق</Badge>} · {r.attendant_name ?? <Badge tone="warning">بلا مشرفة</Badge>}</td>
              <td className="num">{r.students}{r.capacity ? ` / ${r.capacity}` : ''}</td>
              <td>{can(me, 'tasks:assign') && <><button className="small" onClick={() => setEdit(r)}>تعديل</button> </>}<button className="small" onClick={() => setStudentsOf(r)}>الطلاب</button></td></tr>
          ))}</tbody></table></div>
      )}
      {edit && <RouteForm r={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void routes.reload(); }} />}
      {studentsOf && <StudentsModal r={studentsOf} onClose={() => { setStudentsOf(null); void routes.reload(); }} />}
    </section>
  );
}

function RouteForm({ r, onClose, onDone }: { r: Route | null; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const assets = useAssets();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string }[] }>('/workers?status=active').then((x) => x.data));
  const { f, bind, setF } = useForm({ code: r?.code ?? '', name: r?.name ?? '', school_name: r?.school_name ?? '', customer_id: r?.customer_id ?? '', direction: r?.direction ?? 'to_school',
    depart_time: r?.depart_time ?? '06:15', duration_min: String(r?.duration_min ?? 60), capacity: r?.capacity ? String(r.capacity) : '', asset_id: r?.asset_id ?? '',
    driver_worker_id: r?.driver_worker_id ?? '', attendant_worker_id: r?.attendant_worker_id ?? '',
    stops: r ? r.stops.map((s) => [s.offset_min, s.name, s.area ?? ''].join(' | ').replace(/ \| $/, '')).join('\n') : '0 | ', active: r?.active ?? true });
  const [days, setDays] = useState<number[]>(r?.days ?? [7, 1, 2, 3, 4]);
  const parseStops = () => f.stops.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [m, name, area] = l.split('|').map((x) => x.trim());
    return { offset_min: Number(m), name, ...clean({ area: area ?? '' }) };
  });
  return (
    <Modal title={r ? `تعديل الخط ${r.code}` : 'إضافة خط'} onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const body = { name: f.name, school_name: f.school_name, customer_id: f.customer_id || null, direction: f.direction, depart_time: f.depart_time, duration_min: Number(f.duration_min), days,
          stops: parseStops(), capacity: f.capacity ? Number(f.capacity) : null, asset_id: f.asset_id || null, driver_worker_id: f.driver_worker_id || null, attendant_worker_id: f.attendant_worker_id || null };
        if (r) await api(`/school/routes/${r.id}`, { method: 'PATCH', body: { ...body, version: r.version, active: f.active } });
        else await api('/school/routes', { method: 'POST', body: { ...body, legal_entity_id: me.legal_entities[0]?.id, code: f.code } });
        onDone();
      }); }}>
        <div className="row">
          {!r && <label className="field">الرمز<input {...bind('code')} required maxLength={12} className="num" style={{ width: 100 }} /></label>}
          <label className="field">اسم الخط<input {...bind('name')} required maxLength={120} /></label>
          <label className="field">المدرسة<input {...bind('school_name')} required maxLength={120} /></label>
          <label className="field">العميل<select {...bind('customer_id')}><option value="">اشتراكات الأهالي</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">الاتجاه<select {...bind('direction')}>{Object.entries(SCHOOL_DIRECTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">الانطلاق<input {...bind('depart_time')} type="time" required /></label>
          <label className="field">المدة (دقيقة)<input {...bind('duration_min')} type="number" min={10} max={240} className="num" style={{ width: 90 }} /></label>
          <label className="field">المقاعد<input {...bind('capacity')} type="number" min={1} max={120} className="num" style={{ width: 80 }} /></label>
        </div>
        <fieldset className="row" aria-label="أيام الدراسة">{ISO_WEEKDAYS.map(([n, l]) => (
          <label key={n} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={days.includes(n)} onChange={(e) => setDays(e.target.checked ? [...days, n] : days.filter((x) => x !== n))} /> {l}</label>
        ))}</fieldset>
        <label className="field">المحطات بالترتيب، سطر لكل محطة: الدقائق بعد الانطلاق | الاسم | المنطقة
          <textarea {...bind('stops')} rows={4} required aria-label="المحطات" /></label>
        <div className="row">
          <label className="field">الحافلة<select {...bind('asset_id')}><option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          <label className="field">السائق<select {...bind('driver_worker_id')}><option value="">—</option>{workers.data?.filter((w) => ['driver', 'courier'].includes(w.kind)).map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          <label className="field">المشرفة<select {...bind('attendant_worker_id')}><option value="">—</option>{workers.data?.filter((w) => ['supervisor', 'driver', 'courier'].includes(w.kind)).map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          {r && <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> فعّال</label>}
        </div>
        <button disabled={act.busy}>حفظ</button>
      </form>
    </Modal>
  );
}

function StudentsModal({ r, onClose }: { r: Route; onClose: () => void }) {
  const me = useMe();
  const students = useLoad(() => api<{ data: Student[] }>(`/school/routes/${r.id}/students`).then((x) => x.data), [r.id]);
  const act = useAction();
  const [text, setText] = useState('');
  const [res, setRes] = useState<number | null>(null);
  return (
    <Modal title={`طلاب الخط ${r.code}`} onClose={onClose}>
      <ErrorBox error={act.error ?? students.error} />
      {can(me, 'tasks:assign') && <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const list = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, grade, stop, guardian_phone, guardian_name] = l.split(/\t|,|،/).map((x) => x.trim());
          return { name, stop_seq: Number(stop) || 1, guardian_phone: guardian_phone ?? '', ...clean({ grade: grade ?? '', guardian_name: guardian_name ?? '' }) };
        });
        setRes((await api<{ added: number }>(`/school/routes/${r.id}/students`, { method: 'POST', body: { students: list } })).added); setText(''); await students.reload();
      }); }}>
        <label className="field">سطر لكل طالب: الاسم، الصف (KG1، KG2، 1 … 12)، رقم المحطة ({r.stops.map((s, i) => `${i + 1} ${s.name}`).join('، ')})، هاتف ولي الأمر، اسم ولي الأمر
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} required aria-label="الطلاب" /></label>
        <p className="muted" style={{ margin: 0 }}>الروضة والصفوف 1-3 تُسلَّم لبالغ عند النزول في البيت تلقائيًا، ويمكن تغييرها لكل طالب [تخمين].</p>
        <button disabled={act.busy}>إضافة الطلاب</button>
        {res !== null && <p className="muted" data-testid="students-result">أُضيف {res}</p>}
      </form>}
      {students.data?.length === 0 ? <Empty>لا طلاب بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="students"><thead><tr><th>الاسم</th><th>الصف</th><th>المحطة</th><th>ولي الأمر</th><th>التسليم</th><th>غياب 30 يومًا</th><th></th></tr></thead>
          <tbody>{students.data?.map((x) => (
            <tr key={x.id}><td>{x.name}{!x.active && <> <Badge>موقوف</Badge></>}{x.note && <div className="muted">{x.note}</div>}</td><td>{x.grade ?? '—'}</td><td>{r.stops[x.stop_seq - 1]?.name ?? x.stop_seq}</td>
              <td>{x.guardian_name ?? ''} <span className="num">{x.guardian_phone}</span></td>
              <td>{can(me, 'tasks:assign') ? <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={x.handover} disabled={act.busy}
                onChange={(e) => void act.run(async () => { await api(`/school/students/${x.id}`, { method: 'PATCH', body: { handover: e.target.checked } }); await students.reload(); })} aria-label={`تسليم ${x.name} لبالغ`} /> لبالغ</label>
                : x.handover ? 'لبالغ' : '—'}</td>
              <td className="num">{x.absent_30d ? <Badge tone="warning">{x.absent_30d}</Badge> : 0}</td>
              <td>{can(me, 'tasks:assign') && <button className="small" disabled={act.busy} onClick={() => void act.run(async () => {
                await api(`/school/students/${x.id}`, { method: 'PATCH', body: { active: !x.active } }); await students.reload();
              })}>{x.active ? 'إيقاف' : 'تفعيل'}</button>}</td></tr>
          ))}</tbody></table></div>
      )}
    </Modal>
  );
}

function AbsencesView() {
  const me = useMe();
  const [day, setDay] = useState(tomorrowKw());
  const list = useLoad(() => api<{ data: { id: string; student_name: string; grade: string | null; route_code: string; school_name: string; scope: string; reported_by: string; note: string | null }[] }>(`/school/absences?date=${day}`).then((r) => r.data), [day]);
  const routes = useRoutes();
  const [route, setRoute] = useState('');
  const students = useLoad(() => route ? api<{ data: Student[] }>(`/school/routes/${route}/students`).then((x) => x.data.filter((s) => s.active)) : Promise.resolve([] as Student[]), [route]);
  const { f, bind, setF } = useForm({ student_id: '', scope: 'both', reported_by: 'guardian', note: '' });
  const act = useAction();
  return (
    <section className="card stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الغياب" style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={act.error ?? list.error} />
      {can(me, 'tasks:assign') && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api('/school/absences', { method: 'POST', body: { student_id: f.student_id, date: day, scope: f.scope, reported_by: f.reported_by, ...clean({ note: f.note }) } });
        setF({ ...f, student_id: '', note: '' }); await list.reload();
      }); }}>
        <label className="field">الخط<select value={route} onChange={(e) => setRoute(e.target.value)} aria-label="خط الطالب"><option value="">—</option>{routes.data?.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}</select></label>
        <label className="field">الطالب<select {...bind('student_id')} required aria-label="الطالب"><option value="">—</option>{students.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field">الرحلة<select {...bind('scope')}>{Object.entries(ABSENCE_SCOPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">المُبلِّغ<select {...bind('reported_by')}>{Object.entries(REPORTED_BY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">ملاحظة<input {...bind('note')} maxLength={300} /></label>
        <button disabled={act.busy}>تسجيل الغياب</button>
      </form>}
      <p className="muted" style={{ margin: 0 }}>الطالب المبلَّغ بغيابه يظهر للمشرفة «بلّغ بالغياب» فلا تنتظره الحافلة، ولا يمنع إنهاء الرحلة.</p>
      {list.data?.length === 0 ? <Empty>لا بلاغات غياب لهذا اليوم</Empty> : (
        <div className="tbl-wrap"><table data-testid="absences"><thead><tr><th>الطالب</th><th>الخط</th><th>المدرسة</th><th>الرحلة</th><th>المُبلِّغ</th><th>ملاحظة</th><th></th></tr></thead>
          <tbody>{list.data?.map((a) => (
            <tr key={a.id}><td>{a.student_name} {a.grade && <span className="muted">{a.grade}</span>}</td><td className="num">{a.route_code}</td><td>{a.school_name}</td><td>{ABSENCE_SCOPE[a.scope]}</td><td>{REPORTED_BY[a.reported_by]}</td><td>{a.note ?? ''}</td>
              <td>{can(me, 'tasks:assign') && day >= todayKw() && <button className="small" disabled={act.busy} onClick={() => void act.run(async () => {
                await api(`/school/absences/${a.id}`, { method: 'DELETE' }); await list.reload();
              })}>سحب</button>}</td></tr>
          ))}</tbody></table></div>
      )}
    </section>
  );
}

function ExceptionsView() {
  const [day, setDay] = useState(todayKw());
  type Kid = { id: string; name: string; grade: string | null; guardian_name: string | null; guardian_phone: string; route_code: string; school_name: string };
  const x = useLoad(() => api<{ left_on_board: (Trip & { students: Student[] })[]; late: Trip[]; missing: (Route & { reason: string })[]; no_attendant: Trip[]; over_capacity: Trip[]; absent_streak: Kid[] }>(`/school/exceptions?date=${day}`), [day]);
  const d = x.data;
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="طلاب باقون في حافلة" value={d.left_on_board.reduce((s, t) => s + t.students.length, 0)} tone={d.left_on_board.length ? 'danger' : undefined} />
          <Kpi label="رحلات متأخرة عن الانطلاق" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
          <Kpi label="رحلات بلا مشرفة" value={d.no_attendant.length} tone={d.no_attendant.length ? 'warning' : undefined} />
          <Kpi label="خطوط بلا رحلة" value={d.missing.length} tone={d.missing.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>طلاب ما زالوا مسجّلين في الحافلة بعد انتهاء الرحلة أو موعد وصولها</h2>
          <p className="muted">اتصل بالمشرفة أو السائق فورًا وتأكد أن الحافلة خالية، ثم سجّل نزول الطالب من نافذة الرحلة.</p>
          {d.left_on_board.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-onboard"><thead><tr><th>الخط</th><th>الحافلة والسائق والمشرفة</th><th>الحالة</th><th>الطلاب</th></tr></thead>
            <tbody>{d.left_on_board.map((t) => <tr key={t.id}><td><span className="num">{t.route_code}</span> {t.route_name}</td><td><span className="num">{t.plate_no}</span> · {t.driver_name} · {t.attendant_name ?? '—'}</td>
              <td><Tone map={TASK_STATUS} value={t.status} /></td><td>{t.students.map((s) => <div key={s.id}><b>{s.name}</b> · ولي الأمر <span className="num">{s.guardian_phone}</span></div>)}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>لم تنطلق بعد 10 دقائق من موعدها [تخمين]</h2>
          {d.late.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-late"><thead><tr><th>الخط</th><th>الموعد</th><th>الحافلة والسائق</th><th>الحالة</th></tr></thead>
            <tbody>{d.late.map((t) => <tr key={t.id}><td><span className="num">{t.route_code}</span> {t.route_name}</td><td className="num">{hhmm(t.depart_at)}</td><td><span className="num">{t.plate_no}</span> · {t.driver_name}</td><td><Tone map={TASK_STATUS} value={t.status} /></td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>رحلات تعمل بلا مشرفة</h2>
          {d.no_attendant.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-attendant"><thead><tr><th>الخط</th><th>المدرسة</th><th>الموعد</th></tr></thead>
            <tbody>{d.no_attendant.map((t) => <tr key={t.id}><td><span className="num">{t.route_code}</span> {t.route_name}</td><td>{t.school_name}</td><td className="num">{hhmm(t.depart_at)}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>خطوط تعمل اليوم بلا رحلة</h2>
          {d.missing.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-missing"><thead><tr><th>الخط</th><th>المدرسة</th><th>الانطلاق</th><th>السبب</th></tr></thead>
            <tbody>{d.missing.map((r) => <tr key={r.id}><td><span className="num">{r.code}</span> {r.name}</td><td>{r.school_name}</td><td className="num">{r.depart_time}</td><td><Badge tone="warning">{SCHOOL_SKIP[r.reason] ?? r.reason}</Badge></td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>غائبون بلا بلاغ 3 رحلات متتالية [تخمين]</h2>
          {d.absent_streak.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-streak"><thead><tr><th>الطالب</th><th>الخط</th><th>المدرسة</th><th>ولي الأمر</th></tr></thead>
            <tbody>{d.absent_streak.map((s) => <tr key={s.id}><td>{s.name} {s.grade && <span className="muted">{s.grade}</span>}</td><td className="num">{s.route_code}</td><td>{s.school_name}</td><td>{s.guardian_name ?? ''} <span className="num">{s.guardian_phone}</span></td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { trips: number; completed: number; canceled: number; failed: number; on_time_pct: number | null; carried: number; absences: number; notices: number };
  const r = useLoad(() => api<{ data: (Sum & { school_name: string; customer_name: string | null; routes: number })[]; totals: Sum }>(`/school/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  const pct = (n: number | null) => n === null ? '—' : `${n}%`;
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4">
          <Kpi label="رحلات منفذة" value={`${x.completed} / ${x.trips}`} />
          <Kpi label="الانطلاق في الموعد" value={pct(x.on_time_pct)} />
          <Kpi label="طلاب منقولون" value={x.carried} />
          <Kpi label="غياب (منه ببلاغ)" value={`${x.absences + x.notices} (${x.notices})`} />
        </div>
        <section className="card">
          {r.data!.data.length === 0 ? <Empty>لا توجد رحلات في الفترة</Empty> : (
            <div className="tbl-wrap"><table data-testid="sc-report"><thead><tr><th>المدرسة</th><th>العميل</th><th>الخطوط</th><th>الرحلات</th><th>منفذة</th><th>ملغاة</th><th>تعذرت</th><th>في الموعد</th><th>منقولون</th><th>غياب</th><th>بلاغات</th></tr></thead>
              <tbody>{r.data!.data.map((s) => <tr key={s.school_name}><td>{s.school_name}</td><td>{s.customer_name ?? 'اشتراكات الأهالي'}</td><td className="num">{s.routes}</td><td className="num">{s.trips}</td><td className="num">{s.completed}</td>
                <td className="num">{s.canceled}</td><td className="num">{s.failed}</td><td className="num">{pct(s.on_time_pct)}</td><td className="num">{s.carried}</td><td className="num">{s.absences}</td><td className="num">{s.notices}</td></tr>)}</tbody></table></div>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>الرحلات المنفذة أساس فاتورة المدرسة أو الأهالي الشهرية حسب العقد [تحقق محلي]. آخر تحديث {dt(new Date().toISOString())}.</p>
        </section>
      </>}
    </div>
  );
}
