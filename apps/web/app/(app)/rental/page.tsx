'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ASSET_STATUS, ASSET_TYPE, dt, FINE_STATUS, fuelLine, km, money, RENTAL_STATE, RENTAL_TYPES, RENTAL_UNIT, TASK_STATUS, todayKw } from '@/lib/format';
import { kwIso } from '@/components/internal';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Kpi, Modal, Tabs, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

interface Driver { name: string; phone: string | null; civil_id: string | null; licence_no: string; licence_expiry: string }
interface Agreement {
  id: string; ref: string; customer_id: string; customer_name: string; asset_id: string; plate_no: string; asset_type: string; make: string | null; model: string | null;
  drivers: Driver[]; renter_name: string; renter_phone: string | null; pickup_at: string; return_due: string; rate_unit: string; rate: string; km_per_day: number | null;
  extra_km_rate: string; fuel_rate: string; deposit: string; notes: string | null; state: string;
  out_at: string | null; out_odometer_km: number | null; out_fuel: number | null; out_damage: string | null; out_by: string | null;
  in_at: string | null; in_odometer_km: number | null; in_fuel: number | null; in_damage: string | null;
  days: number | null; rental_amount: string | null; extra_km: number | null; km_amount: string | null; fuel_amount: string | null; damage_amount: string; total: string | null; balance: string | null; fines_amount: string;
}
interface Move { task_id: string; rental_ref: string; kind: string; status: string; at: string; driver_name: string | null; address: Record<string, string> }
interface Fine { id: string; plate_no: string; occurred_at: string; amount: string; fine_no: string | null; description: string | null; agreement_id: string | null; rental_ref: string | null; renter_name: string | null; customer_name: string | null; status: string }
type Tab = 'agreements' | 'fleet' | 'fines' | 'exceptions' | 'report';

const kwLocal = (d = new Date()) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);
const car = (a: { asset_type: string; plate_no: string; make?: string | null; model?: string | null }) => <>{[a.make, a.model].filter(Boolean).join(' ') || ASSET_TYPE[a.asset_type] || a.asset_type} <span className="num">{a.plate_no}</span></>;

/** Car rental (sector 17): reservations and agreements with check-out and check-in, the cars, traffic fines, exceptions and the report. */
export default function RentalPage() {
  const [tab, setTab] = useState<Tab>('agreements');
  return (
    <div className="page stack">
      <div className="page-head"><h1>تأجير السيارات</h1></div>
      <Tabs tabs={[['agreements', 'الحجوزات والعقود'], ['fleet', 'السيارات'], ['fines', 'المخالفات'], ['exceptions', 'الاستثناءات'], ['report', 'التقرير']]} value={tab} onChange={setTab} />
      {tab === 'agreements' && <AgreementsView />}
      {tab === 'fleet' && <FleetView />}
      {tab === 'fines' && <FinesView />}
      {tab === 'exceptions' && <ExceptionsView />}
      {tab === 'report' && <ReportView />}
    </div>
  );
}

function AgreementsTable({ rows, onPick, testId }: { rows: Agreement[]; onPick?: (r: Agreement) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا يوجد</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>العقد</th><th>السيارة</th><th>المستأجر</th><th>الاستلام</th><th>الإرجاع</th><th>السعر</th><th>الحالة</th><th>الإجمالي</th><th></th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}><td className="num">{r.ref}</td><td>{car(r)}</td><td>{r.renter_name}{r.customer_name !== r.renter_name && <div className="muted">{r.customer_name}</div>}</td>
          <td className="num">{dt(r.out_at ?? r.pickup_at)}</td><td className="num">{dt(r.in_at ?? r.return_due)}</td>
          <td className="num">{money(r.rate)} {RENTAL_UNIT[r.rate_unit]}</td><td><Tone map={RENTAL_STATE} value={r.state} /></td>
          <td className="num">{r.total ? money(r.total) : '—'}</td>
          <td>{onPick && <button className="small" onClick={() => onPick(r)}>إدارة</button>}</td></tr>
      ))}</tbody></table></div>
  );
}

