'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, money, time, TK_CLASS, TK_PRODUCT, TK_STATE, todayKw, WEEKDAYS } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

type Site = Record<string, string>;
interface Order {
  id: string; ref: string; customer_name: string; site: Site; product: string; qty_l: number; wanted_from: string; wanted_to: string; unit_price: string | null; attempts: number;
  source: string | null; loaded_l: number | null; delivered_l: number | null; delivered_at: string | null; received_by: string | null; notes: string | null; state: string;
  driver_name: string | null; plate_no: string | null; loss_l: number | null; loss_pct: number | null; loss_flag: boolean; short: boolean; amount: string | null;
}
interface Tanker { asset_id: string; plate_no: string | null; asset_type: string; status: string; product_class: string | null; capacity_l: number | null }
type Tab = 'orders' | 'board' | 'schedules' | 'tankers' | 'exceptions' | 'report';

const siteText = (s: Site) => [s.name, s.area, s.block && `ق ${s.block}`].filter(Boolean).join('، ') || '—';
const L = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('en-US')} لتر`);
const classOf = (p: string) => (p === 'diesel' || p === 'kerosene' ? 'fuel' : 'water');

/** Tankers (sector 7): orders, the day's board by tanker, standing orders, the tankers, exceptions and the report. */
export default function TankersPage() {
  const [tab, setTab] = useState<Tab>('orders');
  return (
    <div className="page stack">
      <div className="page-head"><h1>صهاريج المياه والديزل والوقود</h1></div>
      <Tabs tabs={[['orders', 'الطلبات'], ['board', 'لوحة اليوم'], ['schedules', 'الطلبات الثابتة'], ['tankers', 'الصهاريج'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'orders' && <OrdersView />}
      {tab === 'board' && <BoardView />}
      {tab === 'schedules' && <SchedulesView />}
      {tab === 'tankers' && <TankersView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function OrdersTable({ rows, onPick, testId }: { rows: Order[]; onPick?: (o: Order) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>الطلب</th><th>الموعد</th><th>العميل والموقع</th><th>المنتج</th><th>المطلوب</th><th>المفرّغ</th><th>الصهريج</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id}><td className="num">{o.ref}</td><td className="num">{dt(o.wanted_from)}–{time(o.wanted_to)}</td><td>{o.customer_name} · {siteText(o.site)}</td><td>{TK_PRODUCT[o.product]}</td>
          <td className="num">{L(o.qty_l)}</td><td className="num">{L(o.delivered_l)}{o.loss_flag && <> <Badge tone="danger">فاقد {o.loss_pct}%</Badge></>}{o.short && <> <Badge tone="warning">ناقص</Badge></>}</td>
          <td>{o.plate_no ? <><span className="num">{o.plate_no}</span> · {o.driver_name}</> : '—'}</td><td><Tone map={TK_STATE} value={o.state} /></td>
          <td>{onPick && <button className="small" onClick={() => onPick(o)}>إدارة</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function useCustomers() {
  return useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
}

function OrdersView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const orders = useLoad(() => api<{ data: Order[] }>(`/tankers/orders?date=${day}`).then((r) => r.data), [day]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={orders.error} />
      <div className="row">
        {can(me, 'tasks:assign') && <button onClick={() => setAdding(true)}>طلب جديد</button>}
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="اليوم" style={{ maxWidth: 180 }} />
      </div>
      <OrdersTable rows={orders.data ?? []} onPick={(o) => setOpen(o.id)} testId="tk-orders" />
      {adding && <OrderForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void orders.reload(); }} />}
      {open && <OrderModal id={open} onClose={() => { setOpen(null); void orders.reload(); }} />}
    </section>
  );
}

function OrderForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useCustomers();
  const { f, bind } = useForm({ customer_id: '', new_name: '', site_name: '', area: '', block: '', street: '', phone: '', product: 'water_fresh', qty_l: '10000',
    from: new Date(Date.now() + 3 * 3_600_000 + 60 * 60_000).toISOString().slice(0, 16), unit_price: '', notes: '' });
  return (
    <Modal title="طلب توصيل جديد" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const le = me.legal_entities[0]?.id;
        let customer = f.customer_id;
        if (customer === 'new') customer = (await api<{ id: string }>('/customers', { method: 'POST', body: { legal_entity_id: le, kind: 'individual', name: f.new_name, ...clean({ phone: f.phone }) } })).id;
        await api('/tankers/orders', { method: 'POST', body: { legal_entity_id: le, customer_id: customer, site: clean({ name: f.site_name, area: f.area, block: f.block, street: f.street, phone: f.phone }),
          product: f.product, qty_l: Number(f.qty_l), from: kwIso(f.from), ...clean({ unit_price: f.unit_price, notes: f.notes }) } });
        onDone();
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option><option value="new">+ عميل جديد (فرد)</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          {f.customer_id === 'new' && <label className="field">اسم العميل<input {...bind('new_name')} required maxLength={200} /></label>}
        </div>
        <div className="row">
          <label className="field">الموقع<input {...bind('site_name')} maxLength={120} placeholder="عمارة، فيلا، موقع" /></label>
          <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
          <label className="field">القطعة<input {...bind('block')} maxLength={10} className="num" style={{ width: 70 }} /></label>
          <label className="field">الشارع<input {...bind('street')} maxLength={80} /></label>
          <label className="field">الهاتف<input {...bind('phone')} maxLength={20} className="num" dir="ltr" /></label>
        </div>
        <div className="row">
          <label className="field">المنتج<select {...bind('product')}>{Object.entries(TK_PRODUCT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">الكمية (لتر)<input {...bind('qty_l')} type="number" min={100} max={60000} step={100} required className="num" style={{ width: 110 }} /></label>
          <label className="field">من الساعة<input {...bind('from')} type="datetime-local" required /></label>
          <label className="field">السعر لكل 1000 لتر (د.ك)<input {...bind('unit_price')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
        </div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} placeholder="خزان السطح، المفتاح عند الحارس…" /></label>
        <p className="muted">نافذة التوصيل ساعتان من الوقت المحدد [تخمين].</p>
        <button disabled={act.busy}>حفظ الطلب</button>
      </form>
    </Modal>
  );
}

function OrderModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Order>(`/tankers/orders/${id}`), [id]);
  const workers = useLoad(() => api<{ data: { id: string; display_name: string }[] }>('/workers?status=active').then((x) => x.data));
  const tankers = useLoad(() => api<{ data: Tanker[] }>('/tankers/vehicles').then((x) => x.data));
  const act = useAction();
  const { f, bind } = useForm({ driver: '', tanker: '', loaded: '', delivered: '', received_by: '', reason: '' });
  const o = d.data;
  const w = can(me, 'tasks:assign');
  const run = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); await d.reload(); });
  const fit = (tankers.data ?? []).filter((t) => o && t.product_class === classOf(o.product) && (t.capacity_l ?? 0) >= o.qty_l && !['out_of_service', 'retired'].includes(t.status));
  return (
    <Modal title={o ? `طلب ${o.ref}` : 'طلب'} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {o && <div className="stack">
        <div className="row"><Tone map={TK_STATE} value={o.state} />{o.loss_flag && <Badge tone="danger">فاقد {o.loss_l} لتر ({o.loss_pct}%)</Badge>}{o.short && <Badge tone="warning">أقل من المطلوب</Badge>}</div>
        <dl className="dl">
          <dt>العميل</dt><dd>{o.customer_name} · {siteText(o.site)} {o.site.phone && <span className="num muted">{o.site.phone}</span>}</dd>
          <dt>المطلوب</dt><dd>{TK_PRODUCT[o.product]} · <span className="num">{L(o.qty_l)}</span> · <span className="num">{dt(o.wanted_from)}–{time(o.wanted_to)}</span></dd>
          {o.plate_no && <><dt>الصهريج</dt><dd><span className="num">{o.plate_no}</span> · {o.driver_name}{o.attempts > 1 && <span className="muted"> · المحاولة {o.attempts}</span>}</dd></>}
          {o.loaded_l !== null && <><dt>التعبئة</dt><dd className="num">{L(o.loaded_l)}{o.source && ` · ${o.source}`}</dd></>}
          {o.delivered_l !== null && <><dt>التفريغ</dt><dd><span className="num">{L(o.delivered_l)}</span> · استلم {o.received_by}{o.amount && <> · <b className="num">{money(o.amount)}</b></>}</dd></>}
          {o.notes && <><dt>ملاحظات</dt><dd>{o.notes}</dd></>}
        </dl>
        {w && ['new', 'failed'].includes(o.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/tankers/orders/${id}/assign`, { method: 'POST', body: { driver_worker_id: f.driver, asset_id: f.tanker } })); }}>
          <label className="field">الصهريج<select {...bind('tanker')} required><option value="">اختر</option>{fit.map((t) => <option key={t.asset_id} value={t.asset_id}>{t.plate_no} · {L(t.capacity_l)}</option>)}</select></label>
          <label className="field">السائق<select {...bind('driver')} required><option value="">اختر</option>{workers.data?.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
          <button disabled={act.busy}>{o.state === 'failed' ? 'إعادة الإسناد' : 'إسناد'}</button>
        </form>}
        {w && ['new', 'failed'].includes(o.state) && fit.length === 0 && <p className="muted">لا يوجد صهريج {TK_CLASS[classOf(o.product)]} بسعة كافية. سجّل الصهاريج من تبويب «الصهاريج».</p>}
        {w && ['assigned', 'on_way'].includes(o.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/tankers/orders/${id}/record`, { method: 'POST',
          body: { delivered_l: Number(f.delivered), received_by: f.received_by, ...(f.loaded ? { loaded_l: Number(f.loaded) } : {}) } })); }}>
          <label className="field">المعبأ (لتر)<input {...bind('loaded')} type="number" min={0} max={60000} className="num" style={{ width: 100 }} /></label>
          <label className="field">المفرّغ (لتر)<input {...bind('delivered')} type="number" min={0} max={60000} required className="num" style={{ width: 100 }} /></label>
          <label className="field">المستلم<input {...bind('received_by')} required maxLength={120} /></label>
          <button className="secondary" disabled={act.busy}>تسجيل من الإيصال</button>
        </form>}
        {w && ['new', 'assigned', 'failed'].includes(o.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/tankers/orders/${id}/cancel`, { method: 'POST', body: { reason: f.reason } })); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب الإلغاء" /><button className="danger" disabled={act.busy}>إلغاء الطلب</button>
        </form>}
      </div>}
    </Modal>
  );
}

