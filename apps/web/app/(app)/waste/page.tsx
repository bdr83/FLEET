'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, ISO_WEEKDAYS, SHUTTLE_SKIP, TASK_STATUS, todayKw, WS_BIN, WS_EVENT, WS_MISS, WS_TYPE } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Route {
  id: string; code: string; name: string; waste_type: string; start_time: string; duration_min: number; days: number[]; facility: string | null;
  asset_id: string | null; plate_no: string | null; driver_worker_id: string | null; driver_name: string | null; active: boolean; version: number; points: number;
}
interface Bin { type: string; count: number }
interface Point {
  id: string; seq: number; customer_id: string | null; customer_name: string | null; name: string; area: string | null; bins: Bin[]; note: string | null; active: boolean;
  event?: string | null; bins_emptied?: number | null; reason?: string | null; mark_note?: string | null; marked_at?: string | null; source?: string | null;
}
interface Run {
  id: string; route_id: string; route_code: string; route_name: string; waste_type: string; run_date: string; task_id: string; status: string; start_at: string;
  plate_no: string; driver_name: string; points_planned: number; started_at: string | null; ended_at: string | null; collected: number; missed: number; bins: number; dumps: number; net_kg: number;
}
type Tab = 'day' | 'routes' | 'exceptions' | 'report';

const hhmm = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16) : '—');
const binsText = (b: Bin[]) => b.map((x) => `${x.count} × ${WS_BIN[x.type] ?? x.type}`).join('، ');
const tonnes = (kg: number) => `${(kg / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} طن`;
const daysText = (d: number[]) => (d.length === 7 ? 'كل يوم' : ISO_WEEKDAYS.filter(([n]) => d.includes(n)).map(([, l]) => l).join('، '));