function AgreementsView() {
  const me = useMe();
  const [state, setState] = useState('');
  const list = useLoad(() => api<{ data: Agreement[] }>(`/rental/agreements${state ? `?state=${state}` : ''}`).then((r) => r.data), [state]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Agreement | null>(null);
  return (
    <section className="card stack">
      <ErrorBox error={list.error} />
      <div className="row">
        {can(me, 'tasks:assign') && <button onClick={() => setAdding(true)}>حجز جديد</button>}
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="الحالة" style={{ maxWidth: 200 }}>
          <option value="">كل الحالات</option>{Object.entries(RENTAL_STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <AgreementsTable rows={list.data ?? []} onPick={setOpen} testId="agreements" />
      {adding && <AgreementForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void list.reload(); }} />}
      {open && <AgreementModal id={open.id} onClose={() => { setOpen(null); void list.reload(); }} />}
    </section>
  );
}

function AgreementForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const act = useAction();
  const assets = useAssets();
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((x) => x.data.filter((c) => c.status === 'active')).catch(() => []));
  const now = kwLocal(), tomorrow = kwLocal(new Date(Date.now() + 86_400_000));
  const { f, bind } = useForm({
    customer_id: '', new_name: '', new_phone: '', asset_id: '', pickup_at: now, return_due: tomorrow, rate_unit: 'day', rate: '', km_per_day: '', extra_km_rate: '', fuel_rate: '', deposit: '',
    d_name: '', d_phone: '', d_civil: '', d_licence: '', d_expiry: '', d2_name: '', d2_licence: '', d2_expiry: '', notes: '',
  });
  const cars = (assets.data ?? []).filter((a) => RENTAL_TYPES.includes(a.asset_type) && !['out_of_service', 'retired'].includes(a.status));
  const [res, setRes] = useState<Agreement | null>(null);
  return (
    <Modal title="حجز سيارة" onClose={res ? onDone : onClose}>
      <ErrorBox error={act.error} />
      {res ? <div className="stack" data-testid="agreement-created">
        <p>أُنشئ العقد <b className="num">{res.ref}</b> وحُجزت السيارة <span className="num">{res.plate_no}</span> من {dt(res.pickup_at)} إلى {dt(res.return_due)}.</p>
        <button onClick={onDone}>تم</button>
      </div> : <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        const le = me.legal_entities[0]?.id;
        let customer = f.customer_id;
        if (customer === 'new') customer = (await api<{ id: string }>('/customers', { method: 'POST', body: { legal_entity_id: le, kind: 'individual', name: f.new_name || f.d_name, ...clean({ phone: f.new_phone || f.d_phone }) } })).id;
        const drivers = [{ name: f.d_name, licence_no: f.d_licence, licence_expiry: f.d_expiry, ...clean({ phone: f.d_phone, civil_id: f.d_civil }) },
          ...(f.d2_name ? [{ name: f.d2_name, licence_no: f.d2_licence, licence_expiry: f.d2_expiry }] : [])];
        setRes(await api<Agreement>('/rental/agreements', { method: 'POST', body: { legal_entity_id: le, customer_id: customer, asset_id: f.asset_id, drivers,
          pickup_at: kwIso(f.pickup_at), return_due: kwIso(f.return_due), rate_unit: f.rate_unit, rate: f.rate, ...(f.km_per_day ? { km_per_day: Number(f.km_per_day) } : {}),
          ...clean({ extra_km_rate: f.extra_km_rate, fuel_rate: f.fuel_rate, deposit: f.deposit, notes: f.notes }) } }));
      }); }}>
        <div className="row">
          <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option><option value="new">+ عميل جديد (فرد)</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          {f.customer_id === 'new' && <>
            <label className="field">اسم العميل<input {...bind('new_name')} maxLength={200} placeholder="اسم المستأجر إن تُرك فارغًا" /></label>
            <label className="field">هاتف العميل<input {...bind('new_phone')} maxLength={20} className="num" dir="ltr" /></label>
          </>}
          <label className="field">السيارة<select {...bind('asset_id')} required><option value="">اختر</option>{cars.map((a) => <option key={a.id} value={a.id}>{ASSET_TYPE[a.asset_type]} {a.plate_no}</option>)}</select></label>
        </div>
        <fieldset className="stack" style={{ gap: 6 }}><legend>المستأجر (السائق الأول)</legend>
          <div className="row">
            <label className="field">الاسم<input {...bind('d_name')} required maxLength={120} /></label>
            <label className="field">الهاتف<input {...bind('d_phone')} maxLength={20} className="num" dir="ltr" /></label>
            <label className="field">الرقم المدني<input {...bind('d_civil')} maxLength={20} className="num" dir="ltr" /></label>
          </div>
          <div className="row">
            <label className="field">رقم الرخصة<input {...bind('d_licence')} required maxLength={40} className="num" dir="ltr" /></label>
            <label className="field">انتهاء الرخصة<input {...bind('d_expiry')} type="date" required /></label>
          </div>
        </fieldset>
        <div className="row">
          <label className="field">سائق إضافي (اختياري)<input {...bind('d2_name')} maxLength={120} /></label>
          {f.d2_name && <>
            <label className="field">رخصته<input {...bind('d2_licence')} required maxLength={40} className="num" dir="ltr" /></label>
            <label className="field">انتهاؤها<input {...bind('d2_expiry')} type="date" required /></label>
          </>}
        </div>
        <div className="row">
          <label className="field">الاستلام<input {...bind('pickup_at')} type="datetime-local" required /></label>
          <label className="field">الإرجاع<input {...bind('return_due')} type="datetime-local" required /></label>
        </div>
        <div className="row">
          <label className="field">نوع السعر<select {...bind('rate_unit')}>{Object.entries(RENTAL_UNIT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">السعر (د.ك)<input {...bind('rate')} required inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 100 }} /></label>
          <label className="field">كم مسموح يوميًا<input {...bind('km_per_day')} type="number" min={1} className="num" style={{ width: 100 }} placeholder="مفتوح" /></label>
          <label className="field">سعر الكم الزائد<input {...bind('extra_km_rate')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 90 }} /></label>
          <label className="field">سعر ثُمن الوقود الناقص<input {...bind('fuel_rate')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 90 }} /></label>
          <label className="field">العربون<input {...bind('deposit')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 90 }} /></label>
        </div>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        <p className="muted">الأسعار من عندك. العربون يُسجّل فقط ويُخصم من الإجمالي عند الإرجاع. يجب أن تكون كل الرخص سارية حتى موعد الإرجاع.</p>
        <button disabled={act.busy}>حجز السيارة</button>
      </form>}
    </Modal>
  );
}

