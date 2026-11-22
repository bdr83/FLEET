'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, SHUTTLE_DIRECTION, SHUTTLE_SKIP, TASK_STATUS, todayKw, ISO_WEEKDAYS } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

interface Stop { name: string; area?: string; offset_min: number }
interface Route {
  id: string; legal_entity_id: string; customer_id: string | null; customer_name: string | null; code: string; name: string; direction: string; depart_time: string; duration_min: number;
  days: number[]; stops: Stop[]; capacity: number | null; asset_id: string | null; plate_no: string | null; driver_worker_id: string | null; driver_name: string | null; active: boolean; version: number; riders: number;
}
interface Rider { id: string; name: string; staff_no: string | null; phone: string | null; stop_seq: number; active?: boolean; event?: string | null; marked_at?: string | null; source?: string | null; no_shows_30d?: number }
interface Trip {
  id: string; route_id: string; route_code: string; route_name: string; direction: string; customer_name: string | null; trip_date: string; task_id: string; status: string;
  depart_at: string; arrive_by: string; plate_no: string; driver_name: string; riders_planned: number; capacity: number | null; started_at: string | null; ended_at: string | null; boarded: number; no_show: number;
}
type Tab = 'day' | 'routes' | 'exceptions' | 'report';

const useRoutes = () => useLoad(() => api<{ data: Route[] }>('/shuttle/routes').then((r) => r.data));
const owner = (n: string | null) => n ?? 'موظفو الشركة';
const hhmm = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16);
const daysText = (d: number[]) => d.length === 7 ? 'كل يوم' : ISO_WEEKDAYS.filter(([n]) => d.includes(n)).map(([, l]) => l).join('، ');

