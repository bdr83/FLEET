'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { CUSTOMER_STATUS, money } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { clean, Empty, ErrorBox, Tone, useLoad } from '@/components/ui';
import { currencyOf, Customer, CustomerForm } from '@/components/customer-form';


export default function CustomersPage() {
  const me = useMe();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useLoad(() => api<{ data: Customer[] }>(`/customers?${new URLSearchParams(clean({ q, status }) as Record<string, string>)}`).then((r) => r.data), [q, status]);
  const [creating, setCreating] = useState(false);
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>العملاء</h1>
        {can(me, 'customers:write') && <button className="primary" onClick={() => setCreating(true)}>إضافة عميل</button>}
      </div>
      <div className="row">
        <input type="search" placeholder="بحث بالاسم أو المرجع أو الجوال" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
        <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">كل الحالات</option>
          {Object.entries(CUSTOMER_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>لا يوجد عملاء مطابقون</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>العميل</th><th>المرجع</th><th>الجوال</th><th>مدة السداد</th><th>حد الائتمان</th><th>الحالة</th></tr></thead>
          <tbody>
            {list.data?.map((c) => (
              <tr key={c.id} onClick={() => router.push(`/customers/${c.id}`)} style={{ cursor: 'pointer' }}>
                <td><Link href={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()}><strong>{c.name}</strong></Link></td>
                <td className="num">{c.ref ?? '—'}</td>
                <td className="num">{c.phone ?? '—'}</td>
                <td>{c.payment_terms_days ? `${c.payment_terms_days} يومًا` : 'فوري'}</td>
                <td className="num">{c.credit_limit ? money(c.credit_limit, currencyOf(me, c.legal_entity_id)) : '—'}</td>
                <td><Tone map={CUSTOMER_STATUS} value={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {creating && <CustomerForm onClose={() => setCreating(false)} onDone={(c) => router.push(`/customers/${c.id}`)} />}
    </div>
  );
}

