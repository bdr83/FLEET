'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { BILL_UNIT, dt, EXPENSE_CAT, FREIGHT_FAIL, FREIGHT_MODE, FREIGHT_STAGE, kg, km, money, TASK_STATUS, todayKw, UNIT } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Place { name?: string; area?: string; address?: string; contact_name?: string; contact_phone?: string }
interface Ship {
  task_id: string; legal_entity_id: string; waybill_no: string; mode: string; cargo: { description: string; packages?: number; weight_kg?: number }; pickup: Place; dropoff: Place;
  planned_km: number | null; bill_unit: string; trailer_asset_id: string | null; trailer_plate: string | null; carrier_id: string | null; carrier_name: string | null; carrier_cost: number | null;
  loaded_weight_kg: number | null; seal_no: string | null; delivered_weight_kg: number | null; received_by: string | null; delivered_at: string | null; detention_minutes: number | null;
  status: string; version: number; customer_name: string | null; pickup_at: string; deliver_by: string; worker_id: string | null; worker_name: string | null; plate_no: string | null;
  at_pickup: string | null; loaded: string | null; at_dropoff: string | null; unloaded: string | null; stage: string | null; quantities: Record<string, number> | null; notes: string | null; run_by: 'own' | 'carrier' | null;
}
interface Detail extends Ship { weight_mismatch: boolean; expenses: { id: string; category: string; amount: number; spent_at: string; note: string | null; status: string }[]; failure: { reason_code: string | null; note: string | null } | null }
interface Settle { revenue: number | null; carrier_cost: number; expenses: number; profit: number | null; estimated: boolean; unpriced: string[]; quantities: Record<string, number>; on_time: boolean | null; lines: { unit: string; qty: number; amount: string }[] }
interface Carrier { id: string; legal_entity_id: string; name: string; phone: string | null; cr_number: string | null; active: boolean; shipments: number }
type Tab = 'shipments' | 'exceptions' | 'report' | 'carriers' | 'settings';

const kwStart = (d: string) => `${d}T00:00:00+03:00`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const placeLine = (p: Place) => [p.name, p.area, p.address].filter(Boolean).join('، ') || '—';
const stageText = (s: Ship) => (s.stage ? FREIGHT_STAGE[s.stage] ?? s.stage : '—');
const OPEN = ['draft', 'ready', 'assigned', 'accepted', 'in_progress'];

/** Haulage (sector 2): transport orders, planning on our trucks or a carrier, driver stages, exceptions, trip profit and carriers. */
export default function FreightPage() {
  const [tab, setTab] = useState<Tab>('shipments');
  const [open, setOpen] = useState<string | null>(null);
  const [stamp, setStamp] = useState(0);
  const me = useMe();
  return (
    <div className="page stack">
      <div className="page-head"><h1>الشحن والنقل البري</h1></div>
      <Tabs tabs={[['shipments', 'الشحنات'], ['exceptions', 'الاستثناءات'], ['report', 'ربح الرحلات'], ['carriers', 'الناقلون'], ['settings', 'الإعدادات']]} value={tab} onChange={setTab} />
      {tab === 'shipments' && <ShipmentsView key={stamp} onOpen={setOpen} canWrite={can(me, 'tasks:write')} />}
      {tab === 'exceptions' && <ExceptionsView key={stamp} onOpen={setOpen} />}
      {tab === 'report' && <ReportView onOpen={setOpen} />}
      {tab === 'carriers' && <CarriersView />}
      {tab === 'settings' && <SettingsView />}
      {open && <ShipmentModal id={open} onClose={() => setOpen(null)} onChange={() => setStamp((s) => s + 1)} />}
    </div>
  );
}

