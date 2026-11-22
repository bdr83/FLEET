'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { day, WORKER_KIND, WORKER_STATUS } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { clean, Empty, ErrorBox, Modal, Tone, useAction, useForm, useLoad } from '@/components/ui';
import { DocsPanel } from '@/components/docs';

interface Worker { id: string; legal_entity_id: string; kind: string; display_name: string; phone: string | null; status: string; user_id: string | null; created_at: string }

export default function WorkersPage() {
  const me = useMe();
  const [status, setStatus] = useState('active');
  const list = useLoad(() => api<{ data: Worker[] }>(`/workers${status ? `?status=${status}` : ''}`).then((r) => r.data), [status]);
  const [edit, setEdit] = useState<Worker | 'new' | null>(null);
  const write = can(me, 'fleet:write');
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>السائقون والعاملون</h1>
        {write && <button className="primary" onClick={() => setEdit('new')}>إضافة سائق</button>}
      </div>
      <div className="row">
        <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">كل الحالات</option>
          {Object.entries(WORKER_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا يوجد عاملون بهذه الحالة</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>الاسم</th><th>الصفة</th><th>الجوال</th><th>تطبيق السائق</th><th>الحالة</th><th>أضيف</th></tr></thead>
          <tbody>
            {list.data?.map((w) => (
              <tr key={w.id} onClick={() => setEdit(w)} style={{ cursor: 'pointer' }}>
                <td><strong>{w.display_name}</strong></td>
                <td>{WORKER_KIND[w.kind] ?? w.kind}</td>
                <td className="num">{w.phone ?? '—'}</td>
                <td>{w.user_id ? 'مفعّل' : <span className="muted">بلا جوال</span>}</td>
                <td><Tone map={WORKER_STATUS} value={w.status} /></td>
                <td className="num">{day(w.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {edit && <WorkerForm worker={edit === 'new' ? null : edit} readOnly={!write} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void list.reload(); }} />}
    </div>
  );
}

function WorkerForm({ worker, readOnly, onClose, onDone }: { worker: Worker | null; readOnly: boolean; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const { f, bind } = useForm({
    legal_entity_id: worker?.legal_entity_id ?? me.legal_entities[0]?.id ?? '', kind: worker?.kind ?? 'driver',
    display_name: worker?.display_name ?? '', phone: '', email: '', password: '', status: worker?.status ?? 'active',
  });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (worker) await api(`/workers/${worker.id}`, { method: 'PATCH', body: { display_name: f.display_name, status: f.status } });
      else await api('/workers', { method: 'POST', body: clean({ legal_entity_id: f.legal_entity_id, kind: f.kind, display_name: f.display_name, phone: f.phone, email: f.email, password: f.email ? f.password : '' }) });
      onDone();
    });
  };
  return (
    <Modal title={worker ? worker.display_name : 'إضافة سائق'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }} className="form-2">
          {!worker && me.legal_entities.length > 1 && (
            <label className="field">الشركة القانونية<select {...bind('legal_entity_id')}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          )}
          <label className="field">الاسم<input {...bind('display_name')} required maxLength={120} /></label>
          {!worker && <>
            <label className="field">الصفة<select {...bind('kind')}>{Object.entries(WORKER_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">الجوال<input {...bind('phone')} className="num" inputMode="tel" placeholder="+965 5xxx xxxx" /></label>
            <label className="field">بريد الدخول لتطبيق السائق<input {...bind('email')} type="email" dir="ltr" /></label>
            {f.email && <label className="field">كلمة مرور أولى <span className="muted">(8 أحرف على الأقل)</span><input {...bind('password')} type="text" dir="ltr" minLength={8} autoComplete="off" required /></label>}
          </>}
          {worker && (
            <label className="field">الحالة<select {...bind('status')}>{Object.entries(WORKER_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</select></label>
          )}
        </fieldset>
        {worker && f.status === 'left' && worker.status !== 'left' && <div className="alert">عند الحفظ يفقد السائق الدخول إلى التطبيق وتُنهى جلساته.</div>}
        {!readOnly && <div className="row"><button className="primary" disabled={busy}>حفظ</button><button type="button" onClick={onClose}>إلغاء</button></div>}
      </form>
      {worker && <DocsPanel owner={{ worker_id: worker.id }} />}
    </Modal>
  );
}