function AgreementModal({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const d = useLoad(() => api<Agreement & { moves: Move[]; fines: Fine[] }>(`/rental/agreements/${id}`), [id]);
  const workers = useLoad(() => api<{ data: { id: string; display_name: string }[] }>('/workers?status=active').then((x) => x.data));
  const act = useAction();
  const { f, bind } = useForm({ odometer_km: '', fuel: '8', damage: '', damage_amount: '', return_due: '', reason: '', kind: 'deliver', driver: '', area: '', block: '', street: '' });
  const x = d.data;
  const w = can(me, 'tasks:assign');
  const post = (path: string, body: Record<string, unknown>) => act.run(async () => { await api(`/rental/agreements/${id}/${path}`, { method: 'POST', body }); await d.reload(); });
  return (
    <Modal title={x ? `عقد ${x.ref}` : 'عقد'} onClose={onClose}>
      <ErrorBox error={d.error ?? act.error} />
      {x && <div className="stack">
        <div className="row"><Tone map={RENTAL_STATE} value={x.state} />{car(x)}</div>
        <dl className="dl">
          <dt>العميل</dt><dd>{x.customer_name}</dd>
          <dt>السائقون</dt><dd>{x.drivers.map((v) => <div key={v.licence_no}>{v.name} · رخصة <span className="num">{v.licence_no}</span> حتى <span className="num">{v.licence_expiry}</span></div>)}</dd>
          <dt>الفترة</dt><dd className="num">{dt(x.pickup_at)} ← {dt(x.return_due)}</dd>
          <dt>السعر</dt><dd>{money(x.rate)} {RENTAL_UNIT[x.rate_unit]} · {x.km_per_day ? `${x.km_per_day} كم يوميًا، الزائد ${money(x.extra_km_rate)}` : 'كيلومترات مفتوحة'} · العربون {money(x.deposit)}</dd>
          {x.out_at && <><dt>الاستلام</dt><dd className="num">{dt(x.out_at)} · {km(x.out_odometer_km)} · الوقود {fuelLine(x.out_fuel)}{x.out_by === 'driver' && <> <Badge>بالتوصيل</Badge></>}{x.out_damage && <div className="muted">{x.out_damage}</div>}</dd></>}
          {x.in_at && <><dt>الإرجاع</dt><dd className="num">{dt(x.in_at)} · {km(x.in_odometer_km)} · الوقود {fuelLine(x.in_fuel)}{x.in_damage && <div className="muted">{x.in_damage}</div>}</dd></>}
        </dl>
        {x.total && <section className="card" data-testid="charges">
          <h2>الرسوم</h2>
          <dl className="dl">
            <dt>{x.days} يوم</dt><dd className="num">{money(x.rental_amount)}</dd>
            <dt>كم زائد ({x.extra_km})</dt><dd className="num">{money(x.km_amount)}</dd>
            <dt>نقص الوقود</dt><dd className="num">{money(x.fuel_amount)}</dd>
            <dt>أضرار</dt><dd className="num">{money(x.damage_amount)}</dd>
            <dt><b>الإجمالي</b></dt><dd className="num"><b>{money(x.total)}</b></dd>
            <dt>بعد خصم العربون</dt><dd className="num">{Number(x.balance) < 0 ? `يُرد للعميل ${money(-Number(x.balance))}` : `على العميل ${money(x.balance)}`}</dd>
            {Number(x.fines_amount) > 0 && <><dt>مخالفات</dt><dd className="num">{money(x.fines_amount)}</dd></>}
          </dl>
        </section>}
        {w && x.state === 'reserved' && <form className="form" onSubmit={(e) => { e.preventDefault(); void post('checkout', { odometer_km: Number(f.odometer_km), fuel: Number(f.fuel), ...clean({ damage: f.damage }) }); }}>
          <h2>تسليم السيارة في الفرع</h2>
          <OdoFields bind={bind} />
          <button disabled={act.busy}>تسليم</button>
        </form>}
        {w && (x.state === 'out' || x.state === 'overdue') && <form className="form" onSubmit={(e) => { e.preventDefault(); void post('checkin', { odometer_km: Number(f.odometer_km), fuel: Number(f.fuel), ...clean({ damage: f.damage, damage_amount: f.damage_amount }) }); }}>
          <h2>استلام السيارة وإغلاق العقد</h2>
          <OdoFields bind={bind} />
          <label className="field">مبلغ الأضرار (د.ك)<input {...bind('damage_amount')} inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 110 }} /></label>
          <button disabled={act.busy}>استلام وحساب الرسوم</button>
        </form>}
        {w && ['reserved', 'out', 'overdue'].includes(x.state) && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('extend', { return_due: kwIso(f.return_due) }); }}>
          <label className="field">تمديد الإرجاع إلى<input {...bind('return_due')} type="datetime-local" required /></label><button className="secondary" disabled={act.busy}>تمديد</button>
        </form>}
        {w && ['reserved', 'out', 'overdue'].includes(x.state) && <form className="form" onSubmit={(e) => { e.preventDefault(); void post('moves', { kind: f.kind, driver_worker_id: f.driver, address: clean({ area: f.area, block: f.block, street: f.street }) }); }}>
          <h2>توصيل أو استلام بسائق</h2>
          <div className="row">
            <label className="field">النوع<select {...bind('kind')}>{x.state === 'reserved' && <option value="deliver">توصيل للعميل</option>}<option value="collect">استلام من العميل</option></select></label>
            <label className="field">السائق<select {...bind('driver')} required><option value="">اختر</option>{workers.data?.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}</select></label>
            <label className="field">المنطقة<input {...bind('area')} required maxLength={80} /></label>
            <label className="field">القطعة<input {...bind('block')} maxLength={10} className="num" style={{ width: 70 }} /></label>
            <label className="field">الشارع<input {...bind('street')} maxLength={80} /></label>
          </div>
          <button className="secondary" disabled={act.busy}>إسناد للسائق</button>
          <p className="muted" style={{ margin: 0 }}>التوصيل في موعد الاستلام، والاستلام في موعد الإرجاع. السائق يسجّل العدّاد والوقود من التطبيق.</p>
        </form>}
        {x.moves.length > 0 && <div className="tbl-wrap"><table data-testid="moves"><thead><tr><th>المهمة</th><th>الموعد</th><th>السائق</th><th>الحالة</th></tr></thead>
          <tbody>{x.moves.map((m) => <tr key={m.task_id}><td>{m.kind === 'deliver' ? 'توصيل' : 'استلام'} · {[m.address.area, m.address.block && `ق ${m.address.block}`].filter(Boolean).join('، ')}</td><td className="num">{dt(m.at)}</td><td>{m.driver_name ?? '—'}</td><td><Tone map={TASK_STATUS} value={m.status} /></td></tr>)}</tbody></table></div>}
        {x.fines.length > 0 && <><h2>المخالفات</h2><FinesTable rows={x.fines} testId="agreement-fines" /></>}
        {w && x.state === 'reserved' && <form className="row" onSubmit={(e) => { e.preventDefault(); void post('cancel', { reason: f.reason }); }}>
          <input {...bind('reason')} placeholder="سبب الإلغاء" required maxLength={500} aria-label="سبب الإلغاء" /><button className="danger" disabled={act.busy}>إلغاء الحجز</button>
        </form>}
      </div>}
    </Modal>
  );
}

