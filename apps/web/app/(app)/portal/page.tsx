'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { day, dt, hours, PACKS, packLabel, REQUEST_STATE, siteLine, ConcreteSite, taskSummary, time, todayKw, workDaysLine } from '@/lib/format';
import { Badge, Empty, ErrorBox, Modal, StatusBadge, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface PortalTask { id: string; ref: string | null; status: string; sector_pack: string; window_from: string | null; window_to: string | null; attributes: Record<string, unknown>; driver_name: string | null; plate_no: string | null }
interface PortalMe { name: string; sites: { id: string; name: string; address: string | null }[] }

/** Customer portal: the customer's own requests, their progress, and new requests. */
export default function Portal() {
  const me = useLoad(() => api<PortalMe>('/portal/me'));
  const tasks = useLoad(() => api<{ data: PortalTask[] }>('/portal/tasks').then((r) => r.data));
  const [creating, setCreating] = useState(false);
  const act = useAction();
  const cancel = (t: PortalTask) => act.run(async () => { await api(`/portal/tasks/${t.id}/cancel`, { method: 'POST', body: {} }); await tasks.reload(); });
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>{me.data?.name ?? 'طلباتي'}</h1>
        <button className="primary" onClick={() => setCreating(true)}>طلب جديد</button>
      </div>
      <ErrorBox error={me.error ?? tasks.error ?? act.error} />
      {tasks.data?.length === 0 ? <Empty>لا توجد طلبات بعد</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>المرجع</th><th>النوع</th><th>الموعد</th><th>التفاصيل</th><th>الحالة</th><th>السائق</th><th></th></tr></thead>
          <tbody>{tasks.data?.map((t) => (
            <tr key={t.id}>
              <td className="num">{t.ref?.replace(/^[0-9a-f]{8}:/, '') ?? t.id.slice(0, 8)}</td><td>{packLabel(t.sector_pack)}</td><td className="num">{dt(t.window_from)}</td>
              <td>{taskSummary(t.attributes)}</td><td><StatusBadge status={t.status} /></td>
              <td>{t.driver_name ?? '—'}{t.plate_no && <span className="muted num"> · {t.plate_no}</span>}</td>
              <td>{['draft', 'ready'].includes(t.status) && <button className="small" disabled={act.busy} onClick={() => cancel(t)}>إلغاء</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <StaffingSection />
      {creating && <NewRequest sites={me.data?.sites ?? []} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void tasks.reload(); }} />}
    </div>
  );
}

function NewRequest({ sites, onClose, onDone }: { sites: PortalMe['sites']; onClose: () => void; onDone: () => void }) {
  const today = todayKw();
  const { f, bind } = useForm({ sector_pack: 'delivery@1', site_id: '', ref: '', from: `${today}T09:00`, to: `${today}T13:00`, address: '', recipient_name: '', recipient_phone: '' });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const attributes = Object.fromEntries(Object.entries({ address: f.address, recipient_name: f.recipient_name, recipient_phone: f.recipient_phone }).filter(([, v]) => v));
      await api('/portal/tasks', { method: 'POST', body: { sector_pack: f.sector_pack, site_id: f.site_id || undefined, ref: f.ref || undefined, attributes, window: { from: `${f.from}:00+03:00`, to: `${f.to}:00+03:00` } } });
      onDone();
    });
  };
  return (
    <Modal title="طلب جديد" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-2">
          <label className="field">النوع<select {...bind('sector_pack')}>{Object.entries(PACKS).filter(([k]) => k !== 'internal@1' && k !== 'staffing@1').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {sites.length > 0 && <label className="field">موقع الاستلام<select {...bind('site_id')}><option value="">—</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
          <label className="field">مرجعكم<input {...bind('ref')} maxLength={60} /></label>
          <label className="field">من<input {...bind('from')} type="datetime-local" required /></label>
          <label className="field">إلى<input {...bind('to')} type="datetime-local" required /></label>
        </div>
        <label className="field">عنوان التسليم<input {...bind('address')} maxLength={300} /></label>
        <div className="form-2">
          <label className="field">اسم المستلم<input {...bind('recipient_name')} maxLength={120} /></label>
          <label className="field">جوال المستلم<input {...bind('recipient_phone')} className="num" inputMode="tel" maxLength={20} /></label>
        </div>
        <div className="row"><button className="primary" disabled={busy}>إرسال الطلب</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}

interface PStaffing {
  requests: { id: string; ref: string; site: ConcreteSite; headcount: number; starts_on: string; ends_on: string; shift_start: string; shift_end: string; work_days: number[]; bill_unit: string; state: string;
    placements: { placement_id: string; worker_name: string | null; starts_on: string; ends_on: string; licence_valid: boolean }[] }[];
  shifts: { task_id: string; request_ref: string; work_date: string; status: string; worker_name: string | null; check_in: string | null; check_out: string | null; hours: number | null; days: number | null; disputed: boolean; dispute_reason: string | null }[];
}

/** Driver supply: who is placed with the customer (first name and licence check only), and the worked days to approve or dispute. */
function StaffingSection() {
  const st = useLoad(() => api<PStaffing>('/portal/staffing'));
  const [sel, setSel] = useState<string[]>([]);
  const [disputing, setDisputing] = useState<PStaffing['shifts'][number] | null>(null);
  const act = useAction();
  const d = st.data;
  if (!d || d.requests.length === 0) return st.error ? <ErrorBox error={st.error} /> : null;
  const open = d.shifts.filter((s) => s.status === 'completed' && !s.disputed);
  const approve = () => act.run(async () => { await api('/portal/staffing/approve', { method: 'POST', body: { task_ids: sel } }); setSel([]); await st.reload(); });
  return (
    <section className="card stack" data-testid="portal-staffing">
      <h2>توريد السائقين</h2>
      <ErrorBox error={act.error} />
      <div className="tbl-wrap"><table>
        <thead><tr><th>الطلب</th><th>الفترة والدوام</th><th>السائقون</th><th>الحالة</th></tr></thead>
        <tbody>{d.requests.map((r) => (
          <tr key={r.id}>
            <td><span className="num">{r.ref}</span><div className="muted">{siteLine(r.site)}</div></td>
            <td><span className="num">{day(r.starts_on)} – {day(r.ends_on)}</span><div className="muted">{workDaysLine(r.work_days)} · <span className="num">{r.shift_start}–{r.shift_end}</span></div></td>
            <td>{r.placements.length === 0 ? '—' : r.placements.map((p) => <div key={p.placement_id}>{p.worker_name} {p.licence_valid ? <Badge tone="success">الرخصة سارية</Badge> : <Badge tone="danger">الرخصة غير سارية</Badge>}</div>)}
              <div className="muted"><span className="num">{r.placements.length}/{r.headcount}</span></div></td>
            <td><Tone map={REQUEST_STATE} value={r.state} /></td>
          </tr>
        ))}</tbody>
      </table></div>
      <h3 style={{ margin: 0 }}>أيام العمل (آخر 31 يومًا)</h3>
      <p className="muted" style={{ margin: 0 }}>اعتمد الأيام الصحيحة لتدخل الفاتورة، أو اعترض على ساعات يوم ليراجعه المكتب.</p>
      {d.shifts.length === 0 ? <Empty>لا أيام عمل بعد</Empty> : (
        <div className="tbl-wrap"><table data-testid="portal-shifts">
          <thead><tr><th><input type="checkbox" aria-label="تحديد الكل" checked={sel.length > 0 && sel.length === open.length} onChange={(e) => setSel(e.target.checked ? open.map((s) => s.task_id) : [])} /></th>
            <th>اليوم</th><th>الطلب</th><th>السائق</th><th>الحضور</th><th>الانصراف</th><th>الساعات</th><th>الحالة</th><th></th></tr></thead>
          <tbody>{d.shifts.map((s) => (
            <tr key={s.task_id}>
              <td>{s.status === 'completed' && !s.disputed && <input type="checkbox" aria-label={`اعتماد يوم ${s.work_date}`} checked={sel.includes(s.task_id)} onChange={(e) => setSel(e.target.checked ? [...sel, s.task_id] : sel.filter((x) => x !== s.task_id))} />}</td>
              <td className="num">{day(s.work_date)}</td><td className="num">{s.request_ref}</td><td>{s.worker_name ?? '—'}</td>
              <td className="num">{time(s.check_in)}</td><td className="num">{time(s.check_out)}</td><td>{s.days ? `${s.days} يوم` : hours(s.hours)}</td>
              <td>{s.disputed ? <Badge tone="warning">اعتراض قيد المراجعة</Badge> : s.status === 'reviewed' || s.status === 'invoiced' ? <Badge tone="success">معتمد</Badge> : <StatusBadge status={s.status} />}</td>
              <td>{s.status === 'completed' && !s.disputed && <button className="small" onClick={() => setDisputing(s)}>اعتراض</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open.length > 0 && <div className="row"><button className="primary" disabled={act.busy || sel.length === 0} onClick={() => void approve()}>اعتماد المحدد ({sel.length})</button></div>}
      {disputing && <DisputeForm s={disputing} onClose={() => setDisputing(null)} onDone={() => { setDisputing(null); void st.reload(); }} />}
    </section>
  );
}

function DisputeForm({ s, onClose, onDone }: { s: PStaffing['shifts'][number]; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title={`اعتراض على يوم ${day(s.work_date)}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/portal/staffing/dispute', { method: 'POST', body: { task_id: s.task_id, reason } }); onDone(); }); }}>
        <ErrorBox error={error} />
        <p style={{ margin: 0 }}>{s.worker_name}: حضور <span className="num">{time(s.check_in)}</span>، انصراف <span className="num">{time(s.check_out)}</span> ({hours(s.hours)}).</p>
        <label className="field">سبب الاعتراض<input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} placeholder="مثال: غادر الساعة 4 عصرًا" /></label>
        <div className="row"><button className="primary" disabled={busy}>إرسال الاعتراض</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}
