'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { day, INVOICE_STATUS, money, PAY_METHOD, UNIT } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Empty, ErrorBox, Modal, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Line { id: string; task_id: string | null; description: string; unit: string; qty: number; unit_price: string; amount: string }
interface Invoice {
  id: string; legal_entity_id: string; customer_id: string; customer_name: string; number: string | null; status: string; currency: string;
  period_from: string | null; period_to: string | null; issue_date: string | null; due_date: string | null;
  subtotal: string; tax_rate: number; tax_amount: string; total: string; paid_amount: string; balance: string; notes: string | null; void_reason: string | null;
  lines: Line[]; payments: { id: string; received_on: string; method: string; reference: string | null; amount: string }[];
}

function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const skipped = Number(useSearchParams().get('skipped') ?? 0);
  const me = useMe();
  const inv = useLoad(() => api<Invoice>(`/invoices/${id}`), [id]);
  const act = useAction();
  const line = useForm({ description: '', qty: '1', unit_price: '' });
  const [voiding, setVoiding] = useState(false);
  const i = inv.data;
  if (!i) return <div className="page"><ErrorBox error={inv.error} />{!inv.error && <p className="muted">جارٍ التحميل…</p>}</div>;
  const write = can(me, 'billing:write');
  const draft = i.status === 'draft';
  const le = me.legal_entities.find((l) => l.id === i.legal_entity_id);
  const post = (path: string, body?: unknown) => act.run(async () => { await api(`/invoices/${i.id}/${path}`, { method: 'POST', body }); await inv.reload(); });
  const addLine = (e: React.FormEvent) => {
    e.preventDefault();
    void post('lines', { description: line.f.description, qty: Number(line.f.qty), unit_price: line.f.unit_price })
      .then((ok) => ok && line.setF({ description: '', qty: '1', unit_price: '' }));
  };
  return (
    <div className="page stack">
      <div className="page-head no-print">
        <div className="row"><Link href="/invoices" className="muted">الفواتير ‹</Link><h1 className="num">{i.number ?? 'مسودة فاتورة'}</h1><Tone map={INVOICE_STATUS} value={i.status} /></div>
        <div className="row">
          {!draft && <button onClick={() => window.print()}>طباعة / PDF</button>}
          {write && draft && <button className="primary" disabled={act.busy || i.lines.length === 0} onClick={() => post('issue')}>إصدار الفاتورة</button>}
          {write && (i.status === 'issued' || draft) && <button className="danger" disabled={act.busy} onClick={() => setVoiding(true)}>إلغاء</button>}
        </div>
      </div>
      <ErrorBox error={act.error} />
      {draft && skipped > 0 && <div className="alert no-print">{skipped} مهمة لم تُضف لأنها بلا عقد أو بوحدة غير مسعّرة. راجع عقد العميل أو أضف بندًا يدويًا.</div>}
      {draft && <div className="alert ok no-print">المسودة قابلة للتعديل. عند الإصدار تأخذ رقمًا متسلسلًا وتُقيَّد في الدفاتر، ولا تُعدّل بعدها (تُلغى فقط).</div>}
      {i.void_reason && <div className="alert">سبب الإلغاء: {i.void_reason}</div>}
      <section className="card stack">
        <div className="row spread" style={{ alignItems: 'start' }}>
          <div><h2 style={{ marginBottom: 4 }}>{le?.name ?? me.tenant_name}</h2><div className="muted">فاتورة</div></div>
          <dl className="dl">
            <dt>رقم الفاتورة</dt><dd className="num">{i.number ?? '—'}</dd>
            <dt>تاريخ الإصدار</dt><dd className="num">{day(i.issue_date)}</dd>
            <dt>تاريخ الاستحقاق</dt><dd className="num">{day(i.due_date)}</dd>
          </dl>
        </div>
        <dl className="dl">
          <dt>العميل</dt><dd><Link href={`/customers/${i.customer_id}`}>{i.customer_name}</Link></dd>
          <dt>الفترة</dt><dd>من <span className="num">{day(i.period_from)}</span> إلى <span className="num">{day(i.period_to)}</span></dd>
        </dl>
        {i.lines.length === 0 ? <Empty>لا توجد بنود</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>البيان</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>المبلغ</th>{draft && write && <th className="no-print"></th>}</tr></thead>
            <tbody>
              {i.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td><td>{UNIT[l.unit] ?? (l.unit === 'item' ? 'بند' : l.unit)}</td><td className="num">{l.qty}</td>
                  <td className="num">{money(l.unit_price, i.currency)}</td><td className="num">{money(l.amount, i.currency)}</td>
                  {draft && write && <td className="no-print"><button className="small" disabled={act.busy} onClick={() => post(`lines/${l.id}/remove`)}>حذف</button></td>}
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <div style={{ marginInlineStart: 'auto', minWidth: 280 }}>
          <div className="row spread"><span>المجموع</span><span className="num">{money(i.subtotal, i.currency)}</span></div>
          {i.tax_rate > 0 && <div className="row spread"><span>الضريبة <span className="num">{i.tax_rate}%</span></span><span className="num">{money(i.tax_amount, i.currency)}</span></div>}
          <div className="row spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6 }}><strong>الإجمالي</strong><strong className="num">{money(i.total, i.currency)}</strong></div>
          {!draft && i.status !== 'void' && <>
            <div className="row spread"><span>المدفوع</span><span className="num">{money(i.paid_amount, i.currency)}</span></div>
            <div className="row spread"><strong>المتبقي</strong><strong className="num">{money(i.balance, i.currency)}</strong></div>
          </>}
        </div>
        {i.notes && <p>{i.notes}</p>}
      </section>
      {draft && write && (
        <section className="card no-print">
          <h2>بند يدوي</h2>
          <form className="form-2" onSubmit={addLine}>
            <label className="field">البيان<input {...line.bind('description')} required maxLength={300} placeholder="وقت انتظار، رسوم إضافية…" /></label>
            <label className="field">الكمية<input {...line.bind('qty')} type="number" min={0.001} step="any" className="num" required /></label>
            <label className="field">السعر<input {...line.bind('unit_price')} inputMode="decimal" className="num" required placeholder="0.000" /></label>
            <div><button disabled={act.busy}>إضافة</button></div>
          </form>
        </section>
      )}
      {i.payments.length > 0 && (
        <section className="card">
          <h2>الدفعات المخصّصة</h2>
          <table><tbody>{i.payments.map((p) => (
            <tr key={p.id}><td className="num">{day(p.received_on)}</td><td>{PAY_METHOD[p.method] ?? p.method}</td><td className="num">{p.reference ?? ''}</td><td className="num">{money(p.amount, i.currency)}</td></tr>
          ))}</tbody></table>
        </section>
      )}
      {write && ['issued', 'partially_paid'].includes(i.status) && (
        <div className="no-print"><Link className="btn primary" href={`/receivables?tab=payments&pay=${i.customer_id}&invoice=${i.id}`}>تسجيل دفعة لهذه الفاتورة</Link></div>
      )}
      {voiding && <VoidModal draft={draft} onClose={() => setVoiding(false)} onSubmit={async (reason) => { if (await post('void', { reason })) setVoiding(false); }} busy={act.busy} />}
    </div>
  );
}

function VoidModal({ draft, onClose, onSubmit, busy }: { draft: boolean; onClose: () => void; onSubmit: (r: string) => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={draft ? 'إلغاء المسودة' : 'إلغاء الفاتورة'} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }}>
        {!draft && <p className="muted" style={{ margin: 0 }}>يُعكس قيد الفاتورة في الدفاتر وتعود مهامها قابلة للفوترة. يبقى رقمها محفوظًا (لا فجوات في الترقيم).</p>}
        <label className="field">السبب<textarea name="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} /></label>
        <div className="row"><button className="danger" disabled={busy || !reason.trim()}>تأكيد الإلغاء</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}

export default function Page() { return <Suspense><InvoicePage /></Suspense>; }
