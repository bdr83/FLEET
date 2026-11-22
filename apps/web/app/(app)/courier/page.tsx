'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { COURIER_SERVICE, dt, FAIL_REASON, money, PARCEL_WHERE, SCAN_EVENT, SCAN_REJECT, TASK_STATUS, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Parcel {
  task_id: string; legal_entity_id: string; awb: string; service: string; pieces: number; weight_kg: number | null; max_attempts: number; due_at: string; rto_at: string | null; rto_done_at: string | null;
  created_at: string; origin_hub: string | null; dest_hub: string | null; current_hub_id: string | null; current_hub: string | null; current_hub_name: string | null;
  status: string; version: number; customer_id: string | null; shipper_name: string | null; worker_id: string | null; worker_name: string | null; attempts: number; delivered_at: string | null;
  last_event: string | null; last_scan_at: string | null; cod_collected: string | null; where: string;
  attributes: { recipient?: { name?: string; phone?: string }; address?: string; cod_amount?: string; delivery_fee?: string; attempt?: number; notes?: string };
}
interface Detail extends Parcel {
  scans: { id: string; event: string; scanned_at: string; note: string | null; hub: string | null; hub_name: string | null }[];
  events: { to_status: string; occurred_at: string; reason_code: string | null; note: string | null; actor_type: string; driver_name: string | null }[];
  track_token: string | null;
}
interface Hub { id: string; legal_entity_id: string; code: string; name: string; area: string | null; active: boolean; parcels_here?: number }
interface ScanResult { awb: string; result: 'applied' | 'rejected'; reason?: string; reopened?: boolean; rto?: boolean }
interface Kpis { parcels: number; delivered: number; rto: number; failed_attempts: number; delivery_pct: number | null; first_attempt_pct: number | null; on_time_pct: number | null; rto_pct: number | null; cod_collected: string }
interface Report { services: (Kpis & { service: string })[]; shippers: (Kpis & { customer_id: string | null; name: string })[]; totals: Kpis }
type Tab = 'parcels' | 'scan' | 'exceptions' | 'report' | 'hubs';

const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
const useHubs = () => useLoad(() => api<{ data: Hub[] }>('/courier/hubs').then((r) => r.data));

/** Courier and express (sector 4): parcels with waybills, hub scans, delivery attempts and returns, exceptions and KPIs. Drivers deliver from the delivery app flow. */
export default function CourierPage() {
  const [tab, setTab] = useState<Tab>('parcels');
  const [open, setOpen] = useState<string | null>(null);
  const [stamp, setStamp] = useState(0);
  return (
    <div className="page stack">
      <div className="page-head"><h1>البريد والشحن السريع</h1><Link href="/delivery">مركز التوصيل</Link></div>
      <Tabs tabs={[['parcels', 'الشحنات'], ['scan', 'المسح في المحطة'], ['exceptions', 'الاستثناءات'], ['report', 'المؤشرات'], ['hubs', 'المحطات']]} value={tab} onChange={setTab} />
      {tab === 'parcels' && <ParcelsView key={stamp} onOpen={setOpen} />}
      {tab === 'scan' && <ScanView />}
      {tab === 'exceptions' && <ExceptionsView key={stamp} onOpen={setOpen} />}
      {tab === 'report' && <ReportView />}
      {tab === 'hubs' && <HubsView />}
      {open && <ParcelModal id={open} onClose={() => setOpen(null)} onChange={() => setStamp((s) => s + 1)} />}
    </div>
  );
}

