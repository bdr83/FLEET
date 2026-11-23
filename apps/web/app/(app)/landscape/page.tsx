'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { FAIL_REASON, ISO_WEEKDAYS, LS_IRRIGATION, LS_SERVICE, LS_STATE, SHUTTLE_SKIP, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Site {
  id: string; code: string; name: string; customer_id: string; customer_name: string; area: string | null; address: string | null; contact_phone: string | null; area_m2: number | null;
  services: string[]; days: number[]; visit_time: string; duration_min: number; lead_worker_id: string | null; lead_name: string | null; crew_size: number; asset_id: string | null;
  plate_no: string | null; irrigation: boolean; instructions: string | null; active: boolean; version: number; open_faults: number;
}
interface Visit {
  id: string; ref: string; site_id: string; site_code: string; site_name: string; customer_name: string; area: string | null; has_irrigation: boolean; visit_date: string; extra: boolean;
  task_status: string; start_at: string; lead_name: string; plate_no: string | null; services_planned: string[]; arrived_at: string | null; done_at: string | null;
  services_done: string[] | null; irrigation: string | null; waste_bags: number | null; received_by: string | null; result_note: string | null; issue_closed_at: string | null;
  issue_close_note: string | null; started_at: string | null; fail_reason: string | null; state: string; missing?: string[];
}
type Tab = 'day' | 'sites' | 'exceptions' | 'report';

const hhmm = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16) : '—');
const daysText = (d: number[]) => (d.length === 7 ? 'كل يوم' : ISO_WEEKDAYS.filter(([n]) => d.includes(n)).map(([, l]) => l).join('، '));
const svcText = (l: string[] | null | undefined) => (l?.length ? l.map((s) => LS_SERVICE[s] ?? s).join('، ') : '—');
const FAULTS = ['leak', 'broken', 'dry_area'];

