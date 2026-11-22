'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ASSET_TYPE, dt, fuelLine, km, money, ROLE, time, todayKw, VEHICLE_STATE, VR_STATUS } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';
import { CancelButton, DecideForm, period, RequestFacts, typeLabel, VReq } from '@/components/internal';

interface Booking { asset_id: string; from: string; to: string; sector_pack: string; task_status: string; ref: string; request_id: string | null; status: string | null; department_name: string | null; requester_name: string | null; driver_name: string | null }
interface Vehicle { id: string; plate_no: string | null; asset_type: string; status: string; odometer_km: number | null; state: string; bookings: Booking[] }
interface Board { date: string; vehicles: Vehicle[]; counts: Record<string, number>; pending: number; to_allocate: number }
interface Dept { id: string; legal_entity_id: string; name: string; cost_center: string | null; manager_user_id: string | null; manager_name: string | null; manager_phone: string | null; active: boolean; members: number }
type Tab = 'board' | 'requests' | 'exceptions' | 'who' | 'costs' | 'departments' | 'settings';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fuelOptions = Array.from({ length: 9 }, (_, i) => i);

/** In-house corporate fleet (sector 21): the vehicles' day, employees' requests from approval to return, exceptions, fines lookup and the charge-back per department. */
export default function InternalPage() {
  const [tab, setTab] = useState<Tab>('board');
  const [date, setDate] = useState(todayKw());
  const [open, setOpen] = useState<string | null>(null);
  const board = useLoad(() => api<Board>(`/internal/board?date=${date}`), [date]);
  const [stamp, setStamp] = useState(0);
  const changed = () => { void board.reload(); setStamp((s) => s + 1); };
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>أسطول الشركة</h1>
        {tab === 'board' && <div className="row">
          <button className="small" onClick={() => setDate(addDays(date, -1))} aria-label="اليوم السابق">›</button>
          <input type="date" aria-label="اليوم" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="small" onClick={() => setDate(addDays(date, 1))} aria-label="اليوم التالي">‹</button>
        </div>}
      </div>
      <Tabs tabs={[['board', 'المركبات اليوم'], ['requests', 'الطلبات'], ['exceptions', 'الاستثناءات'], ['who', 'من كان يقود؟'], ['costs', 'التكلفة على الإدارات'], ['departments', 'الإدارات'], ['settings', 'الإعدادات']]} value={tab} onChange={setTab} />
      {tab === 'board' && <BoardView board={board.data} error={board.error} onOpen={setOpen} />}
      {tab === 'requests' && <RequestsView key={stamp} onOpen={setOpen} />}
      {tab === 'exceptions' && <ExceptionsView key={stamp} onOpen={setOpen} />}
      {tab === 'who' && <WhoView onOpen={setOpen} />}
      {tab === 'costs' && <CostsView />}
      {tab === 'departments' && <DepartmentsView />}
      {tab === 'settings' && <SettingsView />}
      {open && <RequestModal id={open} onClose={() => setOpen(null)} onChange={changed} />}
    </div>
  );
}

