'use client';
import { api } from '@/lib/api';
import { day, DOC_TYPE } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Badge, clean, ErrorBox, useAction, useForm, useLoad } from '@/components/ui';

export interface Doc { id: string; doc_type: string; number: string | null; issued_on: string | null; expires_on: string | null; asset_id: string | null; worker_id: string | null }

/** Days until a yyyy-mm-dd date, counted in whole days. */
export function daysLeft(d: string | null) {
  if (!d) return null;
  return Math.round((new Date(`${d}T00:00:00Z`).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86_400_000);
}
export function ExpiryBadge({ date }: { date: string | null }) {
  const n = daysLeft(date);
  if (n === null) return <span className="muted">بلا انتهاء</span>;
  if (n < 0) return <Badge tone="danger">منتهية منذ {-n} يوم</Badge>;
  if (n <= 30) return <Badge tone="warning">تنتهي خلال {n} يوم</Badge>;
  return <span className="num">{day(date)}</span>;
}

/** Documents of one vehicle or driver, with add and archive. */
export function DocsPanel({ owner }: { owner: { asset_id?: string; worker_id?: string } }) {
  const me = useMe();
  const qs = new URLSearchParams(owner as Record<string, string>);
  const docs = useLoad(() => api<{ data: Doc[] }>(`/documents?${qs}`).then((r) => r.data), [qs.toString()]);
  const { f, bind, setF } = useForm({ doc_type: owner.asset_id ? 'vehicle_registration' : 'driving_license', number: '', issued_on: '', expires_on: '' });
  const act = useAction();
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await api('/documents', { method: 'POST', body: { ...owner, ...clean(f) } });
      setF({ ...f, number: '', issued_on: '', expires_on: '' });
      await docs.reload();
    });
  };
  const archive = (id: string) => act.run(async () => { await api(`/documents/${id}`, { method: 'DELETE' }); await docs.reload(); });
  return (
    <section className="stack" style={{ marginTop: 20 }}>
      <h2>الوثائق</h2>
      <ErrorBox error={act.error ?? docs.error} />
      {docs.data?.length === 0 && <p className="muted">لا توجد وثائق</p>}
      {docs.data?.map((d) => (
        <div key={d.id} className="row spread" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
          <span>{DOC_TYPE[d.doc_type] ?? d.doc_type} {d.number && <span className="muted num">· {d.number}</span>}</span>
          <span className="row"><ExpiryBadge date={d.expires_on} />
            {can(me, 'fleet:write') && <button className="small" onClick={() => archive(d.id)} disabled={act.busy}>أرشفة</button>}</span>
        </div>
      ))}
      {can(me, 'fleet:write') && (
        <form className="form-2" onSubmit={add}>
          <label className="field">نوع الوثيقة<select {...bind('doc_type')}>{Object.entries(DOC_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">الرقم<input {...bind('number')} className="num" maxLength={60} /></label>
          <label className="field">تاريخ الإصدار<input {...bind('issued_on')} type="date" /></label>
          <label className="field">تاريخ الانتهاء<input {...bind('expires_on')} type="date" /></label>
          <div><button disabled={act.busy}>إضافة وثيقة</button></div>
        </form>
      )}
    </section>
  );
}
