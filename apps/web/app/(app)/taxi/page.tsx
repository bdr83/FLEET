'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, todayKw, TX_CLASS, TX_FAIL, TX_PAYMENT, TX_STATE } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useForm, useLoad } from '@/components/ui';

type Place = Record<string, string | undefined>;
interface Booking {
  id: string; ref: string; legal_entity_id: string; customer_id: string | null; customer_name: string | null; passenger_name: string; passenger_phone: string; pickup: Place; dropoff: Place | null;
  pickup_at: string; hold_min: number; class: string; pax: number; flight_no: string | null; notes: string | null; fixed_fare: string | null; task_id: string | null; attempts: number;
  arrived_at: string | null; picked_at: string | null; dropped_at: string | null; km: number | null; wait_min: number | null; fare: string | null; payment: string | null;
  canceled_at: string | null; cancel_reason: string | null; driver_name: string | null; plate_no: string | null; state: string; fail_reason: string | null;
}
type Tab = 'day' | 'cars' | 'exceptions' | 'report';

const place = (p: Place | null) => !p ? '—' : [p.name, p.area, p.block ? `ق ${p.block}` : null, p.street].filter(Boolean).join('، ');
const hhmm = (iso: string | null) => iso ? new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString().slice(11, 16) : '—';
const kwLocal = (d = new Date()) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);

