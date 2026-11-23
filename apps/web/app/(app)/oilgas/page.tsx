'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { DOC_TYPE, dt, OG_ASSET_DOCS, OG_CHECK, OG_FAIL, OG_PURPOSE, OG_STATE, OG_WORKER_DOCS, todayKw } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Site {
  id: string; code: string; name: string; field: string | null; customer_id: string | null; customer_name: string | null; worker_docs: string[]; asset_docs: string[];
  h2s_zone: boolean; checkin_min: number; notes: string | null; active: boolean;
}
interface Journey {
  id: string; ref: string; site_id: string; site_code: string; site_name: string; field: string | null; customer_name: string | null; h2s_zone: boolean; checkin_min: number;
  purpose: string; from_place: string; depart_at: string; eta_at: string; end_at: string; passengers: number; cargo: string | null; hazmat: boolean; notes: string | null;
  approved_at: string | null; approved_by_name: string | null; departed_at: string | null; last_checkin_at: string | null; checkins: number; arrived_at: string | null;
  canceled_at: string | null; cancel_reason: string | null; driver_name: string | null; plate_no: string | null; state: string; fail_reason: string | null; checkin_due_at: string | null;
  inspection: { passed: boolean; failed_items: string[]; at: string } | null;
}
type Tab = 'day' | 'sites' | 'exceptions' | 'report';

const kwLocal = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);
const hhmm = (iso: string | null) => iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16) : '—';
const docs = (l: string[]) => l.length ? l.map((d) => DOC_TYPE[d] ?? d).join('، ') : '—';

