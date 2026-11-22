'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, LOC_KIND, qtyText, TASK_STATUS, todayKw, WH_ORDER_STATUS, WH_UNIT } from '@/lib/format';
import { can, hasPack, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Loc { id: string; code: string; kind: string; active: boolean }
interface Wh { id: string; legal_entity_id: string; code: string; name: string; area: string | null; active: boolean; locations: Loc[] }
interface Item { id: string; customer_id: string | null; customer_name: string | null; sku: string; name: string; unit: string; min_qty: number | null; track_expiry: boolean; active: boolean; on_hand: number }
interface Stock { item_id: string; sku: string; item_name: string; unit: string; customer_name: string | null; location_id: string; location_code: string; location_kind: string; warehouse_code: string; lot: string | null; expiry: string | null; qty: number }
interface Variance { item_id: string; sku?: string; expected: number; received: number; diff: number }
interface Receipt { id: string; warehouse_code: string; customer_name: string | null; ref: string; received_at: string; lines: { sku: string; qty: number; location_code: string; lot: string | null; expiry: string | null }[] | null; variance: Variance[] }
interface OLine { item_id: string; qty: number; sku?: string; name?: string; unit?: string }
interface PickRow { item_id: string; sku?: string; location_code: string; lot: string | null; expiry: string | null; qty: number }
interface Order {
  id: string; warehouse_code: string; customer_id: string | null; customer_name: string | null; ref: string; lines: OLine[]; ship_to: Record<string, string> | null; due_at: string | null; status: string;
  picked_at: string | null; shipped_at: string | null; delivery_task_id: string | null; delivery_status: string | null; cancel_reason: string | null; created_at: string;
  plan?: { picks: PickRow[]; short: { item_id: string; qty: number }[] } | null; picks?: PickRow[];
}
type Tab = 'stock' | 'receive' | 'orders' | 'exceptions' | 'report' | 'setup';

const useWh = () => useLoad(() => api<{ data: Wh[] }>('/warehouse/warehouses').then((r) => r.data));
const useItems = () => useLoad(() => api<{ data: Item[] }>('/warehouse/items').then((r) => r.data));
const useCustomers = () => useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((r) => r.data.filter((c) => c.status === 'active')).catch(() => []));
const ownerName = (n: string | null) => n ?? 'بضاعة الشركة';