function ShipmentsView({ onOpen, canWrite }: { onOpen: (id: string) => void; canWrite: boolean }) {
  const [from, setFrom] = useState(addDays(todayKw(), -2));
  const [status, setStatus] = useState('open');
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => api<{ data: Ship[] }>(`/freight/shipments?from=${encodeURIComponent(kwStart(from))}&to=${encodeURIComponent(kwStart(addDays(from, 10)))}${status ? `&status=${status}` : ''}`).then((r) => r.data), [from, status]);
  const rows = list.data ?? [];
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="مفتوحة" value={rows.filter((s) => OPEN.includes(s.status)).length} />
        <Kpi label="بلا شاحنة أو ناقل" value={rows.filter((s) => s.status === 'ready' && !s.run_by).length} tone={rows.some((s) => s.status === 'ready' && !s.run_by) ? 'warning' : undefined} />
        <Kpi label="على الطريق" value={rows.filter((s) => s.status === 'in_progress').length} />
        <Kpi label="عند ناقلين" value={rows.filter((s) => s.run_by === 'carrier' && OPEN.includes(s.status)).length} />
      </div>
      <section className="card stack">
        <div className="row">
          <label className="field">من<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label className="field">الحالة<select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
            <option value="open">المفتوحة</option><option value="done">المسلّمة</option><option value="failed">المتعثرة</option><option value="">الكل</option>
          </select></label>
          {canWrite && <button className="primary" onClick={() => setAdding(true)}>أمر نقل جديد</button>}
        </div>
        <ErrorBox error={list.error} />
        {list.data && (rows.length === 0 ? <Empty>لا توجد شحنات في هذه الفترة</Empty> : (
          <div className="tbl-wrap"><table data-testid="shipments">
            <thead><tr><th>البوليصة</th><th>العميل</th><th>من ← إلى</th><th>التحميل</th><th>التسليم قبل</th><th>الحمولة</th><th>الشاحنة / الناقل</th><th>المرحلة</th><th>الحالة</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.task_id}>
                <td><button type="button" className="link num" onClick={() => onOpen(s.task_id)} aria-label={`الشحنة ${s.waybill_no}`}>{s.waybill_no}</button></td>
                <td>{s.customer_name ?? '—'}</td>
                <td>{placeLine(s.pickup)} ← {placeLine(s.dropoff)}</td>
                <td className="num">{dt(s.pickup_at)}</td><td className="num">{dt(s.deliver_by)}</td>
                <td>{s.cargo.description}{s.cargo.weight_kg ? <span className="muted"> · {kg(s.cargo.weight_kg)}</span> : null}</td>
                <td>{s.run_by === 'carrier' ? <Badge tone="info">{s.carrier_name}</Badge> : s.run_by === 'own' ? <span className="num">{s.plate_no ?? '—'} · {s.worker_name}</span> : <span className="muted">لم تُخطط</span>}</td>
                <td>{stageText(s)}</td><td><Tone map={TASK_STATUS} value={s.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        ))}
      </section>
      {adding && <NewShipment onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); void list.reload(); onOpen(id); }} />}
    </div>
  );
}