/** Staff transport (sector 11): daily trips per route with the riders' boarding, routes and riders, exceptions and the report. */
export default function ShuttlePage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>نقل الموظفين</h1></div>
      <Tabs tabs={[['day', 'رحلات اليوم'], ['routes', 'الخطوط والركاب'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
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
  const trips = useLoad(() => api<{ data: Trip[] }>(`/shuttle/trips?date=${day}`).then((r) => r.data), [day]);
  const act = useAction();
  const [gen, setGen] = useState<{ created: string[]; existing: string[]; skipped: { code: string; reason: string }[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => { setDay(e.target.value); setGen(null); }} aria-label="يوم الرحلات" /></label>
        {can(me, 'tasks:assign') && <button disabled={act.busy} onClick={() => void act.run(async () => {
          setGen(await api('/shuttle/trips/generate', { method: 'POST', body: { date: day } })); await trips.reload();
        })}>توليد رحلات اليوم</button>}
      </div>
      <ErrorBox error={act.error ?? trips.error} />
      {gen && <p data-testid="gen-result" className="muted">أُنشئ {gen.created.length}{gen.existing.length ? ` · موجود ${gen.existing.length}` : ''}
        {gen.skipped.map((s) => <span key={s.code}> · <Badge tone="warning">{s.code}: {SHUTTLE_SKIP[s.reason] ?? s.reason}</Badge></span>)}</p>}
      {trips.data?.length === 0 ? <Empty>لا توجد رحلات لهذا اليوم. ولّدها من الخطوط العاملة فيه.</Empty> : (
        <div className="tbl-wrap"><table data-testid="trips"><thead><tr><th>الانطلاق</th><th>الخط</th><th>العميل</th><th>الحافلة والسائق</th><th>الحالة</th><th>الركاب</th><th></th></tr></thead>
          <tbody>{trips.data?.map((t) => (
            <tr key={t.id}><td className="num">{hhmm(t.depart_at)}{t.started_at && <> <span className="muted">انطلق {hhmm(t.started_at)}</span></>}</td>
              <td><span className="num">{t.route_code}</span> {t.route_name} <Badge>{SHUTTLE_DIRECTION[t.direction]}</Badge></td><td>{owner(t.customer_name)}</td>
              <td><span className="num">{t.plate_no}</span> · {t.driver_name}</td><td><Tone map={TASK_STATUS} value={t.status} /></td>
              <td className="num">{t.boarded} / {t.riders_planned}{t.no_show > 0 && <> <Badge tone="warning">غائب {t.no_show}</Badge></>}{t.capacity && t.boarded > t.capacity && <> <Badge tone="danger">فوق السعة</Badge></>}</td>
              <td><button className="small" onClick={() => setOpen(t.id)}>الركاب</button></td></tr>
          ))}</tbody></table></div>
      )}
      {open && <TripModal id={open} onClose={() => { setOpen(null); void trips.reload(); }} />}
    </section>
  );
}

function TripModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const t = useLoad(() => api<Trip & { stops: Stop[]; riders: Rider[] }>(`/shuttle/trips/${id}`), [id]);
  const act = useAction();
  const [reason, setReason] = useState('');
  const d = t.data;
  const mark = (rider: string, event: string) => act.run(async () => { await api(`/shuttle/trips/${id}/board`, { method: 'POST', body: { rider_id: rider, event } }); await t.reload(); });
  return (
    <Modal title={d ? `رحلة ${d.route_code} · ${d.trip_date}` : 'الرحلة'} onClose={onClose}>
      <ErrorBox error={t.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={TASK_STATUS} value={d.status} /> صعد {d.boarded} من {d.riders.length}{d.capacity ? ` · المقاعد ${d.capacity}` : ''} · <span className="num">{d.plate_no}</span> · {d.driver_name}</p>
        {d.stops.map((s, i) => (
          <div key={i}>
            <h3><span className="num">{hhmm(new Date(new Date(d.depart_at).getTime() + s.offset_min * 60_000).toISOString())}</span> {s.name}{s.area ? ` · ${s.area}` : ''}</h3>
            {d.riders.filter((r) => r.stop_seq === i + 1).length === 0 ? <p className="muted">لا ركاب من هذه المحطة</p> : (
              <div className="tbl-wrap"><table data-testid={`manifest-${i + 1}`}><tbody>{d.riders.filter((r) => r.stop_seq === i + 1).map((r) => (
                <tr key={r.id}><td>{r.name} {r.staff_no && <span className="num muted">{r.staff_no}</span>}</td>
                  <td>{r.event === 'boarded' ? <Badge tone="success">صعد</Badge> : r.event === 'no_show' ? <Badge tone="warning">غائب</Badge> : <Badge>لم يُسجَّل</Badge>}{r.source === 'office' && <span className="muted"> (المكتب)</span>}</td>
                  <td>{can(me, 'tasks:assign') && d.status !== 'canceled' && d.status !== 'failed' && <>
                    <button className="small" disabled={act.busy || r.event === 'boarded'} onClick={() => void mark(r.id, 'boarded')} aria-label={`صعد ${r.name}`}>صعد</button>{' '}
                    <button className="small" disabled={act.busy || r.event === 'no_show'} onClick={() => void mark(r.id, 'no_show')} aria-label={`غائب ${r.name}`}>غائب</button></>}</td></tr>
              ))}</tbody></table></div>
            )}
          </div>
        ))}
        {can(me, 'tasks:assign') && ['ready', 'assigned', 'accepted'].includes(d.status) && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api(`/shuttle/trips/${id}/cancel`, { method: 'POST', body: { reason } }); await t.reload();
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
  const [ridersOf, setRidersOf] = useState<Route | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={routes.error} />
      {can(me, 'tasks:assign') && <div className="row"><button onClick={() => setEdit('new')}>إضافة خط</button></div>}
      {routes.data?.length === 0 ? <Empty>لا توجد خطوط بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="routes"><thead><tr><th>الخط</th><th>العميل</th><th>الانطلاق</th><th>الأيام</th><th>المحطات</th><th>الحافلة والسائق</th><th>الركاب</th><th></th></tr></thead>
          <tbody>{routes.data?.map((r) => (
            <tr key={r.id}><td><span className="num">{r.code}</span> {r.name} <Badge>{SHUTTLE_DIRECTION[r.direction]}</Badge>{!r.active && <> <Badge>موقوف</Badge></>}</td><td>{owner(r.customer_name)}</td>
              <td className="num">{r.depart_time} · {r.duration_min} د</td><td>{daysText(r.days)}</td><td>{r.stops.map((s) => s.name).join(' ← ')}</td>
              <td>{r.plate_no ? <span className="num">{r.plate_no}</span> : <Badge tone="warning">بلا حافلة</Badge>} · {r.driver_name ?? <Badge tone="warning">بلا سائق</Badge>}</td>
              <td className="num">{r.riders}{r.capacity ? ` / ${r.capacity}` : ''}</td>
              <td>{can(me, 'tasks:assign') && <><button className="small" onClick={() => setEdit(r)}>تعديل</button> </>}<button className="small" onClick={() => setRidersOf(r)}>الركاب</button></td></tr>
          ))}</tbody></table></div>
      )}
      {edit && <RouteForm r={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void routes.reload(); }} />}
      {ridersOf && <RidersModal r={ridersOf} onClose={() => { setRidersOf(null); void routes.reload(); }} />}
    </section>
  );
}

function RouteForm({ r, onClose, onDone }: { r: Route | null; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const assets = useAssets();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string }[] }>('/workers?status=active').then((x) => x.data.filter((w) => ['driver', 'courier'].includes(w.kind))));
  const { f, bind, setF } = useForm({ code: r?.code ?? '', name: r?.name ?? '', customer_id: r?.customer_id ?? '', direction: r?.direction ?? 'to_work', depart_time: r?.depart_time ?? '06:00',
    duration_min: String(r?.duration_min ?? 60), capacity: r?.capacity ? String(r.capacity) : '', asset_id: r?.asset_id ?? '', driver_worker_id: r?.driver_worker_id ?? '',
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
        const body = { name: f.name, customer_id: f.customer_id || null, direction: f.direction, depart_time: f.depart_time, duration_min: Number(f.duration_min), days, stops: parseStops(),
          capacity: f.capacity ? Number(f.capacity) : null, asset_id: f.asset_id || null, driver_worker_id: f.driver_worker_id || null };
        if (r) await api(`/shuttle/routes/${r.id}`, { method: 'PATCH', body: { ...body, version: r.version, active: f.active } });
        else await api('/shuttle/routes', { method: 'POST', body: { ...body, legal_entity_id: me.legal_entities[0]?.id, code: f.code } });
        onDone();
      }); }}>
        <div className="row">
          {!r && <label className="field">الرمز<input {...bind('code')} required maxLength={12} className="num" style={{ width: 100 }} /></label>}
          <label className="field">اسم الخط<input {...bind('name')} required maxLength={120} /></label>
          <label className="field">العميل<select {...bind('customer_id')}><option value="">موظفو الشركة</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">الاتجاه<select {...bind('direction')}>{Object.entries(SHUTTLE_DIRECTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">الانطلاق<input {...bind('depart_time')} type="time" required /></label>
          <label className="field">المدة (دقيقة)<input {...bind('duration_min')} type="number" min={10} max={480} className="num" style={{ width: 90 }} /></label>
          <label className="field">المقاعد<input {...bind('capacity')} type="number" min={1} max={120} className="num" style={{ width: 80 }} /></label>
        </div>
        <fieldset className="row" aria-label="أيام التشغيل">{ISO_WEEKDAYS.map(([n, l]) => (
          <label key={n} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={days.includes(n)} onChange={(e) => setDays(e.target.checked ? [...days, n] : days.filter((x) => x !== n))} /> {l}</label>
        ))}</fieldset>
        <label className="field">المحطات بالترتيب، سطر لكل محطة: الدقائق بعد الانطلاق | الاسم | المنطقة
          <textarea {...bind('stops')} rows={4} required aria-label="المحطات" /></label>
        <div className="row">
          <label className="field">الحافلة<select {...bind('asset_id')}><option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          <label className="field">السائق<select {...bind('driver_worker_id')}><option value="">—</option>{workers.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          {r && <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> فعّال</label>}
        </div>
        <button disabled={act.busy}>حفظ</button>
      </form>
    </Modal>
  );
}

