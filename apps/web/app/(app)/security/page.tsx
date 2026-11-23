'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, ISO_WEEKDAYS, SC_CATEGORY, SC_EVENT, SC_SEVERITY, SC_SKIP, SHUTTLE_SKIP, TASK_STATUS, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Site {
  id: string; code: string; name: string; customer_id: string | null; customer_name: string | null; area: string | null; address: string | null; patrol_times: string[]; duration_min: number;
  days: number[]; guard_worker_id: string | null; guard_name: string | null; asset_id: string | null; plate_no: string | null; instructions: string | null; active: boolean; version: number;
  checkpoints: number; open_incidents: number;
}
interface Checkpoint {
  id: string; seq: number; name: string; tag: string; note: string | null; active: boolean;
  event?: string | null; reason?: string | null; mark_note?: string | null; marked_at?: string | null; source?: string | null;
}
interface Patrol {
  id: string; site_id: string; site_code: string; site_name: string; customer_name: string | null; patrol_date: string; slot: string; task_id: string; status: string; start_at: string;
  guard_name: string; plate_no: string | null; checkpoints_planned: number; started_at: string | null; ended_at: string | null; scanned: number; skipped: number; incidents: number;
}
interface Incident {
  id: string; ref: string; site_id: string; site_code: string; site_name: string; customer_name: string | null; slot: string | null; category: string; severity: string; description: string;
  occurred_at: string; source: string; reported_by_name: string | null; closed_at: string | null; close_note: string | null;
}
type Tab = 'day' | 'sites' | 'incidents' | 'exceptions' | 'report';

const hhmm = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16) : '—');
const daysText = (d: number[]) => (d.length === 7 ? 'كل يوم' : ISO_WEEKDAYS.filter(([n]) => d.includes(n)).map(([, l]) => l).join('، '));

