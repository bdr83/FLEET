'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { kwIso } from '@/components/internal';
import { dt, PC_INFESTATION, PC_PEST, PC_PREMISES, PC_SERVICE, PC_STATE, PC_UNIT, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Product { id: string; name: string; active_ingredient: string | null; registration_no: string | null; unit: string; reentry_hours: number; active: boolean; version: number }
interface Job {
  id: string; ref: string; customer_id: string; customer_name: string; premises: string; area: string; address: string | null; contact_phone: string | null; pests: string[]; service: string;
  scheduled_at: string; duration_min: number; warranty_days: number; repeat_days: number | null; parent_job_id: string | null; parent_ref: string | null; in_warranty: boolean; notes: string | null;
  task_id: string | null; arrived_at: string | null; treated_at: string | null; infestation: string | null; received_by: string | null; result_note: string | null; reentry_at: string | null;
  next_job_id: string | null; next_ref: string | null; canceled_at: string | null; cancel_reason: string | null; technician_name: string | null; plate_no: string | null; fail_reason: string | null; state: string;
}
type Detail = Job & { applications: { id: string; product_name: string; unit: string; registration_no: string | null; qty: number; location: string | null; applied_at: string }[];
  callbacks: { id: string; ref: string; scheduled_at: string; in_warranty: boolean }[] };
type Tab = 'jobs' | 'products' | 'exceptions' | 'report';

const kwLocal = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);
const hhmm = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16) : '—');
const pestsText = (p: string[]) => p.map((x) => PC_PEST[x] ?? x).join('، ');

