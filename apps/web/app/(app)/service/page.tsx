'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, money, qtyText, SVC_CATEGORY, SVC_KIND, SVC_PRIORITY, SVC_RESULT, SVC_STATE, TASK_STATUS, time, todayKw } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

type Site = Record<string, string>;
interface Visit {
  task_id: string; job_id: string; job_ref: string; seq: number; status: string; starts_at: string; ends_at: string; technician_name: string | null; arrived_at: string | null;
  result: string | null; work_done: string | null; signed_by: string | null; finished_at: string | null; parts: { name: string; qty: number }[];
  customer_name: string; site: Site; category: string; priority: string; problem: string;
}
interface Job {
  id: string; ref: string; customer_id: string; customer_name: string; site: Site; category: string; kind: string; priority: string; problem: string; unit: Site | null; due_by: string;
  outcome: string | null; labour_amount: string | null; parts_amount: string | null; total: string; closed_at: string | null; created_at: string; first_arrival: string | null;
  state: string; technician_name?: string | null; visits?: Visit[]; visits_count?: number;
}
type Tab = 'jobs' | 'board' | 'plans' | 'exceptions' | 'report';

const siteText = (s: Site) => [s.name, s.area, s.block && `ق ${s.block}`, s.street].filter(Boolean).join('، ') || '—';
const late = (j: Job) => !j.first_arrival && !j.closed_at && Date.parse(j.due_by) < Date.now();