function OdoFields({ bind }: { bind: (k: 'odometer_km' | 'fuel' | 'damage') => { name: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void } }) {
  return (
    <div className="row">
      <label className="field">العدّاد (كم)<input {...bind('odometer_km')} type="number" min={0} required className="num" style={{ width: 120 }} /></label>
      <label className="field">الوقود<select {...bind('fuel')}>{[8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => <option key={n} value={n}>{fuelLine(n)}</option>)}</select></label>
      <label className="field">الأضرار والملاحظات<input {...bind('damage')} maxLength={1000} /></label>
    </div>
  );
}

function FleetView() {
  type Car = { id: string; plate_no: string; asset_type: string; make: string | null; model: string | null; year: number | null; status: string; odometer_km: number | null;
    out_ref: string | null; out_customer: string | null; out_due: string | null; overdue: boolean | null; next_ref: string | null; next_pickup: string | null };
  const fleet = useLoad(() => api<{ data: Car[] }>('/rental/fleet').then((r) => r.data));
  const rows = fleet.data ?? [];
  const out = rows.filter((c) => c.out_ref).length, late = rows.filter((c) => c.overdue).length;
  return (
    <div className="stack">
      <ErrorBox error={fleet.error} />
      <div className="grid g4"><Kpi label="مع العملاء" value={out} tone="success" /><Kpi label="متأخرة الإرجاع" value={late} tone={late ? 'danger' : undefined} /><Kpi label="في الفرع" value={rows.length - out} /></div>
      <section className="card">
        {rows.length === 0 ? <Empty>لا توجد سيارات. أضفها من «المركبات».</Empty> : (
          <div className="tbl-wrap"><table data-testid="fleet"><thead><tr><th>السيارة</th><th>السنة</th><th>العدّاد</th><th>الآن</th><th>الإرجاع</th><th>الحجز التالي</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id}><td>{car(c)}</td><td className="num">{c.year ?? '—'}</td><td className="num">{km(c.odometer_km)}</td>
                <td>{c.out_ref ? <Badge tone={c.overdue ? 'danger' : 'success'}>{c.out_ref} · {c.out_customer}</Badge> : c.status === 'available' ? <Badge>في الفرع</Badge> : <Tone map={ASSET_STATUS} value={c.status} />}</td>
                <td className="num">{c.out_due ? dt(c.out_due) : '—'}</td><td className="num">{c.next_ref ? `${c.next_ref} · ${dt(c.next_pickup)}` : '—'}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>
    </div>
  );
}

function FinesTable({ rows, onSet, testId }: { rows: Fine[]; onSet?: (f: Fine, status: string) => void; testId: string }) {
  if (rows.length === 0) return <Empty>لا توجد مخالفات</Empty>;
  return (
    <div className="tbl-wrap"><table data-testid={testId}><thead><tr><th>الوقت</th><th>السيارة</th><th>المبلغ</th><th>الرقم والوصف</th><th>العقد والمستأجر</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{rows.map((f) => (
        <tr key={f.id}><td className="num">{dt(f.occurred_at)}</td><td className="num">{f.plate_no}</td><td className="num">{money(f.amount)}</td>
          <td><span className="num">{f.fine_no ?? ''}</span> {f.description ?? ''}</td>
          <td>{f.rental_ref ? <><span className="num">{f.rental_ref}</span> · {f.renter_name}</> : <Badge tone="warning">لم تكن مؤجرة</Badge>}</td>
          <td><Tone map={FINE_STATUS} value={f.status} /></td>
          <td>{onSet && f.status === 'open' && <div className="row" style={{ gap: 4 }}>
            {f.agreement_id && <button className="small" onClick={() => onSet(f, 'charged')}>على المستأجر</button>}
            {!f.agreement_id && <button className="small secondary" onClick={() => onSet(f, 'paid_by_us')}>دفعتها الشركة</button>}
            <button className="small secondary" onClick={() => onSet(f, 'waived')}>إعفاء</button>
          </div>}</td></tr>
      ))}</tbody></table></div>
  );
}

function FinesView() {
  const me = useMe();
  const fines = useLoad(() => api<{ data: Fine[] }>('/rental/fines').then((r) => r.data));
  const assets = useAssets();
  const act = useAction();
  const blank = { asset_id: '', occurred_at: '', amount: '', fine_no: '', description: '' };
  const { f, bind, setF } = useForm(blank);
  const w = can(me, 'tasks:assign');
  return (
    <section className="card stack">
      <ErrorBox error={fines.error ?? act.error} />
      {w && <form className="row" onSubmit={(e) => { e.preventDefault(); void act.run(async () => {
        await api('/rental/fines', { method: 'POST', body: { asset_id: f.asset_id, occurred_at: kwIso(f.occurred_at), amount: f.amount, ...clean({ fine_no: f.fine_no, description: f.description }) } });
        setF(blank); await fines.reload();
      }); }}>
        <label className="field">السيارة<select {...bind('asset_id')} required><option value="">اختر</option>{(assets.data ?? []).filter((a) => RENTAL_TYPES.includes(a.asset_type)).map((a) => <option key={a.id} value={a.id}>{a.plate_no}</option>)}</select></label>
        <label className="field">وقت المخالفة<input {...bind('occurred_at')} type="datetime-local" required /></label>
        <label className="field">المبلغ<input {...bind('amount')} required inputMode="decimal" pattern="\d+(\.\d{1,3})?" className="num" style={{ width: 90 }} /></label>
        <label className="field">رقم المخالفة<input {...bind('fine_no')} maxLength={60} className="num" dir="ltr" /></label>
        <label className="field">الوصف<input {...bind('description')} maxLength={500} /></label>
        <button disabled={act.busy}>تسجيل المخالفة</button>
      </form>}
      <p className="muted" style={{ margin: 0 }}>تُطابق المخالفة تلقائيًا مع العقد الذي كانت السيارة فيه وقت المخالفة.</p>
      <FinesTable rows={fines.data ?? []} testId="fines" onSet={w ? (x, status) => void act.run(async () => { await api(`/rental/fines/${x.id}`, { method: 'POST', body: { status } }); await fines.reload(); }) : undefined} />
    </section>
  );
}

function ExceptionsView() {
  const [day, setDay] = useState(todayKw());
  const x = useLoad(() => api<{ overdue: Agreement[]; late_pickups: Agreement[]; pickups: Agreement[]; returns: Agreement[]; failed_moves: Move[]; open_fines: Fine[] }>(`/rental/exceptions?date=${day}`), [day]);
  const d = x.data;
  return (
    <div className="stack">
      <label className="field">اليوم<input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ maxWidth: 180 }} /></label>
      <ErrorBox error={x.error} />
      {d && <>
        <div className="grid g4">
          <Kpi label="متأخرة الإرجاع" value={d.overdue.length} tone={d.overdue.length ? 'danger' : undefined} />
          <Kpi label="لم تُستلم في موعدها" value={d.late_pickups.length} tone={d.late_pickups.length ? 'warning' : undefined} />
          <Kpi label="استلام / إرجاع اليوم" value={`${d.pickups.length} / ${d.returns.length}`} />
          <Kpi label="مخالفات مفتوحة" value={d.open_fines.length} />
        </div>
        <section className="card"><h2>سيارات متأخرة الإرجاع</h2><AgreementsTable rows={d.overdue} testId="ex-overdue" /></section>
        <section className="card"><h2>حجوزات لم تُستلم بعد ساعة من موعدها [تخمين]</h2><AgreementsTable rows={d.late_pickups} testId="ex-late" /></section>
        <section className="card"><h2>الاستلام اليوم</h2><AgreementsTable rows={d.pickups} testId="ex-pickups" /></section>
        <section className="card"><h2>الإرجاع اليوم</h2><AgreementsTable rows={d.returns} testId="ex-returns" /></section>
        {d.failed_moves.length > 0 && <section className="card"><h2>توصيل أو استلام تعذّر</h2>
          <ul>{d.failed_moves.map((m) => <li key={m.task_id}><span className="num">{m.rental_ref}</span> · {m.kind === 'deliver' ? 'توصيل' : 'استلام'} · {m.driver_name}</li>)}</ul></section>}
        <section className="card"><h2>مخالفات مفتوحة</h2><FinesTable rows={d.open_fines} testId="ex-fines" /></section>
      </>}
    </div>
  );
}

