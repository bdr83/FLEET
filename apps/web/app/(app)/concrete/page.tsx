'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { ConcreteSite, dt, m3, MIXER_STATE, POUR_STATE, siteLine, STAGE, TASK_STATUS, time, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface LoadBrief { task_id: string; seq: number; status: string; stage: string | null; volume_m3: number; planned_arrival: string; window_from: string; window_to: string; batched_at: string | null; pour_end: string | null; worker_name: string | null; plate_no: string | null }
interface Pour {
  id: string; ref: string; legal_entity_id: string; customer_id: string | null; customer_name: string | null; site: ConcreteSite; mix_code: string; volume_m3: number; pour_rate_m3h: number;
  pump_required: boolean; pump_plate: string | null; scheduled_at: string; site_ready: boolean; notes: string | null; state: string; version: number; cancel_reason: string | null;
  totals: { loads: number; assigned: number; dispatched_m3: number; delivered_loads: number; poured_m3: number; returned_m3: number; wait_minutes: number };
  loads_brief: LoadBrief[];
}
interface Load extends LoadBrief { ticket_no: string; version: number; worker_id: string | null; asset_id: string | null; at_site: string | null; pour_start: string | null; poured_m3: number | null; returned_m3: number | null; signed_by: string | null; wait_minutes: number | null; age_minutes: number | null }
interface PourDetail extends Pour { loads: Load[]; plan: { spacing_minutes: number; trucks_needed: number; pour_minutes: number }; limits: { max_age_minutes: number; age_warn_minutes: number; free_wait_minutes: number } }
interface Mixer { asset_id: string; plate_no: string | null; capacity_m3: number | null; worker_id: string | null; worker_name: string | null; state: string; ticket_no: string | null; pour_ref: string | null; age_minutes: number | null; age_level: string | null }
interface Board { today: { scheduled_m3: number; poured_m3: number; returned_m3: number; avg_wait_minutes: number | null; pours: number }; counts: Record<string, number>; mixers: Mixer[] }
type Tab = 'schedule' | 'exceptions' | 'waiting' | 'settings';

const kwStart = (d: string) => `${d}T00:00:00+03:00`;
const nextDay = (d: string) => new Date(Date.parse(kwStart(d)) + 86_400_000).toISOString();

