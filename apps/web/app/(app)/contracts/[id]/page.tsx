'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { CONTRACT_STATUS, day, money, PACKS, packLabel, UNIT } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { clean, Empty, ErrorBox, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Rate { id: string; sector_pack: string | null; unit: string; price: string; included_qty: number; min_charge: string; description: string | null }
interface Contract {
  id: string; customer_id: string; customer_name: string; code: string; starts_on: string; ends_on: string | null; status: string;
  currency: string; payment_terms_days: number; notes: string | null; rates: Rate[];
}
interface Quote { currency: string; total: string; unpriced: string[]; lines: { unit: string; qty: number; billable_qty: number; unit_price: string; amount: string }[] }

const ACTIONS: { key: string; label: string; from: string[]; tone?: string }[] = [
  { key: 'activate', label: 'تفعيل العقد', from: ['draft'], tone: 'primary' },
  { key: 'suspend', label: 'تعليق', from: ['active'] },
  { key: 'resume', label: 'استئناف', from: ['suspended'], tone: 'primary' },
  { key: 'end', label: 'إنهاء العقد', from: ['active', 'suspended'], tone: 'danger' },
];

export default function ContractDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const k = useLoad(() => api<Contract>(`/contracts/${id}`), [id]);
  const act = useAction();
  const c = k.data;
  if (!c) return <div className="page"><ErrorBox error={k.error} />{!k.error && <p className="muted">جارٍ التحميل…</p>}</div>;
  const write = can(me, 'customers:write');
  const draft = c.status === 'draft';
  const go = (a: string) => act.run(async () => { k.setData(await api<Contract>(`/contracts/${c.id}/${a}`, { method: 'POST' })); });
  const removeRate = (rid: string) => act.run(async () => { await api(`/contracts/${c.id}/rates/${rid}`, { method: 'DELETE' }); await k.reload(); });
  return (
    <div className="page stack">
      <div className="page-head">
        <div className="row"><Link href="/contracts" className="muted">العقود ‹</Link><h1 className="num">{c.code}</h1><Tone map={CONTRACT_STATUS} value={c.status} /></div>
        {write && <div className="row">{ACTIONS.filter((a) => a.from.includes(c.status)).map((a) => (
          <button key={a.key} className={a.tone} disabled={act.busy} onClick={() => go(a.key)}>{a.label}</button>
        ))}</div>}
      </div>
      <ErrorBox error={act.error} />
      <section className="card">
        <dl className="dl">
          <dt>العميل</dt><dd><Link href={`/customers/${c.customer_id}`}>{c.customer_name}</Link></dd>
          <dt>المدة</dt><dd>من <span className="num">{day(c.starts_on)}</span> إلى {c.ends_on ? <span className="num">{day(c.ends_on)}</span> : 'غير محدد'}</dd>
          <dt>العملة</dt><dd>{c.currency}</dd>
          <dt>مدة السداد</dt><dd>{c.payment_terms_days ? `${c.payment_terms_days} يومًا` : 'فوري'}</dd>
          {c.notes && <><dt>ملاحظات</dt><dd>{c.notes}</dd></>}
        </dl>
      </section>
      <section className="card stack">
        <h2>قائمة الأسعار</h2>
        {!draft && <p className="muted" style={{ margin: 0 }}>الأسعار مجمّدة لأن العقد لم يعد مسودة.</p>}
        {c.rates.length === 0 ? <Empty>لا توجد أسعار بعد. أضف سعرًا واحدًا على الأقل قبل التفعيل.</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>نوع العمل</th><th>الوحدة</th><th>السعر</th><th>كمية مشمولة</th><th>حد أدنى</th><th>الوصف</th>{draft && write && <th></th>}</tr></thead>
            <tbody>{c.rates.map((r) => (
              <tr key={r.id}>
                <td>{r.sector_pack ? packLabel(r.sector_pack) : 'كل الأنواع'}</td><td>{UNIT[r.unit] ?? r.unit}</td>
                <td className="num">{money(r.price, c.currency)}</td><td className="num">{r.included_qty || '—'}</td>
                <td className="num">{Number(r.min_charge) ? money(r.min_charge, c.currency) : '—'}</td><td>{r.description ?? ''}</td>
                {draft && write && <td><button className="small" disabled={act.busy} onClick={() => removeRate(r.id)}>حذف</button></td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {draft && write && <RateForm contractId={c.id} onDone={(next) => k.setData(next)} />}
      </section>
      {c.rates.length > 0 && <QuoteBox contract={c} />}
    </div>
  );
}

function RateForm({ contractId, onDone }: { contractId: string; onDone: (c: Contract) => void }) {
  const { f, bind, setF } = useForm({ sector_pack: '', unit: 'task', price: '', included_qty: '', min_charge: '', description: '' });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      onDone(await api<Contract>(`/contracts/${contractId}/rates`, { method: 'POST', body: clean(f) }));
      setF({ ...f, price: '', included_qty: '', min_charge: '', description: '' });
    });
  };
  return (
    <form className="stack" onSubmit={submit}>
      <ErrorBox error={error} />
      <div className="form-2">
        <label className="field">نوع العمل<select {...bind('sector_pack')}><option value="">كل الأنواع</option>{Object.entries(PACKS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">الوحدة<select {...bind('unit')}>{Object.entries(UNIT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">السعر للوحدة<input {...bind('price')} className="num" inputMode="decimal" required placeholder="0.000" pattern="\d{1,15}(\.\d{1,3})?" /></label>
        <label className="field">كمية مشمولة بلا سعر<input {...bind('included_qty')} className="num" inputMode="decimal" placeholder="0" /></label>
        <label className="field">حد أدنى للمبلغ<input {...bind('min_charge')} className="num" inputMode="decimal" placeholder="0.000" /></label>
        <label className="field">الوصف<input {...bind('description')} maxLength={200} /></label>
      </div>
      <div><button disabled={busy}>إضافة السعر</button></div>
    </form>
  );
}

/** Price preview: what one task of a type with given quantities costs under this contract. */
function QuoteBox({ contract }: { contract: Contract }) {
  const units = [...new Set(contract.rates.map((r) => r.unit))];
  const [pack, setPack] = useState(contract.rates.find((r) => r.sector_pack)?.sector_pack ?? 'delivery@1');
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(units.map((u) => [u, u === 'task' ? '1' : ''])));
  const [quote, setQuote] = useState<Quote | null>(null);
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const quantities = Object.fromEntries(Object.entries(qty).filter(([, n]) => n !== '').map(([u, n]) => [u, Number(n)]));
    void run(async () => setQuote(await api<Quote>(`/contracts/${contract.id}/quote`, { method: 'POST', body: { sector_pack: pack, quantities } })));
  };
  return (
    <section className="card stack">
      <h2>حاسبة السعر</h2>
      <form className="row" onSubmit={submit} style={{ alignItems: 'end' }}>
        <label className="field">نوع العمل<select value={pack} onChange={(e) => setPack(e.target.value)}>{Object.entries(PACKS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {units.map((u) => (
          <label key={u} className="field" style={{ width: 110 }}>{UNIT[u] ?? u}<input className="num" inputMode="decimal" value={qty[u] ?? ''} onChange={(e) => setQty({ ...qty, [u]: e.target.value })} /></label>
        ))}
        <button disabled={busy}>احسب</button>
      </form>
      <ErrorBox error={error} />
      {quote && (
        <div>
          {quote.lines.map((l) => (
            <div key={l.unit} className="row spread"><span>{UNIT[l.unit] ?? l.unit}: <span className="num">{l.billable_qty} × {l.unit_price}</span></span><span className="num">{money(l.amount, quote.currency)}</span></div>
          ))}
          <div className="row spread" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}><strong>الإجمالي</strong><strong className="num">{money(quote.total, quote.currency)}</strong></div>
          {quote.unpriced.length > 0 && <div className="alert" style={{ marginTop: 8 }}>وحدات بلا سعر في العقد: {quote.unpriced.map((u) => UNIT[u] ?? u).join('، ')}</div>}
        </div>
      )}
    </section>
  );
}