function ReportView() {
  const t = todayKw();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  type Sum = { agreements: number; days: number; km: number; rental: string; extra_km: string; fuel: string; damage: string; total: string };
  const r = useLoad(() => api<{ customers: (Sum & { customer_name: string })[]; vehicles: { plate_no: string; asset_type: string; agreements: number; rented_hours: number; period_hours: number; utilization_pct: number | null }[];
    totals: Sum; fines: { charged: string; paid_by_us: string; open: number } }>(`/rental/report?from=${from}&to=${to}`), [from, to]);
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
          <Kpi label="عقود أُغلقت" value={x.agreements} />
          <Kpi label="أيام إيجار" value={x.days} />
          <Kpi label="الإيرادات" value={money(x.total)} tone="success" />
          <Kpi label="مخالفات على المستأجرين" value={money(r.data!.fines.charged)} />
        </div>
        <section className="card"><h2>حسب العميل</h2>
          {r.data!.customers.length === 0 ? <Empty>لا توجد عقود مغلقة في الفترة</Empty> : <div className="tbl-wrap"><table data-testid="rn-customers"><thead><tr><th>العميل</th><th>عقود</th><th>أيام</th><th>كم</th><th>الإيجار</th><th>كم زائد</th><th>وقود</th><th>أضرار</th><th>الإجمالي</th></tr></thead>
            <tbody>{r.data!.customers.map((c) => <tr key={c.customer_name}><td>{c.customer_name}</td><td className="num">{c.agreements}</td><td className="num">{c.days}</td><td className="num">{c.km}</td>
              <td className="num">{money(c.rental)}</td><td className="num">{money(c.extra_km)}</td><td className="num">{money(c.fuel)}</td><td className="num">{money(c.damage)}</td><td className="num">{money(c.total)}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="card"><h2>استغلال السيارات</h2>
          {r.data!.vehicles.length === 0 ? <Empty>لا يوجد</Empty> : <div className="tbl-wrap"><table data-testid="rn-vehicles"><thead><tr><th>السيارة</th><th>عقود</th><th>ساعات الإيجار</th><th>الاستغلال</th></tr></thead>
            <tbody>{r.data!.vehicles.map((v) => <tr key={v.plate_no}><td className="num">{v.plate_no}</td><td className="num">{v.agreements}</td><td className="num">{v.rented_hours}</td><td className="num">{v.utilization_pct === null ? '—' : `${v.utilization_pct}%`}</td></tr>)}</tbody></table></div>}
          <p className="muted" style={{ marginBottom: 0 }}>المخالفات التي دفعتها الشركة في الفترة: {money(r.data!.fines.paid_by_us)}.</p>
        </section>
      </>}
    </div>
  );
}
