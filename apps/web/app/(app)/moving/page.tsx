'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, money, MV_CLAIM, MV_SERVICE, MV_SIZE, MV_STATE, TASK_STATUS, time, todayKw } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

type Site = Record<string, string | boolean>;
interface Crew { task_id: string; role: 'lead' | 'helper'; ref: string; status: string; starts_at: string; ends_at: string; worker_name: string | null; plate_no: string | null }
interface Item { id: string; room: string | null; name: string; qty: number; fragile: boolean }
interface Claim { id: string; item: string; description: string; claimed_amount: string | null; status: string; settled_amount: string | null; decision_note: string | null; ref?: string; customer_name?: string; job_id?: string }
interface Move {
  id: string; ref: string; customer_name: string; customer_phone: string | null; from_site: Site; to_site: Site; home_size: string; services: string[]; move_at: string; hours: number; crew_size: number;
  notes: string | null; surveyed_at: string | null; volume_m3: number | null; quote_amount: string | null; deposit_amount: string | null; deposit_paid_at: string | null; accepted_at: string | null;
  loaded_at: string | null; unloaded_at: string | null; received_by: string | null; delivery_note: string | null; extra_amount: string | null; total: string; rating: number | null; rating_note: string | null;
  state: string; created_at: string; items?: Item[]; crew?: Crew[]; claims?: Claim[];
}
type Tab = 'jobs' | 'board' | 'exceptions' | 'report';

const siteText = (s: Site) => [s.area, s.block && `ق ${s.block}`, s.street, s.house && `منزل ${s.house}`, s.floor && `الدور ${s.floor}`].filter((x) => typeof x === 'string' && x).join('، ') || '—';

/** One item per line: "الغرفة: الصنف × العدد" with * for fragile, e.g. "الصالة: تلفزيون × 1 *". */
function parseItemLines(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const fragile = l.includes('*');
    let rest = l.replace(/\*/g, '').trim();
    let room: string | null = null;
    const c = rest.indexOf(':');
    if (c > 0) { room = rest.slice(0, c).trim(); rest = rest.slice(c + 1).trim(); }
    const m = rest.match(/^(.*?)\s*[×xX]\s*([0-9٠-٩]+)$/);
    const qty = m ? Number(m[2].replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))) : 1;
    return { room, name: (m ? m[1] : rest).trim(), qty, fragile };
  });
}

