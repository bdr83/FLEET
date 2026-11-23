'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { CT_DIRECTION, CT_LEG, CT_PORT, CT_STATE, CT_TYPE, dt, money, TASK_STATUS, time, todayKw } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

type Site = Record<string, string>;
interface Leg {
  task_id: string; job_id: string; job_ref: string; container_no: string; iso_size: string; seq: number; kind: string; ref: string; status: string; starts_at: string; ends_at: string;
  driver_name: string | null; plate_no: string | null; picked_at: string | null; dropped_at: string | null; seal_no: string | null; received_by: string | null; gate_ref: string | null; customer_name: string;
}
interface Job {
  id: string; ref: string; customer_name: string; direction: string; container_no: string; iso_size: string; ctype: string; line: string | null; doc_no: string | null; seal_no: string | null;
  port: string; depot: string | null; site: Site; last_free_day: string | null; return_by: string | null; picked_at: string | null; at_customer_at: string | null; emptied_at: string | null; done_at: string | null;
  haulage_amount: string | null; extra_amount: string | null; total: string; closed_at: string | null; state: string; next_leg: string | null; next_booked: boolean;
  storage_days: number; detention_days: number; days_at_customer?: number; legs?: Leg[];
}
type Tab = 'jobs' | 'yard' | 'board' | 'exceptions' | 'report';

const siteText = (s: Site) => [s.name, s.area, s.block && `ق ${s.block}`].filter(Boolean).join('، ') || '—';
const box = (j: { container_no: string; iso_size: string; ctype?: string }) => `${j.container_no} · ${j.iso_size}′${j.ctype && j.ctype !== 'dry' ? ` ${CT_TYPE[j.ctype]}` : ''}`;

