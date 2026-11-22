'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { DIST_FAIL, dt, km, money, PRODUCT_UNIT, qtyText, ROUTE_STATUS, TASK_STATUS, TEMP_CLASS, time, todayKw } from '@/lib/format';
import { can, hasPack, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

interface Item { sku: string; name: string; qty: number; price: string; expiry?: string }
interface Stop {
  task_id: string; seq: number; name: string; payment: 'cash' | 'credit'; items: Item[]; delivered: Record<string, number> | null; returned: Record<string, number> | null;
  cash_due: string | null; cash_collected: string | null; received_by: string | null; closed_reason: string | null; done_at: string | null; status: string; address: string | null;
  window_from: string | null; window_to: string | null; damaged: Record<string, number> | null;
}
interface Route {
  id: string; ref: string; legal_entity_id: string; route_date: string; task_id: string; asset_id: string; plate_no: string | null; driver_name: string; status: string; task_status: string;
  notes: string | null; loaded_at: string | null; out_at: string | null; back_at: string | null; start_odometer_km: number | null; end_odometer_km: number | null; km: number | null;
  cash_received: string | null; settled_at: string | null; settle_note: string | null; cancel_reason: string | null; version: number; window_from: string; window_to: string;
  stops: number; stops_done: number; stops_failed: number; cash_due: string; cash_collected: string;
  temp_class: string; temp_min: number | null; temp_max: number | null; last_reading: { reading_c: number; recorded_at: string; in_range: boolean | null } | null;
}
interface RouteDetail extends Omit<Route, 'stops'> {
  stops: Stop[]; load: { sku: string; name: string; qty: number }[];
  reconcile: { sku: string; name: string; loaded: number; delivered: number; returned: number; back: number }[]; variance: string | null;
  temps: { id: string; stop_task_id: string | null; reading_c: number; source: string; device_ref: string | null; in_range: boolean | null; recorded_at: string; note: string | null }[];
}
interface Product { id: string; legal_entity_id: string; sku: string; name: string; unit: string; price: string; active: boolean }
type Tab = 'board' | 'exceptions' | 'report' | 'products';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const qtyLine = (q: Record<string, number> | null, items: Item[]) =>
  !q || !Object.keys(q).length ? '—' : Object.entries(q).map(([k, n]) => `${items.find((i) => i.sku === k)?.name ?? k} ${qtyText(n)}`).join('، ');

/** Own-fleet distribution (sector 29): the day's routes, planning with a load list, stops, cash settlement, exceptions and the report. */
export default function DistributionPage() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('board');
  const [date, setDate] = useState(todayKw());
  const [planning, setPlanning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const board = useLoad(() => api<{ date: string; routes: Route[]; totals: { routes: number; stops: number; stops_done: number; out: number; cash_due: string; cash_collected: string; unsettled: number } }>(`/distribution/board?date=${date}`), [date]);
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>التوزيع اليومي</h1>
        <div className="row">
          {tab === 'board' && <>
            <button className="small" onClick={() => setDate(addDays(date, -1))} aria-label="اليوم السابق">›</button>
            <input type="date" aria-label="اليوم" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <button className="small" onClick={() => setDate(addDays(date, 1))} aria-label="اليوم التالي">‹</button>
          </>}
          {can(me, 'tasks:assign') && <button className="primary" onClick={() => setPlanning(true)}>مسار جديد</button>}
        </div>
      </div>
      <Tabs tabs={[['board', 'مسارات اليوم'], ['exceptions', 'الاستثناءات'], ['report', 'تقرير التوزيع'], ['products', 'الأصناف']]} value={tab} onChange={setTab} />
      {tab === 'board' && (board.data ? <>
        <div className="grid g4">
          <Kpi label="مسارات" value={board.data.totals.routes} />
          <Kpi label="توقفات منجزة" value={`${board.data.totals.stops_done} / ${board.data.totals.stops}`} tone={board.data.totals.stops_done < board.data.totals.stops ? 'warning' : 'success'} />
          <Kpi label="نقد محصّل / مستحق" value={`${money(board.data.totals.cash_collected)} / ${Number(board.data.totals.cash_due).toFixed(3)}`} tone={Number(board.data.totals.cash_collected) < Number(board.data.totals.cash_due) ? 'danger' : undefined} />
          <Kpi label="بانتظار تسوية العهدة" value={board.data.totals.unsettled} tone={board.data.totals.unsettled ? 'warning' : undefined} />
        </div>
        <section className="card stack">
          <h2>المسارات</h2>
          {board.data.routes.length === 0 ? <Empty>لا توجد مسارات في هذا اليوم</Empty> : (
            <div className="tbl-wrap"><table data-testid="routes">
              <thead><tr><th>المسار</th><th>المركبة</th><th>السائق</th><th>النافذة</th><th>التوقفات</th><th>النقد</th><th>الحالة</th></tr></thead>
              <tbody>{board.data.routes.map((r) => (
                <tr key={r.id}>
                  <td><button type="button" className="link num" onClick={() => setOpen(r.id)} aria-label={`المسار ${r.ref}`}>{r.ref}</button></td>
                  <td className="num">{r.plate_no}</td><td>{r.driver_name}</td><td className="num">{time(r.window_from)}–{time(r.window_to)}</td>
                  <td><span className="num">{r.stops_done}/{r.stops}</span>{r.stops_failed > 0 && <> <Badge tone="danger">{r.stops_failed} تعذّر</Badge></>}</td>
                  <td className="num">{Number(r.cash_collected).toFixed(3)} / {Number(r.cash_due).toFixed(3)}</td>
                  <td><Tone map={ROUTE_STATUS} value={r.status} />{r.temp_class !== 'ambient' && <> <Badge tone={r.last_reading?.in_range === false ? 'danger' : 'info'}>{TEMP_CLASS[r.temp_class]}{r.last_reading ? ` ${r.last_reading.reading_c}°` : ''}</Badge></>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </> : <ErrorBox error={board.error} />)}
      {tab === 'exceptions' && <ExceptionsView onOpen={setOpen} />}
      {tab === 'report' && <ReportView />}
      {tab === 'products' && <ProductsView />}
      {planning && <PlanRoute date={date} onClose={() => setPlanning(false)} onDone={(r) => { setPlanning(false); setDate(r.route_date); setOpen(r.id); void board.reload(); }} />}
      {open && <RouteModal id={open} onClose={() => setOpen(null)} onChange={() => void board.reload()} />}
    </div>
  );
}

function RouteModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const me = useMe();
  const r = useLoad(() => api<RouteDetail>(`/distribution/routes/${id}`), [id]);
  const act = useAction();
  const [cash, setCash] = useState('');
  const [note, setNote] = useState('');
  const p = r.data;
  const done = (x: RouteDetail) => { r.setData(x); onChange(); };
  const variance = p && cash !== '' ? Math.round(Number(cash) * 1000) - Math.round(Number(p.cash_collected) * 1000) : 0;
  return (
    <Modal title={p ? `المسار ${p.ref}` : 'المسار'} onClose={onClose}>
      <div className="stack pour-modal">
        <ErrorBox error={r.error ?? act.error} />
        {p && <>
          <div className="row"><Tone map={ROUTE_STATUS} value={p.status} /><span className="muted">مهمة المسار: <Tone map={TASK_STATUS} value={p.task_status} /></span></div>
          <dl className="dl">
            <dt>اليوم</dt><dd className="num">{p.route_date} · {time(p.window_from)}–{time(p.window_to)}</dd>
            <dt>المركبة والسائق</dt><dd><strong className="num">{p.plate_no}</strong> · {p.driver_name}</dd>
            {p.temp_class !== 'ambient' && <><dt>الحرارة</dt><dd>{TEMP_CLASS[p.temp_class]} · النطاق <span className="num">{p.temp_min}° إلى {p.temp_max}°</span></dd></>}
            {p.loaded_at && <><dt>مراجعة الحمولة</dt><dd><span className="num">{dt(p.loaded_at)}</span> · عدّاد {km(p.start_odometer_km)}</dd></>}
            {p.out_at && <><dt>الانطلاق</dt><dd className="num">{dt(p.out_at)}</dd></>}
            {p.back_at && <><dt>العودة</dt><dd><span className="num">{dt(p.back_at)}</span> · عدّاد {km(p.end_odometer_km)} · المسافة <strong>{km(p.km)}</strong></dd></>}
            <dt>النقد</dt><dd>مستحق {money(p.cash_due)} · محصّل {money(p.cash_collected)}{p.cash_received !== null && <> · سُلّم للمكتب {money(p.cash_received)} · الفرق <strong style={{ color: Number(p.variance) < 0 ? 'var(--danger)' : undefined }}>{money(p.variance)}</strong></>}</dd>
            {p.settle_note && <><dt>ملاحظة التسوية</dt><dd>{p.settle_note}</dd></>}
            {p.cancel_reason && <><dt>سبب الإلغاء</dt><dd>{p.cancel_reason}</dd></>}
          </dl>
          <section><h3>التوقفات</h3>
            <div className="tbl-wrap"><table data-testid="stops">
              <thead><tr><th>#</th><th>الجهة</th><th>المخطط</th><th>المسلَّم</th><th>المرتجع</th><th>التالف</th><th>النقد</th><th>الحالة</th></tr></thead>
              <tbody>{p.stops.map((s) => (
                <tr key={s.task_id}>
                  <td className="num">{s.seq}</td>
                  <td>{s.name}<div className="muted">{s.payment === 'cash' ? 'نقدًا' : 'على الحساب'}{s.received_by && <> · استلم {s.received_by}</>}{(s.window_from || s.window_to) && <> · <span className="num">{time(s.window_from)}–{time(s.window_to)}</span></>}</div></td>
                  <td>{s.items.map((i) => `${i.name} ${qtyText(i.qty)}${i.expiry ? ` (صلاحية ${i.expiry})` : ''}`).join('، ')}</td>
                  <td>{qtyLine(s.delivered, s.items)}</td><td>{qtyLine(s.returned, s.items)}</td><td>{qtyLine(s.damaged, s.items)}</td>
                  <td className="num">{s.payment === 'cash' && s.done_at ? <>{Number(s.cash_collected).toFixed(3)} / {Number(s.cash_due).toFixed(3)}</> : '—'}</td>
                  <td><Tone map={TASK_STATUS} value={s.status} />{s.closed_reason && <div><Badge tone="danger">{DIST_FAIL[s.closed_reason] ?? s.closed_reason}</Badge></div>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </section>
          {(p.temp_class !== 'ambient' || p.temps.length > 0) && <TempsCard r={p} onDone={done} />}
          <section><h3>{p.back_at ? 'مطابقة الحمولة' : 'قائمة التحميل'}</h3>
            <div className="tbl-wrap"><table data-testid="reconcile">
              <thead><tr><th>الصنف</th><th>المحمّل</th><th>المسلَّم</th><th>المرتجع من العملاء</th><th>يعود للمستودع</th></tr></thead>
              <tbody>{p.reconcile.map((x) => (
                <tr key={x.sku}><td>{x.name} <span className="muted num">{x.sku}</span></td><td className="num">{qtyText(x.loaded)}</td><td className="num">{qtyText(x.delivered)}</td><td className="num">{qtyText(x.returned)}</td><td className="num"><strong>{qtyText(x.back)}</strong></td></tr>
              ))}</tbody>
            </table></div>
          </section>
          {p.status === 'back' && can(me, 'billing:write') && (
            <form className="form card" onSubmit={(e) => { e.preventDefault(); void act.run(async () => done(await api<RouteDetail>(`/distribution/routes/${p.id}/settle`, { method: 'POST', body: { version: p.version, cash_received: cash, ...clean({ note }) } }))); }}>
              <h3>تسوية العهدة النقدية</h3>
              <div className="form-2">
                <label className="field">المبلغ المستلم من السائق (د.ك)<input name="cash_received" value={cash} onChange={(e) => setCash(e.target.value)} className="num" inputMode="decimal" pattern="\d{1,9}(\.\d{1,3})?" required placeholder={Number(p.cash_collected).toFixed(3)} /></label>
                <label className="field">ملاحظة{variance !== 0 && ' (مطلوبة: يوجد فرق)'}<input name="settle_note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required={variance !== 0} /></label>
              </div>
              {cash !== '' && variance !== 0 && <div className="alert warn">الفرق عن المحصّل: <span className="num">{(variance / 1000).toFixed(3)}</span> د.ك</div>}
              <div className="row"><button className="primary" disabled={act.busy}>تسوية</button></div>
            </form>
          )}
          {['planned', 'loaded'].includes(p.status) && can(me, 'tasks:assign') && (
            <div className="row"><button className="small" disabled={act.busy} onClick={() => {
              const reason = window.prompt('سبب إلغاء المسار؟');
              if (reason) void act.run(async () => done(await api<RouteDetail>(`/distribution/routes/${p.id}/cancel`, { method: 'POST', body: { version: p.version, reason } })));
            }}>إلغاء المسار</button></div>
          )}
        </>}
      </div>
    </Modal>
  );
}

interface StopDraft { name: string; address: string; phone: string; payment: 'cash' | 'credit'; window_from: string; window_to: string; items: { sku: string; qty: string; expiry: string }[] }
const emptyStop = (): StopDraft => ({ name: '', address: '', phone: '', payment: 'credit', window_from: '', window_to: '', items: [{ sku: '', qty: '', expiry: '' }] });

function TempsCard({ r, onDone }: { r: RouteDetail; onDone: (x: RouteDetail) => void }) {
  const me = useMe();
  const act = useAction();
  const [c, setC] = useState('');
  const [device, setDevice] = useState('');
  const stopName = (id: string | null) => r.stops.find((s) => s.task_id === id)?.name;
  return (
    <section className="card stack" data-testid="temps">
      <h3>قراءات الحرارة</h3>
      {r.temps.length === 0 ? <Empty>لا توجد قراءات بعد</Empty> : (
        <div className="tbl-wrap"><table><thead><tr><th>الوقت</th><th>الحرارة</th><th>المصدر</th><th>عند</th><th></th></tr></thead>
          <tbody>{r.temps.map((x) => <tr key={x.id}><td className="num">{dt(x.recorded_at)}</td><td className="num"><strong>{x.reading_c}°</strong></td>
            <td>{x.source === 'manual' ? 'يدوي' : x.source === 'device' ? `جهاز ${x.device_ref}` : `تطبيق خارجي ${x.device_ref}`}</td><td>{stopName(x.stop_task_id) ?? '—'}</td>
            <td>{x.in_range === false ? <Badge tone="danger">خارج النطاق</Badge> : x.in_range ? <Badge tone="success">ضمن النطاق</Badge> : null}</td></tr>)}</tbody></table></div>
      )}
      {can(me, 'tasks:write') && r.status !== 'canceled' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { onDone(await api<RouteDetail>(`/distribution/routes/${r.id}/temps`, { method: 'POST', body: { reading_c: Number(c), ...(device ? { source: 'device', device_ref: device } : {}) } })); setC(''); }); }}>
          <input name="reading_c" value={c} onChange={(e) => setC(e.target.value)} className="num" inputMode="decimal" pattern="-?\d{1,2}(\.\d)?" required placeholder="°C" style={{ width: 90 }} aria-label="الحرارة" />
          <input name="device_ref" value={device} onChange={(e) => setDevice(e.target.value)} maxLength={80} placeholder="رقم جهاز التسجيل (اختياري)" aria-label="رقم الجهاز" />
          <button disabled={act.busy}>تسجيل قراءة</button>
        </form>
      )}
      <ErrorBox error={act.error} />
      <p className="muted" style={{ margin: 0 }}>القراءات يسجلها السائق من شاشة الثلاجة، أو المكتب، أو جهاز تسجيل برقمه. لا تُفترض حرارة بلا قراءة.</p>
    </section>
  );
}

function PlanRoute({ date, onClose, onDone }: { date: string; onClose: () => void; onDone: (r: RouteDetail) => void }) {
  const me = useMe();
  const assets = useAssets();
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string; status: string; legal_entity_id: string }[] }>('/workers?status=active').then((r) => r.data));
  const products = useLoad(() => api<{ data: Product[] }>('/distribution/products').then((r) => r.data.filter((p) => p.active)));
  const act = useAction();
  const cold = hasPack(me, 'coldchain');
  const { f, bind } = useForm({ legal_entity_id: me.legal_entities[0]?.id ?? '', route_date: date, asset_id: '', driver_worker_id: '', start_time: '06:00', end_time: '18:00', notes: '', temp_class: 'ambient' });
  const [stops, setStops] = useState<StopDraft[]>([emptyStop()]);
  const setStop = (i: number, p: Partial<StopDraft>) => setStops(stops.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const setItem = (i: number, k: number, p: Partial<StopDraft['items'][number]>) => setStop(i, { items: stops[i].items.map((x, j) => (j === k ? { ...x, ...p } : x)) });
  const prods = (products.data ?? []).filter((p) => p.legal_entity_id === f.legal_entity_id);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => onDone(await api<RouteDetail>('/distribution/routes', { method: 'POST', body: {
      ...clean({ legal_entity_id: f.legal_entity_id, route_date: f.route_date, asset_id: f.asset_id, driver_worker_id: f.driver_worker_id, start_time: f.start_time, end_time: f.end_time, notes: f.notes, temp_class: f.temp_class }),
      stops: stops.map((s) => ({ name: s.name, payment: s.payment, ...clean({ address: s.address, phone: s.phone, window_from: s.window_from, window_to: s.window_to }),
        items: s.items.filter((x) => x.sku && x.qty).map((x) => ({ sku: x.sku, qty: Number(x.qty), ...clean({ expiry: x.expiry }) })) })),
    } })));
  };
  return (
    <Modal title="مسار توزيع جديد" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={act.error} />
        {prods.length === 0 && products.data && <div className="alert warn">أضف الأصناف أولًا من تبويب «الأصناف».</div>}
        <div className="form-2">
          <label className="field">اليوم<input type="date" {...bind('route_date')} required /></label>
          <label className="field">المركبة<select {...bind('asset_id')} required><option value="">اختر</option>{assets.data?.filter((a) => a.legal_entity_id === f.legal_entity_id && a.status !== 'retired').map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
          <label className="field">السائق<select {...bind('driver_worker_id')} required><option value="">اختر</option>{workers.data?.filter((w) => w.legal_entity_id === f.legal_entity_id && ['driver', 'courier'].includes(w.kind)).map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          <label className="field">من<input type="time" {...bind('start_time')} required /></label>
          <label className="field">إلى<input type="time" {...bind('end_time')} required /></label>
          {cold && <label className="field">الحرارة<select {...bind('temp_class')}><option value="ambient">عادي</option><option value="chilled">مبرد (0° إلى 5°)</option><option value="frozen">مجمد (-25° إلى -18°)</option></select></label>}
        </div>
        {stops.map((s, i) => (
          <fieldset key={i} className="card stack" data-testid={`stop-${i + 1}`}>
            <legend>التوقف {i + 1}</legend>
            <div className="form-2">
              <label className="field">الفرع أو العميل<input value={s.name} onChange={(e) => setStop(i, { name: e.target.value })} required maxLength={120} aria-label={`اسم التوقف ${i + 1}`} /></label>
              <label className="field">العنوان<input value={s.address} onChange={(e) => setStop(i, { address: e.target.value })} maxLength={300} aria-label={`عنوان التوقف ${i + 1}`} /></label>
              <label className="field">الدفع<select value={s.payment} onChange={(e) => setStop(i, { payment: e.target.value as 'cash' | 'credit' })} aria-label={`دفع التوقف ${i + 1}`}><option value="credit">على الحساب</option><option value="cash">نقدًا عند التسليم</option></select></label>
              {cold && <label className="field">نافذة التسليم من<input type="time" value={s.window_from} onChange={(e) => setStop(i, { window_from: e.target.value })} aria-label={`نافذة التوقف ${i + 1} من`} /></label>}
              {cold && <label className="field">إلى<input type="time" value={s.window_to} onChange={(e) => setStop(i, { window_to: e.target.value })} aria-label={`نافذة التوقف ${i + 1} إلى`} /></label>}
            </div>
            {s.items.map((x, k) => (
              <div key={k} className="row">
                <select value={x.sku} onChange={(e) => setItem(i, k, { sku: e.target.value })} aria-label={`صنف ${k + 1} للتوقف ${i + 1}`} required={k === 0}>
                  <option value="">الصنف</option>{prods.map((p) => <option key={p.sku} value={p.sku}>{p.name} ({PRODUCT_UNIT[p.unit] ?? p.unit})</option>)}
                </select>
                <input value={x.qty} onChange={(e) => setItem(i, k, { qty: e.target.value })} className="num" inputMode="decimal" style={{ width: 100 }} placeholder="الكمية" aria-label={`كمية ${k + 1} للتوقف ${i + 1}`} required={k === 0} />
                {cold && <input type="date" value={x.expiry} onChange={(e) => setItem(i, k, { expiry: e.target.value })} title="تاريخ الصلاحية" aria-label={`صلاحية ${k + 1} للتوقف ${i + 1}`} />}
              </div>
            ))}
            <div className="row">
              <button type="button" className="small" onClick={() => setStop(i, { items: [...s.items, { sku: '', qty: '', expiry: '' }] })}>+ صنف</button>
              {stops.length > 1 && <button type="button" className="small danger" onClick={() => setStops(stops.filter((_, j) => j !== i))}>حذف التوقف</button>}
            </div>
          </fieldset>
        ))}
        <div className="row"><button type="button" onClick={() => setStops([...stops, emptyStop()])}>+ توقف</button></div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        <p className="muted" style={{ margin: 0 }}>تُحجز المركبة والسائق لنافذة اليوم، ويرى السائق المسار وقائمة التحميل ثم التوقفات بالترتيب.</p>
        <div className="row"><button className="primary" disabled={act.busy}>حفظ المسار</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}

interface ExStop extends Stop { route_id: string; route_ref: string; route_date: string; driver_name: string }
interface Ex { not_loaded: Route[]; late: Route[]; unsettled: Route[]; variance: Route[]; short: ExStop[]; failed: ExStop[]; returns: ExStop[] }
function ExceptionsView({ onOpen }: { onOpen: (id: string) => void }) {
  const ex = useLoad(() => api<Ex>('/distribution/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  const link = (id: string, ref: string) => <button type="button" className="link num" onClick={() => onOpen(id)}>{ref}</button>;
  const routes = (title: string, rows: Route[], hint: string) => (
    <section className="card"><h2>{title}</h2><p className="muted">{hint}</p>
      {rows.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table><thead><tr><th>المسار</th><th>اليوم</th><th>السائق</th><th>التوقفات</th><th>النقد</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{link(r.id, r.ref)}</td><td className="num">{r.route_date}</td><td>{r.driver_name}</td><td className="num">{r.stops_done}/{r.stops}</td>
          <td className="num">{Number(r.cash_collected).toFixed(3)}{r.cash_received !== null && <> ← {Number(r.cash_received).toFixed(3)}</>}</td></tr>)}</tbody></table></div>}
    </section>
  );
  const stops = (title: string, rows: ExStop[], col: (s: ExStop) => React.ReactNode, hint: string) => (
    <section className="card"><h2>{title}</h2><p className="muted">{hint}</p>
      {rows.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table><thead><tr><th>المسار</th><th>الجهة</th><th>السائق</th><th>التفاصيل</th></tr></thead>
        <tbody>{rows.map((s) => <tr key={s.task_id}><td>{link(s.route_id, `${s.route_ref}-${s.seq}`)}</td><td>{s.name}</td><td>{s.driver_name}</td><td>{col(s)}</td></tr>)}</tbody></table></div>}
    </section>
  );
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="نقص نقد عند التسليم" value={d.short.length} tone={d.short.length ? 'danger' : undefined} />
        <Kpi label="عهدة لم تُسوَّ" value={d.unsettled.length} tone={d.unsettled.length ? 'warning' : undefined} />
        <Kpi label="توقفات تعذّرت" value={d.failed.length} tone={d.failed.length ? 'warning' : undefined} />
        <Kpi label="مرتجعات" value={d.returns.length} />
      </div>
      {stops('نقص في النقد عند التسليم', d.short, (s) => <span className="num">{Number(s.cash_collected).toFixed(3)} من {Number(s.cash_due).toFixed(3)}</span>, 'حصّل السائق أقل من قيمة المسلَّم لعميل نقدي.')}
      {routes('عهدة لم تُسوَّ', d.unsettled, 'عاد السائق منذ أكثر من ساعتين ولم يسلّم النقد.')}
      {routes('فرق عند التسوية', d.variance, 'المبلغ المسلَّم يختلف عن المحصّل.')}
      {routes('لم تبدأ في موعدها', d.not_loaded, 'مضت 30 دقيقة على بداية النافذة ولم يراجع السائق الحمولة.')}
      {routes('تأخر العودة', d.late, 'انتهت نافذة المسار والسائق ما زال في الطريق.')}
      {stops('توقفات تعذّرت', d.failed, (s) => DIST_FAIL[s.closed_reason ?? ''] ?? s.closed_reason, 'أعد جدولتها في مسار قادم.')}
      {stops('مرتجعات من العملاء', d.returns, (s) => qtyLine(s.returned, s.items), 'تالف أو منتهٍ أو زائد: راجع المستودع.')}
    </div>
  );
}

interface ReportRow { id: string; ref: string; route_date: string; driver_name: string; plate_no: string; status: string; stops: number; stops_done: number; stops_failed: number; km: number | null; planned_value: string; delivered_value: string; returned_value: string; cash_due: string; cash_collected: string; cash_received: string | null; variance: string | null }
function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<{ data: ReportRow[]; totals: Record<string, string | number> }>(`/distribution/report?from=${from}&to=${to}`), [from, to]);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {r.data && (r.data.data.length === 0 ? <Empty>لا توجد مسارات في الفترة</Empty> : (
        <div className="tbl-wrap"><table data-testid="dist-report">
          <thead><tr><th>اليوم</th><th>المسار</th><th>السائق</th><th>التوقفات</th><th>المسافة</th><th>المخطط</th><th>المسلَّم</th><th>المرتجع</th><th>محصّل</th><th>مسلَّم للمكتب</th><th>الفرق</th></tr></thead>
          <tbody>{r.data.data.map((x) => (
            <tr key={x.id}><td className="num">{x.route_date}</td><td className="num">{x.ref}</td><td>{x.driver_name}</td><td className="num">{x.stops_done}/{x.stops}</td><td>{km(x.km)}</td>
              <td className="num">{x.planned_value}</td><td className="num">{x.delivered_value}</td><td className="num">{x.returned_value}</td><td className="num">{x.cash_collected}</td>
              <td className="num">{x.cash_received ?? '—'}</td><td className="num" style={{ color: Number(x.variance) < 0 ? 'var(--danger)' : undefined }}>{x.variance ?? '—'}</td></tr>
          ))}</tbody>
          <tfoot><tr><th colSpan={4}>الإجمالي</th><th>{km(Number(r.data.totals.km))}</th><th className="num">{r.data.totals.planned_value}</th><th className="num">{r.data.totals.delivered_value}</th>
            <th className="num">{r.data.totals.returned_value}</th><th className="num">{r.data.totals.cash_collected}</th><th /><th className="num">{r.data.totals.variance}</th></tr></tfoot>
        </table></div>
      ))}
      <p className="muted" style={{ margin: 0 }}>القيم بالدينار بأسعار الأصناف وقت التخطيط. نسبة التسليم = المسلَّم ÷ المخطط.</p>
    </section>
  );
}