/** Furniture moving (sector 5): requests from survey to closing, the day's board, exceptions and the report. */
export default function MovingPage() {
  const [tab, setTab] = useState<Tab>('jobs');
  return (
    <div className="page stack">
      <div className="page-head"><h1>نقل الأثاث</h1></div>
      <Tabs tabs={[['jobs', 'طلبات النقل'], ['board', 'لوحة اليوم'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'jobs' && <JobsView />}
      {tab === 'board' && <BoardView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function MovesTable({ rows, onPick, testId }: { rows: Move[]; onPick?: (m: Move) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>الطلب</th><th>العميل</th><th>من ← إلى</th><th>الحجم</th><th>موعد النقل</th><th>السعر</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{rows.map((m) => (
        <tr key={m.id}><td className="num">{m.ref}</td><td>{m.customer_name}</td><td>{siteText(m.from_site)} ← {siteText(m.to_site)}</td><td>{MV_SIZE[m.home_size]}</td>
          <td className="num">{dt(m.move_at)}</td><td className="num">{m.quote_amount ? money(m.quote_amount) : '—'}</td><td><Tone map={MV_STATE} value={m.state} /></td>
          <td>{onPick && <button className="small" onClick={() => onPick(m)}>إدارة</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function JobsView() {
  const me = useMe();
  const [state, setState] = useState('');
  const jobs = useLoad(() => api<{ data: Move[] }>(`/moving/jobs${state ? `?state=${state}` : ''}`).then((r) => r.data), [state]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={jobs.error} />
      <div className="row">
        {can(me, 'tasks:assign') && <button onClick={() => setAdding(true)}>طلب نقل جديد</button>}
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="الحالة" style={{ maxWidth: 220 }}>
          <option value="">كل الحالات</option>{Object.entries(MV_STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <MovesTable rows={jobs.data ?? []} onPick={(m) => setOpen(m.id)} testId="moves" />
      {adding && <MoveForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void jobs.reload(); }} />}
      {open && <MoveModal id={open} onClose={() => { setOpen(null); void jobs.reload(); }} />}
    </section>
  );
}

type Bind = (k: string) => { name: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void };
function AddressFields({ p, title, bind }: { p: 'f' | 't'; title: string; bind: Bind }) {
  return (
    <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="muted">{title}</legend>
      <label className="field">المنطقة<input {...bind(`${p}_area`)} required maxLength={80} /></label>
      <label className="field">القطعة<input {...bind(`${p}_block`)} maxLength={10} className="num" style={{ width: 70 }} /></label>
      <label className="field">الشارع<input {...bind(`${p}_street`)} maxLength={80} /></label>
      <label className="field">المنزل<input {...bind(`${p}_house`)} maxLength={20} className="num" style={{ width: 80 }} /></label>
      <label className="field">الدور<input {...bind(`${p}_floor`)} maxLength={20} className="num" style={{ width: 60 }} /></label>
    </fieldset>
  );
}
const siteOf = (f: Record<string, string | boolean>, p: 'f' | 't') => clean({ area: f[`${p}_area`] as string, block: f[`${p}_block`] as string, street: f[`${p}_street`] as string, house: f[`${p}_house`] as string, floor: f[`${p}_floor`] as string });

function MoveForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const { f, bind, check } = useForm<Record<string, string | boolean>>({ customer_id: '', new_name: '', phone: '', f_area: '', f_block: '', f_street: '', f_house: '', f_floor: '', f_lift: false,
    t_area: '', t_block: '', t_street: '', t_house: '', t_floor: '', home_size: 'apt_2', move_at: new Date(Date.now() + 3 * 3_600_000 + 2 * 86_400_000).toISOString().slice(0, 11) + '08:00',
    packing: false, assembly: false, crating: false, storage: false, cleaning: false, notes: '' });
  const b = bind as unknown as Bind;
  return (
    <Modal title="طلب نقل جديد" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const le = me.legal_entities[0]?.id;
        let customer = f.customer_id as string;
        if (customer === 'new') customer = (await api<{ id: string }>('/customers', { method: 'POST', body: { legal_entity_id: le, kind: 'individual', name: f.new_name, ...clean({ phone: f.phone as string }) } })).id;
        await api('/moving/jobs', { method: 'POST', body: { legal_entity_id: le, customer_id: customer, from_site: { ...siteOf(f, 'f'), lift: !!f.f_lift, ...clean({ phone: f.phone as string }) }, to_site: siteOf(f, 't'),
          home_size: f.home_size, move_at: kwIso(f.move_at as string), services: Object.keys(MV_SERVICE).filter((k) => f[k]), ...clean({ notes: f.notes as string }) } });
        onDone();
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...b('customer_id')} required><option value="">اختر</option><option value="new">+ عميل جديد (فرد)</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          {f.customer_id === 'new' && <label className="field">اسم العميل<input {...b('new_name')} required maxLength={200} /></label>}
          <label className="field">الهاتف<input {...b('phone')} maxLength={20} className="num" dir="ltr" /></label>
        </div>
        <AddressFields p="f" title="من" bind={b} />
        <label className="check"><input {...check('f_lift')} /> يوجد مصعد</label>
        <AddressFields p="t" title="إلى" bind={b} />
        <div className="row">
          <label className="field">الحجم<select {...b('home_size')}>{Object.entries(MV_SIZE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">موعد النقل<input {...b('move_at')} type="datetime-local" required /></label>
        </div>
        <div className="row">{Object.entries(MV_SERVICE).map(([k, l]) => <label key={k} className="check"><input {...check(k)} /> {l}</label>)}</div>
        <label className="field">ملاحظات<textarea {...b('notes')} maxLength={1000} rows={2} /></label>
        <p className="muted">ساعات الحجز وعدد العمال تُقترح من الحجم [تخمين]، ويعدّلها المكتب.</p>
        <button disabled={act.busy}>حفظ الطلب</button>
      </form>
    </Modal>
  );
}

function MoveModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Move & { items: Item[]; crew: Crew[]; claims: Claim[] }>(`/moving/jobs/${id}`), [id]);
  const workers = useLoad(() => api<{ data: { id: string; display_name: string }[] }>('/workers?status=active').then((x) => x.data));
  const assets = useAssets();
  const act = useAction();
  const { f, bind, setF } = useForm({ volume: '', items: '', quote: '', deposit: '', driver: '', truck: '', starts_at: '', extra: '', rating: '', rating_note: '', reason: '',
    c_item: '', c_desc: '', c_amount: '', settle: '', settle_note: '' });
  const [helpers, setHelpers] = useState<string[]>([]);
  const m = d.data;
  const w = can(me, 'tasks:assign');
  const run = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); await d.reload(); });
  const live = m?.crew.filter((x) => x.status !== 'canceled') ?? [];
  return (
    <Modal title={m ? `طلب نقل ${m.ref}` : 'طلب نقل'} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {m && <div className="stack">
        <div className="row"><Tone map={MV_STATE} value={m.state} />{m.deposit_amount && Number(m.deposit_amount) > 0 && (m.deposit_paid_at ? <Badge tone="success">العربون مدفوع</Badge> : <Badge tone="warning">العربون غير مدفوع</Badge>)}</div>
        <dl className="dl">
          <dt>العميل</dt><dd>{m.customer_name} {m.customer_phone && <span className="num muted">{m.customer_phone}</span>}</dd>
          <dt>من</dt><dd>{siteText(m.from_site)}{m.from_site.lift === false && <span className="muted"> · بلا مصعد</span>}</dd>
          <dt>إلى</dt><dd>{siteText(m.to_site)}</dd>
          <dt>النقل</dt><dd><span className="num">{dt(m.move_at)}</span> · {MV_SIZE[m.home_size]} · {m.hours} ساعات · {m.crew_size} عمال{m.services.length > 0 && <> · {m.services.map((s) => MV_SERVICE[s]).join('، ')}</>}</dd>
          {m.volume_m3 && <><dt>المعاينة</dt><dd className="num">{m.volume_m3} م³ · {m.items.reduce((s, x) => s + x.qty, 0)} قطعة</dd></>}
          {m.quote_amount && <><dt>السعر</dt><dd className="num">{money(m.quote_amount)}{m.deposit_amount && <> · عربون {money(m.deposit_amount)}</>}{m.extra_amount && <> · إضافي {money(m.extra_amount)} · الإجمالي <b>{money(m.total)}</b></>}</dd></>}
          {m.unloaded_at && <><dt>التسليم</dt><dd>{dt(m.unloaded_at)} · استلم {m.received_by}{m.delivery_note && <div className="muted">{m.delivery_note}</div>}</dd></>}
          {m.rating && <><dt>التقييم</dt><dd>{'★'.repeat(m.rating)}{'☆'.repeat(5 - m.rating)} {m.rating_note}</dd></>}
        </dl>
        {m.items.length > 0 && <details><summary>قائمة الأغراض ({m.items.length})</summary><ul data-testid="items">{m.items.map((x) => <li key={x.id}>{x.room ? `${x.room}: ` : ''}{x.name} × {x.qty}{x.fragile && <> <Badge tone="warning">قابل للكسر</Badge></>}</li>)}</ul></details>}
        {live.length > 0 && <div className="tbl-wrap"><table data-testid="crew"><thead><tr><th>المهمة</th><th>الدور</th><th>الاسم</th><th>الشاحنة</th><th>الوقت</th><th>الحالة</th></tr></thead>
          <tbody>{live.map((x) => <tr key={x.task_id}><td className="num">{x.ref}</td><td>{x.role === 'lead' ? 'السائق' : 'عامل'}</td><td>{x.worker_name ?? '—'}</td><td className="num">{x.plate_no ?? ''}</td>
            <td className="num">{time(x.starts_at)}–{time(x.ends_at)}</td><td><Tone map={TASK_STATUS} value={x.status} /></td></tr>)}</tbody></table></div>}

        {w && ['new', 'quoted', 'accepted', 'booked'].includes(m.state) && <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/moving/jobs/${id}/survey`, { method: 'POST',
          body: { ...(f.volume ? { volume_m3: Number(f.volume) } : {}), ...(f.items.trim() ? { items: parseItemLines(f.items) } : {}) } })); }}>
          <h2>المعاينة</h2>
          <div className="row"><label className="field">الحجم (م³)<input {...bind('volume')} type="number" min={0.1} max={500} step={0.1} className="num" style={{ width: 100 }} /></label></div>
          <label className="field">الأغراض: سطر لكل صنف «الغرفة: الصنف × العدد» و* للقابل للكسر<textarea {...bind('items')} rows={4} placeholder={'الصالة: كنبة × 2\nالصالة: تلفزيون × 1 *\nثلاجة'} /></label>
          <button className="secondary" disabled={act.busy}>حفظ المعاينة</button>
        </form>}
        {w && ['new', 'quoted'].includes(m.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/moving/jobs/${id}/quote`, { method: 'POST', body: { quote_amount: f.quote, ...clean({ deposit_amount: f.deposit }) } })); }}>
          <label className="field">السعر (د.ك)<input {...bind('quote')} required inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <label className="field">العربون (د.ك)<input {...bind('deposit')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <button disabled={act.busy}>إرسال السعر</button>
        </form>}
        {w && m.state === 'quoted' && <div className="row">
          <button disabled={act.busy} onClick={() => void run(() => api(`/moving/jobs/${id}/accept`, { method: 'POST', body: { deposit_paid: true } }))}>وافق العميل ودفع العربون</button>
          <button className="secondary" disabled={act.busy} onClick={() => void run(() => api(`/moving/jobs/${id}/accept`, { method: 'POST', body: {} }))}>وافق دون عربون بعد</button>
        </div>}
        {w && ['accepted', 'booked'].includes(m.state) && m.deposit_amount && Number(m.deposit_amount) > 0 && !m.deposit_paid_at &&
          <button className="secondary" disabled={act.busy} onClick={() => void run(() => api(`/moving/jobs/${id}/accept`, { method: 'POST', body: { deposit_paid: true } }))}>استُلم العربون</button>}
        {w && m.state === 'accepted' && <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/moving/jobs/${id}/book`, { method: 'POST',
          body: { driver_worker_id: f.driver, asset_id: f.truck, helper_worker_ids: helpers, ...(f.starts_at ? { starts_at: kwIso(f.starts_at) } : {}) } })); }}>
          <h2>حجز الشاحنة والطاقم</h2>
          <div className="row">
            <label className="field">السائق<select {...bind('driver')} required><option value="">اختر</option>{workers.data?.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
            <label className="field">الشاحنة<select {...bind('truck')} required><option value="">اختر</option>{(assets.data ?? []).filter((a) => !['out_of_service', 'retired'].includes(a.status)).map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
            <label className="field">البداية (إن اختلفت)<input {...bind('starts_at')} type="datetime-local" /></label>
          </div>
          <div className="row" data-testid="helpers">{workers.data?.filter((x) => x.id !== f.driver).map((x) => (
            <label key={x.id} className="check"><input type="checkbox" style={{ width: 'auto' }} checked={helpers.includes(x.id)} onChange={(e) => setHelpers((h) => (e.target.checked ? [...h, x.id] : h.filter((y) => y !== x.id)))} /> {x.display_name}</label>
          ))}</div>
          <p className="muted">العمال المطلوبون: {m.crew_size} · المختارون: {helpers.length}</p>
          <button disabled={act.busy}>حجز</button>
        </form>}
        {w && m.state === 'delivered' && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/moving/jobs/${id}/close`, { method: 'POST',
          body: { ...clean({ extra_amount: f.extra, rating_note: f.rating_note }), ...(f.rating ? { rating: Number(f.rating) } : {}) } })); }}>
          <label className="field">مبالغ إضافية (د.ك)<input {...bind('extra')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <label className="field">تقييم العميل<select {...bind('rating')}><option value="">—</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="field">ملاحظة العميل<input {...bind('rating_note')} maxLength={500} /></label>
          <button disabled={act.busy}>إغلاق الطلب</button>
        </form>}
        {['delivered', 'closed'].includes(m.state) && <section className="stack">
          <h2>مطالبات الأضرار</h2>
          {m.claims.length === 0 ? <Empty>لا توجد مطالبات</Empty> : <div className="tbl-wrap"><table data-testid="claims"><thead><tr><th>القطعة</th><th>الوصف</th><th>المطالب</th><th>الحالة</th><th></th></tr></thead>
            <tbody>{m.claims.map((k) => <tr key={k.id}><td>{k.item}</td><td>{k.description}</td><td className="num">{k.claimed_amount ? money(k.claimed_amount) : '—'}</td>
              <td><Tone map={MV_CLAIM} value={k.status} />{k.settled_amount && <span className="num"> {money(k.settled_amount)}</span>}{k.decision_note && <div className="muted">{k.decision_note}</div>}</td>
              <td>{w && k.status === 'open' && <div className="row">
                <input {...bind('settle')} placeholder="مبلغ التسوية" inputMode="decimal" className="num" style={{ width: 90 }} aria-label="مبلغ التسوية" />
                <input {...bind('settle_note')} placeholder="ملاحظة" maxLength={500} style={{ width: 120 }} aria-label="ملاحظة القرار" />
                <button className="small" disabled={act.busy || !f.settle} onClick={() => void run(async () => { await api(`/moving/claims/${k.id}/decide`, { method: 'POST', body: { status: 'settled', settled_amount: f.settle, ...clean({ note: f.settle_note }) } }); setF((p) => ({ ...p, settle: '', settle_note: '' })); })}>تسوية</button>
                <button className="small danger" disabled={act.busy || !f.settle_note} onClick={() => void run(() => api(`/moving/claims/${k.id}/decide`, { method: 'POST', body: { status: 'rejected', note: f.settle_note } }))}>رفض</button>
              </div>}</td></tr>)}</tbody></table></div>}
          {w && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/moving/jobs/${id}/claims`, { method: 'POST', body: { item: f.c_item, description: f.c_desc, ...clean({ claimed_amount: f.c_amount }) } }); setF((p) => ({ ...p, c_item: '', c_desc: '', c_amount: '' })); }); }}>
            <label className="field">القطعة<input {...bind('c_item')} required maxLength={120} /></label>
            <label className="field">الضرر<input {...bind('c_desc')} required maxLength={1000} /></label>
            <label className="field">المبلغ المطالب (د.ك)<input {...bind('c_amount')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
            <button className="secondary" disabled={act.busy}>تسجيل مطالبة</button>
          </form>}
          <p className="muted" style={{ margin: 0 }}>تُقبل المطالبات خلال 7 أيام من التسليم [تخمين].</p>
        </section>}
        {w && ['new', 'quoted', 'accepted', 'booked'].includes(m.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/moving/jobs/${id}/cancel`, { method: 'POST', body: { reason: f.reason } })); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب الإلغاء" /><button className="danger" disabled={act.busy}>إلغاء الطلب</button>
        </form>}
      </div>}
    </Modal>
  );
}

