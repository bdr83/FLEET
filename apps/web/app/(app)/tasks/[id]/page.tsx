'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { addressLine, dt, KwAddress, money, packLabel, TASK_STATUS } from '@/lib/format';
import { DeliveryPanel } from '@/components/delivery';
import { can, useMe } from '@/components/me';
import { AssignModal } from '@/components/assign';
import { ErrorBox, Modal, StatusBadge, useAction, useLoad } from '@/components/ui';
import type { Task } from '../page';

interface TaskEvent { from_status: string | null; to_status: string; occurred_at: string; actor_type: string | null; note: string | null }
type Detail = Task & { events: TaskEvent[] };

/** Mirrors the API's STAFF_FLOW so only allowed buttons show; the API still enforces it. */
const FLOW: Record<string, string[]> = {
  publish: ['draft'], assign: ['ready', 'assigned', 'accepted'], unassign: ['assigned', 'accepted'],
  cancel: ['draft', 'ready', 'assigned', 'accepted', 'in_progress', 'failed'], review: ['completed'], reopen: ['failed'],
};
const ACTOR: Record<string, string> = { staff: 'الموظف', driver: 'السائق', system: 'النظام', customer: 'العميل' };
const LABELS: Record<string, string> = {
  address: 'العنوان', recipient_name: 'المستلم', recipient_phone: 'جوال المستلم', notes: 'ملاحظات', title: 'العنوان', product: 'المنتج',
  dropoff: 'عنوان التسليم', pickup: 'نقطة الاستلام', recipient: 'المستلم', cod_amount: 'التحصيل عند التسليم', delivery_fee: 'رسم التوصيل',
  tip: 'إكرامية', external_order_id: 'رقم الطلب الخارجي', items_count: 'عدد القطع',
};
const MONEY = new Set(['cod_amount', 'delivery_fee', 'tip']);

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const task = useLoad(() => api<Detail>(`/tasks/${id}`), [id]);
  const act = useAction();
  const [assigning, setAssigning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const t = task.data;
  if (!t) return <div className="page"><ErrorBox error={task.error} />{!task.error && <p className="muted">جارٍ التحميل…</p>}</div>;

  const allowed = (a: string) => FLOW[a].includes(t.status) && can(me, a === 'assign' || a === 'unassign' ? 'tasks:assign' : 'tasks:write');
  const simple = (a: string, extra: Record<string, unknown> = {}) =>
    act.run(async () => { await api(`/tasks/${t.id}/${a}`, { method: 'POST', body: { version: t.version, ...extra } }); await task.reload(); });

  return (
    <div className="page stack">
      <div className="page-head">
        <div className="row">
          <Link href="/tasks" className="muted">المهام ‹</Link>
          <h1>{t.ref ?? `مهمة ${t.id.slice(0, 8)}`}</h1>
          <StatusBadge status={t.status} />
        </div>
        <div className="row">
          {allowed('publish') && <button className="primary" disabled={act.busy} onClick={() => simple('publish')}>نشر للتوزيع</button>}
          {allowed('assign') && <button className="primary" disabled={act.busy} onClick={() => setAssigning(true)}>{t.worker_id ? 'إعادة إسناد' : 'إسناد'}</button>}
          {allowed('unassign') && <button disabled={act.busy} onClick={() => simple('unassign')}>إلغاء الإسناد</button>}
          {allowed('review') && <button className="primary" disabled={act.busy} onClick={() => simple('review')}>اعتماد المراجعة</button>}
          {allowed('reopen') && <button disabled={act.busy} onClick={() => simple('reopen')}>إعادة للقائمة</button>}
          {allowed('cancel') && <button className="danger" disabled={act.busy} onClick={() => setCanceling(true)}>إلغاء المهمة</button>}
        </div>
      </div>
      <ErrorBox error={act.error} />
      <div className="grid g2">
        <section className="card">
          <h2>التفاصيل</h2>
          <dl className="dl">
            <dt>النوع</dt><dd>{packLabel(t.sector_pack)}</dd>
            <dt>الموعد</dt><dd className="num">{t.window_from ? `${dt(t.window_from)} – ${dt(t.window_to)}` : '—'}</dd>
            <dt>العميل</dt><dd>{t.customer_name ?? '—'}</dd>
            <dt>السائق</dt><dd>{t.worker_name ?? '—'}</dd>
            <dt>المركبة</dt><dd className="num">{t.plate_no ?? '—'}</dd>
            {Object.entries(t.attributes ?? {}).filter(([k]) => !(k === 'address' && t.attributes?.dropoff)).map(([k, val]) => (
              <Attr key={k} k={k} v={val} />
            ))}
            <dt>أُنشئت</dt><dd className="num">{dt(t.created_at)}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>السجل</h2>
          <ul className="timeline">
            {t.events.map((e, i) => (
              <li key={i}>
                <div><strong>{TASK_STATUS[e.to_status]?.label ?? e.to_status}</strong> <span className="muted">· {ACTOR[e.actor_type ?? ''] ?? e.actor_type ?? ''}</span></div>
                <div className="muted num">{dt(e.occurred_at)}</div>
                {e.note && <div>{e.note}</div>}
              </li>
            ))}
          </ul>
        </section>
        {t.sector_pack === 'delivery@1' && <DeliveryPanel taskId={t.id} status={t.status} onChange={() => void task.reload()} />}
      </div>
      {assigning && <AssignModal task={t} onClose={() => setAssigning(false)} onDone={() => { setAssigning(false); void task.reload(); }} />}
      {canceling && <CancelModal onClose={() => setCanceling(false)} onSubmit={async (reason) => { if (await simple('cancel', { reason })) setCanceling(false); }} busy={act.busy} />}
    </div>
  );
}

function Attr({ k, v }: { k: string; v: unknown }) {
  if (v === null || v === undefined || v === '') return null;
  let text: string;
  if (k === 'dropoff' || k === 'pickup') text = addressLine(v as KwAddress) + ((v as KwAddress).notes ? ` · ${(v as KwAddress).notes}` : '');
  else if (k === 'recipient') text = [(v as { name?: string }).name, (v as { phone?: string }).phone].filter(Boolean).join(' · ') || '—';
  else if (MONEY.has(k)) text = money(v as string);
  else text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return <><dt>{LABELS[k] ?? k}</dt><dd>{text}</dd></>;
}

function CancelModal({ onClose, onSubmit, busy }: { onClose: () => void; onSubmit: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="إلغاء المهمة" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }}>
        <label className="field">سبب الإلغاء<textarea name="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} /></label>
        <div className="row"><button className="danger" disabled={busy || !reason.trim()}>تأكيد الإلغاء</button><button type="button" onClick={onClose}>رجوع</button></div>
      </form>
    </Modal>
  );
}