/** Technical maintenance (sector 22): jobs and visits, today's board, preventive plans, exceptions and the report. */
export default function ServicePage() {
  const [tab, setTab] = useState<Tab>('jobs');
  return (
    <div className="page stack">
      <div className="page-head"><h1>الصيانة الفنية</h1></div>
      <Tabs tabs={[['jobs', 'البلاغات'], ['board', 'لوحة اليوم'], ['plans', 'الصيانة الدورية'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'jobs' && <JobsView />}
      {tab === 'board' && <BoardView />}
      {tab === 'plans' && <PlansView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function JobsTable({ rows, onPick, testId }: { rows: Job[]; onPick?: (j: Job) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>البلاغ</th><th>العميل والموقع</th><th>النوع</th><th>المشكلة</th><th>الأولوية</th><th>الاستجابة قبل</th><th>الفني</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{rows.map((j) => (
        <tr key={j.id}><td className="num">{j.ref}</td><td>{j.customer_name} · {siteText(j.site)}</td><td>{SVC_CATEGORY[j.category]} · {SVC_KIND[j.kind]}</td><td>{j.problem}</td>
          <td><Tone map={SVC_PRIORITY} value={j.priority} /></td><td className="num">{dt(j.due_by)}{late(j) && <> <Badge tone="danger">متأخر</Badge></>}</td>
          <td>{j.technician_name ?? '—'}</td><td><Tone map={SVC_STATE} value={j.state} /></td>
          <td>{onPick && <button className="small" onClick={() => onPick(j)}>إدارة</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function JobsView() {
  const me = useMe();
  const [state, setState] = useState('');
  const jobs = useLoad(() => api<{ data: Job[] }>(`/service/jobs${state ? `?state=${state}` : ''}`).then((r) => r.data), [state]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={jobs.error} />
      <div className="row">
        {can(me, 'tasks:assign') && <button onClick={() => setAdding(true)}>بلاغ جديد</button>}
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="الحالة" style={{ maxWidth: 200 }}>
          <option value="">كل الحالات</option>{Object.entries(SVC_STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <JobsTable rows={jobs.data ?? []} onPick={(j) => setOpen(j.id)} testId="jobs" />
      {adding && <JobForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void jobs.reload(); }} />}
      {open && <JobModal id={open} onClose={() => { setOpen(null); void jobs.reload(); }} />}
    </section>
  );
}

function useCustomers() {
  return useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
}

function SiteFields({ bind }: { bind: (k: 'site_name' | 'area' | 'block' | 'street' | 'phone') => { name: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void } }) {
  return (
    <div className="row">
      <label className="field">اسم الموقع<input {...bind('site_name')} maxLength={120} placeholder="فيلا، مكتب، مبنى" /></label>
      <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
      <label className="field">القطعة<input {...bind('block')} maxLength={10} className="num" style={{ width: 70 }} /></label>
      <label className="field">الشارع<input {...bind('street')} maxLength={80} /></label>
      <label className="field">هاتف الموقع<input {...bind('phone')} maxLength={20} className="num" dir="ltr" /></label>
    </div>
  );
}

function JobForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useCustomers();
  const { f, bind } = useForm({ customer_id: '', new_name: '', site_name: '', area: '', block: '', street: '', phone: '', category: 'ac', kind: 'repair', priority: 'normal', problem: '', brand: '', model: '', location: '' });
  return (
    <Modal title="بلاغ صيانة جديد" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const le = me.legal_entities[0]?.id;
        let customer = f.customer_id;
        if (customer === 'new') customer = (await api<{ id: string }>('/customers', { method: 'POST', body: { legal_entity_id: le, kind: 'individual', name: f.new_name, ...clean({ phone: f.phone }) } })).id;
        const unit = clean({ brand: f.brand, model: f.model, location: f.location });
        await api('/service/jobs', { method: 'POST', body: { legal_entity_id: le, customer_id: customer, site: clean({ name: f.site_name, area: f.area, block: f.block, street: f.street, phone: f.phone }),
          category: f.category, kind: f.kind, priority: f.priority, problem: f.problem, ...(Object.keys(unit).length ? { unit } : {}) } });
        onDone();
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option><option value="new">+ عميل جديد (فرد)</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          {f.customer_id === 'new' && <label className="field">اسم العميل<input {...bind('new_name')} required maxLength={200} /></label>}
        </div>
        <SiteFields bind={bind} />
        <div className="row">
          <label className="field">التخصص<select {...bind('category')}>{Object.entries(SVC_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">النوع<select {...bind('kind')}>{Object.entries(SVC_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">الأولوية<select {...bind('priority')}>{Object.entries(SVC_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        </div>
        <label className="field">المشكلة<textarea {...bind('problem')} required maxLength={1000} rows={2} /></label>
        <div className="row">
          <label className="field">الجهاز: الماركة<input {...bind('brand')} maxLength={60} /></label>
          <label className="field">الموديل<input {...bind('model')} maxLength={60} /></label>
          <label className="field">مكانه<input {...bind('location')} maxLength={60} placeholder="الصالة، السطح…" /></label>
        </div>
        <p className="muted">موعد الاستجابة: عاجل 4 ساعات، عادي 24 ساعة، منخفض 72 ساعة [تخمين].</p>
        <button disabled={act.busy}>فتح البلاغ</button>
      </form>
    </Modal>
  );
}

function JobModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Job & { visits: Visit[] }>(`/service/jobs/${id}`), [id]);
  const workers = useLoad(() => api<{ data: { id: string; display_name: string }[] }>('/workers?status=active').then((x) => x.data));
  const assets = useAssets();
  const act = useAction();
  const { f, bind } = useForm({ tech: '', van: '', starts_at: new Date(Date.now() + 3 * 3_600_000 + 30 * 60_000).toISOString().slice(0, 16), duration: '120',
    result: 'fixed', work_done: '', signed_by: '', part: '', qty: '1', labour: '', parts_amount: '', reason: '' });
  const j = d.data;
  const w = can(me, 'tasks:assign');
  const run = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); await d.reload(); });
  const openVisit = j?.visits.find((x) => !x.result && !['canceled', 'failed'].includes(x.status));
  return (
    <Modal title={j ? `بلاغ ${j.ref}` : 'بلاغ'} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {j && <div className="stack">
        <div className="row"><Tone map={SVC_STATE} value={j.state} /><Tone map={SVC_PRIORITY} value={j.priority} />{late(j) && <Badge tone="danger">تجاوز موعد الاستجابة</Badge>}</div>
        <dl className="dl">
          <dt>العميل</dt><dd>{j.customer_name} · {siteText(j.site)} {j.site.phone && <span className="num muted">{j.site.phone}</span>}</dd>
          <dt>المطلوب</dt><dd>{SVC_CATEGORY[j.category]} · {SVC_KIND[j.kind]} · {j.problem}</dd>
          {j.unit && <><dt>الجهاز</dt><dd>{Object.values(j.unit).join(' · ')}</dd></>}
          <dt>الاستجابة قبل</dt><dd className="num">{dt(j.due_by)}{j.first_arrival && <> · وصل الفني {dt(j.first_arrival)}</>}</dd>
          {j.closed_at && <><dt>الإغلاق</dt><dd><Tone map={SVC_RESULT} value={j.outcome ?? 'not_fixed'} /> · عمالة {money(j.labour_amount)} · قطع {money(j.parts_amount)} · <b className="num">{money(j.total)}</b></dd></>}
        </dl>
        {j.visits.length > 0 && <div className="tbl-wrap"><table data-testid="visits"><thead><tr><th>#</th><th>الموعد</th><th>الفني</th><th>الحالة</th><th>النتيجة</th><th>العمل والقطع</th></tr></thead>
          <tbody>{j.visits.map((x) => (
            <tr key={x.task_id}><td className="num">{x.seq}</td><td className="num">{dt(x.starts_at)}</td><td>{x.technician_name ?? '—'}</td><td><Tone map={TASK_STATUS} value={x.status} /></td>
              <td>{x.result ? <Tone map={SVC_RESULT} value={x.result} /> : '—'}</td>
              <td>{x.work_done ?? ''}{x.parts.length > 0 && <div className="muted">{x.parts.map((p) => `${p.name} × ${qtyText(p.qty)}`).join('، ')}</div>}{x.signed_by && <div className="muted">استلم: {x.signed_by}</div>}</td></tr>
          ))}</tbody></table></div>}
        {w && ['new', 'follow_up'].includes(j.state) && <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/service/jobs/${id}/visits`, { method: 'POST',
          body: { technician_worker_id: f.tech, starts_at: kwIso(f.starts_at), duration_min: Number(f.duration), ...(f.van ? { asset_id: f.van } : {}) } })); }}>
          <h2>حجز زيارة</h2>
          <div className="row">
            <label className="field">الفني<select {...bind('tech')} required><option value="">اختر</option>{workers.data?.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
            <label className="field">السيارة (اختياري)<select {...bind('van')}><option value="">بدون</option>{(assets.data ?? []).filter((a) => !['out_of_service', 'retired'].includes(a.status)).map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
            <label className="field">الموعد<input {...bind('starts_at')} type="datetime-local" required /></label>
            <label className="field">المدة (دقيقة)<input {...bind('duration')} type="number" min={15} max={720} className="num" style={{ width: 90 }} /></label>
          </div>
          <button disabled={act.busy}>حجز الزيارة</button>
        </form>}
        {w && openVisit && <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/service/visits/${openVisit.task_id}/record`, { method: 'POST',
          body: { result: f.result, work_done: f.work_done, ...clean({ signed_by: f.signed_by }), parts: f.part ? [{ name: f.part, qty: Number(f.qty) }] : [] } })); }}>
          <h2>تسجيل الزيارة {openVisit.seq} من بطاقة العمل</h2>
          <div className="row">
            <label className="field">النتيجة<select {...bind('result')}>{Object.entries(SVC_RESULT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
            <label className="field">ما تم من عمل<input {...bind('work_done')} required maxLength={1000} /></label>
            <label className="field">اسم العميل<input {...bind('signed_by')} maxLength={120} /></label>
          </div>
          <div className="row">
            <label className="field">قطعة مستخدمة<input {...bind('part')} maxLength={120} /></label>
            <label className="field">الكمية<input {...bind('qty')} type="number" min={0.01} step={0.01} className="num" style={{ width: 80 }} /></label>
          </div>
          <button className="secondary" disabled={act.busy}>حفظ الزيارة</button>
        </form>}
        {w && ['to_close', 'follow_up'].includes(j.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/service/jobs/${id}/close`, { method: 'POST',
          body: clean({ labour_amount: f.labour, parts_amount: f.parts_amount }) })); }}>
          <label className="field">العمالة (د.ك)<input {...bind('labour')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <label className="field">القطع (د.ك)<input {...bind('parts_amount')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <button disabled={act.busy}>إغلاق البلاغ</button>
        </form>}
        {w && ['new', 'scheduled', 'follow_up'].includes(j.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/service/jobs/${id}/cancel`, { method: 'POST', body: { reason: f.reason } })); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب الإلغاء" /><button className="danger" disabled={act.busy}>إلغاء البلاغ</button>
        </form>}
      </div>}
    </Modal>
  );
}

function BoardView() {
  const [day, setDay] = useState(todayKw());
  const b = useLoad(() => api<{ visits: Visit[]; waiting: Job[] }>(`/service/board?date=${day}`), [day]);
  const [open, setOpen] = useState<string | null>(null);
  const byTech = new Map<string, Visit[]>();
  for (const x of b.data?.visits ?? []) byTech.set(x.technician_name ?? '—', [...(byTech.get(x.technician_name ?? '—') ?? []), x]);
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={b.error} />
      <section className="card"><h2>بلاغات بانتظار فني</h2><JobsTable rows={b.data?.waiting ?? []} onPick={(j) => setOpen(j.id)} testId="waiting" /></section>
      <section className="card"><h2>زيارات اليوم حسب الفني</h2>
        {byTech.size === 0 ? <Empty>لا توجد زيارات</Empty> : <div className="stack" data-testid="board">{[...byTech.entries()].map(([tech, list]) => (
          <div key={tech}><h3 style={{ margin: '4px 0' }}>{tech} <span className="muted">({list.length})</span></h3>
            <div className="tbl-wrap"><table><tbody>{list.map((x) => (
              <tr key={x.task_id}><td className="num">{time(x.starts_at)}–{time(x.ends_at)}</td><td className="num">{x.job_ref}</td><td>{x.customer_name} · {siteText(x.site)}</td>
                <td>{SVC_CATEGORY[x.category]} · {x.problem}</td><td><Tone map={TASK_STATUS} value={x.status} /></td><td>{x.result ? <Tone map={SVC_RESULT} value={x.result} /> : x.arrived_at ? <Badge tone="success">في الموقع</Badge> : ''}</td></tr>
            ))}</tbody></table></div></div>
        ))}</div>}
      </section>
      {open && <JobModal id={open} onClose={() => { setOpen(null); void b.reload(); }} />}
    </div>
  );
}

function PlansView() {
  const me = useMe();
  const act = useAction();
  const plans = useLoad(() => api<{ data: { id: string; customer_name: string; name: string; site: Site; category: string; every_days: number; next_due: string; ends_on: string | null; active: boolean; jobs: number }[] }>('/service/plans').then((r) => r.data));
  const customers = useCustomers();
  const { f, bind } = useForm({ customer_id: '', name: '', site_name: '', area: '', block: '', street: '', phone: '', category: 'ac', every_days: '90', first_due: todayKw(), ends_on: '', tasks_note: '' });
  const [made, setMade] = useState<string[] | null>(null);
  const w = can(me, 'tasks:assign');
  return (
    <div className="stack">
      <ErrorBox error={plans.error ?? act.error} />
      {w && <section className="card"><h2>عقد صيانة دورية جديد</h2>
        <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api('/service/plans', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, customer_id: f.customer_id, name: f.name, category: f.category, every_days: Number(f.every_days), first_due: f.first_due,
            site: clean({ name: f.site_name, area: f.area, block: f.block, street: f.street, phone: f.phone }), ...clean({ ends_on: f.ends_on, tasks_note: f.tasks_note }) } });
          await plans.reload();
        }); }}>
          <div className="row">
            <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">اسم العقد<input {...bind('name')} required maxLength={120} placeholder="تنظيف المكيفات" /></label>
            <label className="field">التخصص<select {...bind('category')}>{Object.entries(SVC_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          </div>
          <SiteFields bind={bind} />
          <div className="row">
            <label className="field">كل (يوم)<input {...bind('every_days')} type="number" min={7} max={366} required className="num" style={{ width: 80 }} /></label>
            <label className="field">أول موعد<input {...bind('first_due')} type="date" required /></label>
            <label className="field">ينتهي العقد<input {...bind('ends_on')} type="date" /></label>
            <label className="field">ما يُفحص في كل زيارة<input {...bind('tasks_note')} maxLength={1000} /></label>
          </div>
          <button disabled={act.busy}>حفظ العقد</button>
        </form>
      </section>}
      <section className="card stack">
        {w && <div className="row"><button className="secondary" disabled={act.busy} onClick={() => void act.run(async () => {
          setMade((await api<{ created: string[] }>('/service/plans/generate', { method: 'POST', body: {} })).created); await plans.reload();
        })}>إنشاء بلاغات الأسبوع القادم</button>{made && <span data-testid="generated">أُنشئ {made.length} بلاغ{made.length ? `: ${made.join('، ')}` : ''}</span>}</div>}
        {plans.data?.length === 0 ? <Empty>لا توجد عقود صيانة دورية</Empty> : <div className="tbl-wrap"><table data-testid="plans"><thead><tr><th>العقد</th><th>العميل والموقع</th><th>التخصص</th><th>كل</th><th>الموعد القادم</th><th>البلاغات</th><th></th></tr></thead>
          <tbody>{plans.data?.map((p) => (
            <tr key={p.id}><td>{p.name}</td><td>{p.customer_name} · {siteText(p.site)}</td><td>{SVC_CATEGORY[p.category]}</td><td className="num">{p.every_days} يوم</td>
              <td className="num">{p.active ? p.next_due : <Badge>متوقف</Badge>}</td><td className="num">{p.jobs}</td>
              <td>{w && p.active && <button className="small secondary" onClick={() => void act.run(async () => { await api(`/service/plans/${p.id}/stop`, { method: 'POST', body: {} }); await plans.reload(); })}>إيقاف</button>}</td></tr>
          ))}</tbody></table></div>}
        <p className="muted" style={{ margin: 0 }}>تُنشأ البلاغات الوقائية قبل موعدها بأسبوع [تخمين].</p>
      </section>
    </div>
  );
}

function ExceptionsView() {
  const x = useLoad(() => api<{ late: Job[]; unassigned: Job[]; follow_ups: Job[]; to_close: Job[]; repeats: Job[] }>('/service/exceptions'));
  const [open, setOpen] = useState<string | null>(null);
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="تجاوزت موعد الاستجابة" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
          <Kpi label="بلا فني" value={d.unassigned.length} tone={d.unassigned.length ? 'warning' : undefined} />
          <Kpi label="تحتاج زيارة أخرى" value={d.follow_ups.length} />
          <Kpi label="جاهزة للإغلاق" value={d.to_close.length} />
        </div>
        <section className="card"><h2>تجاوزت موعد الاستجابة ولم يصل فني</h2><JobsTable rows={d.late} onPick={(j) => setOpen(j.id)} testId="ex-late" /></section>
        <section className="card"><h2>بلاغات بلا فني محجوز</h2><JobsTable rows={d.unassigned} onPick={(j) => setOpen(j.id)} testId="ex-unassigned" /></section>
        <section className="card"><h2>تحتاج زيارة أخرى</h2><JobsTable rows={d.follow_ups} onPick={(j) => setOpen(j.id)} testId="ex-follow" /></section>
        <section className="card"><h2>جاهزة للإغلاق والفوترة</h2><JobsTable rows={d.to_close} onPick={(j) => setOpen(j.id)} testId="ex-close" /></section>
        <section className="card"><h2>أعطال متكررة خلال 30 يومًا من إصلاح [تخمين]</h2><JobsTable rows={d.repeats} onPick={(j) => setOpen(j.id)} testId="ex-repeats" /></section>
      </>}
      {open && <JobModal id={open} onClose={() => { setOpen(null); void x.reload(); }} />}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<{ totals: { jobs: number; closed: number; fixed: number; visits: number; on_time_pct: number | null; first_fix_pct: number | null; avg_response_h: number | null; labour: string; parts: string };
    technicians: { technician_name: string; visits: number; fixed: number; follow_up: number; onsite_hours: number }[]; categories: { category: string; jobs: number; closed: number; fixed: number }[] }>(`/service/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  const pct = (n: number | null) => (n === null ? '—' : `${n}%`);
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4">
          <Kpi label="بلاغات" value={`${x.closed} مغلق / ${x.jobs}`} />
          <Kpi label="الوصول في الموعد" value={pct(x.on_time_pct)} tone="success" />
          <Kpi label="إصلاح من أول زيارة" value={pct(x.first_fix_pct)} />
          <Kpi label="العمالة + القطع" value={money(Number(x.labour) + Number(x.parts))} />
        </div>
        <p className="muted">متوسط زمن الاستجابة: {x.avg_response_h === null ? '—' : `${x.avg_response_h} ساعة`} · زيارات: {x.visits}</p>
        <section className="card"><h2>حسب الفني</h2>
          {r.data!.technicians.length === 0 ? <Empty>لا توجد زيارات</Empty> : <div className="tbl-wrap"><table data-testid="sv-techs"><thead><tr><th>الفني</th><th>زيارات</th><th>أُصلح</th><th>زيارة أخرى</th><th>ساعات في المواقع</th></tr></thead>
            <tbody>{r.data!.technicians.map((v) => <tr key={v.technician_name}><td>{v.technician_name}</td><td className="num">{v.visits}</td><td className="num">{v.fixed}</td><td className="num">{v.follow_up}</td><td className="num">{v.onsite_hours}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>حسب التخصص</h2>
          {r.data!.categories.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="sv-cats"><thead><tr><th>التخصص</th><th>بلاغات</th><th>مغلقة</th><th>أُصلحت</th></tr></thead>
            <tbody>{r.data!.categories.map((c) => <tr key={c.category}><td>{SVC_CATEGORY[c.category]}</td><td className="num">{c.jobs}</td><td className="num">{c.closed}</td><td className="num">{c.fixed}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
