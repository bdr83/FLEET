'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, todayKw, TR_BUS, TR_FAIL, TR_STATE } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Bus {
  task_id: string; seq: number; asset_id: string; plate_no: string; seats: number | null; boarded: number | null; odometer_out: number | null; departed_at: string | null;
  returned: number | null; odometer_in: number | null; returned_at: string | null; return_note: string | null; status: string; driver_name: string | null; fail_reason: string | null;
  trip_ref?: string; group_name?: string; customer_name?: string; start_at?: string; end_at?: string;
}
interface Trip {
  id: string; ref: string; customer_id: string; customer_name: string; group_name: string; contact_name: string | null; contact_phone: string | null; pax: number; start_at: string; end_at: string;
  pickup: string; destination: string; itinerary: { place: string; at: string | null; note?: string }[]; cross_border: boolean; price: string | null; deposit: string | null; notes: string | null;
  canceled_at: string | null; cancel_reason: string | null; listed: number; buses: Bus[]; seats: number; state: string; km: number;
}
type Tab = 'trips' | 'exceptions' | 'report';

const kwLocal = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);
const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

/** Tourist and charter buses (sector 13): group trips with their buses and passenger lists, exceptions, and the report. */
export default function TourPage() {
  const [tab, setTab] = useState<Tab>('trips');
  return (
    <div className="page stack">
      <div className="page-head"><h1>الحافلات السياحية</h1></div>
      <Tabs tabs={[['trips', 'الرحلات'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'trips' && <TripsView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function TripsView() {
  const me = useMe();
  const [from, setFrom] = useState(todayKw());
  const [to, setTo] = useState(plusDays(todayKw(), 30));
  const list = useLoad(() => api<{ data: Trip[] }>(`/tours/trips?from=${from}&to=${to}`).then((r) => r.data), [from, to]);
  const [add, setAdd] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="من تاريخ" /></label>
        <label className="field">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="إلى تاريخ" /></label>
        {can(me, 'tasks:assign') && <button onClick={() => setAdd(true)}>رحلة جديدة</button>}
        <button className="secondary" onClick={() => void list.reload()}>تحديث</button>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا رحلات في هذه الفترة</Empty> : (
        <div className="tbl-wrap"><table data-testid="trips"><thead><tr><th>الرحلة</th><th>العميل والمجموعة</th><th>من ← إلى</th><th>الانطلاق</th><th>العودة</th><th>الركاب / المقاعد</th><th>الحالة</th><th></th></tr></thead>
          <tbody>{list.data?.map((t) => (
            <tr key={t.id}><td><span className="num">{t.ref}</span>{t.cross_border && <> <Badge tone="warning">عبر الحدود</Badge></>}</td>
              <td>{t.customer_name}<div className="muted">{t.group_name}</div></td><td>{t.pickup} ← {t.destination}</td>
              <td className="num">{dt(t.start_at)}</td><td className="num">{dt(t.end_at)}</td>
              <td className="num">{t.pax} / {t.seats} <span className="muted">({t.buses.filter((b) => !['canceled', 'failed'].includes(b.status)).length} حافلة)</span></td>
              <td><Tone map={TR_STATE} value={t.state} /></td>
              <td><button className="small" onClick={() => setOpen(t.id)}>فتح</button></td></tr>
          ))}</tbody></table></div>
      )}
      {add && <TripForm onClose={() => setAdd(false)} onDone={(id) => { setAdd(false); setOpen(id); void list.reload(); }} />}
      {open && <TripModal id={open} onClose={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function TripForm({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const tomorrow = new Date(Date.now() + 86_400_000);
  const { f, bind } = useForm({ customer_id: '', group_name: '', contact_name: '', contact_phone: '', pax: '', start_at: kwLocal(tomorrow), end_at: kwLocal(new Date(tomorrow.getTime() + 10 * 3_600_000)),
    pickup: '', destination: '', itinerary: '', cross_border: '', price: '', deposit: '', notes: '' });
  return (
    <Modal title="رحلة جديدة" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const itinerary = f.itinerary.split('\n').map((l) => l.trim()).filter(Boolean).map((place) => ({ place }));
        const t = await api<Trip>('/tours/trips', { method: 'POST', body: {
          legal_entity_id: me.legal_entities[0]?.id, customer_id: f.customer_id, group_name: f.group_name, pax: Number(f.pax), start_at: kwIso(f.start_at), end_at: kwIso(f.end_at),
          pickup: f.pickup, destination: f.destination, itinerary, cross_border: f.cross_border === 'yes', ...clean({ contact_name: f.contact_name, contact_phone: f.contact_phone, price: f.price, deposit: f.deposit, notes: f.notes }),
        } });
        onDone(t.id);
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field">اسم المجموعة<input {...bind('group_name')} required maxLength={120} placeholder="عمرة رجب، رحلة مدرسية…" /></label>
          <label className="field">عدد الركاب<input {...bind('pax')} required type="number" min={1} max={2000} className="num" style={{ width: 90 }} /></label>
        </div>
        <div className="row">
          <label className="field">المسؤول عن المجموعة<input {...bind('contact_name')} maxLength={120} /></label>
          <label className="field">جواله<input {...bind('contact_phone')} className="num" dir="ltr" placeholder="+965…" /></label>
        </div>
        <div className="row">
          <label className="field">الانطلاق<input {...bind('start_at')} type="datetime-local" required /></label>
          <label className="field">العودة<input {...bind('end_at')} type="datetime-local" required /></label>
          <label className="field">عبر الحدود<select {...bind('cross_border')}><option value="">لا</option><option value="yes">نعم (يلزم كشف الركاب)</option></select></label>
        </div>
        <div className="row">
          <label className="field">نقطة التجمع<input {...bind('pickup')} required maxLength={200} /></label>
          <label className="field">الوجهة<input {...bind('destination')} required maxLength={200} /></label>
        </div>
        <label className="field">البرنامج (محطة في كل سطر)<textarea {...bind('itinerary')} rows={3} /></label>
        <div className="row">
          <label className="field">السعر (د.ك)<input {...bind('price')} inputMode="decimal" className="num" style={{ width: 110 }} /></label>
          <label className="field">العربون (د.ك)<input {...bind('deposit')} inputMode="decimal" className="num" style={{ width: 110 }} /></label>
        </div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        <button disabled={act.busy}>حفظ الرحلة</button>
      </form>
    </Modal>
  );
}

/** One passenger per line: name, ID or passport, nationality, phone, bus number (only the name is required). */
function parseManifest(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, id_no, nationality, phone, bus] = l.split(/[,،\t]/).map((x) => x.trim());
    return { name, ...clean({ id_no, nationality, phone }), ...(bus && Number(bus) ? { bus_seq: Number(bus) } : {}) };
  });
}

function TripModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const t = useLoad(() => api<Trip>(`/tours/trips/${id}`), [id]);
  const d = t.data;
  const open = !!d && ['planned', 'ready'].includes(d.state);
  const cand = useLoad(() => open ? api<{ buses: { asset_id: string; plate_no: string; seats: number | null }[]; drivers: { id: string; display_name: string }[]; seats_needed: number }>(`/tours/trips/${id}/candidates`) : Promise.resolve(null), [d?.state, d?.buses.length]);
  const man = useLoad(() => api<{ data: { name: string; id_no: string | null; nationality: string | null; phone: string | null; bus_seq: number | null }[] }>(`/tours/trips/${id}/manifest`).then((r) => r.data), [id]);
  const act = useAction();
  const { f, bind } = useForm({ asset_id: '', driver_worker_id: '', seats: '', manifest: '', reason: '' });
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/tours/trips/${id}/${path}`, { method: 'POST', body }); await t.reload(); await man.reload(); });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={d ? `رحلة ${d.ref}` : 'الرحلة'} onClose={onClose}>
      <ErrorBox error={t.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={TR_STATE} value={d.state} /> <b>{d.group_name}</b> · {d.customer_name} · {d.pax} راكب{d.cross_border && <> · <Badge tone="warning">عبر الحدود</Badge></>}</p>
        <p>من <b>{d.pickup}</b> إلى <b>{d.destination}</b> · <span className="num">{dt(d.start_at)}</span> ← <span className="num">{dt(d.end_at)}</span>
          {d.contact_name && <> · المسؤول {d.contact_name} <span className="num">{d.contact_phone}</span></>}</p>
        {d.itinerary.length > 0 && <p className="muted">البرنامج: {d.itinerary.map((s) => `${s.place}${s.at ? ` (${dt(s.at)})` : ''}`).join(' ← ')}</p>}
        <p data-testid="trip-money">السعر <span className="num">{d.price ?? '—'}</span> · العربون <span className="num">{d.deposit ?? '—'}</span>{d.km > 0 && <> · <span className="num">{d.km}</span> كم</>}</p>
        {d.canceled_at && <p className="muted">أُلغيت: {d.cancel_reason}</p>}

        <h3>الحافلات · <span className="num">{d.seats}</span> مقعد لـ <span className="num">{d.pax}</span> راكب</h3>
        {d.buses.length === 0 ? <Empty>لا حافلات بعد</Empty> : (
          <div className="tbl-wrap"><table data-testid="trip-buses"><thead><tr><th>#</th><th>الحافلة</th><th>السائق</th><th>المقاعد</th><th>صعد</th><th>عاد</th><th>العداد</th><th>الحالة</th><th></th></tr></thead>
            <tbody>{d.buses.map((b) => (
              <tr key={b.task_id}><td className="num">{b.seq}</td><td className="num">{b.plate_no}</td><td>{b.driver_name ?? '—'}</td><td className="num">{b.seats ?? '؟'}</td>
                <td className="num">{b.boarded ?? '—'}</td>
                <td className="num">{b.returned ?? '—'}{b.return_note && <div className="muted">{b.return_note}</div>}</td>
                <td className="num">{b.odometer_out ?? '—'} ← {b.odometer_in ?? '—'}</td>
                <td><Tone map={TR_BUS} value={b.status} />{b.fail_reason && <div className="muted">{TR_FAIL[b.fail_reason] ?? b.fail_reason}</div>}</td>
                <td>{w && ['assigned', 'ready', 'failed'].includes(b.status) && <button className="small secondary" disabled={act.busy} onClick={() => void post(`buses/${b.task_id}/release`, {})}>إلغاء الحافلة</button>}</td></tr>
            ))}</tbody></table></div>
        )}
        {w && open && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('buses', { asset_id: f.asset_id, driver_worker_id: f.driver_worker_id, ...(f.seats ? { seats: Number(f.seats) } : {}) }); }}>
          <label className="field">الحافلة<select {...bind('asset_id')} required><option value="">—</option>{cand.data?.buses.map((b) => <option key={b.asset_id} value={b.asset_id}>{b.plate_no} · {b.seats ?? '؟'} مقعد</option>)}</select></label>
          <label className="field">السائق<select {...bind('driver_worker_id')} required><option value="">—</option>{cand.data?.drivers.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
          <label className="field">المقاعد (إن لم تُسجّل)<input {...bind('seats')} type="number" min={1} max={120} className="num" style={{ width: 80 }} /></label>
          <button disabled={act.busy}>إضافة حافلة</button>
          {cand.data && cand.data.seats_needed > 0 && <Badge tone="warning">ينقص {cand.data.seats_needed} مقعد</Badge>}
          {cand.data && cand.data.seats_needed > 0 && cand.data.buses.length === 0 && <Badge tone="warning">لا حافلة متاحة طوال الرحلة</Badge>}
        </form>}

        <h3>كشف الركاب · <span className="num">{d.listed}</span> من <span className="num">{d.pax}</span></h3>
        {man.data && man.data.length > 0 && <div className="tbl-wrap"><table data-testid="manifest"><thead><tr><th>الاسم</th><th>الهوية / الجواز</th><th>الجنسية</th><th>الهاتف</th><th>الحافلة</th></tr></thead>
          <tbody>{man.data.map((p, i) => <tr key={i}><td>{p.name}</td><td className="num">{p.id_no ?? '—'}</td><td>{p.nationality ?? '—'}</td><td className="num">{p.phone ?? '—'}</td><td className="num">{p.bus_seq ?? '—'}</td></tr>)}</tbody></table></div>}
        {w && !['canceled', 'back'].includes(d.state) && <form className="stack" onSubmit={(e) => { e.preventDefault(); void post('manifest', { passengers: parseManifest(f.manifest) }); }}>
          <label className="field">استبدال الكشف: راكب في كل سطر (الاسم، الهوية أو الجواز، الجنسية، الهاتف، رقم الحافلة){d.cross_border ? ' · الهوية إلزامية عبر الحدود' : ''}
            <textarea {...bind('manifest')} rows={4} required aria-label="كشف الركاب" /></label>
          <button className="secondary" disabled={act.busy}>حفظ الكشف</button>
        </form>}

        {w && open && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب إلغاء الرحلة" />
          <button className="danger" disabled={act.busy}>إلغاء الرحلة</button>
        </form>}
      </div>}
    </Modal>
  );
}

function ExceptionsView() {
  type X = { short_seats: Trip[]; manifest_missing: Trip[]; late_start: Bus[]; left_behind: Bus[]; not_back: Bus[] };
  const x = useLoad(() => api<X>('/tours/exceptions'));
  const d = x.data;
  const trips = (id: string, rows: Trip[], extra: (t: Trip) => string) => rows.length === 0 ? <Empty>لا يوجد</Empty> : (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th>الرحلة</th><th>العميل والمجموعة</th><th>الانطلاق</th><th>التفاصيل</th></tr></thead>
      <tbody>{rows.map((t) => <tr key={t.id}><td className="num">{t.ref}</td><td>{t.customer_name}<div className="muted">{t.group_name}</div></td><td className="num">{dt(t.start_at)}</td><td>{extra(t)}</td></tr>)}</tbody></table></div>
  );
  const buses = (id: string, rows: Bus[]) => rows.length === 0 ? <Empty>لا يوجد</Empty> : (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th>الرحلة</th><th>المجموعة</th><th>الحافلة</th><th>السائق</th><th>صعد / عاد</th><th>ملاحظة</th></tr></thead>
      <tbody>{rows.map((b) => <tr key={b.task_id}><td className="num">{b.trip_ref}</td><td>{b.group_name}</td><td className="num">{b.seq} · {b.plate_no}</td><td>{b.driver_name ?? '—'}</td>
        <td className="num">{b.boarded ?? '—'} / {b.returned ?? '—'}</td><td>{b.return_note ?? ''}</td></tr>)}</tbody></table></div>
  );
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="عادوا بعدد أقل" value={d.left_behind.length} tone={d.left_behind.length ? 'danger' : undefined} />
          <Kpi label="لم تعد بعد موعد العودة" value={d.not_back.length} tone={d.not_back.length ? 'danger' : undefined} />
          <Kpi label="مقاعد ناقصة قريبًا" value={d.short_seats.length} tone={d.short_seats.length ? 'warning' : undefined} />
          <Kpi label="كشف ركاب ناقص (حدود)" value={d.manifest_missing.length} tone={d.manifest_missing.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>عادت الحافلة بركاب أقل ممن صعدوا</h2>{buses('ex-left', d.left_behind)}</section>
        <section className="card"><h2>لم تسجّل العودة بعد موعد نهاية الرحلة</h2>{buses('ex-notback', d.not_back)}</section>
        <section className="card"><h2>لم تنطلق بعد 15 دقيقة من الموعد [تخمين]</h2>{buses('ex-late', d.late_start)}</section>
        <section className="card"><h2>تبدأ خلال 3 أيام والمقاعد أقل من الركاب [تخمين]</h2>{trips('ex-seats', d.short_seats, (t) => `${t.seats} مقعد لـ ${t.pax} راكب`)}</section>
        <section className="card"><h2>رحلات حدود تبدأ خلال 3 أيام وكشف الركاب ناقص</h2>{trips('ex-manifest', d.manifest_missing, (t) => `${t.listed} من ${t.pax} في الكشف`)}</section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { trips: number; pax: number; buses: number; bus_days: number; km: number; amount: string; deposits: string; no_price: number };
  type R = { totals: Sum & { canceled: number; cross_border: number }; customers: (Sum & { customer_name: string })[] };
  const r = useLoad(() => api<R>(`/tours/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="رحلات" value={x.trips} />
          <Kpi label="ركاب" value={x.pax} />
          <Kpi label="أيام الحافلات" value={x.bus_days} />
          <Kpi label="المبلغ (د.ك)" value={x.amount} />
        </div>
        <p className="muted">ملغاة {x.canceled} · عبر الحدود {x.cross_border} · {x.buses} حافلة · <span className="num">{x.km}</span> كم · عربون {x.deposits}{x.no_price ? ` · بلا سعر ${x.no_price}` : ''}</p>
        <section className="card"><h2>حسب العميل: أساس الفاتورة</h2>
          {r.data!.customers.length === 0 ? <Empty>لا رحلات</Empty> : <div className="tbl-wrap"><table data-testid="tr-customers"><thead><tr><th>العميل</th><th>رحلات</th><th>ركاب</th><th>حافلات</th><th>أيام الحافلات</th><th>كم</th><th>المبلغ</th><th>العربون</th></tr></thead>
            <tbody>{r.data!.customers.map((c) => <tr key={c.customer_name}><td>{c.customer_name}</td><td className="num">{c.trips}</td><td className="num">{c.pax}</td><td className="num">{c.buses}</td><td className="num">{c.bus_days}</td>
              <td className="num">{c.km}</td><td className="num"><b>{c.amount}</b></td><td className="num">{c.deposits}</td></tr>)}</tbody></table></div>}
          <p className="muted" style={{ marginBottom: 0 }}>الأسعار يدخلها المكتب لكل رحلة؛ الفوترة من صفحة الفواتير [تحقق محلي].</p>
        </section>
      </>}
    </div>
  );
}