/** Waste collection (sector 23): the day's rounds with each point and the weighbridge tickets, routes and their points, exceptions and the report. */
export default function WastePage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>جمع النفايات</h1></div>
      <Tabs tabs={[['day', 'جولات اليوم'], ['routes', 'الخطوط ونقاط الجمع'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'day' && <DayView />}
      {tab === 'routes' && <RoutesView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function DayView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const runs = useLoad(() => api<{ data: Run[] }>(`/waste/runs?date=${day}`).then((r) => r.data), [day]);
  const act = useAction();
  const [gen, setGen] = useState<{ created: string[]; existing: string[]; skipped: { code: string; reason: string }[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const skip: Record<string, string> = { ...SHUTTLE_SKIP, no_vehicle: 'بلا كابسة', vehicle_booked: 'الكابسة محجوزة في الوقت نفسه', vehicle_out_of_service: 'الكابسة خارج الخدمة', past: 'موعد الجولة مضى', no_points: 'بلا نقاط جمع' };
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => { setDay(e.target.value); setGen(null); }} aria-label="يوم الجولات" /></label>
        {can(me, 'tasks:assign') && <button disabled={act.busy} onClick={() => void act.run(async () => {
          setGen(await api('/waste/runs/generate', { method: 'POST', body: { date: day } })); await runs.reload();
        })}>توليد جولات اليوم</button>}
        <button className="secondary" onClick={() => void runs.reload()}>تحديث</button>
      </div>
      <ErrorBox error={act.error ?? runs.error} />
      {gen && <p data-testid="gen-result" className="muted">أُنشئ {gen.created.length}{gen.existing.length ? ` · موجود ${gen.existing.length}` : ''}
        {gen.skipped.map((s) => <span key={s.code}> · <Badge tone="warning">{s.code}: {skip[s.reason] ?? s.reason}</Badge></span>)}</p>}
      {runs.data?.length === 0 ? <Empty>لا جولات لهذا اليوم. ولّدها من الخطوط العاملة فيه.</Empty> : (
        <div className="tbl-wrap"><table data-testid="runs"><thead><tr><th>البدء</th><th>الخط</th><th>الكابسة والسائق</th><th>الحالة</th><th>النقاط</th><th>الحاويات</th><th>المردم</th><th></th></tr></thead>
          <tbody>{runs.data?.map((r) => (
            <tr key={r.id}><td className="num">{hhmm(r.start_at)}{r.started_at && <div className="muted">بدأ {hhmm(r.started_at)}</div>}</td>
              <td><span className="num">{r.route_code}</span> {r.route_name} <Badge>{WS_TYPE[r.waste_type]}</Badge></td>
              <td><span className="num">{r.plate_no}</span> · {r.driver_name}</td><td><Tone map={TASK_STATUS} value={r.status} /></td>
              <td className="num">{r.collected} / {r.points_planned}{r.missed > 0 && <> <Badge tone="danger">لم تُجمع {r.missed}</Badge></>}</td>
              <td className="num">{r.bins}</td><td className="num">{r.dumps ? `${tonnes(r.net_kg)} · ${r.dumps} تذكرة` : '—'}</td>
              <td><button className="small" onClick={() => setOpen(r.id)}>فتح</button></td></tr>
          ))}</tbody></table></div>
      )}
      {open && <RunModal id={open} onClose={() => { setOpen(null); void runs.reload(); }} />}
    </section>
  );
}

function RunModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  type D = Run & { points: Point[]; tickets: { ticket_no: string; facility: string | null; net_kg: number; occurred_at: string; source: string }[] };
  const r = useLoad(() => api<D>(`/waste/runs/${id}`), [id]);
  const act = useAction();
  const d = r.data;
  const w = can(me, 'tasks:assign') && !!d && !['canceled', 'failed'].includes(d.status);
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/waste/runs/${id}/${path}`, { method: 'POST', body }); await r.reload(); });
  const { f, bind, setF } = useForm({ ticket_no: '', net_kg: '', facility: '', reason: '' });
  return (
    <Modal title={d ? `جولة ${d.route_code} · ${d.run_date}` : 'الجولة'} onClose={onClose}>
      <ErrorBox error={r.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={TASK_STATUS} value={d.status} /> {d.route_name} · <span className="num">{d.plate_no}</span> · {d.driver_name} · جُمعت {d.collected} من {d.points.filter((p) => p.active).length} · حاويات {d.bins}</p>
        <div className="tbl-wrap"><table data-testid="round-sheet"><thead><tr><th>#</th><th>النقطة</th><th>العميل</th><th>الحاويات</th><th>التسجيل</th>{w && <th></th>}</tr></thead>
          <tbody>{d.points.map((p) => (
            <tr key={p.id}><td className="num">{p.seq}</td><td>{p.name}{p.area && <div className="muted">{p.area}</div>}{p.note && <div className="muted">{p.note}</div>}</td><td>{p.customer_name ?? '—'}</td>
              <td>{binsText(p.bins)}</td>
              <td>{p.event ? <><Tone map={WS_EVENT} value={p.event} />{p.event === 'collected' && <span className="num"> {p.bins_emptied}</span>}{p.reason && <div className="muted">{WS_MISS[p.reason]}{p.mark_note ? `: ${p.mark_note}` : ''}</div>}
                <div className="muted num">{hhmm(p.marked_at ?? null)}{p.source === 'office' ? ' (المكتب)' : ''}</div></> : <Badge>لم تُسجَّل</Badge>}</td>
              {w && <td><button className="small" disabled={act.busy} aria-label={`جُمعت ${p.name}`} onClick={() => void post('visit', { point_id: p.id, event: 'collected', bins: p.bins.reduce((n, b) => n + b.count, 0) })}>جُمعت</button>{' '}
                <select aria-label={`لم تُجمع ${p.name}`} value="" disabled={act.busy} onChange={(e) => e.target.value && void post('visit', { point_id: p.id, event: 'missed', reason: e.target.value })} style={{ width: 'auto' }}>
                  <option value="">لم تُجمع…</option>{Object.entries(WS_MISS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>}</tr>
          ))}</tbody></table></div>
        <h3>تذاكر الميزان</h3>
        {d.tickets.length === 0 ? <p className="muted">لا تذاكر بعد</p> : (
          <div className="tbl-wrap"><table data-testid="tickets"><thead><tr><th>التذكرة</th><th>المردم</th><th>الصافي</th><th>الوقت</th></tr></thead>
            <tbody>{d.tickets.map((t) => <tr key={t.ticket_no}><td className="num">{t.ticket_no}</td><td>{t.facility ?? '—'}</td><td className="num">{tonnes(t.net_kg)}</td><td className="num">{dt(t.occurred_at)}</td></tr>)}</tbody></table></div>
        )}
        {w && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api(`/waste/runs/${id}/dump`, { method: 'POST', body: { ticket_no: f.ticket_no, net_kg: Number(f.net_kg), ...clean({ facility: f.facility }) } });
          setF({ ...f, ticket_no: '', net_kg: '', facility: '' }); await r.reload();
        }); }}>
          <input {...bind('ticket_no')} placeholder="رقم تذكرة الميزان" required maxLength={40} aria-label="رقم تذكرة الميزان" className="num" />
          <input {...bind('net_kg')} type="number" step="0.1" min={0.1} max={40000} placeholder="الصافي (كغ)" required aria-label="الوزن الصافي" className="num" style={{ width: 120 }} />
          <input {...bind('facility')} placeholder="المردم (اختياري)" maxLength={120} aria-label="المردم" />
          <button className="secondary" disabled={act.busy}>تسجيل تذكرة</button>
        </form>}
        {w && ['ready', 'assigned', 'accepted'].includes(d.status) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={300} aria-label="سبب إلغاء الجولة" />
          <button className="danger" disabled={act.busy}>إلغاء الجولة</button>
        </form>}
      </div>}
    </Modal>
  );
}

function RoutesView() {
  const me = useMe();
  const routes = useLoad(() => api<{ data: Route[] }>('/waste/routes').then((r) => r.data));
  const [edit, setEdit] = useState<Route | 'new' | null>(null);
  const [pts, setPts] = useState<Route | null>(null);
  const w = can(me, 'tasks:assign');
  return (
    <section className="card stack">
      <div className="row"><h2 style={{ margin: 0 }}>خطوط الجمع</h2>{w && <button onClick={() => setEdit('new')}>إضافة خط</button>}</div>
      <ErrorBox error={routes.error} />
      {routes.data?.length === 0 ? <Empty>لا خطوط بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="ws-routes"><thead><tr><th>الرمز</th><th>الخط</th><th>البدء</th><th>الأيام</th><th>الكابسة والسائق</th><th>المردم</th><th>النقاط</th><th></th></tr></thead>
          <tbody>{routes.data?.map((r) => (
            <tr key={r.id} className={r.active ? '' : 'muted'}><td className="num">{r.code}</td><td>{r.name} <Badge>{WS_TYPE[r.waste_type]}</Badge></td>
              <td className="num">{r.start_time} · {Math.round(r.duration_min / 60 * 10) / 10} س</td><td>{daysText(r.days)}</td>
              <td>{r.plate_no ? <span className="num">{r.plate_no}</span> : <Badge tone="warning">بلا كابسة</Badge>} · {r.driver_name ?? <Badge tone="warning">بلا سائق</Badge>}</td>
              <td>{r.facility ?? '—'}</td><td className="num">{r.points}</td>
              <td><button className="small" onClick={() => setPts(r)}>النقاط</button>{w && <> <button className="small secondary" onClick={() => setEdit(r)}>تعديل</button></>}</td></tr>
          ))}</tbody></table></div>
      )}
      {edit && <RouteForm r={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void routes.reload(); }} />}
      {pts && <PointsModal r={pts} onClose={() => { setPts(null); void routes.reload(); }} />}
    </section>
  );
}

function RouteForm({ r, onClose, onDone }: { r: Route | null; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const assets = useLoad(() => api<{ data: { id: string; plate_no: string | null; asset_type: string }[] }>('/assets').then((x) => x.data.filter((a) => a.asset_type === 'truck')));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string }[] }>('/workers?status=active').then((x) => x.data.filter((w) => ['driver', 'courier'].includes(w.kind))));
  const { f, bind, setF } = useForm({ code: r?.code ?? '', name: r?.name ?? '', waste_type: r?.waste_type ?? 'general', start_time: r?.start_time ?? '05:00', hours: String((r?.duration_min ?? 480) / 60),
    facility: r?.facility ?? '', asset_id: r?.asset_id ?? '', driver_worker_id: r?.driver_worker_id ?? '', active: r?.active ?? true });
  const [days, setDays] = useState<number[]>(r?.days ?? [1, 2, 3, 4, 5, 6, 7]);
  return (
    <Modal title={r ? `تعديل الخط ${r.code}` : 'إضافة خط جمع'} onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const body = { name: f.name, waste_type: f.waste_type, start_time: f.start_time, duration_min: Math.round(Number(f.hours) * 60), days, facility: f.facility || null,
          asset_id: f.asset_id || null, driver_worker_id: f.driver_worker_id || null };
        if (r) await api(`/waste/routes/${r.id}`, { method: 'PATCH', body: { ...body, version: r.version, active: f.active } });
        else await api('/waste/routes', { method: 'POST', body: { ...body, legal_entity_id: me.legal_entities[0]?.id, code: f.code } });
        onDone();
      }); }}>
        <div className="row">
          {!r && <label className="field">الرمز<input {...bind('code')} required maxLength={12} className="num" style={{ width: 100 }} placeholder="SAL-1" /></label>}
          <label className="field">اسم الخط<input {...bind('name')} required maxLength={120} /></label>
          <label className="field">نوع النفايات<select {...bind('waste_type')}>{Object.entries(WS_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">البدء<input {...bind('start_time')} type="time" required /></label>
          <label className="field">المدة (ساعة)<input {...bind('hours')} type="number" step="0.5" min={0.5} max={16} className="num" style={{ width: 90 }} /></label>
          <label className="field">المردم أو مركز الفرز<input {...bind('facility')} maxLength={120} placeholder="مردم الجهراء" /></label>
        </div>
        <fieldset className="row" aria-label="أيام التشغيل">{ISO_WEEKDAYS.map(([n, l]) => (
          <label key={n} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={days.includes(n)} onChange={(e) => setDays(e.target.checked ? [...days, n] : days.filter((x) => x !== n))} /> {l}</label>
        ))}</fieldset>
        <div className="row">
          <label className="field">الكابسة<select {...bind('asset_id')}><option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          <label className="field">السائق<select {...bind('driver_worker_id')}><option value="">—</option>{workers.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          {r && <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> فعّال</label>}
        </div>
        <button disabled={act.busy}>حفظ</button>
      </form>
    </Modal>
  );
}

function PointsModal({ r, onClose }: { r: Route; onClose: () => void }) {
  const me = useMe();
  const pts = useLoad(() => api<{ data: Point[] }>(`/waste/routes/${r.id}/points`).then((x) => x.data), [r.id]);
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const act = useAction();
  const { f, bind, setF } = useForm({ name: '', area: '', customer_id: '', bin_type: 'bin_1100', count: '1', seq: '', note: '' });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={`نقاط الخط ${r.code}`} onClose={onClose}>
      <ErrorBox error={act.error ?? pts.error} />
      {pts.data?.filter((p) => p.active).length === 0 ? <Empty>لا نقاط بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="ws-points"><thead><tr><th>#</th><th>النقطة</th><th>العميل</th><th>الحاويات</th>{w && <th></th>}</tr></thead>
          <tbody>{pts.data?.filter((p) => p.active).map((p) => (
            <tr key={p.id}><td className="num">{p.seq}</td><td>{p.name}{p.area && <div className="muted">{p.area}</div>}</td><td>{p.customer_name ?? '—'}</td><td>{binsText(p.bins)}</td>
              {w && <td><button className="small secondary" disabled={act.busy} onClick={() => void act.run(async () => { await api(`/waste/points/${p.id}`, { method: 'PATCH', body: { active: false } }); await pts.reload(); })}>إزالة</button></td>}</tr>
          ))}</tbody></table></div>
      )}
      {w && <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api(`/waste/routes/${r.id}/points`, { method: 'POST', body: { name: f.name, bins: [{ type: f.bin_type, count: Number(f.count) || 1 }], ...clean({ area: f.area, customer_id: f.customer_id, note: f.note }),
          ...(f.seq ? { seq: Number(f.seq) } : {}) } });
        setF({ ...f, name: '', note: '', seq: '' }); await pts.reload();
      }); }}>
        <div className="row">
          <label className="field">النقطة<input {...bind('name')} required maxLength={120} placeholder="جمعية السالمية الرئيسي" /></label>
          <label className="field">المنطقة<input {...bind('area')} maxLength={80} /></label>
          <label className="field">العميل<select {...bind('customer_id')}><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">نوع الحاوية<select {...bind('bin_type')}>{Object.entries(WS_BIN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">العدد<input {...bind('count')} type="number" min={1} max={50} className="num" style={{ width: 70 }} /></label>
          <label className="field">الترتيب (اختياري)<input {...bind('seq')} type="number" min={1} max={200} className="num" style={{ width: 80 }} /></label>
          <label className="field">ملاحظة للسائق<input {...bind('note')} maxLength={300} placeholder="المدخل الخلفي" /></label>
        </div>
        <button disabled={act.busy}>إضافة النقطة</button>
      </form>}
    </Modal>
  );
}

function ExceptionsView() {
  const [day, setDay] = useState(todayKw());
  type M = { point_id: string; name: string; area: string | null; customer_name: string | null; route_code: string; reason?: string; note?: string | null; runs?: number };
  type X = { late_start: Run[]; not_generated: Route[]; no_vehicle_or_driver: Route[]; missed: M[]; repeat_missed: M[] };
  const x = useLoad(() => api<X>(`/waste/exceptions?date=${day}`), [day]);
  const d = x.data;
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الاستثناءات" /></label>
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="نقاط لم تُجمع" value={d.missed.length} tone={d.missed.length ? 'danger' : undefined} />
          <Kpi label="لم تُجمع جولتين متتاليتين" value={d.repeat_missed.length} tone={d.repeat_missed.length ? 'danger' : undefined} />
          <Kpi label="جولات تأخرت عن البدء" value={d.late_start.length} tone={d.late_start.length ? 'warning' : undefined} />
          <Kpi label="خطوط بلا جولة" value={d.not_generated.length + d.no_vehicle_or_driver.length} tone={d.not_generated.length + d.no_vehicle_or_driver.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>نقاط لم تُجمع</h2>{d.missed.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-missed"><thead><tr><th>الخط</th><th>النقطة</th><th>العميل</th><th>السبب</th></tr></thead>
            <tbody>{d.missed.map((m) => <tr key={m.point_id}><td className="num">{m.route_code}</td><td>{m.name}</td><td>{m.customer_name ?? '—'}</td><td>{WS_MISS[m.reason ?? ''] ?? m.reason}{m.note ? `: ${m.note}` : ''}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>لم تُجمع في آخر جولتين: تواصل مع العميل [تخمين]</h2>{d.repeat_missed.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-repeat"><thead><tr><th>الخط</th><th>النقطة</th><th>العميل</th><th>جولات</th></tr></thead>
            <tbody>{d.repeat_missed.map((m) => <tr key={m.point_id}><td className="num">{m.route_code}</td><td>{m.name}</td><td>{m.customer_name ?? '—'}</td><td className="num">{m.runs}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>جولات لم تبدأ بعد 30 دقيقة من موعدها [تخمين]</h2>{d.late_start.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-late"><tbody>{d.late_start.map((r) => <tr key={r.id}><td className="num">{r.route_code}</td><td className="num">{hhmm(r.start_at)}</td><td>{r.driver_name}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>خطوط تعمل اليوم بلا جولة</h2>{d.not_generated.length + d.no_vehicle_or_driver.length === 0 ? <Empty>لا يوجد</Empty> : (
          <ul>{d.not_generated.map((r) => <li key={r.id}><span className="num">{r.code}</span> {r.name}: لم تُولَّد جولته</li>)}
            {d.no_vehicle_or_driver.map((r) => <li key={r.id}><span className="num">{r.code}</span> {r.name}: {!r.asset_id ? 'بلا كابسة' : 'بلا سائق'}</li>)}</ul>)}</section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { runs: number; completed: number; collected: number; missed: number; bins: number; dumps: number; tonnes: number };
  const r = useLoad(() => api<{ totals: Sum; routes: (Sum & { route_code: string; route_name: string; waste_type: string })[]; customers: { customer_name: string; collected: number; missed: number; bins: number }[] }>(`/waste/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="جولات مكتملة" value={`${x.completed} / ${x.runs}`} />
          <Kpi label="نسبة الجمع" value={x.collected + x.missed ? `${Math.round((x.collected / (x.collected + x.missed)) * 100)}%` : '—'} />
          <Kpi label="حاويات مفرّغة" value={x.bins} />
          <Kpi label="أطنان للمردم" value={x.tonnes} />
        </div>
        <section className="card"><h2>حسب الخط</h2>
          {r.data!.routes.length === 0 ? <Empty>لا جولات</Empty> : <div className="tbl-wrap"><table data-testid="ws-report-routes"><thead><tr><th>الخط</th><th>جولات</th><th>جُمعت</th><th>لم تُجمع</th><th>حاويات</th><th>تذاكر</th><th>أطنان</th></tr></thead>
            <tbody>{r.data!.routes.map((s) => <tr key={s.route_code}><td><span className="num">{s.route_code}</span> {s.route_name}</td><td className="num">{s.runs}</td><td className="num">{s.collected}</td><td className="num">{s.missed}</td>
              <td className="num">{s.bins}</td><td className="num">{s.dumps}</td><td className="num">{s.tonnes}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>حسب العميل</h2>
          {r.data!.customers.length === 0 ? <Empty>لا تسجيلات</Empty> : <div className="tbl-wrap"><table data-testid="ws-report-customers"><thead><tr><th>العميل</th><th>جُمعت</th><th>لم تُجمع</th><th>حاويات</th></tr></thead>
            <tbody>{r.data!.customers.map((c) => <tr key={c.customer_name}><td>{c.customer_name}</td><td className="num">{c.collected}</td><td className="num">{c.missed}</td><td className="num">{c.bins}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
