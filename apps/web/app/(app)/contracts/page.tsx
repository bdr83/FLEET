'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { CONTRACT_STATUS, day, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { clean, Empty, ErrorBox, Modal, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Contract { id: string; customer_id: string; customer_name: string; code: string; starts_on: string; ends_on: string | null; status: string; currency: string; payment_terms_days: number }

function ContractsPage() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState('');
  const list = useLoad(() => api<{ data: Contract[] }>(`/contracts${status ? `?status=${status}` : ''}`).then((r) => r.data), [status]);
  const [creating, setCreating] = useState(params.get('new') === '1');
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>العقود</h1>
        {can(me, 'customers:write') && <button className="primary" onClick={() => setCreating(true)}>عقد جديد</button>}
      </div>
      <p className="muted" style={{ margin: 0 }}>يُجهَّز العقد كمسودة مع قائمة الأسعار ثم يُفعّل. أسعار العقد الساري مجمّدة: لتغييرها أنهِ العقد وفعّل عقدًا جديدًا.</p>
      <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
        <option value="">كل الحالات</option>
        {Object.entries(CONTRACT_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
      </select>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا توجد عقود</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>الرمز</th><th>العميل</th><th>من</th><th>إلى</th><th>السداد</th><th>الحالة</th></tr></thead>
          <tbody>{list.data?.map((k) => (
            <tr key={k.id} onClick={() => router.push(`/contracts/${k.id}`)} style={{ cursor: 'pointer' }}>
              <td className="num"><Link href={`/contracts/${k.id}`} onClick={(e) => e.stopPropagation()}>{k.code}</Link></td>
              <td>{k.customer_name}</td><td className="num">{day(k.starts_on)}</td><td className="num">{k.ends_on ? day(k.ends_on) : 'مفتوح'}</td>
              <td>{k.payment_terms_days ? `${k.payment_terms_days} يومًا` : 'فوري'}</td><td><Tone map={CONTRACT_STATUS} value={k.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {creating && <NewContract customerId={params.get('customer') ?? ''} onClose={() => setCreating(false)} onDone={(id) => router.push(`/contracts/${id}`)} />}
    </div>
  );
}

function NewContract({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: (id: string) => void }) {
  const customers = useLoad(() => api<{ data: { id: string; name: string; status: string }[] }>('/customers?status=active').then((r) => r.data));
  const { f, bind } = useForm({ customer_id: customerId, code: '', starts_on: todayKw(), ends_on: '', payment_terms_days: '', notes: '' });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const k = await api<{ id: string }>('/contracts', {
        method: 'POST', body: clean({ ...f, payment_terms_days: f.payment_terms_days === '' ? '' : Number(f.payment_terms_days) }),
      });
      onDone(k.id);
    });
  };
  return (
    <Modal title="عقد جديد" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error ?? customers.error} />
        <label className="field">العميل
          <select {...bind('customer_id')} required>
            <option value="">اختر العميل</option>
            {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div className="form-2">
          <label className="field">الرمز (اختياري)<input {...bind('code')} className="num" maxLength={40} /></label>
          <label className="field">مدة السداد (تُؤخذ من العميل إن تُركت)<input {...bind('payment_terms_days')} type="number" min={0} max={365} className="num" /></label>
          <label className="field">يبدأ في<input {...bind('starts_on')} type="date" required /></label>
          <label className="field">ينتهي في (اختياري)<input {...bind('ends_on')} type="date" /></label>
        </div>
        <label className="field">ملاحظات<textarea {...bind('notes')} rows={2} maxLength={2000} /></label>
        <div className="row"><button className="primary" disabled={busy}>إنشاء المسودة</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}

export default function Page() { return <Suspense><ContractsPage /></Suspense>; }