function BoardView({ board, error, onOpen }: { board: Board | null; error: string | null; onOpen: (id: string) => void }) {
  if (!board) return <ErrorBox error={error} />;
  const c = board.counts;
  return (
    <>
      <div className="grid g4">
        <Kpi label="متاحة الآن" value={c.free ?? 0} tone="success" />
        <Kpi label="في مشوار" value={c.in_use ?? 0} tone={c.in_use ? 'warning' : undefined} />
        <Kpi label="طلبات بانتظار الموافقة" value={board.pending} tone={board.pending ? 'warning' : undefined} />
        <Kpi label="موافق عليها بلا مركبة" value={board.to_allocate} tone={board.to_allocate ? 'danger' : undefined} />
      </div>
      <section className="card stack">
        <h2>حجوزات المركبات</h2>
        {board.vehicles.length === 0 ? <Empty>لا توجد مركبات</Empty> : (
          <div className="tbl-wrap"><table data-testid="vehicle-board">
            <thead><tr><th>المركبة</th><th>الآن</th><th>العدّاد</th><th>حجوزات اليوم</th></tr></thead>
            <tbody>{board.vehicles.map((v) => (
              <tr key={v.id}>
                <td><strong className="num">{v.plate_no ?? '—'}</strong> <span className="muted">{ASSET_TYPE[v.asset_type] ?? v.asset_type}</span></td>
                <td><Tone map={VEHICLE_STATE} value={v.state} /></td>
                <td>{km(v.odometer_km)}</td>
                <td>{v.bookings.length === 0 ? <span className="muted">لا شيء</span> : (
                  <div className="stack" style={{ gap: 4 }}>{v.bookings.map((b, i) => (
                    <div key={i}>
                      <span className="num">{time(b.from)}–{time(b.to)}</span>{' '}
                      {b.request_id
                        ? <><button type="button" className="link num" onClick={() => onOpen(b.request_id!)}>{b.ref}</button> {b.department_name} · {b.requester_name}{b.driver_name && <> · السائق {b.driver_name}</>} {b.status && <Tone map={VR_STATUS} value={b.status} />}</>
                        : <Badge>مهمة {b.ref}</Badge>}
                    </div>
                  ))}</div>
                )}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="muted" style={{ margin: 0 }}>المركبة المحجوزة لأي قطاع آخر (توصيل، توريد) تظهر هنا أيضًا، ولا يمكن حجزها مرتين في نفس الوقت.</p>
      </section>
    </>
  );
}

function RequestsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState('open');
  const list = useLoad(() => api<{ data: VReq[] }>(`/internal/requests${status ? `?status=${status}` : ''}`), [status]);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">الحالة<select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
          <option value="open">المفتوحة</option><option value="">الكل</option>
          {Object.entries(VR_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select></label>
      </div>
      <ErrorBox error={list.error} />
      {list.data && (list.data.data.length === 0 ? <Empty>لا توجد طلبات</Empty> : (
        <div className="tbl-wrap"><table data-testid="vr-list">
          <thead><tr><th>الطلب</th><th>الإدارة</th><th>الطالب</th><th>الفترة</th><th>المطلوب</th><th>المركبة</th><th>الحالة</th></tr></thead>
          <tbody>{list.data.data.map((r) => (
            <tr key={r.id}>
              <td><button type="button" className="link num" onClick={() => onOpen(r.id)} aria-label={`طلب المركبة ${r.ref}`}>{r.ref}</button><div className="muted">{r.purpose}</div></td>
              <td>{r.department_name}</td><td>{r.requester_name}</td><td className="num">{period(r)}</td>
              <td>{typeLabel(r.asset_type)}{r.with_driver && <> · <Badge tone="info">مع سائق</Badge></>}</td>
              <td className="num">{r.plate_no ?? '—'}</td><td><Tone map={VR_STATUS} value={r.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
    </section>
  );
}

function RequestModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const me = useMe();
  const r = useLoad(() => api<VReq>(`/internal/requests/${id}`), [id]);
  const p = r.data;
  const done = (x: VReq) => { r.setData(x); onChange(); };
  return (
    <Modal title={p ? `طلب المركبة ${p.ref}` : 'طلب المركبة'} onClose={onClose}>
      <div className="stack">
        <ErrorBox error={r.error} />
        {p && <>
          <RequestFacts r={p} />
          {p.status === 'pending' && can(me, 'tasks:assign') && <section className="card"><h3>القرار</h3><DecideForm r={p} onDone={done} /></section>}
          {p.status === 'approved' && can(me, 'tasks:assign') && <AllocateForm r={p} onDone={done} />}
          {p.status === 'allocated' && can(me, 'tasks:write') && <OdometerForm r={p} kind="handover" onDone={done} />}
          {p.status === 'in_use' && can(me, 'tasks:write') && <OdometerForm r={p} kind="return" onDone={done} />}
          <div className="row"><CancelButton r={p} onDone={done} /></div>
        </>}
      </div>
    </Modal>
  );
}

interface Options { vehicles: { id: string; plate_no: string | null; asset_type: string; status: string; odometer_km: number | null; matches: boolean | null; busy: { from: string; to: string } | null }[]; drivers: { id: string; display_name: string; busy: boolean }[] }
function AllocateForm({ r, onDone }: { r: VReq; onDone: (r: VReq) => void }) {
  const o = useLoad(() => api<Options>(`/internal/requests/${r.id}/options`), [r.id]);
  const act = useAction();
  const { f, bind } = useForm({ asset_id: '', driver_worker_id: '' });
  return (
    <form className="form card" onSubmit={(e) => { e.preventDefault(); void act.run(async () => onDone(await api<VReq>(`/internal/requests/${r.id}/allocate`, { method: 'POST', body: { version: r.version, asset_id: f.asset_id, ...clean({ driver_worker_id: f.driver_worker_id }) } }))); }}>
      <h3>تخصيص مركبة</h3>
      <ErrorBox error={o.error ?? act.error} />
      <div className="form-2">
        <label className="field">المركبة<select {...bind('asset_id')} required>
          <option value="">اختر</option>
          {o.data?.vehicles.map((v) => <option key={v.id} value={v.id} disabled={!!v.busy}>{v.plate_no} · {ASSET_TYPE[v.asset_type] ?? v.asset_type}{v.matches ? ' ✓' : ''}{v.busy ? ` (محجوزة ${time(v.busy.from)}–${time(v.busy.to)})` : ''}</option>)}
        </select></label>
        {r.with_driver && <label className="field">السائق<select {...bind('driver_worker_id')} required>
          <option value="">اختر</option>
          {o.data?.drivers.map((d) => <option key={d.id} value={d.id} disabled={d.busy}>{d.display_name}{d.busy ? ' (مشغول)' : ''}</option>)}
        </select></label>}
      </div>
      <p className="muted" style={{ margin: 0 }}>المركبات المتاحة طوال الفترة أولًا، ثم المطابقة للنوع المطلوب (✓).</p>
      <div className="row"><button className="primary" disabled={act.busy}>تخصيص</button></div>
    </form>
  );
}

function OdometerForm({ r, kind, onDone }: { r: VReq; kind: 'handover' | 'return'; onDone: (r: VReq) => void }) {
  const act = useAction();
  const { f, bind } = useForm({ odometer_km: '', fuel: '', note: '' });
  const out = kind === 'handover';
  return (
    <form className="form card" onSubmit={(e) => { e.preventDefault(); void act.run(async () => onDone(await api<VReq>(`/internal/requests/${r.id}/${kind}`, { method: 'POST', body: { version: r.version, odometer_km: Number(f.odometer_km), ...(f.fuel !== '' ? { fuel: Number(f.fuel) } : {}), ...clean({ note: f.note }) } }))); }}>
      <h3>{out ? 'تسليم المفتاح' : 'استلام المركبة'}</h3>
      {out && r.with_driver && <p className="muted" style={{ margin: 0 }}>السائق يسجّل الاستلام من التطبيق عادةً. استخدم هذا فقط إن سُلّمت من المكتب.</p>}
      <ErrorBox error={act.error} />
      <div className="form-2">
        <label className="field">العدّاد (كم)<input {...bind('odometer_km')} type="number" className="num" min={out ? 0 : r.out_odometer_km ?? 0} required /></label>
        <label className="field">الوقود<select {...bind('fuel')}><option value="">—</option>{fuelOptions.map((n) => <option key={n} value={n}>{fuelLine(n)}</option>)}</select></label>
        <label className="field">{out ? 'ملاحظات الفحص' : 'حالة المركبة'}<input {...bind('note')} maxLength={500} placeholder={out ? 'خدوش، نظافة…' : 'سليمة'} /></label>
      </div>
      {!out && r.out_odometer_km !== null && <p className="muted" style={{ margin: 0 }}>عدّاد الاستلام {km(r.out_odometer_km)}. تنتهي الحجزة الآن فتتاح المركبة لغيره.</p>}
      <div className="row"><button className="primary" disabled={act.busy}>{out ? 'تسليم' : 'استلام'}</button></div>
    </form>
  );
}

interface Ex { to_allocate: VReq[]; not_picked: VReq[]; overdue: VReq[]; waiting: VReq[]; after_hours: VReq[] }
function ExceptionsView({ onOpen }: { onOpen: (id: string) => void }) {
  const ex = useLoad(() => api<Ex>('/internal/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  const table = (title: string, rows: VReq[], hint: string) => (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted">{hint}</p>
      {rows.length === 0 ? <Empty>لا يوجد</Empty> : (
        <div className="tbl-wrap"><table><thead><tr><th>الطلب</th><th>الإدارة</th><th>الطالب</th><th>الفترة</th><th>المركبة</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}>
            <td><button type="button" className="link num" onClick={() => onOpen(r.id)}>{r.ref}</button></td><td>{r.department_name}</td><td>{r.requester_name}</td>
            <td className="num">{period(r)}</td><td className="num">{r.plate_no ?? '—'}</td></tr>)}</tbody></table></div>
      )}
    </section>
  );
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="تأخر إرجاعها" value={d.overdue.length} tone={d.overdue.length ? 'danger' : undefined} />
        <Kpi label="تبدأ قريبًا بلا مركبة" value={d.to_allocate.length} tone={d.to_allocate.length ? 'danger' : undefined} />
        <Kpi label="لم تُستلم في موعدها" value={d.not_picked.length} tone={d.not_picked.length ? 'warning' : undefined} />
        <Kpi label="تنتظر قرار المدير" value={d.waiting.length} tone={d.waiting.length ? 'warning' : undefined} />
      </div>
      {table('تأخر الإرجاع', d.overdue, 'بعد نهاية الفترة ومهلة الإرجاع في الإعدادات. تواصل مع الموظف.')}
      {table('موافق عليها وتبدأ خلال 24 ساعة بلا مركبة', d.to_allocate, 'افتح الطلب لتخصيص مركبة.')}
      {table('مخصصة ولم تُستلم', d.not_picked, 'مضى موعد البداية ولم يُسجّل الاستلام: ألغِ الطلب لتحرير المركبة إن لم يعد مطلوبًا.')}
      {table('تنتظر قرار مدير الإدارة', d.waiting, 'أكثر من 4 ساعات، أو المشوار خلال 24 ساعة. المكتب يستطيع القرار أيضًا.')}
      {table('خارج ساعات العمل', d.after_hours, 'مشاوير خلال 7 أيام تبدأ أو تنتهي خارج ساعات العمل، أو تمتد لأكثر من يوم.')}
    </div>
  );
}

interface Who { trip: VReq | null; shift: { driver_name: string; started_at: string; ended_at: string | null } | null }
function WhoView({ onOpen }: { onOpen: (id: string) => void }) {
  const assets = useAssets();
  const act = useAction();
  const { f, bind } = useForm({ asset_id: '', at: '' });
  const [res, setRes] = useState<Who | null>(null);
  return (
    <section className="card stack">
      <p className="muted" style={{ margin: 0 }}>مخالفة مرورية أو ضرر: اختر المركبة ووقت الحادثة لمعرفة من كان معه المفتاح، من سجل الاستلام والإرجاع ثم ورديات السائقين.</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => setRes(await api<Who>(`/internal/who?asset_id=${f.asset_id}&at=${encodeURIComponent(new Date(`${f.at}:00+03:00`).toISOString())}`))); }}>
        <div className="form-2">
          <label className="field">المركبة<select {...bind('asset_id')} required><option value="">اختر</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
          <label className="field">وقت المخالفة<input type="datetime-local" {...bind('at')} required /></label>
        </div>
        <ErrorBox error={act.error} />
        <div className="row"><button className="primary" disabled={act.busy}>بحث</button></div>
      </form>
      {res && (res.trip ? (
        <div className="alert ok" data-testid="who-result">
          المشوار <button type="button" className="link num" onClick={() => onOpen(res.trip!.id)}>{res.trip.ref}</button>: {res.trip.requester_name} ({res.trip.department_name}){res.trip.driver_name && <>، السائق {res.trip.driver_name}</>}.{' '}
          <span className="num">{dt(res.trip.out_at ?? res.trip.starts_at)} – {res.trip.back_at ? dt(res.trip.back_at) : 'لم تُرجع'}</span>
        </div>
      ) : res.shift ? (
        <div className="alert ok" data-testid="who-result">وردية السائق {res.shift.driver_name} على المركبة منذ <span className="num">{dt(res.shift.started_at)}</span>.</div>
      ) : <div className="alert warn" data-testid="who-result">لا يوجد مشوار ولا وردية تغطي هذا الوقت.</div>)}
    </section>
  );
}

interface Cost { department_id: string; department_name: string; cost_center: string | null; trips: number; km: number; hours: number; distance_cost: string; expenses: string; total: string }
function CostsView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const c = useLoad(() => api<{ data: Cost[] }>(`/internal/costs?from=${from}&to=${to}`), [from, to]);
  const rows = c.data?.data ?? [];
  const sum = (k: 'distance_cost' | 'expenses' | 'total') => rows.reduce((s, r) => s + Number(r[k]), 0);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={c.error} />
      {c.data && (rows.length === 0 ? <Empty>لا توجد مشاوير مُرجعة في الفترة</Empty> : (
        <div className="tbl-wrap"><table data-testid="costs">
          <thead><tr><th>الإدارة</th><th>مركز التكلفة</th><th>المشاوير</th><th>المسافة</th><th>ساعات السائق</th><th>المسافة والسائق</th><th>المصروفات</th><th>الإجمالي</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.department_id}><td>{r.department_name}</td><td className="num">{r.cost_center ?? '—'}</td><td className="num">{r.trips}</td><td>{km(r.km)}</td>
              <td className="num">{r.hours}</td><td className="num">{money(r.distance_cost)}</td><td className="num">{money(r.expenses)}</td><td className="num"><strong>{money(r.total)}</strong></td></tr>
          ))}</tbody>
          <tfoot><tr><th colSpan={5}>الإجمالي</th><th className="num">{money(sum('distance_cost'))}</th><th className="num">{money(sum('expenses'))}</th><th className="num">{money(sum('total'))}</th></tr></tfoot>
        </table></div>
      ))}
      <p className="muted" style={{ margin: 0 }}>المسافة × سعر الكيلومتر، وساعات السائق × سعر الساعة (للمشاوير مع سائق)، والمصروفات المعتمدة على المركبة أثناء المشوار (وقود، مواقف…). الأسعار من الإعدادات.</p>
    </section>
  );
}