function NewShipment({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((r) => r.data.filter((c) => c.status === 'active')).catch(() => []));
  const act = useAction();
  const t = todayKw();
  const { f, bind } = useForm({
    waybill_no: `WB-${Date.now() % 1_000_000}`, customer_id: '', mode: 'ftl', description: '', packages: '', weight_kg: '',
    pickup_name: '', pickup_area: '', pickup_phone: '', dropoff_name: '', dropoff_area: '', dropoff_phone: '',
    pickup_at: `${t}T08:00`, deliver_by: `${t}T14:00`, planned_km: '', bill_unit: 'trip', notes: '',
  });
  const iso = (v: string) => new Date(`${v}:00+03:00`).toISOString();
  return (
    <Modal title="أمر نقل جديد" onClose={onClose}>
      <form className="form" onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => {
          const r = await api<Ship>('/freight/shipments', { method: 'POST', body: {
            legal_entity_id: me.legal_entities[0]?.id, waybill_no: f.waybill_no, mode: f.mode, bill_unit: f.bill_unit, ...clean({ customer_id: f.customer_id, notes: f.notes }),
            cargo: { description: f.description, ...(f.packages ? { packages: Number(f.packages) } : {}), ...(f.weight_kg ? { weight_kg: Number(f.weight_kg) } : {}) },
            pickup: clean({ name: f.pickup_name, area: f.pickup_area, contact_phone: f.pickup_phone }),
            dropoff: clean({ name: f.dropoff_name, area: f.dropoff_area, contact_phone: f.dropoff_phone }),
            pickup_at: iso(f.pickup_at), deliver_by: iso(f.deliver_by), ...(f.planned_km ? { planned_km: Number(f.planned_km) } : {}),
          } });
          onDone(r.task_id);
        });
      }}>
        <ErrorBox error={act.error ?? customers.error} />
        <div className="form-2">
          <label className="field">رقم البوليصة<input {...bind('waybill_no')} className="num" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,39}" /></label>
          <label className="field">العميل<select {...bind('customer_id')}><option value="">بدون عميل</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">نوع الحمولة<select {...bind('mode')}>{Object.entries(FREIGHT_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">الفوترة<select {...bind('bill_unit')}>{Object.entries(BILL_UNIT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">وصف الحمولة<input {...bind('description')} required maxLength={200} placeholder="حديد تسليح، أسمنت، مواد غذائية…" /></label>
          <label className="field">عدد الطرود<input {...bind('packages')} type="number" className="num" min={1} /></label>
          <label className="field">الوزن (كغ)<input {...bind('weight_kg')} type="number" className="num" min={1} max={100000} required={f.bill_unit === 'ton'} /></label>
          <label className="field">المسافة المخططة (كم)<input {...bind('planned_km')} type="number" className="num" min={1} max={20000} required={f.bill_unit === 'km'} /></label>
          <label className="field">التحميل من<input {...bind('pickup_name')} required maxLength={120} placeholder="مصنع، ميناء الشويخ…" /></label>
          <label className="field">منطقة التحميل<input {...bind('pickup_area')} maxLength={120} /></label>
          <label className="field">هاتف التحميل<input {...bind('pickup_phone')} className="num" inputMode="tel" /></label>
          <label className="field">موعد التحميل<input {...bind('pickup_at')} type="datetime-local" required /></label>
          <label className="field">التفريغ في<input {...bind('dropoff_name')} required maxLength={120} /></label>
          <label className="field">منطقة التفريغ<input {...bind('dropoff_area')} maxLength={120} /></label>
          <label className="field">هاتف المستلم<input {...bind('dropoff_phone')} className="num" inputMode="tel" /></label>
          <label className="field">التسليم قبل<input {...bind('deliver_by')} type="datetime-local" required /></label>
        </div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        <p className="muted" style={{ margin: 0 }}>السعر من عقد العميل لنوع «نقل بري»: رحلة أو كيلومتر أو طن، وساعة الانتظار بعد الوقت المجاني.</p>
        <div className="row"><button className="primary" disabled={act.busy}>إنشاء</button></div>
      </form>
    </Modal>
  );
}

function ShipmentModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const me = useMe();
  const s = useLoad(() => api<Detail>(`/freight/shipments/${id}`), [id]);
  const st = useLoad(() => (can(me, 'reports:read') ? api<Settle>(`/freight/shipments/${id}/settlement`) : Promise.resolve(null)), [id, s.data?.version, s.data?.expenses.length]);
  const p = s.data;
  const done = async () => { await s.reload(); onChange(); };
  const planning = p && ['draft', 'ready', 'assigned', 'accepted'].includes(p.status);
  return (
    <Modal title={p ? `الشحنة ${p.waybill_no}` : 'الشحنة'} onClose={onClose}>
      <div className="stack">
        <ErrorBox error={s.error} />
        {p && <>
          <section className="card">
            <div className="form-2">
              <div><span className="muted">العميل</span><div>{p.customer_name ?? '—'}</div></div>
              <div><span className="muted">الحالة</span><div><Tone map={TASK_STATUS} value={p.status} /> {p.stage && <Badge>{stageText(p)}</Badge>}</div></div>
              <div><span className="muted">من</span><div>{placeLine(p.pickup)} <span className="num muted">{dt(p.pickup_at)}</span></div></div>
              <div><span className="muted">إلى</span><div>{placeLine(p.dropoff)} <span className="num muted">قبل {dt(p.deliver_by)}</span></div></div>
              <div><span className="muted">الحمولة</span><div>{p.cargo.description} · {FREIGHT_MODE[p.mode]}{p.cargo.packages ? ` · ${p.cargo.packages} طرد` : ''}{p.cargo.weight_kg ? ` · ${kg(p.cargo.weight_kg)}` : ''}</div></div>
              <div><span className="muted">الفوترة</span><div>{BILL_UNIT[p.bill_unit]}{p.planned_km ? ` · ${km(p.planned_km)}` : ''}</div></div>
              <div><span className="muted">التنفيذ</span><div>{p.run_by === 'carrier' ? <>ناقل: {p.carrier_name} · الكلفة {money(p.carrier_cost)}</> : p.run_by === 'own' ? <span className="num">{p.plate_no} · {p.worker_name}{p.trailer_plate ? ` · مقطورة ${p.trailer_plate}` : ''}</span> : <span className="muted">لم تُخطط</span>}</div></div>
              <div><span className="muted">التحميل والتفريغ</span><div className="num">
                {[p.loaded_weight_kg !== null && `حُمّل ${kg(p.loaded_weight_kg)}`, p.seal_no && `ختم ${p.seal_no}`,
                  p.delivered_weight_kg !== null && `سُلّم ${kg(p.delivered_weight_kg)}`, p.received_by && `استلمه ${p.received_by}`].filter(Boolean).join(' · ') || '—'}
                {p.weight_mismatch && <> <Badge tone="danger">اختلاف وزن</Badge></>}
              </div></div>
            </div>
            {(p.at_pickup || p.loaded || p.at_dropoff || p.unloaded) && (
              <p className="muted num" style={{ marginBottom: 0 }}>
                {(['at_pickup', 'loaded', 'at_dropoff', 'unloaded'] as const).filter((k) => p[k]).map((k) => `${FREIGHT_STAGE[k]} ${dt(p[k])}`).join(' · ')}
                {p.detention_minutes ? ` · انتظار محتسب ${p.detention_minutes} د` : ''}
              </p>
            )}
            {p.failure && <div className="alert warn">تعثرت: {FREIGHT_FAIL[p.failure.reason_code ?? ''] ?? p.failure.reason_code ?? ''} {p.failure.note}</div>}
          </section>
          {planning && can(me, 'tasks:assign') && <PlanForm p={p} onDone={done} />}
          {p.run_by === 'carrier' && ['ready', 'draft'].includes(p.status) && can(me, 'tasks:write') && <CarrierDelivered p={p} onDone={done} />}
          <ExpensesCard p={p} onDone={done} />
          {st.data && <SettleCard s={st.data} />}
        </>}
      </div>
    </Modal>
  );
}

