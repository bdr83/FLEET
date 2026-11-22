'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { COURIER_SERVICE, dt, ECOM_SOURCE, ECOM_STATUS, FAIL_REASON, money, todayKw } from '@/lib/format';
import { can, hasPack, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Merchant { customer_id: string; name: string; pickup: Record<string, string> | null; default_service: string; warehouse_id: string | null; warehouse_code: string | null; max_attempts: number; active: boolean; keys: number; orders: number }
interface Key { id: string; hint: string; label: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface Order {
  id: string; customer_id: string; merchant_name: string; external_id: string; source: string; status: string; awb: string | null; created_at: string; updated_at: string;
  attributes: { recipient?: { name?: string; phone?: string }; dropoff?: { area?: string }; cod_amount?: string } | null;
  cod_collected: string | null; fail_reason: string | null; return_task_id: string | null; return_status: string | null; return_reason: string | null; wh_ref: string | null;
}
interface ImportResult { line: number; external_id: string | null; result: 'created' | 'duplicate' | 'error'; error?: string }
type Tab = 'orders' | 'import' | 'exceptions' | 'statement' | 'stores';

const useMerchants = () => useLoad(() => api<{ data: Merchant[] }>('/ecommerce/merchants').then((r) => r.data));

/** E-commerce fulfilment (sector 9): stores send orders by API key or file; each becomes a parcel, a delivery or a warehouse order. */
export default function EcommercePage() {
  const [tab, setTab] = useState<Tab>('orders');
  return (
    <div className="page stack">
      <div className="page-head"><h1>طلبات المتاجر</h1></div>
      <Tabs tabs={[['orders', 'الطلبات'], ['import', 'إدخال واستيراد'], ['exceptions', 'الاستثناءات'], ['statement', 'كشف المتجر'], ['stores', 'المتاجر والمفاتيح']]} value={tab} onChange={setTab} />
      {tab === 'orders' && <OrdersView />}
      {tab === 'import' && <ImportView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'statement' && <StatementView />}
      {tab === 'stores' && <StoresView />}
    </div>
  );
}

const who = (o: Order) => [o.attributes?.recipient?.name, o.attributes?.dropoff?.area].filter(Boolean).join(' · ') || '—';

function OrdersTable({ rows, onPick, testId }: { rows: Order[]; onPick?: (o: Order) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا توجد طلبات</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>رقم الطلب</th><th>المتجر</th><th>المستلم</th><th>البوليصة</th><th>الحالة</th><th>COD</th><th>آخر تحديث</th><th></th></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id}><td className="num">{o.external_id} <Badge>{ECOM_SOURCE[o.source]}</Badge></td><td>{o.merchant_name}</td><td>{who(o)}</td><td className="num">{o.awb ?? o.wh_ref ?? '—'}</td>
          <td><Tone map={ECOM_STATUS} value={o.status} />{o.fail_reason && <> <span className="muted">{FAIL_REASON[o.fail_reason] ?? o.fail_reason}</span></>}{o.return_task_id && <> <Badge tone="warning">مرتجع</Badge></>}</td>
          <td className="num">{o.attributes?.cod_amount ? money(o.attributes.cod_amount) : '—'}{o.cod_collected && <> <Badge tone="success">حُصّل</Badge></>}</td>
          <td className="num">{dt(o.updated_at)}</td><td>{onPick && <button className="small" onClick={() => onPick(o)}>تفاصيل</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function OrdersView() {
  const ms = useMerchants();
  const [customer, setCustomer] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useLoad(() => api<{ data: Order[] }>(`/ecommerce/orders?${new URLSearchParams(clean({ customer_id: customer, status, q }) as Record<string, string>)}`).then((r) => r.data), [customer, status, q]);
  const [open, setOpen] = useState<Order | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="المتجر"><option value="">كل المتاجر</option>{ms.data?.map((m) => <option key={m.customer_id} value={m.customer_id}>{m.name}</option>)}</select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة"><option value="">كل الحالات</option>{Object.entries(ECOM_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="رقم الطلب أو البوليصة أو الهاتف" aria-label="بحث في الطلبات" style={{ maxWidth: 280 }} />
      </div>
      <ErrorBox error={list.error} />
      <OrdersTable rows={list.data ?? []} onPick={setOpen} testId="ecom-orders" />
      {open && <OrderModal id={open.id} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function OrderModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const o = useLoad(() => api<Order & { items: { sku?: string; name: string; qty: number }[] | null; events: { to_status: string; occurred_at: string; reason_code: string | null }[] }>(`/ecommerce/orders/${id}`), [id]);
  const act = useAction();
  const [reason, setReason] = useState('');
  const d = o.data;
  const canCancel = d && ['received', 'processing', 'ready_to_ship', 'confirmed'].includes(d.status);
  const canReturn = d && d.status === 'delivered' && !d.return_task_id;
  return (
    <Modal title={`الطلب ${d?.external_id ?? ''}`} onClose={onClose}>
      <ErrorBox error={o.error ?? act.error} />
      {d && <div className="stack">
        <dl className="dl">
          <dt>المتجر</dt><dd>{d.merchant_name}</dd>
          <dt>الحالة</dt><dd><Tone map={ECOM_STATUS} value={d.status} /></dd>
          <dt>المستلم</dt><dd>{who(d)} <span className="num">{d.attributes?.recipient?.phone}</span></dd>
          {d.awb && <><dt>البوليصة</dt><dd className="num">{d.awb}</dd></>}
          {d.items?.length ? <><dt>الأصناف</dt><dd>{d.items.map((i) => `${i.name} × ${i.qty}`).join('، ')}</dd></> : null}
          {d.return_task_id && <><dt>المرتجع</dt><dd>{d.return_reason} · <Badge tone="warning">{d.return_status}</Badge></dd></>}
        </dl>
        {d.events.length > 0 && <ul className="muted">{d.events.map((e, i) => <li key={i}><span className="num">{dt(e.occurred_at)}</span> {e.to_status}{e.reason_code ? ` (${FAIL_REASON[e.reason_code] ?? e.reason_code})` : ''}</li>)}</ul>}
        {can(me, 'tasks:write') && (canCancel || canReturn) && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api(`/ecommerce/orders/${id}/${canCancel ? 'cancel' : 'return'}`, { method: 'POST', body: { reason } }); onDone();
        }); }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={canCancel ? 'سبب الإلغاء' : 'سبب الإرجاع'} required maxLength={300} aria-label="السبب" />
          <button disabled={act.busy} className={canCancel ? 'danger' : undefined}>{canCancel ? 'إلغاء الطلب' : 'طلب استرجاع من المشتري'}</button>
        </form>}
      </div>}
    </Modal>
  );
}

/** One order typed in, or many pasted as lines: رقم الطلب, الاسم, الهاتف, المنطقة, القطعة, الشارع, المنزل, مبلغ COD, ملاحظات */
function ImportView() {
  const ms = useMerchants();
  const act = useAction();
  const [customer, setCustomer] = useState('');
  const [text, setText] = useState('');
  const [res, setRes] = useState<ImportResult[] | null>(null);
  const toOrder = (cols: string[]) => {
    const [external_id, name, phone, area, block, street, house, cod, notes] = cols.map((x) => x?.trim() ?? '');
    return { external_id, recipient: clean({ name, phone }), dropoff: clean({ area, block, street, house }), ...clean({ cod_amount: cod, notes }) };
  };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l, i) => !(i === 0 && /external|رقم/i.test(l)));
  return (
    <section className="card stack">
      <p className="muted">ألصق الطلبات من ملف Excel أو CSV، سطر لكل طلب: رقم الطلب، اسم المستلم، الهاتف، المنطقة، القطعة، الشارع، المنزل، مبلغ COD، ملاحظات. الطلب المكرر برقمه لا يُنشأ مرتين.</p>
      <ErrorBox error={act.error ?? ms.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const orders = lines.map((l) => toOrder(l.split(/\t|,|،/)));
        setRes((await api<{ results: ImportResult[] }>('/ecommerce/orders', { method: 'POST', body: { customer_id: customer, orders } })).results);
      }); }}>
        <label className="field">المتجر<select value={customer} onChange={(e) => setCustomer(e.target.value)} required aria-label="متجر الاستيراد"><option value="">اختر</option>{ms.data?.filter((m) => m.active).map((m) => <option key={m.customer_id} value={m.customer_id}>{m.name}</option>)}</select></label>
        <label className="field">الطلبات<textarea name="orders" value={text} onChange={(e) => setText(e.target.value)} rows={8} required /></label>
        <button disabled={act.busy || !lines.length || lines.length > 500}>إنشاء {lines.length || ''} طلب</button>
      </form>
      {res && <>
        <div className="grid g4">
          <Kpi label="أُنشئ" value={res.filter((r) => r.result === 'created').length} tone="success" />
          <Kpi label="مكرر" value={res.filter((r) => r.result === 'duplicate').length} />
          <Kpi label="أخطاء" value={res.filter((r) => r.result === 'error').length} tone={res.some((r) => r.result === 'error') ? 'danger' : undefined} />
        </div>
        {res.some((r) => r.result === 'error') && <div className="tbl-wrap"><table data-testid="import-errors"><thead><tr><th>السطر</th><th>رقم الطلب</th><th>الخطأ</th></tr></thead>
          <tbody>{res.filter((r) => r.result === 'error').map((r) => <tr key={r.line}><td className="num">{r.line}</td><td className="num">{r.external_id ?? '—'}</td><td className="num">{String(r.error)}</td></tr>)}</tbody></table></div>}
      </>}
    </section>
  );
}

