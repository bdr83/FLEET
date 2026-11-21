'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { day, money, PAY_METHOD, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, Empty, ErrorBox, Modal, Tabs, useAction, useForm, useLoad } from '@/components/ui';

type Tab = 'aging' | 'payments' | 'statement' | 'cod' | 'trial';

function Receivables() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get('tab') as Tab) ?? (params.get('customer') ? 'statement' : 'aging');
  const setTab = (t: Tab) => router.replace(`/receivables?tab=${t}`);
  return (
    <div className="page stack">
      <div className="page-head"><h1>الذمم والتحصيل</h1></div>
      <Tabs<Tab> tabs={[['aging', 'أعمار الذمم'], ['payments', 'الدفعات'], ['statement', 'كشف حساب'], ['cod', 'التحصيل عند الاستلام'], ['trial', 'ميزان المراجعة']]} value={tab} onChange={setTab} />
      {tab === 'aging' && <Aging />}
      {tab === 'payments' && <Payments payFor={params.get('pay')} invoiceId={params.get('invoice')} />}
      {tab === 'statement' && <Statement initial={params.get('customer') ?? ''} />}
      {tab === 'cod' && <Cod />}
      {tab === 'trial' && <Trial />}
    </div>
  );
}

interface AgingRow { customer_id: string; name: string; currency: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string; total_due: string; credit: string; credit_limit: string | null; over_limit: boolean }
function Aging() {
  const r = useLoad(() => api<{ as_of: string; data: AgingRow[] }>('/receivables/aging'));
  const m = (v: string, c: string) => (Number(v) ? money(v, c) : '—');
  return <>
    <ErrorBox error={r.error} />
    {r.data && <p className="muted" style={{ margin: 0 }}>حتى تاريخ <span className="num">{day(r.data.as_of)}</span>، بالأيام بعد تاريخ الاستحقاق.</p>}
    {r.data?.data.length === 0 ? <Empty>لا توجد ذمم مفتوحة</Empty> : (
      <div className="tbl-wrap"><table>
        <thead><tr><th>العميل</th><th>غير مستحق</th><th>1–30</th><th>31–60</th><th>61–90</th><th>+90</th><th>الإجمالي</th><th>رصيد دائن</th></tr></thead>
        <tbody>{r.data?.data.map((a) => (
          <tr key={a.customer_id}>
            <td><Link href={`/receivables?tab=statement&customer=${a.customer_id}`}>{a.name}</Link>{a.over_limit && <> <Badge tone="danger">تجاوز حد الائتمان</Badge></>}</td>
            <td className="num">{m(a.current, a.currency)}</td><td className="num">{m(a.d1_30, a.currency)}</td><td className="num">{m(a.d31_60, a.currency)}</td>
            <td className="num">{m(a.d61_90, a.currency)}</td><td className="num" style={Number(a.d90_plus) ? { color: 'var(--danger)' } : undefined}>{m(a.d90_plus, a.currency)}</td>
            <td className="num"><strong>{money(a.total_due, a.currency)}</strong></td><td className="num">{m(a.credit, a.currency)}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )}
  </>;
}

interface Payment { id: string; customer_id: string; customer_name: string; amount: string; currency: string; received_on: string; method: string; reference: string | null; status: string; unallocated: string }
function Payments({ payFor, invoiceId }: { payFor: string | null; invoiceId: string | null }) {
  const me = useMe();
  const list = useLoad(() => api<{ data: Payment[] }>('/payments').then((r) => r.data));
  const [adding, setAdding] = useState(!!payFor);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const write = can(me, 'billing:write');
  return <>
    {write && <div><button className="primary" onClick={() => setAdding(true)}>تسجيل دفعة</button></div>}
    <ErrorBox error={list.error} />
    {list.data?.length === 0 ? <Empty>لا توجد دفعات</Empty> : (
      <div className="tbl-wrap"><table>
        <thead><tr><th>التاريخ</th><th>العميل</th><th>المبلغ</th><th>الطريقة</th><th>المرجع</th><th>غير مخصّص</th><th>الحالة</th><th></th></tr></thead>
        <tbody>{list.data?.map((p) => (
          <tr key={p.id} style={p.status === 'reversed' ? { opacity: 0.55 } : undefined}>
            <td className="num">{day(p.received_on)}</td><td>{p.customer_name}</td><td className="num">{money(p.amount, p.currency)}</td>
            <td>{PAY_METHOD[p.method] ?? p.method}</td><td className="num">{p.reference ?? '—'}</td>
            <td className="num">{Number(p.unallocated) ? money(p.unallocated, p.currency) : '—'}</td>
            <td>{p.status === 'reversed' ? <Badge tone="danger">معكوسة</Badge> : <Badge tone="success">مرحّلة</Badge>}</td>
            <td>{write && p.status === 'posted' && <button className="small" onClick={() => setReversing(p)}>عكس</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )}
    {adding && <AddPayment customerId={payFor ?? ''} invoiceId={invoiceId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void list.reload(); }} />}
    {reversing && <Reverse p={reversing} onClose={() => setReversing(null)} onDone={() => { setReversing(null); void list.reload(); }} />}
  </>;
}

function AddPayment({ customerId, invoiceId, onClose, onDone }: { customerId: string; invoiceId: string | null; onClose: () => void; onDone: () => void }) {
  const customers = useLoad(() => api<{ data: { id: string; name: string }[] }>('/customers').then((r) => r.data));
  const { f, bind } = useForm({ customer_id: customerId, amount: '', method: 'bank_transfer', received_on: todayKw(), reference: '', notes: '' });
  const open = useLoad(() => f.customer_id
    ? api<{ data: { id: string; number: string; balance: string; currency: string; status: string; due_date: string }[] }>(`/invoices?customer_id=${f.customer_id}`).then((r) => r.data.filter((i) => i.status === 'issued' || i.status === 'partially_paid'))
    : Promise.resolve([]), [f.customer_id]);
  const [target, setTarget] = useState(invoiceId ?? '');
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const inv = open.data?.find((i) => i.id === target);
      const allocations = inv ? [{ invoice_id: inv.id, amount: Math.min(Number(f.amount), Number(inv.balance)).toFixed(3) }] : undefined;
      await api('/payments', { method: 'POST', body: { ...clean(f), allocations } });
      onDone();
    });
  };
  return (
    <Modal title="تسجيل دفعة" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">العميل<select {...bind('customer_id')} required><option value="">اختر</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <div className="form-2">
          <label className="field">المبلغ<input {...bind('amount')} inputMode="decimal" className="num" required placeholder="0.000" /></label>
          <label className="field">الطريقة<select {...bind('method')}>{Object.entries(PAY_METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">تاريخ الاستلام<input {...bind('received_on')} type="date" required /></label>
          <label className="field">المرجع (رقم التحويل أو الشيك)<input {...bind('reference')} className="num" maxLength={100} /></label>
        </div>
        <label className="field">تخصيص الدفعة
          <select name="target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">تلقائي: الأقدم استحقاقًا أولًا</option>
            {open.data?.map((i) => <option key={i.id} value={i.id}>{i.number} · متبقٍ {money(i.balance, i.currency)}</option>)}
          </select>
        </label>
        <p className="muted" style={{ margin: 0 }}>ما يزيد عن المستحق يبقى رصيدًا دائنًا للعميل.</p>
        <div className="row"><button className="primary" disabled={busy}>تسجيل</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}

function Reverse({ p, onClose, onDone }: { p: Payment; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title={`عكس دفعة ${money(p.amount, p.currency)}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/payments/${p.id}/reverse`, { method: 'POST', body: { reason } }); onDone(); }); }}>
        <ErrorBox error={error} />
        <p className="muted" style={{ margin: 0 }}>للشيك المرتجع أو القيد الخاطئ: يُعكس القيد وتعود الفواتير مفتوحة.</p>
        <label className="field">السبب<textarea name="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} /></label>
        <div className="row"><button className="danger" disabled={busy || !reason.trim()}>عكس</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}

interface Stmt { customer: { name: string }; currency: string; opening: string; closing: string; lines: { date: string; type: string; memo: string | null; debit: string | null; credit: string | null; balance: string }[] }
const SOURCE: Record<string, string> = { invoice: 'فاتورة', payment: 'دفعة', invoice_void: 'إلغاء فاتورة', payment_reverse: 'عكس دفعة' };
function Statement({ initial }: { initial: string }) {
  const customers = useLoad(() => api<{ data: { id: string; name: string }[] }>('/customers').then((r) => r.data));
  const today = todayKw();
  const { f, bind } = useForm({ customer_id: initial, from: `${today.slice(0, 4)}-01-01`, to: today });
  const s = useLoad(() => f.customer_id ? api<Stmt>(`/customers/${f.customer_id}/statement?from=${f.from}&to=${f.to}`) : Promise.resolve(null), [f.customer_id, f.from, f.to]);
  return <>
    <div className="row no-print">
      <select {...bind('customer_id')} aria-label="العميل" style={{ width: 'auto' }}><option value="">اختر العميل</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <input {...bind('from')} type="date" aria-label="من" style={{ width: 'auto' }} />
      <input {...bind('to')} type="date" aria-label="إلى" style={{ width: 'auto' }} />
      {s.data && <button onClick={() => window.print()}>طباعة</button>}
    </div>
    <ErrorBox error={s.error} />
    {s.data && (
      <section className="card stack">
        <h2>كشف حساب: {s.data.customer.name}</h2>
        <div className="tbl-wrap"><table>
          <thead><tr><th>التاريخ</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
          <tbody>
            <tr><td colSpan={4}>رصيد أول المدة</td><td className="num">{money(s.data.opening, s.data.currency)}</td></tr>
            {s.data.lines.map((l, i) => (
              <tr key={i}><td className="num">{day(l.date)}</td><td>{SOURCE[l.type] ?? l.type} {l.memo && <span className="muted num">{l.memo}</span>}</td>
                <td className="num">{l.debit ? money(l.debit, s.data!.currency) : ''}</td><td className="num">{l.credit ? money(l.credit, s.data!.currency) : ''}</td><td className="num">{money(l.balance, s.data!.currency)}</td></tr>
            ))}
            <tr><td colSpan={4}><strong>الرصيد الختامي</strong></td><td className="num"><strong>{money(s.data.closing, s.data.currency)}</strong></td></tr>
          </tbody>
        </table></div>
      </section>
    )}
  </>;
}

function Cod() {
  const me = useMe();
  const custody = useLoad(() => api<{ data: { worker_id: string; display_name: string; currency: string; held: string }[] }>('/cod/custody').then((r) => r.data));
  const payable = useLoad(() => api<{ data: { customer_id: string; name: string; currency: string; owed: string }[] }>('/cod/payable').then((r) => r.data));
  const act = useAction();
  const [form, setForm] = useState<{ kind: 'deposit' | 'payout'; id: string; name: string; max: string; currency: string } | null>(null);
  const write = can(me, 'billing:write');
  return <>
    <p className="muted" style={{ margin: 0 }}>المنصة لا تحتفظ بأي أموال: هذه سجلات لأموال تحصّلها شركتك من المستلمين نيابة عن عملائها.</p>
    <ErrorBox error={custody.error ?? payable.error ?? act.error} />
    <div className="grid g2">
      <section className="card">
        <h2>نقد لدى السائقين</h2>
        {custody.data?.length === 0 ? <Empty>لا يوجد نقد غير مسلَّم</Empty> : (
          <table><tbody>{custody.data?.map((c) => (
            <tr key={c.worker_id}><td>{c.display_name}</td><td className="num">{money(c.held, c.currency)}</td>
              <td>{write && <button className="small" onClick={() => setForm({ kind: 'deposit', id: c.worker_id, name: c.display_name, max: c.held, currency: c.currency })}>استلام في المكتب</button>}</td></tr>
          ))}</tbody></table>
        )}
      </section>
      <section className="card">
        <h2>مستحق للعملاء (التجار)</h2>
        {payable.data?.length === 0 ? <Empty>لا يوجد مستحق</Empty> : (
          <table><tbody>{payable.data?.map((p) => (
            <tr key={p.customer_id}><td>{p.name}</td><td className="num">{money(p.owed, p.currency)}</td>
              <td>{write && <button className="small" onClick={() => setForm({ kind: 'payout', id: p.customer_id, name: p.name, max: p.owed, currency: p.currency })}>تحويل للعميل</button>}</td></tr>
          ))}</tbody></table>
        )}
      </section>
    </div>
    {form && <CodForm {...form} onClose={() => setForm(null)} onDone={() => { setForm(null); void custody.reload(); void payable.reload(); }} />}
  </>;
}

function CodForm({ kind, id, name, max, currency, onClose, onDone }: { kind: 'deposit' | 'payout'; id: string; name: string; max: string; currency: string; onClose: () => void; onDone: () => void }) {
  const { f, bind } = useForm({ amount: max, reference: '' });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(kind === 'deposit' ? '/cod/deposits' : '/cod/payouts', { method: 'POST', body: clean({ [kind === 'deposit' ? 'worker_id' : 'customer_id']: id, amount: f.amount, reference: f.reference }) });
      onDone();
    });
  };
  return (
    <Modal title={kind === 'deposit' ? `استلام نقد من ${name}` : `تحويل مبالغ التحصيل إلى ${name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">المبلغ (الحد الأقصى {money(max, currency)})<input {...bind('amount')} inputMode="decimal" className="num" required /></label>
        <label className="field">المرجع<input {...bind('reference')} className="num" maxLength={100} /></label>
        <div className="row"><button className="primary" disabled={busy}>تأكيد</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}

interface TB { currency: string; accounts: { account: string; name: string; debit: string | null; credit: string | null }[]; total_debit: string; total_credit: string }
function Trial() {
  const me = useMe();
  const [le, setLe] = useState(me.legal_entities[0]?.id ?? '');
  const tb = useLoad(() => le ? api<TB>(`/ledger/trial-balance?legal_entity_id=${le}`) : Promise.resolve(null), [le]);
  return <>
    {me.legal_entities.length > 1 && <select aria-label="الشركة القانونية" value={le} onChange={(e) => setLe(e.target.value)} style={{ width: 'auto' }}>{me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
    <p className="muted" style={{ margin: 0 }}>دليل الحسابات المبدئي يحتاج مراجعة محاسبكم [تخمين].</p>
    <ErrorBox error={tb.error} />
    {tb.data && (tb.data.accounts.length === 0 ? <Empty>لا توجد قيود بعد</Empty> : (
      <div className="tbl-wrap"><table>
        <thead><tr><th>الحساب</th><th>الاسم</th><th>مدين</th><th>دائن</th></tr></thead>
        <tbody>
          {tb.data.accounts.map((a) => <tr key={a.account}><td className="num">{a.account}</td><td>{a.name}</td><td className="num">{a.debit ? money(a.debit, tb.data!.currency) : ''}</td><td className="num">{a.credit ? money(a.credit, tb.data!.currency) : ''}</td></tr>)}
          <tr><td colSpan={2}><strong>الإجمالي</strong></td><td className="num"><strong>{money(tb.data.total_debit, tb.data.currency)}</strong></td><td className="num"><strong>{money(tb.data.total_credit, tb.data.currency)}</strong></td></tr>
        </tbody>
      </table></div>
    ))}
  </>;
}

export default function Page() { return <Suspense><Receivables /></Suspense>; }