/** Warehousing (sector 8): stock by location, goods in, outbound orders picked first-expiry-first-out, exceptions, the report and setup. */
export default function WarehousePage() {
  const [tab, setTab] = useState<Tab>('stock');
  return (
    <div className="page stack">
      <div className="page-head"><h1>المستودعات</h1></div>
      <Tabs tabs={[['stock', 'المخزون'], ['receive', 'الاستلام'], ['orders', 'أوامر الصرف'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير'], ['setup', 'المستودعات والأصناف']]} value={tab} onChange={setTab} />
      {tab === 'stock' && <StockView />}
      {tab === 'receive' && <ReceiveView />}
      {tab === 'orders' && <OrdersView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
      {tab === 'setup' && <SetupView />}
    </div>
  );
}

function StockView() {
  const me = useMe();
  const [q, setQ] = useState('');
  const stock = useLoad(() => api<{ data: Stock[] }>('/warehouse/stock').then((r) => r.data));
  const [act, setAct] = useState<{ kind: 'move' | 'count'; row: Stock } | null>(null);
  const rows = (stock.data ?? []).filter((s) => !q || `${s.sku} ${s.item_name} ${s.location_code} ${s.customer_name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const today = todayKw();
  return (
    <section className="card stack">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="صنف أو موقع أو عميل" aria-label="بحث في المخزون" style={{ maxWidth: 320 }} />
      <ErrorBox error={stock.error} />
      {rows.length === 0 ? <Empty>لا يوجد مخزون</Empty> : (
        <div className="tbl-wrap"><table data-testid="stock"><thead><tr><th>الصنف</th><th>المالك</th><th>الموقع</th><th>الدفعة</th><th>الصلاحية</th><th>الكمية</th><th></th></tr></thead>
          <tbody>{rows.map((s, i) => (
            <tr key={i}><td><span className="num">{s.sku}</span> {s.item_name}</td><td>{ownerName(s.customer_name)}</td>
              <td className="num">{s.warehouse_code} · {s.location_code}{s.location_kind !== 'storage' && <> <Badge tone={s.location_kind === 'quarantine' ? 'danger' : 'info'}>{LOC_KIND[s.location_kind]}</Badge></>}</td>
              <td className="num">{s.lot ?? '—'}</td><td className="num">{s.expiry ? <Badge tone={s.expiry < today ? 'danger' : 'muted'}>{s.expiry}</Badge> : '—'}</td>
              <td className="num">{qtyText(s.qty)} {WH_UNIT[s.unit]}</td>
              <td>{can(me, 'tasks:write') && <><button className="small" onClick={() => setAct({ kind: 'move', row: s })}>نقل</button> <button className="small" onClick={() => setAct({ kind: 'count', row: s })}>جرد</button></>}</td></tr>
          ))}</tbody></table></div>
      )}
      {act && <StockAction a={act} onClose={() => setAct(null)} onDone={() => { setAct(null); void stock.reload(); }} />}
    </section>
  );
}

function StockAction({ a, onClose, onDone }: { a: { kind: 'move' | 'count'; row: Stock }; onClose: () => void; onDone: () => void }) {
  const whs = useWh();
  const act = useAction();
  const { f, bind } = useForm({ to: '', qty: String(a.row.qty), counted: String(a.row.qty), reason: '' });
  const locs = whs.data?.find((w) => w.code === a.row.warehouse_code)?.locations.filter((l) => l.active && l.id !== a.row.location_id) ?? [];
  return (
    <Modal title={`${a.kind === 'move' ? 'نقل' : 'جرد'} ${a.row.sku} من ${a.row.location_code}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        if (a.kind === 'move') await api('/warehouse/moves', { method: 'POST', body: { item_id: a.row.item_id, from_location_id: a.row.location_id, to_location_id: f.to, qty: Number(f.qty), ...clean({ lot: a.row.lot ?? '' }) } });
        else await api('/warehouse/counts', { method: 'POST', body: { item_id: a.row.item_id, location_id: a.row.location_id, counted_qty: Number(f.counted), reason: f.reason, ...clean({ lot: a.row.lot ?? '' }) } });
        onDone();
      }); }}>
        <ErrorBox error={act.error ?? whs.error} />
        {a.kind === 'move' ? <div className="form-2">
          <label className="field">إلى الموقع<select {...bind('to')} required><option value="">اختر</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></label>
          <label className="field">الكمية<input {...bind('qty')} type="number" className="num" min={0.01} step={0.01} max={a.row.qty} required /></label>
        </div> : <div className="form-2">
          <label className="field">الكمية المعدودة (النظام {qtyText(a.row.qty)})<input {...bind('counted')} type="number" className="num" min={0} step={0.01} required /></label>
          <label className="field">السبب<input {...bind('reason')} required maxLength={300} placeholder="جرد دوري، تلف، فقد…" /></label>
        </div>}
        <div className="row"><button className="primary" disabled={act.busy}>{a.kind === 'move' ? 'نقل' : 'تسجيل الجرد'}</button></div>
      </form>
    </Modal>
  );
}