function ProductsView() {
  const me = useMe();
  const list = useLoad(() => api<{ data: Product[] }>('/distribution/products').then((r) => r.data));
  const act = useAction();
  const { f, bind, setF } = useForm({ sku: '', name: '', unit: 'piece', price: '' });
  const writer = can(me, 'tasks:write');
  return (
    <section className="card stack">
      <ErrorBox error={list.error ?? act.error} />
      {list.data && (list.data.length === 0 ? <Empty>لا توجد أصناف بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="products">
          <thead><tr><th>الرمز</th><th>الصنف</th><th>الوحدة</th><th>السعر</th><th /></tr></thead>
          <tbody>{list.data.map((p) => (
            <tr key={p.id}><td className="num">{p.sku}</td><td>{p.name}{!p.active && <> <Badge>موقوف</Badge></>}</td><td>{PRODUCT_UNIT[p.unit] ?? p.unit}</td><td className="num">{money(p.price)}</td>
              <td>{writer && <button className="small" onClick={() => void act.run(async () => { await api(`/distribution/products/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); await list.reload(); })}>{p.active ? 'إيقاف' : 'تفعيل'}</button>}</td></tr>
          ))}</tbody>
        </table></div>
      ))}
      {writer && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('/distribution/products', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, sku: f.sku, name: f.name, unit: f.unit, price: f.price || '0' } }); setF({ sku: '', name: '', unit: 'piece', price: '' }); await list.reload(); }); }}>
          <div className="form-2">
            <label className="field">الرمز<input {...bind('sku')} className="num" required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,39}" placeholder="MLK-1L" /></label>
            <label className="field">الاسم<input {...bind('name')} required maxLength={120} /></label>
            <label className="field">الوحدة<select {...bind('unit')}>{Object.entries(PRODUCT_UNIT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">السعر (د.ك)<input {...bind('price')} className="num" inputMode="decimal" pattern="\d{1,9}(\.\d{1,3})?" placeholder="0.350" /></label>
          </div>
          <div className="row"><button className="primary" disabled={act.busy}>إضافة صنف</button></div>
        </form>
      )}
    </section>
  );
}
