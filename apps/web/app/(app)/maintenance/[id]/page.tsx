'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { dt, LINE_KIND, money, WO_KIND, WO_STATUS } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, Empty, ErrorBox, Tone, useAction, useForm, useLoad } from '@/components/ui';

interface Line { id: string; kind: string; description: string; qty: number; unit_cost: string; amount: string }
interface Wo {
  id: string; number: string; asset_id: string; plate_no: string | null; kind: string; status: string; out_of_service: boolean;
  description: string | null; vendor: string | null; odometer_km: number | null; opened_at: string; closed_at: string | null; total_cost: string; lines: Line[];
}

export default function WorkOrder() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const wo = useLoad(() => api<Wo>(`/work-orders/${id}`), [id]);
  const act = useAction();
  const line = useForm({ kind: 'part', description: '', qty: '1', unit_cost: '' });
  const odo = useForm({ odometer_km: '' });
  const w = wo.data;
  if (!w) return <div className="page"><ErrorBox error={wo.error} />{!wo.error && <p className="muted">جارٍ التحميل…</p>}</div>;
  const cur = me.legal_entities[0]?.currency ?? 'KWD';
  const open = w.status === 'open' || w.status === 'in_progress';
  const write = can(me, 'fleet:write') && open;
  const post = (path: string, body?: unknown) => act.run(async () => { await api(`/work-orders/${w.id}/${path}`, { method: 'POST', body }); await wo.reload(); });
  const addLine = (e: React.FormEvent) => {
    e.preventDefault();
    void post('lines', { kind: line.f.kind, description: line.f.description, qty: Number(line.f.qty), unit_cost: line.f.unit_cost })
      .then((ok) => ok && line.setF({ ...line.f, description: '', qty: '1', unit_cost: '' }));
  };
  return (
    <div className="page stack">
      <div className="page-head">
        <div className="row"><Link href="/maintenance" className="muted">الصيانة ‹</Link><h1 className="num">{w.number}</h1><Tone map={WO_STATUS} value={w.status} />
          {w.out_of_service && open && <Badge tone="danger">المركبة خارج الخدمة</Badge>}</div>
        {write && <div className="row">
          {w.status === 'open' && <button disabled={act.busy} onClick={() => post('start')}>بدء العمل</button>}
          <button className="danger" disabled={act.busy} onClick={() => post('cancel')}>إلغاء الأمر</button>
        </div>}
      </div>
      <ErrorBox error={act.error} />
      <section className="card">
        <dl className="dl">
          <dt>المركبة</dt><dd className="num">{w.plate_no ?? '—'}</dd>
          <dt>النوع</dt><dd>{WO_KIND[w.kind] ?? w.kind}</dd>
          <dt>الورشة</dt><dd>{w.vendor ?? '—'}</dd>
          <dt>الوصف</dt><dd>{w.description ?? '—'}</dd>
          <dt>العداد</dt><dd className="num">{w.odometer_km?.toLocaleString('en-US') ?? '—'}</dd>
          <dt>فُتح</dt><dd className="num">{dt(w.opened_at)}</dd>
          {w.closed_at && <><dt>أُغلق</dt><dd className="num">{dt(w.closed_at)}</dd></>}
        </dl>
      </section>
      <section className="card stack">
        <h2>بنود التكلفة</h2>
        {w.lines.length === 0 ? <Empty>لا توجد بنود</Empty> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>النوع</th><th>الوصف</th><th>الكمية</th><th>سعر الوحدة</th><th>المبلغ</th></tr></thead>
            <tbody>
              {w.lines.map((l) => <tr key={l.id}><td>{LINE_KIND[l.kind] ?? l.kind}</td><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{money(l.unit_cost, cur)}</td><td className="num">{money(l.amount, cur)}</td></tr>)}
              <tr><td colSpan={4}><strong>الإجمالي</strong></td><td className="num"><strong>{money(w.total_cost, cur)}</strong></td></tr>
            </tbody>
          </table></div>
        )}
        {write && (
          <form className="form-2" onSubmit={addLine}>
            <label className="field">النوع<select {...line.bind('kind')}>{Object.entries(LINE_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">الوصف<input {...line.bind('description')} required maxLength={200} /></label>
            <label className="field">الكمية<input {...line.bind('qty')} type="number" min={0.001} step="any" className="num" required /></label>
            <label className="field">سعر الوحدة<input {...line.bind('unit_cost')} inputMode="decimal" className="num" required placeholder="0.000" /></label>
            <div><button disabled={act.busy}>إضافة بند</button></div>
          </form>
        )}
      </section>
      {write && (
        <section className="card">
          <h2>إغلاق الأمر</h2>
          <p className="muted">عند الإنجاز يُسجَّل إجمالي البنود مصروف صيانة معتمدًا ويُقيَّد في الدفاتر، ويُحدَّث عداد المركبة وخطة الصيانة، وتعود المركبة للخدمة.</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void post('complete', odo.f.odometer_km ? { odometer_km: Number(odo.f.odometer_km) } : {}); }} style={{ alignItems: 'end' }}>
            <label className="field">العداد عند الإنجاز (اختياري)<input {...odo.bind('odometer_km')} type="number" min={0} className="num" /></label>
            <button className="primary" disabled={act.busy}>تم الإنجاز</button>
          </form>
        </section>
      )}
    </div>
  );
}