function PlanForm({ p, onDone }: { p: Detail; onDone: () => Promise<void> }) {
  const assets = useLoad(() => api<{ data: { id: string; plate_no: string | null; asset_type: string; status: string; legal_entity_id: string }[] }>('/assets').then((r) => r.data.filter((a) => a.legal_entity_id === p.legal_entity_id && !['retired', 'out_of_service'].includes(a.status))));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string; legal_entity_id: string }[] }>('/workers?status=active').then((r) => r.data.filter((w) => w.legal_entity_id === p.legal_entity_id)));
  const carriers = useLoad(() => api<{ data: Carrier[] }>('/freight/carriers').then((r) => r.data.filter((c) => c.active && c.legal_entity_id === p.legal_entity_id)));
  const act = useAction();
  const [mode, setMode] = useState<'own' | 'carrier'>(p.run_by === 'carrier' ? 'carrier' : 'own');
  const { f, bind } = useForm({ asset_id: '', worker_id: '', trailer_asset_id: p.trailer_asset_id ?? '', carrier_id: p.carrier_id ?? '', carrier_cost: p.carrier_cost?.toString() ?? '' });
  const trucks = assets.data?.filter((a) => ['truck', 'pickup', 'van'].includes(a.asset_type)) ?? [];
  const trailers = assets.data?.filter((a) => a.asset_type === 'trailer') ?? [];
  const submit = () => act.run(async () => {
    if (mode === 'own') {
      let v = p.version;
      if (p.carrier_id) v = (await api<Ship>(`/freight/shipments/${p.task_id}/plan`, { method: 'POST', body: { version: v, carrier_id: null } })).version;
      if (f.trailer_asset_id !== (p.trailer_asset_id ?? '')) v = (await api<Ship>(`/freight/shipments/${p.task_id}/plan`, { method: 'POST', body: { version: v, trailer_asset_id: f.trailer_asset_id || null } })).version;
      if (f.worker_id) await api(`/tasks/${p.task_id}/assign`, { method: 'POST', body: { version: v, worker_id: f.worker_id, exclusive: true, ...clean({ asset_id: f.asset_id }) } });
    } else {
      await api(`/freight/shipments/${p.task_id}/plan`, { method: 'POST', body: { version: p.version, carrier_id: f.carrier_id, carrier_cost: Number(f.carrier_cost) } });
    }
    await onDone();
  });
  return (
    <form className="form card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>التخطيط</h3>
      <ErrorBox error={act.error ?? assets.error ?? workers.error} />
      <div className="row">
        <label className="row"><input type="radio" style={{ width: 'auto' }} checked={mode === 'own'} onChange={() => setMode('own')} /> شاحنتنا وسائقنا</label>
        <label className="row"><input type="radio" style={{ width: 'auto' }} checked={mode === 'carrier'} onChange={() => setMode('carrier')} /> ناقل من الباطن</label>
      </div>
      {mode === 'own' ? (
        <div className="form-2">
          <label className="field">الشاحنة<select {...bind('asset_id')}><option value="">—</option>{trucks.map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
          <label className="field">السائق<select {...bind('worker_id')} required={!p.worker_id}><option value="">{p.worker_name ? `الحالي: ${p.worker_name}` : 'اختر'}</option>{workers.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          <label className="field">المقطورة<select {...bind('trailer_asset_id')}><option value="">بدون</option>{trailers.map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
        </div>
      ) : (
        <div className="form-2">
          <label className="field">الناقل<select {...bind('carrier_id')} required><option value="">اختر</option>{carriers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">كلفة الناقل (د.ك)<input {...bind('carrier_cost')} className="num" inputMode="decimal" pattern="\d{1,7}(\.\d{1,3})?" required /></label>
        </div>
      )}
      <p className="muted" style={{ margin: 0 }}>{mode === 'own' ? 'تُحجز الشاحنة والسائق حصريًا من موعد التحميل إلى موعد التسليم.' : 'الناقل يعمل خارج تطبيقنا: سجّل تسليمه هنا عند وصول إثبات الاستلام.'}</p>
      <div className="row"><button className="primary" disabled={act.busy}>حفظ التخطيط</button></div>
    </form>
  );
}

function CarrierDelivered({ p, onDone }: { p: Detail; onDone: () => Promise<void> }) {
  const act = useAction();
  const { f, bind } = useForm({ received_by: '', delivered_weight_kg: '' });
  return (
    <form className="form card" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/freight/shipments/${p.task_id}/carrier-delivered`, { method: 'POST', body: { version: p.version, received_by: f.received_by, ...(f.delivered_weight_kg ? { delivered_weight_kg: Number(f.delivered_weight_kg) } : {}) } }); await onDone(); }); }}>
      <h3>تسليم الناقل</h3>
      <ErrorBox error={act.error} />
      <div className="form-2">
        <label className="field">المستلم<input {...bind('received_by')} required maxLength={120} /></label>
        <label className="field">الوزن المسلَّم (كغ)<input {...bind('delivered_weight_kg')} type="number" className="num" min={0} max={100000} required={p.bill_unit === 'ton'} /></label>
      </div>
      <div className="row"><button className="primary" disabled={act.busy}>تسجيل التسليم</button></div>
    </form>
  );
}

function ExpensesCard({ p, onDone }: { p: Detail; onDone: () => Promise<void> }) {
  const me = useMe();
  const act = useAction();
  const { f, bind, setF } = useForm({ category: 'fuel', amount: '', note: '' });
  return (
    <section className="card stack">
      <h3>مصاريف الرحلة</h3>
      {p.expenses.length === 0 ? <Empty>لا توجد مصاريف</Empty> : (
        <div className="tbl-wrap"><table data-testid="trip-expenses"><thead><tr><th>البند</th><th>المبلغ</th><th>التاريخ</th><th>ملاحظة</th></tr></thead>
          <tbody>{p.expenses.map((x) => <tr key={x.id}><td>{EXPENSE_CAT[x.category] ?? x.category}</td><td className="num">{money(x.amount)}</td><td className="num">{dt(x.spent_at)}</td><td>{x.note ?? '—'}</td></tr>)}</tbody></table></div>
      )}
      {can(me, 'fleet:write') && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/freight/shipments/${p.task_id}/expenses`, { method: 'POST', body: { category: f.category, amount: Number(f.amount), ...clean({ note: f.note }) } }); setF({ category: 'fuel', amount: '', note: '' }); await onDone(); }); }}>
          <ErrorBox error={act.error} />
          <div className="form-2">
            <label className="field">البند<select {...bind('category')}>{['fuel', 'tolls', 'parking', 'other'].map((k) => <option key={k} value={k}>{EXPENSE_CAT[k] ?? k}</option>)}</select></label>
            <label className="field">المبلغ (د.ك)<input {...bind('amount')} className="num" inputMode="decimal" pattern="\d{1,6}(\.\d{1,3})?" required /></label>
            <label className="field">ملاحظة<input {...bind('note')} maxLength={1000} placeholder="رسوم منفذ، مبيت السائق…" /></label>
          </div>
          <div className="row"><button disabled={act.busy}>إضافة مصروف</button></div>
        </form>
      )}
    </section>
  );
}