function RidersModal({ r, onClose }: { r: Route; onClose: () => void }) {
  const me = useMe();
  const riders = useLoad(() => api<{ data: Rider[] }>(`/shuttle/routes/${r.id}/riders`).then((x) => x.data), [r.id]);
  const act = useAction();
  const [text, setText] = useState('');
  const [res, setRes] = useState<{ added: number; skipped: number } | null>(null);
  return (
    <Modal title={`ركاب الخط ${r.code}`} onClose={onClose}>
      <ErrorBox error={act.error ?? riders.error} />
      {can(me, 'tasks:assign') && <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const list = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, staff_no, stop, phone] = l.split(/\t|,|،/).map((x) => x.trim());
          return { name, stop_seq: Number(stop) || 1, ...clean({ staff_no: staff_no ?? '', phone: phone ?? '' }) };
        });
        setRes(await api(`/shuttle/routes/${r.id}/riders`, { method: 'POST', body: { riders: list } })); setText(''); await riders.reload();
      }); }}>
        <label className="field">سطر لكل راكب: الاسم، الرقم الوظيفي، رقم المحطة ({r.stops.map((s, i) => `${i + 1} ${s.name}`).join('، ')})، الجوال
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} required aria-label="الركاب" /></label>
        <button disabled={act.busy}>إضافة الركاب</button>
        {res && <p className="muted" data-testid="riders-result">أُضيف {res.added}{res.skipped ? ` · مكرر ${res.skipped}` : ''}</p>}
      </form>}
      {riders.data?.length === 0 ? <Empty>لا ركاب بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="riders"><thead><tr><th>الاسم</th><th>الرقم الوظيفي</th><th>المحطة</th><th>غياب 30 يومًا</th><th></th></tr></thead>
          <tbody>{riders.data?.map((x) => (
            <tr key={x.id}><td>{x.name}{!x.active && <> <Badge>موقوف</Badge></>}</td><td className="num">{x.staff_no ?? '—'}</td><td>{r.stops[x.stop_seq - 1]?.name ?? x.stop_seq}</td>
              <td className="num">{x.no_shows_30d ? <Badge tone="warning">{x.no_shows_30d}</Badge> : 0}</td>
              <td>{can(me, 'tasks:assign') && <button className="small" disabled={act.busy} onClick={() => void act.run(async () => {
                await api(`/shuttle/riders/${x.id}`, { method: 'PATCH', body: { active: !x.active } }); await riders.reload();
              })}>{x.active ? 'إيقاف' : 'تفعيل'}</button>}</td></tr>
          ))}</tbody></table></div>
      )}
    </Modal>
  );
}