function BoardView() {
  const [day, setDay] = useState(todayKw());
  const b = useLoad(() => api<{ orders: Order[] }>(`/tankers/board?date=${day}`), [day]);
  const [open, setOpen] = useState<string | null>(null);
  const by = new Map<string, Order[]>();
  for (const o of b.data?.orders ?? []) by.set(o.plate_no ?? 'بلا صهريج', [...(by.get(o.plate_no ?? 'بلا صهريج') ?? []), o]);
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={b.error} />
      {by.size === 0 ? <Empty>لا توجد طلبات</Empty> : <div className="stack" data-testid="tk-board">{[...by.entries()].map(([plate, list]) => (
        <section key={plate} className="card"><h3 style={{ margin: '0 0 4px' }}><span className="num">{plate}</span> <span className="muted">({list.length} · {L(list.reduce((s, o) => s + o.qty_l, 0))})</span></h3>
          <OrdersTable rows={list} onPick={(o) => setOpen(o.id)} testId={`tk-board-${plate}`} /></section>
      ))}</div>}
      {open && <OrderModal id={open} onClose={() => { setOpen(null); void b.reload(); }} />}
    </div>
  );
}

function SchedulesView() {
  const me = useMe();
  const act = useAction();
  const list = useLoad(() => api<{ data: { id: string; customer_name: string; site: Site; product: string; qty_l: number; days: number[]; at_time: string; unit_price: string | null; active: boolean; orders: number }[] }>('/tankers/schedules').then((r) => r.data));
  const customers = useCustomers();
  const { f, bind } = useForm({ customer_id: '', site_name: '', area: '', block: '', phone: '', product: 'water_fresh', qty_l: '10000', at_time: '08:00', unit_price: '' });
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [made, setMade] = useState<string[] | null>(null);
  const [day, setDay] = useState(todayKw());
  const w = can(me, 'tasks:assign');
  return (
    <div className="stack">
      <ErrorBox error={list.error ?? act.error} />
      {w && <section className="card"><h2>طلب ثابت جديد</h2>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api('/tankers/schedules', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, customer_id: f.customer_id, site: clean({ name: f.site_name, area: f.area, block: f.block, phone: f.phone }),
            product: f.product, qty_l: Number(f.qty_l), days, at_time: f.at_time, ...clean({ unit_price: f.unit_price }) } });
          await list.reload();
        }); }}>
          <div className="row">
            <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">الموقع<input {...bind('site_name')} maxLength={120} /></label>
            <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
            <label className="field">القطعة<input {...bind('block')} maxLength={10} className="num" style={{ width: 70 }} /></label>
          </div>
          <div className="row">
            <label className="field">المنتج<select {...bind('product')}>{Object.entries(TK_PRODUCT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">الكمية (لتر)<input {...bind('qty_l')} type="number" min={100} max={60000} step={100} required className="num" style={{ width: 110 }} /></label>
            <label className="field">الساعة<input {...bind('at_time')} type="time" required /></label>
            <label className="field">السعر لكل 1000 لتر<input {...bind('unit_price')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          </div>
          <div className="row" data-testid="tk-days">{WEEKDAYS.map((n, i) => (
            <label key={i} className="check"><input type="checkbox" style={{ width: 'auto' }} checked={days.includes(i)} onChange={(e) => setDays((d) => (e.target.checked ? [...d, i].sort() : d.filter((x) => x !== i)))} /> {n}</label>
          ))}</div>
          <button disabled={act.busy || days.length === 0}>حفظ الطلب الثابت</button>
        </form>
      </section>}
      <section className="card stack">
        {w && <div className="row"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الإنشاء" style={{ maxWidth: 180 }} />
          <button className="secondary" disabled={act.busy} onClick={() => void act.run(async () => { setMade((await api<{ created: string[] }>('/tankers/schedules/generate', { method: 'POST', body: { date: day } })).created); await list.reload(); })}>إنشاء طلبات اليوم</button>
          {made && <span data-testid="tk-generated">أُنشئ {made.length} طلب{made.length ? `: ${made.join('، ')}` : ''}</span>}</div>}
        {list.data?.length === 0 ? <Empty>لا توجد طلبات ثابتة</Empty> : <div className="tbl-wrap"><table data-testid="tk-schedules"><thead><tr><th>العميل والموقع</th><th>المنتج</th><th>الكمية</th><th>الأيام</th><th>الساعة</th><th>طلبات</th><th></th></tr></thead>
          <tbody>{list.data?.map((s) => (
            <tr key={s.id}><td>{s.customer_name} · {siteText(s.site)}</td><td>{TK_PRODUCT[s.product]}</td><td className="num">{L(s.qty_l)}</td><td>{s.days.length === 7 ? 'يوميًا' : s.days.map((x) => WEEKDAYS[x]).join('، ')}</td>
              <td className="num">{s.at_time}</td><td className="num">{s.orders}</td>
              <td>{!s.active ? <Badge>متوقف</Badge> : w && <button className="small secondary" onClick={() => void act.run(async () => { await api(`/tankers/schedules/${s.id}/stop`, { method: 'POST', body: {} }); await list.reload(); })}>إيقاف</button>}</td></tr>
          ))}</tbody></table></div>}
      </section>
    </div>
  );
}

