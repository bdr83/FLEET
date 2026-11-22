'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ConcreteSite, day, DOC_PROBLEM, DOC_TYPE, ELIGIBILITY, hours, REQUEST_STATE, siteLine, TASK_STATUS, time, todayKw, WEEKDAYS, WORKER_DOC_TYPES, workDaysLine } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Eligibility { status: 'ok' | 'warn' | 'blocked'; issues: { doc_type: string; problem: string; expires_on?: string | null }[] }
interface Req {
  id: string; ref: string; legal_entity_id: string; customer_id: string; customer_name: string; site: ConcreteSite; worker_kind: string; with_vehicle: boolean; headcount: number;
  starts_on: string; ends_on: string; shift_start: string; shift_end: string; work_days: number[]; bill_unit: 'hour' | 'day'; notes: string | null; state: string; version: number;
  cancel_reason: string | null; placed_now: number;
}
interface Placement { id: string; seq: number; worker_id: string; worker_name: string; asset_id: string | null; plate_no: string | null; starts_on: string; ends_on: string; active: boolean; end_reason: string | null; eligibility: Eligibility }
interface Shift {
  task_id: string; placement_id: string; work_date: string; status: string; ref: string; window_from: string; window_to: string; worker_id: string | null; worker_name: string | null;
  plate_no: string | null; checkin_distance_m: number | null; absent_at: string | null; replaced_at: string | null; check_in: string | null; check_out: string | null;
  hours: number | null; days: number | null; dispute_id: string | null; dispute_reason: string | null; request_id: string; request_ref: string;
}
interface ReqDetail extends Req { placements: Placement[]; shifts: Shift[] }
interface Cell { date: string; required: number; covered: number; checked_in: number; absent: number; replaced: number }
interface Board {
  from: string; to: string; dates: string[]; rows: (Req & { days: Cell[] })[];
  today: { active_requests: number; required: number; covered: number; checked_in: number; absent: number; pending_approval: number; open_disputes: number };
}
interface Candidate { id: string; display_name: string; busy: { request_ref: string; starts_on: string; ends_on: string } | null; eligibility: Eligibility }
type Tab = 'board' | 'timesheet' | 'exceptions' | 'settings';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const shortDay = (d: string) => `${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
const issuesLine = (e: Eligibility) => e.issues.map((i) => `${DOC_TYPE[i.doc_type] ?? i.doc_type}: ${DOC_PROBLEM[i.problem] ?? i.problem}${i.expires_on ? ` ${day(i.expires_on)}` : ''}`).join('، ');

/** Driver supply (sector 14): coverage of customers' supply requests per day, placements, day-shifts, timesheet approval, exceptions and settings. */
export default function StaffingPage() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('board');
  const [from, setFrom] = useState(todayKw());
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const board = useLoad(() => api<Board>(`/staffing/board?from=${from}&days=7`), [from]);
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>لوحة الإسناد</h1>
        <div className="row">
          {tab === 'board' && <>
            <button className="small" onClick={() => setFrom(addDays(from, -7))} aria-label="الأسبوع السابق">›</button>
            <input type="date" aria-label="من يوم" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <button className="small" onClick={() => setFrom(addDays(from, 7))} aria-label="الأسبوع التالي">‹</button>
          </>}
          {can(me, 'tasks:write') && <button className="primary" onClick={() => setCreating(true)}>طلب توريد جديد</button>}
        </div>
      </div>
      <Tabs tabs={[['board', 'التغطية'], ['timesheet', 'كشف الساعات'], ['exceptions', 'الاستثناءات'], ['settings', 'الإعدادات']]} value={tab} onChange={setTab} />
      {tab === 'board' && <CoverageView board={board.data} error={board.error} onOpen={setOpen} />}
      {tab === 'timesheet' && <TimesheetView />}
      {tab === 'exceptions' && <ExceptionsView onOpen={setOpen} />}
      {tab === 'settings' && <SettingsView />}
      {creating && <NewRequest onClose={() => setCreating(false)} onDone={(r) => { setCreating(false); setOpen(r.id); void board.reload(); }} />}
      {open && <RequestModal id={open} onClose={() => setOpen(null)} onChange={() => void board.reload()} />}
    </div>
  );
}

function CoverageView({ board, error, onOpen }: { board: Board | null; error: string | null; onOpen: (id: string) => void }) {
  if (!board) return <ErrorBox error={error} />;
  const t = board.today;
  const short = t.required - t.covered;
  return (
    <>
      <div className="grid g4">
        <Kpi label="طلبات سارية" value={t.active_requests} />
        <Kpi label={`مغطى في ${shortDay(board.from)}`} value={`${t.covered} / ${t.required}`} tone={short > 0 ? 'danger' : t.required ? 'success' : undefined} />
        <Kpi label="سجّلوا الحضور" value={`${t.checked_in} / ${t.covered}`} tone={t.checked_in < t.covered ? 'warning' : undefined} />
        <Kpi label="أيام بانتظار اعتماد العميل" value={t.pending_approval} tone={t.open_disputes ? 'warning' : undefined} />
      </div>
      <section className="card stack">
        <h2>تغطية الطلبات</h2>
        {board.rows.length === 0 ? <Empty>لا توجد طلبات سارية في هذا الأسبوع</Empty> : (
          <div className="tbl-wrap"><table className="coverage" data-testid="coverage">
            <thead><tr><th>الطلب</th>{board.dates.map((d) => <th key={d} className="num">{shortDay(d)}</th>)}</tr></thead>
            <tbody>{board.rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <button type="button" className="link" onClick={() => onOpen(r.id)} aria-label={`طلب التوريد ${r.ref}`}><strong className="num">{r.ref}</strong></button> <Tone map={REQUEST_STATE} value={r.state} />
                  <div className="muted">{r.customer_name} · <span className="num">{r.shift_start}–{r.shift_end}</span> · {r.headcount} {r.worker_kind === 'courier' ? 'مندوب' : 'سائق'}</div>
                </td>
                {r.days.map((c) => {
                  const cls = !c.required ? 'off' : c.covered < c.required ? 'short' : c.checked_in >= c.required ? 'in' : 'ok';
                  return (
                    <td key={c.date} className={`cov ${cls}`} title={c.required ? `مطلوب ${c.required}، مغطى ${c.covered}، حضر ${c.checked_in}${c.absent ? `، غائب ${c.absent}` : ''}${c.replaced ? `، بديل ${c.replaced}` : ''}` : 'ليس يوم عمل'}>
                      {c.required ? <span className="num">{c.covered}/{c.required}</span> : '·'}
                      {c.absent > 0 && <span className="cov-flag">غ</span>}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="row muted g-legend">
          <span><i className="g-dot t-danger" /> نقص في التغطية</span><span><i className="g-dot t-info" /> مغطى</span><span><i className="g-dot t-success" /> الكل سجّل الحضور</span><span>غ = غياب</span>
        </div>
      </section>
    </>
  );
}

function RequestModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const me = useMe();
  const r = useLoad(() => api<ReqDetail>(`/staffing/requests/${id}`), [id]);
  const act = useAction();
  const [mode, setMode] = useState<'place' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [replacing, setReplacing] = useState<Shift | null>(null);
  const p = r.data;
  const refresh = async () => { await r.reload(); onChange(); };
  const endPlacement = (pl: Placement) => {
    const why = window.prompt('سبب إنهاء التعيين؟');
    if (!why) return;
    void act.run(async () => { await api(`/staffing/placements/${pl.id}/end`, { method: 'POST', body: { reason: why } }); await refresh(); });
  };
  const absent = (s: Shift) => act.run(async () => { await api(`/staffing/shifts/${s.task_id}/absent`, { method: 'POST', body: { reason: 'غياب بلا بديل' } }); await refresh(); });
  const writer = can(me, 'tasks:write'), assigner = can(me, 'tasks:assign');
  return (
    <Modal title={p ? `طلب التوريد ${p.ref}` : 'طلب التوريد'} onClose={onClose}>
      <div className="stack pour-modal">
        <ErrorBox error={r.error ?? act.error} />
        {p && (
          <>
            <div className="row"><Tone map={REQUEST_STATE} value={p.state} />{p.with_vehicle && <Badge tone="info">مع مركبة</Badge>}<Badge>{p.bill_unit === 'hour' ? 'فوترة بالساعة' : 'فوترة باليوم'}</Badge></div>
            <dl className="dl">
              <dt>العميل</dt><dd>{p.customer_name}</dd>
              <dt>الموقع</dt><dd>{siteLine(p.site)}{p.site.lat === undefined && <> <Badge tone="warning">بلا دبوس: لا يُقاس بُعد الحضور</Badge></>}{p.site.contact_name && <span className="muted"> · {p.site.contact_name} <span className="num">{p.site.contact_phone}</span></span>}</dd>
              <dt>العدد</dt><dd><span className="num">{p.placed_now} / {p.headcount}</span> {p.worker_kind === 'courier' ? 'مندوب' : 'سائق'} معيّن الآن</dd>
              <dt>الفترة</dt><dd><span className="num">{day(p.starts_on)} – {day(p.ends_on)}</span> · {workDaysLine(p.work_days)} · <span className="num">{p.shift_start}–{p.shift_end}</span></dd>
              {p.notes && <><dt>ملاحظات</dt><dd>{p.notes}</dd></>}
              {p.cancel_reason && <><dt>سبب الإلغاء</dt><dd>{p.cancel_reason}</dd></>}
            </dl>
            <h3 style={{ margin: 0 }}>التعيينات</h3>
            {p.placements.length === 0 ? <Empty>لم يُعيّن أحد بعد</Empty> : (
              <div className="tbl-wrap"><table data-testid="placements">
                <thead><tr><th>#</th><th>السائق</th><th>المركبة</th><th>الفترة</th><th>المستندات</th><th></th></tr></thead>
                <tbody>{p.placements.map((pl) => (
                  <tr key={pl.id} className={pl.active ? '' : 'muted'}>
                    <td className="num">{pl.seq}</td><td>{pl.worker_name}</td><td className="num">{pl.plate_no ?? '—'}</td>
                    <td className="num">{day(pl.starts_on)} – {day(pl.ends_on)}{!pl.active && <div className="muted">أُزيل: {pl.end_reason}</div>}{pl.active && pl.end_reason && <div className="muted">أُنهي: {pl.end_reason}</div>}</td>
                    <td><Tone map={ELIGIBILITY} value={pl.eligibility.status} />{pl.eligibility.issues.length > 0 && <div className="muted">{issuesLine(pl.eligibility)}</div>}</td>
                    <td>{pl.active && assigner && p.state !== 'canceled' && pl.ends_on >= todayKw() && <button className="small" disabled={act.busy} onClick={() => endPlacement(pl)}>إنهاء</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <h3 style={{ margin: 0 }}>المناوبات (أسبوع قبل وبعد اليوم)</h3>
            {p.shifts.length === 0 ? <Empty>لا مناوبات في هذه الفترة</Empty> : (
              <div className="tbl-wrap"><table data-testid="shifts">
                <thead><tr><th>اليوم</th><th>السائق</th><th>الحالة</th><th>الحضور</th><th>الانصراف</th><th>{p.bill_unit === 'hour' ? 'الساعات' : 'الأيام'}</th><th></th></tr></thead>
                <tbody>{p.shifts.map((s) => (
                  <tr key={s.task_id}>
                    <td><Link href={`/tasks/${s.task_id}`} className="num">{shortDay(s.work_date)}</Link></td>
                    <td>{s.worker_name ?? <Badge tone="danger">غير مغطى</Badge>}{s.replaced_at && <div className="muted">بديل</div>}</td>
                    <td><Tone map={TASK_STATUS} value={s.status} />{s.absent_at && <div className="muted">غياب</div>}{s.dispute_id && <div><Badge tone="warning">اعتراض</Badge></div>}</td>
                    <td className="num">{time(s.check_in)}{s.checkin_distance_m !== null && s.checkin_distance_m > 300 && <div className="muted">على بُعد {s.checkin_distance_m} م</div>}</td>
                    <td className="num">{time(s.check_out)}</td>
                    <td>{p.bill_unit === 'hour' ? hours(s.hours) : s.days ?? '—'}</td>
                    <td>{assigner && ['ready', 'assigned', 'accepted'].includes(s.status) && (
                      <div className="row">
                        <button className="small" disabled={act.busy} onClick={() => setReplacing(s)}>بديل</button>
                        {s.worker_id && writer && <button className="small" disabled={act.busy} onClick={() => void absent(s)}>غياب</button>}
                      </div>
                    )}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {replacing && <ReplaceForm req={p} shift={replacing} onClose={() => setReplacing(null)} onDone={async () => { setReplacing(null); await refresh(); }} />}
            {p.state !== 'canceled' && p.state !== 'ended' && (mode === null ? (
              <div className="row">
                {assigner && <button className="primary" disabled={act.busy} onClick={() => setMode('place')}>تعيين سائق</button>}
                {writer && <button className="danger" disabled={act.busy} onClick={() => setMode('cancel')}>إلغاء الطلب</button>}
              </div>
            ) : mode === 'place' ? (
              <PlaceForm req={p} onClose={() => setMode(null)} onDone={async () => { setMode(null); await refresh(); }} />
            ) : (
              <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { r.setData(await api<ReqDetail>(`/staffing/requests/${id}/cancel`, { method: 'POST', body: { version: p.version, reason } })); setMode(null); onChange(); }); }}>
                <label className="field">سبب الإلغاء<input name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} /></label>
                <p className="muted" style={{ margin: 0 }}>تُلغى المناوبات القادمة التي لم تبدأ، وتنتهي التعيينات اليوم. الأيام المنجزة تبقى للفوترة.</p>
                <div className="row"><button className="danger" disabled={act.busy}>تأكيد الإلغاء</button><button type="button" onClick={() => setMode(null)}>رجوع</button></div>
              </form>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

function useCandidates(reqId: string) {
  return useLoad(() => api<{ from: string; to: string; data: Candidate[] }>(`/staffing/requests/${reqId}/candidates`), [reqId]);
}
function useVehicles(on: boolean) {
  const me = useMe();
  return useLoad(() => (on && can(me, 'fleet:read') ? api<{ data: { id: string; plate_no: string | null; status: string }[] }>('/assets').then((r) => r.data.filter((a) => a.status !== 'retired' && a.status !== 'out_of_service')) : Promise.resolve([])));
}
const candidateLabel = (c: Candidate) => `${c.display_name} · ${ELIGIBILITY[c.eligibility.status].label}${c.busy ? ` · معيّن على ${c.busy.request_ref}` : ''}`;

function PlaceForm({ req, onClose, onDone }: { req: ReqDetail; onClose: () => void; onDone: () => void }) {
  const cands = useCandidates(req.id);
  const vehicles = useVehicles(req.with_vehicle);
  const { f, bind } = useForm({ worker_id: '', asset_id: '', starts_on: '', ends_on: req.ends_on });
  const act = useAction();
  const pick = cands.data?.data.find((c) => c.id === f.worker_id);
  return (
    <form className="form card" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/staffing/requests/${req.id}/placements`, { method: 'POST', body: { worker_id: f.worker_id, ...clean({ asset_id: f.asset_id, starts_on: f.starts_on, ends_on: f.ends_on }) } }); onDone(); }); }}>
      <ErrorBox error={cands.error ?? act.error} />
      <div className="form-2">
        <label className="field">السائق<select {...bind('worker_id')} required>
          <option value="">اختر</option>
          {cands.data?.data.map((c) => <option key={c.id} value={c.id} disabled={c.eligibility.status === 'blocked' || !!c.busy}>{candidateLabel(c)}</option>)}
        </select></label>
        {req.with_vehicle && <label className="field">المركبة<select {...bind('asset_id')} required><option value="">اختر</option>{vehicles.data?.map((v) => <option key={v.id} value={v.id}>{v.plate_no}</option>)}</select></label>}
        <label className="field">من<input type="date" {...bind('starts_on')} min={cands.data?.from} max={req.ends_on} placeholder={cands.data?.from} /></label>
        <label className="field">إلى<input type="date" {...bind('ends_on')} min={cands.data?.from} max={req.ends_on} /></label>
      </div>
      {pick && pick.eligibility.issues.length > 0 && <div className={`alert ${pick.eligibility.status === 'blocked' ? 'err' : 'warn'}`}>{issuesLine(pick.eligibility)}</div>}
      {cands.data && cands.data.data.length === 0 && <p className="muted" style={{ margin: 0 }}>لا يوجد {req.worker_kind === 'courier' ? 'مندوبون' : 'سائقون'} نشطون في هذه الشركة.</p>}
      <p className="muted" style={{ margin: 0 }}>تُنشأ مناوبة يومية لكل يوم عمل (حتى 93 يومًا مقدمًا) وتظهر للسائق في التطبيق قبل موعدها بيوم ونصف.</p>
      <div className="row"><button className="primary" disabled={act.busy || !f.worker_id}>تعيين وإنشاء المناوبات</button><button type="button" onClick={onClose}>رجوع</button></div>
    </form>
  );
}