function BoardView() {
  const [day, setDay] = useState(todayKw());
  const b = useLoad(() => api<{ moves: (Move & { crew: Crew[] })[] }>(`/moving/board?date=${day}`), [day]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={b.error} />
      {(b.data?.moves ?? []).length === 0 ? <Empty>لا توجد عمليات نقل</Empty> : <div className="stack" data-testid="board">{b.data!.moves.map((m) => {
        const lead = m.crew.find((x) => x.role === 'lead');
        return (
          <section key={m.id} className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}><span className="num">{time(m.move_at)}</span> · {m.ref} · {m.customer_name}</h3><Tone map={MV_STATE} value={m.state} /></div>
            <p style={{ margin: '4px 0' }}>{siteText(m.from_site)} ← {siteText(m.to_site)} · {MV_SIZE[m.home_size]}</p>
            <p className="muted" style={{ margin: 0 }}>{lead ? <>الشاحنة <span className="num">{lead.plate_no}</span> · السائق {lead.worker_name} · العمال: {m.crew.filter((x) => x.role === 'helper').map((x) => x.worker_name).join('، ') || '—'}</> : 'لم يُحجز طاقم'}</p>
            <button className="small" onClick={() => setOpen(m.id)}>إدارة</button>
          </section>
        );
      })}</div>}
      {open && <MoveModal id={open} onClose={() => { setOpen(null); void b.reload(); }} />}
    </div>
  );
}

