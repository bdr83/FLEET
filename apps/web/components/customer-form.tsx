'use client';
import { api } from '@/lib/api';
import { CUSTOMER_STATUS } from '@/lib/format';
import { useMe } from '@/components/me';
import { clean, ErrorBox, Modal, useAction, useForm } from '@/components/ui';

export interface Customer {
  id: string; legal_entity_id: string; ref: string | null; kind: string; name: string; phone: string | null; email: string | null;
  cr_number: string | null; payment_terms_days: number; credit_limit: string | null; status: string; notes: string | null; created_at: string;
}

export function currencyOf(me: ReturnType<typeof useMe>, le: string) {
  return me.legal_entities.find((l) => l.id === le)?.currency ?? 'KWD';
}

export function CustomerForm({ customer, onClose, onDone }: { customer?: Customer; onClose: () => void; onDone: (c: Customer) => void }) {
  const me = useMe();
  const { f, bind } = useForm({
    legal_entity_id: customer?.legal_entity_id ?? me.legal_entities[0]?.id ?? '', kind: customer?.kind ?? 'business',
    name: customer?.name ?? '', ref: customer?.ref ?? '', phone: customer?.phone ?? '', email: customer?.email ?? '',
    cr_number: customer?.cr_number ?? '', payment_terms_days: String(customer?.payment_terms_days ?? 30),
    credit_limit: customer?.credit_limit ?? '', notes: customer?.notes ?? '', status: customer?.status ?? 'active',
  });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const common = clean({
        name: f.name, phone: f.phone, email: f.email, notes: f.notes, credit_limit: f.credit_limit,
        payment_terms_days: f.payment_terms_days === '' ? '' : Number(f.payment_terms_days),
      });
      const c = customer
        ? await api<Customer>(`/customers/${customer.id}`, { method: 'PATCH', body: { ...common, status: f.status } })
        : await api<Customer>('/customers', { method: 'POST', body: { ...common, ...clean({ legal_entity_id: f.legal_entity_id, kind: f.kind, ref: f.ref, cr_number: f.cr_number }) } });
      onDone(c);
    });
  };
  return (
    <Modal title={customer ? `تعديل ${customer.name}` : 'إضافة عميل'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-2">
          {!customer && me.legal_entities.length > 1 && (
            <label className="field">الشركة القانونية<select {...bind('legal_entity_id')}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          )}
          <label className="field">الاسم<input {...bind('name')} required maxLength={200} /></label>
          {!customer && <>
            <label className="field">النوع<select {...bind('kind')}><option value="business">شركة</option><option value="individual">فرد</option></select></label>
            <label className="field">المرجع<input {...bind('ref')} className="num" maxLength={40} /></label>
            <label className="field">السجل التجاري<input {...bind('cr_number')} className="num" maxLength={40} /></label>
          </>}
          <label className="field">الجوال<input {...bind('phone')} className="num" inputMode="tel" /></label>
          <label className="field">البريد<input {...bind('email')} type="email" className="num" maxLength={200} /></label>
          <label className="field">مدة السداد (أيام)<input {...bind('payment_terms_days')} type="number" min={0} max={365} className="num" /></label>
          <label className="field">حد الائتمان<input {...bind('credit_limit')} inputMode="decimal" className="num" placeholder="0.000" /></label>
          {customer && (
            <label className="field">الحالة<select {...bind('status')}>{Object.entries(CUSTOMER_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</select></label>
          )}
        </div>
        <label className="field">ملاحظات<textarea {...bind('notes')} rows={2} maxLength={2000} /></label>
        <div className="row"><button className="primary" disabled={busy}>حفظ</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}
