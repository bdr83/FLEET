'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { dt, EXPENSE_CAT, EXPENSE_STATUS, money } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { clean, Empty, ErrorBox, Modal, Tone, useAction, useAssets, useForm, useLoad } from '@/components/ui';

interface Expense {
  id: string; category: string; amount: string; currency: string; spent_at: string; asset_id: string | null; plate_no: string | null;
  worker_id: string | null; worker_name: string | null; work_order_id: string | null; liters: number | null; odometer_km: number | null;
  vendor: string | null; note: string | null; status: string; reject_reason: string | null;
}

/** Office entries are approved at once; drivers' claims from the app wait here for approval. Approved expenses post to the ledger. */
export default function ExpensesPage() {
  const me = useMe();
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const list = useLoad(() => api<{ totals: { currency: string; total: string }[]; data: Expense[] }>(`/expenses?${new URLSearchParams(clean({ status, category }) as Record<string, string>)}`), [status, category]);
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState<Expense | null>(null);
  const act = useAction();
  const write = can(me, 'fleet:write');
  const approve = (e: Expense) => act.run(async () => { await api(`/expenses/${e.id}/approve`, { method: 'POST' }); await list.reload(); });
  const pending = list.data?.data.filter((e) => e.status === 'submitted').length ?? 0;
  return (
    <div className="page stack">
      <div className="page-head">
        <h1>المصروفات</h1>
        {write && <button className="primary" onClick={() => setAdding(true)}>تسجيل مصروف</button>}
      </div>
      <div className="row">
        <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">كل الحالات</option>{Object.entries(EXPENSE_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <select aria-label="الفئة" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 'auto' }}>
          <option value="">كل الفئات</option>{Object.entries(EXPENSE_CAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {list.data?.totals.map((t) => <span key={t.currency} className="badge t-primary">الإجمالي: <span className="num">{money(t.total, t.currency)}</span></span>)}
        {pending > 0 && <span className="badge t-warning">{pending} بانتظار الاعتماد</span>}
      </div>
      <ErrorBox error={list.error ?? act.error} />
      {list.data?.data.length === 0 ? <Empty>لا توجد مصروفات</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>التاريخ</th><th>الفئة</th><th>المبلغ</th><th>المركبة</th><th>السائق</th><th>المورد / ملاحظة</th><th>الحالة</th><th></th></tr></thead>
          <tbody>{list.data?.data.map((e) => (
            <tr key={e.id}>
              <td className="num">{dt(e.spent_at)}</td>
              <td>{EXPENSE_CAT[e.category] ?? e.category}{e.liters != null && <span className="muted num"> · {e.liters} لتر</span>}</td>
              <td className="num">{money(e.amount, e.currency)}</td>
              <td className="num">{e.plate_no ?? '—'}</td><td>{e.worker_name ?? '—'}</td>
              <td>{[e.vendor, e.note].filter(Boolean).join(' · ') || '—'}</td>
              <td><Tone map={EXPENSE_STATUS} value={e.status} />{e.reject_reason && <div className="muted">{e.reject_reason}</div>}</td>
              <td>{write && e.status === 'submitted' && <span className="row">
                <button className="small primary" disabled={act.busy} onClick={() => approve(e)}>اعتماد</button>
                <button className="small" disabled={act.busy} onClick={() => setRejecting(e)}>رفض</button></span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {adding && <AddExpense onClose={() => setAdding(false)} onDone={() => { setAdding(false); void list.reload(); }} />}
      {rejecting && <Reject e={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); void list.reload(); }} />}
    </div>
  );
}

function AddExpense({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const assets = useAssets();
  const { f, bind } = useForm({ legal_entity_id: me.legal_entities[0]?.id ?? '', category: 'fuel', amount: '', asset_id: '', liters: '', odometer_km: '', vendor: '', note: '' });
  const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/expenses', {
        method: 'POST',
        body: clean({
          category: f.category, amount: f.amount, vendor: f.vendor, note: f.note,
          asset_id: f.asset_id, legal_entity_id: f.asset_id ? '' : f.legal_entity_id,
          liters: f.category === 'fuel' && f.liters ? Number(f.liters) : '', odometer_km: f.odometer_km ? Number(f.odometer_km) : '',
        }),
      });
      onDone();
    });
  };
  return (
    <Modal title="تسجيل مصروف" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-2">
          <label className="field">الفئة<select {...bind('category')}>{Object.entries(EXPENSE_CAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">المبلغ<input {...bind('amount')} inputMode="decimal" className="num" required placeholder="0.000" /></label>
          <label className="field">المركبة (اختياري)<select {...bind('asset_id')}><option value="">بدون مركبة</option>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.plate_no ?? a.id.slice(0, 8)}</option>)}</select></label>
          {f.category === 'fuel' && <label className="field">اللترات<input {...bind('liters')} type="number" min={0.01} step="any" className="num" /></label>}
          <label className="field">العداد (كم)<input {...bind('odometer_km')} type="number" min={0} className="num" /></label>
          <label className="field">المورد<input {...bind('vendor')} maxLength={200} /></label>
        </div>
        <label className="field">ملاحظة<textarea {...bind('note')} rows={2} maxLength={1000} /></label>
        <p className="muted" style={{ margin: 0 }}>المصروف الذي يسجّله المكتب يُعتمد فورًا ويُقيَّد في الدفاتر.</p>
        <div className="row"><button className="primary" disabled={busy}>حفظ</button><button type="button" onClick={onClose}>إلغاء</button></div>
      </form>
    </Modal>
  );
}

function Reject({ e, onClose, onDone }: { e: Expense; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title={`رفض مصروف ${money(e.amount, e.currency)}`} onClose={onClose}>
      <form className="form" onSubmit={(ev) => { ev.preventDefault(); void run(async () => { await api(`/expenses/${e.id}/reject`, { method: 'POST', body: { reason } }); onDone(); }); }}>
        <ErrorBox error={error} />
        <label className="field">السبب<textarea name="reason" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} required maxLength={300} /></label>
        <div className="row"><button className="danger" disabled={busy || !reason.trim()}>رفض</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}