interface Member { id: string; user_id: string; display_name: string | null; phone: string; role: string; department_id: string | null }
function DepartmentsView() {
  const me = useMe();
  const d = useLoad(() => api<{ data: Dept[] }>('/internal/departments'));
  const members = useLoad(() => (can(me, 'members:read') || can(me, 'members:write') ? api<{ data: Member[] }>('/members').then((r) => r.data) : Promise.resolve([] as Member[])));
  const act = useAction();
  const writer = can(me, 'org:write');
  const { f, bind, setF } = useForm({ name: '', cost_center: '', manager_user_id: '' });
  const memberName = (m: Member) => m.display_name ?? m.phone;
  const setManager = (dep: Dept, user: string) => act.run(async () => { await api(`/internal/departments/${dep.id}`, { method: 'PATCH', body: { manager_user_id: user || null } }); await d.reload(); });
  const setDept = (m: Member, dep: string) => act.run(async () => { await api(`/members/${m.id}`, { method: 'PATCH', body: { department_id: dep || null } }); await members.reload(); await d.reload(); });
  const depts = d.data?.data ?? [];
  return (
    <div className="stack">
      <section className="card stack">
        <h2>الإدارات ومديروها</h2>
        <ErrorBox error={d.error ?? act.error} />
        {depts.length === 0 ? <Empty>لا توجد إدارات بعد</Empty> : (
          <div className="tbl-wrap"><table data-testid="departments">
            <thead><tr><th>الإدارة</th><th>مركز التكلفة</th><th>المدير (يوافق على الطلبات)</th><th>الموظفون</th></tr></thead>
            <tbody>{depts.map((x) => (
              <tr key={x.id}><td>{x.name}{!x.active && <> <Badge>موقوفة</Badge></>}</td><td className="num">{x.cost_center ?? '—'}</td>
                <td>{writer && members.data?.length ? (
                  <select value={x.manager_user_id ?? ''} onChange={(e) => void setManager(x, e.target.value)} aria-label={`مدير ${x.name}`}>
                    <option value="">بلا مدير (يقرر المكتب)</option>{members.data.map((m) => <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>)}
                  </select>) : x.manager_name ?? '—'}</td>
                <td className="num">{x.members}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {writer && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('/internal/departments', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, name: f.name, ...clean({ cost_center: f.cost_center, manager_user_id: f.manager_user_id }) } }); setF({ name: '', cost_center: '', manager_user_id: '' }); await d.reload(); }); }}>
            <div className="form-2">
              <label className="field">اسم الإدارة<input {...bind('name')} required maxLength={120} /></label>
              <label className="field">مركز التكلفة<input {...bind('cost_center')} className="num" pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,29}" placeholder="CC-100" /></label>
              <label className="field">المدير<select {...bind('manager_user_id')}><option value="">—</option>{members.data?.map((m) => <option key={m.user_id} value={m.user_id}>{memberName(m)}</option>)}</select></label>
            </div>
            <div className="row"><button className="primary" disabled={act.busy}>إضافة إدارة</button></div>
          </form>
        )}
      </section>
      {can(me, 'members:write') && members.data && (
        <section className="card stack">
          <h2>إدارة كل موظف</h2>
          <p className="muted" style={{ margin: 0 }}>أضف الموظفين من الإعدادات ← المستخدمون بدور «موظف»، ثم اختر إدارتهم هنا. طلباتهم تُحمَّل على إدارتهم.</p>
          <div className="tbl-wrap"><table data-testid="member-depts">
            <thead><tr><th>المستخدم</th><th>الدور</th><th>الإدارة</th></tr></thead>
            <tbody>{members.data.filter((m) => m.role !== 'customer').map((m) => (
              <tr key={m.id}><td>{memberName(m)}</td><td>{ROLE[m.role] ?? m.role}</td>
                <td><select value={m.department_id ?? ''} onChange={(e) => void setDept(m, e.target.value)} aria-label={`إدارة ${memberName(m)}`}>
                  <option value="">—</option>{depts.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}

interface Settings { require_approval: boolean; auto_approve_max_hours: number | null; cost_per_km: string; driver_cost_per_hour: string; return_grace_minutes: number; work_start: string; work_end: string }
function SettingsView() {
  const me = useMe();
  const [le, setLe] = useState(me.legal_entities[0]?.id ?? '');
  const s = useLoad(() => api<Settings>(`/internal/settings?legal_entity_id=${le}`), [le]);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState<Settings | null>(null);
  const cur = f ?? s.data;
  const writer = can(me, 'org:write');
  if (!cur) return <ErrorBox error={s.error} />;
  const set = (p: Partial<Settings>) => { setF({ ...cur, ...p }); setSaved(false); };
  return (
    <section className="card">
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { setF(await api<Settings>('/internal/settings', { method: 'PUT', body: { legal_entity_id: le, ...cur } })); setSaved(true); }); }}>
        {me.legal_entities.length > 1 && <label className="field">الشركة القانونية<select value={le} onChange={(e) => { setLe(e.target.value); setF(null); }}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        <ErrorBox error={act.error} />
        {saved && <div className="alert ok">حُفظت الإعدادات</div>}
        <label className="row"><input type="checkbox" style={{ width: 'auto' }} disabled={!writer} checked={cur.require_approval} onChange={(e) => set({ require_approval: e.target.checked })} /> الطلب يحتاج موافقة مدير الإدارة</label>
        <div className="form-2">
          <label className="field">اعتماد تلقائي للمشوار حتى (ساعات)<input type="number" className="num" min={1} max={72} disabled={!writer || !cur.require_approval} value={cur.auto_approve_max_hours ?? ''} placeholder="لا" onChange={(e) => set({ auto_approve_max_hours: e.target.value ? Number(e.target.value) : null })} /></label>
          <label className="field">سعر الكيلومتر (د.ك)<input className="num" inputMode="decimal" pattern="\d{1,5}(\.\d{1,3})?" disabled={!writer} value={cur.cost_per_km} onChange={(e) => set({ cost_per_km: e.target.value })} required /></label>
          <label className="field">سعر ساعة السائق (د.ك)<input className="num" inputMode="decimal" pattern="\d{1,5}(\.\d{1,3})?" disabled={!writer} value={cur.driver_cost_per_hour} onChange={(e) => set({ driver_cost_per_hour: e.target.value })} required /></label>
          <label className="field">مهلة الإرجاع قبل التنبيه (دقيقة)<input type="number" className="num" min={0} max={600} disabled={!writer} value={cur.return_grace_minutes} onChange={(e) => set({ return_grace_minutes: Number(e.target.value) })} required /></label>
          <label className="field">بداية الدوام<input type="time" disabled={!writer} value={cur.work_start} onChange={(e) => set({ work_start: e.target.value })} required /></label>
          <label className="field">نهاية الدوام<input type="time" disabled={!writer} value={cur.work_end} onChange={(e) => set({ work_end: e.target.value })} required /></label>
        </div>
        <p className="muted" style={{ margin: 0 }}>طلب مدير الإدارة نفسه لا يحتاج موافقة. الأسعار لتحميل التكلفة داخليًا على الإدارات، والقيم الافتراضية تقديرية [تخمين] تُضبط مع الشركة.</p>
        {writer && <div className="row"><button className="primary" disabled={act.busy}>حفظ</button></div>}
      </form>
    </section>
  );
}