function ExceptionsView() {
  const x = useLoad(() => api<{ not_dispatched: Order[]; failed: Order[]; returns_open: Order[]; cod_owed: { customer_id: string; name: string; owed: string; oldest: string | null }[] }>('/ecommerce/exceptions'));
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="لم تُشحن بعد 24 ساعة" value={d.not_dispatched.length} tone={d.not_dispatched.length ? 'warning' : undefined} />
          <Kpi label="تعذر تسليمها" value={d.failed.length} tone={d.failed.length ? 'danger' : undefined} />
          <Kpi label="مرتجعات مفتوحة" value={d.returns_open.length} />
          <Kpi label="متاجر لها COD عندنا" value={d.cod_owed.length} />
        </div>
        <section className="card"><h2>لم تُشحن بعد 24 ساعة [تخمين]</h2><OrdersTable rows={d.not_dispatched} testId="ex-late" /></section>
        <section className="card"><h2>تعذر التسليم</h2><OrdersTable rows={d.failed} testId="ex-failed" /></section>
        <section className="card"><h2>مرتجعات من المشترين</h2><OrdersTable rows={d.returns_open} testId="ex-returns" /></section>
        <section className="card"><h2>مبالغ COD مستحقة للمتاجر</h2>
          {d.cod_owed.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-cod"><thead><tr><th>المتجر</th><th>المبلغ</th><th>أقدم تحصيل</th></tr></thead>
            <tbody>{d.cod_owed.map((c) => <tr key={c.customer_id}><td>{c.name}</td><td className="num">{money(c.owed)}</td><td className="num">{c.oldest ? dt(c.oldest) : '—'}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}

function StatementView() {
  const ms = useMerchants();
  const t = todayKw();
  const [customer, setCustomer] = useState('');
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const s = useLoad(() => customer ? api<{ orders: number; delivered: number; failed: number; returned: number; canceled: number; open: number; delivery_pct: number | null; cod_collected: string; cod_held_now: string; invoices_due_now: string; net_payable_now: string; lines: { external_id: string; awb: string | null; status: string; created_at: string; delivered_at: string | null; cod_amount: string | null; cod_collected: string | null }[] }>(`/ecommerce/merchants/${customer}/statement?from=${from}&to=${to}`) : Promise.resolve(null), [customer, from, to]);
  const d = s.data;
  return (
    <div className="stack">
      <div className="row">
        <select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="متجر الكشف"><option value="">اختر المتجر</option>{ms.data?.map((m) => <option key={m.customer_id} value={m.customer_id}>{m.name}</option>)}</select>
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={s.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="الطلبات" value={d.orders} />
          <Kpi label="نسبة التسليم" value={d.delivery_pct === null ? '—' : `${d.delivery_pct}%`} />
          <Kpi label="COD محصّل في الفترة" value={money(d.cod_collected)} />
          <Kpi label="الصافي المستحق للمتجر الآن" value={money(d.net_payable_now)} tone="success" />
        </div>
        <section className="card">
          <p className="muted">COD عندنا الآن {money(d.cod_held_now)} ناقص فواتير غير مدفوعة {money(d.invoices_due_now)}. التحويل للمتجر يُسجَّل في المالية. سُلّم {d.delivered} · تعذر {d.failed} · مرتجع {d.returned} · ملغى {d.canceled} · مفتوح {d.open}.</p>
          {d.lines.length === 0 ? <Empty>لا توجد طلبات في الفترة</Empty> : <div className="tbl-wrap"><table data-testid="statement"><thead><tr><th>رقم الطلب</th><th>البوليصة</th><th>الحالة</th><th>أُنشئ</th><th>سُلّم</th><th>COD</th><th>حُصّل</th></tr></thead>
            <tbody>{d.lines.map((l) => <tr key={l.external_id}><td className="num">{l.external_id}</td><td className="num">{l.awb ?? '—'}</td><td><Tone map={ECOM_STATUS} value={l.status} /></td><td className="num">{dt(l.created_at)}</td>
              <td className="num">{l.delivered_at ? dt(l.delivered_at) : '—'}</td><td className="num">{l.cod_amount ? money(l.cod_amount) : '—'}</td><td className="num">{l.cod_collected ? money(l.cod_collected) : '—'}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}

function StoresView() {
  const me = useMe();
  const ms = useMerchants();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((r) => r.data.filter((c) => c.status === 'active')).catch(() => []));
  const whs = useLoad(() => hasPack(me, 'warehouse') ? api<{ data: { id: string; code: string }[] }>('/warehouse/warehouses').then((r) => r.data).catch(() => []) : Promise.resolve([]));
  const [edit, setEdit] = useState<Merchant | 'new' | null>(null);
  const [keysOf, setKeysOf] = useState<Merchant | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={ms.error} />
      {can(me, 'customers:write') && <div className="row"><button onClick={() => setEdit('new')}>إضافة متجر</button></div>}
      {ms.data?.length === 0 ? <Empty>لا توجد متاجر بعد. المتجر عميل من قائمة العملاء.</Empty> : (
        <div className="tbl-wrap"><table data-testid="stores"><thead><tr><th>المتجر</th><th>الاستلام من</th><th>الخدمة</th><th>المستودع</th><th>المحاولات</th><th>المفاتيح</th><th>الطلبات</th><th></th></tr></thead>
          <tbody>{ms.data?.map((m) => <tr key={m.customer_id}><td>{m.name}{!m.active && <> <Badge>موقوف</Badge></>}</td><td>{m.pickup?.area ?? '—'}</td><td>{COURIER_SERVICE[m.default_service]}</td><td className="num">{m.warehouse_code ?? '—'}</td>
            <td className="num">{m.max_attempts}</td><td className="num">{m.keys}</td><td className="num">{m.orders}</td>
            <td>{can(me, 'customers:write') && <><button className="small" onClick={() => setEdit(m)}>تعديل</button> <button className="small" onClick={() => setKeysOf(m)}>مفاتيح API</button></>}</td></tr>)}</tbody></table></div>
      )}
      {edit && <MerchantForm m={edit === 'new' ? null : edit} customers={(customers.data ?? []).filter((c) => edit !== 'new' || !ms.data?.some((m) => m.customer_id === c.id))} whs={whs.data ?? []}
        onClose={() => setEdit(null)} onDone={() => { setEdit(null); void ms.reload(); }} />}
      {keysOf && <KeysModal m={keysOf} onClose={() => { setKeysOf(null); void ms.reload(); }} />}
    </section>
  );
}

function MerchantForm({ m, customers, whs, onClose, onDone }: { m: Merchant | null; customers: { id: string; name: string }[]; whs: { id: string; code: string }[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const p = m?.pickup ?? {};
  const { f, bind, check } = useForm({ customer_id: m?.customer_id ?? '', area: p.area ?? '', block: p.block ?? '', street: p.street ?? '', house: p.house ?? '', phone: p.phone ?? '',
    default_service: m?.default_service ?? 'next_day', warehouse_id: m?.warehouse_id ?? '', max_attempts: String(m?.max_attempts ?? 3), active: m?.active ?? true });
  return (
    <Modal title={m ? `إعدادات ${m.name}` : 'إضافة متجر'} onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api(`/ecommerce/merchants/${f.customer_id}`, { method: 'PUT', body: { pickup: clean({ area: f.area, block: f.block, street: f.street, house: f.house, phone: f.phone }), default_service: f.default_service, max_attempts: Number(f.max_attempts), active: f.active, warehouse_id: f.warehouse_id || null } });
        onDone();
      }); }}>
        {!m && <label className="field">العميل<select {...bind('customer_id')} required aria-label="عميل المتجر"><option value="">اختر</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <div className="row">
          <label className="field">منطقة الاستلام والمرتجعات<input {...bind('area')} required maxLength={80} /></label>
          <label className="field">القطعة<input {...bind('block')} maxLength={20} className="num" style={{ width: 80 }} /></label>
          <label className="field">الشارع<input {...bind('street')} maxLength={80} /></label>
          <label className="field">المنزل<input {...bind('house')} maxLength={20} className="num" style={{ width: 80 }} /></label>
          <label className="field">هاتف المتجر<input {...bind('phone')} maxLength={20} className="num" dir="ltr" /></label>
        </div>
        <div className="row">
          <label className="field">الخدمة الافتراضية<select {...bind('default_service')}>{Object.entries(COURIER_SERVICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">محاولات التسليم<input {...bind('max_attempts')} type="number" min={1} max={9} className="num" style={{ width: 80 }} /></label>
          {whs.length > 0 && <label className="field">يخزّن بضاعته عندنا في<select {...bind('warehouse_id')}><option value="">لا</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select></label>}
          <label className="row" style={{ gap: 4 }}><input {...check('active')} /> فعّال</label>
        </div>
        <button disabled={act.busy}>حفظ</button>
      </form>
    </Modal>
  );
}

function KeysModal({ m, onClose }: { m: Merchant; onClose: () => void }) {
  const keys = useLoad(() => api<{ data: Key[] }>(`/ecommerce/merchants/${m.customer_id}/keys`).then((r) => r.data), [m.customer_id]);
  const act = useAction();
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  return (
    <Modal title={`مفاتيح API: ${m.name}`} onClose={onClose}>
      <ErrorBox error={act.error ?? keys.error} />
      {fresh && <div className="card" data-testid="new-key"><p><b>انسخ المفتاح الآن، لن يظهر مرة أخرى.</b> يرسله المتجر في الترويسة X-Api-Key إلى /v1/ecom/api/orders.</p><code dir="ltr" className="num" style={{ wordBreak: 'break-all' }}>{fresh}</code></div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        setFresh((await api<{ key: string }>(`/ecommerce/merchants/${m.customer_id}/keys`, { method: 'POST', body: clean({ label }) })).key); setLabel(''); await keys.reload();
      }); }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="وصف المفتاح (مثل: متجر Shopify)" maxLength={80} aria-label="وصف المفتاح" />
        <button disabled={act.busy}>إنشاء مفتاح</button>
      </form>
      {keys.data?.length === 0 ? <Empty>لا توجد مفاتيح</Empty> : <div className="tbl-wrap"><table data-testid="keys"><thead><tr><th>المفتاح</th><th>الوصف</th><th>أُنشئ</th><th>آخر استخدام</th><th></th></tr></thead>
        <tbody>{keys.data?.map((k) => <tr key={k.id}><td className="num" dir="ltr">{k.hint}</td><td>{k.label ?? '—'}</td><td className="num">{dt(k.created_at)}</td><td className="num">{k.last_used_at ? dt(k.last_used_at) : '—'}</td>
          <td>{k.revoked_at ? <Badge>ملغى</Badge> : <button className="small danger" disabled={act.busy} onClick={() => void act.run(async () => { await api(`/ecommerce/keys/${k.id}/revoke`, { method: 'POST', body: {} }); await keys.reload(); })}>إلغاء</button>}</td></tr>)}</tbody></table></div>}
    </Modal>
  );
}