/** Taxi and limousine (sector 12): the day's bookings with dispatch, cars and tariffs, exceptions, and the report. */
export default function TaxiPage() {
  const [tab, setTab] = useState<Tab>('day');
  return (
    <div className="page stack">
      <div className="page-head"><h1>التاكسي والليموزين</h1></div>
      <Tabs tabs={[['day', 'حجوزات اليوم'], ['cars', 'السيارات والتعرفة'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'day' && <DayView />}
      {tab === 'cars' && <CarsView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function DayView() {
  const me = useMe();
  const [day, setDay] = useState(todayKw());
  const list = useLoad(() => api<{ data: Booking[] }>(`/taxi/bookings?date=${day}`).then((r) => r.data), [day]);
  const [add, setAdd] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card stack">
      <div className="row">
        <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="يوم الحجوزات" /></label>
        {can(me, 'tasks:assign') && <button onClick={() => setAdd(true)}>حجز جديد</button>}
        <button className="secondary" onClick={() => void list.reload()}>تحديث</button>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا حجوزات لهذا اليوم</Empty> : (
        <div className="tbl-wrap"><table data-testid="bookings"><thead><tr><th>الموعد</th><th>الحجز</th><th>الراكب</th><th>من ← إلى</th><th>الفئة</th><th>السائق والسيارة</th><th>الحالة</th><th>الأجرة</th><th></th></tr></thead>
          <tbody>{list.data?.map((b) => (
            <tr key={b.id}><td className="num">{hhmm(b.pickup_at)}</td>
              <td><span className="num">{b.ref}</span>{b.flight_no && <> <Badge>✈ {b.flight_no}</Badge></>}{b.customer_name && <div className="muted">{b.customer_name}</div>}</td>
              <td>{b.passenger_name} <span className="num muted">{b.passenger_phone}</span></td><td>{place(b.pickup)} ← {place(b.dropoff)}</td><td>{TX_CLASS[b.class]}</td>
              <td>{b.driver_name ? <>{b.driver_name} · <span className="num">{b.plate_no}</span></> : '—'}</td>
              <td><Tone map={TX_STATE} value={b.state} />{b.fail_reason && <div className="muted">{TX_FAIL[b.fail_reason] ?? b.fail_reason}</div>}</td>
              <td className="num">{b.fare ?? b.fixed_fare ?? '—'}{b.payment && <div className="muted">{TX_PAYMENT[b.payment]}</div>}</td>
              <td><button className="small" onClick={() => setOpen(b.id)}>فتح</button></td></tr>
          ))}</tbody></table></div>
      )}
      {add && <BookingForm onClose={() => setAdd(false)} onDone={(id) => { setAdd(false); setOpen(id); void list.reload(); }} />}
      {open && <BookingModal id={open} onClose={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function BookingForm({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe();
  const act = useAction();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const { f, bind } = useForm({ passenger_name: '', passenger_phone: '', customer_id: '', p_name: '', p_area: '', p_block: '', p_street: '', d_name: '', d_area: '',
    when: 'now', pickup_at: kwLocal(new Date(Date.now() + 3_600_000)), class: 'sedan', pax: '1', flight_no: '', fixed_fare: '', notes: '' });
  return (
    <Modal title="حجز جديد" onClose={onClose}>
      <ErrorBox error={act.error} />
      <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const b = await api<Booking>('/taxi/bookings', { method: 'POST', body: {
          legal_entity_id: me.legal_entities[0]?.id, passenger_name: f.passenger_name, passenger_phone: f.passenger_phone, customer_id: f.customer_id || null,
          pickup: clean({ name: f.p_name, area: f.p_area, block: f.p_block, street: f.p_street }), ...(f.d_name || f.d_area ? { dropoff: clean({ name: f.d_name, area: f.d_area }) } : {}),
          ...(f.when === 'later' ? { pickup_at: kwIso(f.pickup_at) } : {}), class: f.class, pax: Number(f.pax) || 1, ...clean({ flight_no: f.flight_no, fixed_fare: f.fixed_fare, notes: f.notes }),
        } });
        onDone(b.id);
      }); }}>
        <div className="row">
          <label className="field">اسم الراكب<input {...bind('passenger_name')} required maxLength={120} /></label>
          <label className="field">جواله<input {...bind('passenger_phone')} required className="num" dir="ltr" placeholder="+965…" /></label>
          <label className="field">حساب شركة<select {...bind('customer_id')}><option value="">بدون (نقدي)</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <fieldset className="row" aria-label="مكان الالتقاط">
          <label className="field">الالتقاط: المكان<input {...bind('p_name')} maxLength={120} placeholder="مطار الكويت T4، فندق…" /></label>
          <label className="field">المنطقة<input {...bind('p_area')} maxLength={80} /></label>
          <label className="field">القطعة<input {...bind('p_block')} maxLength={10} style={{ width: 70 }} /></label>
          <label className="field">الشارع<input {...bind('p_street')} maxLength={80} /></label>
        </fieldset>
        <div className="row">
          <label className="field">الوجهة: المكان<input {...bind('d_name')} maxLength={120} /></label>
          <label className="field">المنطقة<input {...bind('d_area')} maxLength={80} /></label>
        </div>
        <div className="row">
          <label className="field">الموعد<select {...bind('when')}><option value="now">الآن</option><option value="later">لاحقًا</option></select></label>
          {f.when === 'later' && <label className="field">وقت الالتقاط<input {...bind('pickup_at')} type="datetime-local" required /></label>}
          <label className="field">الفئة<select {...bind('class')}>{Object.entries(TX_CLASS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">الركاب<input {...bind('pax')} type="number" min={1} max={14} className="num" style={{ width: 70 }} /></label>
          <label className="field">رقم الرحلة<input {...bind('flight_no')} maxLength={8} className="num" style={{ width: 100 }} placeholder="KU118" /></label>
          <label className="field">أجرة ثابتة (د.ك)<input {...bind('fixed_fare')} inputMode="decimal" className="num" style={{ width: 100 }} /></label>
        </div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={500} /></label>
        <button disabled={act.busy}>حفظ الحجز</button>
      </form>
    </Modal>
  );
}

function BookingModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const b = useLoad(() => api<Booking>(`/taxi/bookings/${id}`), [id]);
  const d = b.data;
  const cand = useLoad(() => d && ['new', 'failed'].includes(d.state) ? api<{ cars: { asset_id: string; plate_no: string; class: string }[]; drivers: { id: string; display_name: string }[] }>(`/taxi/bookings/${id}/candidates`) : Promise.resolve(null), [d?.state]);
  const act = useAction();
  const { f, bind } = useForm({ asset_id: '', driver_worker_id: '', km: '', wait_min: '', payment: 'cash', fare: '', reason: '' });
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/taxi/bookings/${id}/${path}`, { method: 'POST', body }); await b.reload(); });
  const w = can(me, 'tasks:assign');
  return (
    <Modal title={d ? `حجز ${d.ref}` : 'الحجز'} onClose={onClose}>
      <ErrorBox error={b.error ?? act.error} />
      {d && <div className="stack">
        <p><Tone map={TX_STATE} value={d.state} /> {d.passenger_name} <span className="num">{d.passenger_phone}</span> · {TX_CLASS[d.class]} · {d.pax} راكب{d.flight_no ? ` · رحلة ${d.flight_no}` : ''}{d.customer_name ? ` · حساب ${d.customer_name}` : ''}</p>
        <p>من <b>{place(d.pickup)}</b> الساعة <span className="num">{hhmm(d.pickup_at)}</span> إلى <b>{place(d.dropoff)}</b>{d.fixed_fare && <> · أجرة ثابتة <span className="num">{d.fixed_fare}</span></>}</p>
        {d.driver_name && <p data-testid="booking-driver">السائق {d.driver_name} · <span className="num">{d.plate_no}</span> · وصل {hhmm(d.arrived_at)} · ركب {hhmm(d.picked_at)} · نزل {hhmm(d.dropped_at)}</p>}
        {d.state === 'done' && <p data-testid="booking-fare">{d.km !== null && <><span className="num">{d.km}</span> كم · </>}انتظار <span className="num">{d.wait_min ?? 0}</span> د · الأجرة <b className="num">{d.fare ?? 'بلا أجرة'}</b> · {d.payment && TX_PAYMENT[d.payment]}</p>}
        {w && ['new', 'failed'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('assign', { asset_id: f.asset_id, driver_worker_id: f.driver_worker_id }); }}>
          <label className="field">السيارة<select {...bind('asset_id')} required><option value="">—</option>{cand.data?.cars.map((c) => <option key={c.asset_id} value={c.asset_id}>{c.plate_no} · {TX_CLASS[c.class]}</option>)}</select></label>
          <label className="field">السائق<select {...bind('driver_worker_id')} required><option value="">—</option>{cand.data?.drivers.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label>
          <button disabled={act.busy}>إسناد</button>
          {cand.data && cand.data.cars.length === 0 && <Badge tone="warning">لا سيارة متاحة من الفئة في هذا الوقت</Badge>}
        </form>}
        {w && ['assigned', 'on_way', 'waiting', 'on_trip'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('record', {
          payment: f.payment, ...(f.km ? { km: Number(f.km) } : {}), ...(f.wait_min ? { wait_min: Number(f.wait_min) } : {}), ...clean({ fare: f.fare }) }); }}>
          <label className="field">كم<input {...bind('km')} inputMode="decimal" className="num" style={{ width: 80 }} /></label>
          <label className="field">انتظار (د)<input {...bind('wait_min')} type="number" min={0} className="num" style={{ width: 80 }} /></label>
          <label className="field">الدفع<select {...bind('payment')}>{Object.entries(TX_PAYMENT).filter(([k]) => k !== 'account' || d.customer_id).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">أجرة (اختياري)<input {...bind('fare')} inputMode="decimal" className="num" style={{ width: 90 }} /></label>
          <button className="secondary" disabled={act.busy}>تسجيل المشوار من المكتب</button>
        </form>}
        {can(me, 'billing:write') && d.state === 'done' && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('fare', { fare: f.fare }); }}>
          <label className="field">تصحيح الأجرة<input {...bind('fare')} required inputMode="decimal" className="num" style={{ width: 100 }} aria-label="الأجرة الجديدة" /></label>
          <button className="secondary" disabled={act.busy}>حفظ الأجرة</button>
        </form>}
        {w && ['new', 'assigned', 'on_way', 'failed'].includes(d.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب إلغاء الحجز" />
          <button className="danger" disabled={act.busy}>إلغاء الحجز</button>
        </form>}
      </div>}
    </Modal>
  );
}

function CarsView() {
  const me = useMe();
  const cars = useLoad(() => api<{ data: { asset_id: string; plate_no: string; asset_type: string; status: string; class: string | null }[] }>('/taxi/cars').then((r) => r.data));
  const tariffs = useLoad(() => api<{ data: { class: string; base: string; per_km: string; per_wait_min: string; min_fare: string }[] }>('/taxi/tariffs').then((r) => r.data));
  const act = useAction();
  const { f, bind } = useForm({ class: 'sedan', base: '', per_km: '', per_wait_min: '', min_fare: '' });
  return (
    <div className="stack">
      <section className="card stack"><h2>سيارات الأسطول وفئاتها</h2>
        <ErrorBox error={cars.error ?? act.error} />
        {cars.data?.length === 0 ? <Empty>أضف السيارات من صفحة المركبات أولًا</Empty> : (
          <div className="tbl-wrap"><table data-testid="tx-cars"><thead><tr><th>اللوحة</th><th>الحالة</th><th>الفئة</th></tr></thead>
            <tbody>{cars.data?.map((c) => (
              <tr key={c.asset_id}><td className="num">{c.plate_no}</td><td>{c.status}</td>
                <td>{can(me, 'fleet:write') ? <select value={c.class ?? ''} aria-label={`فئة ${c.plate_no}`} disabled={act.busy} onChange={(e) => void act.run(async () => {
                  await api(`/taxi/cars/${c.asset_id}`, { method: 'PUT', body: { class: e.target.value } }); await cars.reload();
                })}><option value="" disabled>ليست في أسطول التاكسي</option>{Object.entries(TX_CLASS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : (c.class ? TX_CLASS[c.class] : '—')}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>
      <section className="card stack"><h2>التعرفة لكل فئة</h2>
        <ErrorBox error={tariffs.error} />
        {tariffs.data?.length === 0 ? <Empty>لا تعرفة بعد: الحجوزات بلا أجرة ثابتة تحتاج تعرفة لفئتها</Empty> : (
          <div className="tbl-wrap"><table data-testid="tx-tariffs"><thead><tr><th>الفئة</th><th>فتحة العداد</th><th>لكل كم</th><th>لكل دقيقة انتظار</th><th>الحد الأدنى</th></tr></thead>
            <tbody>{tariffs.data?.map((t) => <tr key={t.class}><td>{TX_CLASS[t.class]}</td><td className="num">{t.base}</td><td className="num">{t.per_km}</td><td className="num">{t.per_wait_min}</td><td className="num">{t.min_fare}</td></tr>)}</tbody></table></div>
        )}
        {can(me, 'billing:write') && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
          await api('/taxi/tariffs', { method: 'PUT', body: { legal_entity_id: me.legal_entities[0]?.id, class: f.class, base: f.base, per_km: f.per_km, ...clean({ per_wait_min: f.per_wait_min, min_fare: f.min_fare }) } });
          await tariffs.reload();
        }); }}>
          <label className="field">الفئة<select {...bind('class')}>{Object.entries(TX_CLASS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">فتحة العداد<input {...bind('base')} required inputMode="decimal" className="num" style={{ width: 90 }} /></label>
          <label className="field">لكل كم<input {...bind('per_km')} required inputMode="decimal" className="num" style={{ width: 90 }} /></label>
          <label className="field">لكل دقيقة انتظار<input {...bind('per_wait_min')} inputMode="decimal" className="num" style={{ width: 90 }} /></label>
          <label className="field">الحد الأدنى<input {...bind('min_fare')} inputMode="decimal" className="num" style={{ width: 90 }} /></label>
          <button disabled={act.busy}>حفظ التعرفة</button>
        </form>}
        <p className="muted" style={{ margin: 0 }}>الانتظار يُحسب بعد 5 دقائق مجانية من وصول السائق أو موعد الالتقاط [تخمين]. الأسعار يدخلها المكتب.</p>
      </section>
    </div>
  );
}

function ExceptionsView() {
  const x = useLoad(() => api<{ unassigned: Booking[]; late: Booking[]; failed: Booking[]; no_fare: Booking[] }>('/taxi/exceptions'));
  const d = x.data;
  const table = (id: string, rows: Booking[]) => rows.length === 0 ? <Empty>لا يوجد</Empty> : (
    <div className="tbl-wrap"><table data-testid={id}><thead><tr><th>الحجز</th><th>الموعد</th><th>الراكب</th><th>الالتقاط</th><th>السائق</th><th>الحالة</th></tr></thead>
      <tbody>{rows.map((b) => <tr key={b.id}><td className="num">{b.ref}</td><td className="num">{dt(b.pickup_at)}</td><td>{b.passenger_name} <span className="num muted">{b.passenger_phone}</span></td>
        <td>{place(b.pickup)}</td><td>{b.driver_name ?? '—'}</td><td><Tone map={TX_STATE} value={b.state} />{b.fail_reason && <span className="muted"> {TX_FAIL[b.fail_reason]}</span>}</td></tr>)}</tbody></table></div>
  );
  return (
    <div className="stack">
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="بلا سيارة قبل موعدها بنصف ساعة" value={d.unassigned.length} tone={d.unassigned.length ? 'danger' : undefined} />
          <Kpi label="سائق متأخر عن الراكب" value={d.late.length} tone={d.late.length ? 'danger' : undefined} />
          <Kpi label="تعذّرت (آخر 24 ساعة)" value={d.failed.length} />
          <Kpi label="مشاوير بلا أجرة" value={d.no_fare.length} tone={d.no_fare.length ? 'warning' : undefined} />
        </div>
        <section className="card"><h2>حجوزات بلا سيارة وموعدها خلال 30 دقيقة [تخمين]</h2>{table('ex-unassigned', d.unassigned)}</section>
        <section className="card"><h2>لم يصل السائق بعد 10 دقائق من الموعد [تخمين]</h2>{table('ex-late', d.late)}</section>
        <section className="card"><h2>تعذّرت: أعد إسنادها أو ألغها</h2>{table('ex-failed', d.failed)}</section>
        <section className="card"><h2>مشاوير انتهت بلا أجرة (لا تعرفة لفئتها)</h2>{table('ex-nofare', d.no_fare)}</section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type R = {
    totals: { bookings: number; done: number; canceled: number; no_shows: number; failed: number; km: number; fare: string; cash: string; card: string; account: string; no_fare: number };
    drivers: { driver_name: string; rides: number; km: number; fare: string; cash: string; card: string }[]; accounts: { customer_name: string; rides: number; account: string; fare: string }[];
    classes: { class: string; rides: number; fare: string }[];
  };
  const r = useLoad(() => api<R>(`/taxi/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="مشاوير منتهية" value={`${x.done} / ${x.bookings}`} />
          <Kpi label="الأجرة (د.ك)" value={x.fare} />
          <Kpi label="نقد مع السائقين" value={x.cash} />
          <Kpi label="على حسابات الشركات" value={x.account} />
        </div>
        <p className="muted">ملغاة {x.canceled} · لم يحضر الراكب {x.no_shows} · تعذّرت {x.failed} · <span className="num">{x.km}</span> كم · بطاقة {x.card}{x.no_fare ? ` · بلا أجرة ${x.no_fare}` : ''}</p>
        <section className="card"><h2>السائقون: النقد المطلوب تسليمه</h2>
          {r.data!.drivers.length === 0 ? <Empty>لا مشاوير</Empty> : <div className="tbl-wrap"><table data-testid="tx-drivers"><thead><tr><th>السائق</th><th>المشاوير</th><th>كم</th><th>الأجرة</th><th>نقد</th><th>بطاقة</th></tr></thead>
            <tbody>{r.data!.drivers.map((d) => <tr key={d.driver_name}><td>{d.driver_name}</td><td className="num">{d.rides}</td><td className="num">{d.km}</td><td className="num">{d.fare}</td><td className="num"><b>{d.cash}</b></td><td className="num">{d.card}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>حسابات الشركات: أساس الفاتورة الشهرية</h2>
          {r.data!.accounts.length === 0 ? <Empty>لا مشاوير على حسابات</Empty> : <div className="tbl-wrap"><table data-testid="tx-accounts"><thead><tr><th>الشركة</th><th>المشاوير</th><th>على الحساب</th><th>كل الأجرة</th></tr></thead>
            <tbody>{r.data!.accounts.map((a) => <tr key={a.customer_name}><td>{a.customer_name}</td><td className="num">{a.rides}</td><td className="num"><b>{a.account}</b></td><td className="num">{a.fare}</td></tr>)}</tbody></table></div>}
          <p className="muted" style={{ marginBottom: 0 }}>الفوترة من صفحة الفواتير حسب عقد كل شركة [تحقق محلي]. آخر تحديث {dt(new Date().toISOString())}.</p>
        </section>
      </>}
    </div>
  );
}