/** Containers and ports (sector 6): container jobs and their legs, the yard, the day's board, exceptions and the report. */
export default function ContainersPage() {
  const [tab, setTab] = useState<Tab>('jobs');
  return (
    <div className="page stack">
      <div className="page-head"><h1>الحاويات والموانئ</h1></div>
      <Tabs tabs={[['jobs', 'الحاويات'], ['yard', 'أين الحاويات'], ['board', 'رحلات اليوم'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'jobs' && <JobsView />}
      {tab === 'yard' && <YardView />}
      {tab === 'board' && <BoardView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function DateFlags({ j }: { j: Job }) {
  return <>{j.storage_days > 0 && <Badge tone="danger">أرضيات {j.storage_days} يوم</Badge>}{j.detention_days > 0 && <> <Badge tone="danger">تأخير {j.detention_days} يوم</Badge></>}</>;
}

function JobsTable({ rows, onPick, testId }: { rows: Job[]; onPick?: (j: Job) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>الرقم</th><th>الحاوية</th><th>النوع</th><th>العميل</th><th>الخط والبوليصة</th><th>آخر يوم مجاني</th><th>الإرجاع قبل</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{rows.map((j) => (
        <tr key={j.id}><td className="num">{j.ref}</td><td className="num" dir="ltr">{box(j)}</td><td>{CT_DIRECTION[j.direction]} · {CT_PORT[j.port]}</td><td>{j.customer_name}</td>
          <td>{[j.line, j.doc_no].filter(Boolean).join(' · ') || '—'}</td><td className="num">{j.last_free_day ?? '—'}</td><td className="num">{j.return_by ?? '—'}</td>
          <td><Tone map={CT_STATE} value={j.state} /> <DateFlags j={j} /></td><td>{onPick && <button className="small" onClick={() => onPick(j)}>إدارة</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function JobsView() {
  const me = useMe();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const jobs = useLoad(() => api<{ data: Job[] }>(`/containers/jobs?${new URLSearchParams(clean({ q, state }))}`).then((r) => r.data), [q, state]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={jobs.error} />
      <div className="row">
        {can(me, 'tasks:assign') && <button onClick={() => setAdding(true)}>حاوية جديدة</button>}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="رقم الحاوية أو البوليصة" aria-label="بحث" style={{ maxWidth: 220 }} dir="ltr" />
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="الحالة" style={{ maxWidth: 200 }}>
          <option value="">كل الحالات</option>{Object.entries(CT_STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <JobsTable rows={jobs.data ?? []} onPick={(j) => setOpen(j.id)} testId="ctr-jobs" />
      {adding && <JobForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void jobs.reload(); }} />}
      {open && <JobModal id={open} onClose={() => { setOpen(null); void jobs.reload(); }} />}
    </section>
  );
}

function JobForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const { f, bind } = useForm({ customer_id: '', new_name: '', direction: 'import', container_no: '', iso_size: '40', ctype: 'dry', line: '', doc_no: '', seal_no: '', port: 'shuwaikh', depot: '',
    site_name: '', area: '', block: '', street: '', phone: '', last_free_day: '', return_by: '' });
  return (
    <Modal title="حاوية جديدة" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const le = me.legal_entities[0]?.id;
        let customer = f.customer_id;
        if (customer === 'new') customer = (await api<{ id: string }>('/customers', { method: 'POST', body: { legal_entity_id: le, kind: 'business', name: f.new_name } })).id;
        await api('/containers/jobs', { method: 'POST', body: { legal_entity_id: le, customer_id: customer, direction: f.direction, container_no: f.container_no, iso_size: f.iso_size, ctype: f.ctype, port: f.port,
          site: clean({ name: f.site_name, area: f.area, block: f.block, street: f.street, phone: f.phone }), ...clean({ line: f.line, doc_no: f.doc_no, seal_no: f.seal_no, depot: f.depot, last_free_day: f.last_free_day, return_by: f.return_by }) } });
        onDone();
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option><option value="new">+ عميل جديد</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          {f.customer_id === 'new' && <label className="field">اسم العميل<input {...bind('new_name')} required maxLength={200} /></label>}
          <label className="field">الاتجاه<select {...bind('direction')}>{Object.entries(CT_DIRECTION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">رقم الحاوية<input {...bind('container_no')} required maxLength={14} dir="ltr" className="num" placeholder="MSCU1234566" /></label>
          <label className="field">المقاس<select {...bind('iso_size')}><option value="20">20</option><option value="40">40</option><option value="45">45</option></select></label>
          <label className="field">النوع<select {...bind('ctype')}>{Object.entries(CT_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">الميناء<select {...bind('port')}>{Object.entries(CT_PORT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">الخط الملاحي<input {...bind('line')} maxLength={60} /></label>
          <label className="field">البوليصة أو الحجز<input {...bind('doc_no')} maxLength={40} dir="ltr" /></label>
          <label className="field">الختم<input {...bind('seal_no')} maxLength={40} dir="ltr" /></label>
          <label className="field">ساحة الفارغ<input {...bind('depot')} maxLength={120} /></label>
        </div>
        <div className="row">
          <label className="field">موقع العميل<input {...bind('site_name')} maxLength={120} placeholder="مستودع، مصنع" /></label>
          <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
          <label className="field">القطعة<input {...bind('block')} maxLength={10} className="num" style={{ width: 70 }} /></label>
          <label className="field">الهاتف<input {...bind('phone')} maxLength={20} className="num" dir="ltr" /></label>
        </div>
        <div className="row">
          <label className="field">آخر يوم بلا أرضيات<input {...bind('last_free_day')} type="date" /></label>
          <label className="field">إرجاع الحاوية قبل<input {...bind('return_by')} type="date" /></label>
        </div>
        <button disabled={act.busy}>حفظ</button>
      </form>
    </Modal>
  );
}

function JobModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Job & { legs: Leg[] }>(`/containers/jobs/${id}`), [id]);
  const workers = useLoad(() => api<{ data: { id: string; display_name: string }[] }>('/workers?status=active').then((x) => x.data));
  const assets = useAssets();
  const act = useAction();
  const { f, bind } = useForm({ driver: '', truck: '', starts_at: new Date(Date.now() + 3 * 3_600_000 + 30 * 60_000).toISOString().slice(0, 16), duration: '180', free: '', ret: '', haul: '', extra: '', reason: '' });
  const j = d.data;
  const w = can(me, 'tasks:assign');
  const run = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); await d.reload(); });
  return (
    <Modal title={j ? `حاوية ${j.ref}` : 'حاوية'} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {j && <div className="stack">
        <div className="row"><Tone map={CT_STATE} value={j.state} /><DateFlags j={j} />{j.emptied_at && j.state === 'at_customer' && <Badge tone="success">جاهزة للسحب</Badge>}</div>
        <dl className="dl">
          <dt>الحاوية</dt><dd className="num" dir="ltr">{box(j)}{j.seal_no && ` · seal ${j.seal_no}`}</dd>
          <dt>العملية</dt><dd>{CT_DIRECTION[j.direction]} · ميناء {CT_PORT[j.port]}{j.depot && ` · الساحة: ${j.depot}`} · {[j.line, j.doc_no].filter(Boolean).join(' · ')}</dd>
          <dt>العميل</dt><dd>{j.customer_name} · {siteText(j.site)}</dd>
          <dt>المواعيد</dt><dd className="num">آخر يوم مجاني {j.last_free_day ?? '—'} · الإرجاع قبل {j.return_by ?? '—'}</dd>
          {j.closed_at && <><dt>الإغلاق</dt><dd className="num">نقل {money(j.haulage_amount)} · إضافي {money(j.extra_amount)} · <b>{money(j.total)}</b></dd></>}
        </dl>
        {j.legs.length > 0 && <div className="tbl-wrap"><table data-testid="ctr-legs"><thead><tr><th>#</th><th>الرحلة</th><th>الموعد</th><th>السائق والشاحنة</th><th>الحالة</th><th>الاستلام والتسليم</th></tr></thead>
          <tbody>{j.legs.map((l) => (
            <tr key={l.task_id}><td className="num">{l.seq}</td><td>{CT_LEG[l.kind]}</td><td className="num">{dt(l.starts_at)}</td><td>{l.driver_name ?? '—'} <span className="num">{l.plate_no}</span></td>
              <td><Tone map={TASK_STATUS} value={l.status} /></td>
              <td className="muted">{l.picked_at && `سُحبت ${time(l.picked_at)}`}{l.dropped_at && ` · سُلّمت ${time(l.dropped_at)}`}{l.received_by && ` · ${l.received_by}`}{l.gate_ref && <span dir="ltr"> · {l.gate_ref}</span>}</td></tr>
          ))}</tbody></table></div>}
        {w && j.next_leg && !['closed', 'canceled', 'done'].includes(j.state) && <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/containers/jobs/${id}/legs`, { method: 'POST',
          body: { driver_worker_id: f.driver, asset_id: f.truck, starts_at: kwIso(f.starts_at), duration_min: Number(f.duration) } })); }}>
          <h2>حجز الرحلة التالية: {CT_LEG[j.next_leg]}</h2>
          <div className="row">
            <label className="field">السائق<select {...bind('driver')} required><option value="">اختر</option>{workers.data?.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
            <label className="field">الشاحنة<select {...bind('truck')} required><option value="">اختر</option>{(assets.data ?? []).filter((a) => !['out_of_service', 'retired'].includes(a.status)).map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
            <label className="field">الموعد<input {...bind('starts_at')} type="datetime-local" required /></label>
            <label className="field">المدة (دقيقة)<input {...bind('duration')} type="number" min={30} max={720} className="num" style={{ width: 90 }} /></label>
          </div>
          <button disabled={act.busy}>حجز الرحلة</button>
        </form>}
        {w && j.state === 'at_customer' && !j.emptied_at && <button className="secondary" disabled={act.busy} onClick={() => void run(() => api(`/containers/jobs/${id}/ready`, { method: 'POST', body: {} }))}>
          {j.direction === 'export' ? 'انتهى التحميل عند العميل' : 'فرّغ العميل الحاوية'}</button>}
        {w && !['closed', 'canceled'].includes(j.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/containers/jobs/${id}/dates`, { method: 'POST', body: clean({ last_free_day: f.free, return_by: f.ret }) })); }}>
          <label className="field">تمديد آخر يوم مجاني<input {...bind('free')} type="date" /></label>
          <label className="field">تمديد الإرجاع<input {...bind('ret')} type="date" /></label>
          <button className="secondary" disabled={act.busy || (!f.free && !f.ret)}>حفظ المواعيد</button>
        </form>}
        {w && j.state === 'done' && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/containers/jobs/${id}/close`, { method: 'POST', body: clean({ haulage_amount: f.haul, extra_amount: f.extra }) })); }}>
          <label className="field">أجرة النقل (د.ك)<input {...bind('haul')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <label className="field">أرضيات وتأخير على العميل (د.ك)<input {...bind('extra')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <button disabled={act.busy}>إغلاق</button>
        </form>}
        {w && j.state === 'waiting' && !j.picked_at && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/containers/jobs/${id}/cancel`, { method: 'POST', body: { reason: f.reason } })); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب الإلغاء" /><button className="danger" disabled={act.busy}>إلغاء</button>
        </form>}
      </div>}
    </Modal>
  );
}

function YardView() {
  const y = useLoad(() => api<{ waiting: Job[]; at_customer: (Job & { days_at_customer: number })[]; in_transit: Job[] }>('/containers/yard'));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="stack">
      <ErrorBox error={y.error} />
      {y.data && <>
        <div className="grid g4">
          <Kpi label="في الميناء أو الساحة" value={y.data.waiting.length} />
          <Kpi label="على الطريق" value={y.data.in_transit.length} />
          <Kpi label="عند العملاء" value={y.data.at_customer.length} />
        </div>
        <section className="card"><h2>عند العملاء</h2>
          {y.data.at_customer.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="yard-customer"><thead><tr><th>الحاوية</th><th>العميل</th><th>منذ</th><th>الإرجاع قبل</th><th></th><th></th></tr></thead>
            <tbody>{y.data.at_customer.map((j) => <tr key={j.id}><td className="num" dir="ltr">{box(j)}</td><td>{j.customer_name} · {siteText(j.site)}</td><td className="num">{j.days_at_customer} يوم</td>
              <td className="num">{j.return_by ?? '—'}</td><td>{j.emptied_at ? <Badge tone="success">جاهزة للسحب</Badge> : <DateFlags j={j} />}</td><td><button className="small" onClick={() => setOpen(j.id)}>إدارة</button></td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>بانتظار السحب من الميناء أو الساحة</h2><JobsTable rows={y.data.waiting} onPick={(j) => setOpen(j.id)} testId="yard-waiting" /></section>
      </>}
      {open && <JobModal id={open} onClose={() => { setOpen(null); void y.reload(); }} />}
    </div>
  );
}

function BoardView() {
  const [day, setDay] = useState(todayKw());
  const b = useLoad(() => api<{ legs: Leg[] }>(`/containers/board?date=${day}`), [day]);
  const byTruck = new Map<string, Leg[]>();
  for (const l of b.data?.legs ?? []) byTruck.set(l.plate_no ?? '—', [...(byTruck.get(l.plate_no ?? '—') ?? []), l]);
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={b.error} />
      {byTruck.size === 0 ? <Empty>لا توجد رحلات</Empty> : <div className="stack" data-testid="ctr-board">{[...byTruck.entries()].map(([plate, list]) => (
        <section key={plate} className="card"><h3 style={{ margin: '0 0 4px' }}>الشاحنة <span className="num">{plate}</span> <span className="muted">({list.length})</span></h3>
          <div className="tbl-wrap"><table><tbody>{list.map((l) => (
            <tr key={l.task_id}><td className="num">{time(l.starts_at)}–{time(l.ends_at)}</td><td className="num" dir="ltr">{l.container_no} · {l.iso_size}′</td><td>{CT_LEG[l.kind]}</td><td>{l.customer_name}</td>
              <td>{l.driver_name}</td><td><Tone map={TASK_STATUS} value={l.status} /></td></tr>
          ))}</tbody></table></div></section>
      ))}</div>}
    </div>
  );
}

function ExceptionsView() {
  const x = useLoad(() => api<{ storage_risk: Job[]; detention_risk: Job[]; ready_to_collect: Job[]; unbooked: Job[]; to_close: Job[] }>('/containers/exceptions'));
  const [open, setOpen] = useState<string | null>(null);
  const d = x.data;
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="خطر أرضيات" value={d.storage_risk.length} tone={d.storage_risk.length ? 'danger' : undefined} />
          <Kpi label="خطر تأخير الإرجاع" value={d.detention_risk.length} tone={d.detention_risk.length ? 'danger' : undefined} />
          <Kpi label="جاهزة للسحب من العميل" value={d.ready_to_collect.length} tone={d.ready_to_collect.length ? 'warning' : undefined} />
          <Kpi label="جاهزة للإغلاق" value={d.to_close.length} />
        </div>
        <section className="card"><h2>في الميناء وآخر يوم مجاني اليوم أو غدًا أو فات [تخمين]</h2><JobsTable rows={d.storage_risk} onPick={(j) => setOpen(j.id)} testId="ex-storage" /></section>
        <section className="card"><h2>موعد الإرجاع اليوم أو غدًا أو فات [تخمين]</h2><JobsTable rows={d.detention_risk} onPick={(j) => setOpen(j.id)} testId="ex-detention" /></section>
        <section className="card"><h2>جاهزة للسحب من العميل بلا رحلة</h2><JobsTable rows={d.ready_to_collect} onPick={(j) => setOpen(j.id)} testId="ex-ready" /></section>
        <section className="card"><h2>بلا رحلة محجوزة</h2><JobsTable rows={d.unbooked} onPick={(j) => setOpen(j.id)} testId="ex-unbooked" /></section>
        <section className="card"><h2>أُرجعت وجاهزة للإغلاق والفوترة</h2><JobsTable rows={d.to_close} onPick={(j) => setOpen(j.id)} testId="ex-close" /></section>
      </>}
      {open && <JobModal id={open} onClose={() => { setOpen(null); void x.reload(); }} />}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const r = useLoad(() => api<{ totals: { containers: number; teu: number; import: number; export: number; moves: number; done: number; closed: number; storage_days: number; detention_days: number; haulage: string; extra: string };
    lines: { line: string; containers: number; teu: number; storage_days: number; detention_days: number }[] }>(`/containers/report?from=${from}&to=${to}`), [from, to]);
  const x = r.data?.totals;
  return (
    <div className="stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={r.error} />
      {x && <>
        <div className="grid g4" data-testid="ct-kpis">
          <Kpi label="حاويات" value={`${x.containers} (${x.teu} TEU)`} />
          <Kpi label="رحلات منفذة" value={x.moves} />
          <Kpi label="أيام أرضيات / تأخير" value={`${x.storage_days} / ${x.detention_days}`} tone={x.storage_days + x.detention_days ? 'danger' : 'success'} />
          <Kpi label="النقل + الإضافي" value={money(Number(x.haulage) + Number(x.extra))} />
        </div>
        <p className="muted">استيراد {x.import} · تصدير {x.export} · أُرجعت {x.done} · مغلقة {x.closed}</p>
        <section className="card"><h2>حسب الخط الملاحي</h2>
          {r.data!.lines.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="ct-lines"><thead><tr><th>الخط</th><th>حاويات</th><th>TEU</th><th>أيام أرضيات</th><th>أيام تأخير</th></tr></thead>
            <tbody>{r.data!.lines.map((l) => <tr key={l.line}><td>{l.line}</td><td className="num">{l.containers}</td><td className="num">{l.teu}</td><td className="num">{l.storage_days}</td><td className="num">{l.detention_days}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