function TankersView() {
  const me = useMe();
  const act = useAction();
  const t = useLoad(() => api<{ data: Tanker[] }>('/tankers/vehicles').then((r) => r.data));
  const [edit, setEdit] = useState<Record<string, { cls: string; cap: string }>>({});
  const w = can(me, 'fleet:write');
  return (
    <section className="card stack">
      <ErrorBox error={t.error ?? act.error} />
      <p className="muted" style={{ margin: 0 }}>سجّل كل صهريج بنوعه (ماء أو وقود) وسعته. لا يُسند طلب ديزل لصهريج ماء، ولا كمية أكبر من السعة.</p>
      {t.data?.length === 0 ? <Empty>لا توجد مركبات. أضفها من صفحة المركبات</Empty> : <div className="tbl-wrap"><table data-testid="tk-vehicles"><thead><tr><th>اللوحة</th><th>النوع</th><th>السعة</th><th></th></tr></thead>
        <tbody>{t.data?.map((v) => {
          const e = edit[v.asset_id] ?? { cls: v.product_class ?? 'water', cap: String(v.capacity_l ?? '') };
          return (
            <tr key={v.asset_id}><td className="num">{v.plate_no}</td>
              <td>{w ? <select value={e.cls} aria-label={`نوع ${v.plate_no}`} onChange={(x) => setEdit((p) => ({ ...p, [v.asset_id]: { ...e, cls: x.target.value } }))}>{Object.entries(TK_CLASS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select> : v.product_class ? TK_CLASS[v.product_class] : '—'}</td>
              <td>{w ? <input value={e.cap} aria-label={`سعة ${v.plate_no}`} type="number" min={500} max={60000} step={500} className="num" style={{ width: 110 }} onChange={(x) => setEdit((p) => ({ ...p, [v.asset_id]: { ...e, cap: x.target.value } }))} /> : L(v.capacity_l)}</td>
              <td>{w && <button className="small" disabled={act.busy || !e.cap} onClick={() => void act.run(async () => { await api(`/tankers/vehicles/${v.asset_id}`, { method: 'PUT', body: { product_class: e.cls, capacity_l: Number(e.cap) } }); await t.reload(); })}>
                {v.capacity_l ? 'تحديث' : 'تسجيل كصهريج'}</button>}{v.capacity_l && <> <Badge tone="success">صهريج {TK_CLASS[v.product_class!]}</Badge></>}</td></tr>
          );
        })}</tbody></table></div>}
    </section>
  );
}

function ExceptionsView() {
  const x = useLoad(() => api<{ unassigned: Order[]; late: Order[]; failed: Order[]; short: Order[]; losses: Order[] }>('/tankers/exceptions'));
  const [open, setOpen] = useState<string | null>(null);
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="بلا صهريج" value={d.unassigned.length} tone={d.unassigned.length ? 'warning' : undefined} />
          <Kpi label="متأخرة" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
          <Kpi label="تعذّرت" value={d.failed.length} tone={d.failed.length ? 'danger' : undefined} />
          <Kpi label="فاقد فوق المسموح" value={d.losses.length} tone={d.losses.length ? 'danger' : undefined} />
        </div>
        <section className="card"><h2>بلا صهريج (اليوم وغدًا)</h2><OrdersTable rows={d.unassigned} onPick={(o) => setOpen(o.id)} testId="ex-unassigned" /></section>
        <section className="card"><h2>تجاوزت نافذة التوصيل</h2><OrdersTable rows={d.late} onPick={(o) => setOpen(o.id)} testId="ex-late" /></section>
        <section className="card"><h2>تعذّرت وتحتاج إعادة إسناد</h2><OrdersTable rows={d.failed} onPick={(o) => setOpen(o.id)} testId="ex-failed" /></section>
        <section className="card"><h2>فاقد بين التعبئة والتفريغ فوق المسموح (وقود 0.5%، ماء 3%) [تخمين]</h2><OrdersTable rows={d.losses} onPick={(o) => setOpen(o.id)} testId="ex-losses" /></section>
        <section className="card"><h2>وُصّل أقل من المطلوب بأكثر من 5% [تخمين]</h2><OrdersTable rows={d.short} onPick={(o) => setOpen(o.id)} testId="ex-short" /></section>
      </>}
      {open && <OrderModal id={open} onClose={() => { setOpen(null); void x.reload(); }} />}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<{ totals: { orders: number; delivered: number; failed: number; ordered_l: number; delivered_l: number; loss_l: number; amount: string };
    products: { product: string; orders: number; ordered_l: number; delivered_l: number; loss_l: number; amount: string }[]; tankers: { plate_no: string; trips: number; delivered_l: number; loss_l: number }[] }>(`/tankers/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4" data-testid="tk-kpis">
          <Kpi label="طلبات" value={`${x.delivered} وُصّل / ${x.orders}`} />
          <Kpi label="لترات مفرّغة" value={L(x.delivered_l)} />
          <Kpi label="الفاقد" value={L(x.loss_l)} tone={x.loss_l > 0 ? 'warning' : 'success'} />
          <Kpi label="المبلغ" value={money(x.amount)} />
        </div>
        <section className="card"><h2>حسب المنتج</h2>
          {r.data!.products.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="tk-products"><thead><tr><th>المنتج</th><th>طلبات</th><th>المطلوب</th><th>المفرّغ</th><th>الفاقد</th><th>المبلغ</th></tr></thead>
            <tbody>{r.data!.products.map((p) => <tr key={p.product}><td>{TK_PRODUCT[p.product]}</td><td className="num">{p.orders}</td><td className="num">{L(p.ordered_l)}</td><td className="num">{L(p.delivered_l)}</td><td className="num">{L(p.loss_l)}</td><td className="num">{money(p.amount)}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>حسب الصهريج</h2>
          {r.data!.tankers.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="tk-tankers"><thead><tr><th>الصهريج</th><th>رحلات</th><th>المفرّغ</th><th>الفاقد</th></tr></thead>
            <tbody>{r.data!.tankers.map((p) => <tr key={p.plate_no}><td className="num">{p.plate_no}</td><td className="num">{p.trips}</td><td className="num">{L(p.delivered_l)}</td><td className="num">{L(p.loss_l)}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