/** Landscaping and garden maintenance (sector 27): the day's visits, the contract gardens, exceptions and the report. */
export default function LandscapePage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>تنسيق الحدائق وصيانتها</h1></div>
      <Tabs tabs={[['day', 'زيارات اليوم'], ['sites', 'الحدائق والعقود'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'day' && <DayView />}
      {tab === 'sites' && <SitesView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function DayView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const visits = useLoad(() => api<{ data: Visit[] }>(`/landscape/visits?date=${day}`).then((r) => r.data), [day]);
  const act = useAction();
  const [gen, setGen] = useState<{ created: string[]; existing: string[]; skipped: { site: string; reason: string }[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [extra, setExtra] = useState(false);
  const skip: Record<string, string> = { ...SHUTTLE_SKIP, no_lead: 'بلا رئيس طاقم', lead_booked: 'رئيس الطاقم محجوز في الوقت نفسه', lead_inactive: 'رئيس الطاقم غير نشط',
    vehicle_booked: 'المركبة محجوزة في الوقت نفسه', vehicle_out_of_service: 'المركبة خارج الخدمة', past: 'موعد الزيارة مضى' };
  const w = can(me, 'tasks:assign');
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => { setDay(e.target.value); setGen(null); }} aria-label="يوم الزيارات" /></label>
        {w && <button disabled={act.busy} onClick={() => void act.run(async () => {
          setGen(await api('/landscape/visits/generate', { method: 'POST', body: { date: day } })); await visits.reload();
        })}>توليد زيارات اليوم</button>}
        {w && <button className="secondary" onClick={() => setExtra(true)}>زيارة إضافية</button>}
        <button className="secondary" onClick={() => void visits.reload()}>تحديث</button>
      </div>
      <ErrorBox error={act.error ?? visits.error} />
      {gen && <p data-testid="gen-result" className="muted">أُنشئ {gen.created.length}{gen.existing.length ? ` · موجود ${gen.existing.length}` : ''}
        {gen.skipped.map((s) => <span key={s.site}> · <Badge tone="warning">{s.site}: {skip[s.reason] ?? s.reason}</Badge></span>)}</p>}
      {visits.data?.length === 0 ? <Empty>لا زيارات لهذا اليوم. ولّدها من أيام الحدائق.</Empty> : (
        <div className="tbl-wrap"><table data-testid="visits"><thead><tr><th>الموعد</th><th>الحديقة</th><th>رئيس الطاقم</th><th>الحالة</th><th>الخدمات</th><th>الري</th><th></th></tr></thead>
          <tbody>{visits.data?.map((v) => (
            <tr key={v.id}><td className="num">{hhmm(v.start_at)}{v.started_at && <div className="muted">بدأ {hhmm(v.started_at)}</div>}</td>
              <td><span className="num">{v.site_code}</span> {v.site_name}{v.extra && <> <Badge tone="info">إضافية</Badge></>}<div className="muted">{v.customer_name}</div></td>
              <td>{v.lead_name}{v.plate_no && <> · <span className="num">{v.plate_no}</span></>}</td>
              <td><Tone map={LS_STATE} value={v.state} />{v.fail_reason && <div className="muted">{FAIL_REASON[v.fail_reason] ?? v.fail_reason}</div>}</td>
              <td>{v.services_done ? <>{svcText(v.services_done)}{v.services_planned.some((s) => !v.services_done!.includes(s)) && <div><Badge tone="warning">لم يُنفذ: {svcText(v.services_planned.filter((s) => !v.services_done!.includes(s)))}</Badge></div>}</>
                : <span className="muted">{svcText(v.services_planned)}</span>}</td>
              <td>{v.irrigation ? <Tone map={LS_IRRIGATION} value={v.irrigation} /> : '—'}</td>
              <td><button className="small" onClick={() => setOpen(v.id)}>فتح</button></td></tr>
          ))}</tbody></table></div>
      )}
      {open && <VisitModal id={open} onClose={() => { setOpen(null); void visits.reload(); }} />}
      {extra && <ExtraVisit day={day} onClose={() => setExtra(false)} onDone={() => { setExtra(false); void visits.reload(); }} />}
    </section>
  );
}

function VisitModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const r = useLoad(() => api<Visit>(`/landscape/visits/${id}`), [id]);
  const act = useAction();
  const v = r.data;
  const w = can(me, 'tasks:assign');
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/landscape/visits/${id}/${path}`, { method: 'POST', body }); await r.reload(); });
  const { f, bind } = useForm({ reason: '', note: '' });
  return (
    <Modal title={v ? `زيارة ${v.ref}` : 'الزيارة'} onClose={onClose}>
      <ErrorBox error={r.error ?? act.error} />
      {v && <div className="stack" data-testid="visit-detail">
        <p><Tone map={LS_STATE} value={v.state} /> {v.site_name} · {v.lead_name}{v.arrived_at && <> · وصل {hhmm(v.arrived_at)}</>}{v.done_at && <> · أنجز {hhmm(v.done_at)}</>}</p>
        <dl className="dl">
          <dt>الخدمات المخططة</dt><dd>{svcText(v.services_planned)}</dd>
          <dt>المنفذة</dt><dd>{svcText(v.services_done)}</dd>
          <dt>شبكة الري</dt><dd>{v.irrigation ? <Tone map={LS_IRRIGATION} value={v.irrigation} /> : v.has_irrigation ? '—' : 'لا توجد شبكة'}</dd>
          <dt>أكياس المخلفات</dt><dd className="num">{v.waste_bags ?? '—'}</dd>
          {v.received_by && <><dt>المستلم</dt><dd>{v.received_by}</dd></>}
          {v.result_note && <><dt>ملاحظة الطاقم</dt><dd>{v.result_note}</dd></>}
          {v.issue_closed_at && <><dt>إغلاق العطل</dt><dd>{v.issue_close_note}</dd></>}
        </dl>
        {w && v.irrigation && FAULTS.includes(v.irrigation) && !v.issue_closed_at && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('close-fault', { note: f.note }); }}>
          <input {...bind('note')} required maxLength={500} placeholder="ما الذي تم (تغيير رشاش، طلب قطعة، إبلاغ العميل...)" aria-label="ملاحظة إغلاق العطل" />
          <button disabled={act.busy}>إغلاق عطل الري</button>
        </form>}
        {w && v.state === 'assigned' && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={300} aria-label="سبب إلغاء الزيارة" />
          <button className="danger" disabled={act.busy}>إلغاء الزيارة</button>
        </form>}
      </div>}
    </Modal>
  );
}

function ServicesPick({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="row" aria-label="الخدمات">{Object.entries(LS_SERVICE).map(([k, l]) => (
      <label key={k} className="row" style={{ gap: 4 }}><input type="checkbox" name={`svc-${k}`} style={{ width: 'auto' }} checked={value.includes(k)}
        onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} /> {l}</label>
    ))}</fieldset>
  );
}

const useLeads = () => useLoad(() => api<{ data: { id: string; display_name: string; kind: string }[] }>('/workers?status=active').then((x) => x.data.filter((w) => ['technician', 'supervisor', 'driver'].includes(w.kind))));
const useAssets = () => useLoad(() => api<{ data: { id: string; plate_no: string | null; status: string }[] }>('/assets').then((x) => x.data.filter((a) => !['retired', 'out_of_service'].includes(a.status))));

function ExtraVisit({ day, onClose, onDone }: { day: string; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const sites = useLoad(() => api<{ data: Site[] }>('/landscape/sites').then((r) => r.data.filter((s) => s.active)));
  const leads = useLeads();
  const { f, bind } = useForm({ site_id: '', date: day, time: '16:00', lead_worker_id: '', note: '' });
  const [svc, setSvc] = useState<string[]>(['planting']);
  return (
    <Modal title="زيارة إضافية" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api('/landscape/visits', { method: 'POST', body: { site_id: f.site_id, date: f.date, time: f.time, services: svc, lead_worker_id: f.lead_worker_id || null, note: f.note || null } });
        onDone();
      }); }}>
        <div className="row">
          <label className="field">الحديقة<select {...bind('site_id')} required aria-label="حديقة الزيارة الإضافية"><option value="">—</option>{sites.data?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label>
          <label className="field">اليوم<input {...bind('date')} type="date" required /></label>
          <label className="field">الوقت<input {...bind('time')} type="time" required className="num" /></label>
        </div>
        <ServicesPick value={svc} onChange={setSvc} />
        <div className="row">
          <label className="field">رئيس الطاقم (إن لم يكن المعتاد)<select {...bind('lead_worker_id')}><option value="">رئيس طاقم الحديقة</option>{leads.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          <label className="field">ملاحظة<input {...bind('note')} maxLength={300} placeholder="زراعة 20 شتلة ورد" /></label>
        </div>
        <button disabled={act.busy || svc.length === 0}>إضافة الزيارة</button>
      </form>
    </Modal>
  );
}

function SitesView() {
  const me = useMe();
  const sites = useLoad(() => api<{ data: Site[] }>('/landscape/sites').then((r) => r.data));
  const [edit, setEdit] = useState<Site | 'new' | null>(null);
  const w = can(me, 'tasks:assign');
  return (
    <section className="card stack">
      <div className="row"><h2 style={{ margin: 0 }}>الحدائق المتعاقد عليها</h2>{w && <button onClick={() => setEdit('new')}>إضافة حديقة</button>}</div>
      <ErrorBox error={sites.error} />
      {sites.data?.length === 0 ? <Empty>لا حدائق بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="ls-sites"><thead><tr><th>الرمز</th><th>الحديقة</th><th>الخدمات</th><th>الزيارة</th><th>الطاقم</th><th>أعطال ري</th><th></th></tr></thead>
          <tbody>{sites.data?.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'muted'}><td className="num">{s.code}</td>
              <td>{s.name}<div className="muted">{s.customer_name}{s.area ? ` · ${s.area}` : ''}{s.area_m2 ? ` · ${s.area_m2} م²` : ''}</div></td>
              <td>{svcText(s.services)}{!s.irrigation && <div className="muted">بلا شبكة ري</div>}</td>
              <td>{daysText(s.days)}<div className="muted num">{s.visit_time} · {s.duration_min} د</div></td>
              <td>{s.lead_name ?? <Badge tone="warning">بلا رئيس طاقم</Badge>} <span className="muted">({s.crew_size} عمال)</span>{s.plate_no && <div className="num muted">{s.plate_no}</div>}</td>
              <td className="num">{s.open_faults ? <Badge tone="danger">{s.open_faults}</Badge> : '—'}</td>
              <td>{w && <button className="small secondary" onClick={() => setEdit(s)}>تعديل</button>}</td></tr>
          ))}</tbody></table></div>
      )}
      {edit && <SiteForm s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void sites.reload(); }} />}
    </section>
  );
}

function SiteForm({ s, onClose, onDone }: { s: Site | null; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const assets = useAssets();
  const leads = useLeads();
  const { f, bind, setF } = useForm({ code: s?.code ?? '', name: s?.name ?? '', customer_id: s?.customer_id ?? '', area: s?.area ?? '', address: s?.address ?? '', contact_phone: s?.contact_phone ?? '',
    area_m2: s?.area_m2 ? String(s.area_m2) : '', time: s?.visit_time ?? '07:00', duration: String(s?.duration_min ?? 120), lead_worker_id: s?.lead_worker_id ?? '', crew: String(s?.crew_size ?? 2),
    asset_id: s?.asset_id ?? '', instructions: s?.instructions ?? '', irrigation: s?.irrigation ?? true, active: s?.active ?? true });
  const [days, setDays] = useState<number[]>(s?.days ?? [1, 4]);
  const [svc, setSvc] = useState<string[]>(s?.services ?? ['mowing', 'pruning', 'irrigation']);
  return (
    <Modal title={s ? `تعديل الحديقة ${s.code}` : 'إضافة حديقة'} onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const body = { name: f.name, customer_id: f.customer_id, area: f.area || null, address: f.address || null, contact_phone: f.contact_phone || null, area_m2: f.area_m2 ? Number(f.area_m2) : null,
          services: svc, days, visit_time: f.time, duration_min: Number(f.duration) || 120, lead_worker_id: f.lead_worker_id || null, crew_size: Number(f.crew) || 2,
          asset_id: f.asset_id || null, irrigation: f.irrigation, instructions: f.instructions || null };
        if (s) await api(`/landscape/sites/${s.id}`, { method: 'PATCH', body: { ...body, version: s.version, active: f.active } });
        else await api('/landscape/sites', { method: 'POST', body: { ...body, legal_entity_id: me.legal_entities[0]?.id, code: f.code } });
        onDone();
      }); }}>
        <div className="row">
          {!s && <label className="field">الرمز<input {...bind('code')} required maxLength={12} className="num" style={{ width: 100 }} placeholder="V12" /></label>}
          <label className="field">اسم الحديقة<input {...bind('name')} required maxLength={120} /></label>
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field">المنطقة<input {...bind('area')} maxLength={80} /></label>
          <label className="field">العنوان<input {...bind('address')} maxLength={200} /></label>
          <label className="field">هاتف التواصل<input {...bind('contact_phone')} maxLength={20} className="num" /></label>
          <label className="field">المساحة (م²)<input {...bind('area_m2')} type="number" min={1} className="num" style={{ width: 100 }} /></label>
        </div>
        <ServicesPick value={svc} onChange={setSvc} />
        <fieldset className="row" aria-label="أيام الزيارة">{ISO_WEEKDAYS.map(([n, l]) => (
          <label key={n} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={days.includes(n)} onChange={(e) => setDays(e.target.checked ? [...days, n] : days.filter((x) => x !== n))} /> {l}</label>
        ))}</fieldset>
        <div className="row">
          <label className="field">وقت الزيارة<input {...bind('time')} type="time" className="num" aria-label="وقت الزيارة" /></label>
          <label className="field">المدة (دقيقة)<input {...bind('duration')} type="number" min={15} max={720} className="num" style={{ width: 90 }} /></label>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.irrigation} onChange={(e) => setF({ ...f, irrigation: e.target.checked })} /> فيها شبكة ري</label>
        </div>
        <div className="row">
          <label className="field">رئيس الطاقم<select {...bind('lead_worker_id')}><option value="">—</option>{leads.data?.map((w) => <option key={w.id} value={w.id}>{w.display_name}</option>)}</select></label>
          <label className="field">عدد العمال<input {...bind('crew')} type="number" min={1} max={50} className="num" style={{ width: 80 }} /></label>
          <label className="field">المركبة (اختيارية)<select {...bind('asset_id')}><option value="">—</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          {s && <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> فعّال</label>}
        </div>
        <label className="field">تعليمات للطاقم<input {...bind('instructions')} maxLength={500} placeholder="لا تقصوا النخلة، المفتاح عند الحارس" /></label>
        <button disabled={act.busy || svc.length === 0}>حفظ</button>
      </form>
    </Modal>
  );
}

function ExceptionsView() {
  const [day, setDay] = useState(todayKw());
  type X = { late_start: Visit[]; no_lead: Site[]; services_undone: Visit[]; open_faults: Visit[]; irrigation_unchecked: { site_id: string; site_code: string; site_name: string; customer_name: string; visits: number }[] };
  const x = useLoad(() => api<X>(`/landscape/exceptions?date=${day}`), [day]);
  const d = x.data;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الاستثناءات" /></label>
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="أعطال ري مفتوحة" value={d.open_faults.length} tone={d.open_faults.length ? 'danger' : undefined} />
          <Kpi label="زيارات تأخرت عن البدء" value={d.late_start.length} tone={d.late_start.length ? 'warning' : undefined} />
          <Kpi label="خدمات لم تُنفذ (7 أيام)" value={d.services_undone.length} tone={d.services_undone.length ? 'warning' : undefined} />
          <Kpi label="حدائق اليوم بلا رئيس طاقم" value={d.no_lead.length} tone={d.no_lead.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>أعطال الري المفتوحة</h2>{d.open_faults.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-faults"><tbody>{d.open_faults.map((v) => <tr key={v.id}><td className="num">{v.site_code}</td><td>{v.site_name}</td><td className="num">{v.visit_date}</td>
            <td><Tone map={LS_IRRIGATION} value={v.irrigation ?? ''} />{v.result_note && <div className="muted">{v.result_note}</div>}</td><td><button className="small" onClick={() => setOpen(v.id)}>فتح</button></td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>زيارات لم تبدأ بعد 30 دقيقة من موعدها [تخمين]</h2>{d.late_start.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-late"><tbody>{d.late_start.map((v) => <tr key={v.id}><td className="num">{v.site_code}</td><td>{v.site_name}</td><td className="num">{hhmm(v.start_at)}</td><td>{v.lead_name}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>خدمات مخططة لم تُنفذ</h2>{d.services_undone.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-undone"><thead><tr><th>الحديقة</th><th>اليوم</th><th>لم يُنفذ</th><th>ملاحظة الطاقم</th></tr></thead>
            <tbody>{d.services_undone.map((v) => <tr key={v.id}><td><span className="num">{v.site_code}</span> {v.site_name}</td><td className="num">{v.visit_date}</td><td>{svcText(v.missing)}</td><td>{v.result_note ?? '—'}</td></tr>)}</tbody></table></div>)}</section>
        <section className="card"><h2>شبكة ري لم تُفحص في آخر 3 زيارات [تخمين]</h2>{d.irrigation_unchecked.length === 0 ? <Empty>لا يوجد</Empty> : (
          <ul data-testid="ex-unchecked">{d.irrigation_unchecked.map((s) => <li key={s.site_id}><span className="num">{s.site_code}</span> {s.site_name} · {s.customer_name}</li>)}</ul>)}</section>
        <section className="card"><h2>حدائق تُزار اليوم بلا رئيس طاقم</h2>{d.no_lead.length === 0 ? <Empty>لا يوجد</Empty> : (
          <ul data-testid="ex-nolead">{d.no_lead.map((s) => <li key={s.id}><span className="num">{s.code}</span> {s.name}</li>)}</ul>)}</section>
      </>}
      {open && <VisitModal id={open} onClose={() => { setOpen(null); void x.reload(); }} />}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { visits: number; done: number; failed: number; extra: number; late: number; services_planned: number; services_done: number; completion: number | null; waste_bags: number; faults: number; open_faults: number };
  const r = useLoad(() => api<{ totals: Sum; sites: (Sum & { site_code: string; site_name: string; customer_name: string })[]; services: { key: string; planned: number; done: number }[] }>(`/landscape/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="زيارات منجزة" value={`${x.done} / ${x.visits}`} />
          <Kpi label="تنفيذ الخدمات المخططة" value={x.completion === null ? '—' : `${x.completion}%`} />
          <Kpi label="أكياس مخلفات خضراء" value={x.waste_bags} />
          <Kpi label="أعطال ري (مفتوحة)" value={`${x.faults} (${x.open_faults})`} tone={x.open_faults ? 'danger' : undefined} />
        </div>
        <section className="card"><h2>حسب الحديقة</h2>
          {r.data!.sites.length === 0 ? <Empty>لا زيارات</Empty> : <div className="tbl-wrap"><table data-testid="ls-report-sites"><thead><tr><th>الحديقة</th><th>زيارات</th><th>منجزة</th><th>متأخرة</th><th>تنفيذ الخدمات</th><th>أكياس</th><th>أعطال ري</th></tr></thead>
            <tbody>{r.data!.sites.map((s) => <tr key={s.site_code}><td><span className="num">{s.site_code}</span> {s.site_name}<div className="muted">{s.customer_name}</div></td>
              <td className="num">{s.visits}</td><td className="num">{s.done}</td><td className="num">{s.late}</td><td className="num">{s.completion === null ? '—' : `${s.completion}%`}</td>
              <td className="num">{s.waste_bags}</td><td className="num">{s.faults}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>حسب الخدمة</h2>
          {r.data!.services.length === 0 ? <Empty>لا خدمات</Empty> : <div className="tbl-wrap"><table data-testid="ls-report-services"><thead><tr><th>الخدمة</th><th>مخططة</th><th>نُفذت</th></tr></thead><tbody>
            {r.data!.services.map((s) => <tr key={s.key}><td>{LS_SERVICE[s.key] ?? s.key}</td><td className="num">{s.planned}</td><td className="num">{s.done}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
