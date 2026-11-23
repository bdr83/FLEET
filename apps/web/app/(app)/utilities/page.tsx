'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, todayKw, UT_CHECK, UT_NETWORK, UT_PRIORITY, UT_RESULT, UT_STATE, UT_TYPE } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Job {
  id: string; ref: string; customer_id: string | null; customer_name: string | null; network: string; job_type: string; priority: string; reported_at: string; due_at: string;
  duration_min: number; area: string; address: string | null; asset_ref: string | null; description: string; affected: number; needs_permit: boolean; permit_no: string | null;
  permit_expires: string | null; task_id: string | null; arrived_at: string | null; isolated_at: string | null; restored_at: string | null; reinstated_at: string | null;
  result: string | null; result_note: string | null; checks: Record<string, boolean> | null; canceled_at: string | null; cancel_reason: string | null; lead_name: string | null;
  plate_no: string | null; fail_reason: string | null; state: string; response_min: number | null; restore_min: number | null; breached: boolean;
}
type Tab = 'jobs' | 'exceptions' | 'report';

const hhmm = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16) : '—');
const mins = (n: number | null) => (n === null ? '—' : n < 120 ? `${n} د` : `${Math.round(n / 6) / 10} س`);
const kwLocal = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);

/** Utilities field work (sector 24): today's and open work orders with crews and permits, exceptions and the report. */
export default function UtilitiesPage() {
  const [tab, setTab] = useState<Tab>('jobs');
  return (
    <div className="page stack">
      <div className="page-head"><h1>أعمال المرافق</h1></div>
      <Tabs tabs={[['jobs', 'أوامر العمل'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'jobs' && <JobsView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function JobTable({ id, rows, onOpen }: { id: string; rows: Job[]; onOpen?: (id: string) => void }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th>الأمر</th><th>العمل</th><th>الموقع</th><th>البلاغ</th><th>الوصول قبل</th><th>الفرقة</th><th>الحالة</th>{onOpen && <th></th>}</tr></thead>
      <tbody>{rows.map((j) => (
        <tr key={j.id}><td><span className="num">{j.ref}</span> <Tone map={UT_PRIORITY} value={j.priority} /></td>
          <td>{UT_NETWORK[j.network]} · {UT_TYPE[j.job_type]}<div className="muted">{j.description}</div>{j.needs_permit && <Badge tone={j.permit_no ? 'info' : 'danger'}>{j.permit_no ? `تصريح ${j.permit_no}` : 'يحتاج تصريح حفر'}</Badge>}</td>
          <td>{j.area}{j.asset_ref && <div className="muted num">{j.asset_ref}</div>}{j.affected > 0 && <div className="muted">{j.affected} مشترك متأثر</div>}</td>
          <td className="num">{dt(j.reported_at)}</td>
          <td className="num">{hhmm(j.due_at)}{j.breached && <> <Badge tone="danger">تجاوز</Badge></>}</td>
          <td>{j.lead_name ? <>{j.lead_name} · <span className="num">{j.plate_no}</span></> : '—'}</td>
          <td><Tone map={UT_STATE} value={j.state} />{j.response_min !== null && <div className="muted">استجابة {mins(j.response_min)}</div>}</td>
          {onOpen && <td><button className="small" onClick={() => onOpen(j.id)}>فتح</button></td>}</tr>
      ))}</tbody></table></div>
  );
}

function JobsView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const list = useLoad(() => api<{ data: Job[] }>(`/utilities/jobs?date=${day}`).then((r) => r.data), [day]);
  const [add, setAdd] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم البلاغات" /></label>
        {can(me, 'tasks:assign') && <button onClick={() => setAdd(true)}>أمر عمل جديد</button>}
        <button className="secondary" onClick={() => void list.reload()}>تحديث</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>أوامر اليوم وكل أمر ما زال مفتوحًا، الطارئ أولًا.</p>
      <ErrorBox error={list.error} />
      {list.data && <JobTable id="jobs" rows={list.data} onOpen={setOpen} />}
      {add && <JobForm onClose={() => setAdd(false)} onDone={(id) => { setAdd(false); setOpen(id); void list.reload(); }} />}
      {open && <JobModal id={open} onClose={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function JobForm({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const { f, bind } = useForm({ customer_id: '', network: 'electricity', job_type: 'outage', priority: 'emergency', reported_at: kwLocal(new Date()), area: '', address: '', asset_ref: '',
    description: '', affected: '0', hours: '4', permit_no: '', permit_expires: '' });
  return (
    <Modal title="أمر عمل جديد" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const j = await api<Job>('/utilities/jobs', { method: 'POST', body: {
          legal_entity_id: me.legal_entities[0]?.id, network: f.network, job_type: f.job_type, priority: f.priority, reported_at: kwIso(f.reported_at), area: f.area, description: f.description,
          affected: Number(f.affected) || 0, duration_min: Math.round(Number(f.hours) * 60) || 240,
          ...clean({ customer_id: f.customer_id, address: f.address, asset_ref: f.asset_ref, permit_no: f.permit_no, permit_expires: f.permit_expires }),
        } });
        onDone(j.id);
      }); }}>
        <div className="row">
          <label className="field">الشبكة<select {...bind('network')}>{Object.entries(UT_NETWORK).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">نوع العمل<select {...bind('job_type')}>{Object.entries(UT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">الأولوية<select {...bind('priority')}>{Object.entries(UT_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
          <label className="field">العميل<select {...bind('customer_id')}><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <label className="field">الوصف<input {...bind('description')} required maxLength={500} placeholder="انقطاع كهرباء عن المجمع، كسر خط مياه…" /></label>
        <div className="row">
          <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
          <label className="field">العنوان<input {...bind('address')} maxLength={200} placeholder="ق 1 ش 5" /></label>
          <label className="field">رقم الأصل<input {...bind('asset_ref')} maxLength={60} className="num" placeholder="SS-JAB-112" /></label>
          <label className="field">المشتركون المتأثرون<input {...bind('affected')} type="number" min={0} className="num" style={{ width: 100 }} /></label>
        </div>
        <div className="row">
          <label className="field">وقت البلاغ<input {...bind('reported_at')} type="datetime-local" required /></label>
          <label className="field">مدة العمل (ساعة)<input {...bind('hours')} type="number" step="0.5" min={0.5} max={24} className="num" style={{ width: 90 }} /></label>
          <label className="field">رقم تصريح الحفر<input {...bind('permit_no')} maxLength={40} className="num" /></label>
          <label className="field">ينتهي<input {...bind('permit_expires')} type="date" /></label>
        </div>
        <p className="muted" style={{ margin: 0 }}>الوصول قبل: طارئ ساعتان، عاجل 24 ساعة، مجدول 7 أيام من البلاغ [تخمين]. أعمال الحفر تحتاج تصريحًا ساريًا قبل العزل.</p>
        <button disabled={act.busy}>حفظ الأمر</button>
      </form>
    </Modal>
  );
}

function JobModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const j = useLoad(() => api<Job>(`/utilities/jobs/${id}`), [id]);
  const d = j.data;
  const assets = useLoad(() => api<{ data: { id: string; plate_no: string | null; status: string }[] }>('/assets').then((x) => x.data.filter((a) => !['retired', 'out_of_service'].includes(a.status))));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string }[] }>('/workers?status=active').then((x) => x.data));
  const act = useAction();
  const { f, bind } = useForm({ asset_id: '', worker_id: '', permit_no: '', permit_expires: '', reason: '' });
  const post = (path: string, body: Record<string, unknown>, method = 'POST') => act.run(async () => { await api(`/utilities/jobs/${id}/${path}`, { method, body }); await j.reload(); });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={d ? `أمر العمل ${d.ref}` : 'أمر العمل'} onClose={onClose}>
      <ErrorBox error={j.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={UT_STATE} value={d.state} /> <Tone map={UT_PRIORITY} value={d.priority} /> <b>{UT_NETWORK[d.network]} · {UT_TYPE[d.job_type]}</b>: {d.description}</p>
        <p>{[d.address, d.area].filter(Boolean).join('، ')}{d.asset_ref && <> · الأصل <span className="num">{d.asset_ref}</span></>}{d.customer_name && <> · {d.customer_name}</>}{d.affected > 0 && <> · {d.affected} مشترك متأثر</>}</p>
        <p data-testid="job-times">البلاغ <span className="num">{dt(d.reported_at)}</span> · الوصول قبل <span className="num">{dt(d.due_at)}</span>{d.breached && <> <Badge tone="danger">تجاوز موعد الاستجابة</Badge></>}
          {d.response_min !== null && <> · استجابة {mins(d.response_min)}</>}{d.restore_min !== null && <> · الإصلاح بعد {mins(d.restore_min)}</>}</p>
        {d.needs_permit && <p data-testid="job-permit">{d.permit_no ? <>تصريح الحفر <span className="num">{d.permit_no}</span> ينتهي <span className="num">{d.permit_expires}</span></> : <b>يحتاج تصريح حفر قبل العمل</b>}</p>}
        {d.lead_name && <p data-testid="job-crew">الفرقة {d.lead_name} · <span className="num">{d.plate_no}</span> · وصل {hhmm(d.arrived_at)} · عزل {hhmm(d.isolated_at)} · أُصلح {hhmm(d.restored_at)}{d.needs_permit && <> · أُعيد الطريق {hhmm(d.reinstated_at)}</>}</p>}
        {d.checks && <p className="muted">قائمة السلامة: {Object.keys(d.checks).map((k) => UT_CHECK[k] ?? k).join('، ')}</p>}
        {d.result && <p>النتيجة: <b>{UT_RESULT[d.result]}</b>{d.result_note && <> · {d.result_note}</>}</p>}
        {d.canceled_at && <p className="muted">أُلغي: {d.cancel_reason}</p>}
        {w && ['open', 'assigned', 'failed'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('assign', { asset_id: f.asset_id, worker_id: f.worker_id }); }}>
          <label className="field">السيارة<select {...bind('asset_id')} required><option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          <label className="field">قائد الفرقة<select {...bind('worker_id')} required><option value="">—</option>{workers.data?.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
          <button disabled={act.busy}>{d.state === 'assigned' ? 'تغيير الفرقة' : 'إسناد الفرقة'}</button>
        </form>}
        {w && d.needs_permit && !d.restored_at && !['done', 'canceled'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('permit', { permit_no: f.permit_no, permit_expires: f.permit_expires }, 'PUT'); }}>
          <input {...bind('permit_no')} placeholder="رقم التصريح" required maxLength={40} aria-label="رقم التصريح" className="num" />
          <input {...bind('permit_expires')} type="date" required aria-label="انتهاء التصريح" />
          <button className="secondary" disabled={act.busy}>{d.permit_no ? 'تجديد التصريح' : 'تسجيل التصريح'}</button>
        </form>}
        {w && ['open', 'assigned', 'failed'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={300} aria-label="سبب إلغاء الأمر" />
          <button className="danger" disabled={act.busy}>إلغاء الأمر</button>
        </form>}
      </div>}
    </Modal>
  );
}

function ExceptionsView() {
  type X = { response_breach: Job[]; unassigned: Job[]; permits: Job[]; not_reinstated: Job[]; follow_up: Job[] };
  const x = useLoad(() => api<X>('/utilities/exceptions'));
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="تجاوزت موعد الاستجابة" value={d.response_breach.length} tone={d.response_breach.length ? 'danger' : undefined} />
          <Kpi label="بلا فرقة وتستحق قريبًا" value={d.unassigned.length} tone={d.unassigned.length ? 'warning' : undefined} />
          <Kpi label="تصاريح حفر" value={d.permits.length} tone={d.permits.length ? 'warning' : undefined} />
          <Kpi label="إصلاحات مؤقتة" value={d.follow_up.length} tone={d.follow_up.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>تجاوزت موعد الاستجابة ولم تصل الفرقة</h2><JobTable id="ex-breach" rows={d.response_breach} /></section>
        <section className="card"><h2>بلا فرقة وموعد الوصول خلال ساعتين</h2><JobTable id="ex-unassigned" rows={d.unassigned} /></section>
        <section className="card"><h2>حفر بلا تصريح أو تصريحه ينتهي خلال يومين [تخمين]</h2><JobTable id="ex-permits" rows={d.permits} /></section>
        <section className="card"><h2>لم يُعد الطريق بعد 3 أيام من الإصلاح [تخمين]</h2><JobTable id="ex-reinstate" rows={d.not_reinstated} /></section>
        <section className="card"><h2>إصلاحات مؤقتة تحتاج متابعة</h2><JobTable id="ex-follow" rows={d.follow_up} /></section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { jobs: number; done: number; breached: number; avg_response_min: number | null; avg_restore_min: number | null; customer_minutes: number; follow_up: number };
  const r = useLoad(() => api<{ totals: Sum; customers: (Sum & { key: string })[]; networks: (Sum & { key: string })[] }>(`/utilities/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  const table = (id: string, rows: (Sum & { key: string })[], label: (k: string) => string) => rows.length === 0 ? <Empty>لا أوامر</Empty> : (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th></th><th>أوامر</th><th>مغلقة</th><th>تجاوز الاستجابة</th><th>متوسط الاستجابة</th><th>متوسط الإصلاح</th><th>دقائق انقطاع × مشترك</th></tr></thead>
      <tbody>{rows.map((s) => <tr key={s.key}><td>{label(s.key)}</td><td className="num">{s.jobs}</td><td className="num">{s.done}</td><td className="num">{s.breached}</td>
        <td className="num">{mins(s.avg_response_min)}</td><td className="num">{mins(s.avg_restore_min)}</td><td className="num">{s.customer_minutes.toLocaleString('en-US')}</td></tr>)}</tbody></table></div>
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
          <Kpi label="ضمن موعد الاستجابة" value={x.jobs ? `${Math.round(((x.jobs - x.breached) / x.jobs) * 100)}%` : '—'} />
          <Kpi label="متوسط الاستجابة" value={mins(x.avg_response_min)} />
          <Kpi label="متوسط الإصلاح" value={mins(x.avg_restore_min)} />
        </div>
        <p className="muted">إصلاحات مؤقتة {x.follow_up} · دقائق انقطاع × مشترك {x.customer_minutes.toLocaleString('en-US')}</p>
        <section className="card"><h2>حسب العميل</h2>{table('ut-report-customers', r.data!.customers, (k) => k)}</section>
        <section className="card"><h2>حسب الشبكة</h2>{table('ut-report-networks', r.data!.networks, (k) => UT_NETWORK[k] ?? k)}</section>
      </>}
    </div>
  );
}