interface RLine { item_id: string; qty: string; location_id: string; lot: string; expiry: string }
function ReceiveView() {
  const me = useMe();
  const whs = useWh();
  const items = useItems();
  const customers = useCustomers();
  const list = useLoad(() => api<{ data: Receipt[] }>('/warehouse/receipts').then((r) => r.data));
  const act = useAction();
  const [wh, setWh] = useState('');
  const [owner, setOwner] = useState('');
  const [ref, setRef] = useState('');
  const [lines, setLines] = useState<RLine[]>([{ item_id: '', qty: '', location_id: '', lot: '', expiry: '' }]);
  const [result, setResult] = useState<Variance[] | null>(null);
  const locs = whs.data?.find((w) => w.id === wh)?.locations.filter((l) => l.active) ?? [];
  const ownItems = items.data?.filter((i) => i.active && (i.customer_id ?? '') === owner) ?? [];
  const set = (i: number, p: Partial<RLine>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const sku = (id: string) => items.data?.find((i) => i.id === id)?.sku ?? id;
  return (
    <div className="stack">
      {can(me, 'tasks:write') && <section className="card stack">
        <h3>استلام بضاعة</h3>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          const r = await api<{ variance: Variance[] }>('/warehouse/receipts', { method: 'POST', body: { warehouse_id: wh, ref, ...clean({ customer_id: owner }),
            lines: lines.filter((l) => l.item_id && l.qty).map((l) => ({ item_id: l.item_id, qty: Number(l.qty), location_id: l.location_id, ...clean({ lot: l.lot, expiry: l.expiry }) })) } });
          setResult(r.variance); setRef(''); setLines([{ item_id: '', qty: '', location_id: '', lot: '', expiry: '' }]); await list.reload();
        }); }}>
          <div className="form-2">
            <label className="field">المستودع<select name="warehouse_id" value={wh} onChange={(e) => setWh(e.target.value)} required><option value="">اختر</option>{whs.data?.filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
            <label className="field">المالك<select name="owner" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">بضاعة الشركة</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">رقم إذن الاستلام<input name="ref" value={ref} onChange={(e) => setRef(e.target.value)} required maxLength={40} className="num" /></label>
          </div>
          {lines.map((l, i) => {
            const it = items.data?.find((x) => x.id === l.item_id);
            return (
              <div key={i} className="row" data-testid={`rline-${i + 1}`}>
                <select value={l.item_id} onChange={(e) => set(i, { item_id: e.target.value })} aria-label={`صنف السطر ${i + 1}`} required={i === 0}><option value="">الصنف</option>{ownItems.map((x) => <option key={x.id} value={x.id}>{x.sku} · {x.name}</option>)}</select>
                <input value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} type="number" min={0.01} step={0.01} className="num" placeholder="الكمية" aria-label={`كمية السطر ${i + 1}`} style={{ width: 100 }} required={!!l.item_id} />
                <select value={l.location_id} onChange={(e) => set(i, { location_id: e.target.value })} aria-label={`موقع السطر ${i + 1}`} required={!!l.item_id}><option value="">الموقع</option>{locs.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>
                <input value={l.lot} onChange={(e) => set(i, { lot: e.target.value })} maxLength={40} placeholder="الدفعة" aria-label={`دفعة السطر ${i + 1}`} style={{ width: 100 }} />
                <input value={l.expiry} onChange={(e) => set(i, { expiry: e.target.value })} type="date" aria-label={`صلاحية السطر ${i + 1}`} required={!!it?.track_expiry} title="الصلاحية" />
              </div>
            );
          })}
          <div className="row"><button type="button" className="small" onClick={() => setLines((ls) => [...ls, { item_id: '', qty: '', location_id: '', lot: '', expiry: '' }])}>+ سطر</button>
            <button className="primary" disabled={act.busy}>تسجيل الاستلام</button></div>
        </form>
        <ErrorBox error={act.error ?? whs.error ?? items.error} />
        {result && (result.length === 0 ? <div className="alert ok">سُجّل الاستلام.</div>
          : <div className="alert warn">سُجّل الاستلام بفروق عن الإشعار: {result.map((v) => `${sku(v.item_id)} ${v.diff > 0 ? '+' : ''}${qtyText(v.diff)}`).join('، ')}</div>)}
      </section>}
      <section className="card">
        <h3>آخر الاستلامات</h3>
        {list.data?.length === 0 ? <Empty>لا توجد استلامات</Empty> : (
          <div className="tbl-wrap"><table data-testid="receipts"><thead><tr><th>الإذن</th><th>المستودع</th><th>المالك</th><th>الأصناف</th><th>الوقت</th><th></th></tr></thead>
            <tbody>{list.data?.map((r) => <tr key={r.id}><td className="num">{r.ref}</td><td className="num">{r.warehouse_code}</td><td>{ownerName(r.customer_name)}</td>
              <td>{r.lines?.map((l) => `${l.sku} ${qtyText(l.qty)} ← ${l.location_code}`).join('، ')}</td><td className="num">{dt(r.received_at)}</td>
              <td>{r.variance.length > 0 && <Badge tone="warning">فروق عن الإشعار</Badge>}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}

function OrdersView() {
  const me = useMe();
  const [status, setStatus] = useState('active');
  const list = useLoad(() => api<{ data: Order[] }>(`/warehouse/orders?status=${status}`).then((r) => r.data), [status]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة"><option value="active">المفتوحة والمجموعة</option><option value="shipped">المشحونة</option><option value="canceled">الملغاة</option></select>
        {can(me, 'tasks:write') && <button className="primary" onClick={() => setAdding(true)}>أمر صرف جديد</button>}
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا توجد أوامر</Empty> : (
        <div className="tbl-wrap"><table data-testid="orders"><thead><tr><th>الأمر</th><th>المستودع</th><th>المالك</th><th>الأسطر</th><th>إلى</th><th>الموعد</th><th>الحالة</th></tr></thead>
          <tbody>{list.data?.map((o) => <tr key={o.id}><td><button className="link num" onClick={() => setOpen(o.id)} aria-label={`الأمر ${o.ref}`}>{o.ref}</button></td>
            <td className="num">{o.warehouse_code}</td><td>{ownerName(o.customer_name)}</td><td className="num">{o.lines.length}</td><td>{o.ship_to?.name ?? '—'}</td>
            <td className="num">{o.due_at ? dt(o.due_at) : '—'}</td><td><Tone map={WH_ORDER_STATUS} value={o.status} /></td></tr>)}</tbody></table></div>
      )}
      {adding && <NewOrder onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); void list.reload(); setOpen(id); }} />}
      {open && <OrderModal id={open} onClose={() => setOpen(null)} onChange={() => void list.reload()} />}
    </section>
  );
}