function SettleCard({ s }: { s: Settle }) {
  return (
    <section className="card stack" data-testid="settlement">
      <h3>تسوية الرحلة {s.estimated && <Badge>تقديرية حتى التسليم</Badge>}</h3>
      <div className="grid g4">
        <Kpi label="الإيراد" value={s.revenue === null ? '—' : money(s.revenue)} />
        <Kpi label="كلفة الناقل" value={money(s.carrier_cost)} />
        <Kpi label="المصاريف" value={money(s.expenses)} />
        <Kpi label="الربح" value={s.profit === null ? '—' : money(s.profit)} tone={s.profit === null ? undefined : s.profit < 0 ? 'danger' : 'success'} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        الكميات: {Object.entries(s.quantities).map(([u, q]) => `${q} ${UNIT[u] ?? u}`).join('، ') || '—'}
        {s.revenue === null && ' · لا سعر في عقد العميل لهذه الوحدات، أو الشحنة بلا عقد.'}
        {s.on_time !== null && (s.on_time ? ' · سُلّمت في الموعد' : ' · تأخر التسليم')}
      </p>
    </section>
  );
}

interface ExRow extends Ship { held_minutes?: number; free_minutes?: number; tolerance_pct?: number }
function ExceptionsView({ onOpen }: { onOpen: (id: string) => void }) {
  const ex = useLoad(() => api<{ unplanned: ExRow[]; late: ExRow[]; detention: ExRow[]; weight_mismatch: ExRow[] }>('/freight/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  const block = (title: string, rows: ExRow[], hint: string, extra?: (r: ExRow) => React.ReactNode) => (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted">{hint}</p>
      {rows.length === 0 ? <Empty>لا يوجد</Empty> : (
        <div className="tbl-wrap"><table><thead><tr><th>البوليصة</th><th>العميل</th><th>الوجهة</th><th>التسليم قبل</th><th>التنفيذ</th>{extra && <th>التفاصيل</th>}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.task_id}>
            <td><button type="button" className="link num" onClick={() => onOpen(r.task_id)}>{r.waybill_no}</button></td><td>{r.customer_name ?? '—'}</td><td>{placeLine(r.dropoff)}</td>
            <td className="num">{dt(r.deliver_by)}</td><td>{r.carrier_name ?? (r.plate_no ? `${r.plate_no} · ${r.worker_name}` : '—')}</td>{extra && <td className="num">{extra(r)}</td>}</tr>)}</tbody></table></div>
      )}
    </section>
  );
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="تحميلها خلال 24 ساعة بلا تخطيط" value={d.unplanned.length} tone={d.unplanned.length ? 'danger' : undefined} />
        <Kpi label="متأخرة عن موعد التسليم" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
        <Kpi label="شاحنات تنتظر بعد الوقت المجاني" value={d.detention.length} tone={d.detention.length ? 'warning' : undefined} />
        <Kpi label="اختلاف وزن" value={d.weight_mismatch.length} tone={d.weight_mismatch.length ? 'warning' : undefined} />
      </div>
      {block('بلا شاحنة أو ناقل', d.unplanned, 'افتح الشحنة لإسنادها لشاحنتنا أو لناقل.')}
      {block('متأخرة', d.late, 'مضى موعد التسليم ولم تُفرَّغ.')}
      {block('انتظار (حجز)', d.detention, 'الشاحنة عند التحميل أو التفريغ أطول من الوقت المجاني: يُحتسب على العميل بالساعة.', (r) => `${r.held_minutes} د (المجاني ${r.free_minutes})`)}
      {block('اختلاف الوزن بين التحميل والتسليم', d.weight_mismatch, 'خلال آخر 7 أيام، أكبر من النسبة المسموحة في الإعدادات.', (r) => `${kg(r.loaded_weight_kg)} ← ${kg(r.delivered_weight_kg)}`)}
    </div>
  );
}

