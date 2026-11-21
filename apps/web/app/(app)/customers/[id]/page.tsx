'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { CONTRACT_STATUS, CUSTOMER_STATUS, day, money } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { clean, Empty, ErrorBox, Modal, Tone, useAction, useForm, useLoad } from '@/components/ui';
import { currencyOf, Customer, CustomerForm } from '@/components/customer-form';

interface Site { id: string; name: string; address: string | null; lat: number | null; lng: number | null; contact_name: string | null; contact_phone: string | null; active: boolean }
type Detail = Customer & { sites: Site[]; active_contract: { id: string; code: string; starts_on: string; ends_on: string | null } | null };
interface Contract { id: string; code: string; starts_on: string; ends_on: string | null; status: string }

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const cu = useLoad(() => api<Detail>(`/customers/${id}`), [id]);
  const contracts = useLoad(() => api<{ data: Contract[] }>(`/contracts?customer_id=${id}`).then((r) => r.data), [id]);
  const [editing, setEditing] = useState(false);
  const [addingSite, setAddingSite] = useState(false);
  const c = cu.data;
  if (!c) return <div className="page"><ErrorBox error={cu.error} />{!cu.error && <p className="muted">جارٍ التحميل…</p>}</div>;
  const write = can(me, 'customers:write');
  const cur = currencyOf(me, c.legal_entity_id);
  return (
    <div className="page stack">
      <div className="page-head">
        <div className="row"><Link href="/customers" className="muted">العملاء ‹</Link><h1>{c.name}</h1><Tone map={CUSTOMER_STATUS} value={c.status} /></div>
        <div className="row">
          {can(me, 'billing:read') && <Link className="btn" href={`/receivables?customer=${c.id}`}>كشف الحساب</Link>}
          {write && <button onClick={() => setEditing(true)}>تعديل</button>}
        </div>
      </div>
      <div className="grid g2">
        <section className="card">
          <h2>البيانات</h2>
          <dl className="dl">
            <dt>النوع</dt><dd>{c.kind === 'individual' ? 'فرد' : 'شركة'}</dd>
            <dt>المرجع</dt><dd className="num">{c.ref ?? '—'}</dd>
            <dt>الجوال</dt><dd className="num">{c.phone ?? '—'}</dd>
            <dt>البريد</dt><dd className="num">{c.email ?? '—'}</dd>
            <dt>السجل التجاري</dt><dd className="num">{c.cr_number ?? '—'}</dd>
            <dt>مدة السداد</dt><dd>{c.payment_terms_days ? `${c.payment_terms_days} يومًا` : 'فوري'}</dd>
            <dt>حد الائتمان</dt><dd className="num">{c.credit_limit ? money(c.credit_limit, cur) : '—'}</dd>
            <dt>العقد الساري</dt><dd>{c.active_contract ? <Link href={`/contracts/${c.active_contract.id}`}>{c.active_contract.code}</Link> : <span className="muted">لا يوجد (المهام تُسعّر يدويًا)</span>}</dd>
            {c.notes && <><dt>ملاحظات</dt><dd>{c.notes}</dd></>}
          </dl>
        </section>
        <section className="card">
          <div className="row spread"><h2>العقود</h2>{write && <Link className="btn small" href={`/contracts?new=1&customer=${c.id}`}>عقد جديد</Link>}</div>
          {contracts.data?.length === 0 ? <Empty>لا توجد عقود</Empty> : (
            <table><tbody>
              {contracts.data?.map((k) => (
                <tr key={k.id}><td><Link href={`/contracts/${k.id}`}>{k.code}</Link></td><td>من <span className="num">{day(k.starts_on)}</span> إلى {k.ends_on ? <span className="num">{day(k.ends_on)}</span> : 'غير محدد'}</td><td><Tone map={CONTRACT_STATUS} value={k.status} /></td></tr>
              ))}
            </tbody></table>
          )}
        </section>
      </div>
      <section className="card">
        <div className="row spread"><h2>المواقع ({c.sites.length})</h2>{write && <button className="small" onClick={() => setAddingSite(true)}>إضافة موقع</button>}</div>
        {c.sites.length === 0 ? <Empty>لا توجد مواقع (فروع، مستودعات، مواقع إنشاء)</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>الموقع</th><th>العنوان</th><th>جهة الاتصال</th><th>الإحداثيات</th></tr></thead>
            <tbody>{c.sites.map((s) => (
              <tr key={s.id} style={s.active ? undefined : { opacity: 0.5 }}>
                <td>{s.name}</td><td>{s.address ?? '—'}</td>
                <td>{s.contact_name ?? '—'} {s.contact_phone && <span className="muted num">{s.contact_phone}</span>}</td>
                <td className="num">{s.lat != null ? `${s.lat.toFixed(5)}, ${s.lng!.toFixed(5)}` : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {editing && <CustomerForm customer={c} onClose={() => setEditing(false)} onDone={() => { setEditing(false); void cu.reload(); }} />}
      {addingSite && <SiteForm customerId={c.id} onClose={() => setAddingSite(false)} onDone={() => { setAddingSite(false); void cu.reload(); }} />}
    </div>
  );
}

function SiteForm({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: () => void }) {
  const { f, bind } = useForm({ name: '', address: '', lat: '', lng: '', contact_name: '', contact_phone: '' });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const pos = f.lat && f.lng ? { lat: Number(f.lat), lng: Number(f.lng) } : {};
      await api(`/customers/${customerId}/sites`, { method: 'POST', body: { ...clean({ name: f.name, address: f.address, contact_name: f.contact_name, contact_phone: f.contact_phone }), ...pos } });
      onDone();
    });
  };
  return (
    <Modal title="إضافة موقع" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">اسم الموقع<input {...bind('name')} required maxLength={200} /></label>
        <label className="field">العنوان<input {...bind('address')} maxLength={500} /></label>
        <div className="form-2">
          <label className="field">خط العرض<input {...bind('lat')} className="num" inputMode="decimal" placeholder="29.3759" /></label>
          <label className="field">خط الطول<input {...bind('lng')} className="num" inputMode="decimal" placeholder="47.9774" /></label>
          <label className="field">جهة الاتصال<input {...bind('contact_name')} maxLength={120} /></label>
          <label className="field">جوال جهة الاتصال<input {...bind('contact_phone')} className="num" inputMode="tel" /></label>
        </div>
        <div className="row"><button className="primary" disabled={busy}>حفظ</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}