/** Oil and gas services (sector 18): journey plans for the day, sites and their required documents, journey alarms, and the report. */
export default function OilgasPage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>خدمات النفط والغاز</h1></div>
      <Tabs tabs={[['day', 'رحلات اليوم'], ['sites', 'المواقع'], ['exceptions', 'إدارة الرحلات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
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
  const list = useLoad(() => api<{ data: Journey[] }>(`/oilgas/journeys?date=${day}`).then((r) => r.data), [day]);
  const [add, setAdd] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الرحلات" /></label>
        {can(me, 'tasks:assign') && <button onClick={() => setAdd(true)}>خطة رحلة جديدة</button>}
        <button className="secondary" onClick={() => void list.reload()}>تحديث</button>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا رحلات لهذا اليوم</Empty> : (
        <div className="tbl-wrap"><table data-testid="journeys"><thead><tr><th>الانطلاق</th><th>الرحلة</th><th>الموقع</th><th>الغرض</th><th>السائق والمركبة</th><th>الوصول المتوقع</th><th>البلاغات</th><th>الحالة</th><th></th></tr></thead>
          <tbody>{list.data?.map((j) => (
            <tr key={j.id}><td className="num">{hhmm(j.depart_at)}</td>
              <td><span className="num">{j.ref}</span>{j.hazmat && <> <Badge tone="danger">خطرة</Badge></>}</td>
              <td><span className="num">{j.site_code}</span> {j.site_name}{j.h2s_zone && <> <Badge tone="warning">H2S</Badge></>}</td>
              <td>{OG_PURPOSE[j.purpose]}{j.passengers > 0 && <span className="muted"> · {j.passengers} راكب</span>}</td>
              <td>{j.driver_name ? <>{j.driver_name} · <span className="num">{j.plate_no}</span></> : '—'}</td>
              <td className="num">{hhmm(j.eta_at)}</td>
              <td className="num">{j.checkins}{j.checkin_due_at && <div className="muted">التالي {hhmm(j.checkin_due_at)}</div>}</td>
              <td><Tone map={OG_STATE} value={j.state} />{j.fail_reason && <div className="muted">{OG_FAIL[j.fail_reason] ?? j.fail_reason}</div>}</td>
              <td><button className="small" onClick={() => setOpen(j.id)}>فتح</button></td></tr>
          ))}</tbody></table></div>
      )}
      {add && <JourneyForm onClose={() => setAdd(false)} onDone={(id) => { setAdd(false); setOpen(id); void list.reload(); }} />}
      {open && <JourneyModal id={open} onClose={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function JourneyForm({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const act = useAction();
  const sites = useLoad(() => api<{ data: Site[] }>('/oilgas/sites').then((r) => r.data.filter((s) => s.active)));
  const at = new Date(Date.now() + 3_600_000);
  const { f, bind } = useForm({ site_id: '', purpose: 'crew', from_place: '', depart_at: kwLocal(at), eta_at: kwLocal(new Date(at.getTime() + 90 * 60_000)), end_at: '', passengers: '0', cargo: '', hazmat: '', notes: '' });
  return (
    <Modal title="خطة رحلة جديدة" onClose={onClose}>
      <ErrorBox error={act.error} />
      {sites.data?.length === 0 && <p className="muted">أضف موقعًا من تبويب المواقع أولًا.</p>}
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const j = await api<Journey>('/oilgas/journeys', { method: 'POST', body: {
          site_id: f.site_id, purpose: f.purpose, from_place: f.from_place, depart_at: kwIso(f.depart_at), eta_at: kwIso(f.eta_at), ...(f.end_at ? { end_at: kwIso(f.end_at) } : {}),
          passengers: Number(f.passengers) || 0, hazmat: f.hazmat === 'yes', ...clean({ cargo: f.cargo, notes: f.notes }),
        } });
        onDone(j.id);
      }); }}>
        <div className="row">
          <label className="field">الموقع<select {...bind('site_id')} required><option value="">—</option>{sites.data?.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></label>
          <label className="field">الغرض<select {...bind('purpose')}>{Object.entries(OG_PURPOSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">من<input {...bind('from_place')} required maxLength={200} placeholder="القاعدة، المستودع…" /></label>
        </div>
        <div className="row">
          <label className="field">الانطلاق<input {...bind('depart_at')} type="datetime-local" required /></label>
          <label className="field">الوصول المتوقع<input {...bind('eta_at')} type="datetime-local" required /></label>
          <label className="field">تتحرر المركبة (اختياري)<input {...bind('end_at')} type="datetime-local" /></label>
        </div>
        <div className="row">
          <label className="field">الركاب<input {...bind('passengers')} type="number" min={0} max={60} className="num" style={{ width: 80 }} /></label>
          <label className="field">الحمولة<input {...bind('cargo')} maxLength={300} /></label>
          <label className="field">مواد خطرة<select {...bind('hazmat')}><option value="">لا</option><option value="yes">نعم (يلزم السائق وثيقة المواد الخطرة)</option></select></label>
        </div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={500} /></label>
        <button disabled={act.busy}>حفظ الخطة</button>
      </form>
    </Modal>
  );
}

function JourneyModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const j = useLoad(() => api<Journey>(`/oilgas/journeys/${id}`), [id]);
  const d = j.data;
  const assignable = !!d && ['draft', 'approved', 'failed'].includes(d.state);
  type Cand = { worker_docs: string[]; asset_docs: string[]; drivers: { id: string; display_name: string; missing: string[] }[]; vehicles: { asset_id: string; plate_no: string; seats: number | null; missing: string[] }[] };
  const cand = useLoad(() => assignable ? api<Cand>(`/oilgas/journeys/${id}/candidates`) : Promise.resolve(null), [d?.state]);
  const act = useAction();
  const { f, bind } = useForm({ asset_id: '', driver_worker_id: '', note: '', reason: '' });
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/oilgas/journeys/${id}/${path}`, { method: 'POST', body }); await j.reload(); });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={d ? `خطة الرحلة ${d.ref}` : 'خطة الرحلة'} onClose={onClose}>
      <ErrorBox error={j.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={OG_STATE} value={d.state} /> {OG_PURPOSE[d.purpose]} إلى <b>{d.site_code} · {d.site_name}</b>{d.field ? ` (${d.field})` : ''}{d.customer_name ? ` · ${d.customer_name}` : ''}
          {d.hazmat && <> · <Badge tone="danger">حمولة خطرة</Badge></>}{d.h2s_zone && <> · <Badge tone="warning">منطقة H2S</Badge></>}</p>
        <p>من <b>{d.from_place}</b> · انطلاق <span className="num">{dt(d.depart_at)}</span> · وصول متوقع <span className="num">{dt(d.eta_at)}</span>
          {d.passengers > 0 && <> · {d.passengers} راكب</>}{d.cargo && <> · {d.cargo}</>}</p>
        <p data-testid="journey-approval">{d.approved_at ? <>اعتمدها {d.approved_by_name ?? '—'} <span className="num">{dt(d.approved_at)}</span></> : <b>لم تُعتمد بعد: لا ينطلق السائق قبل الاعتماد</b>}</p>
        {d.driver_name && <p data-testid="journey-driver">السائق {d.driver_name} · <span className="num">{d.plate_no}</span> · انطلق {hhmm(d.departed_at)} · بلاغات {d.checkins}
          {d.last_checkin_at && <> (آخرها {hhmm(d.last_checkin_at)})</>} · وصل {hhmm(d.arrived_at)}</p>}
        {d.inspection && <p>آخر فحص للمركبة: {d.inspection.passed ? <Badge tone="success">سليم</Badge> : <Badge tone="danger">فيه خلل: {d.inspection.failed_items.map((x) => OG_CHECK[x] ?? x).join('، ')}</Badge>}</p>}
        {d.canceled_at && <p className="muted">أُلغيت: {d.cancel_reason}</p>}
        <div className="row">
          {w && !d.approved_at && !['canceled', 'done', 'failed'].includes(d.state) && <button disabled={act.busy} onClick={() => void post('approve', {})}>اعتماد الخطة</button>}
        </div>
        {w && assignable && <form className="stack" onSubmit={(e) => { e.preventDefault(); void post('assign', { asset_id: f.asset_id, driver_worker_id: f.driver_worker_id }); }}>
          <p className="muted" style={{ margin: 0 }}>الوثائق المطلوبة حتى نهاية الرحلة · السائق: {docs(cand.data?.worker_docs ?? [])} · المركبة: {docs(cand.data?.asset_docs ?? [])}</p>
          <div className="row">
            <label className="field">المركبة<select {...bind('asset_id')} required><option value="">—</option>{cand.data?.vehicles.map((x) => (
              <option key={x.asset_id} value={x.asset_id} disabled={x.missing.length > 0}>{x.plate_no}{x.seats ? ` · ${x.seats} مقعد` : ''}{x.missing.length ? ` · ينقص: ${docs(x.missing)}` : ''}</option>))}</select></label>
            <label className="field">السائق<select {...bind('driver_worker_id')} required><option value="">—</option>{cand.data?.drivers.map((x) => (
              <option key={x.id} value={x.id} disabled={x.missing.length > 0}>{x.display_name}{x.missing.length ? ` · ينقص: ${docs(x.missing)}` : ''}</option>))}</select></label>
            <button disabled={act.busy}>إسناد</button>
          </div>
        </form>}
        {w && d.state === 'en_route' && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('checkin', clean({ note: f.note })); }}>
          <input {...bind('note')} placeholder="ملاحظة البلاغ (لاسلكي، هاتف)" maxLength={300} aria-label="ملاحظة البلاغ" />
          <button className="secondary" disabled={act.busy}>تسجيل بلاغ من المكتب</button>
          {d.checkin_due_at && <span className="muted">البلاغ التالي قبل <span className="num">{hhmm(d.checkin_due_at)}</span></span>}
        </form>}
        {w && ['draft', 'approved', 'assigned', 'ready', 'failed'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب إلغاء الرحلة" />
          <button className="danger" disabled={act.busy}>إلغاء الرحلة</button>
        </form>}
      </div>}
    </Modal>
  );
}

function DocPicker({ label, options, value, onChange }: { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="row" aria-label={label}><span className="muted">{label}:</span>
      {options.map((k) => <label key={k} className="row"><input type="checkbox" name={`${label}-${k}`} checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} /> {DOC_TYPE[k] ?? k}</label>)}
    </fieldset>
  );
}

function SitesView() {
  const me = useMe();
  const sites = useLoad(() => api<{ data: Site[] }>('/oilgas/sites').then((r) => r.data));
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const act = useAction();
  const { f, bind } = useForm({ code: '', name: '', field: '', customer_id: '', h2s: '', checkin_min: '60' });
  const [wd, setWd] = useState<string[]>(['h2s', 'site_pass']);
  const [ad, setAd] = useState<string[]>(['site_sticker']);
  return (
    <section className="card stack"><h2>مواقع العمل ووثائقها الإلزامية</h2>
      <ErrorBox error={sites.error ?? act.error} />
      {sites.data?.length === 0 ? <Empty>لا مواقع بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="og-sites"><thead><tr><th>الرمز</th><th>الموقع</th><th>المشغّل</th><th>وثائق السائق</th><th>وثائق المركبة</th><th>البلاغ كل</th></tr></thead>
          <tbody>{sites.data?.map((s) => <tr key={s.id} className={s.active ? '' : 'muted'}><td className="num">{s.code}</td><td>{s.name}{s.field && <div className="muted">{s.field}</div>}{s.h2s_zone && <Badge tone="warning">H2S</Badge>}</td>
            <td>{s.customer_name ?? '—'}</td><td>{docs(s.worker_docs)}</td><td>{docs(s.asset_docs)}</td><td className="num">{s.checkin_min} د</td></tr>)}</tbody></table></div>
      )}
      {can(me, 'tasks:assign') && <form className="stack" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api('/oilgas/sites', { method: 'POST', body: { legal_entity_id: me.legal_entities[0]?.id, code: f.code, name: f.name, worker_docs: wd, asset_docs: ad, h2s_zone: f.h2s === 'yes',
          checkin_min: Number(f.checkin_min) || 60, ...clean({ field: f.field, customer_id: f.customer_id }) } });
        await sites.reload();
      }); }}>
        <div className="row">
          <label className="field">الرمز<input {...bind('code')} required maxLength={12} className="num" style={{ width: 110 }} placeholder="BRG-GC1" /></label>
          <label className="field">الاسم<input {...bind('name')} required maxLength={120} /></label>
          <label className="field">الحقل<input {...bind('field')} maxLength={80} placeholder="برقان، الروضتين…" /></label>
          <label className="field">المشغّل<select {...bind('customer_id')}><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">منطقة H2S<select {...bind('h2s')}><option value="">لا</option><option value="yes">نعم</option></select></label>
          <label className="field">البلاغ كل (دقيقة)<input {...bind('checkin_min')} type="number" min={15} max={240} className="num" style={{ width: 80 }} /></label>
        </div>
        <DocPicker label="وثائق السائق" options={OG_WORKER_DOCS} value={wd} onChange={setWd} />
        <DocPicker label="وثائق المركبة" options={OG_ASSET_DOCS} value={ad} onChange={setAd} />
        <button disabled={act.busy}>إضافة الموقع</button>
        <p className="muted" style={{ margin: 0 }}>تُسجَّل وثائق السائقين والمركبات من صفحة الوثائق. قائمة الوثائق المقترحة [تخمين] حسب متطلبات المشغّل.</p>
      </form>}
    </section>
  );
}

function ExceptionsView() {
  type F = { journey_id: string; ref: string; failed_items: string[]; occurred_at: string; plate_no: string | null; driver_name: string | null };
  type X = { not_approved: Journey[]; unassigned: Journey[]; overdue_checkin: Journey[]; overdue_arrival: Journey[]; failed_inspections: F[] };
  const x = useLoad(() => api<X>('/oilgas/exceptions'));
  const d = x.data;
  const table = (id: string, rows: Journey[], extra: (j: Journey) => string) => rows.length === 0 ? <Empty>لا يوجد</Empty> : (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th>الرحلة</th><th>الموقع</th><th>الانطلاق</th><th>السائق</th><th>التفاصيل</th></tr></thead>
      <tbody>{rows.map((j) => <tr key={j.id}><td className="num">{j.ref}</td><td>{j.site_code} · {j.site_name}</td><td className="num">{dt(j.depart_at)}</td><td>{j.driver_name ?? '—'}</td><td>{extra(j)}</td></tr>)}</tbody></table></div>
  );
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="بلاغ فائت" value={d.overdue_checkin.length} tone={d.overdue_checkin.length ? 'danger' : undefined} />
          <Kpi label="تأخرت عن الوصول" value={d.overdue_arrival.length} tone={d.overdue_arrival.length ? 'danger' : undefined} />
          <Kpi label="بانتظار الاعتماد" value={d.not_approved.length} tone={d.not_approved.length ? 'warning' : undefined} />
          <Kpi label="فحص فيه خلل (24 ساعة)" value={d.failed_inspections.length} tone={d.failed_inspections.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>فات موعد البلاغ: اتصل بالسائق فورًا</h2>{table('ex-checkin', d.overdue_checkin, (j) => `آخر بلاغ ${hhmm(j.last_checkin_at ?? j.departed_at)} · المطلوب قبل ${hhmm(j.checkin_due_at)}`)}</section>
        <section className="card"><h2>لم تصل بعد 30 دقيقة من الموعد المتوقع [تخمين]</h2>{table('ex-arrival', d.overdue_arrival, (j) => `متوقع ${hhmm(j.eta_at)}`)}</section>
        <section className="card"><h2>تنطلق خلال ساعتين ولم تُعتمد</h2>{table('ex-approval', d.not_approved, (j) => OG_STATE[j.state]?.label ?? j.state)}</section>
        <section className="card"><h2>تنطلق خلال ساعتين بلا مركبة</h2>{table('ex-unassigned', d.unassigned, (j) => OG_PURPOSE[j.purpose])}</section>
        <section className="card"><h2>فحص مركبة فيه خلل</h2>{d.failed_inspections.length === 0 ? <Empty>لا يوجد</Empty> : (
          <div className="tbl-wrap"><table data-testid="ex-inspections"><thead><tr><th>الرحلة</th><th>الوقت</th><th>المركبة</th><th>السائق</th><th>الخلل</th></tr></thead>
            <tbody>{d.failed_inspections.map((i, k) => <tr key={k}><td className="num">{i.ref}</td><td className="num">{dt(i.occurred_at)}</td><td className="num">{i.plate_no ?? '—'}</td><td>{i.driver_name ?? '—'}</td>
              <td>{i.failed_items.map((f) => OG_CHECK[f] ?? f).join('، ')}</td></tr>)}</tbody></table></div>)}</section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { journeys: number; done: number; on_time: number; late: number; failed: number; canceled: number; passengers: number; hazmat: number; checkins: number };
  const r = useLoad(() => api<{ totals: Sum; sites: (Sum & { site_code: string; site_name: string; customer_name: string | null })[] }>(`/oilgas/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="رحلات منتهية" value={`${x.done} / ${x.journeys}`} />
          <Kpi label="في الوقت" value={x.done ? `${Math.round((x.on_time / x.done) * 100)}%` : '—'} />
          <Kpi label="ركاب منقولون" value={x.passengers} />
          <Kpi label="حمولات خطرة" value={x.hazmat} />
        </div>
        <p className="muted">متأخرة {x.late} · تعذّرت {x.failed} · ملغاة {x.canceled} · بلاغات {x.checkins}</p>
        <section className="card"><h2>حسب الموقع</h2>
          {r.data!.sites.length === 0 ? <Empty>لا رحلات</Empty> : <div className="tbl-wrap"><table data-testid="og-report"><thead><tr><th>الموقع</th><th>المشغّل</th><th>رحلات</th><th>منتهية</th><th>في الوقت</th><th>متأخرة</th><th>ركاب</th><th>خطرة</th></tr></thead>
            <tbody>{r.data!.sites.map((s) => <tr key={s.site_code}><td><span className="num">{s.site_code}</span> {s.site_name}</td><td>{s.customer_name ?? '—'}</td><td className="num">{s.journeys}</td><td className="num">{s.done}</td>
              <td className="num">{s.on_time}</td><td className="num">{s.late}</td><td className="num">{s.passengers}</td><td className="num">{s.hazmat}</td></tr>)}</tbody></table></div>}
        </section>
      </>}
    </div>
  );
}