interface ReportRow extends Settle { task_id: string; waybill_no: string; status: string; customer_name: string | null; pickup_at: string; carrier_name: string | null; plate_no: string | null; planned_km: number | null }
interface Report { data: ReportRow[]; totals: { trips: number; delivered: number; failed: number; own_trips: number; carrier_trips: number; revenue: number; carrier_cost: number; expenses: number; profit: number; unpriced_trips: number; planned_km: number; cost_per_km: number | null; profit_per_trip: number | null; on_time_pct: number | null; load_utilization_pct: number | null; detention_hours: number } }
function ReportView({ onOpen }: { onOpen: (id: string) => void }) {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<Report>(`/freight/report?from=${encodeURIComponent(kwStart(from))}&to=${encodeURIComponent(kwStart(addDays(to, 1)))}`), [from, to]);
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
          <Kpi label="رحلات مسلّمة" value={`${x.delivered} من ${x.trips}`} />
          <Kpi label="الربح" value={money(x.profit)} tone={x.profit < 0 ? 'danger' : 'success'} />
          <Kpi label="ربح الرحلة" value={x.profit_per_trip === null ? '—' : money(x.profit_per_trip)} />
          <Kpi label="في الموعد" value={x.on_time_pct === null ? '—' : `${x.on_time_pct}%`} />
          <Kpi label="الإيراد" value={money(x.revenue)} />
          <Kpi label="كلفة الكيلومتر" value={x.cost_per_km === null ? '—' : money(x.cost_per_km)} />
          <Kpi label="استغلال الحمولة" value={x.load_utilization_pct === null ? '—' : `${x.load_utilization_pct}%`} />
          <Kpi label="ساعات انتظار محتسبة" value={x.detention_hours} />
        </div>
        {x.unpriced_trips > 0 && <div className="alert warn">{x.unpriced_trips} رحلة بلا سعر في عقد العميل: لا يُحسب لها إيراد.</div>}
        <section className="card">
          {r.data!.data.length === 0 ? <Empty>لا توجد رحلات في الفترة</Empty> : (
            <div className="tbl-wrap"><table data-testid="freight-report">
              <thead><tr><th>البوليصة</th><th>العميل</th><th>التحميل</th><th>التنفيذ</th><th>الحالة</th><th>الإيراد</th><th>الناقل</th><th>المصاريف</th><th>الربح</th></tr></thead>
              <tbody>{r.data!.data.map((s) => (
                <tr key={s.task_id}>
                  <td><button type="button" className="link num" onClick={() => onOpen(s.task_id)}>{s.waybill_no}</button></td><td>{s.customer_name ?? '—'}</td><td className="num">{dt(s.pickup_at)}</td>
                  <td>{s.carrier_name ?? s.plate_no ?? '—'}</td><td><Tone map={TASK_STATUS} value={s.status} /></td>
                  <td className="num">{s.revenue === null ? '—' : money(s.revenue)}{s.estimated && s.revenue !== null && <span className="muted"> تقديري</span>}</td>
                  <td className="num">{money(s.carrier_cost)}</td><td className="num">{money(s.expenses)}</td><td className="num"><strong>{s.profit === null ? '—' : money(s.profit)}</strong></td>
                </tr>
              ))}</tbody>
              <tfoot><tr><th colSpan={5}>المسلّمة</th><th className="num">{money(x.revenue)}</th><th className="num">{money(x.carrier_cost)}</th><th className="num">{money(x.expenses)}</th><th className="num">{money(x.profit)}</th></tr></tfoot>
            </table></div>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>كلفة الكيلومتر = (كلفة الناقلين + المصاريف) ÷ الكيلومترات المخططة للرحلات المسلّمة. استغلال الحمولة يحتاج سعة الشاحنة بالكغ في بيانات المركبة.</p>
        </section>
      </>}
    </div>
  );
}