function ReplaceForm({ req, shift, onClose, onDone }: { req: ReqDetail; shift: Shift; onClose: () => void; onDone: () => void }) {
  const cands = useCandidates(req.id);
  const [w, setW] = useState('');
  const act = useAction();
  return (
    <form className="form card" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/staffing/shifts/${shift.task_id}/replace`, { method: 'POST', body: { worker_id: w } }); onDone(); }); }}>
      <strong>بديل ليوم {shortDay(shift.work_date)}{shift.worker_name && <> بدل {shift.worker_name}</>}</strong>
      <ErrorBox error={cands.error ?? act.error} />
      <label className="field">السائق البديل<select value={w} onChange={(e) => setW(e.target.value)} required aria-label="السائق البديل">
        <option value="">اختر</option>
        {cands.data?.data.filter((c) => c.id !== shift.worker_id).map((c) => <option key={c.id} value={c.id} disabled={c.eligibility.status === 'blocked'}>{candidateLabel(c)}</option>)}
      </select></label>
      <div className="row"><button className="primary" disabled={act.busy || !w}>إسناد البديل</button><button type="button" onClick={onClose}>رجوع</button></div>
    </form>
  );
}

function NewRequest({ onClose, onDone }: { onClose: () => void; onDone: (r: ReqDetail) => void }) {
  const me = useMe();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string; legal_entity_id: string }[] }>('/customers').then((r) => r.data.filter((c) => c.status === 'active')).catch(() => []));
  const { f, bind, check } = useForm({
    legal_entity_id: me.legal_entities[0]?.id ?? '', ref: '', customer_id: '', worker_kind: 'driver', with_vehicle: false, headcount: '1', starts_on: todayKw(), ends_on: addDays(todayKw(), 29),
    shift_start: '08:00', shift_end: '17:00', bill_unit: 'hour', name: '', area: '', block: '', street: '', lat: '', lng: '', contact_name: '', contact_phone: '', notes: '',
  });
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const act = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const site = clean({ name: f.name, area: f.area, block: f.block, street: f.street, contact_name: f.contact_name, contact_phone: f.contact_phone, ...(f.lat && f.lng ? { lat: Number(f.lat), lng: Number(f.lng) } : {}) });
      onDone(await api<ReqDetail>('/staffing/requests', { method: 'POST', body: {
        legal_entity_id: f.legal_entity_id, ref: f.ref, customer_id: f.customer_id, worker_kind: f.worker_kind, with_vehicle: f.with_vehicle, headcount: Number(f.headcount),
        starts_on: f.starts_on, ends_on: f.ends_on, shift_start: f.shift_start, shift_end: f.shift_end, work_days: days, bill_unit: f.bill_unit, site, ...clean({ notes: f.notes }),
      } }));
    });
  };
  return (
    <Modal title="طلب توريد جديد" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={act.error} />
        <div className="form-2">
          <label className="field">رقم الطلب<input {...bind('ref')} className="num" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,29}" placeholder="SR-1001" /></label>
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option>{customers.data?.filter((c) => c.legal_entity_id === f.legal_entity_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">النوع<select {...bind('worker_kind')}><option value="driver">سائق</option><option value="courier">مندوب توصيل</option></select></label>
          <label className="field">العدد<input {...bind('headcount')} type="number" min={1} max={500} className="num" required /></label>
          <label className="field">من<input type="date" {...bind('starts_on')} required /></label>
          <label className="field">إلى<input type="date" {...bind('ends_on')} required /></label>
          <label className="field">بداية المناوبة<input type="time" {...bind('shift_start')} required /></label>
          <label className="field">نهاية المناوبة<input type="time" {...bind('shift_end')} required /></label>
          <label className="field">الفوترة<select {...bind('bill_unit')}><option value="hour">بالساعة</option><option value="day">باليوم</option></select></label>
          <label className="row" style={{ alignSelf: 'end' }}><input {...check('with_vehicle')} /> مع مركبة من أسطولنا</label>
        </div>
        <fieldset className="row weekdays"><legend>أيام العمل</legend>
          {WEEKDAYS.map((w, i) => <label key={w} className="row"><input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays(e.target.checked ? [...days, i].sort() : days.filter((x) => x !== i))} /> {w}</label>)}
        </fieldset>
        <h3 style={{ margin: '8px 0 0' }}>موقع العميل</h3>
        <div className="form-2">
          <label className="field">اسم الموقع<input {...bind('name')} maxLength={120} /></label>
          <label className="field">المنطقة<input {...bind('area')} maxLength={120} /></label>
          <label className="field">القطعة<input {...bind('block')} maxLength={20} /></label>
          <label className="field">الشارع<input {...bind('street')} maxLength={120} /></label>
          <label className="field">المسؤول لدى العميل<input {...bind('contact_name')} maxLength={120} /></label>
          <label className="field">جواله<input {...bind('contact_phone')} className="num" inputMode="tel" /></label>
          <label className="field">خط العرض<input {...bind('lat')} className="num" inputMode="decimal" placeholder="29.30" /></label>
          <label className="field">خط الطول<input {...bind('lng')} className="num" inputMode="decimal" placeholder="47.93" /></label>
        </div>
        <p className="muted" style={{ margin: 0 }}>نهاية قبل البداية تعني مناوبة ليلية تنتهي في اليوم التالي. بالإحداثيات يُقاس بُعد السائق عن الموقع عند تسجيل الحضور.</p>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        <div className="row"><button className="primary" disabled={act.busy || days.length === 0}>إنشاء الطلب</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}

function TimesheetView() {
  const me = useMe();
  const [from, setFrom] = useState(`${todayKw().slice(0, 8)}01`);
  const [to, setTo] = useState(todayKw());
  const [sel, setSel] = useState<string[]>([]);
  const data = useLoad(() => api<{ data: Shift[] }>(`/staffing/timesheet?from=${from}&to=${to}`).then((r) => r.data), [from, to]);
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  const rows = (data.data ?? []).filter((s) => !['canceled', 'ready', 'assigned'].includes(s.status));
  const approvable = rows.filter((s) => s.status === 'completed' && !s.dispute_id);
  const total = rows.filter((s) => ['completed', 'reviewed', 'invoiced'].includes(s.status)).reduce((a, s) => a + (s.hours ?? 0), 0);
  const approve = () => act.run(async () => {
    const r = await api<{ approved: string[]; skipped: { task_id: string; reason: string }[] }>('/staffing/approve', { method: 'POST', body: { task_ids: sel } });
    setNote(`اعتُمد ${r.approved.length} يوم${r.skipped.length ? `، وتُرك ${r.skipped.length}` : ''}`); setSel([]); await data.reload();
  });
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <Kpi label="ساعات منجزة" value={hours(Math.round(total * 100) / 100)} />
      </div>
      <p className="muted" style={{ margin: 0 }}>يعتمد العميل الساعات من بوابته، أو يعتمدها المكتب نيابة عنه (مثلًا بموافقة بالبريد). الأيام المعتمدة فقط تدخل الفاتورة، والمعترض عليها تنتظر الحل.</p>
      <ErrorBox error={data.error ?? act.error} />
      {note && <div className="alert ok">{note}</div>}
      {data.data && rows.length === 0 ? <Empty>لا توجد أيام عمل في الفترة</Empty> : (
        <div className="tbl-wrap"><table data-testid="timesheet">
          <thead><tr><th><input type="checkbox" aria-label="تحديد الكل" checked={sel.length > 0 && sel.length === approvable.length} onChange={(e) => setSel(e.target.checked ? approvable.map((s) => s.task_id) : [])} /></th>
            <th>اليوم</th><th>الطلب</th><th>السائق</th><th>الحضور</th><th>الانصراف</th><th>الساعات</th><th>الحالة</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.task_id}>
              <td>{s.status === 'completed' && !s.dispute_id && <input type="checkbox" aria-label={`اعتماد ${s.ref}`} checked={sel.includes(s.task_id)} onChange={(e) => setSel(e.target.checked ? [...sel, s.task_id] : sel.filter((x) => x !== s.task_id))} />}</td>
              <td className="num">{shortDay(s.work_date)}</td><td className="num">{s.request_ref}</td><td>{s.worker_name ?? '—'}</td>
              <td className="num">{time(s.check_in)}</td><td className="num">{time(s.check_out)}</td><td>{s.days ? `${s.days} يوم` : hours(s.hours)}</td>
              <td><Tone map={TASK_STATUS} value={s.status} />{s.dispute_id && <div><Badge tone="warning">اعتراض: {s.dispute_reason}</Badge></div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {can(me, 'tasks:write') && approvable.length > 0 && <div className="row"><button className="primary" disabled={act.busy || sel.length === 0} onClick={() => void approve()}>اعتماد المحدد ({sel.length})</button></div>}
    </section>
  );
}

interface ExShift extends Shift { customer_name?: string }
interface Ex {
  no_show: ExShift[]; uncovered: ExShift[]; far: ExShift[];
  docs: { placement_id: string; worker_name: string; request_ref: string; customer_name: string; ends_on: string; doc_type: string; expires_on: string }[];
  ending: Req[]; disputes: { id: string; task_id: string; reason: string; raised_at: string; hours_before: number | null; work_date: string; worker_name: string; request_ref: string; check_in: string | null; check_out: string | null }[];
}
function ExceptionsView({ onOpen }: { onOpen: (id: string) => void }) {
  const ex = useLoad(() => api<Ex>('/staffing/exceptions'));
  const [resolving, setResolving] = useState<Ex['disputes'][number] | null>(null);
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  const reqLink = (s: { request_id: string; request_ref: string }) => <button type="button" className="link num" onClick={() => onOpen(s.request_id)}>{s.request_ref}</button>;
  const table = (title: string, head: string[], rows: React.ReactNode[][], hint?: string) => (
    <section className="card">
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      {rows.length === 0 ? <Empty>لا يوجد</Empty> : (
        <div className="tbl-wrap"><table><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
      )}
    </section>
  );
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="لم يحضر بعد موعده" value={d.no_show.length} tone={d.no_show.length ? 'danger' : undefined} />
        <Kpi label="مناوبات قريبة بلا سائق" value={d.uncovered.length} tone={d.uncovered.length ? 'danger' : undefined} />
        <Kpi label="اعتراضات مفتوحة" value={d.disputes.length} tone={d.disputes.length ? 'warning' : undefined} />
        <Kpi label="مستندات تنتهي" value={d.docs.length} tone={d.docs.length ? 'warning' : undefined} />
      </div>
      {table('لم يسجّل الحضور', ['الطلب', 'السائق', 'الموعد'], d.no_show.map((s) => [reqLink(s), s.worker_name, <span key="t" className="num">{time(s.window_from)}</span>]),
        'بعد مهلة التأخير في الإعدادات. افتح الطلب لإسناد بديل أو تسجيل غياب.')}
      {table('مناوبات بلا سائق', ['الطلب', 'اليوم', 'الموعد'], d.uncovered.map((s) => [reqLink(s), <span key="d" className="num">{shortDay(s.work_date)}</span>, <span key="t" className="num">{time(s.window_from)}</span>]),
        'السائق المعيّن محجوز في مهمة أخرى بنفس الوقت أو أُلغي إسناده.')}
      {table('حضور بعيد عن الموقع', ['الطلب', 'السائق', 'اليوم', 'المسافة'], d.far.map((s) => [reqLink(s), s.worker_name, <span key="d" className="num">{shortDay(s.work_date)}</span>, <span key="m" className="num">{s.checkin_distance_m} م</span>]),
        'تنبيه للمراجعة لا منع: دقة GPS تختلف داخل المباني.')}
      {table('اعتراضات العملاء على الساعات', ['الطلب', 'السائق', 'اليوم', 'المسجّل', 'السبب', ''], d.disputes.map((x) => [
        <span key="r" className="num">{x.request_ref}</span>, x.worker_name, <span key="d" className="num">{shortDay(x.work_date)}</span>,
        <span key="h"><span className="num">{time(x.check_in)}–{time(x.check_out)}</span> · {hours(x.hours_before)}</span>, x.reason,
        <button key="b" className="small" onClick={() => setResolving(x)}>حل</button>]))}
      {table('مستندات تنتهي قبل نهاية التعيين أو خلال 30 يومًا', ['السائق', 'الطلب', 'المستند', 'ينتهي', 'نهاية التعيين'], d.docs.map((x) => [
        x.worker_name, <span key="r" className="num">{x.request_ref}</span>, DOC_TYPE[x.doc_type] ?? x.doc_type, <span key="e" className="num">{day(x.expires_on)}</span>, <span key="p" className="num">{day(x.ends_on)}</span>]))}
      {table('طلبات تنتهي خلال أسبوع', ['الطلب', 'العميل', 'ينتهي', 'المعيّنون'], d.ending.map((r) => [
        <button key="r" type="button" className="link num" onClick={() => onOpen(r.id)}>{r.ref}</button>, r.customer_name, <span key="e" className="num">{day(r.ends_on)}</span>, <span key="n" className="num">{r.placed_now}/{r.headcount}</span>]),
        'تواصل مع العميل للتجديد قبل الانتهاء.')}
      {resolving && <ResolveDispute d={resolving} onClose={() => setResolving(null)} onDone={() => { setResolving(null); void ex.reload(); }} />}
    </div>
  );
}

function ResolveDispute({ d, onClose, onDone }: { d: Ex['disputes'][number]; onClose: () => void; onDone: () => void }) {
  const { f, bind } = useForm({ resolution: '', hours: d.hours_before === null ? '' : String(d.hours_before) });
  const act = useAction();
  return (
    <Modal title={`اعتراض ${d.request_ref} · ${shortDay(d.work_date)}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/staffing/disputes/${d.id}/resolve`, { method: 'POST', body: { resolution: f.resolution, ...(f.hours !== '' ? { hours: Number(f.hours) } : {}) } }); onDone(); }); }}>
        <ErrorBox error={act.error} />
        <p style={{ margin: 0 }}>العميل: «{d.reason}». المسجّل من التطبيق <span className="num">{time(d.check_in)}–{time(d.check_out)}</span> ({hours(d.hours_before)}).</p>
        {d.hours_before !== null && <label className="field">الساعات المتفق عليها<input {...bind('hours')} className="num" inputMode="decimal" pattern="\d{1,2}(\.\d{1,2})?" /></label>}
        <label className="field">الحل<input {...bind('resolution')} required maxLength={500} placeholder="اتفقنا مع العميل على…" /></label>
        <p className="muted" style={{ margin: 0 }}>بعد الحل يعود اليوم لاعتماد العميل.</p>
        <div className="row"><button className="primary" disabled={act.busy}>حفظ الحل</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}

interface Settings { checkin_radius_m: number; late_grace_minutes: number; hour_rounding_minutes: number; doc_types: string[] }
function SettingsView() {
  const me = useMe();
  const [le, setLe] = useState(me.legal_entities[0]?.id ?? '');
  const s = useLoad(() => api<Settings>(`/staffing/settings?legal_entity_id=${le}`), [le]);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState<Settings | null>(null);
  const cur = f ?? s.data;
  const writer = can(me, 'org:write');
  if (!cur) return <ErrorBox error={s.error} />;
  const set = (p: Partial<Settings>) => { setF({ ...cur, ...p }); setSaved(false); };
  return (
    <section className="card">
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { setF(await api<Settings>('/staffing/settings', { method: 'PUT', body: { legal_entity_id: le, ...cur } })); setSaved(true); }); }}>
        {me.legal_entities.length > 1 && (
          <label className="field">الشركة القانونية<select value={le} onChange={(e) => { setLe(e.target.value); setF(null); }}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        )}
        <ErrorBox error={act.error} />
        {saved && <div className="alert ok">حُفظت الإعدادات</div>}
        <div className="form-2">
          <label className="field">نطاق موقع العميل للحضور (متر)<input type="number" className="num" min={50} max={5000} value={cur.checkin_radius_m} disabled={!writer} onChange={(e) => set({ checkin_radius_m: Number(e.target.value) })} required /></label>
          <label className="field">مهلة التأخير قبل التنبيه (دقيقة)<input type="number" className="num" min={0} max={240} value={cur.late_grace_minutes} disabled={!writer} onChange={(e) => set({ late_grace_minutes: Number(e.target.value) })} required /></label>
          <label className="field">تقريب الساعات<select value={cur.hour_rounding_minutes} disabled={!writer} onChange={(e) => set({ hour_rounding_minutes: Number(e.target.value) })}>
            {[1, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m === 1 ? 'بالدقيقة' : m === 60 ? 'بالساعة' : `كل ${m} دقيقة`}</option>)}
          </select></label>
        </div>
        <fieldset className="row weekdays"><legend>المستندات المطلوبة للأهلية</legend>
          {WORKER_DOC_TYPES.map((k) => <label key={k} className="row"><input type="checkbox" disabled={!writer} checked={cur.doc_types.includes(k)} onChange={(e) => set({ doc_types: e.target.checked ? [...cur.doc_types, k] : cur.doc_types.filter((x) => x !== k) })} /> {DOC_TYPE[k]}</label>)}
        </fieldset>
        <p className="muted" style={{ margin: 0 }}>سائق بمستند مفقود أو منتهٍ لا يُعيّن. مستند ينتهي خلال الفترة يظهر تنبيهًا للتجديد. القيم الافتراضية تقديرية [تخمين] وتُضبط مع الشركة التجريبية.</p>
        {writer && <div className="row"><button className="primary" disabled={act.busy}>حفظ</button></div>}
      </form>
    </section>
  );
}