function ParcelTable({ rows, onOpen, id }: { rows: Parcel[]; onOpen: (id: string) => void; id: string }) {
  if (!rows.length) return <Empty>لا توجد شحنات</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={id}>
      <thead><tr><th>البوليصة</th><th>المرسل</th><th>المستلم</th><th>الخدمة</th><th>القطع</th><th>المكان</th><th>المحاولات</th><th>الموعد</th><th>الحالة</th></tr></thead>
      <tbody>{rows.map((p) => (
        <tr key={p.task_id}>
          <td><button className="link num" onClick={() => onOpen(p.task_id)} aria-label={`الشحنة ${p.awb}`}>{p.awb}</button></td>
          <td>{p.shipper_name ?? '—'}</td>
          <td>{p.attributes.recipient?.name ?? '—'}<div className="muted">{p.attributes.address ?? ''}</div></td>
          <td>{COURIER_SERVICE[p.service] ?? p.service}</td>
          <td className="num">{p.pieces}</td>
          <td><Tone map={PARCEL_WHERE} value={p.where} />{p.where === 'at_hub' && p.current_hub && <> <span className="num">{p.current_hub}</span></>}{p.where === 'with_driver' && p.worker_name && <div className="muted">{p.worker_name}</div>}</td>
          <td className="num">{p.attempts} / {p.max_attempts}</td>
          <td className="num">{dt(p.due_at)}</td>
          <td><Tone map={TASK_STATUS} value={p.status} />{p.rto_at && !p.rto_done_at && <> <Badge tone="danger">إرجاع للمرسل</Badge></>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function ParcelsView({ onOpen }: { onOpen: (id: string) => void }) {
  const me = useMe();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => api<{ data: Parcel[] }>(`/courier/parcels${term ? `?q=${encodeURIComponent(term)}` : ''}`).then((r) => r.data), [term]);
  const rows = list.data ?? [];
  const n = (w: string) => rows.filter((p) => p.where === w).length;
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="في المحطات" value={n('at_hub')} />
        <Kpi label="بين المحطات" value={n('in_transit')} />
        <Kpi label="مع المندوبين" value={n('with_driver')} />
        <Kpi label="تنتظر الإرجاع للمرسل" value={rows.filter((p) => p.rto_at && !p.rto_done_at).length} tone={rows.some((p) => p.rto_at && !p.rto_done_at) ? 'warning' : undefined} />
      </div>
      <section className="card stack">
        <form className="row" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بوليصة أو جوال المستلم أو المرسل" aria-label="بحث" style={{ maxWidth: 320 }} />
          <button>بحث</button>
          {can(me, 'tasks:write') && <button type="button" className="primary" onClick={() => setAdding(true)}>شحنة جديدة</button>}
        </form>
        <ErrorBox error={list.error} />
        <ParcelTable rows={rows} onOpen={onOpen} id="parcels" />
      </section>
      {adding && <NewParcel onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); void list.reload(); onOpen(id); }} />}
    </div>
  );
}