function CarriersView() {
  const me = useMe();
  const list = useLoad(() => api<{ data: Carrier[] }>('/freight/carriers').then((r) => r.data));
  const act = useAction();
  const { f, bind, setF } = useForm({ name: '', phone: '', cr_number: '' });
  const toggle = (c: Carrier) => act.run(async () => { await api(`/freight/carriers/${c.id}`, { method: 'PATCH', body: { active: !c.active } }); await list.reload(); });
  return (
    <section className="card stack">
      <ErrorBox error={list.error ?? act.error} />
      {list.data && (list.data.length === 0 ? <Empty>لا يوجد ناقلون بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="carriers"><thead><tr><th>الناقل</th><th>الهاتف</th><th>السجل التجاري</th><th>الشحنات</th><th></th></tr></thead>
          <tbody>{list.data.map((c) => <tr key={c.id}><td>{c.name}{!c.active && <> <Badge>موقوف</Badge></>}</td><td className="num">{c.phone ?? '—'}</td><td className="num">{c.cr_number ?? '—'}</td><td className="num">{c.shipments}</td>
            <td>{can(me, 'tasks:write') && <button className="small" onClick={() => void toggle(c)} disabled={act.busy}>{c.active ? 'إيقاف' : 'تفعيل'}</button>}</td></tr>)}</tbody></table></div>
      ))}
      {can(me, 'tasks:write') && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('/freight/carriers', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, name: f.name, ...clean({ phone: f.phone, cr_number: f.cr_number }) } }); setF({ name: '', phone: '', cr_number: '' }); await list.reload(); }); }}>
          <div className="form-2">
            <label className="field">اسم الناقل<input {...bind('name')} required maxLength={120} /></label>
            <label className="field">الهاتف<input {...bind('phone')} className="num" inputMode="tel" /></label>
            <label className="field">السجل التجاري<input {...bind('cr_number')} className="num" maxLength={40} /></label>
          </div>
          <div className="row"><button className="primary" disabled={act.busy}>إضافة ناقل</button></div>
        </form>
      )}
    </section>
  );
}

interface Settings { free_detention_minutes: number; weight_tolerance_pct: number }
function SettingsView() {
  const me = useMe();
  const [le, setLe] = useState(me.legal_entities[0]?.id ?? '');
  const s = useLoad(() => api<Settings>(`/freight/settings?legal_entity_id=${le}`), [le]);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState<Settings | null>(null);
  const cur = f ?? s.data;
  const writer = can(me, 'org:write');
  if (!cur) return <ErrorBox error={s.error} />;
  const set = (p: Partial<Settings>) => { setF({ ...cur, ...p }); setSaved(false); };
  return (
    <section className="card">
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { setF(await api<Settings>('/freight/settings', { method: 'PUT', body: { legal_entity_id: le, ...cur } })); setSaved(true); }); }}>
        {me.legal_entities.length > 1 && <label className="field">الشركة القانونية<select value={le} onChange={(e) => { setLe(e.target.value); setF(null); }}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        <ErrorBox error={act.error} />
        {saved && <div className="alert ok">حُفظت الإعدادات</div>}
        <div className="form-2">
          <label className="field">الانتظار المجاني عند كل طرف (دقيقة)<input type="number" className="num" min={0} max={1440} disabled={!writer} value={cur.free_detention_minutes} onChange={(e) => set({ free_detention_minutes: Number(e.target.value) })} required /></label>
          <label className="field">فرق الوزن المسموح (%)<input type="number" className="num" min={0} max={50} step="0.1" disabled={!writer} value={cur.weight_tolerance_pct} onChange={(e) => set({ weight_tolerance_pct: Number(e.target.value) })} required /></label>
        </div>
        <p className="muted" style={{ margin: 0 }}>الانتظار بعد الوقت المجاني يُحتسب بربع الساعة، ويُسعَّر بوحدة «ساعة» في عقد العميل. القيم الافتراضية تقديرية [تخمين] تُضبط مع أول عميل.</p>
        {writer && <div className="row"><button className="primary" disabled={act.busy}>حفظ</button></div>}
      </form>
    </section>
  );
}
