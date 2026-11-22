'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { dt, enabledPacks, packLabel, taskSummary, TASK_STATUS, todayKw } from '@/lib/format';
import { can, useMe } from '@/components/me';
import { Empty, ErrorBox, Modal, StatusBadge, useAction, useLoad } from '@/components/ui';

export interface Task {
  id: string; ref: string | null; legal_entity_id: string; branch_id: string | null; sector_pack: string; status: string;
  window_from: string | null; window_to: string | null; customer_id: string | null; customer_name: string | null;
  version: number; attributes: Record<string, unknown>; created_at: string;
  worker_id: string | null; worker_name: string | null; asset_id: string | null; plate_no: string | null;
}

function TasksPage() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [unassigned, setUnassigned] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(params.get('new') === '1');
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (unassigned) qs.set('unassigned', 'true');
  const list = useLoad(() => api<{ data: Task[] }>(`/tasks?${qs}`).then((r) => r.data), [status, unassigned]);
  const needle = q.trim().toLowerCase();
  const rows = (list.data ?? []).filter((t) => !needle
    || [t.ref, t.customer_name, t.worker_name, t.plate_no, taskSummary(t.attributes)].some((x) => x?.toLowerCase().includes(needle)));

  return (
    <div className="page stack">
      <div className="page-head">
        <h1>المهام</h1>
        {can(me, 'tasks:write') && <button className="primary" onClick={() => setCreating(true)}>مهمة جديدة</button>}
      </div>
      <div className="row">
        <input type="search" placeholder="بحث بالمرجع أو العميل أو السائق" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
        <select aria-label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">كل الحالات</option>
          {Object.entries(TASK_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <label className="row"><input type="checkbox" checked={unassigned} onChange={(e) => setUnassigned(e.target.checked)} style={{ width: 'auto' }} />غير مسندة فقط</label>
      </div>
      <ErrorBox error={list.error} />
      {list.data && rows.length === 0 ? <Empty>لا توجد مهام مطابقة</Empty> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>المرجع</th><th>النوع</th><th>الحالة</th><th>الموعد</th><th>العميل</th><th>التفاصيل</th><th>السائق</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} onClick={() => router.push(`/tasks/${t.id}`)} style={{ cursor: 'pointer' }}>
                <td><Link href={`/tasks/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.ref ?? t.id.slice(0, 8)}</Link></td>
                <td>{packLabel(t.sector_pack)}</td>
                <td><StatusBadge status={t.status} /></td>
                <td className="num">{dt(t.window_from)}</td>
                <td>{t.customer_name ?? '—'}</td>
                <td>{taskSummary(t.attributes)}</td>
                <td>{t.worker_name ?? <span className="muted">—</span>}{t.plate_no && <div className="muted num">{t.plate_no}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {creating && <CreateTask onClose={() => setCreating(false)} onDone={(id) => router.push(`/tasks/${id}`)} />}
    </div>
  );
}

/** Kuwait local date+time (yyyy-mm-ddThh:mm) → ISO with the +03:00 offset. Kuwait has no daylight saving. */
const kwIso = (local: string) => (local ? `${local}:00+03:00` : '');

function CreateTask({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const me = useMe();
  const customers = useLoad(() => can(me, 'customers:read')
    ? api<{ data: { id: string; name: string; status: string }[] }>('/customers').then((r) => r.data.filter((c) => c.status === 'active'))
    : Promise.resolve([]));
  const today = todayKw();
  const [f, setF] = useState({
    legal_entity_id: me.legal_entities[0]?.id ?? '', sector_pack: enabledPacks(me.packs)[0]?.[0] ?? 'delivery@1', ref: '', customer_id: '',
    from: `${today}T09:00`, to: `${today}T13:00`, address: '', recipient_name: '', recipient_phone: '', notes: '', draft: false,
    area: '', block: '', street: '', avenue: '', house: '', cod_amount: '', delivery_fee: '',
  });
  const delivery = f.sector_pack === 'delivery@1';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  const { busy, error, run } = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const attributes: Record<string, unknown> = {};
      if (f.notes) attributes.notes = f.notes;
      if (delivery) {
        // structured Kuwaiti address and recipient (validated by the delivery pack on the server)
        const pick = (keys: (keyof typeof f)[]) => Object.fromEntries(keys.filter((k) => f[k]).map((k) => [k, String(f[k]).trim()]));
        attributes.dropoff = pick(['area', 'block', 'street', 'avenue', 'house']);
        attributes.recipient = { name: f.recipient_name || undefined, phone: f.recipient_phone || undefined };
        if (f.cod_amount) attributes.cod_amount = f.cod_amount;
        if (f.delivery_fee) attributes.delivery_fee = f.delivery_fee;
        if (f.ref) attributes.external_order_id = f.ref;
      } else {
        if (f.address) attributes.address = f.address;
        if (f.recipient_name) attributes.recipient_name = f.recipient_name;
        if (f.recipient_phone) attributes.recipient_phone = f.recipient_phone;
      }
      const t = await api<{ id: string }>('/tasks', {
        method: 'POST',
        body: {
          legal_entity_id: f.legal_entity_id, sector_pack: f.sector_pack, ref: f.ref || undefined,
          customer_id: f.customer_id || undefined, attributes, draft: f.draft,
          window: f.from && f.to ? { from: kwIso(f.from), to: kwIso(f.to) } : undefined,
        },
      });
      onDone(t.id);
    });
  };
  return (
    <Modal title="مهمة جديدة" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-2">
          {me.legal_entities.length > 1 && (
            <label className="field">الشركة القانونية
              <select value={f.legal_entity_id} onChange={set('legal_entity_id')} required>
                {me.legal_entities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
          <label className="field">نوع العمل
            <select name="sector_pack" value={f.sector_pack} onChange={set('sector_pack')}>
              {enabledPacks(me.packs).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="field">{delivery ? 'رقم الطلب الخارجي (يمنع التكرار)' : 'المرجع (اختياري)'}<input name="ref" value={f.ref} onChange={set('ref')} maxLength={60} /></label>
          {can(me, 'customers:read') && (
            <label className="field">العميل (اختياري)
              <select name="customer_id" value={f.customer_id} onChange={set('customer_id')}>
                <option value="">بدون عميل</option>
                {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label className="field">من<input name="from" type="datetime-local" value={f.from} onChange={set('from')} /></label>
          <label className="field">إلى<input name="to" type="datetime-local" value={f.to} onChange={set('to')} /></label>
        </div>
        {delivery ? (
          <fieldset className="addr">
            <legend>عنوان التسليم</legend>
            <div className="addr-grid">
              <label className="field">المنطقة<input name="area" value={f.area} onChange={set('area')} maxLength={80} required /></label>
              <label className="field">القطعة<input name="block" className="num" value={f.block} onChange={set('block')} maxLength={20} /></label>
              <label className="field">الشارع<input name="street" value={f.street} onChange={set('street')} maxLength={80} /></label>
              <label className="field">الجادة<input name="avenue" value={f.avenue} onChange={set('avenue')} maxLength={20} /></label>
              <label className="field">المنزل<input name="house" className="num" value={f.house} onChange={set('house')} maxLength={20} /></label>
            </div>
          </fieldset>
        ) : <label className="field">العنوان<input name="address" value={f.address} onChange={set('address')} maxLength={300} /></label>}
        <div className="form-2">
          <label className="field">اسم المستلم<input name="recipient_name" value={f.recipient_name} onChange={set('recipient_name')} maxLength={120} /></label>
          <label className="field">جوال المستلم<input name="recipient_phone" className="num" inputMode="tel" value={f.recipient_phone} onChange={set('recipient_phone')} maxLength={20} required={delivery} /></label>
          {delivery && <>
            <label className="field">مبلغ التحصيل عند التسليم (COD)<input name="cod_amount" className="num" inputMode="decimal" placeholder="0.000" value={f.cod_amount} onChange={set('cod_amount')} pattern="\d{1,9}(\.\d{1,3})?" /></label>
            <label className="field">رسم التوصيل<input name="delivery_fee" className="num" inputMode="decimal" placeholder="0.000" value={f.delivery_fee} onChange={set('delivery_fee')} pattern="\d{1,9}(\.\d{1,3})?" /></label>
          </>}
        </div>
        {delivery && <p className="muted" style={{ margin: 0 }}>يُنشأ للمستلم رمز تسليم من 4 أرقام ورابط تتبع، ويطلب السائق الرمز عند التسليم.</p>}
        <label className="field">ملاحظات<textarea name="notes" rows={2} value={f.notes} onChange={set('notes')} maxLength={1000} /></label>
        <label className="row"><input type="checkbox" checked={f.draft} onChange={set('draft')} style={{ width: 'auto' }} />حفظ كمسودة (لا تظهر للتوزيع بعد)</label>
        <div className="row">
          <button className="primary" disabled={busy}>إنشاء</button>
          <button type="button" onClick={onClose}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Page() {
  return <Suspense><TasksPage /></Suspense>;
}