/** Security guarding and patrols (sector 25): the day's patrols with each checkpoint, sites and their checkpoints, incidents, exceptions and the report. */
export default function SecurityPage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>الحراسة والدوريات</h1></div>
      <Tabs tabs={[['day', 'جولات اليوم'], ['sites', 'المواقع ونقاط التفتيش'], ['incidents', 'الحوادث'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'day' && <DayView />}
      {tab === 'sites' && <SitesView />}
      {tab === 'incidents' && <IncidentsView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function DayView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const patrols = useLoad(() => api<{ data: Patrol[] }>(`/security/patrols?date=${day}`).then((r) => r.data), [day]);
  const act = useAction();
  const [gen, setGen] = useState<{ created: string[]; existing: string[]; skipped: { patrol: string; reason: string }[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const skip: Record<string, string> = { ...SHUTTLE_SKIP, no_guard: 'بلا حارس', no_checkpoints: 'بلا نقاط تفتيش', guard_booked: 'الحارس محجوز في الوقت نفسه', guard_inactive: 'الحارس غير نشط',
    vehicle_booked: 'السيارة محجوزة في الوقت نفسه', vehicle_out_of_service: 'السيارة خارج الخدمة', past: 'موعد الجولة مضى' };
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => { setDay(e.target.value); setGen(null); }} aria-label="يوم الجولات" /></label>
        {can(me, 'tasks:assign') && <button disabled={act.busy} onClick={() => void act.run(async () => {
          setGen(await api('/security/patrols/generate', { method: 'POST', body: { date: day } })); await patrols.reload();
        })}>توليد جولات اليوم</button>}
        <button className="secondary" onClick={() => void patrols.reload()}>تحديث</button>
      </div>
      <ErrorBox error={act.error ?? patrols.error} />
      {gen && <p data-testid="gen-result" className="muted">أُنشئ {gen.created.length}{gen.existing.length ? ` · موجود ${gen.existing.length}` : ''}
        {gen.skipped.map((s) => <span key={s.patrol}> · <Badge tone="warning">{s.patrol}: {skip[s.reason] ?? s.reason}</Badge></span>)}</p>}
      {patrols.data?.length === 0 ? <Empty>لا جولات لهذا اليوم. ولّدها من مواعيد المواقع.</Empty> : (
        <div className="tbl-wrap"><table data-testid="patrols"><thead><tr><th>الموعد</th><th>الموقع</th><th>الحارس</th><th>الحالة</th><th>النقاط</th><th>حوادث</th><th></th></tr></thead>
          <tbody>{patrols.data?.map((p) => (
            <tr key={p.id}><td className="num">{p.slot}{p.started_at && <div className="muted">بدأ {hhmm(p.started_at)}</div>}</td>
              <td><span className="num">{p.site_code}</span> {p.site_name}{p.customer_name && <div className="muted">{p.customer_name}</div>}</td>
              <td>{p.guard_name}{p.plate_no && <> · <span className="num">{p.plate_no}</span></>}</td><td><Tone map={TASK_STATUS} value={p.status} /></td>
              <td className="num">{p.scanned} / {p.checkpoints_planned}{p.skipped > 0 && <> <Badge tone="danger">لم تُفحص {p.skipped}</Badge></>}</td>
              <td className="num">{p.incidents ? <Badge tone="danger">{p.incidents}</Badge> : '—'}</td>
              <td><button className="small" onClick={() => setOpen(p.id)}>فتح</button></td></tr>
          ))}</tbody></table></div>
      )}
      {open && <PatrolModal id={open} onClose={() => { setOpen(null); void patrols.reload(); }} />}
    </section>
  );
}

function PatrolModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  type D = Patrol & { checkpoints: Checkpoint[]; incidents: Incident[] };
  const r = useLoad(() => api<D>(`/security/patrols/${id}`), [id]);
  const act = useAction();
  const d = r.data;
  const w = can(me, 'tasks:assign') && !!d && !['canceled', 'failed'].includes(d.status);
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/security/patrols/${id}/${path}`, { method: 'POST', body }); await r.reload(); });
  const { f, bind } = useForm({ reason: '' });
  return (
    <Modal title={d ? `جولة ${d.site_code} · ${d.patrol_date} ${d.slot}` : 'الجولة'} onClose={onClose}>
      <ErrorBox error={r.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={TASK_STATUS} value={d.status} /> {d.site_name} · {d.guard_name} · مُسحت {d.scanned} من {d.checkpoints.filter((k) => k.active).length}{d.started_at && <> · بدأ {hhmm(d.started_at)}</>}{d.ended_at && <> · انتهى {hhmm(d.ended_at)}</>}</p>
        <div className="tbl-wrap"><table data-testid="patrol-sheet"><thead><tr><th>#</th><th>النقطة</th><th>التسجيل</th>{w && <th></th>}</tr></thead>
          <tbody>{d.checkpoints.map((k) => (
            <tr key={k.id}><td className="num">{k.seq}</td><td>{k.name}<div className="muted num">{k.tag}</div>{k.note && <div className="muted">{k.note}</div>}</td>
              <td>{k.event ? <><Tone map={SC_EVENT} value={k.event} />{k.reason && <div className="muted">{SC_SKIP[k.reason]}{k.mark_note ? `: ${k.mark_note}` : ''}</div>}
                <div className="muted num">{hhmm(k.marked_at ?? null)}{k.source === 'office' ? ' (المكتب)' : ''}</div></> : <Badge>لم تُسجَّل</Badge>}</td>
              {w && <td><button className="small" disabled={act.busy} aria-label={`مُسحت ${k.name}`} onClick={() => void post('scan', { checkpoint_id: k.id, event: 'scanned' })}>مُسحت</button>{' '}
                <select aria-label={`لم تُفحص ${k.name}`} value="" disabled={act.busy} onChange={(e) => e.target.value && void post('scan', { checkpoint_id: k.id, event: 'skipped', reason: e.target.value })} style={{ width: 'auto' }}>
                  <option value="">لم تُفحص…</option>{Object.entries(SC_SKIP).map(([key, v]) => <option key={key} value={key}>{v}</option>)}</select></td>}</tr>
          ))}</tbody></table></div>
        <h3>حوادث الجولة</h3>
        {d.incidents.length === 0 ? <p className="muted">لا حوادث</p> : <IncidentTable id="patrol-incidents" rows={d.incidents} />}
        {w && ['ready', 'assigned', 'accepted'].includes(d.status) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={300} aria-label="سبب إلغاء الجولة" />
          <button className="danger" disabled={act.busy}>إلغاء الجولة</button>
        </form>}
      </div>}
    </Modal>
  );
}

function IncidentTable({ id, rows, onClose }: { id: string; rows: Incident[]; onClose?: (i: Incident) => void }) {
  return (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th>البلاغ</th><th>الموقع</th><th>النوع</th><th>الوصف</th><th>الوقت</th><th>الحالة</th>{onClose && <th></th>}</tr></thead>
      <tbody>{rows.map((i) => (
        <tr key={i.id}><td><span className="num">{i.ref}</span> <Tone map={SC_SEVERITY} value={i.severity} /></td>
          <td><span className="num">{i.site_code}</span> {i.site_name}</td><td>{SC_CATEGORY[i.category] ?? i.category}</td>
          <td>{i.description}<div className="muted">{i.source === 'office' ? 'من المكتب' : `الحارس ${i.reported_by_name ?? ''}`}{i.slot ? ` · جولة ${i.slot}` : ''}</div></td>
          <td className="num">{dt(i.occurred_at)}</td>
          <td>{i.closed_at ? <><Badge tone="success">مغلق</Badge><div className="muted">{i.close_note}</div></> : <Badge tone="danger">مفتوح</Badge>}</td>
          {onClose && <td>{!i.closed_at && <button className="small" onClick={() => onClose(i)}>إغلاق</button>}</td>}</tr>
      ))}</tbody></table></div>
  );
}

function SitesView() {
  const me = useMe();
  const sites = useLoad(() => api<{ data: Site[] }>('/security/sites').then((r) => r.data));
  const [edit, setEdit] = useState<Site | 'new' | null>(null);
  const [cps, setCps] = useState<Site | null>(null);
  const w = can(me, 'tasks:assign');
  return (
    <section className="card stack">
      <div className="row"><h2 style={{ margin: 0 }}>المواقع المحروسة</h2>{w && <button onClick={() => setEdit('new')}>إضافة موقع</button>}</div>
      <ErrorBox error={sites.error} />
      {sites.data?.length === 0 ? <Empty>لا مواقع بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="sc-sites"><thead><tr><th>الرمز</th><th>الموقع</th><th>مواعيد الجولات</th><th>الأيام</th><th>الحارس</th><th>النقاط</th><th>حوادث مفتوحة</th><th></th></tr></thead>
          <tbody>{sites.data?.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'muted'}><td className="num">{s.code}</td><td>{s.name}{s.customer_name && <div className="muted">{s.customer_name}</div>}</td>
              <td className="num">{s.patrol_times.length ? s.patrol_times.join('، ') : '—'} · {s.duration_min} د</td><td>{daysText(s.days)}</td>
              <td>{s.guard_name ?? <Badge tone="warning">بلا حارس</Badge>}{s.plate_no && <> · <span className="num">{s.plate_no}</span></>}</td>
              <td className="num">{s.checkpoints}</td><td className="num">{s.open_incidents ? <Badge tone="danger">{s.open_incidents}</Badge> : '—'}</td>
              <td><button className="small" onClick={() => setCps(s)}>النقاط</button>{w && <> <button className="small secondary" onClick={() => setEdit(s)}>تعديل</button></>}</td></tr>
          ))}</tbody></table></div>
      )}
      {edit && <SiteForm s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void sites.reload(); }} />}
      {cps && <CheckpointsModal s={cps} onClose={() => { setCps(null); void sites.reload(); }} />}
    </section>
  );
}

function SiteForm({ s, onClose, onDone }: { s: Site | null; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const assets = useLoad(() => api<{ data: { id: string; plate_no: string | null; status: string }[] }>('/assets').then((x) => x.data.filter((a) => !['retired', 'out_of_service'].includes(a.status))));
  const workers = useLoad(() => api<{ data: { id: string; display_name: string; kind: string }[] }>('/workers?status=active').then((x) => x.data.filter((w) => ['guard', 'supervisor', 'driver'].includes(w.kind))));
  const { f, bind, setF } = useForm({ code: s?.code ?? '', name: s?.name ?? '', customer_id: s?.customer_id ?? '', area: s?.area ?? '', address: s?.address ?? '',
    times: s?.patrol_times.join(' ') ?? '', duration: String(s?.duration_min ?? 60), guard_worker_id: s?.guard_worker_id ?? '', asset_id: s?.asset_id ?? '', instructions: s?.instructions ?? '', active: s?.active ?? true });
  const [days, setDays] = useState<number[]>(s?.days ?? [1, 2, 3, 4, 5, 6, 7]);
  return (
    <Modal title={s ? `تعديل الموقع ${s.code}` : 'إضافة موقع محروس'} onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const body = { name: f.name, customer_id: f.customer_id || null, area: f.area || null, address: f.address || null, patrol_times: f.times.split(/[\s,،]+/).filter(Boolean),
          duration_min: Number(f.duration) || 60, days, guard_worker_id: f.guard_worker_id || null, asset_id: f.asset_id || null, instructions: f.instructions || null };
        if (s) await api(`/security/sites/${s.id}`, { method: 'PATCH', body: { ...body, version: s.version, active: f.active } });
        else await api('/security/sites', { method: 'POST', body: { ...body, legal_entity_id: me.legal_entities[0]?.id, code: f.code } });
        onDone();
      }); }}>
        <div className="row">
          {!s && <label className="field">الرمز<input {...bind('code')} required maxLength={12} className="num" style={{ width: 100 }} placeholder="AVN" /></label>}
          <label className="field">اسم الموقع<input {...bind('name')} required maxLength={120} /></label>
          <label className="field">العميل<select {...bind('customer_id')}><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">المنطقة<input {...bind('area')} maxLength={80} /></label>
          <label className="field">العنوان<input {...bind('address')} maxLength={200} /></label>
        </div>
        <div className="row">
          <label className="field">مواعيد الجولات<input {...bind('times')} className="num" placeholder="22:00 02:00 05:00" aria-label="مواعيد الجولات" /></label>
          <label className="field">مدة الجولة (دقيقة)<input {...bind('duration')} type="number" min={10} max={480} className="num" style={{ width: 90 }} /></label>
        </div>
        <fieldset className="row" aria-label="أيام التشغيل">{ISO_WEEKDAYS.map(([n, l]) => (
          <label key={n} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={days.includes(n)} onChange={(e) => setDays(e.target.checked ? [...days, n] : days.filter((x) => x !== n))} /> {l}</label>
        ))}</fieldset>
        <div className="row">
          <label className="field">الحارس<select {...bind('guard_worker_id')}><option value="">—</option>{workers.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          <label className="field">سيارة الدورية (اختيارية)<select {...bind('asset_id')}><option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          {s && <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> فعّال</label>}
        </div>
        <label className="field">تعليمات للحارس<input {...bind('instructions')} maxLength={500} placeholder="تأكد من إغلاق باب المخزن" /></label>
        <button disabled={act.busy}>حفظ</button>
      </form>
    </Modal>
  );
}

function CheckpointsModal({ s, onClose }: { s: Site; onClose: () => void }) {
  const me = useMe();
  const cps = useLoad(() => api<{ data: Checkpoint[] }>(`/security/sites/${s.id}/checkpoints`).then((x) => x.data), [s.id]);
  const act = useAction();
  const { f, bind, setF } = useForm({ name: '', tag: '', note: '' });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={`نقاط تفتيش ${s.code}`} onClose={onClose}>
      <ErrorBox error={act.error ?? cps.error} />
      <p className="muted" style={{ margin: 0 }}>لكل نقطة رمز يُثبَّت في المكان (ملصق أو QR) ويُدخله الحارس عند المرور دليلًا على وجوده.</p>
      {cps.data?.filter((k) => k.active).length === 0 ? <Empty>لا نقاط بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="sc-checkpoints"><thead><tr><th>#</th><th>النقطة</th><th>الرمز</th>{w && <th></th>}</tr></thead>
          <tbody>{cps.data?.filter((k) => k.active).map((k) => (
            <tr key={k.id}><td className="num">{k.seq}</td><td>{k.name}{k.note && <div className="muted">{k.note}</div>}</td><td className="num">{k.tag}</td>
              {w && <td><button className="small secondary" disabled={act.busy} onClick={() => void act.run(async () => { await api(`/security/checkpoints/${k.id}`, { method: 'PATCH', body: { active: false } }); await cps.reload(); })}>إزالة</button></td>}</tr>
          ))}</tbody></table></div>
      )}
      {w && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api(`/security/sites/${s.id}/checkpoints`, { method: 'POST', body: { name: f.name, tag: f.tag, ...clean({ note: f.note }) } });
        setF({ name: '', tag: '', note: '' }); await cps.reload();
      }); }}>
        <label className="field">النقطة<input {...bind('name')} required maxLength={120} placeholder="البوابة الرئيسية" /></label>
        <label className="field">الرمز<input {...bind('tag')} required maxLength={24} className="num" placeholder="CP-GATE" style={{ width: 130 }} /></label>
        <label className="field">ملاحظة<input {...bind('note')} maxLength={300} /></label>
        <button disabled={act.busy}>إضافة النقطة</button>
      </form>}
    </Modal>
  );
}

function IncidentsView() {
  const me = useMe();
  const [onlyOpen, setOnlyOpen] = useState(true);
  const list = useLoad(() => api<{ data: Incident[] }>(`/security/incidents${onlyOpen ? '?open=1' : ''}`).then((r) => r.data), [onlyOpen]);
  const sites = useLoad(() => api<{ data: Site[] }>('/security/sites').then((r) => r.data.filter((s) => s.active)));
  const act = useAction();
  const [closing, setClosing] = useState<Incident | null>(null);
  const { f, bind, setF } = useForm({ site_id: '', category: 'suspicious', severity: 'medium', description: '', note: '' });
  const w = can(me, 'tasks:assign');
  return (
    <section className="card stack">
      <div className="row">
        <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> المفتوحة فقط</label>
        <button className="secondary" onClick={() => void list.reload()}>تحديث</button>
      </div>
      <ErrorBox error={act.error ?? list.error} />
      {list.data?.length === 0 ? <Empty>لا حوادث</Empty> : list.data && <IncidentTable id="incidents" rows={list.data} onClose={w ? setClosing : undefined} />}
      {closing && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api(`/security/incidents/${closing.id}/close`, { method: 'POST', body: { note: f.note } }); setClosing(null); setF({ ...f, note: '' }); await list.reload();
      }); }}>
        <b className="num">{closing.ref}</b>
        <input {...bind('note')} required maxLength={500} placeholder="ما الذي تم (بلاغ شرطة، إبلاغ العميل، إصلاح...)" aria-label="ملاحظة الإغلاق" />
        <button disabled={act.busy}>إغلاق الحادث</button>
        <button type="button" className="secondary" onClick={() => setClosing(null)}>تراجع</button>
      </form>}
      {w && <>
        <h3>تسجيل حادث من المكتب</h3>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api('/security/incidents', { method: 'POST', body: { site_id: f.site_id, category: f.category, severity: f.severity, description: f.description } });
          setF({ ...f, description: '' }); await list.reload();
        }); }}>
          <label className="field">الموقع<select {...bind('site_id')} required><option value="">—</option>{sites.data?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label>
          <label className="field">النوع<select {...bind('category')}>{Object.entries(SC_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">الخطورة<select {...bind('severity')}>{Object.entries(SC_SEVERITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
          <label className="field">الوصف<input {...bind('description')} required maxLength={1000} /></label>
          <button disabled={act.busy}>تسجيل</button>
        </form>
      </>}
    </section>
  );
}

function ExceptionsView() {
  const [day, setDay] = useState(todayKw());
  type S = { checkpoint_id: string; name: string; tag: string; site_code: string; site_name: string; slot?: string; reason?: string; note?: string | null; patrols?: number };
  type X = { late_start: Patrol[]; no_guard_or_checkpoints: Site[]; skipped: S[]; repeat_skipped: S[]; open_incidents: Incident[] };
  const x = useLoad(() => api<X>(`/security/exceptions?date=${day}`), [day]);
  const d = x.data;
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الاستثناءات" /></label>
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="حوادث مفتوحة" value={d.open_incidents.length} tone={d.open_incidents.length ? 'danger' : undefined} />
          <Kpi label="جولات تأخرت عن البدء" value={d.late_start.length} tone={d.late_start.length ? 'warning' : undefined} />
          <Kpi label="نقاط لم تُفحص اليوم" value={d.skipped.length} tone={d.skipped.length ? 'danger' : undefined} />
          <Kpi label="مواقع بلا حارس أو نقاط" value={d.no_guard_or_checkpoints.length} tone={d.no_guard_or_checkpoints.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>حوادث مفتوحة</h2>{d.open_incidents.length === 0 ? <Empty>لا يوجد</Empty> : <IncidentTable id="ex-incidents" rows={d.open_incidents} />}</section>
        <section className="card"><h2>جولات لم تبدأ بعد 15 دقيقة من موعدها [تخمين]</h2>{d.late_start.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-late"><tbody>{d.late_start.map((p) => <tr key={p.id}><td className="num">{p.site_code}</td><td>{p.site_name}</td><td className="num">{p.slot}</td><td>{p.guard_name}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>نقاط لم تُفحص</h2>{d.skipped.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-skipped"><thead><tr><th>الموقع</th><th>الجولة</th><th>النقطة</th><th>السبب</th></tr></thead>
            <tbody>{d.skipped.map((m) => <tr key={`${m.checkpoint_id}-${m.slot}`}><td className="num">{m.site_code}</td><td className="num">{m.slot}</td><td>{m.name} <span className="muted num">{m.tag}</span></td>
              <td>{SC_SKIP[m.reason ?? ''] ?? m.reason}{m.note ? `: ${m.note}` : ''}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>لم تُفحص في آخر 3 جولات متتالية [تخمين]</h2>{d.repeat_skipped.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-repeat"><tbody>{d.repeat_skipped.map((m) => <tr key={m.checkpoint_id}><td className="num">{m.site_code}</td><td>{m.name}</td><td className="num">{m.patrols}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>مواقع تعمل اليوم بلا حارس أو بلا نقاط</h2>{d.no_guard_or_checkpoints.length === 0 ? <Empty>لا يوجد</Empty> : (
          <ul data-testid="ex-unready">{d.no_guard_or_checkpoints.map((s) => <li key={s.id}><span className="num">{s.code}</span> {s.name}: {!s.guard_worker_id ? 'بلا حارس' : 'بلا نقاط تفتيش'}</li>)}</ul>)}</section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { patrols: number; completed: number; late: number; checkpoints: number; scanned: number; skipped: number; coverage: number | null; incidents: number; high: number; open: number };
  const r = useLoad(() => api<{ totals: Sum; sites: (Sum & { site_code: string; site_name: string | null; customer_name: string | null })[]; categories: { category: string; incidents: number }[] }>(`/security/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="جولات مكتملة" value={`${x.completed} / ${x.patrols}`} />
          <Kpi label="تغطية نقاط التفتيش" value={x.coverage === null ? '—' : `${x.coverage}%`} />
          <Kpi label="جولات متأخرة" value={x.late} tone={x.late ? 'warning' : undefined} />
          <Kpi label="حوادث (عالية الخطورة)" value={`${x.incidents} (${x.high})`} tone={x.high ? 'danger' : undefined} />
        </div>
        <section className="card"><h2>حسب الموقع</h2>
          {r.data!.sites.length === 0 ? <Empty>لا جولات</Empty> : <div className="tbl-wrap"><table data-testid="sc-report-sites"><thead><tr><th>الموقع</th><th>جولات</th><th>مكتملة</th><th>متأخرة</th><th>التغطية</th><th>لم تُفحص</th><th>حوادث</th><th>مفتوحة</th></tr></thead>
            <tbody>{r.data!.sites.map((s) => <tr key={s.site_code}><td><span className="num">{s.site_code}</span> {s.site_name ?? ''}{s.customer_name && <div className="muted">{s.customer_name}</div>}</td>
              <td className="num">{s.patrols}</td><td className="num">{s.completed}</td><td className="num">{s.late}</td><td className="num">{s.coverage === null ? '—' : `${s.coverage}%`}</td>
              <td className="num">{s.skipped}</td><td className="num">{s.incidents}</td><td className="num">{s.open}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>الحوادث حسب النوع</h2>
          {r.data!.categories.length === 0 ? <Empty>لا حوادث</Empty> : <div className="tbl-wrap"><table data-testid="sc-report-categories"><tbody>
            {r.data!.categories.map((c) => <tr key={c.category}><td>{SC_CATEGORY[c.category] ?? c.category}</td><td className="num">{c.incidents}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
