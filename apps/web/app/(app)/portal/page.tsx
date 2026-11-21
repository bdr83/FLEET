'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, PACKS, packLabel, taskSummary, todayKw } from '@/lib/format';
import { Empty, ErrorBox, Modal, StatusBadge, useAction, useForm, useLoad } from '@/components/ui';

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
          <label className="field">النوع<select {...bind('sector_pack')}>{Object.entries(PACKS).filter(([k]) => k !== 'internal@1').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
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