/** Pour schedule (sector 20): the day's pours on a time axis with their loads, the mixers board, exceptions, waiting report and settings. */
export default function ConcretePage() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('schedule');
  const [date, setDate] = useState(todayKw());
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const pours = useLoad(() => api<{ data: Pour[] }>(`/concrete/pours?from=${encodeURIComponent(kwStart(date))}&to=${encodeURIComponent(nextDay(date))}`).then((r) => r.data), [date]);
  const board = useLoad(() => api<Board>('/concrete/board'));
  const reload = () => { void pours.reload(); void board.reload(); };
  const tabs: [Tab, string][] = [['schedule', 'الجدول'], ['exceptions', 'الاستثناءات'], ...(can(me, 'reports:read') ? [['waiting', 'تقرير الانتظار'] as [Tab, string]] : []), ['settings', 'الإعدادات']];
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>جدول الصب</h1>
        <div className="row">
          {tab === 'schedule' && <input type="date" aria-label="اليوم" value={date} onChange={(e) => setDate(e.target.value)} />}
          {can(me, 'tasks:write') && <button className="primary" onClick={() => setCreating(true)}>طلب صب جديد</button>}
        </div>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'schedule' && (
        <>
          <BoardKpis board={board.data} />
          <div className="concrete-layout">
            <section className="card stack">
              <h2>صبّات اليوم</h2>
              <ErrorBox error={pours.error} />
              {pours.data && pours.data.length === 0 ? <Empty>لا توجد صبّات في هذا اليوم</Empty> : pours.data && <Gantt pours={pours.data} onOpen={setOpen} />}
            </section>
            <MixersPanel board={board.data} error={board.error} />
          </div>
        </>
      )}
      {tab === 'exceptions' && <ExceptionsView onOpen={setOpen} />}
      {tab === 'waiting' && <WaitingView />}
      {tab === 'settings' && <SettingsView />}
      {creating && <NewPour onClose={() => setCreating(false)} onDone={(p) => { setCreating(false); setDate(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait' }).format(new Date(p.scheduled_at))); setOpen(p.id); reload(); }} />}
      {open && <PourModal id={open} mixers={board.data?.mixers ?? []} onClose={() => setOpen(null)} onChange={reload} />}
    </div>
  );
}

function BoardKpis({ board }: { board: Board | null }) {
  if (!board) return null;
  const t = board.today;
  const busy = ['loading', 'on_road', 'waiting', 'pouring'].reduce((s, k) => s + (board.counts[k] ?? 0), 0);
  return (
    <div className="grid g4">
      <Kpi label="مجدول اليوم" value={m3(t.scheduled_m3)} />
      <Kpi label="مصبوب اليوم" value={m3(t.poured_m3)} tone="success" />
      <Kpi label="خلاطات عاملة / متاحة" value={`${busy} / ${board.counts.available ?? 0}`} />
      <Kpi label="متوسط الانتظار بالموقع" value={t.avg_wait_minutes === null ? '—' : `${t.avg_wait_minutes} د`} tone={(t.avg_wait_minutes ?? 0) > 30 ? 'warning' : undefined} />
    </div>
  );
}

const LOAD_TONE: Record<string, string> = { ready: 'info', assigned: 'info', accepted: 'primary', in_progress: 'warning', completed: 'success', reviewed: 'success', invoiced: 'success', failed: 'danger', canceled: 'muted' };

/** Time axis for the day: one row per pour, one block per load from loading at the plant to the truck's return. */
function Gantt({ pours, onOpen }: { pours: Pour[]; onOpen: (id: string) => void }) {
  const { start, end, hours } = useMemo(() => {
    const ts = pours.flatMap((p) => p.loads_brief.flatMap((l) => [Date.parse(l.window_from), Date.parse(l.window_to)])).filter(Number.isFinite);
    const h = 3_600_000;
    const s = Math.floor(Math.min(...ts, Date.parse(pours[0].scheduled_at)) / h) * h;
    const e = Math.max(Math.ceil(Math.max(...ts, s + 4 * h) / h) * h, s + 4 * h);
    return { start: s, end: e, hours: Array.from({ length: (e - s) / h }, (_, i) => s + i * h) };
  }, [pours]);
  const pos = (t: number) => `${((t - start) / (end - start)) * 100}%`;
  const width = (a: number, b: number) => `${Math.max(0.8, ((b - a) / (end - start)) * 100)}%`;
  const now = Date.now();
  return (
    <div className="gantt" data-testid="gantt">
      <div className="g-row g-head">
        <div className="g-label" />
        <div className="g-track">{hours.map((h) => <span key={h} className="g-hour" style={{ insetInlineStart: pos(h) }}><span className="num">{time(new Date(h).toISOString())}</span></span>)}</div>
      </div>
      {pours.map((p) => {
        const lanes = laneOf(p.loads_brief);
        const count = Math.max(1, ...lanes.values());
        return (
        <div key={p.id} className="g-row" style={{ minHeight: Math.max(56, count * 26 + 12) }}>
          <button type="button" className="g-label" onClick={() => onOpen(p.id)} aria-label={`طلب الصب ${p.ref}`}>
            <strong className="num">{p.ref}</strong> <Tone map={POUR_STATE} value={p.state} />
            {!p.site_ready && p.state !== 'canceled' && <Badge tone="danger">الموقع متوقف</Badge>}
            <div className="muted">{p.customer_name ?? siteLine(p.site)} · {p.mix_code} · <span className="num">{m3(p.volume_m3)}</span></div>
          </button>
          <div className="g-track">
            {hours.map((h) => <span key={h} className="g-grid" style={{ insetInlineStart: pos(h) }} />)}
            {now > start && now < end && <span className="g-now" style={{ insetInlineStart: pos(now) }} title="الآن" />}
            {p.loads_brief.map((l) => {
              const a = Date.parse(l.window_from), b = Date.parse(l.window_to);
              return (
                <button type="button" key={l.task_id} onClick={() => onOpen(p.id)} className={`g-load t-${LOAD_TONE[l.status] ?? 'muted'}`} style={{ insetInlineStart: pos(a), width: width(a, b), top: 6 + ((lanes.get(l.task_id) ?? 1) - 1) * 26 }}
                  title={`حمولة ${l.seq} · ${m3(l.volume_m3)} · وصول ${time(l.planned_arrival)} · ${TASK_STATUS[l.status]?.label ?? l.status}${l.plate_no ? ` · ${l.plate_no}` : ''}`}>
                  <span className="num">{l.seq}</span>{l.plate_no && <span className="g-plate num">{l.plate_no}</span>}
                  <i className="g-arrive" style={{ insetInlineStart: `${((Date.parse(l.planned_arrival) - a) / (b - a)) * 100}%` }} />
                </button>
              );
            })}
          </div>
        </div>
        );
      })}
      <div className="row muted g-legend">
        <span><i className="g-dot t-info" /> مجدولة</span><span><i className="g-dot t-primary" /> قبلها السائق</span><span><i className="g-dot t-warning" /> في الطريق أو الصب</span>
        <span><i className="g-dot t-success" /> مسلّمة</span><span><i className="g-dot t-danger" /> فاشلة</span><span>الخط الداخلي = موعد الوصول للموقع</span>
      </div>
    </div>
  );
}

/** Lanes for overlapping loads (interval colouring): a load goes to the first lane free at its start, so a lane reads as one truck's run. */
function laneOf(loads: LoadBrief[]) {
  const ends: number[] = [];
  const out = new Map<string, number>();
  for (const l of [...loads].sort((x, y) => Date.parse(x.window_from) - Date.parse(y.window_from))) {
    const a = Date.parse(l.window_from), b = Date.parse(l.window_to);
    let i = ends.findIndex((e) => e <= a);
    if (i < 0) { ends.push(b); i = ends.length - 1; } else ends[i] = b;
    out.set(l.task_id, i + 1);
  }
  return out;
}

function MixersPanel({ board, error }: { board: Board | null; error: string | null }) {
  return (
    <section className="card stack" data-testid="mixers">
      <h2>الخلاطات</h2>
      <ErrorBox error={error} />
      {board && board.mixers.length === 0 && <Empty>لا توجد خلاطات. أضفها من صفحة المركبات بنوع «خلاطة خرسانة».</Empty>}
      <ul className="mixers">
        {board?.mixers.map((m) => (
          <li key={m.asset_id}>
            <div className="row spread"><strong className="num">{m.plate_no ?? m.asset_id.slice(0, 6)}</strong><Tone map={MIXER_STATE} value={m.state} /></div>
            <div className="muted">{m.worker_name ?? 'بلا سائق'}{m.ticket_no && <> · تذكرة <span className="num">{m.ticket_no}</span></>}</div>
            {m.age_minutes !== null && <div className={m.age_level === 'over' ? 'age over' : m.age_level === 'warn' ? 'age warn' : 'age'}>عمر الخرسانة <span className="num">{m.age_minutes}</span> د</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PourModal({ id, mixers, onClose, onChange }: { id: string; mixers: Mixer[]; onClose: () => void; onChange: () => void }) {
  const me = useMe();
  const pour = useLoad(() => api<PourDetail>(`/concrete/pours/${id}`), [id]);
  const act = useAction();
  const [mode, setMode] = useState<'adjust' | 'cancel' | null>(null);
  const [vol, setVol] = useState('');
  const [reason, setReason] = useState('');
  const p = pour.data;
  const writer = can(me, 'tasks:write');
  const done = async (r: PourDetail) => { pour.setData(r); setMode(null); setReason(''); onChange(); };
  const patch = (body: Record<string, unknown>) => act.run(async () => done(await api<PourDetail>(`/concrete/pours/${id}`, { method: 'PATCH', body: { version: p!.version, ...body } })));
  const assign = (l: Load, assetId: string) => act.run(async () => {
    const m = mixers.find((x) => x.asset_id === assetId);
    if (!m?.worker_id) throw new Error('no driver');
    await api(`/tasks/${l.task_id}/assign`, { method: 'POST', body: { version: l.version, worker_id: m.worker_id, asset_id: assetId } });
    await pour.reload(); onChange();
  });
  const onShift = mixers.filter((m) => m.worker_id);
  return (
    <Modal title={p ? `طلب الصب ${p.ref}` : 'طلب الصب'} onClose={onClose}>
      <div className="stack pour-modal">
        <ErrorBox error={pour.error ?? act.error} />
        {p && (
          <>
            <div className="row"><Tone map={POUR_STATE} value={p.state} />{!p.site_ready && <Badge tone="danger">الموقع غير جاهز: الإرسال متوقف</Badge>}{p.pump_required && <Badge tone="info">مضخة{p.pump_plate ? ` ${p.pump_plate}` : ''}</Badge>}</div>
            <dl className="dl">
              <dt>العميل</dt><dd>{p.customer_name ?? '—'}</dd>
              <dt>الموقع</dt><dd>{siteLine(p.site)}{p.site.lat === undefined && <> <Badge tone="warning">بلا دبوس</Badge></>}{p.site.contact_name && <span className="muted"> · {p.site.contact_name} <span className="num">{p.site.contact_phone}</span></span>}</dd>
              <dt>الخلطة والكمية</dt><dd>{p.mix_code} · <span className="num">{m3(p.volume_m3)}</span> · معدل الصب <span className="num">{p.pour_rate_m3h}</span> م³/س</dd>
              <dt>بداية الصب</dt><dd className="num">{dt(p.scheduled_at)}</dd>
              <dt>الخطة</dt><dd>خلاطة كل <span className="num">{p.plan.spacing_minutes}</span> د، و<span className="num">{p.plan.trucks_needed}</span> خلاطات لصب مستمر، مدة الصب <span className="num">{p.plan.pour_minutes}</span> د <span className="muted">(تقدير من زمن الدورة في الإعدادات)</span></dd>
              {p.cancel_reason && <><dt>سبب الإلغاء</dt><dd>{p.cancel_reason}</dd></>}
            </dl>
            <div className="grid g4">
              <Kpi label="حمولات" value={`${p.totals.delivered_loads} / ${p.totals.loads}`} />
              <Kpi label="مصبوب" value={m3(p.totals.poured_m3)} tone="success" />
              <Kpi label="مرتجع" value={m3(p.totals.returned_m3)} tone={p.totals.returned_m3 ? 'warning' : undefined} />
              <Kpi label="انتظار بالموقع" value={`${p.totals.wait_minutes} د`} />
            </div>
            <div className="tbl-wrap"><table data-testid="loads">
              <thead><tr><th>التذكرة</th><th>الكمية</th><th>الوصول</th><th>الحالة</th><th>الخلاطة</th><th>العمر</th><th>الانتظار</th><th>مصبوب / مرتجع</th></tr></thead>
              <tbody>{p.loads.map((l) => (
                <tr key={l.task_id}>
                  <td><Link href={`/tasks/${l.task_id}`} className="num">{l.ticket_no}</Link></td>
                  <td className="num">{m3(l.volume_m3)}</td>
                  <td className="num">{time(l.planned_arrival)}</td>
                  <td><Tone map={TASK_STATUS} value={l.status} />{l.stage && <div className="muted">{STAGE[l.stage] ?? l.stage}</div>}</td>
                  <td>{l.plate_no ? <><span className="num">{l.plate_no}</span><div className="muted">{l.worker_name}</div></>
                    : ['ready'].includes(l.status) && can(me, 'tasks:assign') && p.state !== 'canceled' ? (
                      <select aria-label={`خلاطة للحمولة ${l.seq}`} value="" disabled={act.busy} onChange={(e) => e.target.value && void assign(l, e.target.value)}>
                        <option value="">إسناد خلاطة</option>
                        {onShift.map((m) => <option key={m.asset_id} value={m.asset_id}>{m.plate_no} · {m.worker_name} · {MIXER_STATE[m.state]?.label}</option>)}
                      </select>
                    ) : '—'}</td>
                  <td className="num">{l.age_minutes === null ? '—' : <span className={l.age_minutes >= p.limits.max_age_minutes ? 'age over' : l.age_minutes >= p.limits.age_warn_minutes ? 'age warn' : ''}>{l.age_minutes} د</span>}</td>
                  <td className="num">{l.wait_minutes ?? (l.at_site && !l.pour_start ? `${Math.round((Date.now() - Date.parse(l.at_site)) / 60000)} د…` : '—')}</td>
                  <td className="num">{l.poured_m3 === null ? '—' : `${l.poured_m3} / ${l.returned_m3 ?? 0}`}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {onShift.length === 0 && p.loads.some((l) => l.status === 'ready') && <p className="muted" style={{ margin: 0 }}>لا توجد خلاطة في وردية الآن. يبدأ السائق الوردية من التطبيق مع اختيار الخلاطة.</p>}
            {writer && p.state !== 'canceled' && p.state !== 'completed' && (
              mode === null ? (
                <div className="row">
                  <button disabled={act.busy} onClick={() => void patch({ site_ready: !p.site_ready })}>{p.site_ready ? 'إيقاف: الموقع غير جاهز' : 'استئناف: الموقع جاهز'}</button>
                  <button disabled={act.busy} onClick={() => { setMode('adjust'); setVol(String(p.volume_m3)); }}>تعديل الكمية</button>
                  <button className="danger" disabled={act.busy} onClick={() => setMode('cancel')}>إلغاء الصب</button>
                </div>
              ) : (
                <form className="form" onSubmit={(e) => {
                  e.preventDefault();
                  void act.run(async () => done(await api<PourDetail>(`/concrete/pours/${id}/${mode}`, { method: 'POST', body: { version: p.version, reason, ...(mode === 'adjust' ? { volume_m3: Number(vol) } : {}) } })));
                }}>
                  {mode === 'adjust' && <label className="field">الكمية الجديدة (م³)<input name="volume_m3" className="num" inputMode="decimal" value={vol} onChange={(e) => setVol(e.target.value)} required /></label>}
                  <label className="field">{mode === 'adjust' ? 'سبب التعديل (موافقة العميل)' : 'سبب الإلغاء'}<input name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} /></label>
                  <p className="muted" style={{ margin: 0 }}>{mode === 'adjust' ? 'تتغير الحمولات التي لم تُحمّل بعد فقط، والخلاطة المسندة تبقى على حمولتها.' : 'تُلغى الحمولات التي لم تُحمّل. الحمولات المحمّلة تبقى مع سائقيها لقرارك.'}</p>
                  <div className="row"><button className={mode === 'cancel' ? 'danger' : 'primary'} disabled={act.busy}>{mode === 'adjust' ? 'حفظ الكمية' : 'تأكيد الإلغاء'}</button><button type="button" onClick={() => setMode(null)}>رجوع</button></div>
                </form>
              )
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function NewPour({ onClose, onDone }: { onClose: () => void; onDone: (p: PourDetail) => void }) {
  const me = useMe();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string; legal_entity_id: string }[] }>('/customers').then((r) => r.data.filter((c) => c.status === 'active')).catch(() => []));
  const pumps = useLoad(() => (can(me, 'fleet:read') ? api<{ data: { id: string; plate_no: string | null; asset_type: string; status: string }[] }>('/assets').then((r) => r.data.filter((a) => a.asset_type === 'pump' && a.status !== 'retired')) : Promise.resolve([])));
  const { f, bind, check } = useForm({
    legal_entity_id: me.legal_entities[0]?.id ?? '', ref: '', customer_id: '', mix_code: 'C30', volume_m3: '', pour_rate_m3h: '30', date: todayKw(), at: '07:00',
    pump_required: false, pump_asset_id: '', name: '', area: '', block: '', street: '', plot: '', lat: '', lng: '', contact_name: '', contact_phone: '', notes: '',
  });
  const act = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const site = clean({ name: f.name, area: f.area, block: f.block, street: f.street, plot: f.plot, contact_name: f.contact_name, contact_phone: f.contact_phone,
        ...(f.lat && f.lng ? { lat: Number(f.lat), lng: Number(f.lng) } : {}) });
      const r = await api<PourDetail>('/concrete/pours', { method: 'POST', body: {
        legal_entity_id: f.legal_entity_id, ref: f.ref, mix_code: f.mix_code, volume_m3: Number(f.volume_m3), pour_rate_m3h: Number(f.pour_rate_m3h),
        scheduled_at: new Date(`${f.date}T${f.at}:00+03:00`).toISOString(), pump_required: f.pump_required, site,
        ...clean({ customer_id: f.customer_id, pump_asset_id: f.pump_asset_id, notes: f.notes }),
      } });
      onDone(r);
    });
  };
  return (
    <Modal title="طلب صب جديد" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={act.error} />
        <div className="form-2">
          <label className="field">رقم الطلب<input {...bind('ref')} className="num" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,39}" placeholder="RM-1001" /></label>
          <label className="field">العميل<select {...bind('customer_id')}><option value="">بدون عميل مسجّل</option>{customers.data?.filter((c) => c.legal_entity_id === f.legal_entity_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">الخلطة<input {...bind('mix_code')} required maxLength={40} placeholder="C30" /></label>
          <label className="field">الكمية (م³)<input {...bind('volume_m3')} className="num" inputMode="decimal" required pattern="\d{1,4}(\.\d{1,2})?" /></label>
          <label className="field">معدل الصب (م³/ساعة)<input {...bind('pour_rate_m3h')} className="num" inputMode="decimal" required pattern="\d{1,3}(\.\d{1,2})?" /></label>
          <label className="field">اليوم<input type="date" {...bind('date')} required /></label>
          <label className="field">بداية الصب<input type="time" {...bind('at')} required /></label>
          <label className="row" style={{ alignSelf: 'end' }}><input {...check('pump_required')} /> يحتاج مضخة</label>
          {f.pump_required && (pumps.data?.length ?? 0) > 0 && <label className="field">المضخة<select {...bind('pump_asset_id')}><option value="">تُحدد لاحقًا</option>{pumps.data?.map((x) => <option key={x.id} value={x.id}>{x.plate_no}</option>)}</select></label>}
        </div>
        <h3 style={{ margin: '8px 0 0' }}>الموقع</h3>
        <div className="form-2">
          <label className="field">اسم المشروع<input {...bind('name')} maxLength={120} /></label>
          <label className="field">المنطقة<input {...bind('area')} maxLength={120} /></label>
          <label className="field">القطعة<input {...bind('block')} maxLength={20} /></label>
          <label className="field">الشارع<input {...bind('street')} maxLength={120} /></label>
          <label className="field">القسيمة<input {...bind('plot')} maxLength={20} /></label>
          <label className="field">مهندس الموقع<input {...bind('contact_name')} maxLength={120} /></label>
          <label className="field">جوال المهندس<input {...bind('contact_phone')} className="num" inputMode="tel" /></label>
          <label className="field">خط العرض<input {...bind('lat')} className="num" inputMode="decimal" placeholder="29.37" /></label>
          <label className="field">خط الطول<input {...bind('lng')} className="num" inputMode="decimal" placeholder="47.98" /></label>
        </div>
        <p className="muted" style={{ margin: 0 }}>ثبّت الإحداثيات قبل إرسال أول خلاطة: موقع بلا دبوس يظهر في الاستثناءات. تُقسّم الكمية على حمولات بسعة الخلاطة في الإعدادات.</p>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        <div className="row"><button className="primary" disabled={act.busy}>إنشاء وجدولة الحمولات</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}

interface ExRow { task_id?: string; ticket_no?: string; pour_id: string; pour_ref: string; site: ConcreteSite; worker_name?: string | null; plate_no?: string | null; age_minutes?: number; max_age_minutes?: number; wait_minutes?: number; free_wait_minutes?: number; planned_arrival?: string; scheduled_at?: string }
function ExceptionsView({ onOpen }: { onOpen: (id: string) => void }) {
  const ex = useLoad(() => api<{ age: ExRow[]; waiting: ExRow[]; unassigned: ExRow[]; holds: ExRow[]; no_location: ExRow[] }>('/concrete/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  const pourLink = (r: ExRow) => <button type="button" className="link num" onClick={() => onOpen(r.pour_id)}>{r.pour_ref}</button>;
  const block = (title: string, rows: ExRow[], head: string[], cells: (r: ExRow) => React.ReactNode[], hint?: string) => (
    <section className="card">
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      {rows.length === 0 ? <Empty>لا يوجد</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={r.task_id ?? `${r.pour_id}-${i}`}>{cells(r).map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="عمر الخرسانة يقترب من الحد" value={d.age.length} tone={d.age.length ? 'danger' : undefined} />
        <Kpi label="انتظار فوق المجاني" value={d.waiting.length} tone={d.waiting.length ? 'warning' : undefined} />
        <Kpi label="حمولات قريبة بلا خلاطة" value={d.unassigned.length} tone={d.unassigned.length ? 'warning' : undefined} />
        <Kpi label="مواقع متوقفة أو بلا دبوس" value={d.holds.length + d.no_location.length} />
      </div>
      {block('عمر الخرسانة', d.age, ['الطلب', 'التذكرة', 'الخلاطة', 'العمر'], (r) => [pourLink(r), <Link key="t" href={`/tasks/${r.task_id}`} className="num">{r.ticket_no}</Link>, `${r.plate_no ?? '—'} · ${r.worker_name ?? ''}`,
        <span key="a" className={(r.age_minutes ?? 0) >= (r.max_age_minutes ?? 90) ? 'age over' : 'age warn'}><span className="num">{r.age_minutes}</span> من <span className="num">{r.max_age_minutes}</span> د</span>],
        'تنبيه مبكر وقرار بشري: الحد يحدده المصنع في الإعدادات.')}
      {block('خلاطات تنتظر في الموقع', d.waiting, ['الطلب', 'التذكرة', 'الخلاطة', 'الانتظار'], (r) => [pourLink(r), <span key="t" className="num">{r.ticket_no}</span>, `${r.plate_no ?? '—'} · ${r.worker_name ?? ''}`,
        <span key="w"><span className="num">{r.wait_minutes}</span> د (المجاني <span className="num">{r.free_wait_minutes}</span>)</span>], 'يُسجّل الانتظار للفوترة. أوقف الحمولات التالية إن لم يكن الموقع جاهزًا.')}
      {block('حمولات قريبة بلا خلاطة', d.unassigned, ['الطلب', 'التذكرة', 'الكمية', 'الوصول المخطط'], (r) => [pourLink(r), <span key="t" className="num">{r.ticket_no}</span>, <span key="v" className="num">{m3((r as ExRow & { volume_m3: number }).volume_m3)}</span>, <span key="p" className="num">{dt(r.planned_arrival)}</span>])}
      {block('مواقع متوقفة', d.holds, ['الطلب', 'الموقع', 'الموعد'], (r) => [pourLink(r), siteLine(r.site), <span key="s" className="num">{dt(r.scheduled_at)}</span>])}
      {block('مواقع بلا دبوس', d.no_location, ['الطلب', 'الموقع', 'الموعد'], (r) => [pourLink(r), siteLine(r.site), <span key="s" className="num">{dt(r.scheduled_at)}</span>], 'ثبّت إحداثيات الموقع قبل إرسال الخلاطات.')}
    </div>
  );
}

function WaitingView() {
  const [from, setFrom] = useState(`${todayKw().slice(0, 8)}01`);
  const [to, setTo] = useState(todayKw());
  const data = useLoad(() => api<{ customers: { customer_id: string | null; customer_name: string | null; loads: number; wait_minutes: number; avg_wait_minutes: number; billable_hours: number; poured_m3: number; returned_m3: number }[] }>(
    `/concrete/waiting?from=${encodeURIComponent(kwStart(from))}&to=${encodeURIComponent(nextDay(to))}`), [from, to]);
  const rows = data.data?.customers ?? [];
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <p className="muted" style={{ margin: 0 }}>الانتظار من وصول الخلاطة حتى بدء الصب. الساعات المحتسبة بعد الانتظار المجاني، بالربع ساعة، وتدخل الفاتورة بسعر «ساعة» في عقد العميل.</p>
      <ErrorBox error={data.error} />
      {data.data && rows.length === 0 ? <Empty>لا توجد تذاكر موقّعة في الفترة</Empty> : (
        <div className="tbl-wrap"><table data-testid="waiting">
          <thead><tr><th>العميل</th><th>حمولات</th><th>مصبوب</th><th>مرتجع</th><th>متوسط الانتظار</th><th>ساعات محتسبة</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.customer_id ?? '-'}><td>{r.customer_name ?? 'بدون عميل'}</td><td className="num">{r.loads}</td><td className="num">{m3(r.poured_m3)}</td><td className="num">{m3(r.returned_m3)}</td><td className="num">{r.avg_wait_minutes} د</td><td className="num">{r.billable_hours}</td></tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}

interface Settings { truck_capacity_m3: number; max_age_minutes: number; age_warn_minutes: number; free_wait_minutes: number; lead_minutes: number; cycle_minutes: number }
function SettingsView() {
  const me = useMe();
  const [le, setLe] = useState(me.legal_entities[0]?.id ?? '');
  const s = useLoad(() => api<Settings>(`/concrete/settings?legal_entity_id=${le}`), [le]);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState<Settings | null>(null);
  const cur = f ?? s.data;
  const writer = can(me, 'org:write');
  if (!cur) return <ErrorBox error={s.error} />;
  const num = (k: keyof Settings, label: string, min: number, max: number, step = 1) => (
    <label className="field">{label}<input type="number" className="num" min={min} max={max} step={step} value={String(cur[k])} disabled={!writer}
      onChange={(e) => { setF({ ...cur, [k]: Number(e.target.value) }); setSaved(false); }} required /></label>
  );
  return (
    <section className="card">
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { setF(await api<Settings>('/concrete/settings', { method: 'PUT', body: { legal_entity_id: le, ...cur } })); setSaved(true); }); }}>
        {me.legal_entities.length > 1 && (
          <label className="field">الشركة القانونية
            <select value={le} onChange={(e) => { setLe(e.target.value); setF(null); }}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </label>
        )}
        <ErrorBox error={act.error} />
        {saved && <div className="alert ok">حُفظت الإعدادات</div>}
        <div className="form-2">
          {num('truck_capacity_m3', 'حمولة الخلاطة (م³)', 1, 20, 0.5)}
          {num('max_age_minutes', 'أقصى عمر للخرسانة (دقيقة)', 15, 360)}
          {num('age_warn_minutes', 'تنبيه العمر عند (دقيقة)', 5, 360)}
          {num('free_wait_minutes', 'انتظار مجاني بالموقع (دقيقة)', 0, 240)}
          {num('lead_minutes', 'من التحميل حتى الوصول (دقيقة)', 5, 240)}
          {num('cycle_minutes', 'زمن الدورة الكاملة (دقيقة)', 20, 600)}
        </div>
        <p className="muted" style={{ margin: 0 }}>القيم الافتراضية تقديرية [تخمين] وتُضبط مع المصنع الشريك. حد العمر والانتظار المجاني يحددهما المصنع وعقد العميل [تحقق محلي].</p>
        {writer && <div className="row"><button className="primary" disabled={act.busy}>حفظ</button></div>}
      </form>
    </section>
  );
}