function ExceptionsView() {
  const [day, setDay] = useState(todayKw());
  const x = useLoad(() => api<{ late: Trip[]; missing: (Route & { reason: string })[]; over_capacity: Trip[]; no_show_streak: { id: string; name: string; staff_no: string | null; phone: string | null; route_code: string; customer_name: string | null }[] }>(`/shuttle/exceptions?date=${day}`), [day]);
  const d = x.data;
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="رحلات متأخرة عن الانطلاق" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
          <Kpi label="خطوط بلا رحلة" value={d.missing.length} tone={d.missing.length ? 'warning' : undefined} />
          <Kpi label="فوق السعة" value={d.over_capacity.length} />
          <Kpi label="غياب متكرر" value={d.no_show_streak.length} />
        </div>
        <section className="card"><h2>لم تنطلق بعد 10 دقائق من موعدها [تخمين]</h2>
          {d.late.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-late"><thead><tr><th>الخط</th><th>الموعد</th><th>الحافلة والسائق</th><th>الحالة</th></tr></thead>
            <tbody>{d.late.map((t) => <tr key={t.id}><td><span className="num">{t.route_code}</span> {t.route_name}</td><td className="num">{hhmm(t.depart_at)}</td><td><span className="num">{t.plate_no}</span> · {t.driver_name}</td><td><Tone map={TASK_STATUS} value={t.status} /></td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>خطوط تعمل اليوم بلا رحلة</h2>
          {d.missing.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-missing"><thead><tr><th>الخط</th><th>العميل</th><th>الانطلاق</th><th>السبب</th></tr></thead>
            <tbody>{d.missing.map((r) => <tr key={r.id}><td><span className="num">{r.code}</span> {r.name}</td><td>{owner(r.customer_name)}</td><td className="num">{r.depart_time}</td><td><Badge tone="warning">{SHUTTLE_SKIP[r.reason] ?? r.reason}</Badge></td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>غائبون 3 رحلات متتالية [تخمين]</h2>
          {d.no_show_streak.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-streak"><thead><tr><th>الراكب</th><th>الرقم الوظيفي</th><th>الخط</th><th>العميل</th></tr></thead>
            <tbody>{d.no_show_streak.map((r) => <tr key={r.id}><td>{r.name}</td><td className="num">{r.staff_no ?? '—'}</td><td className="num">{r.route_code}</td><td>{owner(r.customer_name)}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { trips: number; completed: number; canceled: number; failed: number; on_time_pct: number | null; boarded: number; no_shows: number; occupancy_pct: number | null };
  const r = useLoad(() => api<{ data: (Sum & { customer_id: string | null; customer_name: string | null; routes: number })[]; totals: Sum }>(`/shuttle/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="ركاب منقولون" value={x.boarded} />
          <Kpi label="إشغال المقاعد" value={pct(x.occupancy_pct)} />
        </div>
        <section className="card">
          {r.data!.data.length === 0 ? <Empty>لا توجد رحلات في الفترة</Empty> : (
            <div className="tbl-wrap"><table data-testid="sh-report"><thead><tr><th>العميل</th><th>الخطوط</th><th>الرحلات</th><th>منفذة</th><th>ملغاة</th><th>تعذرت</th><th>في الموعد</th><th>الركاب</th><th>الغياب</th><th>الإشغال</th></tr></thead>
              <tbody>{r.data!.data.map((s) => <tr key={s.customer_id ?? '-'}><td>{owner(s.customer_name)}</td><td className="num">{s.routes}</td><td className="num">{s.trips}</td><td className="num">{s.completed}</td>
                <td className="num">{s.canceled}</td><td className="num">{s.failed}</td><td className="num">{pct(s.on_time_pct)}</td><td className="num">{s.boarded}</td><td className="num">{s.no_shows}</td><td className="num">{pct(s.occupancy_pct)}</td></tr>)}</tbody></table></div>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>الرحلات المنفذة أساس الفوترة للعميل حسب عقده (بالرحلة أو شهريًا) [تحقق محلي]. آخر تحديث {dt(new Date().toISOString())}.</p>
        </section>
      </>}
    </div>
  );
}