function NewParcel({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe();
  const hubs = useHubs();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((r) => r.data.filter((c) => c.status === 'active')).catch(() => []));
  const act = useAction();
  const { f, bind } = useForm({
    awb: '', customer_id: '', service: 'next_day', pieces: '1', weight_kg: '', origin_hub_id: '', dest_hub_id: '',
    name: '', phone: '', area: '', block: '', street: '', house: '', cod_amount: '', delivery_fee: '', notes: '',
  });
  const active = hubs.data?.filter((h) => h.active) ?? [];
  return (
    <Modal title="شحنة جديدة" onClose={onClose}>
      <form className="form" onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => {
          const r = await api<Detail>('/courier/parcels', { method: 'POST', body: {
            legal_entity_id: me.legal_entities[0]?.id, service: f.service, pieces: Number(f.pieces || 1),
            ...clean({ awb: f.awb, customer_id: f.customer_id, origin_hub_id: f.origin_hub_id, dest_hub_id: f.dest_hub_id, cod_amount: f.cod_amount, delivery_fee: f.delivery_fee, notes: f.notes }),
            ...(f.weight_kg ? { weight_kg: Number(f.weight_kg) } : {}),
            recipient: clean({ name: f.name, phone: f.phone }), dropoff: clean({ area: f.area, block: f.block, street: f.street, house: f.house }),
          } });
          onDone(r.task_id);
        });
      }}>
        <ErrorBox error={act.error ?? hubs.error} />
        <div className="form-2">
          <label className="field">رقم البوليصة<input {...bind('awb')} className="num" pattern="[A-Za-z0-9][A-Za-z0-9\-]{3,29}" placeholder="يُولَّد تلقائيًا إن تُرك فارغًا" /></label>
          <label className="field">المرسل<select {...bind('customer_id')}><option value="">بدون</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">الخدمة<select {...bind('service')}>{Object.entries(COURIER_SERVICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">عدد القطع<input {...bind('pieces')} type="number" className="num" min={1} max={999} required /></label>
          <label className="field">الوزن (كغ)<input {...bind('weight_kg')} type="number" className="num" min={0.01} step={0.01} /></label>
          <label className="field">محطة الاستلام<select {...bind('origin_hub_id')}><option value="">بدون</option>{active.map((h) => <option key={h.id} value={h.id}>{h.code} · {h.name}</option>)}</select></label>
          <label className="field">محطة الوجهة<select {...bind('dest_hub_id')}><option value="">بدون</option>{active.map((h) => <option key={h.id} value={h.id}>{h.code} · {h.name}</option>)}</select></label>
          <label className="field">اسم المستلم<input {...bind('name')} maxLength={120} /></label>
          <label className="field">جوال المستلم<input {...bind('phone')} className="num" inputMode="tel" required /></label>
          <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
          <label className="field">القطعة<input {...bind('block')} maxLength={20} /></label>
          <label className="field">الشارع<input {...bind('street')} maxLength={80} /></label>
          <label className="field">المنزل<input {...bind('house')} maxLength={20} /></label>
          <label className="field">الدفع عند الاستلام (د.ك)<input {...bind('cod_amount')} className="num" inputMode="decimal" pattern="\d{1,9}(\.\d{1,3})?" /></label>
          <label className="field">رسم التوصيل (د.ك)<input {...bind('delivery_fee')} className="num" inputMode="decimal" pattern="\d{1,9}(\.\d{1,3})?" /></label>
        </div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={300} /></label>
        <p className="muted" style={{ margin: 0 }}>الموعد حسب الخدمة: سريع خلال 4 ساعات، نفس اليوم حتى 23:59، اليوم التالي حتى 23:59 من الغد [تخمين]. الدفع عند الاستلام يحتاج المرسل.</p>
        <div className="row"><button className="primary" disabled={act.busy}>حجز الشحنة</button></div>
      </form>
    </Modal>
  );
}

function ParcelModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Detail>(`/courier/parcels/${id}`), [id]);
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string; legal_entity_id: string }[] }>('/workers?status=active').then((r) => r.data).catch(() => []));
  const act = useAction();
  const [worker, setWorker] = useState('');
  const p = d.data;
  const timeline = p ? [
    ...p.scans.map((s) => ({ at: s.scanned_at, text: `${SCAN_EVENT[s.event] ?? s.event}${s.hub ? ` · ${s.hub}` : ''}`, note: s.note, tone: s.event === 'rto_out' ? 'muted' : 'info' })),
    ...p.events.filter((e) => ['assigned', 'accepted', 'in_progress', 'completed', 'failed', 'canceled'].includes(e.to_status)).map((e) => ({
      at: e.occurred_at, text: `${TASK_STATUS[e.to_status]?.label ?? e.to_status}${e.driver_name ? ` · ${e.driver_name}` : ''}`,
      note: e.reason_code ? FAIL_REASON[e.reason_code] ?? e.reason_code : e.note, tone: e.to_status === 'failed' ? 'danger' : e.to_status === 'completed' ? 'success' : 'warning',
    })),
  ].sort((x, y) => x.at.localeCompare(y.at)) : [];
  const canAssign = p && can(me, 'tasks:assign') && ['ready', 'assigned', 'accepted'].includes(p.status) && !p.rto_at;
  return (
    <Modal title={p ? `الشحنة ${p.awb}` : 'الشحنة'} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {p && <div className="stack">
        <dl className="dl">
          <dt>المكان</dt><dd><Tone map={PARCEL_WHERE} value={p.where} />{p.current_hub_name && p.where === 'at_hub' && <> {p.current_hub_name}</>}</dd>
          <dt>المرسل</dt><dd>{p.shipper_name ?? '—'}</dd>
          <dt>المستلم</dt><dd>{p.attributes.recipient?.name ?? '—'} · <span className="num">{p.attributes.recipient?.phone}</span><div className="muted">{p.attributes.address}</div></dd>
          <dt>الخدمة</dt><dd>{COURIER_SERVICE[p.service]} · <span className="num">{p.pieces}</span> قطعة{p.weight_kg ? <> · <span className="num">{p.weight_kg}</span> كغ</> : null}</dd>
          <dt>المسار</dt><dd className="num">{p.origin_hub ?? '—'} ← {p.dest_hub ?? '—'}</dd>
          <dt>الموعد</dt><dd className="num">{dt(p.due_at)}{p.delivered_at && <> · سُلّمت {dt(p.delivered_at)}</>}</dd>
          <dt>المحاولات</dt><dd><span className="num">{p.attempts} من {p.max_attempts}</span>{p.rto_at && <> <Badge tone="danger">{p.rto_done_at ? 'أُرجعت للمرسل' : 'تقرر الإرجاع للمرسل'}</Badge></>}</dd>
          {p.attributes.cod_amount && <><dt>الدفع عند الاستلام</dt><dd className="num">{money(p.attributes.cod_amount)}{p.cod_collected ? ` · حُصّل ${money(p.cod_collected)}` : ' · لم يُحصّل'}</dd></>}
          {p.track_token && <><dt>رابط التتبع</dt><dd><a href={`/track/${p.track_token}`} target="_blank" rel="noreferrer">صفحة المستلم</a></dd></>}
        </dl>
        {canAssign && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/tasks/${p.task_id}/assign`, { method: 'POST', body: { version: p.version, worker_id: worker } }); await d.reload(); onChange(); }); }}>
            <select value={worker} onChange={(e) => setWorker(e.target.value)} required aria-label="المندوب">
              <option value="">اختر المندوب</option>
              {workers.data?.filter((w) => w.legal_entity_id === p.legal_entity_id && ['driver', 'courier'].includes(w.kind)).map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}
            </select>
            <button disabled={act.busy}>{p.worker_id ? 'إعادة الإسناد' : 'إسناد'}</button>
            {p.worker_name && <span className="muted">الحالي: {p.worker_name}</span>}
          </form>
        )}
        <section className="card">
          <h3>المسار الزمني</h3>
          <ol className="timeline" data-testid="timeline">{timeline.map((x, i) => (
            <li key={i}><span className="num muted">{dt(x.at)}</span> <Badge tone={x.tone}>{x.text}</Badge>{x.note && <span className="muted"> {x.note}</span>}</li>
          ))}</ol>
        </section>
      </div>}
    </Modal>
  );
}

function ScanView() {
  const me = useMe();
  const hubs = useHubs();
  const act = useAction();
  const [hub, setHub] = useState('');
  const [event, setEvent] = useState('received');
  const [text, setText] = useState('');
  const [rto, setRto] = useState(false);
  const [res, setRes] = useState<ScanResult[] | null>(null);
  const awbs = text.split(/[\s,،]+/).map((x) => x.trim()).filter(Boolean);
  if (!can(me, 'tasks:write')) return <Empty>المسح يحتاج صلاحية تعديل المهام</Empty>;
  return (
    <section className="card stack">
      <p className="muted" style={{ margin: 0 }}>امسح الباركود بالقارئ (كل بوليصة في سطر) أو الصقها. كل بوليصة تُعالج وحدها، والخطأ في واحدة لا يوقف البقية.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const r = await api<{ results: ScanResult[] }>('/courier/scans', { method: 'POST', body: { hub_id: hub, event, awbs, ...(event === 'returned' && rto ? { rto: true } : {}) } });
        setRes(r.results); setText('');
      }); }}>
        <div className="form-2">
          <label className="field">المحطة<select name="hub_id" value={hub} onChange={(e) => setHub(e.target.value)} required><option value="">اختر</option>{hubs.data?.filter((h) => h.active).map((h) => <option key={h.id} value={h.id}>{h.code} · {h.name}</option>)}</select></label>
          <label className="field">العملية<select name="event" value={event} onChange={(e) => setEvent(e.target.value)}>{Object.entries(SCAN_EVENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        {event === 'returned' && <label className="row"><input type="checkbox" checked={rto} onChange={(e) => setRto(e.target.checked)} style={{ width: 'auto' }} /> إرجاع للمرسل الآن حتى لو بقيت محاولات (طلب المرسل)</label>}
        <label className="field">البوليصات<textarea name="awbs" value={text} onChange={(e) => setText(e.target.value)} rows={6} className="num" required /></label>
        <div className="row"><button className="primary" disabled={act.busy || !awbs.length}>تسجيل المسح ({awbs.length})</button></div>
      </form>
      <ErrorBox error={act.error ?? hubs.error} />
      {res && (
        <div className="tbl-wrap"><table data-testid="scan-results"><thead><tr><th>البوليصة</th><th>النتيجة</th></tr></thead>
          <tbody>{res.map((r) => <tr key={r.awb}><td className="num">{r.awb}</td><td>{r.result === 'applied'
            ? <Badge tone="success">{r.reopened ? 'سُجّل، وعادت لقائمة الإسناد لمحاولة جديدة' : r.rto ? 'سُجّل، وتقرر إرجاعها للمرسل' : 'سُجّل'}</Badge>
            : <Badge tone="danger">{SCAN_REJECT[r.reason ?? ''] ?? r.reason}</Badge>}</td></tr>)}</tbody></table></div>
      )}
    </section>
  );
}

function ExceptionsView({ onOpen }: { onOpen: (id: string) => void }) {
  const ex = useLoad(() => api<{ overdue: Parcel[]; stuck: Parcel[]; awaiting_return: Parcel[]; rto_pending: Parcel[] }>('/courier/exceptions'));
  const d = ex.data;
  if (!d) return <ErrorBox error={ex.error} />;
  const block = (title: string, hint: string, rows: Parcel[], id: string) => (
    <section className="card"><h2>{title}</h2><p className="muted">{hint}</p><ParcelTable rows={rows} onOpen={onOpen} id={id} /></section>
  );
  return (
    <div className="stack">
      <div className="grid g4">
        <Kpi label="تجاوزت موعدها" value={d.overdue.length} tone={d.overdue.length ? 'danger' : undefined} />
        <Kpi label="راكدة في محطة" value={d.stuck.length} tone={d.stuck.length ? 'warning' : undefined} />
        <Kpi label="فشلت ولم تعد للمحطة" value={d.awaiting_return.length} tone={d.awaiting_return.length ? 'warning' : undefined} />
        <Kpi label="تنتظر الإرجاع للمرسل" value={d.rto_pending.length} />
      </div>
      {block('تجاوزت موعد الخدمة', 'لم تُسلَّم بعد موعدها حسب مستوى الخدمة.', d.overdue, 'ex-overdue')}
      {block('راكدة في محطة', 'في محطة بلا مسح منذ أكثر من 24 ساعة [تخمين].', d.stuck, 'ex-stuck')}
      {block('فشلت ولم تعد للمحطة', 'محاولة فاشلة والشحنة ما زالت مع المندوب: امسحها «عودة بعد محاولة» عند وصولها.', d.awaiting_return, 'ex-return')}
      {block('تنتظر الإرجاع للمرسل', 'انتهت محاولاتها أو طلب المرسل إرجاعها: امسحها «تسليم للمرسل» عند تسليمها.', d.rto_pending, 'ex-rto')}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<Report>(`/courier/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  const row = (k: Kpis) => <><td className="num">{k.parcels}</td><td className="num">{pct(k.delivery_pct)}</td><td className="num">{pct(k.first_attempt_pct)}</td><td className="num">{pct(k.on_time_pct)}</td><td className="num">{pct(k.rto_pct)}</td><td className="num">{money(k.cod_collected)}</td></>;
  const head = <><th>الشحنات</th><th>التسليم</th><th>من أول محاولة</th><th>في الموعد</th><th>الإرجاع</th><th>COD المحصّل</th></>;
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4">
          <Kpi label="نسبة التسليم" value={pct(x.delivery_pct)} />
          <Kpi label="من أول محاولة" value={pct(x.first_attempt_pct)} />
          <Kpi label="في الموعد" value={pct(x.on_time_pct)} />
          <Kpi label="نسبة الإرجاع للمرسل" value={pct(x.rto_pct)} tone={x.rto ? 'warning' : undefined} />
        </div>
        <section className="card">
          <h3>حسب الخدمة</h3>
          {r.data!.services.length === 0 ? <Empty>لا توجد شحنات في الفترة</Empty> : (
            <div className="tbl-wrap"><table data-testid="courier-services"><thead><tr><th>الخدمة</th>{head}</tr></thead>
              <tbody>{r.data!.services.map((s) => <tr key={s.service}><td>{COURIER_SERVICE[s.service]}</td>{row(s)}</tr>)}</tbody></table></div>
          )}
        </section>
        <section className="card">
          <h3>حسب المرسل</h3>
          {r.data!.shippers.length > 0 && (
            <div className="tbl-wrap"><table data-testid="courier-shippers"><thead><tr><th>المرسل</th>{head}</tr></thead>
              <tbody>{r.data!.shippers.map((s) => <tr key={s.customer_id ?? '-'}><td>{s.name}</td>{row(s)}</tr>)}</tbody></table></div>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>للشحنات المحجوزة في الفترة. «من أول محاولة» و«في الموعد» من المسلَّمة. تحويل مبالغ الدفع عند الاستلام للمرسل من صفحة المدفوعات.</p>
        </section>
      </>}
    </div>
  );
}

function HubsView() {
  const me = useMe();
  const hubs = useHubs();
  const act = useAction();
  const { f, setF, bind } = useForm({ code: '', name: '', area: '' });
  return (
    <section className="card stack">
      {can(me, 'tasks:write') && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api('/courier/hubs', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, code: f.code, name: f.name, ...clean({ area: f.area }) } });
          setF({ code: '', name: '', area: '' }); await hubs.reload();
        }); }}>
          <input {...bind('code')} placeholder="الرمز (KWI)" required maxLength={12} className="num" style={{ width: 120 }} aria-label="رمز المحطة" />
          <input {...bind('name')} placeholder="اسم المحطة" required maxLength={120} aria-label="اسم المحطة" />
          <input {...bind('area')} placeholder="المنطقة" maxLength={80} aria-label="المنطقة" />
          <button disabled={act.busy}>إضافة محطة</button>
        </form>
      )}
      <ErrorBox error={act.error ?? hubs.error} />
      {hubs.data?.length === 0 ? <Empty>لا توجد محطات بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="hubs"><thead><tr><th>الرمز</th><th>الاسم</th><th>المنطقة</th><th>شحنات فيها</th><th></th></tr></thead>
          <tbody>{hubs.data?.map((h) => <tr key={h.id}><td className="num">{h.code}</td><td>{h.name}</td><td>{h.area ?? '—'}</td><td className="num">{h.parcels_here ?? 0}</td>
            <td>{h.active ? null : <Badge tone="muted">موقوفة</Badge>}</td></tr>)}</tbody></table></div>
      )}
    </section>
  );
}