function NewOrder({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const whs = useWh();
  const items = useItems();
  const customers = useCustomers();
  const act = useAction();
  const { f, bind } = useForm({ warehouse_id: '', customer_id: '', ref: '', due_at: '', name: '', phone: '', area: '', block: '', street: '', house: '' });
  const [lines, setLines] = useState<{ item_id: string; qty: string }[]>([{ item_id: '', qty: '' }]);
  const own = items.data?.filter((i) => i.active && (i.customer_id ?? '') === f.customer_id) ?? [];
  return (
    <Modal title="أمر صرف جديد" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const shipTo = clean({ name: f.name, phone: f.phone, area: f.area, block: f.block, street: f.street, house: f.house });
        const r = await api<Order>('/warehouse/orders', { method: 'POST', body: { warehouse_id: f.warehouse_id, ref: f.ref, ...clean({ customer_id: f.customer_id }),
          ...(f.due_at ? { due_at: new Date(`${f.due_at}:00+03:00`).toISOString() } : {}), ...(Object.keys(shipTo).length ? { ship_to: shipTo } : {}),
          lines: lines.filter((l) => l.item_id && l.qty).map((l) => ({ item_id: l.item_id, qty: Number(l.qty) })) } });
        onDone(r.id);
      }); }}>
        <ErrorBox error={act.error ?? whs.error ?? items.error} />
        <div className="form-2">
          <label className="field">المستودع<select {...bind('warehouse_id')} required><option value="">اختر</option>{whs.data?.filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
          <label className="field">المالك<select {...bind('customer_id')}><option value="">بضاعة الشركة</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">رقم الأمر<input {...bind('ref')} required maxLength={40} className="num" /></label>
          <label className="field">الشحن قبل<input {...bind('due_at')} type="datetime-local" /></label>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="row">
            <select value={l.item_id} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, item_id: e.target.value } : x)))} aria-label={`صنف ${i + 1}`} required={i === 0}>
              <option value="">الصنف</option>{own.map((x) => <option key={x.id} value={x.id}>{x.sku} · {x.name} (متوفر {qtyText(x.on_hand)})</option>)}</select>
            <input value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, qty: e.target.value } : x)))} type="number" min={0.01} step={0.01} className="num" placeholder="الكمية" aria-label={`كمية ${i + 1}`} style={{ width: 110 }} required={!!l.item_id} />
          </div>
        ))}
        <div className="row"><button type="button" className="small" onClick={() => setLines((ls) => [...ls, { item_id: '', qty: '' }])}>+ صنف</button></div>
        <fieldset><legend>الشحن إلى (اختياري، ويلزم الجوال والمنطقة لإنشاء مهمة توصيل)</legend>
          <div className="form-2">
            <label className="field">الاسم<input {...bind('name')} maxLength={120} /></label>
            <label className="field">الجوال<input {...bind('phone')} className="num" inputMode="tel" maxLength={20} /></label>
            <label className="field">المنطقة<input {...bind('area')} maxLength={80} /></label>
            <label className="field">القطعة<input {...bind('block')} maxLength={20} /></label>
            <label className="field">الشارع<input {...bind('street')} maxLength={80} /></label>
            <label className="field">المنزل<input {...bind('house')} maxLength={20} /></label>
          </div>
        </fieldset>
        <div className="row"><button className="primary" disabled={act.busy}>إنشاء الأمر</button></div>
      </form>
    </Modal>
  );
}

function OrderModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Order>(`/warehouse/orders/${id}`), [id]);
  const items = useItems();
  const act = useAction();
  const [reason, setReason] = useState('');
  const o = d.data;
  const sku = (iid: string) => items.data?.find((i) => i.id === iid)?.sku ?? '';
  const run = (path: string, body: Record<string, unknown> = {}) => act.run(async () => { await api(`/warehouse/orders/${id}/${path}`, { method: 'POST', body }); await d.reload(); onChange(); });
  const write = can(me, 'tasks:write');
  const delivers = hasPack(me, 'delivery|courier');
  const picks = o?.status === 'open' ? o.plan?.picks ?? [] : o?.picks ?? [];
  return (
    <Modal title={o ? `الأمر ${o.ref}` : 'الأمر'} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {o && <div className="stack">
        <dl className="dl">
          <dt>الحالة</dt><dd><Tone map={WH_ORDER_STATUS} value={o.status} />{o.cancel_reason && <span className="muted"> {o.cancel_reason}</span>}</dd>
          <dt>المالك</dt><dd>{ownerName(o.customer_name)}</dd>
          <dt>الأصناف</dt><dd>{o.lines.map((l) => `${l.sku} ${l.name ?? ''} ${qtyText(l.qty)} ${WH_UNIT[l.unit ?? ''] ?? ''}`).join('، ')}</dd>
          {o.ship_to && <><dt>إلى</dt><dd>{[o.ship_to.name, o.ship_to.phone, o.ship_to.area].filter(Boolean).join(' · ')}</dd></>}
          {o.due_at && <><dt>الشحن قبل</dt><dd className="num">{dt(o.due_at)}</dd></>}
          {o.shipped_at && <><dt>شُحن</dt><dd className="num">{dt(o.shipped_at)}{o.delivery_task_id && <> · <a href="/tasks?status=ready">مهمة توصيل في قائمة المهام</a>{o.delivery_status && <> (<Tone map={TASK_STATUS} value={o.delivery_status} />)</>}</>}</dd></>}
        </dl>
        <section className="card">
          <h3>{o.status === 'open' ? 'خطة الالتقاط المقترحة (أقدم صلاحية أولًا)' : 'ما جُمع'}</h3>
          {picks.length === 0 ? <Empty>لا يوجد</Empty> : (
            <div className="tbl-wrap"><table data-testid="picks"><thead><tr><th>الموقع</th><th>الصنف</th><th>الدفعة</th><th>الصلاحية</th><th>الكمية</th></tr></thead>
              <tbody>{picks.map((p, i) => <tr key={i}><td className="num">{p.location_code}</td><td className="num">{p.sku ?? sku(p.item_id)}</td><td className="num">{p.lot ?? '—'}</td><td className="num">{p.expiry ?? '—'}</td><td className="num">{qtyText(p.qty)}</td></tr>)}</tbody></table></div>
          )}
          {o.status === 'open' && (o.plan?.short.length ?? 0) > 0 && <div className="alert warn" data-testid="short">المخزون لا يكفي: {o.plan!.short.map((s) => `${sku(s.item_id)} ينقص ${qtyText(s.qty)}`).join('، ')}</div>}
        </section>
        {write && <div className="row">
          {o.status === 'open' && <button className="primary" disabled={act.busy || (o.plan?.short.length ?? 0) > 0} onClick={() => run('pick')}>تأكيد الالتقاط</button>}
          {o.status === 'picked' && <>
            <button className="primary" disabled={act.busy} onClick={() => run('ship')}>شُحن (استلام العميل أو ناقل)</button>
            {delivers && <button disabled={act.busy || !o.ship_to?.phone || !o.ship_to?.area} onClick={() => run('ship', { delivery: true })} title="ينشئ مهمة توصيل لأسطولنا">شحن بأسطولنا (مهمة توصيل)</button>}
          </>}
        </div>}
        {write && ['open', 'picked'].includes(o.status) && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run('cancel', { reason }); }}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} placeholder="سبب الإلغاء" aria-label="سبب الإلغاء" />
            <button className="danger" disabled={act.busy}>إلغاء الأمر{o.status === 'picked' ? ' وإرجاع البضاعة لمواقعها' : ''}</button>
          </form>
        )}
      </div>}
    </Modal>
  );
}