function ExceptionsView() {
  const x = useLoad(() => api<{ to_quote: Move[]; awaiting_answer: Move[]; to_book: Move[]; deposit_unpaid: Move[]; to_close: Move[]; claims: Claim[] }>('/moving/exceptions'));
  const [open, setOpen] = useState<string | null>(null);
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="بلا سعر منذ يومين" value={d.to_quote.length} tone={d.to_quote.length ? 'warning' : undefined} />
          <Kpi label="قريبة بلا طاقم" value={d.to_book.length} tone={d.to_book.length ? 'danger' : undefined} />
          <Kpi label="عربون غير مدفوع" value={d.deposit_unpaid.length} />
          <Kpi label="مطالبات مفتوحة" value={d.claims.length} tone={d.claims.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>طلبات بلا عرض سعر منذ 48 ساعة [تخمين]</h2><MovesTable rows={d.to_quote} onPick={(m) => setOpen(m.id)} testId="ex-quote" /></section>
        <section className="card"><h2>عروض بانتظار رد العميل</h2><MovesTable rows={d.awaiting_answer} onPick={(m) => setOpen(m.id)} testId="ex-answer" /></section>
        <section className="card"><h2>موافق عليها وموعدها خلال يومين بلا طاقم [تخمين]</h2><MovesTable rows={d.to_book} onPick={(m) => setOpen(m.id)} testId="ex-book" /></section>
        <section className="card"><h2>عربون غير مدفوع</h2><MovesTable rows={d.deposit_unpaid} onPick={(m) => setOpen(m.id)} testId="ex-deposit" /></section>
        <section className="card"><h2>وصلت وجاهزة للإغلاق</h2><MovesTable rows={d.to_close} onPick={(m) => setOpen(m.id)} testId="ex-close" /></section>
        <section className="card"><h2>مطالبات أضرار مفتوحة</h2>
          {d.claims.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ex-claims"><thead><tr><th>الطلب</th><th>العميل</th><th>القطعة</th><th>الضرر</th><th>المطالب</th><th></th></tr></thead>
            <tbody>{d.claims.map((k) => <tr key={k.id}><td className="num">{k.ref}</td><td>{k.customer_name}</td><td>{k.item}</td><td>{k.description}</td><td className="num">{k.claimed_amount ? money(k.claimed_amount) : '—'}</td>
              <td><button className="small" onClick={() => setOpen(k.job_id!)}>إدارة</button></td></tr>)}</tbody></table></div>}
        </section>
      </>}
      {open && <MoveModal id={open} onClose={() => { setOpen(null); void x.reload(); }} />}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<{ totals: { requests: number; quoted: number; accepted: number; canceled: number; delivered: number; closed: number; acceptance_pct: number | null; revenue: string; avg_rating: number | null;
    claims: number; claims_open: number; claims_settled: string }; sizes: { home_size: string; moves: number }[] }>(`/moving/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4" data-testid="mv-kpis">
          <Kpi label="طلبات" value={`${x.closed} مغلق / ${x.requests}`} />
          <Kpi label="نسبة قبول العروض" value={x.acceptance_pct === null ? '—' : `${x.acceptance_pct}%`} tone="success" />
          <Kpi label="الإيراد" value={money(x.revenue)} />
          <Kpi label="متوسط التقييم" value={x.avg_rating === null ? '—' : `${x.avg_rating} / 5`} />
        </div>
        <p className="muted">عروض: {x.quoted} · مقبولة: {x.accepted} · ملغاة: {x.canceled} · مطالبات: {x.claims} (مفتوحة {x.claims_open}) · تعويضات: {money(x.claims_settled)}</p>
        <section className="card"><h2>حسب الحجم</h2>
          {r.data!.sizes.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table><thead><tr><th>الحجم</th><th>عمليات</th></tr></thead>
            <tbody>{r.data!.sizes.map((s) => <tr key={s.home_size}><td>{MV_SIZE[s.home_size]}</td><td className="num">{s.moves}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