/** Pest control (sector 26): jobs with the technician and the treatment record, the pesticide register, exceptions and the report. */
export default function PestPage() {
  const [tab, setTab] = useState<Tab>('jobs');
  return (
    <div className="page stack">
      <div className="page-head"><h1>مكافحة الحشرات والقوارض</h1></div>
      <Tabs tabs={[['jobs', 'الأوامر'], ['products', 'سجل المبيدات'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'jobs' && <JobsView />}
      {tab === 'products' && <ProductsView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function JobTable({ id, rows, onOpen }: { id: string; rows: Job[]; onOpen?: (id: string) => void }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th>الأمر</th><th>العميل والموقع</th><th>الخدمة</th><th>الموعد</th><th>الفني</th><th>الحالة</th>{onOpen && <th></th>}</tr></thead>
      <tbody>{rows.map((j) => (
        <tr key={j.id}><td><span className="num">{j.ref}</span>{j.parent_ref && <div><Badge tone={j.in_warranty ? 'warning' : 'info'}>{j.in_warranty ? 'ضمان' : 'إعادة'} {j.parent_ref}</Badge></div>}
          {j.repeat_days && <div className="muted">كل {j.repeat_days} يوم</div>}</td>
          <td>{j.customer_name}<div className="muted">{PC_PREMISES[j.premises]} · {j.area}</div></td>
          <td>{PC_SERVICE[j.service]}<div className="muted">{pestsText(j.pests)}</div></td>
          <td className="num">{dt(j.scheduled_at)}</td>
          <td>{j.technician_name ?? '—'}</td>
          <td><Tone map={PC_STATE} value={j.state} />{j.infestation && <div><Tone map={PC_INFESTATION} value={j.infestation} /></div>}</td>
          {onOpen && <td><button className="small" onClick={() => onOpen(j.id)}>فتح</button></td>}</tr>
      ))}</tbody></table></div>
  );
}

function JobsView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const list = useLoad(() => api<{ data: Job[] }>(`/pest/jobs?date=${day}`).then((r) => r.data), [day]);
  const [add, setAdd] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الأوامر" /></label>
        {can(me, 'tasks:assign') && <button onClick={() => setAdd(true)}>أمر مكافحة جديد</button>}
        <button className="secondary" onClick={() => void list.reload()}>تحديث</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>أوامر اليوم وكل أمر سابق ما زال مفتوحًا.</p>
      <ErrorBox error={list.error} />
      {list.data && <JobTable id="jobs" rows={list.data} onOpen={setOpen} />}
      {add && <JobForm onClose={() => setAdd(false)} onDone={(id) => { setAdd(false); setOpen(id); void list.reload(); }} />}
      {open && <JobModal id={open} onOpen={setOpen} onClose={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function JobForm({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const { f, bind } = useForm({ customer_id: '', premises: 'home', service: 'spray', scheduled_at: kwLocal(new Date(Date.now() + 3_600_000)), area: '', address: '', contact_phone: '',
    minutes: '90', warranty_days: '30', repeat_days: '', notes: '' });
  const [pests, setPests] = useState<string[]>(['cockroaches']);
  return (
    <Modal title="أمر مكافحة جديد" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const j = await api<Job>('/pest/jobs', { method: 'POST', body: {
          legal_entity_id: me.legal_entities[0]?.id, customer_id: f.customer_id, premises: f.premises, service: f.service, pests, scheduled_at: kwIso(f.scheduled_at), area: f.area,
          duration_min: Number(f.minutes) || 90, warranty_days: Number(f.warranty_days) || 0, ...(f.repeat_days ? { repeat_days: Number(f.repeat_days) } : {}),
          ...clean({ address: f.address, contact_phone: f.contact_phone, notes: f.notes }),
        } });
        onDone(j.id);
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">نوع المنشأة<select {...bind('premises')}>{Object.entries(PC_PREMISES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">الخدمة<select {...bind('service')}>{Object.entries(PC_SERVICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <fieldset className="row" aria-label="الآفات">{Object.entries(PC_PEST).map(([k, l]) => (
          <label key={k} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} name={`pest-${k}`} checked={pests.includes(k)}
            onChange={(e) => setPests(e.target.checked ? [...pests, k] : pests.filter((x) => x !== k))} /> {l}</label>
        ))}</fieldset>
        <div className="row">
          <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
          <label className="field">العنوان<input {...bind('address')} maxLength={200} /></label>
          <label className="field">هاتف التواصل<input {...bind('contact_phone')} maxLength={20} className="num" /></label>
        </div>
        <div className="row">
          <label className="field">الموعد<input {...bind('scheduled_at')} type="datetime-local" required /></label>
          <label className="field">المدة (دقيقة)<input {...bind('minutes')} type="number" min={15} max={600} className="num" style={{ width: 90 }} /></label>
          <label className="field">الضمان (يوم)<input {...bind('warranty_days')} type="number" min={0} max={365} className="num" style={{ width: 90 }} /></label>
          <label className="field">عقد دوري كل (يوم)<input {...bind('repeat_days')} type="number" min={7} max={365} className="num" style={{ width: 100 }} placeholder="—" /></label>
        </div>
        <label className="field">ملاحظات للفني<input {...bind('notes')} maxLength={500} /></label>
        <button disabled={act.busy || pests.length === 0}>حفظ الأمر</button>
      </form>
    </Modal>
  );
}

function JobModal({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const me = useMe();
  const j = useLoad(() => api<Detail>(`/pest/jobs/${id}`), [id]);
  const d = j.data;
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string }[] }>('/workers?status=active').then((x) => x.data.filter((w) => ['technician', 'supervisor'].includes(w.kind))));
  const assets = useLoad(() => api<{ data: { id: string; plate_no: string | null; status: string }[] }>('/assets').then((x) => x.data.filter((a) => !['retired', 'out_of_service'].includes(a.status))));
  const act = useAction();
  const { f, bind } = useForm({ worker_id: '', asset_id: '', reason: '', cb_reason: '', cb_at: kwLocal(new Date(Date.now() + 86_400_000)) });
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/pest/jobs/${id}/${path}`, { method: 'POST', body }); await j.reload(); });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={d ? `أمر المكافحة ${d.ref}` : 'أمر المكافحة'} onClose={onClose}>
      <ErrorBox error={j.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={PC_STATE} value={d.state} /> <b>{d.customer_name}</b> · {PC_PREMISES[d.premises]} · {[d.address, d.area].filter(Boolean).join('، ')}{d.contact_phone && <> · <span className="num">{d.contact_phone}</span></>}</p>
        <p>{PC_SERVICE[d.service]}: {pestsText(d.pests)} · الموعد <span className="num">{dt(d.scheduled_at)}</span> · ضمان {d.warranty_days} يوم{d.repeat_days && <> · عقد كل {d.repeat_days} يوم</>}</p>
        {d.parent_ref && <p><Badge tone={d.in_warranty ? 'warning' : 'info'}>{d.in_warranty ? 'إعادة زيارة ضمن الضمان' : 'إعادة زيارة خارج الضمان'}</Badge> للأمر <span className="num">{d.parent_ref}</span></p>}
        {d.notes && <p className="muted">{d.notes}</p>}
        {d.technician_name && <p data-testid="job-tech">الفني {d.technician_name}{d.plate_no && <> · <span className="num">{d.plate_no}</span></>} · وصل {hhmm(d.arrived_at)} · عالج {hhmm(d.treated_at)}</p>}
        {d.treated_at && <div data-testid="job-treatment" className="stack">
          <p>الإصابة: <Tone map={PC_INFESTATION} value={d.infestation ?? ''} /> · استلم {d.received_by}{d.result_note && <> · {d.result_note}</>}</p>
          {d.reentry_at && new Date(d.reentry_at) > new Date(d.treated_at) && <p><Badge tone="warning">لا دخول قبل {hhmm(d.reentry_at)}</Badge></p>}
          {d.applications.length > 0 && <div className="tbl-wrap"><table data-testid="applications"><thead><tr><th>المبيد</th><th>رقم التسجيل</th><th>الكمية</th><th>المكان</th></tr></thead>
            <tbody>{d.applications.map((x) => <tr key={x.id}><td>{x.product_name}</td><td className="num">{x.registration_no ?? '—'}</td><td className="num">{x.qty} {PC_UNIT[x.unit]}</td><td>{x.location ?? '—'}</td></tr>)}</tbody></table></div>}
        </div>}
        {d.next_ref && <p>الزيارة التالية من العقد: <button className="small secondary" onClick={() => onOpen(d.next_job_id!)}>{d.next_ref}</button></p>}
        {d.callbacks.length > 0 && <p>إعادات الزيارة: {d.callbacks.map((x) => <button key={x.id} className="small secondary" onClick={() => onOpen(x.id)}>{x.ref}</button>)}</p>}
        {d.fail_reason && <p className="muted">تعذّرت الزيارة: {d.fail_reason}</p>}
        {d.canceled_at && <p className="muted">أُلغي: {d.cancel_reason}</p>}
        {w && ['open', 'assigned', 'failed'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('assign', { worker_id: f.worker_id, ...clean({ asset_id: f.asset_id }) }); }}>
          <label className="field">الفني<select {...bind('worker_id')} required><option value="">—</option>{workers.data?.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
          <label className="field">السيارة (اختيارية)<select {...bind('asset_id')}><option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          <button disabled={act.busy}>{d.state === 'assigned' ? 'تغيير الفني' : 'إسناد الفني'}</button>
        </form>}
        {w && d.state === 'done' && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          const n = await api<Job>(`/pest/jobs/${id}/callback`, { method: 'POST', body: { reason: f.cb_reason, scheduled_at: kwIso(f.cb_at) } }); onOpen(n.id);
        }); }}>
          <input {...bind('cb_reason')} required maxLength={500} placeholder="سبب إعادة الزيارة (عادت الحشرات...)" aria-label="سبب إعادة الزيارة" />
          <input {...bind('cb_at')} type="datetime-local" required aria-label="موعد إعادة الزيارة" />
          <button className="secondary" disabled={act.busy}>إعادة زيارة</button>
        </form>}
        {w && ['open', 'assigned', 'failed'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={300} aria-label="سبب إلغاء الأمر" />
          <button className="danger" disabled={act.busy}>إلغاء الأمر</button>
        </form>}
      </div>}
    </Modal>
  );
}

function ProductsView() {
  const me = useMe();
  const list = useLoad(() => api<{ data: Product[] }>('/pest/products').then((r) => r.data));
  const act = useAction();
  const { f, bind, setF } = useForm({ name: '', active_ingredient: '', registration_no: '', unit: 'ml', reentry_hours: '0' });
  const w = can(me, 'tasks:assign');
  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>سجل المبيدات</h2>
      <p className="muted" style={{ margin: 0 }}>الفني يختار من هذه القائمة عند العلاج. مدة منع الدخول تُحسب من أطول مدة بين المبيدات المستخدمة.</p>
      <ErrorBox error={act.error ?? list.error} />
      {list.data?.length === 0 ? <Empty>لا مبيدات بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="products"><thead><tr><th>المبيد</th><th>المادة الفعالة</th><th>رقم التسجيل</th><th>الوحدة</th><th>منع الدخول</th>{w && <th></th>}</tr></thead>
          <tbody>{list.data?.map((p) => (
            <tr key={p.id} className={p.active ? '' : 'muted'}><td>{p.name}</td><td>{p.active_ingredient ?? '—'}</td>
              <td className="num">{p.registration_no ?? <Badge tone="warning">بلا رقم</Badge>}</td><td>{PC_UNIT[p.unit]}</td><td className="num">{p.reentry_hours ? `${p.reentry_hours} س` : '—'}</td>
              {w && <td>{p.active && <button className="small secondary" disabled={act.busy} onClick={() => void act.run(async () => {
                await api(`/pest/products/${p.id}`, { method: 'PATCH', body: { version: p.version, active: false } }); await list.reload();
              })}>إيقاف</button>}</td>}</tr>
          ))}</tbody></table></div>
      )}
      {w && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api('/pest/products', { method: 'POST', body: { name: f.name, unit: f.unit, reentry_hours: Number(f.reentry_hours) || 0, ...clean({ active_ingredient: f.active_ingredient, registration_no: f.registration_no }) } });
        setF({ name: '', active_ingredient: '', registration_no: '', unit: f.unit, reentry_hours: '0' }); await list.reload();
      }); }}>
        <label className="field">المبيد<input {...bind('name')} required maxLength={120} /></label>
        <label className="field">المادة الفعالة<input {...bind('active_ingredient')} maxLength={120} /></label>
        <label className="field">رقم التسجيل<input {...bind('registration_no')} maxLength={60} className="num" /></label>
        <label className="field">الوحدة<select {...bind('unit')}>{Object.entries(PC_UNIT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">منع الدخول (ساعة)<input {...bind('reentry_hours')} type="number" min={0} max={72} className="num" style={{ width: 80 }} /></label>
        <button disabled={act.busy}>إضافة</button>
      </form>}
    </section>
  );
}

function ExceptionsView() {
  type X = { unassigned: Job[]; overdue: Job[]; callbacks: Job[]; high_infestation: Job[]; license_missing: Job[]; unregistered_products: Product[] };
  const x = useLoad(() => api<X>('/pest/exceptions'));
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="بلا فني خلال 24 ساعة" value={d.unassigned.length} tone={d.unassigned.length ? 'warning' : undefined} />
          <Kpi label="تجاوزت موعدها" value={d.overdue.length} tone={d.overdue.length ? 'danger' : undefined} />
          <Kpi label="إعادات زيارة مفتوحة" value={d.callbacks.length} tone={d.callbacks.length ? 'warning' : undefined} />
          <Kpi label="فنيون بلا ترخيص ساري" value={d.license_missing.length} tone={d.license_missing.length ? 'danger' : undefined} />
        </div>
        <section className="card"><h2>بلا فني وموعدها خلال 24 ساعة [تخمين]</h2><JobTable id="ex-unassigned" rows={d.unassigned} /></section>
        <section className="card"><h2>تجاوزت موعدها ولم تُعالج</h2><JobTable id="ex-overdue" rows={d.overdue} /></section>
        <section className="card"><h2>إعادات زيارة مفتوحة</h2><JobTable id="ex-callbacks" rows={d.callbacks} /></section>
        <section className="card"><h2>الفني بلا ترخيص مبيدات ساري يوم الزيارة</h2><JobTable id="ex-license" rows={d.license_missing} /></section>
        <section className="card"><h2>إصابة شديدة في آخر 30 يومًا</h2><JobTable id="ex-high" rows={d.high_infestation} /></section>
        <section className="card"><h2>مبيدات بلا رقم تسجيل</h2>{d.unregistered_products.length === 0 ? <Empty>لا يوجد</Empty> : (
          <ul data-testid="ex-products">{d.unregistered_products.map((p) => <li key={p.id}>{p.name}{p.active_ingredient && ` (${p.active_ingredient})`}</li>)}</ul>)}</section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type C = { key: string; jobs: number; done: number; high: number };
  type R = { totals: { jobs: number; done: number; callbacks: number; in_warranty: number; callback_rate: number | null; high: number }; pests: C[]; premises: C[];
    products: { name: string; unit: string; registration_no: string | null; qty: number; jobs: number }[] };
  const r = useLoad(() => api<R>(`/pest/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  const table = (id: string, rows: C[], label: Record<string, string>) => rows.length === 0 ? <Empty>لا أوامر</Empty> : (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th></th><th>أوامر</th><th>مغلقة</th><th>إصابة شديدة</th></tr></thead>
      <tbody>{rows.map((s) => <tr key={s.key}><td>{label[s.key] ?? s.key}</td><td className="num">{s.jobs}</td><td className="num">{s.done}</td><td className="num">{s.high}</td></tr>)}</tbody></table></div>
  );
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4">
          <Kpi label="أوامر مغلقة" value={`${x.done} / ${x.jobs}`} />
          <Kpi label="إعادات الزيارة" value={`${x.callbacks} (ضمان ${x.in_warranty})`} />
          <Kpi label="نسبة إعادة الزيارة" value={x.callback_rate === null ? '—' : `${x.callback_rate}%`} tone={x.callback_rate && x.callback_rate > 10 ? 'warning' : undefined} />
          <Kpi label="إصابات شديدة" value={x.high} />
        </div>
        <section className="card"><h2>حسب الآفة</h2>{table('pc-report-pests', r.data!.pests, PC_PEST)}</section>
        <section className="card"><h2>حسب نوع المنشأة</h2>{table('pc-report-premises', r.data!.premises, PC_PREMISES)}</section>
        <section className="card"><h2>المبيدات المستخدمة</h2>{r.data!.products.length === 0 ? <Empty>لا استخدام</Empty> : (
          <div className="tbl-wrap"><table data-testid="pc-report-products"><thead><tr><th>المبيد</th><th>رقم التسجيل</th><th>الكمية</th><th>أوامر</th></tr></thead>
            <tbody>{r.data!.products.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{p.registration_no ?? '—'}</td><td className="num">{p.qty} {PC_UNIT[p.unit]}</td><td className="num">{p.jobs}</td></tr>)}</tbody></table></div>)}</section>
      </>}
    </div>
  );
}
