'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { day, INVOICE_STATUS, money, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Empty, ErrorBox, Modal, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Invoice { id: string; number: string | null; customer_id: string; customer_name: string; status: string; currency: string; period_from: string | null; period_to: string | null; issue_date: string | null; due_date: string | null; total: string; balance: string }

export default function InvoicesPage() {
  const me = useMe();
  const router = useRouter();
  const [status, setStatus] = useState('');
  const list = useLoad(() => api<{ data: Invoice[] }>(`/invoices${status ? `?status=${status}` : ''}`).then((r) => r.data), [status]);
  const [creating, setCreating] = useState(false);
  const today = todayKw();
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>الفواتير</h1>
        {can(me, 'billing:write') && <button className="primary" onClick={() => setCreating(true)}>فاتورة جديدة</button>}
      </div>
      <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
        <option value="">كل الحالات</option>{Object.entries(INVOICE_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
      </select>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا توجد فواتير. تُبنى الفاتورة من مهام العميل المكتملة والمراجَعة خلال فترة.</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>الرقم</th><th>العميل</th><th>الفترة</th><th>الإصدار</th><th>الاستحقاق</th><th>الإجمالي</th><th>المتبقي</th><th>الحالة</th></tr></thead>
          <tbody>{list.data?.map((i) => {
            const late = i.due_date && i.due_date < today && (i.status === 'issued' || i.status === 'partially_paid');
            return (
              <tr key={i.id} onClick={() => router.push(`/invoices/${i.id}`)} style={{ cursor: 'pointer' }}>
                <td className="num"><Link href={`/invoices/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.number ?? 'مسودة'}</Link></td>
                <td>{i.customer_name}</td>
                <td><span className="num">{day(i.period_from)}</span> – <span className="num">{day(i.period_to)}</span></td>
                <td className="num">{day(i.issue_date)}</td>
                <td className="num" style={late ? { color: 'var(--danger)' } : undefined}>{day(i.due_date)}</td>
                <td className="num">{money(i.total, i.currency)}</td>
                <td className="num">{i.status === 'void' || i.status === 'draft' ? '—' : money(i.balance, i.currency)}</td>
                <td><Tone map={INVOICE_STATUS} value={i.status} /></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {creating && <NewInvoice onClose={() => setCreating(false)} onDone={(id, skipped) => router.push(`/invoices/${id}${skipped ? `?skipped=${skipped}` : ''}`)} />}
    </div>
  );
}

function NewInvoice({ onClose, onDone }: { onClose: () => void; onDone: (id: string, skipped: number) => void }) {
  const customers = useLoad(() => api<{ data: { id: string; name: string }[] }>('/customers?status=active').then((r) => r.data));
  const today = todayKw();
  const { f, bind } = useForm({ customer_id: '', period_from: `${today.slice(0, 8)}01`, period_to: today, notes: '' });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ id: string; skipped: unknown[] }>('/invoices', { method: 'POST', body: { ...f, notes: f.notes || undefined } });
      onDone(r.id, r.skipped.length);
    });
  };
  return (
    <Modal title="فاتورة جديدة" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error ?? customers.error} />
        <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر العميل</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <div className="form-2">
          <label className="field">من<input {...bind('period_from')} type="date" required /></label>
          <label className="field">إلى<input {...bind('period_to')} type="date" required /></label>
        </div>
        <label className="field">ملاحظات تظهر على الفاتورة<textarea {...bind('notes')} rows={2} maxLength={2000} /></label>
        <p className="muted" style={{ margin: 0 }}>تُضاف المهام المراجَعة غير المفوترة التي اكتملت في الفترة، مسعّرة بعقد كل مهمة. تبقى الفاتورة مسودة حتى تصدرها.</p>
        <div className="row"><button className="primary" disabled={busy}>إنشاء المسودة</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}
