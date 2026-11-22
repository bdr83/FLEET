'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { VR_STATUS } from '@/lib/format';
import { Badge, clean, Empty, ErrorBox, Modal, Tone, useAction, useForm, useLoad } from '@/components/ui';
import { ASSET_TYPES, CancelButton, DecideForm, kwIso, period, RequestFacts, typeLabel, VReq } from '@/components/internal';

interface My { department: { id: string; name: string } | null; managed: { id: string; name: string }[]; requests: VReq[]; to_approve: VReq[] }

/** The employee's side of the in-house fleet: ask for a vehicle, follow my requests, and approve my department's if I manage it. */
export default function RequestsPage() {
  const my = useLoad(() => api<My>('/internal/my'));
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<VReq | null>(null);
  const d = my.data;
  const changed = (r: VReq) => { setOpen(r); void my.reload(); };
  const row = (r: VReq, who = false) => (
    <tr key={r.id}>
      <td><button type="button" className="link num" onClick={() => setOpen(r)} aria-label={`طلب المركبة ${r.ref}`}>{r.ref}</button></td>
      {who && <td>{r.requester_name}</td>}
      <td>{r.purpose}{r.destination && <span className="muted"> · {r.destination}</span>}</td>
      <td className="num">{period(r)}</td>
      <td>{typeLabel(r.asset_type)}{r.with_driver && <> · <Badge tone="info">مع سائق</Badge></>}</td>
      <td className="num">{r.plate_no ?? '—'}</td>
      <td><Tone map={VR_STATUS} value={r.status} /></td>
    </tr>
  );
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>طلبات المركبات</h1>
        <button className="primary" onClick={() => setAsking(true)} disabled={!d}>طلب مركبة</button>
      </div>
      <ErrorBox error={my.error} />
      {d && <>
        <p className="muted" style={{ margin: 0 }}>{d.department ? <>إدارتك: <strong>{d.department.name}</strong>. يوافق مديرها على طلبك ثم يخصص مكتب الأسطول المركبة.</> : 'لم تُحدَّد إدارتك بعد: اطلب من مكتب الأسطول ربط حسابك بإدارتك.'}</p>
        {d.managed.length > 0 && (
          <section className="card stack">
            <h2>بانتظار موافقتك ({d.to_approve.length})</h2>
            {d.to_approve.length === 0 ? <Empty>لا توجد طلبات تنتظرك</Empty> : (
              <div className="tbl-wrap"><table data-testid="to-approve">
                <thead><tr><th>الطلب</th><th>الموظف</th><th>الغرض</th><th>الفترة</th><th>المطلوب</th><th>المركبة</th><th>الحالة</th></tr></thead>
                <tbody>{d.to_approve.map((r) => row(r, true))}</tbody>
              </table></div>
            )}
          </section>
        )}
        <section className="card stack">
          <h2>طلباتي</h2>
          {d.requests.length === 0 ? <Empty>لم تطلب مركبة بعد</Empty> : (
            <div className="tbl-wrap"><table data-testid="my-requests">
              <thead><tr><th>الطلب</th><th>الغرض</th><th>الفترة</th><th>المطلوب</th><th>المركبة</th><th>الحالة</th></tr></thead>
              <tbody>{d.requests.map((r) => row(r))}</tbody>
            </table></div>
          )}
        </section>
      </>}
      {asking && d && <AskForm my={d} onClose={() => setAsking(false)} onDone={(r) => { setAsking(false); changed(r); }} />}
      {open && d && (
        <Modal title={`طلب المركبة ${open.ref}`} onClose={() => setOpen(null)}>
          <div className="stack">
            <RequestFacts r={open} />
            {open.status === 'pending' && d.to_approve.some((x) => x.id === open.id) && <section className="card"><h3>قرارك</h3><DecideForm r={open} onDone={changed} /></section>}
            {open.status === 'allocated' && !open.with_driver && <div className="alert ok">استلم المفتاح من مكتب الأسطول في موعدك؛ يُسجَّل العدّاد عند التسليم.</div>}
            {open.status === 'allocated' && open.with_driver && <div className="alert ok">السائق {open.driver_name} سيأتي بالمركبة في موعدك.</div>}
            <div className="row"><CancelButton r={open} onDone={changed} /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AskForm({ my, onClose, onDone }: { my: My; onClose: () => void; onDone: (r: VReq) => void }) {
  const act = useAction();
  const { f, bind, check } = useForm({ purpose: '', destination: '', starts_at: '', ends_at: '', passengers: '1', asset_type: '', with_driver: false, notes: '', department_id: '' });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => onDone(await api<VReq>('/internal/requests', { method: 'POST', body: {
      purpose: f.purpose, starts_at: kwIso(f.starts_at), ends_at: kwIso(f.ends_at), passengers: Number(f.passengers), with_driver: f.with_driver,
      ...clean({ destination: f.destination, asset_type: f.asset_type, notes: f.notes, department_id: f.department_id }),
    } })));
  };
  // a manager without a department of their own asks for the one they manage
  const choose = !my.department && my.managed.length > 0;
  return (
    <Modal title="طلب مركبة" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={act.error} />
        <div className="form-2">
          <label className="field">الغرض<input {...bind('purpose')} required maxLength={300} placeholder="زيارة عميل" /></label>
          <label className="field">الوجهة<input {...bind('destination')} maxLength={300} placeholder="الشويخ الصناعية" /></label>
          <label className="field">من<input type="datetime-local" {...bind('starts_at')} required /></label>
          <label className="field">إلى<input type="datetime-local" {...bind('ends_at')} required min={f.starts_at || undefined} /></label>
          <label className="field">نوع المركبة<select {...bind('asset_type')}><option value="">أي نوع</option>{ASSET_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}</select></label>
          <label className="field">عدد الركاب<input type="number" {...bind('passengers')} className="num" min={1} max={60} required /></label>
          {choose && <label className="field">الإدارة<select {...bind('department_id')} required><option value="">اختر</option>{my.managed.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
        </div>
        <label className="row"><input {...check('with_driver')} /> أحتاج سائقًا</label>
        <label className="field">ملاحظات<input {...bind('notes')} maxLength={1000} /></label>
        <p className="muted" style={{ margin: 0 }}>الأوقات بتوقيت الكويت. الطلب يصل لمدير إدارتك للموافقة، إلا إن كانت سياسة الشركة تعتمد المشاوير القصيرة تلقائيًا.</p>
        <div className="row"><button className="primary" disabled={act.busy}>إرسال الطلب</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}