function ExceptionsView() {
  const ex = useLoad(() => api<{ low: (Item & { customer_name: string | null })[]; expiring: (Stock & { expired: boolean })[]; late: Order[]; variance: { id: string; ref: string; warehouse_code: string; customer_name: string | null; received_at: string; variance: Variance[] }[] }>('/warehouse/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="أصناف تحت حد الطلب" value={d.low.length} tone={d.low.length ? 'warning' : undefined} />
        <Kpi label="صلاحية خلال 30 يومًا" value={d.expiring.length} tone={d.expiring.some((x) => x.expired) ? 'danger' : d.expiring.length ? 'warning' : undefined} />
        <Kpi label="أوامر متأخرة" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
        <Kpi label="استلامات بفروق" value={d.variance.length} />
      </div>
      <section className="card"><h2>تحت حد إعادة الطلب</h2>
        {d.low.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-low"><thead><tr><th>الصنف</th><th>المالك</th><th>المتوفر</th><th>الحد</th></tr></thead>
          <tbody>{d.low.map((x) => <tr key={x.id}><td><span className="num">{x.sku}</span> {x.name}</td><td>{ownerName(x.customer_name)}</td><td className="num">{qtyText(x.on_hand)}</td><td className="num">{qtyText(x.min_qty)}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="card"><h2>الصلاحية</h2><p className="muted">منتهية أو تنتهي خلال 30 يومًا [تخمين]. المنتهية لا تُلتقط تلقائيًا.</p>
        {d.expiring.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-expiry"><thead><tr><th>الصنف</th><th>المالك</th><th>الموقع</th><th>الدفعة</th><th>الصلاحية</th><th>الكمية</th></tr></thead>
          <tbody>{d.expiring.map((x, i) => <tr key={i}><td><span className="num">{x.sku}</span> {x.item_name}</td><td>{ownerName(x.customer_name)}</td><td className="num">{x.location_code}</td><td className="num">{x.lot ?? '—'}</td>
            <td><Badge tone={x.expired ? 'danger' : 'warning'}>{x.expiry}</Badge></td><td className="num">{qtyText(x.qty)}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="card"><h2>أوامر متأخرة</h2><p className="muted">تجاوزت موعد الشحن، أو مفتوحة منذ أكثر من 24 ساعة بلا موعد [تخمين].</p>
        {d.late.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-late"><thead><tr><th>الأمر</th><th>المالك</th><th>الموعد</th><th>الحالة</th></tr></thead>
          <tbody>{d.late.map((o) => <tr key={o.id}><td className="num">{o.ref}</td><td>{ownerName(o.customer_name)}</td><td className="num">{o.due_at ? dt(o.due_at) : '—'}</td><td><Tone map={WH_ORDER_STATUS} value={o.status} /></td></tr>)}</tbody></table></div>}
      </section>
      <section className="card"><h2>استلامات بفروق عن الإشعار (7 أيام)</h2>
        {d.variance.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-variance"><thead><tr><th>الإذن</th><th>المالك</th><th>الفروق</th><th>الوقت</th></tr></thead>
          <tbody>{d.variance.map((r) => <tr key={r.id}><td className="num">{r.ref}</td><td>{ownerName(r.customer_name)}</td><td className="num">{r.variance.map((v) => `${v.sku} ${v.diff > 0 ? '+' : ''}${qtyText(v.diff)}`).join('، ')}</td><td className="num">{dt(r.received_at)}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<{ data: { customer_id: string | null; customer_name: string | null; receipts: number; units_in: number; units_picked: number; count_diff: number; orders_shipped: number; on_time_pct: number | null; avg_hours_to_ship: number | null; on_hand: number; locations: number }[]; totals: { receipts: number; units_in: number; units_picked: number; orders_shipped: number; on_hand: number; locations: number } }>(`/warehouse/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="وحدات مستلمة" value={qtyText(x.units_in)} />
          <Kpi label="وحدات مصروفة" value={qtyText(x.units_picked)} />
          <Kpi label="أوامر مشحونة" value={x.orders_shipped} />
          <Kpi label="مواقع مشغولة الآن" value={x.locations} />
        </div>
        <section className="card">
          {r.data!.data.length === 0 ? <Empty>لا توجد حركة</Empty> : (
            <div className="tbl-wrap"><table data-testid="wh-report"><thead><tr><th>المالك</th><th>استلامات</th><th>وحدات مستلمة</th><th>وحدات مصروفة</th><th>فروق الجرد</th><th>أوامر مشحونة</th><th>في الموعد</th><th>ساعات حتى الشحن</th><th>المخزون الآن</th><th>المواقع</th></tr></thead>
              <tbody>{r.data!.data.map((s) => <tr key={s.customer_id ?? '-'}><td>{ownerName(s.customer_name)}</td><td className="num">{s.receipts}</td><td className="num">{qtyText(s.units_in)}</td><td className="num">{qtyText(s.units_picked)}</td>
                <td className="num">{qtyText(s.count_diff)}</td><td className="num">{s.orders_shipped}</td><td className="num">{s.on_time_pct === null ? '—' : `${s.on_time_pct}%`}</td><td className="num">{s.avg_hours_to_ship ?? '—'}</td>
                <td className="num">{qtyText(s.on_hand)}</td><td className="num">{s.locations}</td></tr>)}</tbody></table></div>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>المواقع المشغولة أساس لفوترة التخزين للعملاء؛ السعر من عقد العميل [تحقق محلي].</p>
        </section>
      </>}
    </div>
  );
}

function SetupView() {
  const me = useMe();
  const whs = useWh();
  const items = useItems();
  const customers = useCustomers();
  const act = useAction();
  const w = useForm({ code: '', name: '', area: '' });
  const l = useForm({ warehouse_id: '', codes: '', kind: 'storage' });
  const it = useForm({ customer_id: '', sku: '', name: '', unit: 'piece', min_qty: '', track_expiry: false as boolean });
  const le = me.legal_entities[0]?.id;
  return (
    <div className="stack">
      <ErrorBox error={act.error ?? whs.error ?? items.error} />
      <section className="card stack">
        <h3>المستودعات والمواقع</h3>
        {can(me, 'org:write') && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api('/warehouse/warehouses', { method: 'POST', body: { legal_entity_id: le, code: w.f.code, name: w.f.name, ...clean({ area: w.f.area }) } }); w.setF({ code: '', name: '', area: '' }); await whs.reload();
        }); }}>
          <input {...w.bind('code')} placeholder="الرمز" required maxLength={12} className="num" style={{ width: 110 }} aria-label="رمز المستودع" />
          <input {...w.bind('name')} placeholder="اسم المستودع" required maxLength={120} aria-label="اسم المستودع" />
          <input {...w.bind('area')} placeholder="المنطقة" maxLength={80} aria-label="منطقة المستودع" />
          <button disabled={act.busy}>إضافة مستودع</button>
        </form>}
        {can(me, 'tasks:write') && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api(`/warehouse/warehouses/${l.f.warehouse_id}/locations`, { method: 'POST', body: { kind: l.f.kind, codes: l.f.codes.split(/[\s,،]+/).filter(Boolean) } }); l.setF({ ...l.f, codes: '' }); await whs.reload();
        }); }}>
          <select {...l.bind('warehouse_id')} required aria-label="مستودع المواقع"><option value="">المستودع</option>{whs.data?.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>
          <input {...l.bind('codes')} placeholder="رموز المواقع: A-01 A-02 …" required className="num" aria-label="رموز المواقع" />
          <select {...l.bind('kind')} aria-label="نوع المواقع">{Object.entries(LOC_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <button disabled={act.busy}>إضافة مواقع</button>
        </form>}
        {whs.data?.length === 0 ? <Empty>لا توجد مستودعات بعد</Empty> : (
          <div className="tbl-wrap"><table data-testid="warehouses"><thead><tr><th>الرمز</th><th>الاسم</th><th>المواقع</th></tr></thead>
            <tbody>{whs.data?.map((x) => <tr key={x.id}><td className="num">{x.code}</td><td>{x.name}</td><td className="num">{x.locations.map((y) => y.code + (y.kind !== 'storage' ? ` (${LOC_KIND[y.kind]})` : '')).join('، ') || '—'}</td></tr>)}</tbody></table></div>
        )}
      </section>
      <section className="card stack">
        <h3>الأصناف</h3>
        {can(me, 'tasks:write') && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api('/warehouse/items', { method: 'POST', body: { legal_entity_id: le, sku: it.f.sku, name: it.f.name, unit: it.f.unit, track_expiry: it.f.track_expiry, ...clean({ customer_id: it.f.customer_id }), ...(it.f.min_qty ? { min_qty: Number(it.f.min_qty) } : {}) } });
          it.setF({ ...it.f, sku: '', name: '', min_qty: '' }); await items.reload();
        }); }}>
          <select {...it.bind('customer_id')} aria-label="مالك الصنف"><option value="">بضاعة الشركة</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input {...it.bind('sku')} placeholder="SKU" required maxLength={40} className="num" style={{ width: 110 }} aria-label="رمز الصنف" />
          <input {...it.bind('name')} placeholder="اسم الصنف" required maxLength={120} aria-label="اسم الصنف" />
          <select {...it.bind('unit')} aria-label="الوحدة">{Object.entries(WH_UNIT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input {...it.bind('min_qty')} type="number" min={0} step={0.01} placeholder="حد الطلب" className="num" style={{ width: 100 }} aria-label="حد إعادة الطلب" />
          <label className="row" style={{ gap: 4 }}><input {...it.check('track_expiry')} /> له صلاحية</label>
          <button disabled={act.busy}>إضافة صنف</button>
        </form>}
        {items.data?.length === 0 ? <Empty>لا توجد أصناف بعد</Empty> : (
          <div className="tbl-wrap"><table data-testid="items"><thead><tr><th>SKU</th><th>الاسم</th><th>المالك</th><th>الوحدة</th><th>المتوفر</th><th>حد الطلب</th></tr></thead>
            <tbody>{items.data?.map((x) => <tr key={x.id}><td className="num">{x.sku}</td><td>{x.name}{x.track_expiry && <> <Badge tone="info">صلاحية</Badge></>}</td><td>{ownerName(x.customer_name)}</td><td>{WH_UNIT[x.unit]}</td>
              <td className="num">{qtyText(x.on_hand)}</td><td className="num">{x.min_qty === null ? '—' : qtyText(x.min_qty)}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}
